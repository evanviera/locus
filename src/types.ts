export interface Folder {
  path: string;
  name: string;
  parent: string | null;
}

export interface ImageEntry {
  path: string;
  folder: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  width: number;
  height: number;
  fileId: string | null;
  onlineOnly: boolean;
}

/** A thumbnail and, when the file is on disk, its pixel size. */
export interface LoadedThumb {
  blob: Blob;
  size?: [number, number];
}

export interface ScanResult {
  root: string;
  folders: Folder[];
  images: ImageEntry[];
  elapsedMs: number;
}

/** Stored per image. Positions are relative to the folder box's content origin. */
export interface ItemRec {
  x?: number;
  y?: number;
  /** Width in world units; height follows the aspect ratio. */
  w?: number;
  rot?: number;
  fx?: boolean;
  fy?: boolean;
  z?: number;
  /** Identity, so the image is recognized after it moves on disk. */
  name?: string;
  size?: number;
  fileId?: string | null;
  /** Pixel size, so teammates with online-only copies still lay it out right. */
  iw?: number;
  ih?: number;
  /** Set by the backend when the file was found in another folder. */
  moved?: boolean;
  /** Tombstone for a path that no longer holds this image. */
  gone?: boolean;
}

export type GroupMode = "auto" | "free";

/** Stored per folder box. x/y are relative to the parent box's content origin. */
export interface GroupRec {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: GroupMode;
}

export type Stamped<T> = T & { t: number; by: string };

export interface LayoutDoc {
  version: number;
  device: string;
  clock: number;
  items: Record<string, Stamped<ItemRec>>;
  groups: Record<string, Stamped<GroupRec>>;
}

export interface MergedLayout {
  clock: number;
  items: Record<string, Stamped<ItemRec>>;
  groups: Record<string, Stamped<GroupRec>>;
  missing: Record<string, Stamped<ItemRec>>;
  moved: { from: string; to: string }[];
  people: number;
}

export interface BoardPayload {
  scan: ScanResult;
  layout: MergedLayout;
  own: LayoutDoc;
  device: string;
}

export type Tier = "256" | "1024" | "full";
