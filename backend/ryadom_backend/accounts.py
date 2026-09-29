from datetime import datetime, timedelta, timezone
import hmac
import uuid

from psycopg import Connection

from .config import Settings
from .errors import ApiError
from .models import LoginInput, RegisterInput
from .security import access_token, hash_password, new_refresh_token, token_hash, verify_password


def public_user(row: dict) -> dict:
    return {
        "id": str(row["id"]), "email": row["email"], "displayName": row["display_name"],
        "role": row["role"], "isActive": row["is_active"],
    }


def issue_session(conn: Connection, settings: Settings, user: dict) -> dict:
    refresh, hashed = new_refresh_token()
    expires = datetime.now(timezone.utc) + timedelta(days=settings.refresh_days)
    conn.execute(
        "INSERT INTO refresh_sessions(id,user_id,token_hash,expires_at) VALUES (%s,%s,%s,%s)",
        (uuid.uuid4(), user["id"], hashed, expires),
    )
    token, _ = access_token(settings.jwt_secret, str(user["id"]), user["token_version"], settings.access_minutes)
    return {"access_token": token, "refresh_token": refresh, "expires_in": settings.access_minutes * 60, "token_type": "Bearer", "user": public_user(user)}


def register(conn: Connection, settings: Settings, body: RegisterInput) -> dict:
    user_id = uuid.uuid4()
    try:
        with conn.transaction():
            is_bootstrap_admin = bool(
                settings.admin_email and settings.admin_setup_token
                and settings.admin_email == body.email
                and body.admin_setup_token
                and hmac.compare_digest(settings.admin_setup_token, body.admin_setup_token)
            )
            role = "admin" if is_bootstrap_admin else "user"
            user = conn.execute(
                "INSERT INTO users(id,email,display_name,password_hash,role) VALUES (%s,%s,%s,%s,%s) "
                "RETURNING id,email,display_name,role,is_active,token_version",
                (user_id, body.email, body.display_name, hash_password(body.password), role),
            ).fetchone()
    except Exception as exc:
        if getattr(exc, "sqlstate", None) == "23505":
            raise ApiError(409, "EMAIL_TAKEN", "Этот email уже зарегистрирован.") from None
        raise
    return issue_session(conn, settings, user)


def login(conn: Connection, settings: Settings, body: LoginInput) -> dict:
    user = conn.execute(
        "SELECT id,email,display_name,password_hash,role,is_active,token_version FROM users WHERE email=%s",
        (body.email,),
    ).fetchone()
    if not user or not user["is_active"] or not verify_password(body.password, user["password_hash"]):
        raise ApiError(401, "INVALID_CREDENTIALS", "Неверный email или пароль.")
    return issue_session(conn, settings, user)


def refresh(conn: Connection, settings: Settings, token: str) -> dict:
    hashed = token_hash(token)
    with conn.transaction():
        row = conn.execute(
            "SELECT s.id AS session_id,s.user_id,s.expires_at,s.revoked_at,u.id,u.email,u.display_name,u.role,u.is_active,u.token_version "
            "FROM refresh_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=%s FOR UPDATE OF s,u",
            (hashed,),
        ).fetchone()
        if not row or row["revoked_at"] is not None or row["expires_at"] <= datetime.now(timezone.utc) or not row["is_active"]:
            raise ApiError(401, "INVALID_REFRESH_TOKEN", "Сессия истекла. Войдите снова.")
        conn.execute("UPDATE refresh_sessions SET revoked_at=now() WHERE id=%s", (row["session_id"],))
        return issue_session(conn, settings, row)


def revoke_all(conn: Connection, user_id: uuid.UUID) -> None:
    with conn.transaction():
        conn.execute("UPDATE refresh_sessions SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL", (user_id,))
        conn.execute("UPDATE users SET token_version=token_version+1 WHERE id=%s", (user_id,))
