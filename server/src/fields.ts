import { FIELDS, FIELD_BY_KEY, needsReview } from '@docreview/shared';
import type { Field, FieldValue, Json, ReviewStatus } from '@docreview/shared';
import { q } from './db.js';
import { rank } from './triage.js';
import { checkInvariants } from './invariants.js';

export function rowToValue(row: any): FieldValue {
  if (row.empty_reason) return { state: 'empty', reason: row.empty_reason };
  return {
    state: 'filled',
    value: row.value as Json,
    grounding: row.grounding,
    violations: row.violations ?? [],
  };
}

export function rowToField(row: any): Field | null {
  const def = FIELD_BY_KEY[row.field_key];
  if (!def) return null;
  const value = rowToValue(row);
  const review = row.review as ReviewStatus;
  const { priority, reason } = rank(def, value, review);
  return {
    id: row.id,
    key: def.key,
    label: def.label,
    type: def.type,
    group: def.group,
    value,
    source: row.source,
    originalValue: row.original_value ?? undefined,
    review,
    version: row.version,
    priority,
    priorityReason: reason,
  };
}

export async function fieldsFor(documentId: string): Promise<Field[]> {
  const rows = await q<any>(
    `select * from field_values where document_id = $1`,
    [documentId],
  );
  const byKey = new Map(rows.map((r) => [r.field_key, r]));
  const out: Field[] = [];
  for (const def of FIELDS) {
    const row = byKey.get(def.key);
    if (row) {
      const f = rowToField(row);
      if (f) out.push(f);
    } else {
      const value: FieldValue = { state: 'empty', reason: 'not_attempted' };
      const { priority, reason } = rank(def, value, 'pending');
      out.push({
        id: `pending:${def.key}`,
        key: def.key,
        label: def.label,
        type: def.type,
        group: def.group,
        value,
        source: 'model',
        review: 'pending',
        version: 0,
        priority,
        priorityReason: reason,
      });
    }
  }
  return out;
}

export function countsOf(fields: Field[]) {
  return {
    total: fields.length,
    pending: fields.filter((f) => f.review === 'pending').length,
    needsReview: fields.filter((f) => {
      const def = FIELD_BY_KEY[f.key];
      return def ? needsReview(def, f.value, f.review) : false;
    }).length,
  };
}

/**
 * The document text a machine-read value was taken from, or null when there is
 * none — a human edit, a derived value, or an empty field.
 */
function sourceTextOf(text: string, row: any): string | null {
  if (row.source === 'human' || row.empty_reason) return null;
  const g = row.grounding;
  if (!g || (g.kind !== 'grounded' && g.kind !== 'mismatch')) return null;
  return text.slice(g.span.start, g.span.end);
}

/**
 * A human edit changes the arithmetic. Recompute violations for the whole
 * document so the remaining rows stop claiming a discrepancy that was just
 * resolved — this is the single most confusing bug a reviewer can hit.
 */
export async function recomputeViolations(documentId: string) {
  const rows = await q<any>(
    `select field_key, value, empty_reason, grounding, source from field_values where document_id = $1`,
    [documentId],
  );
  const doc = await q<any>(`select text_layer from documents where id = $1`, [documentId]);
  const text: string = doc[0]?.text_layer ?? '';

  const flat: Record<string, Json | null> = {};
  const sources: Record<string, string | null> = {};
  for (const r of rows) {
    flat[r.field_key] = r.empty_reason ? null : r.value;
    sources[r.field_key] = sourceTextOf(text, r);
  }
  const violations = checkInvariants(flat, sources);
  for (const r of rows) {
    await q(
      `update field_values set violations = $3 where document_id = $1 and field_key = $2`,
      [documentId, r.field_key, JSON.stringify(violations[r.field_key] ?? [])],
    );
  }
}
