import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS, render, truthOf } from './corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'data', 'samples');
mkdirSync(out, { recursive: true });

const API = process.env.API ?? 'http://localhost:8787';

const built: { file: string; bytes: Buffer }[] = [];
for (const spec of CORPUS) {
  const bytes = await render(spec);
  writeFileSync(join(out, spec.file), bytes);
  writeFileSync(join(out, spec.file.replace(/\.pdf$/, '.truth.json')),
    JSON.stringify({ tests: spec.tests, layout: spec.layout, truth: truthOf(spec) }, null, 2));
  built.push({ file: spec.file, bytes });
}
console.log(`Wrote ${built.length} sample invoices (and their ground truth) to ${out}`);

let reachable = false;
try { reachable = (await fetch(`${API}/health`)).ok; } catch { /* server not running */ }
if (!reachable) {
  console.log(`Server not reachable at ${API}. Start it with ./run dev, then re-run ./run seed.`);
  process.exit(0);
}

for (const { file, bytes } of built) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), file);
  const res = await fetch(`${API}/api/documents`, { method: 'POST', body: form });
  console.log(`  ${res.status}  ${file}`);
}
console.log('Seeded. Extraction runs in the background.');
