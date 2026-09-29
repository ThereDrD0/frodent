# Запуск проекта

## Полный стек

Проект запускается без соседнего репозитория и без C++ сервера. Из каталога `frondent` выполните:

```sh
./start-docker.sh
# или
npm run start:docker
```

Скрипт проверяет Docker Compose v2, при первом запуске создаёт закрытый `.env` со случайными локальными секретами и запускает четыре контейнера:

- `db` — PostgreSQL 16;
- `migrate` — одноразовое применение SQL-миграций через Python;
- `api` — FastAPI/Uvicorn из `backend/`;
- `web` — текущий статический интерфейс и same-origin proxy.

Откройте `http://127.0.0.1:4173`. Изменить порт можно в `.env` через `APP_PORT`. Остановка `Ctrl+C` или `docker compose --project-name ryadom down` сохраняет named volumes. Команда `down -v` удаляет базу и файлы.

Полное описание переменных, API, backup/restore и интеграционных тестов находится в [backend/README.md](../backend/README.md).

## Только локальный интерфейс

Если Docker пока не нужен, можно запустить редактор без API:

```sh
npm run start:frontend
```

В этом режиме сохраняются локальная IndexedDB доски и синхронизация вкладок через BroadcastChannel. Регистрация, серверные снимки и серверные вложения доступны только после запуска полного Docker стека.

## Проверки

```sh
npm test
node scripts/proxy-test.mjs
node scripts/board-test.mjs
./scripts/test-backend.sh
```

Последняя команда требует Docker Compose v2, потому что поднимает изолированный PostgreSQL в отдельном Compose project. Без Docker можно запустить unit-проверки Python:

```sh
cd backend
uv run --locked --group dev python -m pytest
```

## Совместимость старых файлов

Файл `start.mjs` и старые документы с упоминанием C++ сохранены только как исторические материалы прежнего frontend handoff. Они не участвуют в Docker-запуске Python API и не являются зависимостью этого проекта. Не запускайте старый режим `start.mjs` для развёртывания.
