#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="ryadom-test-$$"
cd "$ROOT"
docker compose --project-name "$PROJECT" -f compose.test.yaml up -d --wait test-db
cleanup() { docker compose --project-name "$PROJECT" -f compose.test.yaml down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cd "$ROOT/backend"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/ryadom-uv-cache}" \
JWT_SECRET="ryadom-tests-only-not-for-deployment-0123456789" \
DATABASE_URL="postgresql://ryadom_test:ryadom_test_only@127.0.0.1:55437/ryadom_test" \
TEST_DATABASE_URL="postgresql://ryadom_test:ryadom_test_only@127.0.0.1:55437/ryadom_test" \
uv run --locked --group dev python -m pytest
