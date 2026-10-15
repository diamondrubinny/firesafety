# מחקר: Siemens Desigo → מערכת ניהול גרפית לבטיחות אש לקמפוס אקדמי (VPS)

> סטטוס: **שלב אפיון בלבד. לא נכתב קוד.** הבנייה תתחיל רק אחרי שיתקבל אישור.
> תאריך: 2026-10-15 · גרסת מסמך: 0.1

---

## 1. סיכום מנהלים

- **Desigo** הוא שם של משפחת מוצרים ולא של מוצר אחד. החלק שרלוונטי לנו הוא **Desigo CC**, פלטפורמת ניהול מבנים (BMS / PSIM) שאחת הדיסציפלינות שלה היא בטיחות אש. רכזות האש עצמן הן מוצר נפרד: Desigo Fire Safety (FS20), Cerberus PRO (FS720) ו-Sinteso.
- **אפשר לבנות מערכת דומה שמתמקדת באש ורצה על VPS.** היא תכלול רשימת אירועים, מפות קומה גרפיות, נהלי טיפול באירוע, היסטוריה, דוחות והתראות. התנאי הוא שהיא תוגדר כ**מערכת משלימה (Supplementary / Ancillary) לניטור בלבד**. היא **לא** תחליף את הרכזת או את לוח ההפעלה המאושר.
- **החסם המרכזי הוא תקינה, לא טכנולוגיה.** Desigo CC מחזיקה רישומי UL/ULC (UL 864, ULC-S527/S559) כעמדת ניהול לאש. מערכת שנפתח בעצמנו לא תהיה מאושרת, ולכן אסור שתהיה ערוץ ההתרעה הראשי ואסור שתשלח פקודות לרכזת בלי אישור מפורש של רשות הכבאות ושל יועץ בטיחות אש.
- **VPS לבדו לא מספיק מבחינה ארכיטקטונית.** רכזות אש יושבות ברשת ה-OT של הקמפוס ומדברות BACnet/IP (UDP broadcast), Modbus או פרוטוקול טורי. **אסור לחשוף אותן לאינטרנט.** לכן נדרש **שער קצה (Edge Gateway)** בקמפוס. השער מתרגם את הפרוטוקולים ופותח לשרת ב-VPS חיבור **יוצא בלבד**, מוצפן ומאומת הדדית.
- **הסיכון הטכני מספר 1: אילו רכזות מותקנות בקמפוס, והאם יש להן ממשק פתוח.** בישראל נפוצות רכזות Telefire (ADR-7000), Siemens, Notifier ו-Simplex. לרוב היצרנים יש שער BACnet או Modbus כאופציה בתשלום. אצל Telefire יש מודולי NET-7000 (TCP/IP) ו-GIM-232, אבל **לא מצאתי תיעוד ציבורי של פרוטוקול פתוח שלהם** (דורש אימות מול היצרן).

---

## 2. מה זה Desigo: ממצאי המחקר

### 2.1 משפחת המוצרים

| רכיב | תפקיד |
|---|---|
| **Desigo CC** | פלטפורמת ניהול מבנים משולבת: HVAC, אש, ביטחון, וידאו, אנרגיה. שרת Windows, SQL Server ו-IIS, עם לקוחות Windows, Web ו-Flex |
| **Desigo CC Compact** | גרסה מוקטנת לאתרים קטנים. לא אומתו הפרטים |
| **Desigo Fire Safety (FS20) / Sinteso / Cerberus PRO (FS720/FS92)** | רכזות גילוי אש של Siemens. מתחברות ל-Desigo CC ב-BACnet/IP |
| **Desigo PX / TRA / Optic** | בקרים ל-HVAC ולחדרים. לא רלוונטי לנו |
| **Building X** | שכבת ענן של Siemens. מ-Desigo CC V6 קיימת קישוריות ענן מובנית ו-Operations Manager לריבוי אתרים |

### 2.2 יכולות ליבה של Desigo CC (מה שנרצה לחקות)

1. **רשימת אירועים (Event List).** כל אירוע מוצג בשורה משלו. בראש המסך יש סרגל סיכום לפי קטגוריה (אש, תקלה, ניתוק ועוד). אירוע שעוד לא טופל מהבהב ומשמיע צליל בעמדה.
2. **טיפול באירוע.** הפעולות הן Acknowledge, Silence ו-Reset. האירוע בעל העדיפות הגבוהה ביותר מודגש. כמה מפעילים יכולים לעבוד במקביל, ורואים מי מטפל באיזה אירוע.
3. **נהלי הפעלה (Operating Procedures).** לכל אירוע אפשר להגדיר רשימת צעדים לביצוע, כמו צ'קליסט. אפשר להפעיל או לכבות נוהל ולשנות את סדר הצעדים.
4. **גרפיקה.** מפות קומה, סמלי גלאים ומצבים בזמן אמת, וניווט מהאירוע ישר למיקום במפה.
5. **הרשאות ופרופילי משתמש.** לדוגמה, אפשר לחסום פקודות מתקדמות למפעיל אש.
6. **פקודות לרכזת.** הפעלה או נטרול של קווי גילוי, והפעלה ידנית של אזעקה. ב-FS20 זה נעשה דרך מודול ייעודי.
7. **היסטוריה, דוחות ו-Audit.**
8. **רישוי** לפי מספר לקוחות ומספר אובייקטים בסריקה. בלי רישיון הלקוחות רצים 30 דקות בלבד.
9. **תשתית:** Windows Server 2019–2025 ו-SQL Server. וירטואליזציה נתמכת, אבל Terminal Server לא. גודל השרת נקבע לפי מספר האובייקטים.
10. **רישוי תקינה:** UL ו-ULC (S527, S559) לעבודה עם רכזות Siemens, **בתנאי שמשתמשים בחומרה מאושרת**, כולל מתגי רשת שתואמים ל-UL 864.

### 2.3 איך Desigo מתחבר לרכזות

- **FS20 / Sinteso:** BACnet/IP. נדרשים Device ID, פורט UDP ו-BBMD כשיש כמה Subnets.
- **STT20 (כיבוי):** דרך FCnet/SAFEDLINK. רכזת אחת משמשת **Global Access Point** ל-BACnet.
- **רכזות ישנות:** Cerloop דרך MK7022/NK823x.
- **צד שלישי:** מנהלי התקן (Drivers) ל-Modbus ול-OPC, וספריות מוכנות.

**המסקנה:** המודל של Siemens הוא **רכזת → שער BACnet → שרת ניהול**. אנחנו נחקה אותו בדיוק, עם שער קצה משלנו.

### 2.4 נקודות חולשה של Desigo שמהן נובעת ההזדמנות שלנו

- עלות רישוי גבוהה, תלות ב-Windows וב-SQL Server, ואינטגרטור Siemens לכל שינוי.
- המערכת מותאמת לרכזות Siemens. אינטגרציה של רכזות אחרות דורשת רישיון ל-Driver.
- אין התאמה מקומית לעברית, ל-RTL ולתקינה הישראלית (ת"י 1220, הוראות נציב).

---

## 3. היתכנות: אפשר / אפשר בתנאים / לא מומלץ

| יכולת | היתכנות | הערה |
|---|---|---|
| ניטור מצב רכזות ואירועים (אש, תקלה, נטרול) בזמן אמת | ✅ | דרך BACnet/Modbus/שער יצרן |
| מפות קומה גרפיות ומיקום גלאי | ✅ | SVG ו-PDF של תוכניות אדריכליות |
| רשימת אירועים, Ack פנימי במערכת, נהלי טיפול | ✅ | Ack **במערכת שלנו** הוא תיעוד בלבד ולא נשלח לרכזת |
| התראות SMS, Push ו-Email לצוות ביטחון ובטיחות | ✅ | **משלים בלבד**. לא מחליף חיוג למוקד או לכבאות |
| דוחות תחזוקה ובדיקות תקופתיות (ת"י 1220 חלק 11) | ✅ | ערך עסקי גבוה |
| ריבוי מבנים ורכזות, ריבוי קמפוסים | ✅ | |
| **שליחת פקודות לרכזת** (Silence, Reset, נטרול) | ⚠️ | רק אחרי אישור יועץ בטיחות אש ורשות הכבאות, עם MFA ואישור כפול. **לא ב-MVP** |
| הצגה כ"עמדת ניהול אש מאושרת" (UL 864 / ULC-S527 / EN 54) | ❌ | דורש תהליך אישור ממושך ויקר |
| חיבור ישיר של רכזות לאינטרנט / VPS | ❌ | סיכון אבטחה חמור. חובה שער קצה |

---

## 4. אפיון MVP

### 4.1 משתמשים ותפקידים

| תפקיד | הרשאות |
|---|---|
| **מנהל מערכת (Admin)** | ניהול משתמשים, מבנים, רכזות, שערים, מיפוי נקודות ונהלים |
| **ממונה בטיחות** | כל מה שיש למפעיל, ובנוסף דוחות, עריכת נהלים ונטרולים מתוכננים (רישום בלבד) |
| **מפעיל מוקד ביטחון** | צפייה, Ack פנימי, ביצוע נוהל והערות |
| **טכנאי / קבלן תחזוקה** | צפייה מוגבלת למבנים שהוקצו לו, ורישום בדיקות |
| **צופה** | צפייה בלבד |

### 4.2 User Stories (MVP)

1. כמפעיל, אני רואה אירוע אש חדש תוך פחות מ-3 שניות, עם צליל, הבהוב ומיקום מדויק (מבנה, קומה, חדר).
2. כמפעיל, אני לוחץ על אירוע ועובר למפת הקומה עם הגלאי מסומן.
3. כמפעיל, אני מבצע "קבלה" (Ack) של אירוע במערכת ומתעד הערה. הפעולה נרשמת ב-Audit.
4. כמפעיל, אני מקבל נוהל טיפול צעד-אחר-צעד לפי סוג האירוע והמבנה.
5. כממונה בטיחות, אני מקבל SMS או Push על אירוע אש, גם כשאני מחוץ לקמפוס.
6. כממונה בטיחות, אני רואה את כל הנקודות המנוטרלות ואת כל התקלות הפתוחות בכל הקמפוס.
7. כממונה בטיחות, אני מפיק דוח אירועים חודשי ודוח נטרולים.
8. כמנהל, אני רואה שער קצה או רכזת שהתנתקו (Heartbeat) ומקבל התראה. **זה קריטי: שתיקה שקטה אסורה.**
9. כמנהל, אני מייבא רשימת נקודות (CSV) ומשבץ אותן על מפת קומה.
10. כטכנאי, אני רושם בדיקה תקופתית של גלאי.

### 4.3 מסכים

1. התחברות, MFA ושחזור סיסמה
2. **לוח בקרה ראשי**: סרגל סיכום, רשימת אירועים ומפת קמפוס
3. מפת קמפוס: מבנים בצבע לפי מצב
4. מבנה → קומות → מפת קומה עם נקודות
5. פרטי אירוע: ציר זמן, נוהל, הערות, Audit
6. היסטוריית אירועים עם סינון ויצוא
7. נקודות מנוטרלות ותקלות
8. דוחות
9. ניהול: מבנים, רכזות, שערים, נקודות, מפות, נהלים, משתמשים, ערוצי התראה
10. מצב מערכת: שערים, Heartbeat וזמני השהיה
11. עמודי חובה: הצהרת נגישות, מדיניות פרטיות, הגדרות עוגיות, 404 ו-Error

### 4.4 מחוץ ל-MVP

פקודות לרכזת, אינטגרציה ל-HVAC, למצלמות ולבקרת כניסה, אפליקציה Native (בשלב הראשון PWA), ריבוי ארגונים (SaaS), ו-BACnet/SC.

---

## 5. ארכיטקטורה

```
 ┌──────────────── רשת OT של הקמפוס (מבודדת, VLAN) ────────────────┐
 │                                                                   │
 │  [רכזת אש A]──BACnet/IP──┐                                        │
 │  [רכזת אש B]──Modbus TCP─┤                                        │
 │  [רכזת אש C]──RS-232/485─┤ (דרך ממיר / שער יצרן)                  │
 │                          ▼                                        │
 │                 ┌─────────────────┐   חוצץ מקומי (SQLite)          │
 │                 │  Edge Gateway   │   ממשיך לאסוף גם בלי אינטרנט   │
 │                 │ (Linux, בקמפוס) │   Read-only כברירת מחדל        │
 │                 └────────┬────────┘                               │
 └──────────────────────────┼────────────────────────────────────────┘
                            │ חיבור יוצא בלבד: WireGuard + mTLS (WSS)
                            │ אין פורטים נכנסים לקמפוס
                            ▼
 ┌──────────────────────── VPS (רצוי בישראל) ────────────────────────┐
 │ Caddy/Nginx (TLS, HSTS, CSP) → API (Node.js/TS) ←→ PostgreSQL     │
 │                                  │  ↕ WebSocket                    │
 │                                  ├→ Notification worker (SMS/Push) │
 │                                  └→ Redis (תורים / pub-sub)        │
 │ Web client: React + TS, RTL, PWA                                   │
 └────────────────────────────────────────────────────────────────────┘
                            ▲
              דפדפן מוקד / ממונה בטיחות (HTTPS + MFA)
```

**עקרונות:**

- **השער בקמפוס הוא מקור האמת לאיסוף.** אם אין אינטרנט, הוא שומר את האירועים בחוצץ ושולח אותם כשהחיבור חוזר, עם חותמת זמן מקורית ומספר רצף.
- **Heartbeat דו-כיווני.** השער מנטר את הרכזות, השרת מנטר את השער, ו-Watchdog חיצוני מנטר את השרת. כל ניתוק מעורר התראה.
- **Read-only כברירת מחדל.** קוד שליחת פקודות לא ייכלל ב-MVP בכלל. זה לא רק כפתור מוסתר.
- **אופציה: התקנה מקומית (On-Prem).** אותו Docker Compose ירוץ על שרת בקמפוס אם מחלקת ה-IT או רשות הכבאות ידרשו זאת. מומלץ לשמור על האופציה הזו מהיום הראשון.

---

## 6. החלטות טכנולוגיות וחלופות

| שכבה | המלצה | למה | חלופות | מגבלות |
|---|---|---|---|---|
| Backend | **Node.js + TypeScript + Fastify** | TS מקצה לקצה, WebSocket מובנה, מהיר | NestJS (יותר מבנה, יותר כבד), Go | צריך משמעת בארגון הקוד |
| DB | **PostgreSQL 16** | אמין, JSONB, טרנזקציות, Audit | TimescaleDB לנתוני זמן | — |
| ORM / ולידציה | **Drizzle** או **Prisma** + **Zod** (סכמות משותפות לקליינט ולשרת) | Type-safety | Kysely | — |
| Realtime | WebSocket (ws) + Redis pub/sub | Push מיידי לאירועים | SSE | — |
| Frontend | **React + Vite + TS**, Tailwind עם RTL, מפות SVG | פשוט, מהיר, נגיש | Next.js (SSR מיותר כאן) | — |
| Edge driver | **Python 3.12 + BACpypes3**, ו-pymodbus ל-Modbus | הספרייה הבשלה ביותר בקוד פתוח ל-BACnet, כולל COV | TS: `@bacnet-js/client` (פורק של node-bacnet, דורש אימות בשלות); C: bacnet-stack | שתי שפות בפרויקט. הקוד יבודד בשירות נפרד |
| Auth | ספרייה מוכרת (Lucia-style sessions / Auth.js) + Argon2id + TOTP MFA | מוכח, ללא שירות חיצוני | Keycloak (SSO מול AD של המוסד, מומלץ בשלב 2) | — |
| Tunnel | **WireGuard** + mTLS | פשוט, מהיר, יוצא בלבד | Tailscale/Headscale, OpenVPN | — |
| פריסה | **Docker Compose** על Ubuntu 24.04 LTS | התקנה בפקודה אחת | k3s (מוגזם ל-MVP) | — |
| התראות | ספק SMS ישראלי / Twilio, Web Push, SMTP | — | WhatsApp Business API | **כל ספק דורש DPA** |

> בדיקה נדרשת: יכולות ה-Alarm & Event של BACpypes3 (GetEventInformation, AcknowledgeAlarm, ConfirmedEventNotification) **דורשות אימות מול התיעוד הרשמי ובדיקה מעשית מול רכזת אמיתית**.

### 6.1 שכבת Drivers (Adapter pattern)

```
interface PanelDriver {
  connect(); discoverPoints(); subscribe(onEvent); healthCheck();
  // sendCommand() — intentionally absent in MVP
}
```

| Driver | מקור | הערות |
|---|---|---|
| `bacnet-ip` | BACpypes3: COV + EventNotification + GetEventInformation לסנכרון בעלייה | Siemens FS20/FS720, Notifier BACNET-GW-3, Simplex BACpac, Kentec Vizulinx |
| `modbus-tcp` | pymodbus, Polling עם מפת אוגרים לפי יצרן | Simplex BACpac, Potter Modbus Link, Teletek iRIS8 |
| `serial-printer` | פענוח פלט "מדפסת" של הרכזת (RS-232) | Fallback לרכזות ישנות. אמינות נמוכה יותר |
| `telefire` | **לא ידוע** | דורש פנייה ל-Telefire לגבי NET-7000/GIM-232 |
| `simulator` | סימולטור BACnet/Modbus לפיתוח ולבדיקות | חובה. אסור לפתח מול רכזת חיה |

---

## 7. סכמת נתונים (טיוטה)

```
campus(id, name)
building(id, campus_id, name, code, geo)
floor(id, building_id, level, name, plan_file_id)
gateway(id, campus_id, name, cert_fingerprint, last_seen_at, status)
panel(id, gateway_id, building_id, vendor, model, protocol, address, status, last_seen_at)
point(id, panel_id, floor_id, external_ref, type, label, room, x, y, status, disabled)
event(id, point_id, panel_id, category[fire|prealarm|fault|disable|supervisory|comm],
      state[active|cleared], priority, source_ts, received_ts, seq_no, raw jsonb)
event_ack(id, event_id, user_id, ts, note)          -- internal only
procedure(id, name, category, building_id?, steps jsonb, version)
procedure_run(id, event_id, procedure_id, user_id, steps_done jsonb, completed_at)
user(id, email, name, role, mfa_secret_enc, password_hash, active)
user_building_scope(user_id, building_id)          -- anti-IDOR scope
notification_rule(id, category, building_id?, channel, recipients)
notification_log(id, event_id, channel, recipient_ref, status, ts)
maintenance_log(id, point_id, user_id, type, result, ts, note)
audit_log(id, user_id, action, entity, entity_id, ts, ip_hash, details jsonb)
file(id, kind, storage_key, mime, size, sha256, scan_status)
```

---

## 8. API (טיוטה)

| Endpoint | גישה |
|---|---|
| `POST /auth/login`, `/auth/mfa`, `/auth/logout`, `/auth/reset` | ציבורי, עם Rate Limit |
| `GET /events?state=&building=` | מחובר, מסונן לפי scope |
| `GET /events/:id`, `POST /events/:id/ack`, `POST /events/:id/notes` | מפעיל ומעלה, עם בדיקת scope |
| `GET /buildings`, `/buildings/:id/floors`, `/floors/:id/points` | מחובר, עם scope |
| `GET /reports/events`, `/reports/disabled` | ממונה ומעלה |
| `CRUD /admin/*` | Admin |
| `WS /ws` | מחובר. שולח רק אירועים שבתוך ה-scope |
| `WSS /gateway/ingest` | **שער בלבד**: mTLS עם תעודת לקוח לכל שער. **אין גישה למשתמשים** |

---

## 9. מבנה תיקיות מוצע

```
firesafety/
├─ apps/
│  ├─ server/        # Fastify + TS API, WS, workers
│  ├─ web/           # React + Vite, RTL, PWA
│  └─ edge/          # Python gateway: drivers, buffer, uplink
├─ packages/
│  └─ shared/        # Zod schemas, event types, constants
├─ tools/simulator/  # BACnet/Modbus fire-panel simulator
├─ deploy/           # docker-compose, Caddyfile, wireguard templates
├─ docs/             # this file, threat model, data map, legal drafts
├─ .env.example
└─ README.md
```

---

## 10. אבטחה: Threat Model מקוצר

| נכס | איום | סיכון | בקרה |
|---|---|---|---|
| **רכזות האש** (בטיחות חיים) | גישה זדונית מהאינטרנט ל-BACnet/Modbus, פקודת Reset או נטרול | **קריטי** | אין חשיפה. השער ב-VLAN נפרד, חיבור יוצא בלבד, Read-only, ואין קוד פקודות |
| אמינות ההתרעה | מפעיל סומך על המערכת והיא שותקת (VPS נפל, אינטרנט נפל) | **קריטי** | מוצג כמשלים בלבד, Heartbeat, Watchdog חיצוני, באנר "אין קשר" אדום |
| שער הקצה | גניבה או השתלטות | גבוה | mTLS לכל שער, ביטול תעודה, דיסק מוצפן, SSH במפתחות בלבד, עדכונים |
| חשבונות משתמשים | Brute force, Phishing | גבוה | Argon2id, MFA חובה, Rate limit, נעילה, הודעות שגיאה ניטרליות |
| נתוני אירועים / Audit | IDOR, זליגה בין מבנים | בינוני | בדיקת scope בשרת בכל שאילתה, בדיקות אוטומטיות ל-IDOR |
| קבצי תוכניות קומה | העלאת נוזקה, XSS דרך SVG | בינוני | Allowlist (PDF/PNG/SVG), אימות MIME, ניקוי SVG (DOMPurify), הסגר וסריקת ClamAV, אחסון מחוץ ל-public |
| VPS | השתלטות | גבוה | UFW, fail2ban, עדכונים אוטומטיים, כותרות אבטחה, גיבוי מוצפן יומי מחוץ לשרת |

---

## 11. פרטיות, עוגיות ונגישות

**Data Map (טיוטה):**

| מידע | מטרה | בסיס | אחסון | שמירה | צד שלישי |
|---|---|---|---|---|---|
| שם, אימייל וטלפון של עובדים | התחברות והתראות | חוזה / אינטרס לגיטימי (דורש בדיקה משפטית) | PostgreSQL ב-VPS | עד סיום העסקה + X | ספק SMS (טלפון בלבד) |
| Audit (משתמש, פעולה, IP מגובב) | אבטחה ואחריותיות | חובה / אינטרס לגיטימי | PostgreSQL | 7 שנים? (**דורש בדיקה**) | — |
| אירועי אש | בטיחות, דוחות, תחקירים | חובה חוקית / אינטרס לגיטימי | PostgreSQL | לפי הנחיית רשות הכבאות (**דורש בדיקה**) | — |

- **אין מידע על סטודנטים.** אסור לאסוף אותו.
- **חוק הגנת הפרטיות ותיקון 13:** הנושא דורש בדיקת ממונה הפרטיות של המוסד, כולל רישום מאגר והסכם עיבוד עם ספק ה-VPS.
- **עוגיות:** רק עוגיית Session חיונית (HttpOnly, Secure, SameSite=Strict). אין אנליטיקה ואין פיקסלים, ולכן אין צורך בבאנר הסכמה. קישור "הגדרות פרטיות ועוגיות" יופיע בכל זאת בתחתית הדף, יחד עם מדיניות עוגיות.
- **נגישות:** יעד WCAG 2.1 AA ות"י 5568. **אירוע אש לא יסומן בצבע בלבד** אלא גם באייקון, בטקסט ובצליל. aria-live לאירועים חדשים, ניווט מלא במקלדת, זום 200%, ומצב ניגודיות גבוהה למוקד. עמוד הצהרת נגישות יהיה בתחתית הדף.

---

## 12. תקינה ורגולציה: נושאים שדורשים בדיקה מקצועית

1. **ת"י 1220** (חלקים 2, 3 ו-11): האם מערכת משלימה מותרת, ואילו דרישות חלות עליה. **דורש יועץ בטיחות אש.**
2. **הוראת נציב 536** (אינטגרציה ומשטר הפעלות): רלוונטית אם יבוקש בעתיד חיבור לשליטה בעשן או במערכות נוספות.
3. **רשות הכבאות (AHJ):** אישור שהמערכת "Supplementary" ואינה מחליפה מוקד או לוח הפעלה.
4. **אחריות יצרן הרכזת:** חיבור שער לרכזת עלול להשפיע על האחריות. נדרש אישור של היצרן או של הקבלן המתחזק.
5. **פרטיות:** ממונה פרטיות ועורך דין (תיקון 13, DPA מול ספקים).
6. **נגישות:** יועץ נגישות לפני עלייה לאוויר.
7. **אבטחה:** בדיקת חדירות לשער ולשרת לפני חיבור לרכזת חיה.

---

## 13. תוכנית עבודה בשלבים

| שלב | תוצר | הערכה גסה |
|---|---|---|
| **0. גילוי** | סקר רכזות בקמפוס: יצרן, דגם, גרסה, מודולי תקשורת, קבלן מתחזק. החלטה על Drivers. שיחה עם יועץ בטיחות אש | 1–2 שבועות |
| **1. שלד** | Monorepo, Docker Compose, Auth + MFA, RBAC + scope, Audit, CI, סימולטור | 2 שבועות |
| **2. ליבת אירועים** | פרוטוקול Uplink, Ingest, טבלת אירועים, WebSocket, רשימת אירועים, Ack פנימי, Heartbeat | 2–3 שבועות |
| **3. Edge** | Driver ל-BACnet ול-Modbus מול הסימולטור, חוצץ מקומי, WireGuard | 2–3 שבועות |
| **4. גרפיקה** | מבנים, קומות, העלאת תוכניות (מאובטחת), שיבוץ נקודות | 2 שבועות |
| **5. נהלים, התראות ודוחות** | | 2 שבועות |
| **6. פיילוט** | מבנה אחד, רכזת אחת, **Read-only**, הפעלה במקביל למוקד הקיים במשך חודש | 4 שבועות |
| **7. הקשחה** | בדיקת חדירות, נגישות, מסמכים משפטיים, Checklist לפרודקשן | 2 שבועות |

---

## 14. סיכונים מרכזיים

1. **רכזות בלי ממשק פתוח או פרוטוקול סגור (כנראה Telefire).** ייתכן שיידרש שער יצרן בתשלום, הנדסה הפוכה של פלט מדפסת, או רישיון.
2. **מיפוי נקודות:** הקשר בין כתובת ברכזת למיקום פיזי דורש קובץ תכנות מהקבלן. זה עבודה ידנית משמעותית.
3. **אמינות:** מערכת על VPS לא תגיע לזמינות של רכזת. לכן היא חייבת להיות משלימה.
4. **תקינה:** ייתכן שרשות הכבאות או יועץ הבטיחות יגבילו את השימוש.
5. **מדיניות IT ו-OT של המוסד:** ייתכן שחיבור יוצא מרשת ה-OT לא יאושר, ואז נעבור להתקנה מקומית.

---

## 15. שאלות פתוחות (נדרשות לפני שלב 1)

1. **אילו רכזות מותקנות בקמפוס** (יצרן, דגם, כמות, האם הן ברשת אחת), והאם יש להן מודול תקשורת (BACnet/Modbus/NET-7000)?
2. **ניטור בלבד, או שנדרשות גם פקודות** (Silence/Reset/נטרול)? ההמלצה: ניטור בלבד.
3. **היקף:** כמה מבנים, וכמה נקודות (גלאים ולחצנים) בסך הכול, בקירוב?
4. **האם מחלקת ה-IT מאשרת** שער בקמפוס עם חיבור יוצא ל-VPS, או שנדרשת התקנה מקומית? והאם יש SSO (Azure AD / Google) שצריך להתחבר אליו?
5. **מי המשתמשים בפועל:** מוקד ביטחון 24/7? ממונה בטיחות? באילו ערוצי התראה (SMS/WhatsApp/Push)?

### הנחות עבודה (עד שיתקבלו תשובות)

- ניטור בלבד (Read-only). VPS בישראל. שער קצה בקמפוס על מחשב Linux קטן או VM.
- 5–30 מבנים ועד ~10,000 נקודות. כ-20 משתמשים.
- ממשק בעברית מלאה (RTL), ואנגלית אופציונלית.

---

## 16. מקורות

- [Siemens Desigo CC: Configuring the FS20 Sinteso Fire Network](https://mybuilding.siemens.com/d025938170736/help/engineeringhelp/en-US/14651318411.html)
- [Desigo CC: CMSI STT Fire Systems](https://gbscampus.vu.nl/WebApp/Help/EngineeringHelp/en-US/14757733771.html)
- [Desigo CC: Event Handling](https://mybuilding.siemens.com/D025938170736/Help/EngineeringHelp/en-US/13256608395.html)
- [Desigo CC: Additional FS20 Procedures](https://desigo.pemi.com/DESIGO/Help/EngineeringHelp/en-US/14650229899.html)
- [Desigo CC: Overview of Licensing](https://gbscampus.vu.nl/WebApp/Help/EngineeringHelp/en-US/13438527243.html)
- [Desigo CC: Verify the Installation Environment](https://mybuilding.siemens.com/D025938170736/Help/EngineeringHelp/en-US/23579166475.html)
- [Desigo CC: Hardware Requirements for UL Compliance](https://desigo.pemi.com/DESIGO/Help/EngineeringHelp/en-US/13949216011.html)
- [Desigo CC: ULC S527 Management Station Requirements](https://desigo.pemi.com/DESIGO/Help/EngineeringHelp/en-US/18062294027.html)
- [Desigo CC V6: cloud connectivity, BACnet/SC](https://www.tdworld.com/test-and-measurement/article/21251866/new-desigo-cc-v6-building-management-platform-adds-native-cloud-connectivity)
- [Notifier BACNET-GW-3 datasheet](https://securityandfire.honeywell.com/-/media//Files/Notifier/Data%20Sheets/DN_6877_pdf)
- [Simplex BACpac (BACnet/Modbus)](https://simplex-fire.devlive.jci.com/networks-and-workstations/integration-solutions/5605010401_fd/bacnet-integration-solutions)
- [Potter Modbus Link](https://www.pottersignal.com/fire-alarm-software/integrations/modbus-link-interface-scada)
- [Notifier ONYXWorks spec (UL-listed workstation)](https://www.securityandfire.honeywell.com:443/-/media/Files/Notifier/Engineering-Specs/onyxworks-spec_pdf.pdf)
- [Telefire ADR-7000](https://telefire.com/product/adr-7000/) · [ADR-7000 Technical Manual](https://www.manualslib.com/manual/1634853/Telefire-Adr-7000.html)
- [Teletek iRIS8 (Modbus TCP)](https://teletek-electronics.com/product/iris8-addressable-fire-alarm-panel/)
- [BACnet GetEventInformation](https://docs.chipkin.com/protocols/bacnet/services/get-event-information/) · [AcknowledgeAlarm](https://docs.chipkin.com/protocols/bacnet/services/acknowledge-alarm/)
- [BACpypes3 (GitHub)](https://github.com/JoelBender/BACpypes3)
- [מכון התקנים: ת"י 1220](https://www.sii.org.il/he/lobby/standardization/standard-page?id=4404)
- [הוראת נציב 536: אינטגרציה](https://melonaim.org/wp-content/uploads/2023/04/הוראת-נציב-536-אינטגרציה-משטר-הפעלות-אחת-ל-3-שנים-סע-10.1.pdf)
