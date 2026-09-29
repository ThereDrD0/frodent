from .config import Settings
from .database import create_pool, migrate


def main() -> None:
    settings = Settings.from_env()
    pool = create_pool(settings.database_url)
    pool.open(wait=True)
    try:
        migrate(pool)
    finally:
        pool.close()


if __name__ == "__main__":
    main()
