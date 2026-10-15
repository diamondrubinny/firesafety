import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CATEGORY_LABELS_HE, type AlarmDetail, type PointCategory } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CategoryBadge } from '../components/Category';
import { ErrorBox, Loading } from '../components/Status';

const SOURCE_HE: Record<string, string> = { notification: 'הודעת רכזת', poll: 'סריקה', inventory: 'סריקת מלאי', snapshot: 'סנכרון' };

export function AlarmDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const canHandle = hasRole('Operator', 'SafetyOfficer', 'FireAdmin');
  const { data, isLoading, error } = useQuery({
    queryKey: ['alarms', 'detail', id],
    queryFn: () => api.get<AlarmDetail>(`/api/alarms/${encodeURIComponent(id)}`),
    retry: false,
  });
  useDocumentTitle(data ? `${CATEGORY_LABELS_HE[data.category]}: ${data.pointLabel ?? data.message ?? ''}` : 'אירוע');

  const [note, setNote] = useState('');
  const [newNote, setNewNote] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['alarms'] });
  const ack = useMutation({ mutationFn: () => api.post(`/api/alarms/${id}/ack`, note ? { note } : {}), onSuccess: () => { setNote(''); void refresh(); } });
  const addNote = useMutation({ mutationFn: () => api.post(`/api/alarms/${id}/notes`, { text: newNote }), onSuccess: () => { setNewNote(''); void refresh(); } });

  const submitAck = (e: FormEvent) => {
    e.preventDefault();
    ack.mutate();
  };
  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    addNote.mutate();
  };

  return (
    <section>
      <p><Link to="/">חזרה לאירועים פעילים</Link></p>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <h1>
            <CategoryBadge category={data.category} /> {data.kind === 'point' ? data.pointLabel : data.message}
          </h1>
          <dl className="details">
            <dt>מבנה</dt><dd>{data.buildingName ?? 'לא משויך'}</dd>
            <dt>מיקום</dt><dd>{data.location ?? '—'}</dd>
            <dt>רכזת</dt><dd>{data.deviceName ?? '—'}</dd>
            <dt>הודעה</dt><dd>{data.message ?? '—'}</dd>
            <dt>התחיל</dt><dd>{formatDateTime(data.raisedAt)}</dd>
            <dt>מצב</dt><dd>{data.active ? 'פעיל' : `הסתיים ${data.clearedAt ? formatDateTime(data.clearedAt) : ''}`}</dd>
            <dt>אישור קבלה</dt><dd>{data.ackedAt ? `${formatDateTime(data.ackedAt)}${data.ackedBy ? `, ${data.ackedBy}` : ''}` : 'טרם אושר'}</dd>
          </dl>
          {data.floorId && data.pointId && (
            <p><Link className="btn" to={`/floors/${data.floorId}?point=${data.pointId}`}>הצגה במפת הקומה</Link></p>
          )}
          <p className="muted small">אישור הקבלה נרשם במערכת זו בלבד, ואינו משפיע על הרכזת.</p>

          {canHandle && !data.ackedAt && (
            <form onSubmit={submitAck} className="card">
              <h2>אישור קבלה</h2>
              {ack.error && <div role="alert" className="alert alert-error">{errorMessage(ack.error)}</div>}
              <label htmlFor="ack-note">הערה (לא חובה)</label>
              <textarea id="ack-note" maxLength={1000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="submit" className="btn btn-primary" disabled={ack.isPending} aria-busy={ack.isPending}>אישור קבלה</button>
            </form>
          )}

          <h2>הערות</h2>
          {data.notes.length === 0 ? <p className="muted">אין הערות.</p> : (
            <ul className="notes">
              {data.notes.map((n) => (
                <li key={n.id}><span className="muted small">{formatDateTime(n.ts)} · {n.author ?? '—'}</span><p>{n.text}</p></li>
              ))}
            </ul>
          )}
          {canHandle && (
            <form onSubmit={submitNote} className="card">
              {addNote.error && <div role="alert" className="alert alert-error">{errorMessage(addNote.error)}</div>}
              <label htmlFor="new-note">הוספת הערה</label>
              <textarea id="new-note" required maxLength={1000} rows={2} value={newNote} onChange={(e) => setNewNote(e.target.value)} />
              <button type="submit" className="btn" disabled={addNote.isPending}>הוספה</button>
            </form>
          )}

          {data.history.length > 0 && (
            <>
              <h2>היסטוריית הנקודה</h2>
              <table className="table">
                <thead><tr><th scope="col">זמן</th><th scope="col">מצב</th><th scope="col">ערך BACnet</th><th scope="col">מקור</th></tr></thead>
                <tbody>
                  {data.history.map((h, i) => (
                    <tr key={i}>
                      <td>{formatDateTime(h.ts)}</td>
                      <td><CategoryBadge category={h.category as PointCategory} /></td>
                      <td dir="ltr" className="code">{[h.lifeSafetyState, h.eventState].filter(Boolean).join(' / ') || '—'}</td>
                      <td>{SOURCE_HE[h.source] ?? h.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}
