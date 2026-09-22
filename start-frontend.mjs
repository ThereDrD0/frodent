#!/usr/bin/env node

if (process.argv.length !== 2) {
  console.error('Этот скрипт запускается без аргументов. Для справки используйте start.mjs --help.');
  process.exitCode = 1;
} else {
  process.argv.push('--frontend');
  await import('./start.mjs');
}
