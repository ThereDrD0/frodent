import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated fixture: no real backend, databases, package manager or existing ports.
const fixture = await mkdtemp(join(tmpdir(), 'ryadom-launch-test-'));
const front = join(fixture, 'frondent');
const back = join(fixture, 'todo_list_cpp');
const bin = join(fixture, 'bin');
const processes = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server, number = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(number, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() { const server = createServer(); const number = await listen(server); await new Promise(resolve => server.close(resolve)); return number; }
function start(env, args = [], entry = 'start.mjs') {
  const child = spawn(process.execPath, [join(front, entry), ...args], { cwd: tmpdir(), env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const ended = new Promise(resolve => child.once('close', code => { processes.delete(child); resolve(code); }));
  return { child, ended, output: () => output };
}
async function until(predicate, detail) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await predicate()) return; await sleep(50); }
  throw new Error(`Timed out: ${detail}`);
}
const db = createServer(socket => socket.end());
try {
  await mkdir(join(front, 'scripts'), { recursive: true });
  await mkdir(join(back, 'build'), { recursive: true });
  await mkdir(bin);
  await copyFile(new URL('../start.mjs', import.meta.url), join(front, 'start.mjs'));
  await copyFile(new URL('../start-frontend.mjs', import.meta.url), join(front, 'start-frontend.mjs'));
  await copyFile(new URL('./serve.mjs', import.meta.url), join(front, 'scripts/serve.mjs'));
  await writeFile(join(front, 'index.html'), '<h1>Fixture</h1>');
  // The fixture's dependency probe is mocked; actual missing libraries are tested separately.
  await writeFile(join(bin, 'ldd'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(back, 'build/petty_plusik'), `#!${process.execPath}\nconst fs=require('node:fs'); const http=require('node:http'); const config=JSON.parse(fs.readFileSync('../config.json')); if(process.env.FIXTURE_FAIL==='1') process.exit(7); const server=http.createServer((req,res)=>res.end('backend fixture')); server.listen(config.listeners[0].port,config.listeners[0].address); process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`, { mode: 0o700 });
  const databasePort = await listen(db);
  const config = { listeners: [{ address: '0.0.0.0', port: 5555 }], db_clients: [{ rdbms: 'postgresql', host: '127.0.0.1', port: databasePort, dbname: 'fixture' }], app: {}, custom_config: { fixture: true } };
  const original = JSON.stringify(config);
  await writeFile(join(back, 'config.json'), original);
  const frontendPort = await unusedPort(), backendPort = await unusedPort();
  const env = { PORT: String(frontendPort), BACKEND_PORT: String(backendPort) };
  const both = start(env);
  await until(() => both.output().includes('Остановка обоих серверов'), 'both servers ready: ' + both.output());
  assert.equal((await fetch(`http://127.0.0.1:${frontendPort}`)).status, 200);
  assert.equal(await (await fetch(`http://127.0.0.1:${backendPort}`)).text(), 'backend fixture');
  const sessions = await readdir(join(front, '.runtime'));
  assert.equal(sessions.length, 1);
  const runtimeConfig = join(front, '.runtime', sessions[0], 'config.json');
  assert.equal((await stat(runtimeConfig)).mode & 0o777, 0o600);
  const local = JSON.parse(await readFile(runtimeConfig, 'utf8'));
  assert.equal(local.listeners[0].address, '127.0.0.1');
  assert.equal(local.app.run_as_daemon, false);
  assert.equal(await readFile(join(back, 'config.json'), 'utf8'), original);
  both.child.kill('SIGTERM');
  await both.ended;
  assert.deepEqual(await readdir(join(front, '.runtime')), []);
  await assert.rejects(fetch(`http://127.0.0.1:${frontendPort}`));
  await assert.rejects(fetch(`http://127.0.0.1:${backendPort}`));
  console.log('PASS: two-server launch, arbitrary working directory, loopback-only copy, config permissions, untouched backend, shutdown and cleanup.');
  const frontend = start(env, ['--frontend']);
  await until(() => frontend.output().includes('Остановка обоих серверов'), 'frontend ready');
  const occupied = start(env, ['--frontend']);
  assert.equal(await occupied.ended, 1);
  assert.match(occupied.output(), /занят или недоступен/);
  assert.equal((await fetch(`http://127.0.0.1:${frontendPort}`)).status, 200);
  frontend.child.kill('SIGINT'); await frontend.ended;
  console.log('PASS: frontend-only mode, occupied port preserved, Ctrl+C signal.');
  const shortcut = start(env, [], 'start-frontend.mjs');
  await until(() => shortcut.output().includes('Остановка обоих серверов'), 'frontend shortcut ready');
  assert.equal((await fetch(`http://127.0.0.1:${frontendPort}`)).status, 200);
  shortcut.child.kill('SIGTERM'); await shortcut.ended;
  console.log('PASS: argument-free frontend shortcut.');
  const failed = start({ ...env, FIXTURE_FAIL: '1' });
  assert.equal(await failed.ended, 1);
  assert.deepEqual(await readdir(join(front, '.runtime')), []);
  await assert.rejects(fetch(`http://127.0.0.1:${frontendPort}`));
  console.log('PASS: backend exit aborts startup and removes temporary configuration.');
  const invalid = start({ ...env, PORT: 'invalid' });
  assert.equal(await invalid.ended, 1);
  assert.match(invalid.output(), /Порт должен/);
  console.log('PASS: invalid port rejected.');
} finally {
  for (const child of processes) child.kill('SIGTERM');
  await until(() => processes.size === 0, 'fixture processes stopped');
  await new Promise(resolve => db.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
