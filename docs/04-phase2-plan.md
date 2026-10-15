# שלב 2: ליבת אירועים (Collector, Ingest, אירועים חיים)

> סטטוס: **הושלם (2026-10-15).** מבוסס על [02](02-decisions-v0.2.md) ו-[03](03-phase1-plan.md).
>
> **תוצאות האימות:**
> - בדיקות שרת: 86/86. בדיקות Collector: 30/30 (כולל BACnet אמיתי מול הסימולטור).
> - בדיקת קצה-לקצה (סימולטור → Collector → שרת → דפדפן): 33/33.
>   - התרעת אש על המסך תוך כ-100ms (היעד: פחות מ-3 שניות), כולל אצל ממונה עם הרשאה למבנה.
>   - Ack חי בין משתמשים.
>   - נקודה מנוטרלת זוהתה בסריקת מלאי.
>   - באנר "רכזת לא מגיבה" תוך כ-9 שניות. באנר Watchdog ל-Collector תוך כ-15 שניות.
>   - אירוע שקרה בזמן ניתוק נקלט אחרי סנכרון.
>   - axe WCAG 2.1 AA בכל המסכים (בהיר וכהה).
> - **לא נבדק:** רכזת Siemens אמיתית ובניית Docker (אין Docker daemon בסביבה זו).

## מטרה

התרעה מהרכזת מגיעה למסך המפעיל ולממונה הבטיחות **תוך פחות מ-3 שניות**, ושום אירוע לא הולך לאיבוד. התנאים לכך:
- אין פקודות לרכזת (ניטור בלבד).
- ניתוק של רכזת, של ה-Collector או של השרת מוצג לכולם באופן בולט.

## ממצאי Spike (בדיקה מעשית של BACpypes3 0.0.110 ב-loopback)

| יכולת | תוצאה |
|---|---|
| `GetEventInformationRequest` (לקוח) ו-`GetEventInformationACK` | ✅ עובד. **אין handler בצד השרת**: נכתב בסימולטור |
| `ReadProperty` / `ReadPropertyMultiple` / `objectList` | ✅ |
| קליטת `UnconfirmedEventNotification` ו-`ConfirmedEventNotification` | ✅ בעזרת `do_<Request>` ב-Application |
| `LifeSafetyPointObject` (presentValue = LifeSafetyState) | ✅ |

> **דורש אימות מול רכזת Siemens אמיתית:**
> - אילו סוגי אובייקטים היא חושפת (Life Safety Point/Zone, או Multi-state / Binary).
> - האם היא שולחת EventNotification לנמען שהוגדר.
> - הגודל של כל עמוד ב-GetEventInformation.

## ארכיטקטורה

```
[Siemens panel / Simulator] ──BACnet/IP──► Collector (Python, BACpypes3)
   │  GetEventInformation כל 5 שניות (paged)        │ SQLite outbox (epoch + seq)
   │  EventNotification (אם הוגדרנו כנמען)          │ HTTPS POST /ingest/v1/batch
   │  ReadProperty(device) = Heartbeat               ▼ Bearer token (hash בשרת)
   │  Inventory: objectList + RPM כל 5 דקות       Server (Fastify)
                                                    │ טרנזקציה: event_log → point → alarm
                                                    │ Watchdog: collector שקט 60 שניות → התראת תקשורת
                                                    ▼ WebSocket: הודעת "invalidate" בלבד, מסוננת לפי scope
                                                   Web: אירועים פעילים, צליל, Ack, היסטוריה
```

### החלטות

| נושא | החלטה | נימוק |
|---|---|---|
| Collector → Server | HTTPS POST, Batch ו-Bearer token לכל Collector (נשמר כ-SHA-256) | פשוט, עמיד ל-Retry. mTLS ב-Caddy אפשרי כשכבה נוספת |
| אמינות | Outbox מקומי ב-SQLite, `(epoch, seq)` ייחודי, ו-`ackedSeq` מהשרת | At-least-once + Idempotency = אירוע לא הולך לאיבוד ולא נכפל |
| סנכרון | ה-Collector שולח **Snapshot** של כל הנקודות שאינן נורמליות (באתחול ובכל 60 שניות). השרת מנקה התראות שנעלמו | מתקן מצב אחרי ניתוק או אתחול |
| סיווג | `categorize()` ב-`packages/shared`. ה-Collector שולח ערכי BACnet גולמיים | מדיניות במקום אחד, ניתנת לבדיקה |
| Realtime | WebSocket שולח רק `alarms-changed` ו-category, לא תוכן. הלקוח מושך נתונים דרך REST (מסונן לפי scope) | אין סיכון לדליפה בין מבנים |
| Ack | **פנימי בלבד**. לא נשלח AcknowledgeAlarm לרכזת | D2: ניטור בלבד |

### סיווג (טיוטה, דורש אימות מול Siemens)

| קטגוריה | עדיפות | LifeSafetyState / EventState |
|---|---|---|
| `fire` | 1 | alarm, fault-alarm, local-alarm, general-alarm, או EventState=life-safety-alarm |
| `prealarm` | 2 | pre-alarm, fault-pre-alarm |
| `fault` | 3 | fault, tamper, tamper-alarm, EventState=fault, או reliability ≠ no-fault-detected |
| `supervisory` | 4 | supervisory, active, abnormal, not-ready, delayed, blocked, emergency-power, holdup, duress, offnormal |
| `disabled` | 5 | outOfService=true, או mode=disabled/off |
| `test` | 6 | test-* |
| `normal` | — | quiet, EventState=normal |

## מודל נתונים (מיגרציה 002)

`collector`, `bacnet_device` (עם building_id אופציונלי), `point` (עם building_id, label, location, ומצב נוכחי), `event_log` (ייחודי לפי collector+epoch+seq), `alarm` (מופע: נקודה × קטגוריה, כולל raised/cleared/acked), `alarm_note`.

## API

| Method | Path | הרשאה |
|---|---|---|
| POST | `/ingest/v1/batch` | Bearer של Collector בלבד, ללא Cookie, מחוץ לבדיקת Origin |
| GET | `/api/alarms?state=active\|all` | מחובר, לפי scope |
| GET | `/api/alarms/summary` | מחובר, לפי scope |
| GET | `/api/alarms/:id` | מחובר, לפי scope (404 מחוץ ל-scope) |
| POST | `/api/alarms/:id/ack`, `/api/alarms/:id/notes` | Operator, SafetyOfficer, FireAdmin |
| GET | `/api/system/status` | מחובר. מצב Collectors ורכזות (ללא פרטים רגישים) |
| GET | `/api/ws` | WebSocket. Cookie + בדיקת Origin |
| CRUD | `/api/admin/collectors`, `/api/admin/points`, `/api/admin/devices` | FireAdmin. הטוקן מוצג **פעם אחת** |

**התראות על Collector או רכזת מנותקים** מוצגות לכל המשתמשים כבאנר אדום: "אין קשר. הניטור אינו פעיל".

## בדיקות

- **Python:** סיווג ו-diff, outbox, uplink מול שרת HTTP מדומה, ואינטגרציה של סימולטור ↔ Collector ב-loopback. בנוסף, **בדיקה שאין בקוד שירותי כתיבה ל-BACnet**.
- **Server:** אימות Ingest, Idempotency, מחזור חיים של התראה, Reconcile, Watchdog, scope, הרשאות Ack, ואימות WebSocket ו-Origin.
- **E2E:** סימולטור → Collector → Server → דפדפן. התרעת אש מוצגת תוך פחות מ-3 שניות, ואז Ack. בנוסף axe.

## מחוץ לשלב זה

מפות קומה ושיבוץ גרפי (שלב 3), התראות SMS/WhatsApp/Push (שלב 4), ייבוא EDE (שלב 3), Redis לריבוי מופעי שרת.
