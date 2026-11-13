import type { GroupMode, GroupRec, ImageEntry, ItemRec, MergedLayout, ScanResult } from "../types";
import { justify, shelf } from "./pack.js";

// The board model: one box per folder, nested like the folder tree, and one
// item per image inside its folder's box. Positions are stored relative to the
// parent box so moving a box moves everything in it.

export const HEADER = 44;
export const PAD = 20;
export const GAP = 10;
export const ROW_H = 220;
export const CHILD_GAP = 28;

export interface ItemNode {
  path: string;
  img: ImageEntry;
  group: GroupNode;
  aspect: number;
  /** Local position (top-left, relative to the group's content origin) and width. */
  x: number;
  y: number;
  w: number;
  rot: number;
  fx: boolean;
  fy: boolean;
  z: number;
  /** Needs a spot in a Free box (new file, or moved here on disk). */
  unplaced: boolean;
  /** World geometry, recomputed by `layoutBoard`. */
  wx: number;
  wy: number;
  ww: number;
  wh: number;
  /** Axis-aligned bounds of the rotated image, for culling and hit tests. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  isNew: boolean;
  /** Placed by the app (not by a person) during the last layout; saved so teammates agree. */
  autoPlaced?: boolean;
  /** Index in the draw order. */
  order: number;
}

export interface GroupNode {
  path: string;
  name: string;
  parent: GroupNode | null;
  children: GroupNode[];
  items: ItemNode[];
  depth: number;
  mode: GroupMode;
  hasRec: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  wx: number;
  wy: number;
  /** Images in this folder and every folder below it. */
  total: number;
  autoPlaced?: boolean;
  /** Width an Auto box keeps for this session, so learning image shapes or a
   *  rescan reflows rows inside it instead of reshaping the whole board. */
  keepW?: number;
}

export interface Board {
  root: GroupNode;
  groups: Map<string, GroupNode>;
  items: Map<string, ItemNode>;
  /** Groups then their items, in paint order. */
  drawGroups: GroupNode[];
  drawItems: ItemNode[];
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** `prev` is the board being replaced (after a rescan): image shapes learned
 *  from downloads and the widths of Auto boxes carry over, so nothing jumps. */
export function buildBoard(scan: ScanResult, layout: MergedLayout, seen: Set<string> | null, prev?: Board): Board {
  const groups = new Map<string, GroupNode>();
  const ensure = (path: string, name: string): GroupNode => {
    let g = groups.get(path);
    if (!g) {
      g = {
        path, name, parent: null, children: [], items: [], depth: 0, mode: "auto", hasRec: false,
        x: 0, y: 0, w: 0, h: 0, wx: 0, wy: 0, total: 0
      };
      groups.set(path, g);
    }
    return g;
  };
  for (const f of scan.folders) ensure(f.path, f.name);
  for (const f of scan.folders) {
    if (f.parent === null) continue;
    const g = groups.get(f.path)!;
    const parent = groups.get(f.parent) ?? ensure(f.parent, f.parent.split("/").pop() || f.parent);
    g.parent = parent;
    parent.children.push(g);
  }
  const root = groups.get("") ?? ensure("", "Board");

  for (const [path, rec] of Object.entries(layout.groups)) {
    const g = groups.get(path);
    if (!g) continue;
    g.mode = rec.mode === "free" ? "free" : "auto";
    g.x = rec.x;
    g.y = rec.y;
    g.w = rec.w;
    g.h = rec.h;
    g.hasRec = true;
  }

  const items = new Map<string, ItemNode>();
  for (const img of scan.images) {
    const g = groups.get(img.folder) ?? groups.get(parentOf(img.path)) ?? root;
    const rec: ItemRec | undefined = layout.items[img.path];
    const before = prev?.items.get(img.path);
    const learned = !img.width && before && before.aspect !== 1 ? before.aspect : 0;
    const iw = img.width || rec?.iw || learned || 1;
    const ih = img.height || rec?.ih || 1;
    const placed = rec && rec.x !== undefined && rec.y !== undefined && !rec.moved;
    const item: ItemNode = {
      path: img.path, img, group: g, aspect: iw / ih,
      x: placed ? rec!.x! : 0,
      y: placed ? rec!.y! : 0,
      w: rec?.w ?? ROW_H * (iw / ih),
      rot: rec?.rot ?? 0, fx: rec?.fx ?? false, fy: rec?.fy ?? false, z: rec?.z ?? 0,
      unplaced: !placed,
      wx: 0, wy: 0, ww: 0, wh: 0, minX: 0, minY: 0, maxX: 0, maxY: 0,
      isNew: seen !== null && !seen.has(img.path),
      order: 0
    };
    g.items.push(item);
    items.set(img.path, item);
  }
  if (prev) {
    for (const g of groups.values()) {
      const old = prev.groups.get(g.path);
      if (old && !g.hasRec && old.w > 0) g.keepW = old.w;
    }
  }
  const board: Board = { root, groups, items, drawGroups: [], drawItems: [] };
  setDepths(root, 0);
  layoutBoard(board);
  return board;
}

function setDepths(g: GroupNode, depth: number): number {
  g.depth = depth;
  g.total = g.items.length;
  for (const c of g.children) g.total += setDepths(c, depth + 1);
  return g.total;
}

/** Height of an Auto box's content at a given content width. */
function autoHeight(g: GroupNode, cw: number): number {
  const rows = justify(g.items.map((it) => it.aspect), cw, ROW_H, GAP);
  const top = rows.height > 0 ? rows.height + (g.children.length ? CHILD_GAP : 0) : 0;
  return top + shelf(g.children.map((c) => ({ w: c.w, h: c.h })), cw, CHILD_GAP).height;
}

/** Width for a box laid out for the first time: try a range of widths and keep
 *  the one whose shape is closest to the target (a screen-like 16:10 for the
 *  board, near-square for folders) while wasting the least space. */
function naturalWidth(g: GroupNode): number {
  let area = 0;
  for (const it of g.items) area += it.aspect * ROW_H * ROW_H * 1.15;
  let widest = ROW_H * 2.2;
  for (const c of g.children) {
    area += (c.w + CHILD_GAP) * (c.h + CHILD_GAP);
    widest = Math.max(widest, c.w);
  }
  const target = g.depth === 0 ? 1.6 : 1.2;
  const guess = Math.max(widest, Math.sqrt(area * target));
  if (!g.children.length) return guess;
  let best = guess;
  let bestScore = Infinity;
  const lo = widest;
  const hi = Math.max(lo, guess * 2.2);
  for (let i = 0; i <= 28; i += 1) {
    const cw = lo + ((hi - lo) * i) / 28;
    const h = autoHeight(g, cw);
    const shape = Math.abs(Math.log((cw + PAD * 2) / (h + HEADER + PAD) / target));
    const waste = (cw * h) / Math.max(1, area) - 1;
    const score = shape + Math.max(0, waste) * 0.8;
    if (score < bestScore) {
      bestScore = score;
      best = cw;
    }
  }
  return best;
}

function itemHeight(it: ItemNode) {
  return it.w / it.aspect;
}

/** Size each box bottom-up. Auto boxes reflow their images to the box width and
 *  stack their sub-folders below; Free boxes keep what people placed and only
 *  grow to fit new things. */
function sizeGroup(g: GroupNode) {
  for (const c of g.children) sizeGroup(c);
  if (g.mode === "auto") {
    let cw = g.hasRec ? Math.max(ROW_H, g.w - PAD * 2) : g.keepW ? g.keepW - PAD * 2 : naturalWidth(g);
    for (const c of g.children) cw = Math.max(cw, c.w);
    const rows = justify(g.items.map((it) => it.aspect), cw, ROW_H, GAP);
    g.items.forEach((it, i) => {
      const r = rows.boxes[i];
      it.x = r.x;
      it.y = r.y;
      it.w = r.w;
      it.rot = it.rot || 0;
      it.unplaced = false;
    });
    const top = rows.height > 0 ? rows.height + (g.children.length ? CHILD_GAP : 0) : 0;
    const packed = shelf(g.children.map((c) => ({ w: c.w, h: c.h })), cw, CHILD_GAP);
    g.children.forEach((c, i) => {
      c.x = packed.boxes[i].x;
      c.y = top + packed.boxes[i].y;
    });
    g.w = cw + PAD * 2;
    g.h = HEADER + top + packed.height + PAD;
    return;
  }

  // Free box: content bounds of everything placed, then append newcomers below.
  let maxX = 0;
  let maxY = 0;
  const grow = (x: number, y: number, w: number, h: number) => {
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const it of g.items) if (!it.unplaced) grow(it.x, it.y, it.w, itemHeight(it));
  const newChildren = g.children.filter((c) => !c.hasRec);
  for (const c of g.children) if (c.hasRec) grow(c.x, c.y, c.w, c.h);
  const width = Math.max(g.w - PAD * 2, maxX, ROW_H);
  const unplaced = g.items.filter((it) => it.unplaced);
  if (unplaced.length) {
    const startY = maxY > 0 ? maxY + GAP * 3 : 0;
    const rows = justify(unplaced.map((it) => it.aspect), width, ROW_H, GAP, false);
    unplaced.forEach((it, i) => {
      const r = rows.boxes[i];
      it.x = r.x;
      it.y = startY + r.y;
      it.w = r.w;
      it.unplaced = false;
      it.autoPlaced = true;
      grow(it.x, it.y, it.w, itemHeight(it));
    });
  }
  if (newChildren.length) {
    const startY = maxY > 0 ? maxY + CHILD_GAP : 0;
    const packed = shelf(newChildren.map((c) => ({ w: c.w, h: c.h })), width, CHILD_GAP);
    newChildren.forEach((c, i) => {
      c.x = packed.boxes[i].x;
      c.y = startY + packed.boxes[i].y;
      c.hasRec = true;
      c.autoPlaced = true;
      grow(c.x, c.y, c.w, c.h);
    });
  }
  g.w = Math.max(g.w, maxX + PAD * 2);
  g.h = Math.max(g.h, HEADER + maxY + PAD);
}

export function contentOrigin(g: GroupNode) {
  return { x: g.wx + PAD, y: g.wy + HEADER };
}

export function placeItemWorld(it: ItemNode) {
  const o = contentOrigin(it.group);
  it.wx = o.x + it.x;
  it.wy = o.y + it.y;
  it.ww = it.w;
  it.wh = it.w / it.aspect;
  const cx = it.wx + it.ww / 2;
  const cy = it.wy + it.wh / 2;
  const a = (it.rot * Math.PI) / 180;
  const ex = (Math.abs(Math.cos(a)) * it.ww + Math.abs(Math.sin(a)) * it.wh) / 2;
  const ey = (Math.abs(Math.sin(a)) * it.ww + Math.abs(Math.cos(a)) * it.wh) / 2;
  it.minX = cx - ex;
  it.maxX = cx + ex;
  it.minY = cy - ey;
  it.maxY = cy + ey;
}

function placeWorld(g: GroupNode, board: Board) {
  if (g.parent) {
    const o = contentOrigin(g.parent);
    g.wx = o.x + g.x;
    g.wy = o.y + g.y;
  } else {
    g.wx = g.x;
    g.wy = g.y;
  }
  board.drawGroups.push(g);
  const sorted = g.mode === "free" ? [...g.items].sort((a, b) => a.z - b.z) : g.items;
  for (const it of sorted) {
    placeItemWorld(it);
    it.order = board.drawItems.length;
    board.drawItems.push(it);
  }
  for (const c of g.children) placeWorld(c, board);
}

/** Recompute every box size and every world position. O(images); about a
 *  millisecond for a few thousand. */
export function layoutBoard(board: Board) {
  sizeGroup(board.root);
  board.drawGroups = [];
  board.drawItems = [];
  placeWorld(board.root, board);
}

export function groupRec(g: GroupNode): GroupRec {
  return { x: round(g.x), y: round(g.y), w: round(g.w), h: round(g.h), mode: g.mode };
}

export function itemRec(it: ItemNode): ItemRec {
  return {
    x: round(it.x), y: round(it.y), w: round(it.w),
    rot: round(it.rot), fx: it.fx, fy: it.fy, z: it.z,
    name: it.img.name, size: it.img.size, fileId: it.img.fileId,
    iw: it.img.width || undefined, ih: it.img.height || undefined
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Switch an Auto box to Free, keeping everything exactly where it is. Returns
 *  the boxes and images whose records must be written. */
export function freeze(g: GroupNode): { groups: GroupNode[]; items: ItemNode[] } {
  if (g.mode === "free") return { groups: [], items: [] };
  g.mode = "free";
  g.hasRec = true;
  for (const c of g.children) c.hasRec = true;
  return { groups: [g, ...g.children], items: [...g.items] };
}

/** Back to Auto: images reflow in name order. */
export function tidy(g: GroupNode) {
  g.mode = "auto";
  g.items.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
  for (const it of g.items) {
    it.rot = 0;
    it.fx = false;
    it.fy = false;
  }
}

/** Deepest box whose area contains the point. */
export function groupAt(board: Board, x: number, y: number): GroupNode | null {
  let hit: GroupNode | null = null;
  for (const g of board.drawGroups) {
    if (x >= g.wx && x <= g.wx + g.w && y >= g.wy && y <= g.wy + g.h) {
      if (!hit || g.depth >= hit.depth) hit = g;
    }
  }
  return hit;
}

export function pointInItem(it: ItemNode, x: number, y: number): boolean {
  if (x < it.minX || x > it.maxX || y < it.minY || y > it.maxY) return false;
  if (!it.rot) return true;
  const cx = it.wx + it.ww / 2;
  const cy = it.wy + it.wh / 2;
  const a = (-it.rot * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= it.ww / 2 && Math.abs(ly) <= it.wh / 2;
}

export function itemAt(board: Board, x: number, y: number): ItemNode | null {
  for (let i = board.drawItems.length - 1; i >= 0; i -= 1) {
    const it = board.drawItems[i];
    if (pointInItem(it, x, y)) return it;
  }
  return null;
}

export function isAncestor(a: GroupNode, b: GroupNode | null): boolean {
  for (let g = b; g; g = g.parent) if (g === a) return true;
  return false;
}

export function boardBounds(board: Board) {
  const r = board.root;
  return { x: r.wx, y: r.wy, w: r.w, h: r.h };
}

export function matchesQuery(it: ItemNode, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = `${it.path} ${it.img.ext} ${it.img.width}x${it.img.height} ${it.img.width >= it.img.height ? "landscape" : "portrait"}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
