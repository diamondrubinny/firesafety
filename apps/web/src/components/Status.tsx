import type { ReactNode } from 'react';
import { errorMessage } from '../lib/api';

export function Loading({ label = 'טוען…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="muted">
      {label}
    </p>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div role="alert" className="alert alert-error">
      {errorMessage(error)}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}
