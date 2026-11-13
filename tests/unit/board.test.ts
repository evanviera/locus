import { describe, expect, it } from "vitest";
import { justify, shelf } from "../../src/lib/pack";
import { buildBoard, freeze, layoutBoard, itemRec, type Board } from "../../src/lib/board";
import type { MergedLayout, ScanResult } from "../../src/types";

const emptyLayout: MergedLayout = { clock: 0, items: {}, groups: {}, missing: {}, moved: [], people: 1 };

function scan(): ScanResult {
  const images = [] as ScanResult["images"];
  const add = (folder: string, n: number, w = 1600, h = 900) => {
    for (let i = 0; i < n; i += 1) {
      const name = `img ${i}.jpg`;
      images.push({ path: folder ? `${folder}/${name}` : name, folder, name, ext: "jpg", size: 1000 + i, mtime: 0, width: w, height: h, fileId: `${folder}-${i}`, onlineOnly: false });
    }
  };
  add("", 3);
  add("a", 20);
  add("a/b", 7, 900, 1600);
  add("c", 12);
  return {
    root: "/r",
    folders: [
      { path: "", name: "root", parent: null },
      { path: "a", name: "a", parent: "" },
      { path: "a/b", name: "b", parent: "a" },
      { path: "c", name: "c", parent: "" }
    ],
    images,
    elapsedMs: 0
  };
}

function overlaps(board: Board) {
  for (const g of board.groups.values()) {
    for (let i = 0; i < g.children.length; i += 1) {
      for (let j = i + 1; j < g.children.length; j += 1) {
        const a = g.children[i], b = g.children[j];
        if (a.wx < b.wx + b.w && b.wx < a.wx + a.w && a.wy < b.wy + b.h && b.wy < a.wy + a.h) return true;
      }
    }
  }
  return false;
}

describe("justify", () => {
  it("fills full rows exactly and keeps aspect ratios", () => {
    const r = justify([1.5, 1, 0.66, 2, 1.5, 1], 1000, 200, 10);
    const firstRow = r.boxes.filter((b) => b.y === 0);
    const right = Math.max(...firstRow.map((b) => b.x + b.w));
    expect(right).toBeCloseTo(1000, 3);
    r.boxes.forEach((b, i) => expect(b.w / b.h).toBeCloseTo([1.5, 1, 0.66, 2, 1.5, 1][i], 5));
  });
  it("handles no images", () => {
    expect(justify([], 500, 200, 10).height).toBe(0);
  });
});

describe("shelf", () => {
  it("wraps at the width without overlaps", () => {
    const r = shelf([{ w: 300, h: 100 }, { w: 300, h: 200 }, { w: 300, h: 50 }], 650, 10);
    expect(r.boxes[2]).toMatchObject({ x: 0, y: 210 });
    expect(r.height).toBe(260);
  });
});

describe("board", () => {
  it("nests folders as boxes and contains every image in its box", () => {
    const board = buildBoard(scan(), emptyLayout, null);
    expect(board.items.size).toBe(42);
    expect(board.groups.get("a/b")!.parent!.path).toBe("a");
    expect(board.root.total).toBe(42);
    for (const it of board.items.values()) {
      const g = it.group;
      expect(it.wx).toBeGreaterThanOrEqual(g.wx - 0.01);
      expect(it.wy + it.wh).toBeLessThanOrEqual(g.wy + g.h + 0.01);
      expect(it.wx + it.ww).toBeLessThanOrEqual(g.wx + g.w + 0.01);
    }
    expect(overlaps(board)).toBe(false);
  });

  it("restores stored Free placements and places newcomers below them", () => {
    const first = buildBoard(scan(), emptyLayout, null);
    const g = first.groups.get("c")!;
    freeze(g);
    const moved = first.items.get("c/img 0.jpg")!;
    moved.x = 900;
    moved.y = 40;
    moved.rot = 30;
    layoutBoard(first);
    const layout: MergedLayout = {
      ...emptyLayout,
      groups: { c: { x: g.x, y: g.y, w: g.w, h: g.h, mode: "free", t: 1, by: "x" } },
      items: Object.fromEntries([...g.items].filter((it) => it.path !== "c/img 11.jpg").map((it) => [it.path, { ...itemRec(it), t: 1, by: "x" }]))
    };
    const second = buildBoard(scan(), layout, new Set(first.items.keys()));
    const again = second.items.get("c/img 0.jpg")!;
    expect(again.x).toBe(900);
    expect(again.rot).toBe(30);
    const newcomer = second.items.get("c/img 11.jpg")!;
    const maxBottom = Math.max(...[...second.groups.get("c")!.items].filter((i) => i !== newcomer).map((i) => i.y + i.w / i.aspect));
    expect(newcomer.y).toBeGreaterThan(maxBottom);
    expect(newcomer.autoPlaced).toBe(true);
  });

  it("marks files not seen before as new", () => {
    const seen = new Set(["a/img 0.jpg"]);
    const board = buildBoard(scan(), emptyLayout, seen);
    expect(board.items.get("a/img 0.jpg")!.isNew).toBe(false);
    expect(board.items.get("a/img 1.jpg")!.isNew).toBe(true);
  });
});

describe("rescans while images download", () => {
  it("keep learned shapes and box widths, so nothing jumps", () => {
    const s = scan();
    // Folder c is online-only: sizes unknown at scan time.
    for (const img of s.images) if (img.folder === "c") Object.assign(img, { width: 0, height: 0, onlineOnly: true });
    const first = buildBoard(s, emptyLayout, null);
    const c = first.items.get("c/img 0.jpg")!;
    expect(c.aspect).toBe(1);
    // A download teaches the board the real shape; boxes keep their width.
    for (const it of first.groups.get("c")!.items) it.aspect = 16 / 9;
    for (const g of first.groups.values()) if (!g.hasRec) g.keepW = g.w;
    layoutBoard(first);
    const widths = new Map([...first.groups.values()].map((g) => [g.path, g.w]));
    const pos = { x: first.items.get("a/img 3.jpg")!.wx, y: first.items.get("a/img 3.jpg")!.wy };

    // The sync app touches files, a rescan runs, the files are still online-only.
    const again = buildBoard(scan_withCloud(), emptyLayout, null, first);
    expect(again.items.get("c/img 0.jpg")!.aspect).toBeCloseTo(16 / 9);
    for (const g of again.groups.values()) expect(g.w).toBe(widths.get(g.path));
    expect(again.items.get("a/img 3.jpg")!.wx).toBe(pos.x);
    expect(again.items.get("a/img 3.jpg")!.wy).toBe(pos.y);
  });
});

function scan_withCloud() {
  const s = scan();
  for (const img of s.images) if (img.folder === "c") Object.assign(img, { width: 0, height: 0, onlineOnly: true });
  return s;
}
