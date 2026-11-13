import { useEffect, useState } from "react";
import type { ItemNode } from "../lib/board";

interface Props {
  item: ItemNode;
  source(item: ItemNode): Promise<string>;
  onStep(step: number): void;
  onClose(): void;
}

const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

/** Full-window view of one image. Arrows step through its folder. */
export function Viewer({ item, source, onStep, onClose }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLoaded(false);
    setSrc(null);
    source(item).then((s) => live && setSrc(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [item, source]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); onStep(1); }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); onStep(-1); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, onStep]);
  const { img } = item;
  return (
    <div className="viewer" role="dialog" aria-label={img.name} onClick={onClose}>
      {src && <img
        key={item.path}
        src={src}
        alt={img.name}
        className={loaded ? "loaded" : ""}
        onLoad={() => setLoaded(true)}
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `${item.fx ? "scaleX(-1)" : ""} ${item.fy ? "scaleY(-1)" : ""}` }}
      />}
      <footer className="viewer-meta" onClick={(e) => e.stopPropagation()}>
        <span className="viewer-name">{img.name}</span>
        <span>{img.width && `${img.width} × ${img.height}`}</span>
        <span>{kb(img.size)}</span>
        <span className="viewer-path">{item.group.path || "Board folder"}</span>
        {!loaded && img.onlineOnly && <span>Downloading…</span>}
      </footer>
    </div>
  );
}
