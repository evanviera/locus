import { useState } from "react";
import type { Board, GroupNode } from "../lib/board";

interface Props {
  board: Board;
  onPick(g: GroupNode): void;
}

function Row({ g, depth, onPick }: { g: GroupNode; depth: number; onPick(g: GroupNode): void }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = g.children.filter((c) => c.total > 0 || c.children.length > 0);
  return (
    <li>
      <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {kids.length > 0 ? (
          <button className="tree-toggle" aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <button className="tree-name" onClick={() => onPick(g)} title={g.path || g.name}>
          <span>{g.name}</span>
          <span className="tree-count">{g.total}</span>
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((c) => (
            <Row key={c.path} g={c} depth={depth + 1} onPick={onPick} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ board, onPick }: Props) {
  return (
    <nav className="sidebar" aria-label="Folders">
      <div className="sidebar-head">Folders</div>
      <ul className="tree">
        <Row g={board.root} depth={0} onPick={onPick} />
      </ul>
    </nav>
  );
}
