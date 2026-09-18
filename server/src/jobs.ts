import { randomUUID } from 'node:crypto';
import { FIELDS, SCHEMA_VERSION } from '@docreview/shared';
import type { FieldValue, Json, PageGeometry } from '@docreview/shared';
import { q, one } from './db.js';
import { extract } from './extract.js';
import { verifyField } from './verify.js';
import { checkInvariants } from './invariants.js';
import { MACHINE_WRITE } from './sql.js';

/** Recorded on every run so a stored value can be traced to the rules that made it. */
const EXTRACTOR = 'rules-v1';

export async function enqueue(documentId: string, scope: string[] | null = null) {
  const id = randomUUID();
  await q(
    `insert into extraction_runs (id, document_id, schema_version, model, status, scope)
     values ($1, $2, $3, $4, 'queued', $5)`,
    [id, documentId, SCHEMA_VERSION, EXTRACTOR, JSON.stringify(scope)],
  );
  await q(`update documents set status = 'extracting' where id = $1`, [documentId]);
  return id;
}

/**
 * Claim one run. Stale-claim reclaim lives in the same statement, so crash
 * recovery needs no separate reaper process.
 */
async function claim() {
  return one<any>(
    `update extraction_runs
        set status = 'running', claimed_at = now(), started_at = coalesce(started_at, now()),
            attempts = attempts + 1
      where id = (
        select id from extraction_runs
         where status = 'queued'
            or (status = 'running' and claimed_at < now() - interval '5 minutes')
         order by created_at
         for update skip locked
         limit 1)
     returning *`,
  );
}

export async function runOnce(): Promise<boolean> {
  const run = await claim();
  if (!run) return false;

  try {
    const doc = await one<any>(`select * from documents where id = $1`, [run.document_id]);
    if (!doc) throw new Error('document vanished');

    const scope: string[] | null = run.scope ?? null;
    const geometry: PageGeometry[] = doc.page_geometry ?? [];

    const result = extract(doc.text_layer, scope ?? undefined);

    const targets = FIELDS.filter((f) => !scope || scope.includes(f.key));

    // Pass 1 — verify each field in isolation.
    const values = new Map<string, FieldValue>();
    for (const def of targets) {
      values.set(
        def.key,
        verifyField(def, result.candidates.get(def.key), doc.text_layer, geometry, true),
      );
    }

    // Pass 2 — invariants run across the whole document, including fields a
    // human already fixed. Otherwise a scoped retry would report arithmetic
    // that disagrees with what is actually on screen.
    const existing = await q<any>(
      `select field_key, value, source from field_values where document_id = $1`,
      [doc.id],
    );
    const flat: Record<string, Json | null> = {};
    const humanOwned = new Set<string>();
    for (const row of existing) {
      flat[row.field_key] = row.value;
      if (row.source === 'human') humanOwned.add(row.field_key);
    }
    // A freshly extracted value for a human-owned field will be discarded by the
    // write guard, so it must not enter the arithmetic either — otherwise the
    // invoice would be checked against numbers that never reach the screen.
    for (const [k, v] of values) {
      if (humanOwned.has(k)) continue;
      flat[k] = v.state === 'filled' ? v.value : null;
    }

    const sources: Record<string, string | null> = {};
    for (const [k, v] of values) {
      if (humanOwned.has(k)) continue;
      sources[k] = v.state === 'filled' && (v.grounding.kind === 'grounded' || v.grounding.kind === 'mismatch')
        ? doc.text_layer.slice(v.grounding.span.start, v.grounding.span.end)
        : null;
    }

    const violations = checkInvariants(flat, sources);
    for (const [k, v] of values) {
      if (v.state === 'filled') v.violations = violations[k] ?? [];
    }

    // Pass 3 — write, under the guard. A machine write can never overwrite a human.
    for (const def of targets) {
      const v = values.get(def.key)!;
      await writeMachineValue(doc.id, run.id, def.key, v);
    }

    // Fields a human owns still need their violation set refreshed.
    await refreshHumanViolations(doc.id, violations);

    const failed = [...values.values()].filter(
      (v) => v.state === 'empty' && v.reason === 'extraction_failed',
    ).length;

    await q(
      `update extraction_runs
          set status = $2, finished_at = now(), usage = $3, error = null
        where id = $1`,
      [run.id, failed > 0 ? 'partial' : 'succeeded', JSON.stringify(result.stats)],
    );
    await q(`update documents set status = 'ready' where id = $1`, [doc.id]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = run.attempts >= 3;
    await q(
      `update extraction_runs set status = $2, error = $3, finished_at = now() where id = $1`,
      [run.id, giveUp ? 'failed' : 'queued', message],
    );
    if (giveUp) {
      // The document stays viewable; only the fields record the failure.
      await markAllFailed(run.document_id, run.id, run.scope ?? null);
      await q(`update documents set status = 'ready' where id = $1`, [run.document_id]);
    }
    console.error('[jobs] run failed:', message);
    return true;
  }
}

async function writeMachineValue(
  documentId: string,
  runId: string,
  key: string,
  v: FieldValue,
) {
  const value = v.state === 'filled' ? JSON.stringify(v.value) : null;
  const emptyReason = v.state === 'empty' ? v.reason : null;
  const grounding = JSON.stringify(v.state === 'filled' ? v.grounding : { kind: 'ungrounded' });
  const violations = JSON.stringify(v.state === 'filled' ? v.violations : []);

  await q(
    MACHINE_WRITE,
    [randomUUID(), documentId, runId, key, value, emptyReason, grounding, violations],
  );
}

/** Human-owned values are never rewritten, but their violations must stay true. */
async function refreshHumanViolations(
  documentId: string,
  violations: Record<string, any[]>,
) {
  const humans = await q<any>(
    `select field_key from field_values where document_id = $1 and source = 'human'`,
    [documentId],
  );
  for (const row of humans) {
    await q(
      `update field_values set violations = $3, updated_at = now()
        where document_id = $1 and field_key = $2`,
      [documentId, row.field_key, JSON.stringify(violations[row.field_key] ?? [])],
    );
  }
}

async function markAllFailed(documentId: string, runId: string, scope: string[] | null) {
  const targets = FIELDS.filter((f) => !scope || scope.includes(f.key));
  for (const def of targets) {
    await writeMachineValue(documentId, runId, def.key, {
      state: 'empty',
      reason: 'extraction_failed',
    });
  }
}

let timer: NodeJS.Timeout | null = null;

export function startLoop(intervalMs = 750) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      while (await runOnce()) { /* drain */ }
    } finally {
      busy = false;
    }
  }, intervalMs);
}
