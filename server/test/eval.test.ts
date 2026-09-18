import { describe, it, expect } from 'vitest';
import { scoreCorpus } from '../src/eval.js';

/**
 * The eval harness as a regression gate.
 *
 * `./run eval` reports the numbers; this makes them load-bearing. The
 * thresholds are set just below the numbers the corpus currently achieves, so
 * a change that makes extraction worse — or, more importantly, makes it fail
 * more quietly — fails the build rather than quietly degrading EVAL.md.
 *
 * The escape assertion is the one that matters. Everything else in this
 * codebase is in service of keeping that number at zero.
 */
describe('corpus evaluation', () => {
  it('holds the measured baseline', { timeout: 120_000 }, async () => {
    const { rows, summary } = await scoreCorpus();

    expect(summary.fields).toBe(304);

    // At most one field may be wrong or missing without being flagged. That one
    // is `currency` on the abbreviated-label invoice: "Ccy" is not a label the
    // reader knows. It is a coverage gap, deliberately left — adding the exact
    // abbreviation the fixture invented would make the fixture prove nothing.
    const escaped = rows.filter((r) => r.outcome === 'escaped');
    expect(escaped.map((r) => `${r.file}:${r.key}`)).toEqual(['mno-freight-MF-6120.pdf:currency']);

    expect(summary.accuracy).toBeGreaterThanOrEqual(0.97);
    expect(summary.reviewLoad).toBeLessThanOrEqual(0.10);
    expect(summary.queuePrecision).toBeGreaterThanOrEqual(0.70);
  });

  it('never invents a value for a field that is not on the page', async () => {
    const { rows } = await scoreCorpus();
    expect(rows.filter((r) => r.why.startsWith('invented'))).toEqual([]);
  });
});
