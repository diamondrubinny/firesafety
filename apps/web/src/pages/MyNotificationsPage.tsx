import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_LABELS_HE, CHANNELS, type Channel, type MyNotificationsView, type PhoneVerifyStartResult } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../lib/push';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ErrorBox, Loading } from '../components/Status';

export function MyNotificationsPage() {
  useDocumentTitle('ההתראות שלי');
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['me', 'notifications'], queryFn: () => api.get<MyNotificationsView>('/api/me/notifications') });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [whatsapp, setWhatsapp] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setChannels(data.channels);
    setWhatsapp(data.whatsappOptIn);
  }, [data]);

  const save = useMutation({
    // The phone number is managed separately (verified with a one-time code).
    mutationFn: () => api.put('/api/me/notifications', { phone: null, channels, whatsappOptIn: whatsapp }),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['me', 'notifications'] });
    },
  });
  const clearPhone = useMutation({
    mutationFn: () => api.put('/api/me/notifications', { phone: '', channels, whatsappOptIn: false }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'notifications'] }),
  });
  const test = useMutation({ mutationFn: () => api.post<{ results: Record<string, string> }>('/api/me/notifications/test') });

  const toggle = (c: Channel) => {
    setSaved(false);
    setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <section aria-labelledby="my-title">
      <h1 id="my-title">ההתראות שלי</h1>
      <p className="muted">
        ההתראות נשלחות על אירועים במבנים שבאחריותך. <strong>הן משלימות בלבד ואינן מחליפות את נהלי החירום או את המוקד.</strong>
      </p>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <>
          <form onSubmit={submit} className="card narrow" aria-labelledby="contact-title">
            <h2 id="contact-title" className="h3">פרטי קשר וערוצים</h2>
            {save.error && <div role="alert" className="alert alert-error">{errorMessage(save.error)}</div>}
            <p className="small">דוא"ל: <span dir="ltr">{data.email}</span> (מתוך חשבון המוסד)</p>
            <p className="small">
              טלפון נייד: {data.phoneHint ? <span dir="ltr">{data.phoneHint}</span> : <span className="muted">לא הוגדר</span>}
              {data.phoneHint && (
                <> <button type="button" className="btn btn-small" onClick={() => clearPhone.mutate()} disabled={clearPhone.isPending}>מחיקת מספר הטלפון</button></>
              )}
            </p>
            <fieldset>
              <legend>ערוצים שאני רוצה לקבל</legend>
              {CHANNELS.map((c) => (
                <label key={c} className="checkbox">
                  <input type="checkbox" checked={channels.includes(c)} onChange={() => toggle(c)} />
                  {CHANNEL_LABELS_HE[c]}
                  {!data.available[c] && <span className="muted small"> (לא הופעל במערכת)</span>}
                </label>
              ))}
            </fieldset>
            <label className="checkbox">
              <input type="checkbox" checked={whatsapp} onChange={(e) => { setWhatsapp(e.target.checked); setSaved(false); }} aria-describedby="wa-hint" />
              אני מסכים/ה לקבל התראות ב-WhatsApp
            </label>
            <small id="wa-hint" className="muted">
              ההודעות נשלחות דרך WhatsApp Business (Meta), ומספר הטלפון ותוכן ההתראה מועברים אליה. אפשר לבטל בכל עת.
            </small>
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={save.isPending}>שמירה</button>
              <span aria-live="polite">{saved && <span className="ok">נשמר ✓</span>}</span>
            </div>
          </form>

          {data.eligible ? <PhoneCard pendingHint={data.pendingPhoneHint} hasPhone={!!data.phoneHint} /> : (
            <p className="alert alert-warning">התראות SMS, WhatsApp ודוא"ל נשלחות לממוני בטיחות ולמנהלי המערכת בלבד.</p>
          )}

          <PushCard registered={data.pushSubscriptions} />

          {data.eligible && <div className="card narrow">
            <h2 className="h3">בדיקה</h2>
            <p className="small">שולח הודעת בדיקה לכל הערוצים הפעילים שלך.</p>
            <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>שליחת התראת בדיקה אליי</button>
            {test.error && <div role="alert" className="alert alert-error">{errorMessage(test.error)}</div>}
            <div aria-live="polite">
              {test.data && (
                Object.keys(test.data.results).length === 0 ? <p className="muted">אין ערוצים פעילים לבדיקה.</p> : (
                  <ul>
                    {Object.entries(test.data.results).map(([ch, r]) => (
                      <li key={ch}>{CHANNEL_LABELS_HE[ch as Channel]}: {r}</li>
                    ))}
                  </ul>
                )
              )}
            </div>
          </div>}
        </>
      )}
    </section>
  );
}

/** Two-step phone verification: the number is saved only after the one-time code is confirmed. */
function PhoneCard({ pendingHint, hasPhone }: { pendingHint: string | null; hasPhone: boolean }) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<PhoneVerifyStartResult | null>(null);
  const [done, setDone] = useState('');
  const start = useMutation({
    mutationFn: () => api.post<PhoneVerifyStartResult>('/api/me/phone/verify', { phone }),
    onSuccess: (r) => { setSent(r); setDone(''); void qc.invalidateQueries({ queryKey: ['me', 'notifications'] }); },
  });
  const confirm = useMutation({
    mutationFn: () => api.post<{ phoneHint: string }>('/api/me/phone/confirm', { code }),
    onSuccess: (r) => {
      setDone(`המספר ${r.phoneHint} אומת ונשמר.`);
      setSent(null);
      setCode('');
      setPhone('');
      void qc.invalidateQueries({ queryKey: ['me', 'notifications'] });
    },
  });
  const awaitingCode = !!sent || !!pendingHint;
  return (
    <div className="card narrow" aria-labelledby="phone-title">
      <h2 id="phone-title" className="h3">{hasPhone ? 'החלפת מספר טלפון' : 'הוספת מספר טלפון'}</h2>
      <p className="muted small">כדי לוודא שההתראות מגיעות אליך, נשלח קוד אימות למספר. המספר נשמר מוצפן רק אחרי האימות.</p>
      <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }} className="row">
        <label htmlFor="phone" className="sr-only">מספר טלפון נייד</label>
        <input id="phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" required placeholder="050-1234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button type="submit" className="btn" disabled={start.isPending}>שליחת קוד אימות</button>
      </form>
      {start.error && <div role="alert" className="alert alert-error">{errorMessage(start.error)}</div>}
      {awaitingCode && (
        <form onSubmit={(e) => { e.preventDefault(); confirm.mutate(); }} className="row">
          <label htmlFor="otp">קוד שנשלח {sent ? `ב-${sent.sentVia === 'sms' ? 'SMS' : 'WhatsApp'} ל-` : 'ל-'}<span dir="ltr">{sent?.phoneHint ?? pendingHint}</span></label>
          <input id="otp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required dir="ltr" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <button type="submit" className="btn btn-primary" disabled={confirm.isPending}>אימות</button>
        </form>
      )}
      {confirm.error && <div role="alert" className="alert alert-error">{errorMessage(confirm.error)}</div>}
      <p aria-live="polite" className="ok small">{done}</p>
    </div>
  );
}

function PushCard({ registered }: { registered: number }) {
  const qc = useQueryClient();
  const support = pushSupport();
  const [here, setHere] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    void currentSubscription().then((s) => setHere(!!s));
  }, []);
  const enable = useMutation({
    mutationFn: enablePush,
    onSuccess: (r) => {
      setMsg(
        r === 'ok' ? 'המכשיר נרשם לקבלת התראות.'
        : r === 'denied' ? 'ההרשאה נדחתה בדפדפן. אפשר לשנות זאת בהגדרות האתר.'
        : r === 'failed' ? 'הדפדפן לא הצליח להירשם לשירות ה-Push שלו (ייתכן שהרשת חוסמת אותו). שאר הערוצים ממשיכים לעבוד.'
        : 'הדפדפן אינו תומך בהתראות Push.',
      );
      setHere(r === 'ok');
      void qc.invalidateQueries({ queryKey: ['me', 'notifications'] });
    },
  });
  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: () => {
      setMsg('המכשיר הוסר.');
      setHere(false);
      void qc.invalidateQueries({ queryKey: ['me', 'notifications'] });
    },
  });
  return (
    <div className="card narrow">
      <h2 className="h3">התראות Push במכשיר זה</h2>
      <p className="small">מכשירים רשומים: {registered}. באייפון, יש להוסיף את האתר למסך הבית (שיתוף ← "הוספה למסך הבית") ולפתוח אותו משם.</p>
      {support === 'unsupported' && <p className="muted">הדפדפן אינו תומך בהתראות Push.</p>}
      {support === 'denied' && <p className="err">ההתראות חסומות לאתר זה בהגדרות הדפדפן.</p>}
      {support === 'supported' && (
        here ? (
          <button type="button" className="btn" onClick={() => disable.mutate()} disabled={disable.isPending}>הסרת מכשיר זה</button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => enable.mutate()} disabled={enable.isPending}>הפעלת התראות במכשיר זה</button>
        )
      )}
      {(enable.error || disable.error) && <div role="alert" className="alert alert-error">{errorMessage(enable.error ?? disable.error)}</div>}
      <p aria-live="polite" className="small">{msg}</p>
    </div>
  );
}
