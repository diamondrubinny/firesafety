import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Building, Faculty } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, ErrorBox, Loading } from '../components/Status';

export function AdminBuildingsPage() {
  useDocumentTitle('ניהול מבנים');
  const qc = useQueryClient();
  const buildings = useQuery({ queryKey: ['buildings'], queryFn: () => api.get<Building[]>('/api/buildings') });
  const faculties = useQuery({ queryKey: ['faculties'], queryFn: () => api.get<Faculty[]>('/api/faculties') });
  const [toDelete, setToDelete] = useState<Building | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/buildings/${id}`),
    onSuccess: () => {
      setNotice('המבנה נמחק.');
      void qc.invalidateQueries({ queryKey: ['buildings'] });
    },
    onSettled: () => setToDelete(null),
  });

  return (
    <section aria-labelledby="admin-buildings-title">
      <h1 id="admin-buildings-title">ניהול מבנים</h1>
      <div aria-live="polite">{notice && <div className="alert alert-success">{notice}</div>}</div>
      {remove.error && <ErrorBox error={remove.error} />}

      <div className="grid-2">
        <FacultyForm onDone={setNotice} />
        <BuildingForm faculties={faculties.data ?? []} onDone={setNotice} />
      </div>

      <h2>מבנים קיימים</h2>
      {buildings.isLoading && <Loading />}
      {buildings.error && <ErrorBox error={buildings.error} />}
      {buildings.data?.length === 0 && <Empty>עדיין לא הוגדרו מבנים.</Empty>}
      {!!buildings.data?.length && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">קוד</th>
              <th scope="col">שם</th>
              <th scope="col">פקולטה</th>
              <th scope="col"><span className="sr-only">פעולות</span></th>
            </tr>
          </thead>
          <tbody>
            {buildings.data.map((b) => (
              <tr key={b.id}>
                <td dir="ltr" className="code">{b.code}</td>
                <td>{b.name}</td>
                <td>{b.facultyName ?? '—'}</td>
                <td>
                  <button type="button" className="btn btn-small btn-danger" onClick={() => setToDelete(b)}>
                    מחיקה<span className="sr-only"> {b.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title="מחיקת מבנה"
        message={`למחוק את "${toDelete?.name ?? ''}"? הפעולה תסיר גם את שיוכי ההרשאות למבנה ואינה ניתנת לביטול.`}
        confirmLabel="מחיקה"
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        onCancel={() => setToDelete(null)}
      />
    </section>
  );
}

function FacultyForm({ onDone }: { onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<Faculty>('/api/admin/faculties', { name }),
    onSuccess: (f) => {
      setName('');
      onDone(`הפקולטה "${f.name}" נוספה.`);
      void qc.invalidateQueries({ queryKey: ['faculties'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="card" aria-labelledby="faculty-form-title">
      <h2 id="faculty-form-title">הוספת פקולטה</h2>
      {create.error && <div role="alert" className="alert alert-error">{errorMessage(create.error)}</div>}
      <label htmlFor="faculty-name">שם הפקולטה</label>
      <input id="faculty-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className="btn btn-primary" disabled={create.isPending} aria-busy={create.isPending}>
        הוספה
      </button>
    </form>
  );
}

function BuildingForm({ faculties, onDone }: { faculties: Faculty[]; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', code: '', facultyId: '', address: '' });
  const create = useMutation({
    mutationFn: () =>
      api.post<Building>('/api/admin/buildings', {
        name: form.name,
        code: form.code,
        facultyId: form.facultyId || null,
        address: form.address || undefined,
      }),
    onSuccess: (b) => {
      setForm({ name: '', code: '', facultyId: '', address: '' });
      onDone(`המבנה "${b.name}" נוסף.`);
      void qc.invalidateQueries({ queryKey: ['buildings'] });
    },
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="card" aria-labelledby="building-form-title">
      <h2 id="building-form-title">הוספת מבנה</h2>
      {create.error && <div role="alert" className="alert alert-error">{errorMessage(create.error)}</div>}
      <label htmlFor="b-name">שם המבנה</label>
      <input id="b-name" required maxLength={160} value={form.name} onChange={set('name')} />
      <label htmlFor="b-code">קוד מבנה</label>
      <input
        id="b-code"
        required
        maxLength={32}
        pattern="[A-Za-z0-9._\-]+"
        dir="ltr"
        aria-describedby="b-code-hint"
        value={form.code}
        onChange={set('code')}
      />
      <small id="b-code-hint" className="muted">אותיות באנגלית, ספרות, נקודה, קו תחתון ומקף בלבד.</small>
      <label htmlFor="b-faculty">פקולטה</label>
      <select id="b-faculty" value={form.facultyId} onChange={set('facultyId')}>
        <option value="">ללא</option>
        {faculties.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      <label htmlFor="b-address">כתובת (לא חובה)</label>
      <input id="b-address" maxLength={240} value={form.address} onChange={set('address')} />
      <button type="submit" className="btn btn-primary" disabled={create.isPending} aria-busy={create.isPending}>
        הוספה
      </button>
    </form>
  );
}
