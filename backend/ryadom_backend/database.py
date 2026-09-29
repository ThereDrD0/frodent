from pathlib import Path

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


MIGRATIONS = Path(__file__).parent / "migrations"


def create_pool(database_url: str) -> ConnectionPool:
    return ConnectionPool(database_url, min_size=1, max_size=12, kwargs={"row_factory": dict_row}, open=False)


def migrate(pool: ConnectionPool) -> None:
    with pool.connection() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(725639201)")
            for path in sorted(MIGRATIONS.glob("[0-9]*.sql")):
                version = int(path.name.split("_", 1)[0])
                exists = conn.execute("SELECT 1 FROM schema_migrations WHERE version = %s", (version,)).fetchone()
                if exists:
                    continue
                conn.execute(path.read_text(encoding="utf-8"), prepare=False)
                conn.execute("INSERT INTO schema_migrations(version) VALUES (%s)", (version,))


def migration_version(conn: Connection) -> int:
    row = conn.execute("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").fetchone()
    return int(row["version"])
