import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollectorView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, ErrorBox, Loading } from '../components/Status';

type Pending = { kind: 'rotate' | 'deactivate'; collector: CollectorView } | null;

export function AdminCollectorsPage() {
  useDocumentTitle('Collectors');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['collectors'], queryFn: () => api.get<CollectorView[]>('/api/admin/collectors'), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ collector: CollectorView; token: string }>('/api/admin/collectors', { name }),
    onSuccess: (r) => {
      setSecret({ name: r.collector.name, token: r.token });
      setName('');
      void qc.invalidateQueries({ queryKey: ['collectors'] });
    },
  });
  const act = useMutation({
    mutationFn: async (p: NonNullable<Pending>) => {
      if (p.kind === 'rotate') {
        const r = await api.post<{ token: string }>(`/api/admin/collectors/${p.collector.id}/rotate-token`);
        setSecret({ name: p.collector.name, token: r.token });
      } else {
        await api.post(`/api/admin/collectors/${p.collector.id}/deactivate`);
      }
    },
    onSettled: () => {
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['collectors'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <section aria-labelledby="collectors-title">
      <h1 id="collectors-title">Collectors</h1>
      <p className="muted">Collector הוא שירות שמותקן ברשת הרכזות, קורא מהן בלבד ומדווח לשרת. לכל Collector יש מפתח גישה אישי.</p>

      {secret && (
        <div className="alert alert-warning" role="alert">
          <p><strong>מפתח הגישה של "{secret.name}" יוצג פעם אחת בלבד.</strong> יש להעתיק אותו כעת להגדרות ה-Collector (FS_COLLECTOR_TOKEN). אין לשלוח אותו בדוא"ל או בצ'אט.</p>
          <label htmlFor="token-out">מפתח גישה</label>
          <input id="token-out" readOnly dir="ltr" value={secret.token} className="code token" onFocus={(e) => e.target.select()} />
          <div className="row">
            <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(secret.token)}>העתקה</button>
            <button type="button" className="btn" onClick={() => setSecret(null)}>העתקתי, הסתרה</button>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="card narrow" aria-labelledby="new-collector">
        <h2 id="new-collector">הוספת Collector</h2>
        {create.error && <div role="alert" className="alert alert-error">{errorMessage(create.error)}</div>}
        <label htmlFor="collector-name">שם (תיאורי, ללא פרטים מזהים של המוסד)</label>
        <input id="collector-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>יצירה</button>
      </form>

      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data?.length === 0 && <Empty>לא הוגדרו Collectors.</Empty>}
      {!!list.data?.length && (
        <table className="table">
          <thead>
            <tr><th scope="col">שם</th><th scope="col">מצב</th><th scope="col">דיווח אחרון</th><th scope="col">גרסה</th><th scope="col">ממתינים לשליחה</th><th scope="col"><span className="sr-only">פעולות</span></th></tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{!c.active ? 'מושבת' : c.online ? <span className="ok">✓ מחובר</span> : <strong className="err">✕ מנותק</strong>}</td>
                <td>{c.lastSeenAt ? formatDateTime(c.lastSeenAt) : 'מעולם לא'}</td>
                <td dir="ltr">{c.version ?? '—'}</td>
                <td>{c.bufferDepth ?? '—'}</td>
                <td>
                  {c.active && (
                    <div className="row">
                      <button type="button" className="btn btn-small" onClick={() => setPending({ kind: 'rotate', collector: c })}>החלפת מפתח<span className="sr-only"> {c.name}</span></button>
                      <button type="button" className="btn btn-small btn-danger" onClick={() => setPending({ kind: 'deactivate', collector: c })}>השבתה<span className="sr-only"> {c.name}</span></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {act.error && <ErrorBox error={act.error} />}
      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === 'rotate' ? 'החלפת מפתח גישה' : 'השבתת Collector'}
        message={
          pending?.kind === 'rotate'
            ? `המפתח הנוכחי של "${pending.collector.name}" יפסיק לעבוד מיד. עד שיוגדר המפתח החדש, לא יתקבלו נתונים.`
            : `"${pending?.collector.name ?? ''}" יפסיק לדווח, והרכזות שלו לא ינוטרו.`
        }
        confirmLabel={pending?.kind === 'rotate' ? 'החלפה' : 'השבתה'}
        onConfirm={() => pending && act.mutate(pending)}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
