import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LatencyStats, PilotReport, PilotTarget } from '@firesafety/shared';
import { api } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { Empty, ErrorBox, Loading } from '../components/Status';

const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)}`);
const dur = (s: number) => (s < 60 ? `${s} שנ'` : s < 3600 ? `${Math.floor(s / 60)} דק'` : `${(s / 3600).toFixed(1)} שעות`);
const CHANNEL_HE: Record<string, string> = { push: 'Push', email: 'דוא"ל', sms: 'SMS', whatsapp: 'WhatsApp' };

const TARGET_HE: Record<PilotTarget['id'], string> = {
  ingest_p95: 'השהיה מהרכזת לשרת',
  notify_p95: 'השהיה עד הודעה ראשונה',
  completeness: 'שלמות: אירועים שלא הגיעו',
  availability: 'זמינות הרכיב החלש ביותר',
};

function Verdict({ met }: { met: boolean | null }) {
  if (met === null) return <span className="badge badge-neutral">אין נתונים</span>;
  return met ? <span className="badge badge-success">✓ עומד ביעד</span> : <span className="badge badge-failure">✕ לא עומד ביעד</span>;
}

function LatencyRow({ label, s }: { label: string; s: LatencyStats }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{s.count}</td>
      <td dir="ltr">{sec(s.p50Ms)}</td>
      <td dir="ltr">{sec(s.p95Ms)}</td>
      <td dir="ltr">{sec(s.p99Ms)}</td>
      <td dir="ltr">{sec(s.maxMs)}</td>
    </tr>
  );
}

const LatencyHead = ({ first }: { first: string }) => (
  <thead>
    <tr>
      <th scope="col">{first}</th>
      <th scope="col">מספר</th>
      <th scope="col">חציון (שנ')</th>
      <th scope="col">p95 (שנ')</th>
      <th scope="col">p99 (שנ')</th>
      <th scope="col">מקסימום (שנ')</th>
    </tr>
  </thead>
);

export function PilotReportPage() {
  useDocumentTitle('ביצועי מערכת');
  const [range, setRange] = useState({ from: day(new Date(Date.now() - 7 * 86_400_000)), to: day(new Date()) });
  const [applied, setApplied] = useState(range);
  const qs = new URLSearchParams(applied).toString();
  const report = useQuery({ queryKey: ['pilot-report', qs], queryFn: () => api.get<PilotReport>(`/api/reports/pilot?${qs}`), retry: false });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(range);
  };
  const r = report.data;

  return (
    <section aria-labelledby="pilot-title" className="report">
      <div className="row space-between">
        <h1 id="pilot-title">ביצועי מערכת (פיילוט)</h1>
        <button type="button" className="btn no-print" onClick={() => window.print()}>הדפסה</button>
      </div>
      <p className="muted">מדדי קבלה לפיילוט: השהיה, שלמות האירועים, זמני הודעה וזמינות. הנתונים מכל המבנים.</p>

      <form onSubmit={submit} className="card no-print" aria-label="טווח תאריכים">
        <div className="grid-3">
          <div className="field"><label htmlFor="p-from">מתאריך</label><input id="p-from" type="date" required value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="p-to">עד תאריך</label><input id="p-to" type="date" required value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
        </div>
        <button type="submit" className="btn btn-primary">הצגה</button>
      </form>

      {report.isLoading && <Loading />}
      {report.error && <ErrorBox error={report.error} />}
      {r && (
        <>
          <h2>עמידה ביעדים, {r.from} עד {r.to}</h2>
          <table className="table">
            <caption className="sr-only">עמידה ביעדי הפיילוט</caption>
            <thead><tr><th scope="col">מדד</th><th scope="col">יעד</th><th scope="col">בפועל</th><th scope="col">תוצאה</th></tr></thead>
            <tbody>
              {r.targets.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{TARGET_HE[t.id]}</th>
                  <td>{t.target}</td>
                  <td>{t.actual ?? '—'}</td>
                  <td><Verdict met={t.met} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>השהיית אירועים</h2>
          <table className="table">
            <caption className="sr-only">השהיית אירועים בשניות</caption>
            <LatencyHead first="מקטע" />
            <tbody>
              <LatencyRow label="רכזת → שרת" s={r.ingest.endToEnd} />
              <LatencyRow label="Collector → שרת" s={r.ingest.collectorToServer} />
            </tbody>
          </table>
          <p className="muted small">
            "רכזת → שרת" נמדד מחותמת הזמן של הרכזת כשהיא קיימת, ואחרת משעת קליטת האירוע ב-Collector. ההשהיה מהשרת למסך (WebSocket) היא עשיריות שנייה ואינה נכללת.
            {r.ingest.clockSkewCount > 0 && <strong> {r.ingest.clockSkewCount} אירועים הוצאו מהחישוב כי שעון הרכזת מקדים את שעון ה-Collector. יש לבדוק סנכרון שעון ברכזת.</strong>}
          </p>

          <h2>שלמות: רצף האירועים מכל Collector</h2>
          {r.completeness.length === 0 ? <Empty>לא התקבלו נתונים בטווח.</Empty> : (
            <table className="table">
              <caption className="sr-only">רצף פריטים לכל Collector</caption>
              <thead><tr><th scope="col">Collector</th><th scope="col">Epoch</th><th scope="col">התקבלו</th><th scope="col">טווח רצף</th><th scope="col">חסרים</th></tr></thead>
              <tbody>
                {r.completeness.map((c) => (
                  <tr key={`${c.collectorName}-${c.epoch}`}>
                    <th scope="row">{c.collectorName}</th>
                    <td dir="ltr" className="code">{c.epoch}</td>
                    <td>{c.received}</td>
                    <td dir="ltr">{c.firstSeq}–{c.lastSeq}</td>
                    <td>{c.missing === 0 ? '0' : <strong className="err">{c.missing}</strong>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>הודעות</h2>
          <table className="table">
            <caption className="sr-only">זמני הודעה בשניות</caption>
            <LatencyHead first="ערוץ" />
            <tbody>
              <LatencyRow label="הודעה ראשונה לכל אירוע (כל ערוץ)" s={r.firstNotification} />
              {r.notifications.map((n) => <LatencyRow key={n.channel} label={CHANNEL_HE[n.channel] ?? n.channel} s={n.latency} />)}
            </tbody>
          </table>
          {r.notifications.length > 0 && (
            <table className="table">
              <caption className="sr-only">סטטוס הודעות לפי ערוץ</caption>
              <thead><tr><th scope="col">ערוץ</th><th scope="col">נשלחו</th><th scope="col">נכשלו</th><th scope="col">דולגו</th><th scope="col">ממתינות</th></tr></thead>
              <tbody>
                {r.notifications.map((n) => (
                  <tr key={n.channel}>
                    <th scope="row">{CHANNEL_HE[n.channel] ?? n.channel}</th>
                    <td>{n.sent}</td>
                    <td>{n.failed > 0 ? <strong className="err">{n.failed}</strong> : 0}</td>
                    <td>{n.skipped}</td>
                    <td>{n.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>זמינות</h2>
          {r.availability.length === 0 ? <Empty>אין Collectors פעילים.</Empty> : (
            <table className="table">
              <caption className="sr-only">זמינות Collectors ורכזות</caption>
              <thead><tr><th scope="col">רכיב</th><th scope="col">סוג</th><th scope="col">נפילות</th><th scope="col">משך כולל</th><th scope="col">זמינות</th></tr></thead>
              <tbody>
                {r.availability.map((a) => (
                  <tr key={`${a.kind}-${a.name}`}>
                    <th scope="row">{a.name}</th>
                    <td>{a.kind === 'collector' ? 'Collector' : 'רכזת'}</td>
                    <td>{a.outages}</td>
                    <td>{a.downtimeSeconds > 0 ? dur(a.downtimeSeconds) : '—'}</td>
                    <td dir="ltr">{a.availabilityPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">נפילה של Collector נספרת מרגע שה-watchdog מזהה אותה (לפי COLLECTOR_STALE_SECONDS), ולכן הזמינות בפועל נמוכה מעט יותר.</p>
        </>
      )}
    </section>
  );
}
