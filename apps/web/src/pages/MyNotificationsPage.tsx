import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_LABELS_HE, CHANNELS, type Channel, type MyNotificationsView } from '@firesafety/shared';
import { api, errorMessage } from '../lib/api';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../lib/push';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ErrorBox, Loading } from '../components/Status';

export function MyNotificationsPage() {
  useDocumentTitle('ההתראות שלי');
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['me', 'notifications'], queryFn: () => api.get<MyNotificationsView>('/api/me/notifications') });
  const [phone, setPhone] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [whatsapp, setWhatsapp] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setChannels(data.channels);
    setWhatsapp(data.whatsappOptIn);
  }, [data]);

  const save = useMutation({
    // Empty phone field = keep the stored number (it is never sent back to the browser).
    mutationFn: () => api.put('/api/me/notifications', { phone: phone.trim() === '' ? null : phone, channels, whatsappOptIn: whatsapp }),
    onSuccess: () => {
      setSaved(true);
      setPhone('');
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
            <label htmlFor="phone">טלפון נייד {data.phoneHint && <span className="muted">(שמור: <span dir="ltr">{data.phoneHint}</span>)</span>}</label>
            <input id="phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder={data.phoneHint ? 'השארה ריקה = ללא שינוי' : '050-1234567'} value={phone} onChange={(e) => { setPhone(e.target.value); setSaved(false); }} aria-describedby="phone-hint" />
            <small id="phone-hint" className="muted">המספר נשמר מוצפן ומשמש רק לשליחת התראות.</small>
            {data.phoneHint && (
              <button type="button" className="btn btn-small" onClick={() => clearPhone.mutate()} disabled={clearPhone.isPending}>מחיקת מספר הטלפון</button>
            )}
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

          <PushCard registered={data.pushSubscriptions} />

          <div className="card narrow">
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
          </div>
        </>
      )}
    </section>
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
