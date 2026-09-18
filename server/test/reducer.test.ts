import { describe, it, expect } from 'vitest';
import { reviewReducer, initialReviewState } from '../../web/src/features/review/reducer';

const order = ['total', 'subtotal', 'tax', 'vendor_name'];

describe('review reducer', () => {
  it('moves the cursor within the given order', () => {
    let s = reviewReducer(initialReviewState, { t: 'cursor/set', key: 'subtotal' });
    s = reviewReducer(s, { t: 'cursor/move', dir: 1, order });
    expect(s.cursorKey).toBe('tax');
    s = reviewReducer(s, { t: 'cursor/move', dir: -1, order });
    expect(s.cursorKey).toBe('subtotal');
  });

  it('clamps at both ends rather than wrapping', () => {
    let s = reviewReducer(initialReviewState, { t: 'cursor/set', key: 'total' });
    s = reviewReducer(s, { t: 'cursor/move', dir: -1, order });
    expect(s.cursorKey).toBe('total');
  });

  // The load-bearing test. Background extraction results reorder the list; an
  // index-keyed cursor would slide under the reviewer mid-keystroke.
  it('keeps the cursor and the in-flight draft when the list reorders', () => {
    let s = reviewReducer(initialReviewState, { t: 'cursor/set', key: 'tax' });
    s = reviewReducer(s, { t: 'edit/begin', key: 'tax', initial: '185.77' });
    s = reviewReducer(s, { t: 'edit/change', draft: '185.7' });

    const reordered = ['vendor_name', 'tax', 'total', 'subtotal'];
    const after = reviewReducer(s, { t: 'cursor/set', key: s.cursorKey! });

    expect(after.cursorKey).toBe('tax');
    expect(after.editing).toEqual({ key: 'tax', draft: '185.7', error: null });

    const moved = reviewReducer(after, { t: 'cursor/move', dir: 1, order: reordered });
    expect(moved.cursorKey).toBe('total');
  });

  // The bug this prevents: the server rejects the value, the row silently
  // reverts, and the reviewer's typing is gone with no explanation.
  it('reopens the editor with the typed text when the server refuses it', () => {
    let s = reviewReducer(initialReviewState, { t: 'edit/begin', key: 'tax', initial: '204.35' });
    s = reviewReducer(s, { t: 'edit/change', draft: 'abc' });
    s = reviewReducer(s, { t: 'edit/commit' });
    expect(s.editing).toBeNull();

    s = reviewReducer(s, { t: 'edit/invalid', key: 'tax', draft: 'abc', message: 'not a number: abc' });
    expect(s.editing).toEqual({ key: 'tax', draft: 'abc', error: 'not a number: abc' });
    expect(s.cursorKey).toBe('tax');
  });

  it('clears the error as soon as the reviewer starts fixing it', () => {
    let s = reviewReducer(initialReviewState, {
      t: 'edit/invalid', key: 'tax', draft: 'abc', message: 'not a number: abc',
    });
    s = reviewReducer(s, { t: 'edit/change', draft: '185.77' });
    expect(s.editing).toEqual({ key: 'tax', draft: '185.77', error: null });
  });

  it('cancelling an edit discards the draft but not the cursor', () => {
    let s = reviewReducer(initialReviewState, { t: 'edit/begin', key: 'tax', initial: '1' });
    s = reviewReducer(s, { t: 'edit/cancel' });
    expect(s.editing).toBeNull();
    expect(s.cursorKey).toBe('tax');
  });

  it('is referentially stable when nothing changes', () => {
    const s = reviewReducer(initialReviewState, { t: 'cursor/set', key: 'total' });
    expect(reviewReducer(s, { t: 'cursor/set', key: 'total' })).toBe(s);
  });
});
