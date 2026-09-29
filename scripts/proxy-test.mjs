import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const websocketSockets = new Set();
const mock = createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const isJson = req.headers['content-type']?.includes('application/json');
    res.end(JSON.stringify({ status: 'Success', data: { path: req.url, method: req.method, body: body && isJson ? JSON.parse(body) : null, bodyLength: body.length, contentType: req.headers['content-type'] || null, idempotencyKey: req.headers['idempotency-key'] || null, authorization: req.headers.authorization || null } }));
  });
});
mock.on('upgrade', (req, socket) => {
  websocketSockets.add(socket); socket.once('close', () => websocketSockets.delete(socket));
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Mock: websocket\r\n\r\n');
  socket.on('data', chunk => socket.write(chunk));
});
const backendPort = await listen(mock);
const probe = createServer(); const frontendPort = await listen(probe); await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], { env: { ...process.env, PORT: String(frontendPort), BACKEND_PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('close', resolve));
const origin = `http://127.0.0.1:${frontendPort}`;
try {
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  const login = await fetch(origin + '/api/v1/users/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture' }) });
  assert.equal((await login.json()).data.body.email, 'fixture@example.test');
  const snapshot = await fetch(origin + '/api/v1/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' }, body: JSON.stringify({ title: '[Доска] Тест', content: '{}' }) });
  const result = await snapshot.json(); assert.equal(result.data.authorization, 'Bearer fixture'); assert.equal(result.data.path, '/api/v1/notes');
  assert.equal((await fetch(origin + '/api/v1/notes/42')).status, 200);
  assert.equal((await fetch(origin + '/api/v1/notes/42', { method: 'PATCH' })).status, 404);
  const register = await fetch(origin + '/api/v1/users/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture-password', displayName: 'Анна' }) });
  assert.equal((await register.json()).data.body.displayName, 'Анна');
  assert.equal((await fetch(origin + '/api/v1/users/me', { headers: { Authorization: 'Bearer fixture' } })).status, 200);
  const boardId = 'b53c8fca-83bc-4db0-a8d3-757a536852cb';
  const boardCreate = await fetch(origin + '/api/v1/boards', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' }, body: JSON.stringify({ title: 'Идеи' }) });
  assert.equal((await boardCreate.json()).data.body.title, 'Идеи');
  const boardList = await fetch(origin + '/api/v1/boards?limit=25&offset=2', { headers: { Authorization: 'Bearer fixture' } });
  assert.equal((await boardList.json()).data.path, '/api/v1/boards?limit=25&offset=2');
  const adminList = await fetch(origin + '/api/v1/admin/users?limit=10&offset=0', { headers: { Authorization: 'Bearer fixture' } });
  assert.equal((await adminList.json()).data.path, '/api/v1/admin/users?limit=10&offset=0');
  const object = { id: 'd53c8fca-83bc-4db0-a8d3-757a536852cb', type: 'stroke', x: 1, y: 2, w: 12, h: 16, text: '', color: 'mint', points: [[1, 2], [8, 9]] };
  const operation = await fetch(`${origin}/api/v1/boards/${boardId}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' }, body: JSON.stringify({ opId: 'e53c8fca-83bc-4db0-a8d3-757a536852cb', objectId: object.id, action: 'create', baseRevision: 0, object }) });
  assert.equal((await operation.json()).data.body.object.points.length, 2);
  const form = new FormData(); form.append('file', new Blob(['fixture file'], { type: 'text/plain' }), 'fixture.txt');
  const upload = await fetch(`${origin}/api/v1/boards/${boardId}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Idempotency-Key': 'f53c8fca-83bc-4db0-a8d3-757a536852cb' }, body: form });
  const uploaded = await upload.json(); assert.match(uploaded.data.contentType, /^multipart\/form-data; boundary=/); assert.equal(uploaded.data.idempotencyKey, 'f53c8fca-83bc-4db0-a8d3-757a536852cb'); assert.ok(uploaded.data.bodyLength > 10);
  const forwardedUpload = await fetch(`${origin}/api/v1/boards/${boardId}/attachments`, { method: 'POST', headers: { 'Idempotency-Key': 'x' }, body: form });
  assert.equal((await forwardedUpload.json()).data.idempotencyKey, 'x');
  assert.equal((await fetch(`${origin}/api/v1/boards?unexpected=1`)).status, 404);
  assert.equal((await fetch(origin + '/.runtime/session/config.json')).status, 404);
  assert.equal((await fetch(origin + '/api/v1/notes', { method: 'POST', headers: { Origin: 'http://outside.invalid' }, body: '{}' })).status, 403);
  const head = await fetch(origin); assert.ok(head.headers.get('content-security-policy').includes("connect-src 'self'"));

  const socket = await new Promise((resolve, reject) => {
    const client = createConnection(frontendPort, '127.0.0.1'); let response = '';
    client.once('error', reject);
    client.on('data', chunk => { response += chunk.toString(); if (response.includes('\r\n\r\n')) resolve({ client, response }); });
    client.on('connect', () => client.write(`GET /api/v1/boards/${boardId}/events?ticket=one-time HTTP/1.1\r\nHost: 127.0.0.1:${frontendPort}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  });
  assert.match(socket.response, /101 Switching Protocols/); assert.match(socket.response, /X-Mock: websocket/i);
  const echoed = Promise.race([new Promise(resolve => socket.client.once('data', chunk => resolve(chunk.toString()))), new Promise((_, reject) => setTimeout(() => reject(new Error('WebSocket tunnel did not echo its payload.')), 3000))]); socket.client.write('probe');
  assert.equal(await echoed, 'probe'); socket.client.destroy();
  for (const fixtureSocket of websocketSockets) fixtureSocket.destroy();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  const unavailable = await fetch(origin + '/api/v1/notes/42'); assert.equal(unavailable.status, 503); assert.match((await unavailable.json()).message, /Сервер доски недоступен/);
  console.log('PASS: Python API account and board routes, query validation, multipart attachment and idempotency headers, WebSocket upgrade, CSP, cross-origin rejection and unavailable backend.');
} finally {
  child.kill('SIGTERM'); await exited;
  for (const socket of websocketSockets) socket.destroy();
  mock.closeAllConnections();
  if (mock.listening) await new Promise(resolve => mock.close(resolve));
}
