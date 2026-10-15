import { useEffect, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FloorDetail, FloorPointView, Page, PointView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { FloorMap, floorSummary } from '../components/FloorMap';
import { ErrorBox, Loading } from '../components/Status';

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 10 * 1024 * 1024;
const pct = (v: number | null) => (v === null ? '' : String(Math.round(v * 1000) / 10));

export function AdminFloorEditorPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const floor = useQuery({ queryKey: ['alarms', 'floor', id], queryFn: () => api.get<FloorDetail>(`/api/floors/${encodeURIComponent(id)}`), retry: false });
  const buildingId = floor.data?.building.id;
  const candidates = useQuery({
    queryKey: ['points', 'building', buildingId],
    queryFn: () => api.get<Page<PointView>>(`/api/admin/points?limit=500&buildingId=${buildingId}`),
    enabled: !!buildingId,
  });
  useDocumentTitle(floor.data ? `עריכת ${floor.data.floor.name}` : 'עריכת קומה');

  const [selected, setSelected] = useState('');
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [status, setStatus] = useState('');

  const selectedPoint = candidates.data?.items.find((p) => p.id === selected);
  useEffect(() => {
    if (!selectedPoint) return;
    const onThisFloor = selectedPoint.floorId === id;
    setX(onThisFloor ? pct(selectedPoint.x) : '');
    setY(onThisFloor ? pct(selectedPoint.y) : '');
    setStatus('');
  }, [selectedPoint, id]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['alarms', 'floor', id] });
    void qc.invalidateQueries({ queryKey: ['points'] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => api.raw('PUT', `/api/admin/floors/${id}/plan`, file, file.type),
    onSuccess: () => { setStatus('התוכנית הועלתה ונסרקה בהצלחה.'); refresh(); },
  });
  const place = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/admin/points/${selected}`, body),
    onSuccess: (_d, body) => { setStatus(body.floorId === null ? 'הנקודה הוסרה מהקומה.' : 'המיקום נשמר.'); refresh(); },
  });

  const [fileError, setFileError] = useState('');
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setFileError('');
    if (!f) return;
    if (!ALLOWED.includes(f.type)) return setFileError('ניתן להעלות PNG, JPEG או WebP בלבד.');
    if (f.size > MAX) return setFileError('הקובץ גדול מ-10MB.');
    upload.mutate(f);
  };

  const save = () => {
    const nx = Number(x) / 100;
    const ny = Number(y) / 100;
    if (x === '' || y === '' || !(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) {
      setStatus('יש להזין X ו-Y בין 0 ל-100.');
      return;
    }
    place.mutate({ floorId: id, x: nx, y: ny });
  };

  // Show the selected point on the map even before saving.
  const mapPoints: FloorPointView[] = (floor.data?.points ?? []).filter((p) => p.id !== selected);
  if (selectedPoint && x !== '' && y !== '') {
    mapPoints.push({ id: selected, label: selectedPoint.label ?? selectedPoint.name ?? '', location: null, x: Number(x) / 100, y: Number(y) / 100, category: 'normal', alarmId: null, acked: null });
  }

  return (
    <section>
      {floor.isLoading && <Loading />}
      {floor.error && <ErrorBox error={floor.error} />}
      {floor.data && (
        <>
          <p><Link to={`/floors/${id}`}>חזרה לתצוגת הקומה</Link></p>
          <h1>עריכת מפה: {floor.data.building.name}, {floor.data.floor.name}</h1>

          <div className="card narrow">
            <h2 className="h3">תוכנית קומה</h2>
            <p className="muted small">PNG, JPEG או WebP, עד 10MB. כל קובץ נסרק ב-ClamAV לפני שהוא מוצג. מומלץ לייצא את התוכנית מ-PDF או CAD כתמונה. הקובץ אינו נשמר בריפו.</p>
            <label htmlFor="plan-file">בחירת קובץ</label>
            <input id="plan-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={onFile} disabled={upload.isPending} />
            {upload.isPending && <p role="status">מעלה וסורק…</p>}
            {(fileError || upload.error) && <div role="alert" className="alert alert-error">{fileError || errorMessage(upload.error)}</div>}
          </div>

          <div className="editor">
            <div className="editor-map">
              {floor.data.floor.planFileId ? (
                <>
                  <p className="muted small" id="pick-hint">לאחר בחירת נקודה, לחיצה על המפה קובעת את מיקומה. אפשר גם להזין X ו-Y באחוזים.</p>
                  <FloorMap
                    planFileId={floor.data.floor.planFileId}
                    points={mapPoints}
                    selectedId={selected || null}
                    onPick={selected ? (px, py) => { setX(pct(px)); setY(pct(py)); setStatus(''); } : undefined}
                    summary={floorSummary(floor.data.floor.name, floor.data.points)}
                  />
                </>
              ) : (
                <p className="muted">יש להעלות תוכנית כדי לשבץ נקודות.</p>
              )}
            </div>
            <div className="card editor-panel">
              <h2 className="h3">שיבוץ נקודה</h2>
              {candidates.error && <ErrorBox error={candidates.error} />}
              <label htmlFor="pt-select">נקודה (מנקודות המבנה)</label>
              <select id="pt-select" value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">בחירה…</option>
                {candidates.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {(p.label ?? p.name ?? `${p.objectType}:${p.objectInstance}`) + (p.floorId === id ? ' ✓' : p.floorId ? ' (בקומה אחרת)' : '')}
                  </option>
                ))}
              </select>
              {candidates.data?.items.length === 0 && <p className="muted small">אין נקודות משויכות למבנה. יש לשייך נקודות בעמוד "רכזות ונקודות" או בייבוא CSV.</p>}
              <div className="grid-2 tight">
                <div>
                  <label htmlFor="pt-x">X (% מרוחב התמונה, 0 = קצה שמאל)</label>
                  <input id="pt-x" type="number" min={0} max={100} step={0.1} dir="ltr" value={x} onChange={(e) => setX(e.target.value)} disabled={!selected} />
                </div>
                <div>
                  <label htmlFor="pt-y">Y (% מלמעלה)</label>
                  <input id="pt-y" type="number" min={0} max={100} step={0.1} dir="ltr" value={y} onChange={(e) => setY(e.target.value)} disabled={!selected} />
                </div>
              </div>
              <div className="row">
                <button type="button" className="btn btn-primary" onClick={save} disabled={!selected || place.isPending || !floor.data.floor.planFileId}>שמירת מיקום</button>
                {selectedPoint?.floorId === id && (
                  <button type="button" className="btn" onClick={() => place.mutate({ floorId: null })} disabled={place.isPending}>הסרה מהקומה</button>
                )}
              </div>
              <p aria-live="polite" className="small">{status}</p>
              {place.error && <div role="alert" className="alert alert-error">{errorMessage(place.error)}</div>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
