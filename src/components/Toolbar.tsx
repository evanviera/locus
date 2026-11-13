import { type RefObject } from "react";
import { FOLDER_STYLES, FOLDER_STYLE_NAMES, THEMES, THEME_NAMES, type FolderStyle, type Theme } from "../lib/prefs.js";

interface Props {
  name: string;
  images: number;
  folders: number;
  people: number;
  missing: number;
  query: string;
  matches: number | null;
  searchRef: RefObject<HTMLInputElement | null>;
  theme: Theme;
  folderStyle: FolderStyle;
  sidebar: boolean;
  onQuery(q: string): void;
  onSearchKey(e: React.KeyboardEvent<HTMLInputElement>): void;
  onFit(): void;
  onTheme(t: Theme): void;
  onFolderStyle(s: FolderStyle): void;
  onToggleSidebar(): void;
  onClose(): void;
}

export function Toolbar(p: Props) {
  return (
    <header className="toolbar">
      <button className="icon-btn" onClick={p.onToggleSidebar} aria-pressed={p.sidebar} title="Folders (⌘\)">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3v10" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <div className="toolbar-title">
        <span className="board-name">{p.name}</span>
        <span className="board-meta">
          {p.images.toLocaleString()} images · {p.folders.toLocaleString()} folders
          {p.people > 1 && ` · ${p.people} people`}
          {p.missing > 0 && ` · ${p.missing} missing`}
        </span>
      </div>
      <div className="search">
        <input
          ref={p.searchRef}
          type="search"
          placeholder="Find by name, folder or type"
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={p.onSearchKey}
          spellCheck={false}
        />
        {p.matches !== null && <span className="search-count">{p.matches.toLocaleString()}</span>}
      </div>
      <button className="btn" onClick={p.onFit} title="Fit board (⌘0)">
        Fit
      </button>
      <select
        className="select"
        value={p.folderStyle}
        onChange={(e) => p.onFolderStyle(e.target.value as FolderStyle)}
        aria-label="Folder style"
        title="How folders are drawn"
      >
        {FOLDER_STYLES.map((s) => (
          <option key={s} value={s}>
            {FOLDER_STYLE_NAMES[s]}
          </option>
        ))}
      </select>
      <select className="select" value={p.theme} onChange={(e) => p.onTheme(e.target.value as Theme)} aria-label="Theme">
        {THEMES.map((t) => (
          <option key={t} value={t}>
            {THEME_NAMES[t]}
          </option>
        ))}
      </select>
      <button className="btn ghost" onClick={p.onClose} title="Close board">
        Close
      </button>
    </header>
  );
}
