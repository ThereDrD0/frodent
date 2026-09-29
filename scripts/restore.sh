#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1" ]]; then
  printf 'Использование: %s ./backups/YYYYMMDDTHHMMSSZ\n' "$0" >&2
  exit 2
fi
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="$(cd -- "$1" && pwd)"
PROJECT="${RESTORE_PROJECT:-ryadom-restore-$(date -u +%Y%m%d%H%M%S)}"
if ! [[ "$PROJECT" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,49}$ ]]; then printf '%s\n' 'RESTORE_PROJECT должен быть безопасным именем Docker Compose project.' >&2; exit 2; fi
if [[ ! -f "$BACKUP/manifest.json" || ! -f "$BACKUP/database.dump" || ! -f "$BACKUP/board-files.tar.gz" ]]; then
  printf '%s\n' 'В выбранной папке отсутствует полный backup.' >&2
  exit 1
fi
(cd "$BACKUP" && printf '%s  %s\n%s  %s\n' "$(sed -n 's/.*"databaseSha256": "\([a-f0-9]*\)".*/\1/p' manifest.json)" database.dump "$(sed -n 's/.*"filesSha256": "\([a-f0-9]*\)".*/\1/p' manifest.json)" board-files.tar.gz | sha256sum --check --status) || { printf '%s\n' 'Контрольная сумма backup не совпадает.' >&2; exit 1; }

for suffix in postgres_data board_files; do
  volume="${PROJECT}_${suffix}"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    printf 'Volume %s уже существует. Выберите новый RESTORE_PROJECT; существующие данные не перезаписаны.\n' "$volume" >&2
    exit 1
  fi
done

cd "$ROOT"
docker compose --project-name "$PROJECT" up -d --wait db
docker compose --project-name "$PROJECT" exec -T db sh -ec 'pg_restore --format=custom --no-owner --no-acl -U "$APP_DB_USER" -d "$POSTGRES_DB"' < "$BACKUP/database.dump"

docker compose --project-name "$PROJECT" run --build --rm --no-deps --user 0:0 \
  --volume "$BACKUP:/restore:ro" -e RESTORE_ARCHIVE=/restore/board-files.tar.gz \
  --entrypoint python api -c 'import os,tarfile,pathlib; root=pathlib.Path(os.environ["FILE_ROOT"]); root.mkdir(parents=True,exist_ok=True); archive=tarfile.open(os.environ["RESTORE_ARCHIVE"],"r:gz"); members=archive.getmembers(); [(lambda p,m: (root.joinpath(*p.parts[1:]).parent.mkdir(parents=True,exist_ok=True), root.joinpath(*p.parts[1:]).write_bytes(archive.extractfile(m).read())))(pathlib.PurePosixPath(m.name),m) for m in members if m.isfile() and pathlib.PurePosixPath(m.name).parts[0]=="board-files" and len(pathlib.PurePosixPath(m.name).parts)==2]; archive.close()'

docker compose --project-name "$PROJECT" up -d --wait api
docker compose --project-name "$PROJECT" exec -T api python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/health/ready",timeout=5).read().decode())'
printf 'Restore поднят в отдельном Compose project: %s\n' "$PROJECT"
printf 'Volumes: %s_postgres_data, %s_board_files. Проверяйте данные здесь до любых ручных изменений.\n' "$PROJECT" "$PROJECT"
printf '%s\n' 'Не запускайте down -v, пока не завершили проверку. Эта команда безвозвратно удалит восстановленные volumes.'
