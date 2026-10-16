import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlarmProcedureView, ProcedureRunView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { formatDateTime } from '../lib/format';

/** Step-by-step procedure for an alarm. Checking a step records who and when; nothing is sent to the panel. */
export function ProcedureChecklist({ alarmId, canHandle }: { alarmId: string; canHandle: boolean }) {
  const qc = useQueryClient();
  const key = ['alarms', 'procedure', alarmId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<AlarmProcedureView>(`/api/alarms/${alarmId}/procedure`) });
  // Optimistic: the box changes in the same render as the click; reverted if the server rejects it.
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const clearPending = (index: number) =>
    setPending((p) => {
      const next = { ...p };
      delete next[index];
      return next;
    });
  const toggle = useMutation({
    mutationFn: ({ index, done }: { index: number; done: boolean }) => api.post<ProcedureRunView>(`/api/alarms/${alarmId}/procedure/steps/${index}`, { done }),
    onSuccess: (run, { index }) => {
      qc.setQueryData(key, { template: null, run });
      clearPending(index);
    },
    onError: (_err, { index }) => clearPending(index),
  });
  const onToggle = (index: number, done: boolean) => {
    setPending((p) => ({ ...p, [index]: done }));
    toggle.mutate({ index, done });
  };

  if (error) return null;
  if (!data) return null;
  if (!data.run && !data.template) return <p className="muted small">לא הוגדר נוהל טיפול לסוג אירוע זה.</p>;

  const name = data.run?.procedureName ?? data.template!.name;
  const steps = (data.run?.steps ?? data.template!.steps.map((text) => ({ text, done: false, by: null as string | null, at: null as string | null }))).map(
    (st, i) => (i in pending ? { ...st, done: pending[i]!, by: pending[i] ? 'שומר…' : null, at: null } : st),
  );
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section className="card" aria-labelledby="proc-title">
      <h2 id="proc-title" className="h3">נוהל טיפול: {name}</h2>
      <p className="small" aria-live="polite">
        {doneCount} מתוך {steps.length} צעדים בוצעו
        {data.run?.completedAt && <strong className="ok"> · הושלם {formatDateTime(data.run.completedAt)}</strong>}
      </p>
      <ol className="checklist">
        {steps.map((s, i) => (
          <li key={i} className={s.done ? 'done' : undefined}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={s.done}
                disabled={!canHandle}
                onChange={(e) => onToggle(i, e.target.checked)}
              />
              <span>{s.text}</span>
            </label>
            {s.done && s.by && <span className="muted small"> בוצע ע"י {s.by}, {s.at ? formatDateTime(s.at) : ''}</span>}
          </li>
        ))}
      </ol>
      {!canHandle && <p className="muted small">צפייה בלבד.</p>}
      {toggle.error && <div role="alert" className="alert alert-error">{errorMessage(toggle.error)}</div>}
    </section>
  );
}
