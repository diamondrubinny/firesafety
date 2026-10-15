import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AlarmView, Page } from '@firesafety/shared';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CategoryBadge } from '../components/Category';
import { Empty, ErrorBox, Loading } from '../components/Status';

const PAGE = 50;

export function AlarmHistoryPage() {
  useDocumentTitle('היסטוריית אירועים');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ['alarms', 'history', offset],
    queryFn: () => api.get<Page<AlarmView>>(`/api/alarms?state=all&limit=${PAGE}&offset=${offset}`),
  });
  return (
    <section aria-labelledby="history-title">
      <h1 id="history-title">היסטוריית אירועים</h1>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data?.items.length === 0 && <Empty>אין אירועים.</Empty>}
      {!!data?.items.length && (
        <>
          <table className="table">
            <thead>
              <tr><th scope="col">סוג</th><th scope="col">מבנה</th><th scope="col">נקודה</th><th scope="col">התחיל</th><th scope="col">הסתיים</th><th scope="col">אישור</th></tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td><CategoryBadge category={a.category} /></td>
                  <td>{a.buildingName ?? '—'}</td>
                  <td><Link to={`/alarms/${a.id}`}>{a.kind === 'point' ? a.pointLabel : a.message}</Link></td>
                  <td>{formatDateTime(a.raisedAt)}</td>
                  <td>{a.clearedAt ? formatDateTime(a.clearedAt) : <strong>פעיל</strong>}</td>
                  <td>{a.ackedAt ? `${a.ackedBy ?? ''}` : '—'}</td>
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
