import type { CharBox, CharRange } from '@docreview/shared';

export type Rect = { x: number; y: number; w: number; h: number };
export type PageRect = { page: number; rect: Rect };

/**
 * Highlight geometry is derived on every render, never stored. Stored rects
 * would need invalidating on zoom, scroll, resize and page mount — four
 * independent drift vectors. Derived rects cannot drift.
 *
 * Pure, so it is testable without a DOM.
 */
export function charRangeToRects(
  charBoxes: CharBox[],
  range: CharRange,
  scale: number,
): PageRect[] {
  const out: PageRect[] = [];
  for (const box of charBoxes) {
    if (box.charEnd <= range.start || box.charStart >= range.end) continue;

    const len = box.charEnd - box.charStart;
    if (len <= 0) continue;

    const from = Math.max(box.charStart, range.start);
    const to = Math.min(box.charEnd, range.end);

    // Uniform advance within a text item. Exact for monospaced runs and within
    // a pixel or two for proportional ones, which is all a highlight needs.
    const x = box.x + (box.w * (from - box.charStart)) / len;
    const w = (box.w * (to - from)) / len;

    out.push({
      page: box.page,
      rect: { x: x * scale, y: box.y * scale, w: Math.max(w, 2) * scale, h: box.h * scale },
    });
  }
  return mergeAdjacent(out);
}

/** Collapse runs that sit on the same line so a phrase highlights as one band. */
function mergeAdjacent(rects: PageRect[]): PageRect[] {
  const out: PageRect[] = [];
  for (const cur of rects) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.page === cur.page &&
      Math.abs(prev.rect.y - cur.rect.y) < 2 &&
      cur.rect.x - (prev.rect.x + prev.rect.w) < 6 &&
      cur.rect.x >= prev.rect.x
    ) {
      prev.rect.w = cur.rect.x + cur.rect.w - prev.rect.x;
      prev.rect.h = Math.max(prev.rect.h, cur.rect.h);
    } else {
      out.push({ page: cur.page, rect: { ...cur.rect } });
    }
  }
  return out;
}
