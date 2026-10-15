import type { ApiError } from '@firesafety/shared';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError | null,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
};

/** Maps API errors to safe Hebrew messages. Server messages are not shown verbatim. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.status) {
      case 400:
        return 'הנתונים שהוזנו אינם תקינים. נא לבדוק את השדות המסומנים.';
      case 401:
        return 'פג תוקף ההתחברות. נא להתחבר מחדש.';
      case 403:
        return 'אין לך הרשאה לבצע פעולה זו.';
      case 404:
        return 'הפריט המבוקש לא נמצא.';
      case 409:
        return 'קיים כבר פריט עם אותו מזהה.';
      case 429:
        return 'יותר מדי בקשות. נא לנסות שוב בעוד דקה.';
      default:
        return 'אירעה שגיאה. נא לנסות שוב.';
    }
  }
  return 'לא ניתן להתחבר לשרת. נא לבדוק את החיבור לרשת.';
}
