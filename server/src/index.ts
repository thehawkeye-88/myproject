import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { startLoop } from './jobs.js';

const app = new Hono();

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  return next();
});

app.route('/api', api);
app.get('/health', (c) => c.json({ ok: true }));

// In production Render runs a single Node service. Serve the Vite build from
// the same origin so the browser can keep using /api without CORS configuration.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mjs': 'text/javascript; charset=UTF-8',
};

app.get('*', (c) => {
  const pathname = decodeURIComponent(new URL(c.req.url).pathname);
  const requested = normalize(join(webDist, pathname.replace(/^\/+/, '')));
  const rel = relative(webDist, requested);
  const safe = rel !== '..' && !rel.startsWith(`..${'/'}`) && rel !== '';
  const file = safe && existsSync(requested) ? requested : join(webDist, 'index.html');

  if (!existsSync(file)) return c.text('Frontend build not found', 404);

  return c.body(readFileSync(file), 200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
  });
});

startLoop();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
console.log(`[server] listening on 0.0.0.0:${port}`);
