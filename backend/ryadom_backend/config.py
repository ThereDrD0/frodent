from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_url: str
    jwt_secret: str
    public_app_url: str
    allowed_origins: frozenset[str]
    file_root: Path
    admin_email: str | None
    admin_setup_token: str | None
    access_minutes: int = 15
    refresh_days: int = 30

    @classmethod
    def from_env(cls) -> "Settings":
        secret = os.environ.get("JWT_SECRET", "")
        if len(secret.encode()) < 32:
            raise RuntimeError("JWT_SECRET должен содержать не менее 32 байт.")
        origins = os.environ.get("ALLOWED_ORIGINS", "http://127.0.0.1:4173,http://localhost:4173")
        return cls(
            database_url=os.environ.get("DATABASE_URL", "postgresql://ryadom:ryadom@127.0.0.1:5432/ryadom"),
            jwt_secret=secret,
            public_app_url=os.environ.get("PUBLIC_APP_URL", "http://127.0.0.1:4173").rstrip("/"),
            allowed_origins=frozenset(origin.strip().rstrip("/") for origin in origins.split(",") if origin.strip()),
            file_root=Path(os.environ.get("FILE_ROOT", "./data/board-files")).resolve(),
            admin_email=os.environ.get("ADMIN_EMAIL", "").strip().lower() or None,
            admin_setup_token=os.environ.get("ADMIN_SETUP_TOKEN") or None,
        )
