# שלב 1: שלד מערכת (Foundation)

> סטטוס: **הושלם (2026-10-15).** מבוסס על [02-decisions-v0.2.md](02-decisions-v0.2.md).
>
> **תוצאות האימות:**
> - בדיקות שרת: 46/46, מול PostgreSQL אמיתי.
> - Lint ו-Typecheck: נקיים.
> - `npm audit`: 0 חולשות.
> - בדיקות דפדפן (Playwright): 36/36, כולל axe WCAG 2.1 AA במצב בהיר וכהה.
> - Build ייצור: נבנה ורץ בלי תלויות פיתוח.
>
> **לא אומת בסביבה זו:** בניית Docker (אין Docker daemon) וחיבור Entra אמיתי (אין Tenant). אלה נבדקים בהתקנה הראשונה.
>
> **כלל פרטיות:** אסור לציין בריפו את שם המוסד, פרטי קבלנים, כתובות, מזהי Tenant או מזהי רכזות. ראו README.

## מטרה

תשתית מאובטחת שכל השלבים הבאים יישענו עליה:
- התחברות עם Entra ID
- הרשאות לפי תפקיד והיקף מבנים (מניעת IDOR)
- Audit
- ניהול פקולטות, מבנים ושיוך משתמשים
- ממשק RTL נגיש
- Docker Compose ו-CI

**לא נכלל בשלב זה:** BACnet, אירועים, התראות ומפות. הם בשלבים 2–4.
**שינוי מהתוכנית:** סימולטור ה-B-LSC עבר לשלב 2, כי הוא נבדק יחד עם ה-Collector.

## הנחות (השאלות מסבב 2 עדיין פתוחות)

- **היקף מבנים לפי ממונה:** כל ממונה רואה רק את המבנים שהוקצו לו. מי שמחזיק בתפקיד `FireAdmin` רואה הכול.
- **App Roles ב-Entra:** `FireAdmin`, `SafetyOfficer`, `Operator`, `Viewer`. מי שאין לו תפקיד נדחה בהתחברות.

## החלטות טכנולוגיות בשלב 1

| נושא | בחירה | חלופה | נימוק |
|---|---|---|---|
| גישה ל-DB | `pg` + SQL פרמטרי + שכבת Repository + מיגרציות SQL ממוספרות | Drizzle / Prisma | שקיפות מלאה במערכת בטיחותית, מעט תלויות, אין "קסם" |
| OIDC | `openid-client` v6 | MSAL Node | ספרייה סטנדרטית ומוסמכת (Certified OpenID). PKCE, state ו-nonce |
| Session | טוקן אקראי של 256 ביט בעוגייה. נשמר ב-DB כ-SHA-256 | JWT בעוגייה | ביטול מיידי, ללא סודות בצד הלקוח |
| ולידציה | Zod 4, משותף ב-`packages/shared` | — | |
| בדיקות | Vitest מול PostgreSQL אמיתי | — | בדיקות IDOR מול DB אמיתי |
| Web | React 19 + Vite + React Router | — | |

## מבנה

```
packages/shared   סכמות Zod, תפקידים, טיפוסים
apps/server       Fastify 5: config, db+migrations, auth (OIDC/dev), rbac, audit, routes
apps/web          React RTL: Login, Layout, Buildings, Admin, a11y/privacy pages, 404
deploy/           docker-compose, Caddyfile
.github/workflows CI: typecheck, lint, tests עם שירות Postgres
```

## Endpoints בשלב 1

| Method | Path | הרשאה |
|---|---|---|
| GET | `/healthz`, `/readyz` | ציבורי (ללא מידע רגיש) |
| GET | `/auth/login` → Entra, `/auth/callback` | ציבורי + rate limit |
| POST | `/auth/logout` | מחובר |
| POST | `/auth/dev-login` | **רק אם `AUTH_MODE=dev` ו-`NODE_ENV!=production`** |
| GET | `/api/me` | מחובר |
| GET | `/api/faculties`, `/api/buildings`, `/api/buildings/:id` | מחובר. מסונן לפי scope |
| POST/PATCH/DELETE | `/api/admin/faculties`, `/api/admin/buildings` | FireAdmin |
| GET | `/api/admin/users` | FireAdmin |
| PUT | `/api/admin/users/:id/scope` | FireAdmin |
| GET | `/api/admin/audit` | FireAdmin |

## בקרות אבטחה בשלב 1

- **Session:** Helmet (CSP, HSTS, frame-ancestors none), rate limit, עוגייה HttpOnly/Secure/SameSite=Lax, ותוקף Idle ו-Absolute.
- **CSRF:** בדיקת `Origin` בכל בקשה משנה, יחד עם SameSite.
- **ולידציה:** Zod בכל קלט, מגבלת גודל בקשה (`bodyLimit` 100KB).
- **שגיאות:** טיפול גלובלי, בלי stack trace ללקוח.
- **לוגים:** Pino עם redact ל-cookie, ל-authorization ול-tokens.
- **תפקידים:** נקראים מ-claim `roles` בכל התחברות, כך ששינוי ב-Entra נכנס לתוקף בהתחברות הבאה. דרישת `mfa` ב-`amr` ניתנת להגדרה (`OIDC_REQUIRE_MFA`).
- **Audit:** להתחברות, להתנתקות, לכשל הרשאה, לכל פעולת Admin ולשינוי scope.
