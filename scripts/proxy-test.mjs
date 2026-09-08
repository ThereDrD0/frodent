import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const mock = createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'Success', data: { path: req.url, method: req.method, body: body ? JSON.parse(body) : null, authorization: req.headers.authorization || null } }));
  });
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
  assert.equal((await fetch(origin + '/api/v1/users/me')).status, 404);
  assert.equal((await fetch(origin + '/.runtime/session/config.json')).status, 404);
  assert.equal((await fetch(origin + '/api/v1/notes', { method: 'POST', headers: { Origin: 'http://outside.invalid' }, body: '{}' })).status, 403);
  const head = await fetch(origin); assert.ok(head.headers.get('content-security-policy').includes("connect-src 'self'"));
  await new Promise(resolve => mock.close(resolve));
  const unavailable = await fetch(origin + '/api/v1/notes/42'); assert.equal(unavailable.status, 503); assert.match((await unavailable.json()).message, /C\+\+-сервер недоступен/);
  console.log('PASS: proxy email login, JSON snapshot, Bearer forwarding, route allowlist, private files, cross-origin rejection, CSP and unavailable backend.');
} finally { child.kill('SIGTERM'); await exited; if (mock.listening) await new Promise(resolve => mock.close(resolve)); }
