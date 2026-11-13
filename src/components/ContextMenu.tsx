import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  hint?: string;
  run(): void;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: (MenuItem | "-")[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16);
  return (
    <div className="menu" ref={ref} style={{ left, top }} role="menu">
      {items.map((m, i) =>
        m === "-" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className="menu-item"
            disabled={m.disabled}
            onClick={() => {
              onClose();
              m.run();
            }}
          >
            <span>{m.label}</span>
            {m.hint && <kbd>{m.hint}</kbd>}
          </button>
        )
      )}
    </div>
  );
}
