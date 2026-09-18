/**
 * Real-browser smoke test. Exists because a DOM dump proved insufficient: the
 * canvas element was present in the markup while the page rendered blank, and
 * the difference is only visible in pixels.
 *
 *   ./run smoke [documentId]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WEB = process.env.WEB ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:8787';
// Relative to this file: npm runs workspace scripts with cwd = the workspace.
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

const docs = await (await fetch(`${API}/api/documents`)).json();
const doc = process.argv[2]
  ? docs.find((d) => d.id === process.argv[2])
  : docs.find((d) => d.counts.needsReview > 0) ?? docs[0];
if (!doc) throw new Error('no documents — run ./run seed first');

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));

await page.goto(`${WEB}/?doc=${doc.id}`, { waitUntil: 'networkidle0', timeout: 30000 });

// Wait for the canvas to contain actual ink, not merely to exist.
let painted = false;
try {
  await page.waitForFunction(() => {
    const c = document.querySelector('.page canvas');
    if (!c || !c.width) return false;
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, Math.min(c.height, 400));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) return true;
    }
    return false;
  }, { timeout: 20000 });
  painted = true;
} catch { /* reported below */ }

// Snapshot before the deliberate bad edit below, so its expected 400 does not
// look like a page defect.
const loadProblems = [...problems];

const facts = await page.evaluate(() => ({
  rows: document.querySelectorAll('li.row').length,
  highlights: document.querySelectorAll('.highlight').length,
  violations: document.querySelectorAll('.row-violation').length,
  viewerError: document.querySelector('.viewer-error')?.textContent?.trim() ?? null,
  pill: document.querySelector('.pill')?.textContent?.trim() ?? null,
  queueFoot: document.querySelector('.queue-foot')?.textContent?.trim().slice(0, 90) ?? null,
  zoom: document.querySelector('.zoom')?.textContent ?? null,
}));

await page.screenshot({ path: `${OUT}/review.png` });

// Keyboard path: j moves, e opens the editor, Esc closes it.
await page.focus('.workspace');
await page.keyboard.press('j');
const afterJ = await page.evaluate(() => document.querySelector('li.row.selected')?.textContent?.slice(0, 40));
await page.keyboard.press('e');
const editorOpen = await page.evaluate(() => Boolean(document.querySelector('.editor')));
await page.keyboard.type('not-a-number');
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 1200));
const invalid = await page.evaluate(() => ({
  message: document.querySelector('.row-invalid')?.textContent?.trim() ?? null,
  draft: document.querySelector('.editor')?.value ?? null,
}));
await page.screenshot({ path: `${OUT}/invalid-edit.png` });
await page.keyboard.press('Escape');

const report = {
  document: doc.filename, painted, ...facts,
  afterJ, editorOpen, invalid,
  loadProblems,
  expected400FromBadEdit: problems.length > loadProblems.length,
};
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (!painted) { console.error('\nFAIL: the PDF canvas never painted.'); process.exit(1); }
if (!invalid.message) { console.error('\nFAIL: invalid edit produced no inline error.'); process.exit(1); }
if (invalid.draft !== 'not-a-number') { console.error('\nFAIL: the rejected draft was discarded.'); process.exit(1); }
if (loadProblems.length) { console.error('\nFAIL: console errors on load:', loadProblems); process.exit(1); }
console.log('\nsmoke ok');
