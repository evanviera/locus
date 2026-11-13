import type { LoadedThumb, Tier } from "../types";

// Texture management. Three levels of detail per image:
//   atlas  64 px tiles in a texture array (every image, so a zoomed-out board
//          of thousands draws in one call),
//   256    its own texture once it is ~70-300 px on screen,
//   1024   its own texture beyond that.
// Requests are prioritised every frame by what is on screen (biggest first),
// then the rest of the board fills the atlas in the background.
//
// Online-only files (Google Drive, Dropbox) are downloaded by reading them, so
// they have their own request slots: a slow download never blocks local
// thumbnails, and their background fill can be paused.

export const CELL = 64;
const ATLAS = 2048;
const PER_ROW = ATLAS / CELL;
const PER_LAYER = PER_ROW * PER_ROW;
const SINGLE_BUDGET = 384 * 1024 * 1024;

export interface AtlasSlot {
  layer: number;
  uv: [number, number, number, number];
}

interface Single {
  tex: WebGLTexture;
  bytes: number;
  used: number;
}

export type Loader = (path: string, tier: Tier) => Promise<LoadedThumb>;

const LOCAL_SLOTS = 8;
const CLOUD_SLOTS = 6;

export class TextureStore {
  private gl: WebGL2RenderingContext;
  atlasTex: WebGLTexture | null = null;
  private layers = 0;
  private slotsUsed = 0;
  private freeSlots: number[] = [];
  readonly atlas = new Map<string, AtlasSlot & { index: number }>();
  private singles = new Map<string, Single>();
  private singleBytes = 0;
  private inflight = new Map<string, boolean>();
  private cloudInflight = 0;
  private failed = new Map<string, number>();
  private wants: { key: string; path: string; tier: Tier | "atlas"; prio: number }[] = [];
  private frame = 0;
  private background: string[] = [];
  private backgroundAt = 0;
  private cloudBackground: string[] = [];
  private cloudBackgroundAt = 0;
  /** Stop downloading online-only files except ones big enough on screen to look at. */
  cloudPaused = false;
  isCloud: (path: string) => boolean = () => false;
  /** Called with the pixel size from disk, or else the thumbnail's own size. */
  onSize: (path: string, w: number, h: number, exact: boolean) => void = () => {};
  onChange: () => void = () => {};
  stats = { atlas: 0, singles: 0, loaded: 0, failed: 0 };

  constructor(gl: WebGL2RenderingContext, private load: Loader) {
    this.gl = gl;
  }

  /** Size the atlas for the board (call again when images are added). */
  reserve(count: number) {
    const needed = Math.max(1, Math.ceil((count + 64) / PER_LAYER));
    if (needed <= this.layers) return;
    const gl = this.gl;
    const old = this.atlasTex;
    const oldLayers = this.layers;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, ATLAS, ATLAS, needed);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (old && oldLayers) {
      // Copy existing tiles layer by layer through a framebuffer.
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
      for (let l = 0; l < oldLayers; l += 1) {
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, old, 0, l);
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, 0, 0, ATLAS, ATLAS);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(old);
    }
    this.atlasTex = tex;
    this.layers = needed;
  }

  private allocSlot(): number {
    if (this.freeSlots.length) return this.freeSlots.pop()!;
    if (this.slotsUsed >= this.layers * PER_LAYER) this.reserve(this.slotsUsed + PER_LAYER);
    return this.slotsUsed++;
  }

  /** Forget images that are no longer on the board. */
  retain(paths: Set<string>) {
    for (const [path, slot] of this.atlas) {
      if (!paths.has(path)) {
        this.freeSlots.push(slot.index);
        this.atlas.delete(path);
      }
    }
    for (const [key, s] of this.singles) {
      if (!paths.has(key.slice(0, key.lastIndexOf("|")))) this.dropSingle(key, s);
    }
    this.background = this.background.filter((p) => paths.has(p));
    this.cloudBackground = this.cloudBackground.filter((p) => paths.has(p));
  }

  single(path: string, tier: Tier): WebGLTexture | null {
    const s = this.singles.get(`${path}|${tier}`);
    if (!s) return null;
    s.used = this.frame;
    return s.tex;
  }

  beginFrame() {
    this.frame += 1;
    this.wants = [];
  }

  want(path: string, tier: Tier | "atlas", prio: number) {
    const key = `${path}|${tier}`;
    if (this.inflight.has(key)) return;
    if (tier === "atlas" ? this.atlas.has(path) : this.singles.has(key)) return;
    const failedAt = this.failed.get(key);
    if (failedAt && performance.now() - failedAt < 30_000) return;
    this.wants.push({ key, path, tier, prio });
  }

  /** Every image on the board, nearest to the view first, for background atlas fill. */
  setBackground(paths: string[]) {
    this.background = paths.filter((p) => !this.isCloud(p));
    this.cloudBackground = paths.filter((p) => this.isCloud(p));
    this.backgroundAt = 0;
    this.cloudBackgroundAt = 0;
  }

  /** Online-only images still waiting for a background download. */
  get cloudLeft() {
    let n = 0;
    for (let i = this.cloudBackgroundAt; i < this.cloudBackground.length; i += 1) {
      const p = this.cloudBackground[i];
      if (!this.atlas.has(p) && !this.failed.has(`${p}|atlas`)) n += 1;
    }
    return n + this.cloudInflight;
  }

  pump() {
    const localFree = () => this.inflight.size - this.cloudInflight < LOCAL_SLOTS;
    const cloudFree = () => this.cloudInflight < CLOUD_SLOTS;
    this.wants.sort((a, b) => b.prio - a.prio);
    for (const w of this.wants) {
      const cloud = this.isCloud(w.path);
      // Paused: only online-only images big enough on screen to look at still download.
      if (cloud && this.cloudPaused && w.tier === "atlas") continue;
      if (cloud ? cloudFree() : localFree()) this.start(w.key, w.path, w.tier, cloud);
      if (!localFree() && !cloudFree()) return;
    }
    const fill = (list: string[], at: number, free: () => boolean, cloud: boolean) => {
      while (free() && at < list.length) {
        const path = list[at++];
        const key = `${path}|atlas`;
        if (this.atlas.has(path) || this.inflight.has(key) || this.failed.has(key)) continue;
        this.start(key, path, "atlas", cloud);
      }
      return at;
    };
    this.backgroundAt = fill(this.background, this.backgroundAt, localFree, false);
    if (!this.cloudPaused) this.cloudBackgroundAt = fill(this.cloudBackground, this.cloudBackgroundAt, cloudFree, true);
  }

  get busy() {
    return (
      this.inflight.size > 0 ||
      this.backgroundAt < this.background.length ||
      (!this.cloudPaused && this.cloudBackgroundAt < this.cloudBackground.length)
    );
  }

  private start(key: string, path: string, tier: Tier | "atlas", cloud: boolean) {
    this.inflight.set(key, cloud);
    if (cloud) this.cloudInflight += 1;
    const source: Tier = tier === "atlas" ? "256" : tier;
    this.load(path, source)
      .then(async ({ blob, size }) => {
        if (size) this.onSize(path, size[0], size[1], true);
        if (tier === "atlas") {
          const probe = await createImageBitmap(blob, { premultiplyAlpha: "none" });
          if (!size) this.onSize(path, probe.width, probe.height, false);
          const scale = CELL / Math.max(probe.width, probe.height);
          const w = Math.max(1, Math.round(probe.width * scale));
          const h = Math.max(1, Math.round(probe.height * scale));
          const small = await createImageBitmap(probe, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium", premultiplyAlpha: "none" });
          probe.close();
          this.putAtlas(path, small);
          small.close();
          // A 256 fetch also serves as the 256 texture if the image is near.
        } else {
          const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
          if (!size) this.onSize(path, bmp.width, bmp.height, false);
          this.putSingle(key, bmp);
          if (tier === "256" && !this.atlas.has(path)) {
            const scale = CELL / Math.max(bmp.width, bmp.height);
            const small = await createImageBitmap(bmp, {
              resizeWidth: Math.max(1, Math.round(bmp.width * scale)),
              resizeHeight: Math.max(1, Math.round(bmp.height * scale)),
              resizeQuality: "medium",
              premultiplyAlpha: "none"
            });
            this.putAtlas(path, small);
            small.close();
          }
          bmp.close();
        }
        this.stats.loaded += 1;
      })
      .catch(() => {
        this.failed.set(key, performance.now());
        this.stats.failed += 1;
      })
      .finally(() => {
        this.inflight.delete(key);
        if (cloud) this.cloudInflight -= 1;
        this.onChange();
      });
  }

  private putAtlas(path: string, bmp: ImageBitmap) {
    const gl = this.gl;
    if (!this.atlasTex) this.reserve(1);
    const index = this.allocSlot();
    const layer = Math.floor(index / PER_LAYER);
    const cell = index % PER_LAYER;
    const cx = (cell % PER_ROW) * CELL;
    const cy = Math.floor(cell / PER_ROW) * CELL;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, cx, cy, layer, bmp.width, bmp.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    // Inset half a texel so linear filtering never bleeds into a neighbour.
    const u0 = (cx + 0.5) / ATLAS;
    const v0 = (cy + 0.5) / ATLAS;
    const u1 = (cx + bmp.width - 0.5) / ATLAS;
    const v1 = (cy + bmp.height - 0.5) / ATLAS;
    this.atlas.set(path, { layer, uv: [u0, v0, u1, v1], index });
    this.stats.atlas = this.atlas.size;
  }

  private putSingle(key: string, bmp: ImageBitmap) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const bytes = Math.round(bmp.width * bmp.height * 4 * 1.34);
    this.singles.set(key, { tex, bytes, used: this.frame });
    this.singleBytes += bytes;
    this.evict();
    this.stats.singles = this.singles.size;
  }

  private dropSingle(key: string, s: Single) {
    this.gl.deleteTexture(s.tex);
    this.singleBytes -= s.bytes;
    this.singles.delete(key);
  }

  /** Least recently drawn first, never anything drawn in the last few frames. */
  private evict() {
    if (this.singleBytes <= SINGLE_BUDGET) return;
    const entries = [...this.singles.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, s] of entries) {
      if (this.singleBytes <= SINGLE_BUDGET * 0.85) break;
      if (this.frame - s.used < 3) continue;
      this.dropSingle(key, s);
    }
    this.stats.singles = this.singles.size;
  }

  dispose() {
    for (const [key, s] of this.singles) this.dropSingle(key, s);
    if (this.atlasTex) this.gl.deleteTexture(this.atlasTex);
  }
}
