import {
  type Board, type GroupNode, type ItemNode, HEADER, PAD, boardBounds, freeze, groupAt, isAncestor,
  itemAt, layoutBoard, matchesQuery, placeItemWorld
} from "../lib/board.js";
import type { Loader } from "./textures";
import { TextureStore } from "./textures.js";
import { type Camera, type RGBA, MODE_ATLAS, MODE_DOT, MODE_SINGLE, MODE_SOLID, Renderer, parseColor } from "./renderer.js";

// The interactive canvas: camera, culling, level of detail, picking, dragging,
// and the thin DOM layer on top (folder names, selection handles). React owns
// the chrome around it; this class owns everything inside the canvas.

export interface SceneEvents {
  /** Layout changed for these images/boxes (persist + push undo). */
  edit(change: Change): void;
  /** An image was dropped onto another folder's box. */
  moveFiles(items: ItemNode[], to: GroupNode, copy: boolean, dropAt: { x: number; y: number }): void;
  openViewer(item: ItemNode): void;
  contextMenu(target: ItemNode | GroupNode | null, screen: { x: number; y: number }): void;
  selectionChanged(count: number): void;
  stats(s: { visible: number; drawCalls: number; fps: number; atlas: number; loading: boolean }): void;
  /** Online-only images still to download in the background. */
  cloudLeft(n: number): void;
  /** Images whose shape was learned from a download and that have stored records. */
  sizesLearned(items: ItemNode[]): void;
}

export interface Snapshot {
  items: Map<ItemNode, Pick<ItemNode, "x" | "y" | "w" | "rot" | "fx" | "fy" | "z">>;
  groups: Map<GroupNode, Pick<GroupNode, "x" | "y" | "w" | "h" | "mode">>;
}

export interface Change {
  before: Snapshot;
  after: Snapshot;
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "items"; sx: number; sy: number; moved: boolean; before: Snapshot; starts: Map<ItemNode, { x: number; y: number }>; frozen: boolean }
  | { kind: "group"; g: GroupNode; sx: number; sy: number; ox: number; oy: number; before: Snapshot; moved: boolean }
  | { kind: "group-resize"; g: GroupNode; before: Snapshot }
  | { kind: "scale"; it: ItemNode; before: Snapshot; d0: number; w0: number }
  | { kind: "rotate"; it: ItemNode; before: Snapshot; a0: number; r0: number }
  | { kind: "marquee"; sx: number; sy: number; additive: boolean };

export function snapshot(items: Iterable<ItemNode>, groups: Iterable<GroupNode>): Snapshot {
  const s: Snapshot = { items: new Map(), groups: new Map() };
  for (const it of items) s.items.set(it, { x: it.x, y: it.y, w: it.w, rot: it.rot, fx: it.fx, fy: it.fy, z: it.z });
  for (const g of groups) s.groups.set(g, { x: g.x, y: g.y, w: g.w, h: g.h, mode: g.mode });
  return s;
}

export function applySnapshot(board: Board, s: Snapshot) {
  for (const [it, v] of s.items) Object.assign(it, v, { unplaced: false });
  for (const [g, v] of s.groups) Object.assign(g, v, { hasRec: true });
  layoutBoard(board);
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name);

export class Scene {
  readonly renderer: Renderer;
  readonly textures: TextureStore;
  board: Board | null = null;
  cam: Camera = { x: 0, y: 0, zoom: 0.2 };
  selection = new Set<ItemNode>();
  query: string[] = [];
  private matches: ItemNode[] = [];
  private drag: Drag | null = null;
  private dropTarget: GroupNode | null = null;
  private dirty = true;
  private raf = 0;
  private space = false;
  private colors = {
    bg: [0, 0, 0, 1] as RGBA,
    boxes: [] as RGBA[],
    placeholder: [0, 0, 0, 1] as RGBA,
    accent: [0, 0, 0, 1] as RGBA,
    accentSoft: [0, 0, 0, 1] as RGBA,
    offline: [0, 0, 0, 1] as RGBA
  };
  private labels = new Map<GroupNode, HTMLDivElement>();
  private selBox: HTMLDivElement;
  private marquee: HTMLDivElement;
  private frames: number[] = [];
  private lastBackground = 0;
  private ro: ResizeObserver;
  private disposed = false;
  private listeners = new AbortController();
  private resized = new Set<ItemNode>();
  private resizeTimer = 0;
  private lastCloudLeft = -1;

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
    private overlay: HTMLElement,
    load: Loader,
    private events: SceneEvents
  ) {
    this.renderer = new Renderer(canvas);
    this.textures = new TextureStore(this.renderer.gl, load);
    this.textures.onChange = () => this.invalidate();
    this.textures.isCloud = (p) => this.board?.items.get(p)?.img.onlineOnly ?? false;
    this.textures.onSize = (p, w, h, exact) => this.learnSize(p, w, h, exact);
    this.selBox = this.el("div", "sel");
    this.selBox.innerHTML = '<span class="sel-handle" data-handle="scale"></span><span class="sel-rotate" data-handle="rotate"></span>';
    this.marquee = this.el("div", "marquee");
    this.readColors();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.bindInput();
  }

  private el(tag: string, cls: string) {
    const e = document.createElement(tag) as HTMLDivElement;
    e.className = cls;
    e.hidden = true;
    this.overlay.appendChild(e);
    return e;
  }

  /** A file that was online-only at scan time has arrived: give it its real
   *  shape. Layout is redone at most a few times a second while downloads run,
   *  and never in the middle of a drag. */
  private learnSize(path: string, w: number, h: number, exact: boolean) {
    const it = this.board?.items.get(path);
    if (!it || w <= 0 || h <= 0) return;
    if (exact) {
      it.img.width = w;
      it.img.height = h;
      it.img.onlineOnly = false;
    } else if (it.img.width > 0) {
      return; // the scan already knew; a thumbnail's rounding is no better
    }
    const aspect = w / h;
    if (Math.abs(aspect - it.aspect) / it.aspect < 0.01) return;
    it.aspect = aspect;
    this.resized.add(it);
    if (!this.resizeTimer) this.resizeTimer = window.setTimeout(() => this.applySizes(), 400);
  }

  private applySizes() {
    this.resizeTimer = 0;
    if (this.disposed || !this.board || !this.resized.size) return;
    if (this.drag) {
      this.resizeTimer = window.setTimeout(() => this.applySizes(), 400);
      return;
    }
    const items = [...this.resized].filter((it) => this.board!.items.get(it.path) === it);
    this.resized.clear();
    layoutBoard(this.board);
    this.invalidate();
    const stored = items.filter((it) => it.group.mode === "free");
    if (stored.length) this.events.sizesLearned(stored);
  }

  /** Stop or resume background downloads of online-only files. */
  setCloudPaused(paused: boolean) {
    this.textures.cloudPaused = paused;
    this.invalidate();
  }

  readColors() {
    this.colors = {
      bg: parseColor(css("--ui-bg")),
      boxes: [parseColor(css("--ui-surface-1")), parseColor(css("--ui-surface-2")), parseColor(css("--ui-surface-3"))],
      placeholder: parseColor(css("--ui-surface-hover")),
      accent: parseColor(css("--ui-accent")),
      accentSoft: parseColor(css("--ui-accent"), 0.16),
      offline: parseColor(css("--ui-border"))
    };
    this.invalidate();
  }

  setBoard(board: Board, keepCamera: boolean) {
    const paths = new Set(board.items.keys());
    this.textures.reserve(board.items.size);
    this.textures.retain(paths);
    const old = new Set([...this.selection].map((it) => it.path));
    this.board = board;
    this.selection = new Set([...old].map((p) => board.items.get(p)).filter((x): x is ItemNode => !!x));
    for (const [g, label] of this.labels) {
      if (!board.groups.has(g.path) || board.groups.get(g.path) !== g) {
        label.remove();
        this.labels.delete(g);
      }
    }
    this.setQuery(this.query.join(" "));
    if (!keepCamera) this.fit();
    this.lastBackground = 0;
    this.invalidate();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- camera ----------

  toWorld(sx: number, sy: number) {
    return { x: this.cam.x + sx / this.cam.zoom, y: this.cam.y + sy / this.cam.zoom };
  }

  private fly(x: number, y: number, w: number, h: number, margin = 0.08) {
    const vw = this.renderer.width;
    const vh = this.renderer.height;
    const zoom = Math.min(8, Math.max(0.005, Math.min(vw / (w * (1 + margin * 2)), vh / (h * (1 + margin * 2)))));
    this.cam = { zoom, x: x + w / 2 - vw / 2 / zoom, y: y + h / 2 - vh / 2 / zoom };
    this.invalidate();
  }

  fit() {
    if (!this.board) return;
    const b = boardBounds(this.board);
    this.fly(b.x, b.y, b.w, b.h, 0.03);
  }

  fitGroup(g: GroupNode) {
    this.fly(g.wx, g.wy, g.w, g.h, 0.04);
  }

  fitItems(items: ItemNode[]) {
    if (!items.length) return this.fit();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      x0 = Math.min(x0, it.minX); y0 = Math.min(y0, it.minY);
      x1 = Math.max(x1, it.maxX); y1 = Math.max(y1, it.maxY);
    }
    this.fly(x0, y0, x1 - x0, y1 - y0, items.length === 1 ? 0.06 : 0.1);
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toWorld(sx, sy);
    this.cam.zoom = Math.min(8, Math.max(0.005, this.cam.zoom * factor));
    this.cam.x = before.x - sx / this.cam.zoom;
    this.cam.y = before.y - sy / this.cam.zoom;
    this.invalidate();
  }

  // ---------- search ----------

  setQuery(q: string) {
    this.query = q.toLowerCase().split(/\s+/).filter(Boolean);
    this.matches = this.board && this.query.length ? this.board.drawItems.filter((it) => matchesQuery(it, this.query)) : [];
    this.invalidate();
    return this.matches.length;
  }

  private matchIndex = -1;
  nextMatch(step: number) {
    if (!this.matches.length) return null;
    this.matchIndex = (this.matchIndex + step + this.matches.length) % this.matches.length;
    const it = this.matches[this.matchIndex];
    this.select([it]);
    this.fitItems([it]);
    return { index: this.matchIndex, total: this.matches.length };
  }

  // ---------- selection ----------

  select(items: ItemNode[], additive = false) {
    if (!additive) this.selection.clear();
    for (const it of items) this.selection.add(it);
    this.events.selectionChanged(this.selection.size);
    this.invalidate();
  }

  // ---------- frame ----------

  private frame(t: number) {
    this.raf = 0;
    if (this.disposed) return;
    this.frames.push(t);
    while (this.frames.length && t - this.frames[0] > 1000) this.frames.shift();
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.textures.pump();
    if (this.textures.busy) setTimeout(() => this.invalidate(), 120);
  }

  private draw() {
    const r = this.renderer;
    const board = this.board;
    r.begin();
    this.textures.beginFrame();
    if (!board) {
      r.flush(this.cam, this.colors.bg);
      return;
    }
    const { cam } = this;
    const vx0 = cam.x;
    const vy0 = cam.y;
    const vx1 = cam.x + r.width / cam.zoom;
    const vy1 = cam.y + r.height / cam.zoom;
    const px = 1 / cam.zoom; // one css pixel in world units

    // Folder boxes (parents first). Tint steps by depth, no outlines.
    for (const g of board.drawGroups) {
      if (g.wx > vx1 || g.wy > vy1 || g.wx + g.w < vx0 || g.wy + g.h < vy0) continue;
      if (g.w * cam.zoom < 2) continue;
      const color = this.colors.boxes[Math.min(g.depth, 2)];
      const radius = Math.min(6 * px, g.w / 2, g.h / 2);
      r.push(g.wx + g.w / 2, g.wy + g.h / 2, g.w / 2, g.h / 2, 0, false, false, null, 0, MODE_SOLID, color, radius);
      if (g === this.dropTarget) {
        r.push(g.wx + g.w / 2, g.wy + g.h / 2, g.w / 2, g.h / 2, 0, false, false, null, 0, MODE_SOLID, this.colors.accentSoft, radius);
      }
    }

    // Images: cull, choose a level of detail, request what is missing.
    const dpr = r.dpr;
    const dim = this.query.length > 0;
    let visible = 0;
    const center = { x: (vx0 + vx1) / 2, y: (vy0 + vy1) / 2 };
    const dotR = 4 * px;
    const dots: ItemNode[] = [];
    for (const it of board.drawItems) {
      if (it.minX > vx1 || it.minY > vy1 || it.maxX < vx0 || it.maxY < vy0) continue;
      visible += 1;
      const screen = Math.max(it.ww, it.wh) * cam.zoom * dpr;
      const alpha = dim && !matchesQuery(it, this.query) ? 0.14 : 1;
      const cx = it.wx + it.ww / 2;
      const cy = it.wy + it.wh / 2;
      const rot = (it.rot * Math.PI) / 180;
      const dist = Math.hypot(cx - center.x, cy - center.y) * cam.zoom;
      const prio = screen - dist * 0.02;
      const want = screen > 300 ? "1024" : screen > 72 ? "256" : null;
      let tex: WebGLTexture | null = null;
      if (want) {
        tex = this.textures.single(it.path, want);
        if (!tex) {
          this.textures.want(it.path, want, prio);
          tex = want === "1024" ? this.textures.single(it.path, "256") : null;
        }
      }
      const radius = Math.min(2 * px, it.ww / 4);
      if (tex) {
        r.push(cx, cy, it.ww / 2, it.wh / 2, rot, it.fx, it.fy, null, 0, MODE_SINGLE, [1, 1, 1, alpha], radius, tex);
      } else {
        const slot = this.textures.atlas.get(it.path);
        if (slot) {
          r.push(cx, cy, it.ww / 2, it.wh / 2, rot, it.fx, it.fy, slot.uv, slot.layer, MODE_ATLAS, [1, 1, 1, alpha], radius);
        } else {
          this.textures.want(it.path, "atlas", prio - 1000);
          const c = it.img.onlineOnly ? this.colors.offline : this.colors.placeholder;
          r.push(cx, cy, it.ww / 2, it.wh / 2, rot, false, false, null, 0, MODE_SOLID, [c[0], c[1], c[2], alpha], radius);
        }
      }
      if (it.isNew && it.ww * cam.zoom > 28) dots.push(it);
    }
    // Unread dots for images that are new since this computer last opened the board.
    for (const it of dots) {
      r.push(it.wx + it.ww - dotR * 2.5, it.wy + dotR * 2.5, dotR, dotR, 0, false, false, null, 0, MODE_DOT, this.colors.accent, 0);
    }
    r.atlasTex = this.textures.atlasTex;
    r.flush(cam, this.colors.bg);

    // Background fill: re-rank the rest of the board by distance every so often.
    const now = performance.now();
    if (now - this.lastBackground > 700) {
      this.lastBackground = now;
      const order = board.drawItems
        .filter((it) => !this.textures.atlas.has(it.path))
        .map((it) => ({ p: it.path, d: Math.hypot(it.wx - center.x, it.wy - center.y) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => x.p);
      this.textures.setBackground(order);
    }
    const left = this.textures.cloudLeft;
    if (left !== this.lastCloudLeft) {
      this.lastCloudLeft = left;
      this.events.cloudLeft(left);
    }

    this.drawOverlay(vx0, vy0, vx1, vy1);
    const fps = this.frames.length;
    this.events.stats({ visible, drawCalls: r.drawCalls, fps, atlas: this.textures.atlas.size, loading: this.textures.busy });
  }

  private drawOverlay(vx0: number, vy0: number, vx1: number, vy1: number) {
    const board = this.board!;
    const { zoom } = this.cam;
    const seen = new Set<GroupNode>();
    // Folder names. When headers are too small to hold them, names float as
    // small tags; a tag is skipped if it would cover one already placed.
    const roomy = HEADER * zoom >= 18;
    const placed: { x: number; y: number; w: number }[] = [];
    for (const g of board.drawGroups) {
      if (g.wx > vx1 || g.wy > vy1 || g.wx + g.w < vx0 || g.wy + g.h < vy0) continue;
      const sw = g.w * zoom;
      if (sw < (roomy ? 60 : 110) || g.h * zoom < 40) continue;
      const sx = Math.max(4, (g.wx + PAD - this.cam.x) * zoom);
      const sy = Math.max(4, (g.wy - this.cam.y) * zoom + (roomy ? (HEADER * zoom - 20) / 2 : 4));
      const tagW = Math.min(sw - 8, 8 + (g.name.length + 4) * 7.5);
      if (!roomy && placed.some((r) => Math.abs(r.y - sy) < 24 && sx < r.x + r.w && r.x < sx + tagW)) continue;
      placed.push({ x: sx, y: sy, w: tagW });
      seen.add(g);
      let label = this.labels.get(g);
      if (!label) {
        label = document.createElement("div");
        label.className = "group-label";
        label.innerHTML = '<span class="name"></span><span class="count"></span>';
        this.overlay.appendChild(label);
        this.labels.set(g, label);
      }
      (label.firstChild as HTMLElement).textContent = g.name;
      (label.lastChild as HTMLElement).textContent = g.total.toLocaleString();
      label.style.transform = `translate(${sx}px, ${sy}px)`;
      label.style.maxWidth = `${Math.max(0, sw - 8)}px`;
      label.classList.toggle("tag", !roomy);
      label.hidden = false;
    }
    for (const [g, label] of this.labels) if (!seen.has(g)) label.hidden = true;

    // Selection: one outline per image; handles when exactly one is selected.
    const sel = [...this.selection];
    this.overlay.querySelectorAll(".sel-extra").forEach((e) => e.remove());
    this.selBox.hidden = sel.length === 0;
    sel.forEach((it, i) => {
      const box = i === 0 ? this.selBox : (this.overlay.appendChild(document.createElement("div")) as HTMLDivElement);
      if (i > 0) box.className = "sel sel-extra";
      const w = it.ww * zoom;
      const h = it.wh * zoom;
      const sx = (it.wx - this.cam.x) * zoom;
      const sy = (it.wy - this.cam.y) * zoom;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.style.transform = `translate(${sx}px, ${sy}px) rotate(${it.rot}deg)`;
      box.classList.toggle("single", sel.length === 1 && w > 24);
    });
  }

  // ---------- input ----------

  private local(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindInput() {
    const host = this.host;
    const signal = this.listeners.signal;
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false, signal });
    // Controls floating over the canvas (download status) handle their own clicks.
    const onControl = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.("[data-canvas-control]");
    host.addEventListener("pointerdown", (e) => !onControl(e) && this.onDown(e), { signal });
    host.addEventListener("pointermove", (e) => this.onMove(e), { signal });
    host.addEventListener("pointerup", (e) => this.onUp(e), { signal });
    host.addEventListener("pointercancel", () => { this.drag = null; this.marquee.hidden = true; }, { signal });
    host.addEventListener("dblclick", (e) => this.onDouble(e), { signal });
    host.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!this.board) return;
      const p = this.local(e);
      const w = this.toWorld(p.x, p.y);
      const it = itemAt(this.board, w.x, w.y);
      if (it && !this.selection.has(it)) this.select([it]);
      this.events.contextMenu(it ?? groupAt(this.board, w.x, w.y), { x: e.clientX, y: e.clientY });
    }, { signal });
  }

  setSpace(down: boolean) {
    this.space = down;
    this.host.classList.toggle("panning", down);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    const lineScale = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * lineScale;
    const dy = e.deltaY * lineScale;
    // Pinch arrives as ctrl+wheel; a mouse wheel sends large vertical steps only.
    const mouseWheel = e.deltaMode === 1 || (dx === 0 && Math.abs(dy) >= 40 && Number.isInteger(dy));
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      this.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)));
    } else {
      this.cam.x += dx / this.cam.zoom;
      this.cam.y += dy / this.cam.zoom;
      this.invalidate();
    }
  }

  private onDown(e: PointerEvent) {
    if (!this.board) return;
    const p = this.local(e);
    const w = this.toWorld(p.x, p.y);
    const handle = (e.target as HTMLElement).dataset?.handle;
    this.host.setPointerCapture(e.pointerId);
    if (e.button === 1 || this.space || (e.button === 0 && e.altKey && e.shiftKey)) {
      this.drag = { kind: "pan", sx: p.x, sy: p.y, cx: this.cam.x, cy: this.cam.y };
      return;
    }
    if (e.button !== 0) return;
    const single = this.selection.size === 1 ? [...this.selection][0] : null;
    if (single && handle) {
      const cx = single.wx + single.ww / 2;
      const cy = single.wy + single.wh / 2;
      this.freezeFor(single.group);
      const before = snapshot([single], []);
      if (handle === "scale") this.drag = { kind: "scale", it: single, before, d0: Math.hypot(w.x - cx, w.y - cy), w0: single.w };
      else this.drag = { kind: "rotate", it: single, before, a0: Math.atan2(w.y - cy, w.x - cx), r0: single.rot };
      return;
    }
    const it = itemAt(this.board, w.x, w.y);
    if (it) {
      if (e.shiftKey || e.metaKey) {
        if (this.selection.has(it)) this.selection.delete(it);
        else this.selection.add(it);
        this.events.selectionChanged(this.selection.size);
      } else if (!this.selection.has(it)) this.select([it]);
      const items = [...this.selection];
      const groups = new Set(items.map((x) => x.group));
      this.drag = {
        kind: "items", sx: w.x, sy: w.y, moved: false, frozen: false,
        before: snapshot(items, groups),
        starts: new Map(items.map((x) => [x, { x: x.x, y: x.y }]))
      };
      this.invalidate();
      return;
    }
    const g = groupAt(this.board, w.x, w.y);
    if (g && g.parent) {
      const corner = (g.wx + g.w - w.x) * this.cam.zoom < 18 && (g.wy + g.h - w.y) * this.cam.zoom < 18;
      if (corner) {
        this.drag = { kind: "group-resize", g, before: snapshot(g.items, [g, ...g.children]) };
        return;
      }
      if (w.y - g.wy < HEADER) {
        this.drag = { kind: "group", g, sx: w.x, sy: w.y, ox: g.x, oy: g.y, before: snapshot([], [g.parent, ...g.parent.children]), moved: false };
        return;
      }
    }
    this.drag = { kind: "marquee", sx: p.x, sy: p.y, additive: e.shiftKey || e.metaKey };
  }

  /** Dragging inside an Auto box turns it into a Free box, keeping positions. */
  private freezeFor(g: GroupNode) {
    if (g.mode === "free") return;
    freeze(g);
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || !this.board) return;
    const p = this.local(e);
    const w = this.toWorld(p.x, p.y);
    switch (d.kind) {
      case "pan":
        this.cam.x = d.cx - (p.x - d.sx) / this.cam.zoom;
        this.cam.y = d.cy - (p.y - d.sy) / this.cam.zoom;
        break;
      case "items": {
        const dx = w.x - d.sx;
        const dy = w.y - d.sy;
        if (!d.moved && Math.hypot(dx, dy) * this.cam.zoom < 4) return;
        if (!d.frozen) {
          d.frozen = true;
          for (const it of d.starts.keys()) this.freezeFor(it.group);
          // Bring to front inside each box.
          for (const it of d.starts.keys()) it.z = Math.max(0, ...it.group.items.map((x) => x.z)) + 1;
          layoutBoard(this.board);
        }
        d.moved = true;
        for (const [it, s] of d.starts) {
          it.x = s.x + dx;
          it.y = s.y + dy;
          placeItemWorld(it);
        }
        const target = groupAt(this.board, w.x, w.y);
        const first = d.starts.keys().next().value as ItemNode;
        this.dropTarget = target && target !== first.group ? target : null;
        break;
      }
      case "group": {
        const g = d.g;
        if (!d.moved && Math.hypot(w.x - d.sx, w.y - d.sy) * this.cam.zoom < 4) return;
        if (!d.moved && g.parent) this.freezeFor(g.parent);
        d.moved = true;
        g.x = d.ox + (w.x - d.sx);
        g.y = d.oy + (w.y - d.sy);
        layoutBoard(this.board);
        break;
      }
      case "group-resize": {
        const g = d.g;
        g.w = Math.max(240, w.x - g.wx);
        g.h = Math.max(HEADER + 60, w.y - g.wy);
        g.hasRec = true;
        layoutBoard(this.board);
        break;
      }
      case "scale": {
        const it = d.it;
        const cx = it.wx + it.ww / 2;
        const cy = it.wy + it.wh / 2;
        const lx = it.x + it.w / 2;
        const ly = it.y + it.w / it.aspect / 2;
        it.w = Math.max(16, d.w0 * (Math.hypot(w.x - cx, w.y - cy) / Math.max(1, d.d0)));
        it.x = lx - it.w / 2;
        it.y = ly - it.w / it.aspect / 2;
        placeItemWorld(it);
        break;
      }
      case "rotate": {
        const it = d.it;
        const cx = it.wx + it.ww / 2;
        const cy = it.wy + it.wh / 2;
        let rot = d.r0 + ((Math.atan2(w.y - cy, w.x - cx) - d.a0) * 180) / Math.PI;
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        it.rot = ((rot % 360) + 540) % 360 - 180;
        placeItemWorld(it);
        break;
      }
      case "marquee": {
        const x = Math.min(d.sx, p.x), y = Math.min(d.sy, p.y);
        Object.assign(this.marquee.style, { transform: `translate(${x}px, ${y}px)`, width: `${Math.abs(p.x - d.sx)}px`, height: `${Math.abs(p.y - d.sy)}px` });
        this.marquee.hidden = Math.hypot(p.x - d.sx, p.y - d.sy) < 4;
        return;
      }
    }
    this.invalidate();
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (!d || !this.board) return;
    const p = this.local(e);
    const board = this.board;
    const emit = (before: Snapshot) => {
      layoutBoard(board);
      const after = snapshot(before.items.keys(), before.groups.keys());
      this.events.edit({ before, after });
    };
    switch (d.kind) {
      case "items": {
        if (!d.moved) {
          if (!(e.shiftKey || e.metaKey)) {
            const w = this.toWorld(p.x, p.y);
            const it = itemAt(board, w.x, w.y);
            if (it) this.select([it]);
          }
          break;
        }
        const target = this.dropTarget;
        this.dropTarget = null;
        const items = [...d.starts.keys()];
        if (target && items.every((it) => it.group !== target)) {
          const w = this.toWorld(p.x, p.y);
          applySnapshot(board, d.before);
          this.events.moveFiles(items, target, e.altKey, w);
          break;
        }
        // Include every box whose size may have grown.
        for (const it of items) for (let g: GroupNode | null = it.group; g; g = g.parent) if (!d.before.groups.has(g)) d.before.groups.set(g, { x: g.x, y: g.y, w: g.w, h: g.h, mode: g.mode });
        emit(d.before);
        break;
      }
      case "group":
        if (d.moved) emit(d.before);
        break;
      case "group-resize":
      case "scale":
      case "rotate":
        emit(d.before);
        break;
      case "marquee": {
        this.marquee.hidden = true;
        const a = this.toWorld(Math.min(d.sx, p.x), Math.min(d.sy, p.y));
        const b = this.toWorld(Math.max(d.sx, p.x), Math.max(d.sy, p.y));
        if (Math.hypot(p.x - d.sx, p.y - d.sy) < 4) {
          if (!d.additive) this.select([]);
          break;
        }
        const hits = board.drawItems.filter((it) => it.maxX >= a.x && it.minX <= b.x && it.maxY >= a.y && it.minY <= b.y);
        this.select(hits, d.additive);
        break;
      }
    }
    this.invalidate();
  }

  private onDouble(e: MouseEvent) {
    if (!this.board) return;
    const p = this.local(e);
    const w = this.toWorld(p.x, p.y);
    const it = itemAt(this.board, w.x, w.y);
    if (it) return this.events.openViewer(it);
    const g = groupAt(this.board, w.x, w.y);
    if (g && w.y - g.wy < HEADER) this.fitGroup(g);
  }

  /** Apply a transform to the selection (flip, reset, ...) as one undoable edit. */
  transformSelection(fn: (it: ItemNode) => void) {
    if (!this.board || !this.selection.size) return;
    const items = [...this.selection];
    for (const it of items) this.freezeFor(it.group);
    const before = snapshot(items, new Set(items.map((i) => i.group)));
    for (const it of items) fn(it);
    layoutBoard(this.board);
    this.events.edit({ before, after: snapshot(before.items.keys(), before.groups.keys()) });
    this.invalidate();
  }

  isInside(g: GroupNode, target: GroupNode) {
    return isAncestor(g, target);
  }

  dispose() {
    this.disposed = true;
    this.listeners.abort();
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.clearTimeout(this.resizeTimer);
    this.textures.dispose();
    this.overlay.innerHTML = "";
  }
}
