import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_LABELS_HE,
  CHANNELS,
  type Channel,
  type NotificationSecrets,
  type NotificationSettings,
  type NotificationSettingsView,
  type SecretName,
} from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ErrorBox, Loading } from '../components/Status';

type PolicyKey = 'fire' | 'prealarm' | 'fault' | 'comm';
const POLICY_LABELS: Record<PolicyKey, string> = { fire: 'אש', prealarm: 'קדם-אזעקה', fault: 'תקלה', comm: 'תקלת תקשורת (מנהלים בלבד)' };

export function AdminNotificationSettingsPage() {
  useDocumentTitle('הגדרות התראות');
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'notification-settings'],
    queryFn: () => api.get<NotificationSettingsView>('/api/admin/settings/notifications'),
  });
  const [s, setS] = useState<NotificationSettings | null>(null);
  const [secrets, setSecrets] = useState<NotificationSecrets>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setS(structuredClone(data.settings));
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put<NotificationSettingsView>('/api/admin/settings/notifications', { settings: s, secrets }),
    onSuccess: (v) => {
      qc.setQueryData(['admin', 'notification-settings'], v);
      setSecrets({});
      setSaved(true);
    },
  });

  if (isLoading || !s) return error ? <ErrorBox error={error} /> : <Loading />;
  const set = (fn: (d: NotificationSettings) => void) => {
    setSaved(false);
    setS((cur) => {
      const next = structuredClone(cur!);
      fn(next);
      return next;
    });
  };
  const secret = (name: SecretName, label: string, hint?: string) => (
    <SecretField
      name={name}
      label={label}
      hint={hint}
      configured={data!.secretsConfigured[name]}
      value={secrets[name]}
      onChange={(v) => { setSaved(false); setSecrets((x) => ({ ...x, [name]: v })); }}
    />
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <section aria-labelledby="ns-title">
      <div className="row space-between">
        <h1 id="ns-title">הגדרות התראות</h1>
        <Link to="/admin/notifications">יומן משלוחים</Link>
      </div>
      <p className="muted">
        סיסמאות ומפתחות נשמרים מוצפנים ואינם מוצגים שוב. השארת שדה סודי ריק שומרת את הערך הקיים.
        שמירה ובדיקה נרשמות ביומן הפעולות.
      </p>

      <form onSubmit={submit} className="settings-form">
        <label className="checkbox big">
          <input type="checkbox" checked={s.enabled} onChange={(e) => set((d) => { d.enabled = e.target.checked; })} />
          שליחת התראות פעילה
        </label>

        <Section title={CHANNEL_LABELS_HE.push} enabled={s.push.enabled} onToggle={(v) => set((d) => { d.push.enabled = v; })} channel="push">
          <Field id="push-subject" label="כתובת קשר למפעיל (VAPID subject)" hint="mailto: או https:, נדרש על ידי שירותי Push">
            <input id="push-subject" dir="ltr" value={s.push.subject} onChange={(e) => set((d) => { d.push.subject = e.target.value; })} placeholder="mailto:safety@campus.example" />
          </Field>
          <p className="muted small">מפתחות VAPID נוצרים אוטומטית. מפתח ציבורי: <code dir="ltr" className="code break">{data!.pushPublicKey ?? 'ייווצר בשמירה'}</code></p>
        </Section>

        <Section title={CHANNEL_LABELS_HE.email} enabled={s.email.enabled} onToggle={(v) => set((d) => { d.email.enabled = v; })} channel="email" testPlaceholder="name@campus.example">
          <div className="grid-3">
            <Field id="em-host" label="שרת SMTP"><input id="em-host" dir="ltr" value={s.email.host} onChange={(e) => set((d) => { d.email.host = e.target.value; })} /></Field>
            <Field id="em-port" label="פורט"><input id="em-port" type="number" dir="ltr" value={s.email.port} onChange={(e) => set((d) => { d.email.port = Number(e.target.value); })} /></Field>
            <Field id="em-from" label="שולח (From)"><input id="em-from" dir="ltr" value={s.email.from} onChange={(e) => set((d) => { d.email.from = e.target.value; })} /></Field>
            <Field id="em-user" label="משתמש"><input id="em-user" dir="ltr" autoComplete="off" value={s.email.user} onChange={(e) => set((d) => { d.email.user = e.target.value; })} /></Field>
            {secret('emailPassword', 'סיסמה')}
          </div>
          <label className="checkbox"><input type="checkbox" checked={s.email.secure} onChange={(e) => set((d) => { d.email.secure = e.target.checked; })} />TLS מלא (פורט 465). אחרת נדרש STARTTLS.</label>
        </Section>

        <Section title={CHANNEL_LABELS_HE.sms} enabled={s.sms.enabled} onToggle={(v) => set((d) => { d.sms.enabled = v; })} channel="sms" testPlaceholder="050-1234567">
          <Field id="sms-provider" label="ספק">
            <select id="sms-provider" value={s.sms.provider} onChange={(e) => set((d) => { d.sms.provider = e.target.value as 'twilio' | 'http'; })}>
              <option value="http">HTTP כללי (כל ספק ישראלי לפי התיעוד שלו)</option>
              <option value="twilio">Twilio</option>
            </select>
          </Field>
          {s.sms.provider === 'twilio' ? (
            <div className="grid-3">
              <Field id="tw-sid" label="Account SID"><input id="tw-sid" dir="ltr" value={s.sms.twilio.accountSid} onChange={(e) => set((d) => { d.sms.twilio.accountSid = e.target.value; })} /></Field>
              <Field id="tw-from" label="מספר שולח"><input id="tw-from" dir="ltr" value={s.sms.twilio.from} onChange={(e) => set((d) => { d.sms.twilio.from = e.target.value; })} /></Field>
              {secret('twilioAuthToken', 'Auth Token')}
            </div>
          ) : (
            <>
              <p className="muted small">משתנים זמינים: <code dir="ltr">{'{{to}}'}</code> (E.164, למשל +97250…), <code dir="ltr">{'{{text}}'}</code>. יש למלא לפי התיעוד הרשמי של הספק.</p>
              <div className="grid-3">
                <Field id="sh-url" label="כתובת (https)"><input id="sh-url" dir="ltr" value={s.sms.http.url} onChange={(e) => set((d) => { d.sms.http.url = e.target.value; })} /></Field>
                <Field id="sh-method" label="Method">
                  <select id="sh-method" value={s.sms.http.method} onChange={(e) => set((d) => { d.sms.http.method = e.target.value as 'POST' | 'GET'; })}><option>POST</option><option>GET</option></select>
                </Field>
                <Field id="sh-ct" label="Content-Type">
                  <select id="sh-ct" dir="ltr" value={s.sms.http.contentType} onChange={(e) => set((d) => { d.sms.http.contentType = e.target.value as NotificationSettings['sms']['http']['contentType']; })}>
                    <option>application/json</option><option>application/x-www-form-urlencoded</option>
                  </select>
                </Field>
              </div>
              <Field id="sh-body" label="תבנית גוף הבקשה">
                <textarea id="sh-body" dir="ltr" rows={3} className="code" value={s.sms.http.bodyTemplate} onChange={(e) => set((d) => { d.sms.http.bodyTemplate = e.target.value; })} />
              </Field>
              {secret('smsHttpHeaders', 'כותרות HTTP נוספות (JSON, למשל מפתח API)', '{"Authorization":"Bearer …"}')}
            </>
          )}
        </Section>

        <Section title={CHANNEL_LABELS_HE.whatsapp} enabled={s.whatsapp.enabled} onToggle={(v) => set((d) => { d.whatsapp.enabled = v; })} channel="whatsapp" testPlaceholder="050-1234567">
          <p className="muted small">
            WhatsApp Business Cloud API (רשמי). נדרשת תבנית מאושרת עם שני משתנים: <code>{'{{1}}'}</code> = תיאור האירוע, <code>{'{{2}}'}</code> = קישור.
            לדוגמה: "התרעת מערכת ניטור אש: {'{{1}}'}. פרטים: {'{{2}}'}". הודעות נשלחות רק למשתמשים שאישרו קבלה.
          </p>
          <div className="grid-3">
            <Field id="wa-pn" label="Phone Number ID"><input id="wa-pn" dir="ltr" value={s.whatsapp.phoneNumberId} onChange={(e) => set((d) => { d.whatsapp.phoneNumberId = e.target.value; })} /></Field>
            <Field id="wa-ver" label="גרסת Graph API" hint="לפי התיעוד העדכני של Meta, למשל v21.0"><input id="wa-ver" dir="ltr" value={s.whatsapp.apiVersion} onChange={(e) => set((d) => { d.whatsapp.apiVersion = e.target.value; })} /></Field>
            <Field id="wa-tpl" label="שם התבנית"><input id="wa-tpl" dir="ltr" value={s.whatsapp.templateName} onChange={(e) => set((d) => { d.whatsapp.templateName = e.target.value; })} /></Field>
            <Field id="wa-lang" label="שפת התבנית"><input id="wa-lang" dir="ltr" value={s.whatsapp.templateLanguage} onChange={(e) => set((d) => { d.whatsapp.templateLanguage = e.target.value; })} /></Field>
            {secret('whatsappAccessToken', 'Access Token')}
          </div>
        </Section>

        <fieldset className="card">
          <legend className="h3">מדיניות שליחה</legend>
          <table className="table">
            <caption className="sr-only">ערוצים לפי סוג אירוע</caption>
            <thead><tr><th scope="col">סוג אירוע</th>{CHANNELS.map((c) => <th key={c} scope="col">{CHANNEL_LABELS_HE[c]}</th>)}</tr></thead>
            <tbody>
              {(Object.keys(POLICY_LABELS) as PolicyKey[]).map((k) => (
                <tr key={k}>
                  <th scope="row">{POLICY_LABELS[k]}</th>
                  {CHANNELS.map((c) => (
                    <td key={c}>
                      <input
                        type="checkbox"
                        aria-label={`${POLICY_LABELS[k]}: ${CHANNEL_LABELS_HE[c]}`}
                        checked={s.policy[k].includes(c)}
                        onChange={(e) => set((d) => { d.policy[k] = e.target.checked ? [...d.policy[k], c] : d.policy[k].filter((x) => x !== c); })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row">הסלמת אש</th>
                {CHANNELS.map((c) => (
                  <td key={c}>
                    <input
                      type="checkbox"
                      aria-label={`הסלמה: ${CHANNEL_LABELS_HE[c]}`}
                      checked={s.policy.escalationChannels.includes(c)}
                      onChange={(e) => set((d) => { d.policy.escalationChannels = e.target.checked ? [...d.policy.escalationChannels, c] : d.policy.escalationChannels.filter((x) => x !== c); })}
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <div className="grid-3">
            <Field id="esc" label="הסלמה אם אין אישור קבלה אחרי (שניות)" hint="30–3600. ההסלמה נשלחת גם למנהלי המערכת.">
              <input id="esc" type="number" min={30} max={3600} value={s.policy.escalationSeconds} onChange={(e) => set((d) => { d.policy.escalationSeconds = Number(e.target.value); })} />
            </Field>
            <Field id="grp" label="חלון קיבוץ הודעות (שניות)" hint="ההודעה הראשונה נשלחת מיד, והמשך פרץ ההתראות מאוחד להודעה אחת">
              <input id="grp" type="number" min={0} max={300} value={s.policy.groupingSeconds} onChange={(e) => set((d) => { d.policy.groupingSeconds = Number(e.target.value); })} />
            </Field>
          </div>
        </fieldset>

        {save.error && <div role="alert" className="alert alert-error">{errorMessage(save.error)}</div>}
        <div className="row sticky-actions">
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>שמירת הגדרות</button>
          <span aria-live="polite">{saved && <span className="ok">נשמר ✓</span>}</span>
        </div>
      </form>
    </section>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

function SecretField(props: { name: SecretName; label: string; hint?: string; configured: boolean; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const id = `secret-${props.name}`;
  const clearing = props.value === '';
  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label} <span className={props.configured ? 'ok small' : 'muted small'}>{props.configured ? (clearing ? '(יימחק בשמירה)' : '(מוגדר)') : '(לא מוגדר)'}</span>
      </label>
      <input
        id={id}
        type="password"
        dir="ltr"
        autoComplete="new-password"
        placeholder={props.configured ? 'השארה ריקה = ללא שינוי' : props.hint ?? ''}
        value={clearing ? '' : props.value ?? ''}
        onChange={(e) => props.onChange(e.target.value === '' ? undefined : e.target.value)}
      />
      {props.configured && !clearing && (
        <button type="button" className="btn btn-small" onClick={() => props.onChange('')}>מחיקת הערך<span className="sr-only"> {props.label}</span></button>
      )}
    </div>
  );
}

function Section(props: { title: string; enabled: boolean; onToggle: (v: boolean) => void; channel: Channel; testPlaceholder?: string; children: ReactNode }) {
  const [to, setTo] = useState('');
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean; recipient: string }>('/api/admin/settings/notifications/test', { channel: props.channel, to: to || undefined }) });
  const id = `sec-${props.channel}`;
  return (
    <fieldset className="card" aria-describedby={`${id}-state`}>
      <legend className="h3">{props.title}</legend>
      <label className="checkbox">
        <input type="checkbox" checked={props.enabled} onChange={(e) => props.onToggle(e.target.checked)} />
        ערוץ פעיל
      </label>
      <span id={`${id}-state`} className="sr-only">{props.enabled ? 'פעיל' : 'כבוי'}</span>
      {props.children}
      <div className="row test-row">
        {props.testPlaceholder && (
          <>
            <label htmlFor={`${id}-to`} className="sr-only">נמען לבדיקה ({props.title})</label>
            <input id={`${id}-to`} dir="ltr" placeholder={props.testPlaceholder} value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        <button type="button" className="btn btn-small" onClick={() => test.mutate()} disabled={test.isPending}>
          שליחת בדיקה{props.channel === 'push' ? ' למכשירים שלי' : ''}<span className="sr-only"> ({props.title})</span>
        </button>
        <span aria-live="polite" className="small">
          {test.data && <span className="ok">נשלח ל-{test.data.recipient} ✓</span>}
          {test.error && <span className="err">נכשל: {(test.error as { body?: { message?: string } }).body?.message ?? errorMessage(test.error)}</span>}
        </span>
      </div>
      <p className="muted small">הבדיקה משתמשת בהגדרות השמורות. יש לשמור לפני הבדיקה.</p>
    </fieldset>
  );
}
