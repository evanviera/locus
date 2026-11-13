import { type GroupNode, HEADER } from "../lib/board.js";
import type { FolderStyle } from "../lib/prefs";
import { type RGBA, MODE_SOLID, type Renderer } from "./renderer.js";

// Folder boxes. People pick the style in the toolbar; each one makes nesting
// readable a different way, using only the theme's greys.

export interface FolderColors {
  bg: RGBA;
  boxes: RGBA[];
  border: RGBA;
  raised: RGBA;
}

/** One folder box in the current hierarchy style.
 *  tint:  depth steps through three surface greys (the original look)
 *  frames: one fill, every box outlined; top-level boxes get a heavier line
 *  bars:  every box has a header bar, darker for top-level folders
 *  alternate: fills alternate light/dark by depth so neighbours always differ */
export function drawFolder(r: Renderer, colors: FolderColors, style: FolderStyle, g: GroupNode, px: number) {
  const { boxes, border, raised, bg } = colors;
  const radius = Math.min(6 * px, g.w / 2, g.h / 2);
  const rect = (x: number, y: number, w: number, h: number, c: RGBA, rad = radius) =>
    r.push(x + w / 2, y + h / 2, w / 2, h / 2, 0, false, false, null, 0, MODE_SOLID, c, rad);
  if (style === "frames") {
    const line = (g.depth === 1 ? 2 : 1) * px;
    if (g.depth > 0) rect(g.wx, g.wy, g.w, g.h, border);
    rect(g.wx + line, g.wy + line, g.w - line * 2, g.h - line * 2, boxes[0], Math.max(0, radius - line));
    return;
  }
  if (style === "bars") {
    rect(g.wx, g.wy, g.w, g.h, g.depth === 0 ? boxes[0] : boxes[1]);
    if (g.depth > 0) {
      const bar = Math.min(HEADER - 8, g.h);
      rect(g.wx, g.wy, g.w, bar, g.depth === 1 ? border : raised);
      rect(g.wx, g.wy + bar / 2, g.w, bar / 2, g.depth === 1 ? border : raised, 0);
    }
    return;
  }
  if (style === "alternate") {
    rect(g.wx, g.wy, g.w, g.h, g.depth === 0 ? boxes[0] : g.depth % 2 === 1 ? raised : bg);
    return;
  }
  rect(g.wx, g.wy, g.w, g.h, boxes[Math.min(g.depth, 2)]);
}
