import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../ipc";
import type { GroupNode, ItemNode } from "../lib/board";
import { tidy } from "../lib/board.js";
import type { Session } from "../lib/session";
import { Scene, snapshot } from "../canvas/scene.js";
import { FOLDER_STYLES, type FolderStyle, type Theme, prefs } from "../lib/prefs.js";
import { Toolbar } from "./Toolbar.js";
import { Sidebar } from "./Sidebar.js";
import { Viewer } from "./Viewer.js";
import { ContextMenu, type MenuItem } from "./ContextMenu.js";
import { CloudStatus } from "./CloudStatus.js";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog.js";

interface Props {
  backend: Backend;
  session: Session;
  theme: Theme;
  onTheme(t: Theme): void;
  onClose(): void;
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

export function BoardScreen({ backend, session, theme, onTheme, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number | null>(null);
  const [sidebar, setSidebar] = useState(prefs.sidebar());
  const [folderStyle, setFolderStyle] = useState<FolderStyle>(() => {
    const fromUrl = new URLSearchParams(location.search).get("folders");
    return (FOLDER_STYLES as readonly string[]).includes(fromUrl ?? "") ? (fromUrl as FolderStyle) : prefs.folderStyle();
  });
  const folderStyleRef = useRef(folderStyle);
  const [viewer, setViewer] = useState<ItemNode | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "-")[] } | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [stats, setStats] = useState({ visible: 0, drawCalls: 0, fps: 0, atlas: 0, loading: false });
  const [selected, setSelected] = useState(0);
  const [cloudLeft, setCloudLeft] = useState(0);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [cloudPaused, setCloudPaused] = useState(false);
  const showStats = new URLSearchParams(location.search).has("stats");

  const board = session.board;

  // Create the scene once per session.
  useEffect(() => {
    const scene = new Scene(hostRef.current!, canvasRef.current!, overlayRef.current!, (p, t) => backend.loadThumb(p, t), {
      edit: (change) => session.edit(change),
      moveFiles: (items, to, copy, at) => void session.moveFiles(items, to, copy, at),
      openViewer: (it) => setViewer(it),
      contextMenu: (target, at) => openMenu(target, at),
      selectionChanged: (n) => setSelected(n),
      stats: (s) => showStats && setStats(s),
      cloudLeft: (n) => setCloudLeft(n),
      sizesLearned: (items) => session.write(items, [])
    });
    sceneRef.current = scene;
    scene.hierarchy = folderStyleRef.current;
    if (!backend.native) (window as unknown as { __locus: unknown }).__locus = { session, scene };
    scene.setBoard(session.board, false);
    session.onBoard = (b, keep) => {
      scene.setBoard(b, keep);
      setVersion((v) => v + 1);
    };
    session.onNotice = (text, undo) => setNotice({ text, undo });
    session.ask = (q) => new Promise((resolve) => setConfirmReq({ ...q, resolve }));
    const offFiles = backend.on("files-changed", () => void session.reload(true));
    const offLayout = backend.on("layout-changed", () => void session.reload(true));
    return () => {
      offFiles();
      offLayout();
      void session.flush();
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // The theme attribute is set by App's effect, which runs after this one, so
  // read the new colors on the next frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => sceneRef.current?.readColors());
    return () => cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    prefs.setSidebar(sidebar);
  }, [sidebar]);

  useEffect(() => {
    folderStyleRef.current = folderStyle;
    prefs.setFolderStyle(folderStyle);
    const scene = sceneRef.current;
    if (scene) {
      scene.hierarchy = folderStyle;
      scene.invalidate();
    }
  }, [folderStyle]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const sel = () => [...(sceneRef.current?.selection ?? [])];

  const step = useCallback((dir: number) => {
    setViewer((cur) => {
      if (!cur) return cur;
      const list = cur.group.items;
      const i = list.indexOf(cur);
      return list[(i + dir + list.length) % list.length] ?? cur;
    });
  }, []);

  const viewerSource = useCallback(
    (it: ItemNode) =>
      backend.native ? Promise.resolve(backend.thumbUrl(it.path, "full")) : backend.loadThumb(it.path, "full").then((t) => URL.createObjectURL(t.blob)),
    [backend]
  );

  const flip = (axis: "x" | "y") => sceneRef.current?.transformSelection((it) => (axis === "x" ? (it.fx = !it.fx) : (it.fy = !it.fy)));
  const resetTransform = () => sceneRef.current?.transformSelection((it) => { it.rot = 0; it.fx = false; it.fy = false; });

  const tidyGroup = (g: GroupNode) => {
    const before = snapshot(g.items, [g]);
    tidy(g);
    session.edit({ before, after: snapshot(g.items, [g]) }, "Tidy");
    session.onBoard(session.board, true);
  };

  const newFolder = async (parent: GroupNode) => {
    const name = await session.ask({ title: `New folder in “${parent.name || "the board folder"}”`, input: "New folder", confirm: "Create" });
    if (name) void session.createFolder(parent, name.trim());
  };

  function openMenu(target: ItemNode | GroupNode | null, at: { x: number; y: number }) {
    if (!target) return;
    if ("img" in target) {
      const items = sel();
      const one = items.length === 1;
      setMenu({
        ...at,
        items: [
          { label: "Open", hint: "↩", run: () => setViewer(target) },
          { label: isMac ? "Show in Finder" : "Show in Explorer", run: () => void backend.reveal(target.path) },
          { label: "Open in default app", run: () => void backend.openFile(target.path) },
          { label: "Copy path", run: () => void navigator.clipboard?.writeText(target.path) },
          "-",
          { label: "Flip horizontal", hint: "H", run: () => flip("x") },
          { label: "Flip vertical", hint: "V", run: () => flip("y") },
          { label: "Reset rotation and flip", hint: "R", run: resetTransform },
          "-",
          { label: one ? "Fit to screen" : `Fit ${items.length} images`, hint: "F", run: () => sceneRef.current?.fitItems(items) },
          { label: `Tidy “${target.group.name}”`, run: () => tidyGroup(target.group), disabled: target.group.mode === "auto" }
        ]
      });
    } else {
      setMenu({
        ...at,
        items: [
          { label: "Fit folder", run: () => sceneRef.current?.fitGroup(target) },
          { label: isMac ? "Show in Finder" : "Show in Explorer", run: () => void backend.reveal(target.path) },
          { label: "New folder inside…", run: () => newFolder(target) },
          "-",
          { label: "Tidy (back to a grid)", run: () => tidyGroup(target), disabled: target.mode === "auto" }
        ]
      });
    }
  }

  const runCommand = useCallback(
    (cmd: string) => {
      const scene = sceneRef.current;
      if (!scene) return;
      switch (cmd) {
        case "undo": return void session.undo();
        case "redo": return void session.redo();
        case "find": searchRef.current?.focus(); searchRef.current?.select(); return;
        case "fit": return scene.fit();
        case "sidebar": return setSidebar((s) => !s);
        case "reload": return void session.reload(true);
        case "reveal-root": return void backend.reveal("");
        case "new-folder": {
          const target = sel()[0]?.group ?? session.board.root;
          return newFolder(target);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, backend]
  );

  useEffect(() => backend.on("menu", runCommand), [backend, runCommand]);

  // Keyboard shortcuts (the native menu sends the same commands on macOS).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const scene = sceneRef.current;
      if (!scene || viewer || confirmReq) return;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); runCommand(e.shiftKey ? "redo" : "undo"); return; }
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); runCommand("find"); return; }
      if (mod && e.key === "0") { e.preventDefault(); scene.fit(); return; }
      if (mod && e.key === "\\") { e.preventDefault(); runCommand("sidebar"); return; }
      if (mod && e.key.toLowerCase() === "a" && !typing) { e.preventDefault(); scene.select(board.drawItems); return; }
      if (typing) return;
      if (e.key === " ") { e.preventDefault(); scene.setSpace(true); return; }
      const items = sel();
      switch (e.key) {
        case "Escape": scene.select([]); break;
        case "Enter": if (items[0]) setViewer(items[0]); break;
        case "f": case "F": items.length ? scene.fitItems(items) : scene.fit(); break;
        case "h": case "H": flip("x"); break;
        case "v": case "V": flip("y"); break;
        case "r": case "R": resetTransform(); break;
        case "/": e.preventDefault(); runCommand("find"); break;
        case "=": case "+": scene.zoomAt(scene.renderer.width / 2, scene.renderer.height / 2, 1.25); break;
        case "-": scene.zoomAt(scene.renderer.width / 2, scene.renderer.height / 2, 0.8); break;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") sceneRef.current?.setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, runCommand, board, confirmReq]);

  const onQuery = (q: string) => {
    setQuery(q);
    const n = sceneRef.current?.setQuery(q) ?? 0;
    setMatches(q.trim() ? n : null);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sceneRef.current?.nextMatch(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") {
      onQuery("");
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="app-shell">
      <Toolbar
        name={board.root.name}
        images={board.items.size}
        folders={board.groups.size}
        people={session.people}
        missing={session.missing}
        query={query}
        matches={matches}
        searchRef={searchRef}
        theme={theme}
        folderStyle={folderStyle}
        onFolderStyle={setFolderStyle}
        sidebar={sidebar}
        onQuery={onQuery}
        onSearchKey={onSearchKey}
        onFit={() => sceneRef.current?.fit()}
        onTheme={onTheme}
        onToggleSidebar={() => setSidebar((s) => !s)}
        onClose={onClose}
      />
      <div className="workspace">
        {sidebar && <Sidebar board={board} onPick={(g) => sceneRef.current?.fitGroup(g)} />}
        <div className="canvas-host" ref={hostRef} data-testid="canvas">
          <canvas ref={canvasRef} />
          <div className="overlay" ref={overlayRef} />
          {showStats && (
            <div className="stats" data-testid="stats">
              {stats.fps} fps · {stats.visible.toLocaleString()} visible · {stats.drawCalls} draws · {stats.atlas.toLocaleString()} thumbs{stats.loading ? " · loading" : ""}
            </div>
          )}
          {selected > 1 && <div className="selection-count">{selected} selected</div>}
          {cloudLeft > 0 && (
            <CloudStatus
              left={cloudLeft}
              paused={cloudPaused}
              onToggle={() => {
                sceneRef.current?.setCloudPaused(!cloudPaused);
                setCloudPaused(!cloudPaused);
              }}
            />
          )}
        </div>
      </div>
      {viewer && <Viewer item={viewer} source={viewerSource} onStep={step} onClose={() => setViewer(null)} />}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {confirmReq && <ConfirmDialog req={confirmReq} onDone={() => setConfirmReq(null)} />}
      {notice && (
        <div className="toast" role="status">
          <span>{notice.text}</span>
          {notice.undo && (
            <button className="btn small" onClick={() => { notice.undo!(); setNotice(null); }}>
              Undo <kbd>{MOD}Z</kbd>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
