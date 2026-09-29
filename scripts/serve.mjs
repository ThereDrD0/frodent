import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const boardPath = new RegExp(`^/api/v1/boards/${uuid}(?:/(?:operations|members|members/${uuid}|invite|session|attachments|attachments/${uuid}))?$`);
const backendHost = process.env.BACKEND_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', 'api'].includes(backendHost)) throw new Error('BACKEND_HOST разрешает только localhost, 127.0.0.1 или Docker-сервис api.');

function allowedRoute(method, path) {
  if (method === 'POST' && ['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout', '/api/v1/users/register', '/api/v1/users/login', '/api/v1/notes', '/api/v1/board-invites/accept'].includes(path)) return true;
  if (method === 'POST' && path === '/api/v1/boards') return true;
  if (method === 'GET' && ['/api/v1/users/me', '/api/v1/boards', '/api/v1/admin/users', '/health/live', '/health/ready'].includes(path)) return true;
  if (method === 'GET' && ['/openapi.json', '/api/docs'].includes(path)) return true;
  if (method === 'GET' && /^\/api\/v1\/notes\/\d+$/.test(path)) return true;
  if (method === 'GET' && new RegExp(`^/api/v1/boards/${uuid}$`).test(path)) return true;
  if (method === 'PATCH' && (new RegExp(`^/api/v1/boards/${uuid}$`).test(path) || new RegExp(`^/api/v1/admin/users/${uuid}$`).test(path))) return true;
  if (method === 'POST' && boardPath.test(path) && /\/(operations|invite|session|attachments)$/.test(path)) return true;
  if (method === 'GET' && boardPath.test(path) && /\/(operations|members|attachments\/[^/]+)$/.test(path)) return true;
  if (method === 'DELETE' && boardPath.test(path) && /\/(invite|members\/[^/]+)$/.test(path)) return true;
  return false;
}

function allowedQuery(path, params) {
  const allowed = path === '/api/v1/boards' || path === '/api/v1/admin/users' ? new Set(['limit', 'offset']) : path.endsWith('/operations') ? new Set(['afterSeq', 'limit']) : new Set();
  for (const [key, value] of params) {
    if (!allowed.has(key) || !/^\d{1,12}$/.test(value)) return false;
  }
  return true;
}

function proxy(req, res, parsed) {
  const path = parsed.pathname;
  // Same-origin allowlist; the upstream is a fixed loopback or Compose service.
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
  if (!allowedRoute(req.method, path) || !allowedQuery(path, parsed.searchParams)) { res.writeHead(404).end(); return; }
  const targetPort = Number(process.env.BACKEND_PORT || 5555);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) { res.writeHead(503).end(); return; }
  const maxBytes = path.endsWith('/attachments') ? 21 * 1024 * 1024 : path === '/api/v1/notes' ? 850 * 1024 : 1024 * 1024;
  if (Number(req.headers['content-length']) > maxBytes) { res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'Error', code: 'REQUEST_TOO_LARGE', message: 'Запрос превышает допустимый размер.' })); return; }
  let bytes = 0;
  const upstream = httpRequest({ hostname: backendHost, port: targetPort, path: path + parsed.search, method: req.method, headers: { ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}), ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(req.headers['idempotency-key'] ? { 'Idempotency-Key': req.headers['idempotency-key'] } : {}), ...(req.headers['content-length'] ? { 'Content-Length': req.headers['content-length'] } : {}) }, timeout: 30000 }, response => {
    const headers = { 'Cache-Control': response.headers['cache-control'] || 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of ['content-type', 'content-disposition', 'content-length', 'x-request-id']) if (response.headers[name]) headers[name] = response.headers[name];
    res.writeHead(response.statusCode, headers); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }); if (!res.writableEnded) res.end(JSON.stringify({ status: 'Error', code: 'BACKEND_UNAVAILABLE', message: 'Сервер доски недоступен. Запустите start-docker.sh.' })); });
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'Error', code: 'REQUEST_TOO_LARGE', message: 'Запрос превышает допустимый размер.' })); upstream.destroy(); }
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

function proxyWebSocket(req, socket, head, parsed) {
  const path = parsed.pathname;
  if (!new RegExp(`^/api/v1/boards/${uuid}/events$`).test(path) || [...parsed.searchParams.keys()].some(key => key !== 'ticket') || !parsed.searchParams.get('ticket') || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
  const targetPort = Number(process.env.BACKEND_PORT || 5555);
  const upstream = httpRequest({ hostname: backendHost, port: targetPort, path: path + parsed.search, headers: { ...(req.headers.origin ? { Origin: req.headers.origin } : {}), ...(req.headers['sec-websocket-key'] ? { 'Sec-WebSocket-Key': req.headers['sec-websocket-key'] } : {}), ...(req.headers['sec-websocket-version'] ? { 'Sec-WebSocket-Version': req.headers['sec-websocket-version'] } : {}), Connection: 'Upgrade', Upgrade: 'websocket' } });
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    const headers = response.rawHeaders.reduce((result, value, index, all) => index % 2 ? `${result}${all[index - 1]}: ${value}\r\n` : result, '');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.once('close', () => upstreamSocket.destroy());
    upstreamSocket.once('close', () => socket.destroy());
  });
  upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`); });
  upstream.on('error', () => socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'));
  socket.on('error', () => upstream.destroy());
  upstream.end();
}
const server = createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(parsed.pathname);
    if (path.startsWith('/api/') || path.startsWith('/health/') || path === '/openapi.json') { proxy(req, res, { pathname: path, search: parsed.search, searchParams: parsed.searchParams }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (path !== '/' && !/^\/(?:src|assets)\/[\w./-]+$/.test(path) && path !== '/index.html') { res.writeHead(404).end('Not found'); return; }
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !types[extname(file)]) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404).end('Not found'); }
});
server.on('upgrade', (req, socket, head) => {
  try { proxyWebSocket(req, socket, head, new URL(req.url, 'http://localhost')); }
  catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); }
});
server.listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => console.log(`Рядом: http://127.0.0.1:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
