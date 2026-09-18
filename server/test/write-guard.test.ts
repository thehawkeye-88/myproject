import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACHINE_WRITE, HUMAN_EDIT, REVERT } from '../src/sql.js';

const here = dirname(fileURLToPath(import.meta.url));
const DDL = readFileSync(join(here, '..', 'src', 'schema.sql'), 'utf8');

let db: PGlite;

// The real statements, imported rather than pasted, so this file cannot pass
// against a copy of a guard the server no longer uses.
const write = (id: string, run: string, key: string, value: unknown) =>
  db.query(MACHINE_WRITE, [id, 'doc', run, key, JSON.stringify(value), null, '{"kind":"ungrounded"}', '[]']);

beforeEach(async () => {
  db = new PGlite();
  await db.exec(DDL);
  await db.query(
    `insert into documents (id, filename, sha256, status) values ('doc', 'a.pdf', 'sha', 'ready')`,
  );
});

describe('machine write guard', () => {
  it('fills a gap on first write', async () => {
    await write('f1', 'run1', 'total', 100);
    const { rows } = await db.query<any>(`select value, source from field_values`);
    expect(rows[0].value).toBe(100);
    expect(rows[0].source).toBe('model');
  });

  it('updates its own earlier machine value', async () => {
    await write('f1', 'run1', 'total', 100);
    await write('f2', 'run2', 'total', 200);
    const { rows } = await db.query<any>(`select value, version from field_values`);
    expect(rows[0].value).toBe(200);
    expect(rows[0].version).toBe(2);
  });

  // The product's central invariant, enforced in SQL so no future code path
  // can forget it.
  it('cannot overwrite a human value, however many times it retries', async () => {
    await write('f1', 'run1', 'total', 100);
    await db.query(
      `update field_values set value = $1, source = 'human', original_value = value, version = version + 1
        where field_key = 'total'`,
      [JSON.stringify(999)],
    );

    for (const run of ['run2', 'run3', 'run4']) {
      await write(`f-${run}`, run, 'total', 1);
    }

    const { rows } = await db.query<any>(`select value, source, original_value from field_values`);
    expect(rows[0].value).toBe(999);
    expect(rows[0].source).toBe('human');
    expect(rows[0].original_value).toBe(100);
  });
});

describe('optimistic concurrency', () => {
  const PATCH = `
    update field_values set value = $3, version = version + 1
     where id = $1 and version = $2 returning *`;

  it('rejects a write carrying a stale version', async () => {
    await write('f1', 'run1', 'total', 100);

    const first = await db.query<any>(PATCH, ['f1', 1, JSON.stringify(200)]);
    expect(first.rows).toHaveLength(1);

    // Second tab, still holding version 1.
    const stale = await db.query<any>(PATCH, ['f1', 1, JSON.stringify(300)]);
    expect(stale.rows).toHaveLength(0);

    const { rows } = await db.query<any>(`select value, version from field_values`);
    expect(rows[0].value).toBe(200);
    expect(rows[0].version).toBe(2);
  });
});

describe('undo restores what the machine produced, not the previous correction', () => {
  const total = () =>
    db.query<any>(`select * from field_values where document_id = 'doc' and field_key = 'total'`)
      .then((r) => r.rows[0]);

  it('puts an unreadable field back to unreadable', async () => {
    await db.query(
      `insert into field_values (id, document_id, field_key, value, empty_reason, grounding)
       values ('f1', 'doc', 'total', null, 'unparseable', '{"kind":"ungrounded"}')`,
    );

    // A reviewer corrects the unreadable total, then corrects their correction.
    const a = await total();
    await db.query(HUMAN_EDIT, [a.id, a.version, JSON.stringify(6850.65)]);
    const b = await total();
    expect(b.source).toBe('human');
    expect(b.original_value).toBeNull();
    expect(b.original_empty_reason).toBe('unparseable');

    await db.query(HUMAN_EDIT, [b.id, b.version, JSON.stringify(9000)]);
    const c = await total();
    // The snapshot must still be the machine's state. Recording 6850.65 here —
    // which `coalesce(original_value, value)` did — makes undo restore the
    // reviewer's own first guess and label it as the extractor's output.
    expect(c.original_value).toBeNull();
    expect(c.original_empty_reason).toBe('unparseable');

    await db.query(REVERT, [c.id, c.version]);
    const d = await total();
    expect(d.value).toBeNull();
    expect(d.empty_reason).toBe('unparseable');
    expect(d.source).toBe('model');
  });

  it('restores the located span, so a reverted field is grounded again', async () => {
    await db.query(
      `insert into field_values (id, document_id, field_key, value, grounding)
       values ('f2', 'doc', 'total', '100',
               '{"kind":"grounded","span":{"start":4,"end":7},"page":1,"how":"exact"}')`,
    );
    const a = await total();
    await db.query(HUMAN_EDIT, [a.id, a.version, JSON.stringify(250)]);
    const b = await total();
    expect(b.grounding.kind).toBe('ungrounded');

    await db.query(REVERT, [b.id, b.version]);
    const c = await total();
    expect(c.value).toBe(100);
    expect(c.grounding).toEqual({ kind: 'grounded', span: { start: 4, end: 7 }, page: 1, how: 'exact' });
  });
});
