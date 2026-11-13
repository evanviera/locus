import type { BoardPayload, LayoutDoc, Tier } from "./types";
import { mockBackend } from "./lib/mockBackend.js";

/** Everything the UI needs from the native side. The browser build (used by
 *  `npm run dev:vite` and the e2e tests) swaps in a generated mock board. */
export interface Backend {
  native: boolean;
  pickFolder(): Promise<string | null>;
  openBoard(root: string): Promise<BoardPayload>;
  rescan(): Promise<BoardPayload>;
  saveLayout(own: LayoutDoc): Promise<void>;
  compactLayout(): Promise<void>;
  moveImage(from: string, toFolder: string, copy: boolean): Promise<string>;
  importFiles(sources: string[], toFolder: string): Promise<string[]>;
  createFolder(parent: string, name: string): Promise<string>;
  reveal(path: string): Promise<void>;
  openFile(path: string): Promise<void>;
  loadThumb(path: string, tier: Tier): Promise<Blob>;
  thumbUrl(path: string, tier: Tier): string;
  on(event: "files-changed" | "layout-changed" | "menu", handler: (payload: string) => void): () => void;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const url = (path: string, tier: Tier) => convertFileSrc(`${tier}/${path}`, "thumb");
  return {
    native: true,
    pickFolder: () => invoke("pick_folder"),
    openBoard: (root) => invoke("open_board", { root }),
    rescan: () => invoke("rescan"),
    saveLayout: (own) => invoke("save_layout", { own }),
    compactLayout: () => invoke("compact_layout"),
    moveImage: (from, toFolder, copy) => invoke("move_image", { from, toFolder, copy }),
    importFiles: (sources, toFolder) => invoke("import_files", { sources, toFolder }),
    createFolder: (parent, name) => invoke("create_folder", { parent, name }),
    reveal: (path) => invoke("reveal", { path }),
    openFile: (path) => invoke("open_file", { path }),
    thumbUrl: url,
    async loadThumb(path, tier) {
      const res = await fetch(url(path, tier));
      if (!res.ok) throw new Error(`thumb ${res.status}`);
      return res.blob();
    },
    on(event, handler) {
      const name = event === "menu" ? "menu" : `board:${event}`;
      let stop: (() => void) | null = null;
      let cancelled = false;
      void listen<string>(name, (e) => handler(String(e.payload ?? ""))).then((un) => {
        if (cancelled) un();
        else stop = un;
      });
      return () => {
        cancelled = true;
        stop?.();
      };
    }
  };
}

let backendPromise: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  backendPromise ??= isTauri ? tauriBackend() : Promise.resolve(mockBackend());
  return backendPromise;
}
