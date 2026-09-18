import { FIELDS, needsReview } from '@docreview/shared';
import type { FieldValue, Json } from '@docreview/shared';
import { extractTextLayer } from './textlayer.js';
import { extract } from './extract.js';
import { verifyField } from './verify.js';
import { checkInvariants } from './invariants.js';
import { valuesAgree } from './parse.js';
import { CORPUS, render, truthOf, type Spec } from '../scripts/corpus.js';

/**
 * The evaluation harness (M6).
 *
 * It runs the real pipeline — text layer, extract, verify, invariants, triage —
 * over the whole sample corpus and scores every field against the declared
 * ground truth. It exists to answer one question, and it is the question the
 * README's central claim rests on:
 *
 *   Of the values this tool produced and did NOT flag, how many were wrong?
 *
 * That is the escape rate. A wrong value that is flagged is the product working.
 * A wrong value that is not flagged is the product lying, and no amount of
 * pleasant interface design compensates for it.
 *
 * Everything else here — recall, review load, queue precision — is secondary.
 */

type Outcome =
  | 'clean'        // right, and we said nothing. This is the 85%.
  | 'caught'       // wrong or missing, and we flagged it. The product working.
  | 'expected'     // right, flagged, and the document really is inconsistent.
  | 'false_alarm'  // right, but we flagged it anyway. Costs reviewer time.
  | 'escaped';     // wrong or missing, and we said nothing. The product lying.

type Row = { file: string; key: string; outcome: Outcome; got: unknown; want: unknown; why: string };


export async function scoreDocument(spec: Spec): Promise<Row[]> {
  const pdf = await render(spec);
  const layer = await extractTextLayer(new Uint8Array(pdf));
  const { candidates } = extract(layer.text);

  const values = new Map<string, FieldValue>();
  for (const def of FIELDS) {
    values.set(def.key, verifyField(def, candidates.get(def.key), layer.text, layer.pageGeometry, true));
  }

  const flat: Record<string, Json | null> = {};
  const sources: Record<string, string | null> = {};
  for (const [k, v] of values) {
    flat[k] = v.state === 'filled' ? v.value : null;
    sources[k] = v.state === 'filled' && (v.grounding.kind === 'grounded' || v.grounding.kind === 'mismatch')
      ? layer.text.slice(v.grounding.span.start, v.grounding.span.end)
      : null;
  }
  const violations = checkInvariants(flat, sources);
  for (const [k, v] of values) if (v.state === 'filled') v.violations = violations[k] ?? [];

  const truth = truthOf(spec);
  const rows: Row[] = [];

  for (const def of FIELDS) {
    const v = values.get(def.key)!;
    const want = truth[def.key];
    const flagged = needsReview(def, v, 'pending');

    let right: boolean;
    let why: string;
    if (want === null) {
      // Absent from the document. Saying so is right; producing a value is not.
      right = v.state === 'empty';
      why = right ? 'correctly absent' : 'invented a value for a field that is not on the page';
    } else if (v.state === 'empty') {
      right = false;
      why = `missed (${v.reason})`;
    } else {
      right = valuesAgree(def.type, v.value, want);
      why = right ? 'correct' : `read ${JSON.stringify(v.value)}, document says ${JSON.stringify(want)}`;
    }

    // A flag on a correct value is only justified when the document itself does
    // not reconcile. Otherwise it is attention spent for nothing, and the
    // harness must count it as such rather than quietly calling it a success.
    const outcome: Outcome = right
      ? (!flagged ? 'clean'
         : spec.expectViolation && v.state === 'filled' && v.violations.length > 0 ? 'expected'
         : 'false_alarm')
      : (flagged ? 'caught' : 'escaped');

    rows.push({
      file: spec.file, key: def.key, outcome, want, why,
      got: v.state === 'empty' ? `\u2205 ${v.reason}` : v.value,
    });
  }
  return rows;
}

export type Summary = ReturnType<typeof summarise>;

export async function scoreCorpus(): Promise<{ rows: Row[]; summary: Summary }> {
  const rows: Row[] = [];
  for (const spec of CORPUS) rows.push(...await scoreDocument(spec));
  return { rows, summary: summarise(rows) };
}

export function summarise(rows: Row[]) {
  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  const n = rows.length;
  const flagged = count('caught') + count('expected') + count('false_alarm');
  const wrong = count('caught') + count('escaped');
  return {
    documents: CORPUS.length,
    fields: n,
    clean: count('clean'),
    caught: count('caught'),
    expected: count('expected'),
    falseAlarm: count('false_alarm'),
    escaped: count('escaped'),
    reviewLoad: flagged / n,
    escapeRate: count('escaped') / n,
    accuracy: (n - wrong) / n,
    queuePrecision: flagged ? (count('caught') + count('expected')) / flagged : 1,
  };
}

export type { Row, Outcome };
