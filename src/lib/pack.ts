// Packing helpers for Auto boxes. Pure functions, unit-tested in tests/pack.test.ts.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Justified rows: images keep their aspect ratio, each full row is scaled to
 *  fill `width` exactly, and the last row keeps the target height (unless
 *  `stretchLast`). Rows never get taller than 1.6x the target, so a single
 *  very wide image doesn't become huge. */
export function justify(aspects: number[], width: number, rowH: number, gap: number, stretchLast = false) {
  const boxes: Box[] = new Array(aspects.length);
  let y = 0;
  let start = 0;
  let sum = 0;
  const flush = (end: number, last: boolean) => {
    const count = end - start;
    if (count === 0) return;
    const avail = width - gap * (count - 1);
    let h = avail / sum;
    if (last && !stretchLast) h = Math.min(h, rowH);
    h = Math.min(h, rowH * 1.6);
    let x = 0;
    for (let i = start; i < end; i += 1) {
      const w = aspects[i] * h;
      boxes[i] = { x, y, w, h };
      x += w + gap;
    }
    y += h + gap;
    start = end;
    sum = 0;
  };
  for (let i = 0; i < aspects.length; i += 1) {
    sum += aspects[i];
    const count = i - start + 1;
    if (sum * rowH + gap * (count - 1) >= width) flush(i + 1, false);
  }
  flush(aspects.length, true);
  return { boxes, height: aspects.length ? y - gap : 0 };
}

/** Shelf packing for sub-folder boxes: left to right in order, wrapping at `width`. */
export function shelf(sizes: { w: number; h: number }[], width: number, gap: number) {
  const boxes: Box[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > width) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    boxes.push({ x, y, w: s.w, h: s.h });
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  return { boxes, height: sizes.length ? y + rowH : 0 };
}
