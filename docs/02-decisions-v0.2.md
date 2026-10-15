# החלטות ועדכון אפיון: גרסה 0.2

> מבוסס על תשובות הלקוח מ-2026-10-15. **מסמך זה גובר על המסמך [01](01-desigo-research-and-mvp-plan.md)** בכל מקום שיש ביניהם סתירה.
> סטטוס: **אפיון בלבד, לא נכתב קוד. ממתין לאישור.**

---

## 1. ההחלטות שהתקבלו

| # | נושא | החלטה | השלכה |
|---|---|---|---|
| D1 | יצרן הרכזות | **Siemens** | Driver עיקרי: **BACnet/IP**. אין צורך ב-Drivers ל-Modbus, ל-Telefire או ל-Serial ב-MVP |
| D2 | היקף פונקציונלי | **ניטור בלבד** | אין שירותי כתיבה ל-BACnet בקוד. שום WriteProperty / AcknowledgeAlarm / LifeSafetyOperation לא נשלח לרכזת |
| D3 | היקף | "לא מעט" מבנים ונקודות | תכנון ל-**עד 100 מבנים ו-50,000 נקודות**, עם מבחני עומס בהתאם |
| D4 | אירוח | **VPS בתוך רשת המוסד** (On-Prem) | אין צורך במנהרה דרך האינטרנט. התקשורת לרכזות פנימית. נדרשת יציאה מבוקרת לאינטרנט רק לשירותי ההתראה |
| D5 | זהות | **Microsoft Entra ID (Azure AD)** | SSO ב-OIDC. MFA נאכף דרך Conditional Access של המוסד. אין סיסמאות מקומיות, חוץ מחשבון חירום (Break-glass) אחד |
| D6 | נמענים | **ממוני בטיחות**. המוקד הוא משתמש אופציונלי | הרשאה לפי מבנה או פקולטה |
| D7 | ערוצי התראה | **כל הערוצים**: SMS, WhatsApp, Push, Email, וגם Teams/שיחה קולית כאופציה | מנוע התראות עם הסלמה ואישור קבלה |

---

## 2. אינטגרציה עם רכזות Siemens: מה ידוע

- **FS20 (Sinteso / Desigo Fire Safety) רשום ב-BTL** בפרופיל **B-LSC (BACnet Life Safety Controller)**. הרישום כולל COV, ReadProperty, Alarm & Event (Information, Acknowledge) ו-Life Safety. **המשמעות:** הרכזת יכולה לדחוף אירועים (EventNotification) ולענות ל-GetEventInformation. זה בדיוק מה שנדרש לניטור.
- **Cerberus PRO (FC72x) דורש מפתח רישיון ל-BACnet.**
  - **S2 (FCA2034-A1):** פלט BACnet לניטור על ידי צד שלישי.
  - **S3 (FCA2035-A1):** שילוב.
  - **צריך לבדוק אילו רישיונות מותקנים ברכזות במוסד.**
- הפעלת BACnet ברכזת נעשית בכלי ההנדסה של Siemens (FXS2002): `Global BACnet configuration → Enable BACnet communication`, יחד עם הגדרת **BACnet Client** עם Device ID. **הפעולה הזו מבוצעת על ידי הקבלן המוסמך של Siemens, לא על ידינו.**
- **ברשת רכזות (SAFEDLINK / FCnet)** רכזת אחת יכולה לשמש **Global Access Point** ל-BACnet. ייתכן שנקודת חיבור אחת תספיק לכל הרשת.

### סיכונים ייחודיים ל-Siemens

| סיכון | פירוט | בקרה |
|---|---|---|
| **מגבלת לקוחות BACnet ומנויי COV ברכזת** | רכזות מגבילות את מספר הלקוחות ואת מספר המנויים | לבדוק מול Siemens. להירשם רק ל-Notification Class, ולא ל-COV על כל נקודה |
| **Desigo CC קיים כבר בקמפוס?** | אם כן, אנחנו לקוח BACnet נוסף, ואסור להפריע לו | לתאם עם הקבלן. Device ID ייחודי, קצב קריאה נמוך |
| **רישיונות חסרים** | עלות של S2 לכל רכזת או Access Point | לברר לפני תחילת הפיתוח |
| **אחריות** | שינוי הגדרות ברכזת עלול להשפיע על האחריות או על האישור | שינוי רק על ידי קבלן מוסמך ובאישור יועץ בטיחות |

### אסטרטגיית קליטת האירועים

```
עלייה של השער ─► Who-Is / ReadPropertyMultiple (Object list, Description, Location)
             ─► GetEventInformation  (סנכרון מצב: כל מה שלא NORMAL)
             ─► רישום כיעד ב-Notification Class (Recipient_List)
                → קליטת Confirmed/UnconfirmedEventNotification בזמן אמת
             ─► Polling איטי (כל 60 שניות) כרשת ביטחון + Heartbeat לרכזת
```

> הרישום ב-Recipient_List דורש **כתיבה** לרכזת. כדי לעמוד ב-D2 (אפס כתיבה מצד המערכת שלנו), **הקבלן של Siemens יוסיף אותנו כנמען בהגדרות הרכזת.** אם זה לא אפשרי, נעבוד עם Polling (GetEventInformation כל 2–5 שניות) ו-COV בלבד. **דורש אימות מול Siemens.**

---

## 3. ארכיטקטורה מעודכנת (On-Prem, בתוך המוסד)

```
┌──────────── VLAN רכזות אש (OT) ───────────┐
│  [Siemens FS20/FC72x] ... [Access Point]   │
│              │ BACnet/IP UDP 47808         │
│     ┌────────▼────────┐                    │
│     │ Collector VM    │  Read-only          │
│     │ (Python,        │  חוצץ מקומי         │
│     │  BACpypes3)     │                     │
│     └────────┬────────┘                    │
└──────────────┼─────────────────────────────┘
               │ mTLS / WSS, חומת אש: רק Collector→Server:443
┌──────────────▼──── VLAN שרתים (המוסד) ───────────────┐
│ Caddy (TLS) → API (Fastify/TS) ↔ PostgreSQL ↔ Redis     │
│                 └→ Notification worker ─┐               │
└─────────────────────────────────────────┼───────────────┘
                     Egress allowlist ────▼ (Proxy של המוסד)
        SMS provider · WhatsApp Cloud API · Web Push · Graph (Email/Teams)

משתמשים ──HTTPS──► Server ◄──OIDC──► Microsoft Entra ID (Institution)
```

**למה Collector נפרד** ולא תהליך בתוך השרת:
1. הפרדת רשתות: רק הוא נוגע ב-VLAN של הרכזות.
2. BACnet מבוסס Broadcast ו-UDP, ועדיף שירוץ באותו Subnet של הרכזות או עם BBMD.
3. הוא ממשיך לאגור אירועים גם כשהשרת בעדכון.

> אם ה-IT מאשר שה-VPS ישב ישירות ב-VLAN של הרכזות, אפשר לאחד את השניים ל-VM אחד עם שני Containers. **זו החלטה של ה-IT.**

---

## 4. אימות והרשאות: Entra ID

- **פרוטוקול:** OIDC Authorization Code + PKCE, עם ספריית `openid-client` (Node). הטוקנים נשארים בשרת בלבד. לדפדפן נשלחת עוגיית Session בלבד (HttpOnly, Secure, SameSite=Lax לצורך ה-Redirect).
- **תפקידים:** Entra **App Roles** (`FireAdmin`, `SafetyOfficer`, `Operator`, `Viewer`) מוקצים לקבוצות של המוסד. ה-claim `roles` נקרא בכל התחברות.
- **היקף מבנים:** נשמר אצלנו בטבלת `user_building_scope`, לפי ה-Object ID (`oid`) של המשתמש. מנהל המערכת ממפה ממונה לפקולטה או למבנים.
- **MFA:** נאכף במדיניות Conditional Access של המוסד. המערכת בודקת שהערך `amr` כולל `mfa`, ודוחה התחברות בלי MFA. **דורש אימות מול הגדרות המוסד.**
- **Break-glass:** משתמש מקומי אחד עם Argon2id ו-TOTP, לשימוש כש-Entra לא זמין. מתועד ומנוטר.
- **נדרש מה-IT:** רישום App Registration (Redirect URI, Client Secret או Certificate), הגדרת App Roles ושיוך קבוצות.

---

## 5. מנוע התראות

### 5.1 ערוצים

| ערוץ | מימוש | הערות ומגבלות |
|---|---|---|
| **Web Push (PWA)** | Web Push + VAPID | חינם ומיידי. **ב-iOS עובד רק כשהאפליקציה מותקנת למסך הבית** (iOS 16.4 ומעלה) |
| **SMS** | ספק ישראלי (כמו InforU או 019; **הבחירה טעונה בדיקה**) או Twilio | אמין גם בלי דאטה. עלות לכל הודעה. נדרש DPA |
| **WhatsApp** | **WhatsApp Business Cloud API** (Meta) | הודעה יזומה מחייבת **Template מאושר מראש**. המידע עובר ל-Meta, מחוץ לישראל. נדרש בירור פרטיות. **אסור שיהיה הערוץ היחיד** |
| **Email** | Microsoft Graph `sendMail` או SMTP של המוסד | לסיכומים ולתיעוד. לא מתאים להתרעה מיידית |
| **Teams** (אופציה) | Graph, הודעה לערוץ או לצ'אט | חינם בתוך M365 |
| **שיחה קולית** (אופציה, שלב 2) | Twilio Voice או ספק ישראלי | להסלמה כשאף אחד לא אישר קבלה |

### 5.2 לוגיקה

- **כללים:** (קטגוריית אירוע × מבנה או פקולטה) → קבוצת נמענים → רשימת ערוצים.
- **ברירת מחדל:**
  - **אש:** Push, SMS ו-WhatsApp במקביל. אם אין אישור קבלה תוך 3 דקות, הסלמה לממונה הראשי ולשיחה קולית.
  - **תקלה ונטרול:** Push ו-Email.
  - **ניתוק רכזת או Collector:** Push, SMS ו-Email למנהל המערכת.
- **אישור קבלה (Ack):** קישור חתום וחד-פעמי בהודעה, או אישור ב-PWA. האישור עוצר את ההסלמה ונרשם ב-Audit.
- **אמינות:** תור (BullMQ על Redis) עם ניסיונות חוזרים, Idempotency key לכל אירוע×נמען×ערוץ, ודיכוי הצפות (Dedup / Throttle). לדוגמה, אירוע עם 40 גלאים באותו אזור יישלח כהודעה מקובצת אחת.
- **תוכן ההודעה:** מבנה, קומה, חדר, סוג ושעה, וקישור למערכת. אין בה מידע אישי.
- **חובה בכל ההודעות ובממשק:** "מערכת משלימה. אינה מחליפה את נהלי החירום ואת המוקד."

---

## 6. עדכונים לסכמה

```
user(id, entra_oid UNIQUE, email, name, phone_e164?, whatsapp_opt_in, active)  -- no password_hash
notification_channel_pref(user_id, channel, enabled, quiet_hours?)  -- fire overrides quiet hours
notification_rule(id, category, scope_type[campus|faculty|building], scope_id, recipient_group_id,
                  channels[], escalate_after_s, escalate_to_group_id)
notification_delivery(id, event_id, user_id, channel, status, provider_msg_id, attempts, ts)
push_subscription(id, user_id, endpoint, keys_enc, created_at)
faculty(id, name); building.faculty_id
bacnet_device(id, collector_id, device_instance, ip, network, vendor, model, fw, last_seen_at)
point: + bacnet_object_type, bacnet_object_instance, notification_class
```

- **מספרי טלפון** מוצפנים ברמת השדה. **הבסיס החוקי והשמירה שלהם דורשים בדיקת ממונה הפרטיות של המוסד.**

---

## 7. תוכנית עבודה מעודכנת

| שלב | תוצר |
|---|---|
| **0. גילוי** (חוסם) | קבלת **רשימת הרכזות, הדגמים, הרישיונות ו-Object list / EDE** מהקבלן של Siemens. **בדיקה פסיבית** (Who-Is / ReadProperty) מול רכזת אחת בתיאום. App Registration ב-Entra. אישור הארכיטקטורה מה-IT |
| **1. שלד** | Monorepo, Docker Compose, OIDC Entra, App Roles, scope, Audit, CI, **סימולטור B-LSC** |
| **2. ליבת אירועים** | Collector (BACpypes3): GetEventInformation, EventNotification, Heartbeat. Ingest, WebSocket, רשימת אירועים |
| **3. גרפיקה** | פקולטות, מבנים, קומות, תוכניות, שיבוץ נקודות. ייבוא מ-EDE ו-CSV |
| **4. התראות** | Push, Email, SMS ו-WhatsApp, הסלמה, Ack בקישור |
| **5. נהלים ודוחות** | |
| **6. פיילוט** | מבנה אחד, במקביל למוקד הקיים, 4 שבועות |
| **7. הקשחה** | בדיקת חדירות, נגישות, פרטיות, Checklist לפרודקשן |

---

## 8. שאלות פתוחות: סבב 2

1. **איזה קו מוצרים של Siemens?** Sinteso / Desigo Fire Safety (FC20xx), Cerberus PRO (FC72x), Desigo Fire Safety Modular או רכזות ישנות? והאם הן מחוברות לרשת אחת (SAFEDLINK) או שכל מבנה עומד בפני עצמו?
2. **האם כבר קיים במוסד Desigo CC** או עמדת ניהול אחרת לאש? אם כן, אפשר אולי לקרוא ממנה ולא מהרכזות. זה דורש אימות של ממשקי Desigo CC.
3. **מי הקבלן המתחזק של Siemens**, והאם אפשר לקבל ממנו Object list / EDE ואת מצב רישיונות ה-BACnet (S2/S3)?
4. **רשת:** האם ה-VPS יכול להגיע ל-VLAN של הרכזות, או שצריך VM נפרד שם? והאם יש ל-VPS יציאה לאינטרנט (גם דרך Proxy) לשירותי SMS ו-WhatsApp?
5. **הרשאות:** האם כל ממונה בטיחות אחראי על פקולטה או מבנים מסוימים, או שכולם רואים הכול? ומי צריך לקבל התראות על אש מחוץ לשעות העבודה?

---

## 9. מקורות נוספים

- [BTL Listing 30841: Siemens FS20 Fire Detection (B-LSC)](https://www.bacnetinternational.net/btl/listings/siemens/BTL_Listing_30841_Siemens_FS20FireDetection.pdf)
- [Siemens Cerberus PRO: license keys S2/S3 (sid.siemens.com)](https://sid.siemens.com/api/khub/documents/EAQ9YtHpKnIPi1ssft0y4A/content)
- [Third-party integration: Siemens fire panel (AxxonSoft)](https://docs.axxonsoft.com/confluence/x/lErZCw)
- [Desigo CC: Configuring the FS720 Cerberus Pro Fire Network](https://gbscampus.vu.nl/WebApp/Help/EngineeringHelp/en-US/14651393419.html)
- [Desigo CC Fire Management Platform flyer](https://assets.new.siemens.com/siemens/assets/api/uuid:7e93f66b-b83b-46da-a427-1a4804c9a4f4/desigo-cc-fire-management-platform-flyer.pdf)
- [BACnet Event Enrollment / Notification Class](https://docs.chipkin.com/protocols/bacnet/objects/event-enrollment/)
