// Promise-based dialogs (window.prompt/confirm are blocked in some embeddings).
//   const name = await promptDialog({ title: 'New strategy', label: 'Name', validate })
//   if (await confirmDialog({ title: 'Delete?', message: '…', danger: true })) …
import { useEffect, useRef, useState } from 'react';

interface PromptReq {
  kind: 'prompt';
  title: string;
  message?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  validate?: (v: string) => string | undefined;
  resolve: (v: string | null) => void;
}
interface ConfirmReq {
  kind: 'confirm';
  title: string;
  message?: string;
  okLabel?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
type Req = PromptReq | ConfirmReq;

let push: ((r: Req) => void) | undefined;

export function promptDialog(o: Omit<PromptReq, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => (push ? push({ ...o, kind: 'prompt', resolve }) : resolve(null)));
}

export function confirmDialog(o: Omit<ConfirmReq, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => (push ? push({ ...o, kind: 'confirm', resolve }) : resolve(false)));
}

/** Mount once at the app root. */
export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const openedAt = useRef(0);
  useEffect(() => {
    push = (r) => {
      openedAt.current = Date.now();
      setReq(r);
      setValue(r.kind === 'prompt' ? r.value ?? '' : '');
      setError(undefined);
    };
    return () => (push = undefined);
  }, []);
  if (!req) return null;
  const close = (ok: boolean) => {
    // The key press that opened the dialog (e.g. Enter in a field) must not confirm it.
    if (ok && Date.now() - openedAt.current < 250) return;
    if (req.kind === 'prompt') {
      if (ok) {
        const err = req.validate?.(value.trim());
        if (err) return setError(err);
        req.resolve(value.trim());
      } else req.resolve(null);
    } else req.resolve(ok);
    setReq(null);
  };
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          close(true);
        }}
        onKeyDown={(e) => e.key === 'Escape' && close(false)}
      >
        <h3>{req.title}</h3>
        {req.message && <p>{req.message}</p>}
        {req.kind === 'prompt' && (
          <label style={{ display: 'grid', gap: 4 }}>
            {req.label && <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{req.label}</span>}
            <input
              id="dialog-input"
              className={`input${error ? ' invalid' : ''}`}
              autoFocus
              value={value}
              placeholder={req.placeholder}
              onChange={(e) => {
                setValue(e.target.value);
                setError(undefined);
              }}
            />
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="submit" className={`btn ${req.kind === 'confirm' && req.danger ? 'danger' : 'primary'}`} autoFocus={req.kind === 'confirm'}>
            {req.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}
