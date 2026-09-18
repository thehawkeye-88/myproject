import type {
  FieldValue, Grounding, Json, PageGeometry,
} from '@docreview/shared';
import type { FieldDef } from '@docreview/shared';
import { parseByType, valuesAgree } from './parse.js';
import { locate } from './locate.js';

/** What the extractor produced for one field, before we believe any of it. */
export type Candidate = {
  key: string;
  /** Verbatim text the extractor says it read this from. */
  quote: string | null;
  /** The interpreted value. */
  value: Json | null;
  /** Set when the value was computed from other fields rather than read. */
  derived?: { rule: string; operands: string[] };
  /** The extractor searched for this field and concluded it is not on the page. */
  notPresent?: boolean;
};

export function pageOf(geometry: PageGeometry[], charIndex: number): number {
  for (const g of geometry) {
    if (charIndex >= g.charStart && charIndex < g.charEnd) return g.page;
  }
  return geometry.length ? geometry[geometry.length - 1].page : 1;
}

/**
 * The verifier. Given the canonical text and one candidate, decide what we are
 * willing to claim. It re-reads the page independently of whatever the
 * extractor asserted, so a claimed value only survives if the document still
 * says so on a second, separate reading.
 */
export function verifyField(
  def: FieldDef,
  cand: Candidate | undefined,
  text: string,
  geometry: PageGeometry[],
  /**
   * Whether this field was in scope for the run that produced `cand`. It is the
   * only way to separate "we never asked" from "we asked and got nothing back",
   * and those two need different responses: the first needs a run, the second
   * needs a retry.
   */
  attempted = false,
): FieldValue {
  if (!cand) return { state: 'empty', reason: attempted ? 'extraction_failed' : 'not_attempted' };
  if (cand.notPresent) return { state: 'empty', reason: 'not_present' };

  const hasValue = cand.value !== null && cand.value !== undefined && cand.value !== '';
  const quote = cand.quote?.trim() || null;

  if (!hasValue) {
    // Something was quoted but produced no value — we saw text we could not read.
    return { state: 'empty', reason: quote ? 'unparseable' : 'not_present' };
  }

  const value = cand.value as Json;

  // A derived value was never on the page, so there is nothing to locate. Say
  // so plainly rather than letting it fail to ground and look like a defect.
  if (cand.derived) {
    return {
      state: 'filled',
      value,
      grounding: { kind: 'derived', rule: cand.derived.rule, operands: cand.derived.operands },
      violations: [],
    };
  }

  const found = quote ? locate(text, quote) : null;

  if (!found) {
    return {
      state: 'filled',
      value,
      grounding: { kind: 'ungrounded' },
      violations: [],
    };
  }

  const sourceText = text.slice(found.span.start, found.span.end);
  const parsed = parseByType(def.type, sourceText);
  const page = pageOf(geometry, found.span.start);

  const grounding: Grounding =
    parsed.ok && valuesAgree(def.type, parsed.value, value)
      ? { kind: 'grounded', span: found.span, page, how: found.method }
      : { kind: 'mismatch', span: found.span, page, sourceText };

  return { state: 'filled', value, grounding, violations: [] };
}

