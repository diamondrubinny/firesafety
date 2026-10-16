import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS_HE, hasGlobalScope, type AdminUser, type Building, type Page } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ErrorBox, Loading } from '../components/Status';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function AdminUsersPage() {
  useDocumentTitle('משתמשים והרשאות');
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<Page<AdminUser>>('/api/admin/users?limit=200') });
  const buildings = useQuery({ queryKey: ['buildings'], queryFn: () => api.get<Building[]>('/api/buildings') });

  return (
    <section aria-labelledby="users-title">
      <h1 id="users-title">משתמשים והרשאות</h1>
      <p className="muted">
        התפקידים מנוהלים ב-Microsoft Entra ID ומתעדכנים בכל התחברות. כאן מגדירים רק אילו מבנים כל משתמש רואה.
      </p>
      {(users.isLoading || buildings.isLoading) && <Loading />}
      {users.error && <ErrorBox error={users.error} />}
      {users.data && buildings.data && (
        <ul className="user-list">
          {users.data.items.map((u) => (
            <UserScopeEditor key={u.id} user={u} buildings={buildings.data} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActiveToggle({ user }: { user: AdminUser }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const act = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${user.id}/${user.active ? 'deactivate' : 'activate'}`),
    onSettled: () => { setConfirm(false); void qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });
  return (
    <div className="row">
      {user.active ? (
        <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirm(true)}>השבתת משתמש<span className="sr-only"> {user.displayName}</span></button>
      ) : (
        <button type="button" className="btn btn-small" onClick={() => act.mutate()}>הפעלה מחדש<span className="sr-only"> {user.displayName}</span></button>
      )}
      {act.error && <span role="alert" className="err small">{errorMessage(act.error)}</span>}
      <ConfirmDialog
        open={confirm}
        title="השבתת משתמש"
        message={`להשבית את ${user.displayName}? כל ההתחברויות הפעילות שלו יבוטלו מיד, והוא לא יקבל התראות.`}
        confirmLabel="השבתה"
        onConfirm={() => act.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function UserScopeEditor({ user, buildings }: { user: AdminUser; buildings: Building[] }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(() => new Set(user.buildingIds));
  const [saved, setSaved] = useState(false);
  const global = hasGlobalScope(user.roles);
  const save = useMutation({
    mutationFn: () => api.put(`/api/admin/users/${user.id}/scope`, { buildingIds: [...selected] }),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  const toggle = (id: string) => {
    setSaved(false);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const groupId = `scope-${user.id}`;

  return (
    <li className="card">
      <h2 className="h3">
        {user.displayName} <span className="muted" dir="ltr">{user.email}</span>
      </h2>
      <p>
        תפקידים: {user.roles.map((r) => ROLE_LABELS_HE[r]).join(', ') || '—'}
        {!user.active && <strong> (לא פעיל)</strong>}
      </p>
      <ActiveToggle user={user} />
      {global ? (
        <p className="muted">מנהל מערכת רואה את כל המבנים.</p>
      ) : (
        <fieldset aria-describedby={`${groupId}-status`}>
          <legend>מבנים בהרשאה</legend>
          <div className="checkbox-grid">
            {buildings.map((b) => (
              <label key={b.id} className="checkbox">
                <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} />
                {b.name} <span dir="ltr" className="code">({b.code})</span>
              </label>
            ))}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending} aria-busy={save.isPending}>
            שמירת הרשאות
          </button>
          <span id={`${groupId}-status`} aria-live="polite">
            {saved && <span className="ok"> נשמר ✓</span>}
            {save.error && <span className="err"> {errorMessage(save.error)}</span>}
          </span>
        </fieldset>
      )}
    </li>
  );
}
