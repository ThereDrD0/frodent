#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const backend = resolve(root, '../todo_list_cpp');
const frontendOnly = process.argv.includes('--frontend');
const children = new Set();
let runtime, stopping = false, shutdownPromise;
const run = promisify(execFile);
const delay = ms => new Promise(done => setTimeout(done, ms));

function port(value, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Порт должен быть целым числом от 1 до 65535.');
  return result;
}

function freePort(number) {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', () => fail(new Error(`Порт ${number} занят или недоступен. Уже запущенные приложения не остановлены.`)));
    probe.listen(number, '127.0.0.1', () => probe.close(done));
  });
}

function reachable(host, number) {
  return new Promise(done => {
    const socket = createConnection({ host, port: number });
    const finish = value => { socket.destroy(); done(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function launch(command, args, options, label) {
  if (stopping) throw new Error('Запуск отменён.');
  const child = spawn(command, args, { ...options, stdio: 'inherit' });
  children.add(child);
  child.once('error', error => { console.error(`${label}: ${error.message}`); void shutdown(1); });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} завершился (${signal || code}). Останавливаю второй сервер.`);
      void shutdown(1);
    }
  });
  return child;
}

async function ready(child, number, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stopping || child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} не запущен.`);
    if (await reachable('127.0.0.1', number)) return;
    await delay(100);
  }
  throw new Error(`${label} не открыл порт ${number} за время ожидания.`);
}

function shutdown(code) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  process.exitCode = code;
  shutdownPromise = (async () => {
    await Promise.all([...children].map(child => new Promise(done => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return done();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill('SIGTERM');
    })));
    if (runtime) await rm(runtime, { recursive: true, force: true });
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => { console.log('\nОстанавливаю запущенные скриптом серверы…'); void shutdown(130); });
process.once('SIGTERM', () => { void shutdown(143); });

async function main() {
  if (process.argv.includes('--help')) {
    console.log('node frondent/start.mjs             — фронтенд и C++-сервер\nnode frondent/start.mjs --frontend  — только локальный редактор\nПеременные: PORT=4173, BACKEND_PORT=5555, BACKEND_BINARY=/путь/к/бинарнику.\nPostgreSQL должна быть подготовлена заранее. Скрипт не устанавливает ПО и не запускает системные службы.');
    return;
  }
  if (process.argv.slice(2).some(arg => arg !== '--frontend')) throw new Error('Неизвестный аргумент. Используйте --help.');
  const frontendPort = port(process.env.PORT, 4173);
  let config, binary, backendPort;
  if (!frontendOnly) {
    binary = resolve(process.env.BACKEND_BINARY || join(backend, 'build/petty_plusik'));
    try { await access(binary, constants.X_OK); }
    catch { throw new Error(`Нет исполняемого C++-сервера: ${binary}. Нужна сборка от бэкендера; автоматическая сборка отключена, поскольку CMake скачивает jwt-cpp. Для редактора: node ${join(root, 'start.mjs')} --frontend`); }
    const { stdout } = await run('ldd', [binary]);
    const missing = stdout.split('\n').filter(line => line.includes('not found')).map(line => line.trim().split(' ')[0]);
    if (missing.length) throw new Error(`C++-серверу не хватает библиотек: ${missing.join(', ')}.\nПередайте список бэкендеру для совместимой сборки. Подробности: frondent/docs/STARTUP.md.\nПока можно запустить редактор: node ${join(root, 'start.mjs')} --frontend`);
    config = JSON.parse(await readFile(join(backend, 'config.json'), 'utf8'));
    backendPort = port(process.env.BACKEND_PORT, config.listeners?.[0]?.port ?? 5555);
    if (backendPort === frontendPort) throw new Error('PORT и BACKEND_PORT должны различаться.');
    for (const db of config.db_clients || []) {
      if (db.rdbms !== 'postgresql') throw new Error('Скрипт рассчитан на PostgreSQL из текущего проекта.');
      const host = db.host || '127.0.0.1';
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Запуск отменён: PostgreSQL настроена на внешний адрес. Разрешён только localhost.');
      if (!(await reachable(host, port(db.port, 5432)))) throw new Error(`PostgreSQL недоступна на ${host}:${db.port || 5432}. Нужна готовая база ${db.dbname || 'notes_db'} и учётная запись из config.json. Скрипт не создаёт БД и не управляет системными службами. Для работы без БД используйте --frontend.`);
    }
    await freePort(backendPort);
  }
  await freePort(frontendPort);
  if (stopping) return;
  if (!frontendOnly) {
    const runtimeRoot = join(root, '.runtime');
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    runtime = await mkdtemp(join(runtimeRoot, 'session-'));
    const work = join(runtime, 'work');
    await mkdir(join(work, 'public'), { recursive: true });
    // main.cc reads ../config.json relative to cwd. Keep that contract without
    // writing config, logs or uploads into the backend source directory.
    config.listeners = [{ address: '127.0.0.1', port: backendPort, https: false }];
    config.app = { ...config.app, document_root: './public', upload_path: './uploads', locations: [], load_dynamic_views: false, run_as_daemon: false, relaunch_on_error: false, handle_sig_term: true, reuse_port: false };
    config.app.log = { ...config.app.log, log_path: work };
    config.plugins = (config.plugins || []).map(plugin => plugin.name === 'drogon::plugin::AccessLogger' ? { ...plugin, config: { ...plugin.config, log_path: work } } : plugin);
    await writeFile(join(runtime, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const server = launch(binary, [], { cwd: work }, 'Бэкенд');
    await ready(server, backendPort, 'Бэкенд');
    console.log(`Бэкенд: http://127.0.0.1:${backendPort}`);
  }
  const frontend = launch(process.execPath, [join(root, 'scripts/serve.mjs')], { cwd: root, env: { ...process.env, PORT: String(frontendPort), BACKEND_PORT: String(backendPort || process.env.BACKEND_PORT || 5555) } }, 'Фронтенд');
  await ready(frontend, frontendPort, 'Фронтенд');
  console.log(`Откройте http://127.0.0.1:${frontendPort}\nДоска сохраняется в браузере; вход и снимки C++ API — через «Совместная работа». Синхронизация между устройствами требует доработки бэкенда.\nОстановка обоих серверов — Ctrl+C.`);
}

try { await main(); }
catch (error) { if (!stopping) console.error(`Ошибка запуска: ${error.message}`); await shutdown(stopping ? process.exitCode : 1); }
finally { if (stopping && runtime) await rm(runtime, { recursive: true, force: true }); }
