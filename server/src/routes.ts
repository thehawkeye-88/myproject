import { Hono } from 'hono';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELD_BY_KEY } from '@docreview/shared';
import type { Json } from '@docreview/shared';
import { q, one } from './db.js';
import { extractTextLayer } from './textlayer.js';
import { enqueue } from './jobs.js';
import { fieldsFor, countsOf, rowToField, recomputeViolations } from './fields.js';
import { HUMAN_EDIT, REVERT } from './sql.js';
import { parseByType } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const filesDir = process.env.FILES_DIR ?? join(here, '..', '..', 'data', 'files');
mkdirSync(filesDir, { recursive: true });

export const api = new Hono();

api.get('/documents', async (c) => {
  const docs = await q<any>(
    `select id, filename, status, page_count, created_at from documents order by created_at desc`,
  );
  const out = [];
  for (const d of docs) {
    const fields = await fieldsFor(d.id);
    out.push({
      id: d.id,
      filename: d.filename,
      status: d.status,
      pageCount: d.page_count,
      createdAt: d.created_at,
      counts: countsOf(fields),
    });
  }
  return c.json(out);
});

api.post('/documents', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'no file' }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');

  const dupe = await one<any>(`select id, status from documents where sha256 = $1`, [sha]);
  if (dupe) return c.json({ id: dupe.id, status: dupe.status, duplicate: true });

  const id = randomUUID();
  writeFileSync(join(filesDir, `${id}.pdf`), bytes);

  let layer;
  try {
    layer = await extractTextLayer(bytes);
  } catch (err) {
    await q(
      `insert into documents (id, filename, sha256, status) values ($1, $2, $3, 'failed')`,
      [id, file.name, sha],
    );
    return c.json({ error: `could not read PDF: ${(err as Error).message}` }, 422);
  }

  await q(
    `insert into documents
       (id, filename, sha256, status, page_count, text_layer, page_geometry, char_boxes, text_density)
     values ($1, $2, $3, 'text_extracted', $4, $5, $6, $7, $8)`,
    [
      id, file.name, sha, layer.pageCount, layer.text,
      JSON.stringify(layer.pageGeometry), JSON.stringify(layer.charBoxes), layer.textDensity,
    ],
  );

  await enqueue(id);
  return c.json({ id, status: 'extracting' }, 202);
});

api.get('/documents/:id', async (c) => {
  const id = c.req.param('id');
  const d = await one<any>(`select * from documents where id = $1`, [id]);
  if (!d) return c.json({ error: 'not found' }, 404);

  const run = await one<any>(
    `select status, error, usage from extraction_runs
      where document_id = $1 order by created_at desc limit 1`,
    [id],
  );
  const fields = await fieldsFor(id);

  return c.json({
    id: d.id,
    filename: d.filename,
    status: d.status,
    pageCount: d.page_count,
    createdAt: d.created_at,
    counts: countsOf(fields),
    textLayer: d.text_layer,
    pageGeometry: d.page_geometry,
    charBoxes: d.char_boxes,
    runStatus: run?.status ?? null,
    runError: run?.error ?? null,
    usage: run?.usage ?? null,
  });
});

api.get('/documents/:id/file', async (c) => {
  const id = c.req.param('id');
  const path = join(filesDir, `${id}.pdf`);
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
  const { readFileSync } = await import('node:fs');
  return c.body(readFileSync(path), 200, { 'Content-Type': 'application/pdf' });
});

api.get('/documents/:id/fields', async (c) => {
  const id = c.req.param('id');
  const d = await one<any>(`select status from documents where id = $1`, [id]);
  if (!d) return c.json({ error: 'not found' }, 404);
  const fields = await fieldsFor(id);
  return c.json({ status: d.status, counts: countsOf(fields), fields });
});

api.post('/documents/:id/extract', async (c) => {
  const id = c.req.param('id');
  type Body = { scope?: 'all' | 'failed' | string[] };
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);
  const scope = body.scope ?? 'failed';

  let keys: string[] | null = null;
  if (Array.isArray(scope)) keys = scope;
  else if (scope === 'failed') {
    const fields = await fieldsFor(id);
    keys = fields
      .filter(
        (f) =>
          f.source === 'model' &&
          f.value.state === 'empty' &&
          (f.value.reason === 'extraction_failed' || f.value.reason === 'not_attempted'),
      )
      .map((f) => f.key);
    if (keys.length === 0) return c.json({ error: 'nothing to retry' }, 400);
  }

  const runId = await enqueue(id, keys);
  return c.json({ runId, scope: keys ?? 'all' }, 202);
});

api.patch('/fields/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    value?: Json; review?: 'pending' | 'accepted' | 'rejected'; revert?: boolean; version: number;
  }>();

  const current = await one<any>(`select * from field_values where id = $1`, [id]);
  if (!current) return c.json({ error: 'not found' }, 404);

  let updated: any = null;
  let touchedValue = false;

  if (body.revert) {
    updated = await one<any>(REVERT, [id, body.version]);
    touchedValue = true;
  } else if (body.value !== undefined) {
    const def = FIELD_BY_KEY[current.field_key];
    let value: Json | null = body.value;
    if (typeof value === 'string' && def) {
      const parsed = parseByType(def.type, value);
      if (!parsed.ok) return c.json({ error: parsed.why }, 400);
      value = parsed.value;
    }
    updated = await one<any>(HUMAN_EDIT, [id, body.version, JSON.stringify(value)]);
    touchedValue = true;
  } else if (body.review) {
    updated = await one<any>(
      `update field_values
          set review = $3, version = version + 1, updated_at = now()
        where id = $1 and version = $2
      returning *`,
      [id, body.version, body.review],
    );
  } else {
    return c.json({ error: 'nothing to change' }, 400);
  }

  if (!updated) {
    const fresh = rowToField(current);
    return c.json({ error: 'conflict', current: fresh }, 409);
  }

  if (touchedValue) {
    await recomputeViolations(current.document_id);
    updated = await one<any>(`select * from field_values where id = $1`, [id]);
  }

  return c.json(rowToField(updated));
});

api.get('/documents/:id/export', async (c) => {
  const id = c.req.param('id');
  const format = c.req.query('format') ?? 'json';
  const force = c.req.query('force') === '1';
  const fields = await fieldsFor(id);
  const unresolved = fields.filter((f) => f.review === 'pending');

  // Exporting unreviewed data is the one way this product can do harm: a
  // spreadsheet that looks checked but isn't. Blocked by default, overridable
  // explicitly, and the override is recorded in what comes out.
  if (unresolved.length > 0 && !force) {
    return c.json(
      {
        error: 'unreviewed',
        message: `${unresolved.length} of ${fields.length} fields have not been reviewed.`,
        unreviewedCount: unresolved.length,
        unreviewedKeys: unresolved.map((f) => f.key),
        override: `${c.req.path}?format=${format}&force=1`,
      },
      409,
    );
  }

  const exportedAt = new Date().toISOString();

  if (format === 'csv') {
    const head = 'field_key,label,value,state,grounding,review,source,priority,reason';
    const rows = fields.map((f) =>
      [
        f.key,
        f.label,
        f.value.state === 'filled' ? f.value.value : '',
        f.value.state === 'filled' ? 'filled' : f.value.reason,
        f.value.state === 'filled' ? f.value.grounding.kind : '',
        f.review,
        f.source,
        f.priority,
        f.priorityReason,
      ].map(csv).join(','),
    );
    // The annotation goes in the filename rather than a comment row, so the CSV
    // stays parseable by everything that reads CSVs. Per-field review status is
    // already a column.
    const name = unresolved.length
      ? `${id}-UNREVIEWED-${unresolved.length}.csv`
      : `${id}.csv`;
    return c.body([head, ...rows].join('\n'), 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Unreviewed-Count': String(unresolved.length),
    });
  }

  return c.json({
    documentId: id,
    exportedAt,
    reviewComplete: unresolved.length === 0,
    unreviewedCount: unresolved.length,
    unreviewedKeys: unresolved.map((f) => f.key),
    fields,
  });
});

const csv = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
