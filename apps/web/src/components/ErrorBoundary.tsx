import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

/** Last-resort UI for rendering errors. Details are not shown to the user. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Client-side error reporting can be added here (no third-party service by default).
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main id="main" className="login">
        <h1>אירעה שגיאה</h1>
        <p>משהו השתבש בהצגת הדף.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          טעינה מחדש
        </button>
      </main>
    );
  }
}
