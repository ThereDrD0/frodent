import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function proxy(req, res, path) {
  // Same-origin bridge to the existing C++ server; no third-party destinations.
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
  const allowed = (req.method === 'POST' && ['/api/v1/users/login', '/api/v1/notes'].includes(path)) || (req.method === 'GET' && /^\/api\/v1\/notes\/\d+$/.test(path));
  if (!allowed) { res.writeHead(404).end(); return; }
  const targetPort = Number(process.env.BACKEND_PORT || 5555);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) { res.writeHead(503).end(); return; }
  let bytes = 0;
  const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort, path, method: req.method, headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, timeout: 9000 }, response => {
    res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ status: 'Error', message: 'C++-сервер недоступен. Запустите start.mjs после подготовки его зависимостей и PostgreSQL.' })); });
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'Error', message: 'Снимок больше 1 МБ.' })); upstream.destroy(); }
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.startsWith('/api/')) { proxy(req, res, path); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (path !== '/' && !/^\/(?:src|assets)\/[\w./-]+$/.test(path) && path !== '/index.html') { res.writeHead(404).end('Not found'); return; }
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !types[extname(file)]) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Рядом: http://127.0.0.1:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
