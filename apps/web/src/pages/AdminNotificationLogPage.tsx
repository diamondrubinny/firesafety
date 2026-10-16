import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CHANNEL_LABELS_HE, type NotificationLogEntry, type Page } from '@firesafety/shared';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { Empty, ErrorBox, Loading } from '../components/Status';

const PAGE = 50;
const STATUS_HE: Record<NotificationLogEntry['status'], string> = { pending: 'ממתין', sending: 'בשליחה', sent: 'נשלח', failed: 'נכשל', skipped: 'דולג' };

export function AdminNotificationLogPage() {
  useDocumentTitle('יומן משלוחים');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'notification-log', offset],
    queryFn: () => api.get<Page<NotificationLogEntry>>(`/api/admin/notifications?limit=${PAGE}&offset=${offset}`),
    refetchInterval: 10_000,
  });
  return (
    <section aria-labelledby="nl-title">
      <div className="row space-between">
        <h1 id="nl-title">יומן משלוחים</h1>
        <Link to="/admin/settings/notifications">הגדרות התראות</Link>
      </div>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data?.items.length === 0 && <Empty>עדיין לא נשלחו התראות.</Empty>}
      {!!data?.items.length && (
        <>
          <table className="table">
            <thead>
              <tr><th scope="col">זמן</th><th scope="col">נמען</th><th scope="col">ערוץ</th><th scope="col">שלב</th><th scope="col">סטטוס</th><th scope="col">פרטים</th><th scope="col">אירוע</th></tr>
            </thead>
            <tbody>
              {data.items.map((n) => (
                <tr key={n.id}>
                  <td>{formatDateTime(n.sentAt ?? n.createdAt)}</td>
                  <td>{n.userName}{n.recipientHint && <div className="muted small" dir="ltr">{n.recipientHint}</div>}</td>
                  <td>{CHANNEL_LABELS_HE[n.channel]}</td>
                  <td>{n.stage === 'escalation' ? <strong>הסלמה</strong> : 'ראשוני'}</td>
                  <td><span className={`badge badge-${n.status === 'sent' ? 'success' : n.status === 'failed' ? 'failure' : 'neutral'}`}>{STATUS_HE[n.status]}</span>{n.attempts > 1 && <span className="muted small"> ({n.attempts} ניסיונות)</span>}</td>
                  <td className="small">{n.lastError ?? '—'}</td>
                  <td>{n.alarmId ? <Link to={`/alarms/${n.alarmId}`}>פתיחה</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav aria-label="דפדוף" className="row">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>הקודם</button>
            <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} מתוך {data.total}</span>
            <button type="button" className="btn" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>הבא</button>
          </nav>
        </>
      )}
    </section>
  );
}
