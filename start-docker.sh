#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker не найден. Установите и запустите Docker с Compose v2.' >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Нужен плагин Docker Compose v2.' >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  if ! command -v od >/dev/null 2>&1; then
    printf '%s\n' 'Не найден генератор случайных байтов od.' >&2
    exit 1
  fi
  DB_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  APP_DB_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  API_SECRET="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
  ADMIN_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  cat > .env <<EOF
APP_PORT=4173
POSTGRES_DB=ryadom
POSTGRES_USER=ryadom
POSTGRES_ADMIN_USER=ryadom_admin
POSTGRES_PASSWORD=$DB_SECRET
POSTGRES_APP_PASSWORD=$APP_DB_SECRET
JWT_SECRET=$API_SECRET
PUBLIC_APP_URL=http://127.0.0.1:4173
ALLOWED_ORIGINS=http://127.0.0.1:4173,http://localhost:4173
ADMIN_EMAIL=
ADMIN_SETUP_TOKEN=$ADMIN_SECRET
EOF
  chmod 600 .env
  printf '%s\n' 'Создан локальный .env со случайными секретами.'
fi

if grep -Eq '^(POSTGRES_PASSWORD|POSTGRES_APP_PASSWORD|JWT_SECRET)=replace-' .env; then
  printf '%s\n' '.env содержит примеры секретов. Удалите .env, чтобы создать случайные локальные значения, или задайте свои секреты.' >&2
  exit 1
fi

APP_PORT="$(sed -n 's/^APP_PORT=//p' .env | tail -n 1)"
APP_PORT="${APP_PORT:-4173}"
if ! [[ "$APP_PORT" =~ ^[0-9]{1,5}$ ]] || (( APP_PORT < 1 || APP_PORT > 65535 )); then
  printf '%s\n' 'APP_PORT должен быть числом от 1 до 65535.' >&2
  exit 1
fi
if command -v node >/dev/null 2>&1; then
  if ! PORT_TO_CHECK="$APP_PORT" node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.env.PORT_TO_CHECK),"127.0.0.1",()=>s.close(()=>process.exit(0)));'; then
    printf 'Порт %s занят. Освободите его или задайте APP_PORT=4174 в .env. Чужие процессы не остановлены.\n' "$APP_PORT" >&2
    exit 1
  fi
fi

printf 'Запускаю доску на http://127.0.0.1:%s. Остановка: Ctrl+C. Данные сохраняются в Docker volumes.\n' "$APP_PORT"
exec docker compose --project-name ryadom --project-directory "$ROOT" up --build
