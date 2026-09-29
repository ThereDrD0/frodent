#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/backups}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd -- "$OUT_DIR" && pwd)"
cd "$ROOT"
PROJECT="${COMPOSE_PROJECT_NAME:-ryadom}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$OUT_DIR/$STAMP"
WORK="$(mktemp -d "$OUT_DIR/.backup.XXXXXX")"
API_WAS_RUNNING=0
API_STOPPED=0
if docker compose --project-name "$PROJECT" ps --status running --services api | grep -qx api; then API_WAS_RUNNING=1; fi

cleanup() {
  status=$?
  rm -rf "$WORK"
  if (( API_WAS_RUNNING && API_STOPPED )); then docker compose --project-name "$PROJECT" start api >/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT INT TERM
if (( API_WAS_RUNNING )); then docker compose --project-name "$PROJECT" stop api >/dev/null; API_STOPPED=1; fi

docker compose --project-name "$PROJECT" exec -T db sh -ec 'pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$WORK/database.dump"
docker compose --project-name "$PROJECT" run --rm --no-deps --user 0:0 \
  --volume "$WORK:/backup" \
  --entrypoint python api -c 'import os,tarfile; target="/backup/board-files.tar.gz"; source=os.environ["FILE_ROOT"]; archive=tarfile.open(target,"w:gz"); archive.add(source,arcname="board-files"); archive.close()'

DB_SHA="$(sha256sum "$WORK/database.dump" | awk '{print $1}')"
FILES_SHA="$(sha256sum "$WORK/board-files.tar.gz" | awk '{print $1}')"
cat > "$WORK/manifest.json" <<EOF
{
  "formatVersion": 1,
  "createdAt": "$STAMP",
  "databaseFile": "database.dump",
  "filesArchive": "board-files.tar.gz",
  "databaseSha256": "$DB_SHA",
  "filesSha256": "$FILES_SHA"
}
EOF
if [[ -e "$FINAL" ]]; then printf 'Копия %s уже существует.\n' "$FINAL" >&2; exit 1; fi
mv "$WORK" "$FINAL"
printf 'Резервная копия создана: %s\n' "$FINAL"
