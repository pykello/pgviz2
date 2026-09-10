import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { Database } from './db';
import { Demo } from './demo';
import { Playground } from './playground';
import { WalReader } from './wal';
import { InputError } from '../shared/tree';
import type { Route } from '../shared/types';
const production = process.argv.includes('--production');
const demo = process.argv.includes('--demo') || !process.env.DATABASE_URL;
const provider = demo ? new Demo() : new Database(process.env.DATABASE_URL!);
const playground = demo ? null : new Playground(process.env.DATABASE_URL!);
const wal = demo ? null : new WalReader(process.env.DATABASE_URL!);
const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 5433);
const root = fileURLToPath(new URL('../../', import.meta.url));
const vite = production ? null : await (await import('vite')).createServer({ configFile: resolve(root, 'vite.config.ts'), server: { middlewareMode: true, hmr: { port: port + 10000 } }, appType: 'spa' });
const routes = new Set<Route>(['status', 'relations', 'tree', 'node', 'heap', 'map']);
// Buffer.toJSON runs before a JSON replacer: normalize bytea recursively first.
function jsonSafe(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, jsonSafe(value)]));
  return v;
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const authority = req.headers.host ?? '';
  // SSH forwarding preserves the browser's Host, including its local port.
  // Accept loopback authorities independently of the backend's listening port.
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(authority);
  if (!localHost || (localHost[2] !== undefined && (Number(localHost[2]) < 1 || Number(localHost[2]) > 65535))) { res.writeHead(403).end('Invalid Host'); return; }
  const browserOrigin = new URL(`http://${authority}`).origin;
  if (req.headers.origin && req.headers.origin !== browserOrigin) { res.writeHead(403).end('Cross-origin access denied'); return; }
  const url = new URL(req.url ?? '/', `http://${authority}`);
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/wal') {
      if (req.method !== 'POST' || req.headers['x-pgviz-command'] !== '1' || req.headers['content-type'] !== 'application/json') { res.writeHead(405).end(JSON.stringify({ error: 'WAL access requires a JSON POST with X-Pgviz-Command: 1.' })); return; }
      if (!wal) { res.writeHead(400).end(JSON.stringify({ error: 'WAL capture needs a live PostgreSQL connection (DATABASE_URL).' })); return; }
      try {
        let body = '';
        for await (const chunk of req) { body += String(chunk); if (body.length > 4096) throw new InputError('WAL request too large.'); }
        const input = JSON.parse(body) as { action?: string; token?: string } | null;
        if (!input || typeof input !== 'object') throw new InputError('Invalid WAL request.');
        if (input.action === 'status') res.end(JSON.stringify(await wal.status()));
        else if (input.action === 'start') res.end(JSON.stringify(await wal.start()));
        else if (typeof input.token === 'string' && input.action === 'poll') res.end(JSON.stringify(await wal.poll(input.token)));
        else if (typeof input.token === 'string' && input.action === 'stop') { await wal.stop(input.token); res.end('{}'); }
        else throw new InputError('Unknown WAL action.');
      } catch (error) { res.writeHead(error instanceof InputError || error instanceof SyntaxError ? 400 : 503).end(JSON.stringify({ error: error instanceof Error ? error.message : 'WAL capture failed.' })); }
      return;
    }
    if (url.pathname === '/api/command') {
      if (req.method !== 'POST' || req.headers['x-pgviz-command'] !== '1' || req.headers['content-type'] !== 'application/json') { res.writeHead(405).end(JSON.stringify({ error: 'Commands require a JSON POST with X-Pgviz-Command: 1.' })); return; }
      if (!playground) { res.writeHead(400).end(JSON.stringify({ error: 'Commands need a live PostgreSQL connection. Start pgviz with DATABASE_URL.' })); return; }
      try {
        let body = '';
        for await (const chunk of req) { body += String(chunk); if (body.length > 4096) throw new InputError('Command request is too large.'); }
        const input: unknown = JSON.parse(body);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid command request.');
        res.end(JSON.stringify(await playground.execute(input)));
      } catch (error) { res.writeHead(error instanceof InputError || error instanceof SyntaxError ? 400 : 503).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed.' })); }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(JSON.stringify({ error: 'Only GET is supported.' })); return; }
    const route = url.pathname.slice(5) as Route;
    if (!routes.has(route)) { res.writeHead(404).end(JSON.stringify({ error: 'Unknown API route.' })); return; }
    try { res.end(JSON.stringify(jsonSafe(await provider.request(route, Object.fromEntries(url.searchParams))))); }
    catch (error) {
      const e = error as Error & { code?: string };
      const message = e.code === '42501' ? 'pageinspect requires a PostgreSQL superuser connection.' : e.message;
      res.writeHead(error instanceof InputError ? 400 : 503).end(JSON.stringify({ error: message }));
    }
    return;
  }
  if (vite) { vite.middlewares(req, res); return; }
  try {
    const base = resolve(root, 'dist');
    const path = resolve(base, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(path);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(port, host, () => console.log(`pgviz · http://${host}:${port} · ${demo ? 'DEMO (illustrative data)' : 'live PostgreSQL'}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); void Promise.all([provider.close(), wal?.close(), vite?.close()]).then(() => process.exit(0)); });
