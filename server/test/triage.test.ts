import { describe, it, expect } from 'vitest';
import { rank, needsReview } from '../src/triage.js';
import { FIELD_BY_KEY } from '@docreview/shared';
import type { FieldValue } from '@docreview/shared';

const total = FIELD_BY_KEY.total;
const po = FIELD_BY_KEY.po_number;

const grounded: FieldValue = {
  state: 'filled', value: 1, violations: [],
  grounding: { kind: 'grounded', span: { start: 0, end: 1 }, page: 1, how: 'exact' },
};

describe('rank', () => {
  it('always produces a reason', () => {
    for (const v of [grounded, { state: 'empty', reason: 'not_present' } as FieldValue]) {
      expect(rank(total, v, 'pending').reason.length).toBeGreaterThan(0);
    }
  });

  it('ranks a violated field above a merely ungrounded one', () => {
    const violated: FieldValue = {
      ...grounded,
      violations: [{ rule: 'r', message: 'Subtotal plus tax gives 110.00, but total reads 120.00.', operands: [] }],
    };
    const ungrounded: FieldValue = { state: 'filled', value: 1, grounding: { kind: 'ungrounded' }, violations: [] };
    expect(rank(total, violated, 'pending').priority).toBeGreaterThan(
      rank(total, ungrounded, 'pending').priority,
    );
  });

  it('weights the same weakness by how much the field matters', () => {
    const ungrounded: FieldValue = { state: 'filled', value: 1, grounding: { kind: 'ungrounded' }, violations: [] };
    expect(rank(total, ungrounded, 'pending').priority).toBeGreaterThan(
      rank(po, ungrounded, 'pending').priority,
    );
  });

  it('drops a reviewed field out of the queue entirely', () => {
    expect(rank(total, grounded, 'accepted').priority).toBe(0);
  });

  it('surfaces the violation message as the reason, not a rule name', () => {
    const violated: FieldValue = {
      ...grounded,
      violations: [{ rule: 'lines_sum_to_subtotal', message: 'Line items sum to 1,240.00 but subtotal reads 1,420.00.', operands: [] }],
    };
    expect(rank(total, violated, 'pending').reason).toContain('1,420.00');
  });
});

describe('needsReview', () => {
  const derived = (rule: string): FieldValue =>
    ({ state: 'filled', value: 1, grounding: { kind: 'derived', rule, operands: [] }, violations: [] });

  it('excludes a confidently grounded value and a legitimate absence', () => {
    expect(needsReview(total, grounded, 'pending')).toBe(false);
    expect(needsReview(po, { state: 'empty', reason: 'not_present' }, 'pending')).toBe(false);
  });
  it('flags a required field reported as absent, which is a contradiction', () => {
    // An invoice with no total is not an invoice. Letting `not_present` pass
    // unflagged on a required field let one go missing in silence; the eval
    // harness caught it as an escape on the abbreviated-label invoice.
    expect(needsReview(total, { state: 'empty', reason: 'not_present' }, 'pending')).toBe(true);
  });
  it('includes failures, mismatches and unlocated values', () => {
    expect(needsReview(total, { state: 'empty', reason: 'extraction_failed' }, 'pending')).toBe(true);
    expect(needsReview(total, { state: 'filled', value: 1, grounding: { kind: 'ungrounded' }, violations: [] }, 'pending')).toBe(true);
  });
  it('queues a derived value only when the field is required', () => {
    expect(needsReview(total, derived('sum_of_line_items'), 'pending')).toBe(true);
    expect(needsReview(po, derived('currency_symbol'), 'pending')).toBe(false);
  });
  it('excludes anything a human has already ruled on', () => {
    expect(needsReview(total, { state: 'empty', reason: 'extraction_failed' }, 'accepted')).toBe(false);
  });
});
