import type { Backend } from "../ipc";
import type { BoardPayload, GroupRec, ItemRec, LayoutDoc, Stamped } from "../types";
import { type Board, type GroupNode, type ItemNode, buildBoard, contentOrigin, groupRec, itemRec, layoutBoard } from "./board.js";
import type { Change, Snapshot } from "../canvas/scene";
import { applySnapshot } from "../canvas/scene.js";

// One open board: the model, this computer's own layout document (the only
// layout file it ever writes), saving, undo/redo and moving files on disk.

interface UndoEntry {
  label: string;
  undo(): Promise<void> | void;
  redo(): Promise<void> | void;
}

const SEEN_KEY = (root: string) => `locus:seen:${root}`;

export class Session {
  board: Board;
  own: LayoutDoc;
  clock: number;
  people: number;
  missing: number;
  private saveTimer = 0;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  onBoard: (board: Board, keepCamera: boolean) => void = () => {};
  onNotice: (text: string, undo?: () => void) => void = () => {};

  constructor(private backend: Backend, readonly root: string, payload: BoardPayload) {
    this.own = payload.own;
    this.clock = Math.max(payload.layout.clock, payload.own.clock);
    this.people = payload.layout.people;
    this.missing = Object.keys(payload.layout.missing).length;
    this.board = buildBoard(payload.scan, payload.layout, this.readSeen());
    this.markSeen();
    this.persistUnplaced();
  }

  private readSeen(): Set<string> | null {
    try {
      const raw = localStorage.getItem(SEEN_KEY(this.root));
      return raw ? new Set(JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  }

  /** Remember what this computer has seen, so the next open can mark new files. */
  private markSeen() {
    try {
      localStorage.setItem(SEEN_KEY(this.root), JSON.stringify([...this.board.items.keys()]));
    } catch {
      /* storage full or blocked: new-file dots just won't show */
    }
  }

  /** Images placed for the first time in Free boxes, and boxes that moved to
   *  a new folder, get records so teammates see the same placement. */
  private persistUnplaced() {
    const items = [...this.board.items.values()].filter((it) => it.autoPlaced);
    const groups = [...this.board.groups.values()].filter((g) => g.autoPlaced);
    for (const it of items) it.autoPlaced = false;
    for (const g of groups) g.autoPlaced = false;
    if (items.length || groups.length) this.write(items, groups);
  }

  // ---------- saving ----------

  private stamp<T>(rec: T): Stamped<T> {
    this.clock += 1;
    return { ...rec, t: this.clock, by: this.own.device };
  }

  write(items: Iterable<ItemNode>, groups: Iterable<GroupNode>) {
    for (const it of items) this.own.items[it.path] = this.stamp<ItemRec>(itemRec(it));
    for (const g of groups) this.own.groups[g.path] = this.stamp<GroupRec>(groupRec(g));
    this.scheduleSave();
  }

  private tombstone(path: string) {
    this.own.items[path] = this.stamp<ItemRec>({ gone: true });
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 500);
  }

  async flush() {
    window.clearTimeout(this.saveTimer);
    this.own.clock = this.clock;
    try {
      await this.backend.saveLayout(this.own);
    } catch (e) {
      this.onNotice(`Couldn't save the layout. ${String(e)}`);
    }
  }

  // ---------- edits and undo ----------

  edit(change: Change, label = "Edit") {
    const persist = (s: Snapshot) => {
      applySnapshot(this.board, s);
      this.write(s.items.keys(), s.groups.keys());
      this.onBoard(this.board, true);
    };
    this.write(change.after.items.keys(), change.after.groups.keys());
    this.push({ label, undo: () => persist(change.before), redo: () => persist(change.after) });
  }

  private push(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  async undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    await e.undo();
    this.redoStack.push(e);
  }

  async redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    await e.redo();
    this.undoStack.push(e);
  }

  // ---------- files on disk ----------

  /** Move (or copy, with Alt) images into another folder's box. Their size,
   *  rotation and flip carry over; they land where they were dropped. */
  async moveFiles(items: ItemNode[], to: GroupNode, copy: boolean, dropAt: { x: number; y: number }) {
    if (items.length > 20 && !window.confirm(`${copy ? "Copy" : "Move"} ${items.length} images into “${to.name}”?`)) return;
    const done: { from: string; to: string; fromFolder: string; rec: ItemRec }[] = [];
    const origin = contentOrigin(to);
    const anchor = items[0];
    for (const it of items) {
      try {
        const dest = await this.backend.moveImage(it.path, to.path, copy);
        const rec: ItemRec = {
          ...itemRec(it),
          x: dropAt.x - origin.x + (it.x - anchor.x) - anchor.w / 2,
          y: dropAt.y - origin.y + (it.y - anchor.y) - anchor.w / anchor.aspect / 2
        };
        done.push({ from: it.path, to: dest, fromFolder: it.group.path, rec });
      } catch (e) {
        this.onNotice(`Couldn't ${copy ? "copy" : "move"} ${it.img.name}. ${String(e)}`);
      }
    }
    if (!done.length) return;
    // Placing images by hand makes the target a Free box.
    if (to.mode === "auto") {
      to.mode = "free";
      this.write([], [to]);
      for (const it of to.items) this.own.items[it.path] = this.stamp<ItemRec>(itemRec(it));
    }
    for (const d of done) {
      if (!copy) this.tombstone(d.from);
      this.own.items[d.to] = this.stamp<ItemRec>(d.rec);
    }
    await this.flush();
    await this.reload(true);
    const verb = copy ? "Copied" : "Moved";
    const undo = async () => {
      for (const d of done) {
        if (copy) continue; // copies are left on disk; undo only forgets the layout
        try {
          const back = await this.backend.moveImage(d.to, d.fromFolder, false);
          this.tombstone(d.to);
          this.own.items[back] = this.stamp<ItemRec>({ ...d.rec, moved: true, x: undefined, y: undefined });
        } catch (e) {
          this.onNotice(`Couldn't move ${d.to} back. ${String(e)}`);
        }
      }
      await this.flush();
      await this.reload(true);
    };
    const redo = async () => {
      await this.moveFiles(done.map((d) => this.board.items.get(d.from)).filter((x): x is ItemNode => !!x), to, copy, dropAt);
    };
    this.push({ label: verb, undo, redo });
    this.onNotice(`${verb} ${done.length === 1 ? items[0].img.name : `${done.length} images`} to ${to.name || "the board folder"}.`, () => void this.undo());
  }

  async createFolder(parent: GroupNode, name: string) {
    try {
      await this.backend.createFolder(parent.path, name);
      await this.reload(true);
    } catch (e) {
      this.onNotice(String(e));
    }
  }

  /** Rescan the disk and merge everyone's layout again. */
  async reload(keepCamera: boolean) {
    await this.flush();
    const payload = await this.backend.rescan();
    this.clock = Math.max(this.clock, payload.layout.clock);
    this.people = payload.layout.people;
    this.missing = Object.keys(payload.layout.missing).length;
    // Keep this device's unsaved view of its own document.
    this.own = { ...payload.own, items: { ...payload.own.items, ...this.own.items }, groups: { ...payload.own.groups, ...this.own.groups } };
    const seen = new Set(this.board.items.keys());
    const prev = this.board;
    this.board = buildBoard(payload.scan, payload.layout, seen, prev);
    // New-file dots that were showing stay until the board is reopened.
    for (const it of this.board.items.values()) if (prev.items.get(it.path)?.isNew) it.isNew = true;
    layoutBoard(this.board);
    this.markSeen();
    this.persistUnplaced();
    this.onBoard(this.board, keepCamera);
  }
}
