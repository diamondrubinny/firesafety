import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Building, FloorView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, ErrorBox, Loading } from '../components/Status';

export function BuildingDetailPage() {
  const { id = '' } = useParams();
  const { hasRole } = useAuth();
  const isAdmin = hasRole('FireAdmin');
  const { data, isLoading, error } = useQuery({
    queryKey: ['building', id],
    queryFn: () => api.get<Building>(`/api/buildings/${encodeURIComponent(id)}`),
    retry: false,
  });
  const floors = useQuery({
    queryKey: ['alarms', 'floors', id],
    queryFn: () => api.get<FloorView[]>(`/api/buildings/${encodeURIComponent(id)}/floors`),
    enabled: !!data,
  });
  useDocumentTitle(data?.name ?? 'מבנה');

  return (
    <section>
      <p><Link to="/buildings">חזרה לרשימת המבנים</Link></p>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <h1>{data.name}</h1>
          <dl className="details">
            <dt>קוד</dt>
            <dd dir="ltr">{data.code}</dd>
            <dt>פקולטה</dt>
            <dd>{data.facultyName ?? '—'}</dd>
            <dt>כתובת</dt>
            <dd>{data.address ?? '—'}</dd>
          </dl>

          <h2>קומות</h2>
          {floors.isLoading && <Loading />}
          {floors.error && <ErrorBox error={floors.error} />}
          {floors.data?.length === 0 && <Empty>לא הוגדרו קומות.</Empty>}
          {!!floors.data?.length && (
            <ul className="floor-list">
              {floors.data.map((f) => (
                <FloorItem key={f.id} floor={f} isAdmin={isAdmin} />
              ))}
            </ul>
          )}
          {isAdmin && <AddFloorForm buildingId={id} />}
        </>
      )}
    </section>
  );
}

function FloorItem({ floor, isAdmin }: { floor: FloorView; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/api/admin/floors/${floor.id}`),
    onSettled: () => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['alarms', 'floors'] });
    },
  });
  return (
    <li className="card row space-between">
      <div>
        <Link to={`/floors/${floor.id}`} className="h3">{floor.name}</Link>
        <span className="muted small"> · מפלס {floor.level}</span>
        {floor.abnormalCount > 0 && <strong className="err"> · {floor.abnormalCount} נקודות במצב חריג</strong>}
        {!floor.planFileId && <span className="muted small"> · ללא תוכנית</span>}
      </div>
      {isAdmin && (
        <div className="row">
          <Link className="btn btn-small" to={`/admin/floors/${floor.id}`}>עריכה<span className="sr-only"> {floor.name}</span></Link>
          <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirm(true)}>מחיקה<span className="sr-only"> {floor.name}</span></button>
        </div>
      )}
      {del.error && <ErrorBox error={del.error} />}
      <ConfirmDialog
        open={confirm}
        title="מחיקת קומה"
        message={`למחוק את "${floor.name}"? התוכנית תימחק, והנקודות יוסרו מהמפה (הן יישארו משויכות למבנה).`}
        confirmLabel="מחיקה"
        onConfirm={() => del.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </li>
  );
}

function AddFloorForm({ buildingId }: { buildingId: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [level, setLevel] = useState('0');
  const create = useMutation({
    mutationFn: () => api.post<FloorView>(`/api/admin/buildings/${buildingId}/floors`, { name, level: Number(level) }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['alarms', 'floors', buildingId] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="card narrow" aria-labelledby="add-floor">
      <h3 id="add-floor" className="h3">הוספת קומה</h3>
      {create.error && <div role="alert" className="alert alert-error">{errorMessage(create.error)}</div>}
      <label htmlFor="floor-name">שם</label>
      <input id="floor-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: קומה 2" />
      <label htmlFor="floor-level">מפלס (מספר, קרקע = 0)</label>
      <input id="floor-level" type="number" required min={-20} max={300} step={1} value={level} onChange={(e) => setLevel(e.target.value)} />
      <button type="submit" className="btn btn-primary" disabled={create.isPending}>הוספה</button>
    </form>
  );
}
