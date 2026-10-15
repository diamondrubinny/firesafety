import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Native <dialog> provides focus trapping, Esc handling and inert background. */
export function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} aria-labelledby="confirm-title" aria-describedby="confirm-msg" onCancel={onCancel} className="dialog">
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-msg">{message}</p>
      <div className="row">
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel} autoFocus>
          ביטול
        </button>
      </div>
    </dialog>
  );
}
