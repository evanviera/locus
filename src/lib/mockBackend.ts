import type { Backend } from "../ipc";
import type { BoardPayload, Folder, ImageEntry, LayoutDoc, MergedLayout, Tier } from "../types";

// A generated pre-production folder tree, so the canvas can be developed and
// tested in a plain browser. `?n=3000` sets the image count; `?seed=` varies it.
// `?cloud=0.6` makes that share of images online-only: their size is unknown
// until they are "downloaded", which takes longer, like Google Drive.

const SECTIONS: Record<string, string[]> = {
  Characters: ["Hero", "Sidekick", "Villain", "Crowd"],
  Environments: ["Forest", "Harbor town", "Interior"],
  Props: [],
  "Color keys": ["Act 1", "Act 2"],
  Storyboards: ["Seq 010", "Seq 020", "Seq 030"],
  Mood: []
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function buildTree(n: number, seed: number) {
  const rand = rng(seed);
  const folders: Folder[] = [{ path: "", name: "Pre-production", parent: null }];
  const leaves: string[] = [];
  for (const [section, subs] of Object.entries(SECTIONS)) {
    folders.push({ path: section, name: section, parent: "" });
    if (subs.length === 0) leaves.push(section);
    for (const sub of subs) {
      const path = `${section}/${sub}`;
      folders.push({ path, name: sub, parent: section });
      leaves.push(path);
    }
  }
  leaves.push("");
  const weights = leaves.map(() => 0.3 + rand() * 1.7);
  const total = weights.reduce((a, b) => a + b, 0);
  const images: ImageEntry[] = [];
  let i = 0;
  leaves.forEach((folder, li) => {
    const count = li === leaves.length - 1 ? n - i : Math.round((weights[li] / total) * n);
    for (let k = 0; k < count && i < n; k += 1, i += 1) {
      const kind = rand();
      const [width, height] = kind < 0.45 ? [1920, 1080] : kind < 0.7 ? [1200, 1600] : kind < 0.85 ? [1500, 1500] : [2400, 1000];
      const name = `${(folder.split("/").pop() || "ref").toLowerCase().replace(/ /g, "_")}_${String(k + 1).padStart(3, "0")}.jpg`;
      images.push({
        path: folder ? `${folder}/${name}` : name,
        folder,
        name,
        ext: "jpg",
        size: 200_000 + Math.floor(rand() * 4_000_000),
        mtime: Date.now(),
        width,
        height,
        fileId: `mock-${i}`,
        onlineOnly: false
      });
    }
  });
  return { folders, images };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function paint(img: ImageEntry, edge: number): Promise<Blob> {
  const scale = edge / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const r = rng(hash(img.path));
  const hue = Math.floor(r() * 360);
  // brand-ignore: generated stand-in artwork, not UI color
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 45% ${30 + r() * 30}%)`);
  g.addColorStop(1, `hsl(${(hue + 40 + r() * 80) % 360} 50% ${20 + r() * 40}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 6; k += 1) {
    ctx.fillStyle = `hsla(${(hue + r() * 120) % 360} 60% ${40 + r() * 40}% / 0.55)`;
    ctx.beginPath();
    ctx.ellipse(r() * w, r() * h, (0.05 + r() * 0.3) * w, (0.05 + r() * 0.3) * h, r() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = `${Math.max(9, Math.round(h * 0.07))}px sans-serif`;
  ctx.fillText(img.name, w * 0.05, h * 0.92);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

export function mockBackend(): Backend {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const n = Number(params.get("n") ?? 600);
  const seed = Number(params.get("seed") ?? 7);
  let { folders, images } = buildTree(n, seed);
  const cloudShare = Number(params.get("cloud") ?? 0);
  // Real sizes stay here; the scan reports 0×0 for online-only files.
  const real = new Map(images.map((img) => [img.path, { ...img }]));
  if (cloudShare > 0) {
    const pick = rng(seed + 1);
    images = images.map((img) => (pick() < cloudShare ? { ...img, width: 0, height: 0, onlineOnly: true } : img));
  }
  let own: LayoutDoc = { version: 1, device: "browser", clock: 0, items: {}, groups: {} };
  const listeners = new Map<string, Set<(p: string) => void>>();
  const emit = (event: string, payload = "") => listeners.get(event)?.forEach((h) => h(payload));

  const payload = (): BoardPayload => {
    const layout: MergedLayout = {
      clock: own.clock,
      items: Object.fromEntries(Object.entries(own.items).filter(([, r]) => !r.gone)),
      groups: { ...own.groups },
      missing: {},
      moved: [],
      people: 1
    };
    return {
      scan: { root: "/Volumes/Studio/Pre-production", folders, images, elapsedMs: 3 },
      layout,
      own: structuredClone(own),
      device: "browser"
    };
  };
  const byPath = (p: string) => images.find((i) => i.path === p);

  return {
    native: false,
    pickFolder: async () => "/Volumes/Studio/Pre-production",
    openBoard: async () => payload(),
    rescan: async () => payload(),
    async saveLayout(doc) {
      own = structuredClone(doc);
    },
    compactLayout: async () => {},
    async moveImage(from, toFolder, copy) {
      const img = byPath(from);
      if (!img) throw new Error(`${from} is no longer on disk`);
      let name = img.name;
      let k = 2;
      const taken = (nm: string) => images.some((i) => i.path === (toFolder ? `${toFolder}/${nm}` : nm));
      while (taken(name)) name = img.name.replace(/(\.[^.]+)$/, ` ${k++}$1`);
      const path = toFolder ? `${toFolder}/${name}` : name;
      const next = { ...img, path, folder: toFolder, name, fileId: copy ? `${img.fileId}-copy` : img.fileId };
      images = copy ? [...images, next] : images.map((i) => (i === img ? next : i));
      setTimeout(() => emit("files-changed"), 50);
      return path;
    },
    importFiles: async () => [],
    async createFolder(parent, name) {
      const path = parent ? `${parent}/${name}` : name;
      folders = [...folders, { path, name, parent }];
      setTimeout(() => emit("files-changed"), 50);
      return path;
    },
    reveal: async () => {},
    openFile: async () => {},
    thumbUrl: (path, tier) => `mock://${tier}/${path}`,
    async loadThumb(path: string, tier: Tier) {
      const img = byPath(path);
      if (!img) throw new Error("missing");
      // Simulate decode cost so loading order is visible in the browser build,
      // and a download for online-only files.
      const full = real.get(img.path) ?? img;
      const delay = (tier === "256" ? 2 : 8) + (img.onlineOnly ? 40 + (hash(path) % 120) : 0);
      await new Promise((r) => setTimeout(r, delay));
      if (img.onlineOnly) {
        Object.assign(img, { width: full.width, height: full.height, onlineOnly: false });
      }
      const blob = await paint(full, tier === "256" ? 256 : tier === "1024" ? 1024 : 2048);
      return { blob, size: [full.width, full.height] as [number, number] };
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    }
  };
}
