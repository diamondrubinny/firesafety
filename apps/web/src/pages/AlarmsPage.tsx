import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALARM_CATEGORIES, CATEGORY_LABELS_HE, type AlarmCategory, type AlarmSummary, type AlarmView, type Page } from '@firesafety/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useLive } from '../lib/realtime';
import { AlarmSound, loadSoundPref, saveSoundPref } from '../lib/sound';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CategoryBadge } from '../components/Category';
import { Empty, ErrorBox, Loading } from '../components/Status';

export function AlarmsPage() {
  useDocumentTitle('אירועים פעילים');
  const { hasRole } = useAuth();
  const { connected } = useLive();
  const canHandle = hasRole('Operator', 'SafetyOfficer', 'FireAdmin');
  const [filter, setFilter] = useState<AlarmCategory | ''>('');

  const summary = useQuery({
    queryKey: ['alarms', 'summary'],
    queryFn: () => api.get<AlarmSummary>('/api/alarms/summary'),
    refetchInterval: connected ? false : 10_000,
  });
  const alarms = useQuery({
    queryKey: ['alarms', 'active', filter],
    queryFn: () => api.get<Page<AlarmView>>(`/api/alarms?state=active${filter ? `&category=${filter}` : ''}`),
    refetchInterval: connected ? false : 10_000,
  });

  const unackedFire = summary.data?.fire.unacked ?? 0;

  return (
    <section aria-labelledby="alarms-title">
      <div className="row space-between">
        <h1 id="alarms-title">אירועים פעילים</h1>
        <SoundControl active={unackedFire > 0} />
      </div>
      <FireAnnouncer items={alarms.data?.items} />

      {summary.data && (
        <ul className="summary" aria-label="סיכום אירועים פעילים">
          {ALARM_CATEGORIES.map((c) => (
            <li key={c}>
              <button
                type="button"
                className={`summary-tile cat-tile-${c}${summary.data[c].unacked > 0 ? ' has-unacked' : ''}`}
                aria-pressed={filter === c}
                onClick={() => setFilter(filter === c ? '' : c)}
              >
                <span className="summary-count">{summary.data[c].active}</span>
                <CategoryBadge category={c} />
                {summary.data[c].unacked > 0 && <span className="summary-unacked">{summary.data[c].unacked} לא אושרו</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {filter && (
        <p>
          מוצגים אירועי {CATEGORY_LABELS_HE[filter]} בלבד.{' '}
          <button type="button" className="btn btn-small" onClick={() => setFilter('')}>הצגת הכול</button>
        </p>
      )}

      {(alarms.isLoading || summary.isLoading) && <Loading />}
      {alarms.error && <ErrorBox error={alarms.error} />}
      {alarms.data?.items.length === 0 && <Empty>אין אירועים פעילים.</Empty>}
      {!!alarms.data?.items.length && <AlarmTable items={alarms.data.items} canHandle={canHandle} />}
    </section>
  );
}

function AlarmTable({ items, canHandle }: { items: AlarmView[]; canHandle: boolean }) {
  const qc = useQueryClient();
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/alarms/${id}/ack`, {}),
    onSettled: () => qc.invalidateQueries({ queryKey: ['alarms'] }),
  });
  return (
    <>
      {ack.error && <ErrorBox error={ack.error} />}
      <table className="table alarms">
        <caption className="sr-only">אירועים פעילים, ממוינים לפי חומרה ואישור</caption>
        <thead>
          <tr>
            <th scope="col">סוג</th>
            <th scope="col">מבנה</th>
            <th scope="col">נקודה / מיקום</th>
            <th scope="col">זמן</th>
            <th scope="col">סטטוס</th>
            <th scope="col"><span className="sr-only">פעולות</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} className={!a.ackedAt ? `unacked unacked-${a.category}` : undefined}>
              <td><CategoryBadge category={a.category} /></td>
              <td>{a.buildingName ?? <span className="muted">לא משויך</span>}</td>
              <td>
                <Link to={`/alarms/${a.id}`}>{a.kind === 'point' ? a.pointLabel : a.message}</Link>
                {a.location && <div className="muted small">{a.location}</div>}
                {a.deviceName && <div className="muted small">{a.deviceName}</div>}
              </td>
              <td>{formatDateTime(a.raisedAt)}</td>
              <td>{a.ackedAt ? <span>אושר{a.ackedBy ? ` ע"י ${a.ackedBy}` : ''}</span> : <strong>לא אושר</strong>}</td>
              <td>
                {canHandle && !a.ackedAt && (
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    disabled={ack.isPending && ack.variables === a.id}
                    onClick={() => ack.mutate(a.id)}
                  >
                    אישור קבלה<span className="sr-only"> {a.pointLabel ?? a.message}</span>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Screen-reader announcement for newly raised, unacknowledged fire alarms. */
function FireAnnouncer({ items }: { items: AlarmView[] | undefined }) {
  const seen = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!items) return;
    const fires = items.filter((a) => a.category === 'fire' && !a.ackedAt);
    if (seen.current) {
      const fresh = fires.filter((a) => !seen.current!.has(a.id));
      if (fresh.length > 0) {
        setMessage(`התרעת אש חדשה: ${fresh.map((a) => `${a.buildingName ?? ''} ${a.pointLabel ?? ''}`.trim()).join('; ')}`);
      }
    }
    seen.current = new Set(fires.map((a) => a.id));
  }, [items]);
  return (
    <div className="sr-only" role="alert" aria-live="assertive">
      {message}
    </div>
  );
}

function SoundControl({ active }: { active: boolean }) {
  const sound = useMemo(() => new AlarmSound(), []);
  const [enabled, setEnabled] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const { fireSignal } = useLive();

  // A stored preference still needs one click per page load (browser autoplay policy).
  const wanted = useMemo(() => loadSoundPref(), []);

  useEffect(() => {
    if (enabled && active) sound.start();
    else sound.stop();
  }, [enabled, active, sound, fireSignal]);
  useEffect(() => () => sound.stop(), [sound]);

  const toggle = async () => {
    if (enabled) {
      setEnabled(false);
      saveSoundPref(false);
      return;
    }
    const ok = await sound.unlock();
    setBlocked(!ok);
    setEnabled(ok);
    saveSoundPref(ok);
  };

  return (
    <div className="row">
      <button type="button" className={`btn ${enabled ? 'btn-primary' : ''}`} aria-pressed={enabled} onClick={() => void toggle()}>
        {enabled ? 'התראה קולית פעילה' : 'הפעלת התראה קולית'}
      </button>
      {!enabled && wanted && <span className="muted small">יש ללחוץ כדי להפעיל צליל בדף זה</span>}
      {blocked && <span className="err small">הדפדפן חסם השמעת צליל</span>}
      {enabled && active && <span className="err small" aria-hidden="true">♪ מושמע צליל</span>}
    </div>
  );
}

