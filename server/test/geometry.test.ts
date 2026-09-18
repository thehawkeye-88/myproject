import { describe, it, expect } from 'vitest';
import { charRangeToRects } from '../../web/src/lib/geometry';
import type { CharBox } from '@docreview/shared';

const boxes: CharBox[] = [
  { charStart: 0, charEnd: 10, page: 1, x: 10, y: 100, w: 100, h: 12 },
  { charStart: 10, charEnd: 20, page: 1, x: 110, y: 100, w: 100, h: 12 },
  { charStart: 20, charEnd: 30, page: 2, x: 10, y: 50, w: 100, h: 12 },
];

describe('charRangeToRects', () => {
  it('returns nothing for a range that touches no text', () => {
    expect(charRangeToRects(boxes, { start: 40, end: 45 }, 1)).toEqual([]);
  });

  it('slices a partial box proportionally', () => {
    const [r] = charRangeToRects(boxes, { start: 5, end: 10 }, 1);
    expect(r.rect.x).toBe(60);
    expect(r.rect.w).toBe(50);
  });

  it('merges adjacent runs on the same line into one band', () => {
    const out = charRangeToRects(boxes, { start: 0, end: 20 }, 1);
    expect(out).toHaveLength(1);
    expect(out[0].rect.x).toBe(10);
    expect(out[0].rect.w).toBe(200);
  });

  it('keeps a cross-page span split by page', () => {
    const out = charRangeToRects(boxes, { start: 15, end: 25 }, 1);
    expect(out.map((r) => r.page)).toEqual([1, 2]);
  });

  it('scales every dimension', () => {
    const [r] = charRangeToRects(boxes, { start: 0, end: 10 }, 2);
    expect(r.rect).toEqual({ x: 20, y: 200, w: 200, h: 24 });
  });
});
