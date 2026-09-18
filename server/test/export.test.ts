import { describe, it, expect } from 'vitest';
import type { Field } from '@docreview/shared';

/**
 * The export gate, expressed as the predicate the route actually uses. The route
 * itself is exercised over HTTP; this pins the rule so it cannot be loosened by
 * accident — exporting unreviewed data is the one way this product can do harm.
 */
const blocked = (fields: Field[], force: boolean) =>
  fields.some((f) => f.review === 'pending') && !force;

const field = (review: Field['review']): Field => ({
  id: 'x', key: 'total', label: 'Total', type: 'money', group: 'totals',
  value: { state: 'empty', reason: 'not_present' },
  source: 'model', review, version: 1, priority: 0, priorityReason: 'n/a',
});

describe('export gate', () => {
  it('blocks while anything is still pending', () => {
    expect(blocked([field('accepted'), field('pending')], false)).toBe(true);
  });

  it('allows once every field has been ruled on, either way', () => {
    expect(blocked([field('accepted'), field('rejected')], false)).toBe(false);
  });

  it('allows an explicit override', () => {
    expect(blocked([field('pending')], true)).toBe(false);
  });
});
