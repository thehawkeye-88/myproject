import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? join(here, '..', '..', 'data', 'pgdata');

// PGlite creates the final directory itself, but its parent must already exist.
mkdirSync(dirname(dataDir), { recursive: true });

export const db = await PGlite.create(dataDir);

await db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

export type Row = Record<string, any>;

export async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params as any[]);
  return res.rows;
}

export async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    const out = await fn();
    await db.exec('commit');
    return out;
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}
