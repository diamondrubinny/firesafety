# שלב 4: התראות לממוני בטיחות (Push, SMS, WhatsApp, Email) והסלמה

> סטטוס: **הושלם (2026-10-16).** החלטת לקוח: **כל הספקים והפרטים מוגדרים במסך "הגדרות"**, לא בקוד.
>
> **תוצאות האימות:**
> - בדיקות שרת: 128/128, כולל ספקים מדומים (HTTP ו-SMTP אמיתי).
>   - מגבלת Push ל-allowlist (הגנת SSRF).
>   - הצפנת סודות וטלפונים.
>   - קיבוץ, ניסיונות חוזרים, הסלמה, ודילוג על אירוע שאושר.
>   - שרת שעלה מחדש ממשיך את התור.
> - בדיקת קצה-לקצה: 17/17.
>   - הגדרה דרך המסך ושליחות בדיקה.
>   - אש בסימולטור ← SMS, WhatsApp ודוא"ל תוך כשנייה.
>   - הסלמה אחרי 30 שניות. אירוע שאושר לא מוסלם.
>   - הצגת Push ב-Service Worker.
>   - axe WCAG 2.1 AA.
> - **לא נבדק:** ספקים אמיתיים (Twilio, Meta, ספק SMS ישראלי) ושירות Push אמיתי של דפדפן. הם חסומים ברשת סביבה זו, ונבדקים בהתקנה דרך כפתורי "שליחת בדיקה".

## עקרונות

1. **התראה חיצונית היא ערוץ משלים.** היא לא מחליפה את הרכזת, את המוקד או את הכריזה.
2. **אמינות:**
   - כל משלוח נרשם ב-DB (Outbox) לפני השליחה.
   - Worker שולח, ומבצע ניסיונות חוזרים עם Backoff.
   - שרת שעלה מחדש ממשיך מאותה נקודה.
   - כשל של ערוץ אחד לא עוצר את האחרים.
3. **אין פעולה דרך קישור (GET).** אפליקציות מסרים פותחות קישורים מראש לצורך תצוגה מקדימה, ולכן קישור "אישור" ב-GET עלול לאשר אירוע בלי שאדם ראה אותו. **הקישור בהודעה פותח את דף האירוע** (מאחורי SSO), ושם מבצעים Ack.
4. **סודות:**
   - טוקנים וסיסמאות של ספקים נשמרים ב-DB **מוצפנים ב-AES-256-GCM** במפתח מ-`SETTINGS_ENCRYPTION_KEY` (משתנה סביבה, לא ב-DB).
   - הם Write-only בממשק: מוצג רק "מוגדר", ולא נשלחים חזרה לדפדפן.
5. **פרטיות:**
   - טלפון המשתמש מוצפן ברמת השדה. ביומן המשלוחים נשמר נמען מוסווה (`+97250•••1234`).
   - WhatsApp דורש **הסכמה מפורשת (opt-in)** של המשתמש.

## ערוצים וספקים (נבחרים בהגדרות)

| ערוץ | ספקים | הערות |
|---|---|---|
| Push (PWA) | Web Push (VAPID), מפתחות נוצרים אוטומטית | ב-iOS עובד רק אחרי "הוספה למסך הבית" |
| Email | SMTP (כולל SMTP של M365 של המוסד) | |
| SMS | **Twilio**, או **HTTP כללי** (URL, Headers ו-Body בתבנית `{{to}}` / `{{text}}`) | HTTP כללי מאפשר כל ספק ישראלי בלי שאמציא את ה-API שלו. **דורש אימות מול התיעוד של הספק שייבחר** |
| WhatsApp | **WhatsApp Business Cloud API (רשמי)**: Phone Number ID, Access Token, שם Template ושפה | ההודעה נשלחת כ-Template מאושר מראש. גרסת ה-Graph API ניתנת להגדרה (**דורש אימות מול תיעוד Meta**). חיבור בסריקת QR לא נבנה (ראו החלטה בצ'אט) |

לכל ספק יש כפתור **"שליחת בדיקה"**.

## מדיניות שליחה (ברירות מחדל, ניתנות לשינוי בהגדרות)

| קטגוריה | נמענים | ערוצים | הסלמה |
|---|---|---|---|
| אש | ממוני בטיחות ומנהלים עם scope למבנה | כל הערוצים הפעילים | אם אין Ack תוך **180 שניות**: שליחה חוזרת ל-FireAdmin + SMS |
| קדם-אזעקה, תקלה | ממוני בטיחות עם scope | Push, Email | — |
| תקשורת (רכזת או Collector) | FireAdmin | Push, SMS, Email | — |
| פיקוח, מנוטרל, בדיקה | — (מוצג במערכת בלבד) | — | — |

- **קיבוץ:** כמה התראות לאותו נמען ובאותו ערוץ בתוך חלון של 10 שניות נשלחות כהודעה אחת. כך עשרות גלאים לא יוצרים עשרות SMS.
- **משתמש:** בעמוד "ההתראות שלי" מגדירים טלפון, ערוצים, הסכמה ל-WhatsApp, הפעלת Push ושליחת בדיקה.

## נתונים (מיגרציה 004)

- `app_setting(key, value jsonb, secret_enc bytea, updated_by, updated_at)`
- `user_contact(user_id, phone_enc, phone_hint, channels text[], whatsapp_opt_in_at)`
- `push_subscription(id, user_id, endpoint, p256dh, auth, created_at)`
- `notification(id, alarm_id, user_id, channel, stage[initial|escalation], status[pending|sent|failed|skipped], attempts, next_attempt_at, last_error, recipient_hint, sent_at)`. ייחודי לפי `(alarm_id, user_id, channel, stage)`.
- `alarm.notified_at`, `alarm.escalated_at`

## API

| Method | Path | הרשאה |
|---|---|---|
| GET/PUT | `/api/admin/settings/notifications` | FireAdmin. סודות Write-only |
| POST | `/api/admin/settings/notifications/test` | FireAdmin. שליחת בדיקה בערוץ מסוים |
| GET | `/api/admin/notifications` | FireAdmin. יומן משלוחים (מוסווה) |
| GET/PUT | `/api/me/notifications` | כל משתמש מחובר |
| POST/DELETE | `/api/me/push-subscriptions` | כל משתמש מחובר |
| POST | `/api/me/notifications/test` | כל משתמש מחובר (rate limit) |
| GET | `/api/push/public-key` | כל משתמש מחובר |
