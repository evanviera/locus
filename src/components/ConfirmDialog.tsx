import { useEffect, useRef, useState } from "react";

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirm: string;
  /** Ask for a name instead of a plain yes/no. */
  input?: string;
  resolve(value: string | null): void;
}

/** In-app confirmation (the webview's own confirm/prompt don't work in every
 *  build). Enter confirms, Escape cancels; the confirm button is the blue one. */
export function ConfirmDialog({ req, onDone }: { req: ConfirmRequest; onDone(): void }) {
  const [value, setValue] = useState(req.input ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const finish = (v: string | null) => {
    req.resolve(v);
    onDone();
  };
  const ok = () => finish(req.input !== undefined ? value.trim() || null : "yes");

  useEffect(() => {
    if (req.input !== undefined) inputRef.current?.select();
    else okRef.current?.focus();
  }, [req]);

  return (
    <div
      className="dialog-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && finish(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(null);
        if (e.key === "Enter") ok();
      }}
    >
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" data-testid="confirm">
        <h2 id="dialog-title">{req.title}</h2>
        {req.body && <p>{req.body}</p>}
        {req.input !== undefined && (
          <input ref={inputRef} className="dialog-input" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={() => finish(null)}>
            Cancel
          </button>
          <button ref={okRef} className="btn primary" onClick={ok}>
            {req.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
