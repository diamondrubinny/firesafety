export interface OutboundMessage {
  /** Short single-paragraph text (SMS/WhatsApp parameter/push body). */
  text: string;
  /** Title / e-mail subject. */
  title: string;
  /** Deep link into the app (alarm page or alarm list). */
  url: string;
  /** True for fire alarms: push uses requireInteraction and high urgency. */
  urgent: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** false = configuration/permanent problem; retrying will not help. */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Never include provider responses verbatim: they may echo tokens or numbers. */
export function httpError(status: number): ProviderError {
  return new ProviderError(`provider responded HTTP ${status}`, status >= 500 || status === 429 || status === 408);
}

export async function postWithTimeout(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    const name = (err as Error).name;
    throw new ProviderError(name === 'TimeoutError' ? 'provider timeout' : `provider unreachable (${name})`, true);
  }
}
