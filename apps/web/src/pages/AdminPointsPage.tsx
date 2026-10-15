import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Building, ImportReport, Page, PointCategory, PointView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { CategoryBadge } from '../components/Category';
import { Empty, ErrorBox, Loading } from '../components/Status';

interface DeviceRow { id: string; collectorName: string; instance: number; address: string; name: string | null; buildingId: string | null; online: boolean }

export function AdminPointsPage() {
  useDocumentTitle('רכזות ונקודות');
  const [unmappedOnly, setUnmappedOnly] = useState(true);
  const buildings = useQuery({ queryKey: ['buildings'], queryFn: () => api.get<Building[]>('/api/buildings') });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api.get<DeviceRow[]>('/api/admin/devices') });
  const points = useQuery({
    queryKey: ['points', unmappedOnly],
    queryFn: () => api.get<Page<PointView>>(`/api/admin/points?limit=500${unmappedOnly ? '&unmapped=1' : ''}`),
  });

  return (
    <section aria-labelledby="points-title">
      <h1 id="points-title">רכזות ונקודות</h1>
      <p className="muted">שיוך מבנה קובע מי רואה את ההתראות. נקודה שאינה משויכת יורשת את המבנה של הרכזת. נקודה שאינה משויכת כלל גלויה רק למנהל המערכת.</p>

      <CsvImport />

      <h2>רכזות</h2>
      {devices.isLoading && <Loading />}
      {devices.error && <ErrorBox error={devices.error} />}
      {devices.data?.length === 0 && <Empty>עדיין לא דווחו רכזות.</Empty>}
      {!!devices.data?.length && (
        <table className="table">
          <thead><tr><th scope="col">Collector</th><th scope="col">רכזת</th><th scope="col">מצב</th><th scope="col">מבנה</th></tr></thead>
          <tbody>
            {devices.data.map((d) => (
              <tr key={d.id}>
                <td>{d.collectorName}</td>
                <td dir="ltr">{d.name ?? `device ${d.instance}`} ({d.instance})</td>
                <td>{d.online ? <span className="ok">✓ מגיבה</span> : <strong className="err">✕ לא מגיבה</strong>}</td>
                <td><DeviceBuilding device={d} buildings={buildings.data ?? []} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>נקודות</h2>
      <label className="checkbox">
        <input type="checkbox" checked={unmappedOnly} onChange={(e) => setUnmappedOnly(e.target.checked)} />
        הצגת נקודות לא משויכות בלבד
      </label>
      {points.isLoading && <Loading />}
      {points.error && <ErrorBox error={points.error} />}
      {points.data?.items.length === 0 && <Empty>{unmappedOnly ? 'כל הנקודות משויכות.' : 'עדיין לא דווחו נקודות.'}</Empty>}
      {!!points.data?.items.length && (
        <>
          <p className="muted small">מוצגות {points.data.items.length} מתוך {points.data.total}.</p>
          <ul className="point-list">
            {points.data.items.map((p) => <PointEditor key={p.id} point={p} buildings={buildings.data ?? []} />)}
          </ul>
        </>
      )}
    </section>
  );
}

function DeviceBuilding({ device, buildings }: { device: DeviceRow; buildings: Building[] }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (buildingId: string | null) => api.patch(`/api/admin/devices/${device.id}`, { buildingId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['devices'] }); void qc.invalidateQueries({ queryKey: ['alarms'] }); },
  });
  const id = `dev-b-${device.id}`;
  return (
    <>
      <label htmlFor={id} className="sr-only">מבנה לרכזת {device.instance}</label>
      <select id={id} value={device.buildingId ?? ''} onChange={(e) => save.mutate(e.target.value || null)} disabled={save.isPending}>
        <option value="">לא משויך</option>
        {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {save.error && <span className="err small" role="alert"> {errorMessage(save.error)}</span>}
    </>
  );
}

function PointEditor({ point, buildings }: { point: PointView; buildings: Building[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ buildingId: point.buildingId ?? '', label: point.label ?? '', location: point.location ?? '' });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/points/${point.id}`, { buildingId: form.buildingId || null, label: form.label || null, location: form.location || null }),
    onSuccess: () => { setSaved(true); void qc.invalidateQueries({ queryKey: ['alarms'] }); },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setSaved(false); setForm((f) => ({ ...f, [k]: e.target.value })); };
  const base = `pt-${point.id}`;
  const title = `${point.name ?? `${point.objectType}:${point.objectInstance}`}`;
  return (
    <li className="card point-card">
      <div className="row space-between">
        <h3 className="h3" dir="ltr">{title}</h3>
        <CategoryBadge category={point.category as PointCategory} />
      </div>
      <p className="muted small">{point.description ?? ''} · <span dir="ltr">{point.deviceName ?? `device ${point.deviceInstance}`} / {point.objectType} {point.objectInstance}</span></p>
      <div className="grid-3">
        <div>
          <label htmlFor={`${base}-b`}>מבנה</label>
          <select id={`${base}-b`} value={form.buildingId} onChange={set('buildingId')}>
            <option value="">לא משויך</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${base}-l`}>שם תצוגה</label>
          <input id={`${base}-l`} maxLength={160} value={form.label} onChange={set('label')} />
        </div>
        <div>
          <label htmlFor={`${base}-loc`}>מיקום (קומה / חדר)</label>
          <input id={`${base}-loc`} maxLength={240} value={form.location} onChange={set('location')} />
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary btn-small" onClick={() => save.mutate()} disabled={save.isPending}>
          שמירה<span className="sr-only"> {title}</span>
        </button>
        <span aria-live="polite">{saved && <span className="ok">נשמר ✓</span>}{save.error && <span className="err">{errorMessage(save.error)}</span>}</span>
      </div>
    </li>
  );
}

const TEMPLATE =
  'device_instance,object_type,object_instance,building_code,floor_level,label,location,x,y\n' +
  '1001,life-safety-point,7,BLD-A,2,גלאי עשן מסדרון,ליד חדר 204,40%,30%\n';

function CsvImport() {
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.raw<ImportReport>('POST', `/api/admin/points/import?dryRun=${dryRun ? 1 : 0}`, text ?? '', 'text/csv'),
    onSuccess: (r) => {
      setReport(r);
      if (!r.dryRun && r.applied > 0) {
        void qc.invalidateQueries({ queryKey: ['points'] });
        void qc.invalidateQueries({ queryKey: ['alarms'] });
      }
    },
  });
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setReport(null);
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      setText(null);
      setFileName('');
      return;
    }
    setFileName(f.name);
    setText(await f.text());
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob(['\uFEFF' + TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'points-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card" aria-labelledby="csv-title">
      <h2 id="csv-title" className="h3">ייבוא שיוך נקודות מ-CSV</h2>
      <p className="muted small">
        מעדכן רק נקודות שה-Collector כבר דיווח. קודם מוצגת תצוגה מקדימה, ואם יש שגיאה אחת לפחות, דבר לא נשמר. מפריד: פסיק או נקודה-פסיק. x ו-y: 0–1 או באחוזים.
      </p>
      <div className="row">
        <button type="button" className="btn btn-small" onClick={download}>הורדת קובץ לדוגמה</button>
      </div>
      <label htmlFor="csv-file">קובץ CSV (עד 2MB)</label>
      <input id="csv-file" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e)} />
      <div className="row">
        <button type="button" className="btn" disabled={!text || run.isPending} onClick={() => run.mutate(true)}>בדיקה (ללא שמירה)</button>
        <button type="button" className="btn btn-primary" disabled={!text || run.isPending || !report?.dryRun || report.errors.length > 0} onClick={() => run.mutate(false)}>
          החלת הייבוא
        </button>
      </div>
      {run.error && <div role="alert" className="alert alert-error">{errorMessage(run.error)}</div>}
      <div aria-live="polite">
        {report && (
          <div className={`alert ${report.errors.length ? 'alert-error' : 'alert-success'}`}>
            {report.dryRun
              ? `בדיקת ${fileName}: ${report.rows} שורות, ${report.preview.length} עדכונים מוכנים, ${report.errors.length} שגיאות.`
              : `הייבוא הוחל: ${report.applied} נקודות עודכנו.`}
          </div>
        )}
      </div>
      {!!report?.errors.length && (
        <table className="table">
          <caption>שגיאות לפי שורה</caption>
          <thead><tr><th scope="col">שורה</th><th scope="col">שגיאה</th></tr></thead>
          <tbody>
            {report.errors.map((e) => (
              <tr key={e.line}><td>{e.line}</td><td dir="ltr" className="code">{e.message}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
