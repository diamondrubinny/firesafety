import type { ApiError } from '@firesafety/shared';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError | null,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

async function request<T>(method: string, url: string, body?: unknown, raw?: { body: BodyInit; type: string }): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiRequestError(res.status, data as ApiError | null);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: (url: string) => request<void>('DELETE', url),
  /** Raw body upload (e.g. image, CSV). */
  raw: <T>(method: 'PUT' | 'POST' | 'DELETE', url: string, body: BodyInit, type: string) => request<T>(method, url, undefined, { body, type }),
};

/** Maps API errors to safe Hebrew messages. Server messages are not shown verbatim. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.status) {
      case 400:
        if (err.body?.error === 'code_invalid') return 'הקוד שגוי.';
        if (err.body?.error === 'code_expired') return 'תוקף הקוד פג. נא לבקש קוד חדש.';
        return 'הנתונים שהוזנו אינם תקינים. נא לבדוק את השדות המסומנים.';
      case 401:
        return 'פג תוקף ההתחברות. נא להתחבר מחדש.';
      case 403:
        return 'אין לך הרשאה לבצע פעולה זו.';
      case 404:
        return 'הפריט המבוקש לא נמצא.';
      case 409:
        return 'קיים כבר פריט עם אותו מזהה.';
      case 413:
        return 'הקובץ גדול מדי (עד 10MB).';
      case 415:
        return 'סוג הקובץ אינו נתמך. ניתן להעלות PNG, JPEG או WebP בלבד.';
      case 422:
        return 'הקובץ נחסם בסריקת האבטחה ולא נשמר.';
      case 503:
        return 'סריקת האבטחה אינה זמינה כרגע. נא לנסות שוב מאוחר יותר.';
      case 429:
        return err.body?.error === 'too_many_attempts' ? 'יותר מדי ניסיונות. נא לבקש קוד חדש.' : 'יותר מדי בקשות. נא לנסות שוב בעוד כמה דקות.';
      case 502:
        return 'השליחה לספק נכשלה. נא לבדוק את הגדרות הספק או לנסות שוב.';
      default:
        return 'אירעה שגיאה. נא לנסות שוב.';
    }
  }
  return 'לא ניתן להתחבר לשרת. נא לבדוק את החיבור לרשת.';
}
