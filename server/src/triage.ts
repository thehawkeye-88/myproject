export { needsReview } from '@docreview/shared';
import type { FieldDef, FieldValue, ReviewStatus } from '@docreview/shared';

export type Rank = { priority: number; reason: string };

/**
 * Which fields a human must look at, in what order, and why.
 *
 * `reason` is required, never optional. A queue that ranks without explaining is
 * exactly the failure mode this product exists to avoid — the reviewer has to be
 * able to disagree with the ranking, which means seeing its argument.
 */
export function rank(def: FieldDef, value: FieldValue, review: ReviewStatus): Rank {
  const scale = (base: number, reason: string): Rank => ({
    priority: Math.round(base * def.importance * 100) / 100,
    reason,
  });

  if (review === 'accepted') return { priority: 0, reason: 'Accepted by a reviewer.' };
  if (review === 'rejected') return { priority: 0, reason: 'Rejected by a reviewer.' };

  if (value.state === 'empty') {
    switch (value.reason) {
      case 'extraction_failed':
        return scale(70, 'Extraction failed for this field. Retry rather than judge.');
      case 'unparseable':
        return scale(55, 'Text was found but could not be read as a valid value.');
      case 'not_attempted':
        return scale(45, 'Not attempted yet — this field has no result to trust or distrust.');
      case 'not_present':
        return def.required
          ? scale(60, 'Reported absent from the document, but this field is required.')
          : scale(5, 'Reported absent from the document, and this field is optional.');
      default: {
        const never: never = value.reason;
        return scale(40, `Unknown empty reason ${never}.`);
      }
    }
  }

  if (value.violations.length > 0) {
    return scale(100, value.violations[0].message);
  }

  switch (value.grounding.kind) {
    case 'mismatch':
      return scale(
        90,
        `Reads "${truncate(value.grounding.sourceText)}" in the document, but the extracted value is "${value.value}".`,
      );
    case 'ungrounded':
      return def.required
        ? scale(65, 'No source span could be located for a required field.')
        : scale(30, 'No source span could be located.');
    case 'derived':
      return scale(10, `Computed, not read: ${value.grounding.rule.replace(/_/g, ' ')}.`);
    case 'grounded':
      return grounded(value.grounding.how, scale);
    default: {
      const never: never = value.grounding;
      return scale(50, `Unknown grounding ${JSON.stringify(never)}.`);
    }
  }
}

function grounded(how: string, scale: (b: number, r: string) => Rank): Rank {
  switch (how) {
    case 'exact':
      return scale(5, 'Matches its quoted source text exactly.');
    case 'normalized':
      return scale(8, 'Matches its quoted source apart from whitespace or case.');
    case 'fuzzy':
      return scale(25, 'Located only by approximate match — the quoted text is not exactly in the document.');
    default:
      return scale(10, 'Matches its source text.');
  }
}

const truncate = (s: string, n = 60) =>
  s.replace(/\s+/g, ' ').trim().slice(0, n) + (s.length > n ? '…' : '');

