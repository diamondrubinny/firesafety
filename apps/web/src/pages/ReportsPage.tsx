import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ALARM_CATEGORIES, CATEGORY_LABELS_HE, type AlarmCategory, type AlarmReport, type Building, type OpenIssueRow, type PointCategory } from '@firesafety/shared';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CategoryBadge } from '../components/Category';
import { Empty, ErrorBox, Loading } from '../components/Status';

const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const duration = (s: number | null) => (s === null ? '—' : s < 60 ? `${s} שניות` : s < 3600 ? `${Math.floor(s / 60)} דק' ${s % 60} שנ'` : `${(s / 3600).toFixed(1)} שעות`);
const catLabel = (c: string) => CATEGORY_LABELS_HE[c as PointCategory] ?? c;

export function ReportsPage() {
  useDocumentTitle('דוחות');
  const buildings = useQuery({ queryKey: ['buildings'], queryFn: () => api.get<Building[]>('/api/buildings') });
  const [filters, setFilters] = useState({ from: day(new Date(Date.now() - 30 * 86_400_000)), to: day(new Date()), buildingId: '', category: '' as AlarmCategory | '' });
  const [applied, setApplied] = useState(filters);
  const qs = new URLSearchParams({ from: applied.from, to: applied.to, ...(applied.buildingId ? { buildingId: applied.buildingId } : {}), ...(applied.category ? { category: applied.category } : {}) }).toString();
  const report = useQuery({ queryKey: ['report', qs], queryFn: () => api.get<AlarmReport>(`/api/reports/alarms?${qs}`), retry: false });
  const issues = useQuery({ queryKey: ['report', 'open-issues'], queryFn: () => api.get<OpenIssueRow[]>('/api/reports/open-issues') });
  const submit = (e: FormEvent) => { e.preventDefault(); setApplied(filters); };

  return (
    <section aria-labelledby="rep-title" className="report">
      <div className="row space-between">
        <h1 id="rep-title">דוחות</h1>
        <button type="button" className="btn no-print" onClick={() => window.print()}>הדפסה</button>
      </div>

      <form onSubmit={submit} className="card no-print" aria-label="סינון דוח אירועים">
        <div className="grid-3">
          <div className="field"><label htmlFor="r-from">מתאריך</label><input id="r-from" type="date" required value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="r-to">עד תאריך</label><input id="r-to" type="date" required value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></div>
          <div className="field">
            <label htmlFor="r-b">מבנה</label>
            <select id="r-b" value={filters.buildingId} onChange={(e) => setFilters({ ...filters, buildingId: e.target.value })}>
              <option value="">הכול</option>
              {buildings.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-c">סוג</label>
            <select id="r-c" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value as AlarmCategory | '' })}>
              <option value="">הכול</option>
              {ALARM_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS_HE[c]}</option>)}
            </select>
          </div>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary">הצגה</button>
          <a className="btn" href={`/api/reports/alarms.csv?${qs}`} download>ייצוא CSV</a>
        </div>
      </form>

      <h2>אירועים {applied.from} עד {applied.to}</h2>
      {report.isLoading && <Loading />}
      {report.error && <ErrorBox error={report.error} />}
      {report.data && (
        <>
          <p>סה"כ: <strong>{report.data.total}</strong> אירועים{report.data.total > report.data.items.length && ` (מוצגים ${report.data.items.length} האחרונים, ובייצוא כולם)`}.</p>
          {report.data.total === 0 ? <Empty>אין אירועים בטווח.</Empty> : (
            <>
              <div className="grid-2">
                <table className="table">
                  <caption>לפי סוג</caption>
                  <thead><tr><th scope="col">סוג</th><th scope="col">מספר</th></tr></thead>
                  <tbody>{report.data.byCategory.map((r) => <tr key={r.category}><td><CategoryBadge category={r.category as PointCategory} /></td><td>{r.count}</td></tr>)}</tbody>
                </table>
                <table className="table">
                  <caption>לפי מבנה</caption>
                  <thead><tr><th scope="col">מבנה</th><th scope="col">מספר</th></tr></thead>
                  <tbody>{report.data.byBuilding.map((r) => <tr key={r.buildingName ?? '-'}><td>{r.buildingName ?? 'לא משויך'}</td><td>{r.count}</td></tr>)}</tbody>
                </table>
              </div>
              <table className="table">
                <caption>זמני תגובה (עד אישור קבלה)</caption>
                <thead><tr><th scope="col">סוג</th><th scope="col">אירועים</th><th scope="col">אושרו</th><th scope="col">לא אושרו</th><th scope="col">חציון</th><th scope="col">ממוצע</th><th scope="col">מקסימום</th></tr></thead>
                <tbody>
                  {report.data.responseTimes.map((r) => (
                    <tr key={r.category}>
                      <td>{catLabel(r.category)}</td><td>{r.count}</td><td>{r.acked}</td>
                      <td>{r.unacked > 0 ? <strong>{r.unacked}</strong> : 0}</td>
                      <td>{duration(r.medianSeconds)}</td><td>{duration(r.avgSeconds)}</td><td>{duration(r.maxSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="table">
                <caption>פירוט</caption>
                <thead><tr><th scope="col">התחלה</th><th scope="col">סוג</th><th scope="col">מבנה</th><th scope="col">נקודה</th><th scope="col">אישור</th><th scope="col">סיום</th></tr></thead>
                <tbody>
                  {report.data.items.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDateTime(r.raisedAt)}</td>
                      <td>{r.kind === 'point' ? <CategoryBadge category={r.category as PointCategory} /> : 'תקלת תקשורת'}</td>
                      <td>{r.buildingName ?? '—'}</td>
                      <td><Link to={`/alarms/${r.id}`}>{r.pointLabel ?? '—'}</Link>{r.location && <div className="muted small">{r.location}</div>}</td>
                      <td>{r.ackedAt ? `${r.ackedBy ?? ''} · ${duration(r.ackSeconds)}` : <strong>לא אושר</strong>}</td>
                      <td>{r.clearedAt ? formatDateTime(r.clearedAt) : <strong>פעיל</strong>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <div className="row space-between">
        <h2>נקודות מנוטרלות ותקלות פתוחות</h2>
        <a className="btn no-print" href="/api/reports/open-issues.csv" download>ייצוא CSV</a>
      </div>
      {issues.isLoading && <Loading />}
      {issues.error && <ErrorBox error={issues.error} />}
      {issues.data?.length === 0 && <Empty>אין נקודות מנוטרלות או בתקלה.</Empty>}
      {!!issues.data?.length && (
        <table className="table">
          <thead><tr><th scope="col">מצב</th><th scope="col">מבנה</th><th scope="col">נקודה</th><th scope="col">מיקום</th><th scope="col">מאז</th></tr></thead>
          <tbody>
            {issues.data.map((r) => (
              <tr key={r.pointId}>
                <td><CategoryBadge category={r.category as PointCategory} /></td>
                <td>{r.buildingName ?? '—'}</td><td>{r.pointLabel}</td><td>{r.location ?? '—'}</td>
                <td>{r.since ? formatDateTime(r.since) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
