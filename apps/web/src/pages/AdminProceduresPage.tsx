import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROCEDURE_CATEGORIES, PROCEDURE_CATEGORY_LABELS_HE, type Building, type ProcedureCategory, type ProcedureView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, ErrorBox, Loading } from '../components/Status';

interface FormState { id: string | null; name: string; category: ProcedureCategory; buildingId: string; steps: string; active: boolean }
const EMPTY: FormState = { id: null, name: '', category: 'fire', buildingId: '', steps: '', active: true };

export function AdminProceduresPage() {
  useDocumentTitle('נהלי טיפול');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['procedures'], queryFn: () => api.get<ProcedureView[]>('/api/admin/procedures') });
  const buildings = useQuery({ queryKey: ['buildings'], queryFn: () => api.get<Building[]>('/api/buildings') });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [toDelete, setToDelete] = useState<ProcedureView | null>(null);
  const [notice, setNotice] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        category: form.category,
        buildingId: form.buildingId || null,
        steps: form.steps.split('\n').map((l) => l.trim()).filter(Boolean),
        active: form.active,
      };
      return form.id ? api.put(`/api/admin/procedures/${form.id}`, body) : api.post('/api/admin/procedures', body);
    },
    onSuccess: () => {
      setNotice(form.id ? 'הנוהל עודכן (גרסה חדשה).' : 'הנוהל נוצר.');
      setForm(EMPTY);
      void qc.invalidateQueries({ queryKey: ['procedures'] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/procedures/${id}`),
    onSettled: () => { setToDelete(null); void qc.invalidateQueries({ queryKey: ['procedures'] }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setNotice(''); save.mutate(); };
  const edit = (p: ProcedureView) => {
    setNotice('');
    setForm({ id: p.id, name: p.name, category: p.category, buildingId: p.buildingId ?? '', steps: p.steps.join('\n'), active: p.active });
    document.getElementById('proc-form')?.scrollIntoView();
    document.getElementById('pr-name')?.focus();
  };

  return (
    <section aria-labelledby="procs-title">
      <h1 id="procs-title">נהלי טיפול</h1>
      <p className="muted">
        נוהל מוצג כצ'קליסט בדף האירוע. נוהל של מבנה מסוים גובר על הנוהל הכללי של אותו סוג אירוע.
        עריכה יוצרת גרסה חדשה. אירועים שכבר טופלו שומרים את הגרסה שבוצעה בהם.
      </p>
      <div aria-live="polite">{notice && <div className="alert alert-success">{notice}</div>}</div>

      <form id="proc-form" onSubmit={submit} className="card" aria-labelledby="pf-title">
        <h2 id="pf-title" className="h3">{form.id ? 'עריכת נוהל' : 'נוהל חדש'}</h2>
        {save.error && <div role="alert" className="alert alert-error">{errorMessage(save.error)}</div>}
        <div className="grid-3">
          <div className="field">
            <label htmlFor="pr-name">שם</label>
            <input id="pr-name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pr-cat">סוג אירוע</label>
            <select id="pr-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ProcedureCategory })}>
              {PROCEDURE_CATEGORIES.map((c) => <option key={c} value={c}>{PROCEDURE_CATEGORY_LABELS_HE[c]}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pr-b">מבנה</label>
            <select id="pr-b" value={form.buildingId} onChange={(e) => setForm({ ...form, buildingId: e.target.value })}>
              <option value="">כל המבנים (כללי)</option>
              {buildings.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="pr-steps">צעדים (שורה לכל צעד, עד 30)</label>
          <textarea id="pr-steps" required rows={6} value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} aria-describedby="pr-steps-hint" />
          <small id="pr-steps-hint" className="muted">לדוגמה: "לשלוח מאבטח לבדיקה", "לוודא שהכבאות הוזעקה", "לעדכן את ממונה הבטיחות".</small>
        </div>
        <label className="checkbox"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />פעיל</label>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>{form.id ? 'שמירת שינויים' : 'יצירה'}</button>
          {form.id && <button type="button" className="btn" onClick={() => setForm(EMPTY)}>ביטול עריכה</button>}
        </div>
      </form>

      <h2>נהלים קיימים</h2>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data?.length === 0 && <Empty>לא הוגדרו נהלים.</Empty>}
      {!!list.data?.length && (
        <table className="table">
          <thead><tr><th scope="col">שם</th><th scope="col">סוג</th><th scope="col">מבנה</th><th scope="col">צעדים</th><th scope="col">גרסה</th><th scope="col">מצב</th><th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{PROCEDURE_CATEGORY_LABELS_HE[p.category]}</td>
                <td>{p.buildingName ?? 'כללי'}</td>
                <td>{p.steps.length}</td>
                <td>{p.version} <span className="muted small">({formatDateTime(p.updatedAt)})</span></td>
                <td>{p.active ? 'פעיל' : 'לא פעיל'}</td>
                <td>
                  <div className="row">
                    <button type="button" className="btn btn-small" onClick={() => edit(p)}>עריכה<span className="sr-only"> {p.name}</span></button>
                    <button type="button" className="btn btn-small btn-danger" onClick={() => setToDelete(p)}>מחיקה<span className="sr-only"> {p.name}</span></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {del.error && <ErrorBox error={del.error} />}
      <ConfirmDialog
        open={!!toDelete}
        title="מחיקת נוהל"
        message={`למחוק את "${toDelete?.name ?? ''}"? ביצועים קודמים באירועים יישמרו. אפשר גם לסמן אותו כלא פעיל במקום למחוק.`}
        confirmLabel="מחיקה"
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        onCancel={() => setToDelete(null)}
      />
    </section>
  );
}
