# Python API для доски «Рядом»

Это самостоятельный backend проекта. Для работы не нужен соседний репозиторий и не нужен C++ сервер. Python 3.12, FastAPI, PostgreSQL 16, SQL-миграции, вложения в отдельном Docker volume. Пакеты разрешаются через `uv` и ставятся внутрь образа или `backend/.venv`; системный Python не меняется.

## Запуск одним скриптом

Из `frondent` выполните:

```sh
./start-docker.sh
```

Нужны Docker Engine и Compose v2. При первом запуске скрипт создаёт закрытый `.env` со случайными паролями и секретом JWT, собирает образы и запускает сервисы. Откройте `http://127.0.0.1:4173`. Сервисы PostgreSQL и API доступны только внутри Docker-сети; web опубликован только на loopback. Первый build загружает зафиксированные базовые образы и Python wheels. Системные Python-пакеты не устанавливаются.

Можно заполнить `.env` вручную по [.env.example](../.env.example). Не храните `.env` в Git. `APP_PORT` по умолчанию 4173; при занятом порте поменяйте его на 4174. `POSTGRES_PASSWORD` — пароль bootstrap-пользователя БД, `POSTGRES_APP_PASSWORD` — отдельного ограниченного пользователя приложения.

Остановка сохраняет данные:

```sh
docker compose --project-name ryadom down
```

Не добавляйте `-v` при обычной остановке. `docker compose --project-name ryadom down -v` удаляет PostgreSQL и файлы вложений без возможности восстановления из этих volumes.

## Аккаунты и администратор

Откройте «Совместная работа» и выберите вход или создание аккаунта. Пароль при регистрации должен быть не короче 10 символов; хранится только salted scrypt-хэш. Старые UI маршруты `/api/v1/users/login`, `/api/v1/notes` и `/api/v1/notes/{id}` совместимы с прежним клиентом снимков.

Чтобы создать администратора, до первой регистрации укажите в `.env` адрес в `ADMIN_EMAIL` и скопируйте сгенерированный `ADMIN_SETUP_TOKEN` в поле «Код администратора» при регистрации этого адреса. Оба значения проверяются сервером; без секретного кода аккаунт получает обычную роль. Администратор может просматривать аккаунты, назначать/снимать роль администратора и отключать учётную запись. Последнего активного администратора отключить или понизить нельзя.

## Подключённость интерфейса

Текущий холст хранит изменения и вложения локально в IndexedDB и синхронизирует вкладки через BroadcastChannel. Диалог использует серверную регистрацию/авторизацию и позволяет создавать серверную доску: объекты отправляются операциями, а оригиналы файлов — авторизованными multipart-загрузками. Загрузка UUID серверной доски скачивает эти оригиналы и добавляет копию в локальную доску.

API также реализует серверные доски, операции с CAS-ревизиями и idempotency key, приглашения, состав участников, WebSocket-события, авторизованные загрузку и скачивание файлов. Текущий холст пока не вызывает эти новые маршруты для обычного редактирования. Поэтому серверные операции не включают удалённые доски в локальный интерфейс и не означают, что локальная доска синхронизирована с другими устройствами.

## API

Документация OpenAPI: `http://127.0.0.1:4173/api/docs` или `/openapi.json` после запуска. Стандартный ответ: `{"status":"Success","data":...}`; ошибки содержат `status`, `code`, `message` и настоящий HTTP-код.

Основные маршруты:

| Метод | Путь | Доступ |
| --- | --- | --- |
| POST | `/api/v1/auth/register`, `/api/v1/auth/login` | без токена |
| POST | `/api/v1/auth/refresh`, `/api/v1/auth/logout` | refresh token / Bearer |
| GET | `/api/v1/users/me` | Bearer |
| POST, GET | `/api/v1/boards` | Bearer |
| GET, PATCH | `/api/v1/boards/{boardId}` | участник / владелец |
| POST, GET | `/api/v1/boards/{boardId}/operations` | редактор/владелец |
| POST, GET | `/api/v1/boards/{boardId}/attachments` | редактор/владелец |
| GET | `/api/v1/boards/{boardId}/attachments/{fileId}` | участник |
| GET, DELETE | `/api/v1/boards/{boardId}/members...` | участник / владелец |
| POST, DELETE | `/api/v1/boards/{boardId}/invite` | владелец |
| POST | `/api/v1/board-invites/accept` | Bearer |
| POST | `/api/v1/boards/{boardId}/session` | участник |
| WS | `/api/v1/boards/{boardId}/events?ticket=...` | одноразовый ticket |
| GET, PATCH | `/api/v1/admin/users...` | администратор |
| GET | `/health/live`, `/health/ready` | без токена |

ID новых ресурсов — UUID. Локальный `blobId`, внешние URL, SVG и HTML не принимаются. Сессии access token истекают через 15 минут, refresh — через 30 дней и ротируется при каждом обновлении. Logout отзывает refresh-сессии и увеличивает token version, поэтому старый access token немедленно перестаёт работать.

## Пример API

Зарегистрируйте пользователя; в ответе будет `$TOKEN` (`access_token`). `ADMIN_SETUP_TOKEN` добавляется только если создаётся указанный в `.env` bootstrap-администратор:

```sh
curl -sS -X POST http://127.0.0.1:4173/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.test","password":"choose-a-long-password","displayName":"Владелец"}'
```

После регистрации создайте доску (`$TOKEN` — полученный `access_token`):

```sh
curl -sS http://127.0.0.1:4173/api/v1/boards \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Идеи команды"}'
```

Создайте объект, используя UUID доски и новый UUID объекта:

```sh
curl -sS -X POST "http://127.0.0.1:4173/api/v1/boards/$BOARD_ID/operations" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"opId":"59b365c2-7d6b-4151-bc36-2e280d09e79e","objectId":"ded9bc5d-c2a9-43a2-940a-c57e224b9092","action":"create","baseRevision":0,"object":{"id":"ded9bc5d-c2a9-43a2-940a-c57e224b9092","type":"sticky","x":120,"y":180,"w":240,"h":180,"text":"Наша идея","color":"mint"}}'
```

Создайте приглашение, загрузите PNG и получите URL для скачивания:

```sh
curl -sS -X POST "http://127.0.0.1:4173/api/v1/boards/$BOARD_ID/invite" -H "Authorization: Bearer $TOKEN"
curl -sS -X POST "http://127.0.0.1:4173/api/v1/boards/$BOARD_ID/attachments" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: 93031407-dd9b-46e4-b5e4-525cd776ab61" \
  -F 'file=@drawing.png'
curl -sS "http://127.0.0.1:4173/api/v1/boards/$BOARD_ID/attachments/$FILE_ID" -H "Authorization: Bearer $TOKEN" -o drawing.png
```

Editor принимает приглашение через `POST /api/v1/board-invites/accept` с `{ "token": "..." }`. Повтор `opId` с тем же пользователем и телом возвращает прежний ACK без нового `serverSeq`; повтор с иным телом возвращает `409 OP_ID_REUSED`. Операции с устаревшей revision возвращают `409 REVISION_CONFLICT` с полным текущим объектом.

## Схема, файлы и безопасность

Версионированные SQL-файлы находятся в `ryadom_backend/migrations`. На старте API применяет их транзакционно и под advisory lock. Схема хранит пользователей, refresh sessions, совместимые снимки, доски, участников, операции/receipts, вложения и приглашения. Приложение подключается к PostgreSQL отдельным `NOSUPERUSER`-пользователем.

Пароли — salted scrypt; JWT подписывается HMAC-SHA256. SQL параметризован. Логи содержат метод, путь без query string, status, длительность и request ID; тела, пароли, Authorization и ticket не логируются. Uvicorn access log отключён, чтобы одноразовые WebSocket tickets не попали в строку URL.

Файл сначала проверяется по расширению, сигнатуре или структуре контейнера, записывается во временный файл, fsync-ится и атомарно переименовывается. Один файл — до 20 МиБ, суммарно на доске — до 200 МиБ, HTML/SVG запрещены. Метаданные и квота защищены блокировкой строки доски; ссылки не публичные, скачивание требует участия в доске.

`/health/ready` проверяет PostgreSQL, миграции и доступность volume. Web/API/DB не публикуются на внешний интерфейс. Перед удалённым размещением нужны TLS/WSS, узкий список Origins и пересмотр политики секретов.

## Backup и restore

```sh
./scripts/backup.sh
RESTORE_PROJECT=ryadom-restore-20260928 ./scripts/restore.sh ./backups/20260928T120000Z
```

Backup на несколько секунд останавливает API для согласованной пары `pg_dump` + архива файла-тома, затем возвращает его в прежнее состояние. Архив включает контрольные SHA-256 и manifest; неполная копия не переименовывается в готовую. Restore всегда использует новый Compose project и новые volumes; работающая база не перезаписывается. После проверки удаление тестовых restore-volumes выполняется отдельно и вручную.

Делайте резервную копию ежедневно, держите семь последних успешных копий вне рабочих Docker volumes. Обычная команда `down` сохраняет данные, но volume сам по себе не является резервной копией.

## Тесты

Установите Docker/Compose и `uv`, затем:

```sh
./scripts/test-backend.sh
```

Скрипт создаёт отдельный Compose project и эфемерную PostgreSQL в tmpfs, запускает интеграционные API/DB/file тесты через `uv` и удаляет только свой тестовый контейнер/volume. Unit тесты моделей, токенов, паролей и файлов можно запустить без БД: `cd backend && uv run --locked --group dev python -m pytest`; интеграционные сценарии без `TEST_DATABASE_URL` будут отмечены skipped. Проверки UI и Node proxy перечислены в основном [README](../README.md).
