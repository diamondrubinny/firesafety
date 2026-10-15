import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditEntry, Page } from '@firesafety/shared';
import { api } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ErrorBox, Loading } from '../components/Status';

const PAGE = 50;
const OUTCOME_HE = { success: 'הצליח', denied: 'נדחה', failure: 'נכשל' } as const;
const fmt = new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'medium' });

export function AuditPage() {
  useDocumentTitle('יומן פעולות');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', offset],
    queryFn: () => api.get<Page<AuditEntry>>(`/api/admin/audit?limit=${PAGE}&offset=${offset}`),
  });

  return (
    <section aria-labelledby="audit-title">
      <h1 id="audit-title">יומן פעולות</h1>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">זמן</th>
                <th scope="col">משתמש</th>
                <th scope="col">פעולה</th>
                <th scope="col">ישות</th>
                <th scope="col">תוצאה</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>{fmt.format(new Date(a.ts))}</td>
                  <td dir="ltr">{a.userEmail ?? '—'}</td>
                  <td dir="ltr" className="code">{a.action}</td>
                  <td dir="ltr" className="code">{a.entity ? `${a.entity}:${a.entityId ?? ''}` : '—'}</td>
                  <td>
                    <span className={`badge badge-${a.outcome}`}>{OUTCOME_HE[a.outcome]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav aria-label="דפדוף ביומן" className="row">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              הקודם
            </button>
            <span>
              {data.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, data.total)} מתוך {data.total}
            </span>
            <button type="button" className="btn" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
              הבא
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
