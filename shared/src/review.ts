import type { FieldValue, ReviewStatus } from './types.js';
import type { FieldDef } from './schema.js';

/**
 * Whether a field belongs in the review queue.
 *
 * This lives in `shared` because both the server's counts and the client's
 * filter must answer it identically. Two copies of this rule would show a
 * reviewer "3 flagged" above a list of four rows, and there would be no way to
 * tell which number was lying.
 */
export function needsReview(def: FieldDef, value: FieldValue, review: ReviewStatus): boolean {
  if (review !== 'pending') return false;
  // `not_present` is a legitimate answer for an optional field and a
  // contradiction for a required one: an invoice that genuinely has no total is
  // not an invoice. Leaving those unflagged let a required field go missing in
  // silence, which the eval harness caught as an escape.
  if (value.state === 'empty') return value.reason !== 'not_present' || def.required;
  if (value.violations.length > 0) return true;
  if (value.grounding.kind === 'mismatch' || value.grounding.kind === 'ungrounded') return true;
  // A derived value is one the document never states. On a required field that
  // means the reviewer is being asked to accept our arithmetic rather than the
  // vendor's figure, and should be told so.
  return value.grounding.kind === 'derived' && def.required;
}
