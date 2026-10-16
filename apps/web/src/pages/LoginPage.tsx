import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, ROLE_LABELS_HE, type AuthModeInfo, type Role } from '@firesafety/shared';
import { api, ApiRequestError, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { Footer } from '../components/Layout';

const ERRORS_HE: Record<string, string> = {
  no_app_role: 'לחשבון שלך לא הוקצה תפקיד במערכת. נא לפנות למנהל המערכת.',
  wrong_tenant: 'ניתן להתחבר רק עם חשבון של המוסד.',
  mfa_required: 'נדרש אימות דו-שלבי. נא להתחבר שוב ולהשלים את האימות.',
  user_inactive: 'החשבון אינו פעיל. נא לפנות למנהל המערכת.',
  login_state_expired: 'תהליך ההתחברות פג תוקף. נא לנסות שוב.',
  missing_login_state: 'תהליך ההתחברות פג תוקף. נא לנסות שוב.',
};
const GENERIC_ERROR = 'ההתחברות נכשלה. נא לנסות שוב או לפנות למנהל המערכת.';

/** Only same-site relative paths (mirrors the server-side check). */
function safeReturnTo(v: string | null): string {
  if (!v || v.length > 512) return '/';
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\r\n\t]/.test(v)) return '/';
  return v;
}

export function LoginPage() {
  useDocumentTitle('התחברות');
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const errorCode = params.get('error');
  const { data: mode } = useQuery({ queryKey: ['auth-mode'], queryFn: () => api.get<AuthModeInfo>('/auth/mode') });

  return (
    <>
      <main id="main" className="login">
        <h1>ניטור בטיחות אש</h1>
        <p>התחברות עם חשבון המוסד (Microsoft).</p>
        {errorCode && (
          <div role="alert" className="alert alert-error">
            {ERRORS_HE[errorCode] ?? GENERIC_ERROR}
          </div>
        )}
        <a className="btn btn-primary btn-large" href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
          התחברות עם Microsoft
        </a>
        {mode?.breakGlass && <BreakGlassLogin returnTo={returnTo} />}
        {mode?.mode === 'dev' && <DevLogin returnTo={returnTo} />}
      </main>
      <Footer />
    </>
  );
}

function DevLogin({ returnTo }: { returnTo: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('admin@example.test');
  const [role, setRole] = useState<Role>('FireAdmin');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/dev-login', { email, displayName: email.split('@')[0], roles: [role] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      window.location.assign(returnTo);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card dev-login" aria-labelledby="dev-login-title">
      <h2 id="dev-login-title">התחברות פיתוח (לא לשימוש בייצור)</h2>
      {error && <div role="alert" className="alert alert-error">{error}</div>}
      <label htmlFor="dev-email">אימייל</label>
      <input id="dev-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" autoComplete="off" />
      <label htmlFor="dev-role">תפקיד</label>
      <select id="dev-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>{ROLE_LABELS_HE[r]}</option>
        ))}
      </select>
      <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
        {busy ? 'מתחבר…' : 'התחברות'}
      </button>
    </form>
  );
}

/** Emergency login for when Entra ID is unavailable. Collapsed by default so it is not mistaken for the normal path. */
function BreakGlassLogin({ returnTo }: { returnTo: string }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/break-glass', { username, password, code: code.trim() });
      await qc.invalidateQueries({ queryKey: ['me'] });
      window.location.assign(returnTo);
    } catch (err) {
      // Deliberately one message for every failure: the server does not say which factor was wrong.
      setError(
        err instanceof ApiRequestError && err.status === 401
          ? 'פרטי הכניסה שגויים, או שהחשבון ננעל זמנית לאחר ניסיונות כושלים.'
          : err instanceof ApiRequestError && err.status === 400
            ? 'יש למלא שם משתמש, סיסמה וקוד אימות בן 6 ספרות.'
            : errorMessage(err),
      );
      setPassword('');
      setCode('');
      setBusy(false);
    }
  }

  return (
    <details className="card break-glass-login">
      <summary>כניסת חירום (כאשר ההתחברות עם Microsoft אינה זמינה)</summary>
      <p className="muted">
        לשימוש רק כאשר שירות ההתחברות של המוסד אינו זמין. כל כניסה מתועדת ומדווחת מיד למנהלי המערכת.
      </p>
      <form onSubmit={submit} aria-labelledby="bg-title" noValidate>
        <h2 id="bg-title" className="sr-only">כניסת חירום</h2>
        {error && <div role="alert" className="alert alert-error">{error}</div>}
        <label htmlFor="bg-username">שם משתמש חירום</label>
        <input id="bg-username" required value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} />
        <label htmlFor="bg-password">סיסמה</label>
        <input id="bg-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" autoComplete="current-password" />
        <label htmlFor="bg-code">קוד אימות (6 ספרות מאפליקציית האימות)</label>
        <input
          id="bg-code"
          required
          value={code}
          // No maxLength: apps often display "123 456"; strip separators first, then cap at 6 digits.
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
        />
        <button type="submit" className="btn btn-danger" disabled={busy} aria-busy={busy}>
          {busy ? 'מתחבר…' : 'כניסת חירום'}
        </button>
      </form>
    </details>
  );
}
