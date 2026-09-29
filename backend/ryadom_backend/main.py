from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
from datetime import datetime, timedelta, timezone
import hashlib
import math
import secrets
import time
from pathlib import Path
from typing import Annotated
from urllib.parse import quote
import uuid

from fastapi import Depends, FastAPI, File, Header, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from psycopg import Connection, Error as PsycopgError
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool, PoolTimeout
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .accounts import issue_session, login as login_account, public_user, refresh as refresh_account, register as register_account, revoke_all
from .config import Settings
from .database import create_pool, migrate, migration_version
from .errors import ApiError, missing_board, missing_object
from .models import AdminUserPatch, BoardCreate, BoardRename, InviteAccept, LoginInput, OperationInput, RefreshInput, RegisterInput, validated_object
from .realtime import RealtimeHub, valid_ephemeral
from .security import decode_access_token, token_hash
from .storage import MAX_BOARD_BYTES, MAX_FILE_BYTES, detect_mime, safe_filename, sha256, write_atomic

logger = logging.getLogger("ryadom.api")
log_handler = logging.StreamHandler()
log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
if not logger.handlers:
    logger.addHandler(log_handler)
logger.setLevel(logging.INFO)
logger.propagate = False


class RequestBodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        limit = 21 * 1024 * 1024 if path.startswith("/api/v1/boards/") and path.endswith("/attachments") else 850 * 1024 if path == "/api/v1/notes" else 1024 * 1024
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = limit + 1
        if content_length > limit:
            await JSONResponse({"status": "Error", "code": "REQUEST_TOO_LARGE", "message": "Запрос превышает допустимый размер."}, status_code=413)(scope, receive, send)
            return
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunks.append(message.get("body", b""))
            total += len(chunks[-1])
            if total > limit:
                await JSONResponse({"status": "Error", "code": "REQUEST_TOO_LARGE", "message": "Запрос превышает допустимый размер."}, status_code=413)(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        sent = False

        async def replay_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)


def envelope(data: object, status_code: int = 200) -> JSONResponse:
    return JSONResponse({"status": "Success", "data": data}, status_code=status_code, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def require_role(conn: Connection, board_id: uuid.UUID, user_id: uuid.UUID, *, lock: bool = False) -> tuple[str, dict]:
    suffix = " FOR UPDATE" if lock else ""
    board = conn.execute(f"SELECT id,owner_id,title,server_seq,created_at,updated_at FROM boards WHERE id=%s{suffix}", (board_id,)).fetchone()
    if not board:
        raise missing_board()
    if board["owner_id"] == user_id:
        return "owner", board
    member = conn.execute("SELECT 1 FROM board_members WHERE board_id=%s AND user_id=%s", (board_id, user_id)).fetchone()
    if not member:
        raise missing_board()
    return "editor", board


def object_json(conn: Connection, row: dict) -> dict:
    result = {
        "id": str(row["object_id"]), "type": row["type"], **row["payload"],
        "revision": int(row["revision"]), "deleted": row["deleted"], "created": int(row["created_at"].timestamp() * 1000),
    }
    if row["attachment_id"] is not None:
        attachment = conn.execute(
            "SELECT id,original_name,mime,size FROM board_attachments WHERE board_id=%s AND id=%s",
            (row["board_id"], row["attachment_id"]),
        ).fetchone()
        if attachment:
            result.update({"attachmentId": str(attachment["id"]), "originalName": attachment["original_name"], "mime": attachment["mime"], "size": int(attachment["size"])})
    return result


def get_object(conn: Connection, board_id: uuid.UUID, object_id: uuid.UUID) -> dict | None:
    row = conn.execute("SELECT * FROM board_objects WHERE board_id=%s AND object_id=%s", (board_id, object_id)).fetchone()
    return object_json(conn, row) if row else None


class TokenBuckets:
    def __init__(self):
        self.values: dict[str, tuple[float, float]] = {}

    def consume(self, key: str) -> None:
        now = time.monotonic()
        if len(self.values) > 10_000:
            self.values = {name: value for name, value in self.values.items() if now - value[1] < 60.0}
        previous, updated = self.values.get(key, (40.0, now))
        tokens = min(40.0, previous + (now - updated) * 20.0)
        if tokens < 1.0:
            raise ApiError(429, "RATE_LIMITED", "Слишком много изменений. Повторите позже.")
        self.values[key] = (tokens - 1.0, now)


def create_app(settings: Settings | None = None, *, pool: ConnectionPool | None = None) -> FastAPI:
    config = settings or Settings.from_env()
    owns_pool = pool is None
    database_pool = pool or create_pool(config.database_url)
    hub = RealtimeHub()
    buckets = TokenBuckets()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if database_pool.closed:
            database_pool.open(wait=True)
        config.file_root.mkdir(parents=True, exist_ok=True)
        try:
            migrate(database_pool)
            app.state.pool = database_pool
            app.state.settings = config
            app.state.hub = hub
            app.state.buckets = buckets
            _clean_stale_uploads(database_pool, config.file_root)
            yield
        finally:
            if owns_pool:
                database_pool.close()

    app = FastAPI(title="Рядом Board API", version="1.0.0", lifespan=lifespan, docs_url="/api/docs", redoc_url=None)
    app.state.pool = database_pool
    app.state.settings = config
    app.state.hub = hub
    app.state.buckets = buckets

    @app.middleware("http")
    async def request_log(request: Request, call_next):
        started = time.monotonic()
        request_id = request.headers.get("x-request-id", "")
        if len(request_id) > 80 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in request_id):
            request_id = ""
        request.state.request_id = request_id or str(uuid.uuid4())
        try:
            response = await call_next(request)
        except Exception:
            logger.error("request_failed method=%s path=%s request_id=%s", request.method, request.url.path, request.state.request_id)
            raise
        elapsed = int((time.monotonic() - started) * 1000)
        logger.info("request method=%s path=%s status=%d duration_ms=%d request_id=%s", request.method, request.url.path, response.status_code, elapsed, request.state.request_id)
        response.headers.setdefault("X-Request-ID", request.state.request_id)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    # Keep the raw ASGI size guard outside BaseHTTPMiddleware so early 413s can
    # be returned without leaving a request-body receive task behind.
    app.add_middleware(RequestBodyLimitMiddleware)

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        body = {"status": "Error", "code": exc.code, "message": exc.message}
        if exc.data is not None:
            body["data"] = exc.data
        headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if exc.status == 429:
            headers["Retry-After"] = "1"
        return JSONResponse(body, status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse({"status": "Error", "code": "INVALID_REQUEST", "message": "Проверьте формат и ограничения запроса."}, status_code=422, headers={"Cache-Control": "no-store"})

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(request: Request, exc: StarletteHTTPException):
        return JSONResponse({"status": "Error", "code": "HTTP_ERROR", "message": "Маршрут или ресурс не найден." if exc.status_code == 404 else "Запрос отклонён."}, status_code=exc.status_code, headers={"Cache-Control": "no-store"})

    @app.exception_handler(PsycopgError)
    @app.exception_handler(PoolTimeout)
    async def database_error_handler(request: Request, exc: Exception):
        logger.error("database_unavailable path=%s request_id=%s", request.url.path, getattr(request.state, "request_id", ""))
        return JSONResponse({"status": "Error", "code": "DATABASE_UNAVAILABLE", "message": "База данных временно недоступна."}, status_code=503, headers={"Cache-Control": "no-store"})

    def current_user(request: Request, authorization: Annotated[str | None, Header()] = None) -> dict:
        if not authorization or not authorization.startswith("Bearer "):
            raise ApiError(401, "UNAUTHORIZED", "Войдите в аккаунт.")
        try:
            claims = decode_access_token(config.jwt_secret, authorization[7:])
            user_id = uuid.UUID(claims["sub"])
            version = int(claims["ver"])
        except (ValueError, KeyError, TypeError):
            raise ApiError(401, "UNAUTHORIZED", "Сессия истекла. Войдите снова.") from None
        with database_pool.connection() as conn:
            row = conn.execute("SELECT id,email,display_name,role,is_active,token_version FROM users WHERE id=%s", (user_id,)).fetchone()
        if not row or not row["is_active"] or int(row["token_version"]) != version:
            raise ApiError(401, "UNAUTHORIZED", "Сессия истекла. Войдите снова.")
        return row

    def administrator(user: dict = Depends(current_user)) -> dict:
        if user["role"] != "admin":
            raise ApiError(403, "ADMIN_REQUIRED", "Действие доступно только администратору.")
        return user

    @app.get("/health/live")
    def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    def ready():
        try:
            with database_pool.connection() as conn:
                version = migration_version(conn)
                conn.execute("SELECT 1").fetchone()
            probe = config.file_root / f".ready-{uuid.uuid4()}"
            probe.write_bytes(b"ok")
            probe.unlink()
            if version < 1:
                raise OSError("database schema is not ready")
            return {"status": "ok", "schemaVersion": version}
        except Exception:
            return JSONResponse({"status": "not_ready"}, status_code=503)

    def do_register(body: RegisterInput):
        with database_pool.connection() as conn:
            result = register_account(conn, config, body)
        return envelope(result, 201)

    def do_login(body: LoginInput):
        with database_pool.connection() as conn:
            result = login_account(conn, config, body)
        return envelope(result)

    app.add_api_route("/api/v1/auth/register", do_register, methods=["POST"], status_code=201)
    app.add_api_route("/api/v1/users/register", do_register, methods=["POST"], status_code=201)
    app.add_api_route("/api/v1/auth/login", do_login, methods=["POST"])
    app.add_api_route("/api/v1/users/login", do_login, methods=["POST"])

    @app.post("/api/v1/auth/refresh")
    def auth_refresh(body: RefreshInput):
        with database_pool.connection() as conn:
            result = refresh_account(conn, config, body.refresh_token)
        return envelope(result)

    @app.post("/api/v1/auth/logout")
    async def auth_logout(user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            revoke_all(conn, user["id"])
        await hub.close_user(str(user["id"]))
        return envelope({"loggedOut": True})

    @app.get("/api/v1/users/me")
    def who_am_i(user: dict = Depends(current_user)):
        return envelope(public_user(user))

    @app.post("/api/v1/notes")
    def save_legacy_note(request: Request, body: dict, user: dict = Depends(current_user)):
        title, content = body.get("title"), body.get("content")
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 180 or not isinstance(content, str):
            raise ApiError(422, "INVALID_NOTE", "Некорректный снимок доски.")
        if len(content.encode("utf-8")) > 800_000:
            raise ApiError(413, "REQUEST_TOO_LARGE", "Снимок больше 800 КБ.")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            raise ApiError(422, "INVALID_NOTE", "Содержимое снимка должно быть JSON.") from None
        if not isinstance(parsed, dict) or parsed.get("format") != "ryadom-board" or parsed.get("version") != 1 or not isinstance(parsed.get("objects"), list) or len(parsed["objects"]) > 1000:
            raise ApiError(422, "INVALID_NOTE", "Снимок не соответствует формату доски.")
        with database_pool.connection() as conn:
            row = conn.execute("INSERT INTO notes(user_id,title,content) VALUES (%s,%s,%s) RETURNING id,created_at", (user["id"], title.strip(), content)).fetchone()
        return envelope({"id": row["id"], "createdAt": iso(row["created_at"])}, 201)

    @app.get("/api/v1/notes/{note_id}")
    def read_legacy_note(note_id: int, user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            row = conn.execute("SELECT id,title,content,created_at FROM notes WHERE id=%s AND user_id=%s", (note_id, user["id"])).fetchone()
        if not row:
            raise ApiError(404, "NOTE_NOT_FOUND", "Снимок не найден.")
        return envelope({"id": row["id"], "title": row["title"], "content": row["content"], "createdAt": iso(row["created_at"])})

    @app.post("/api/v1/boards", status_code=201)
    def create_board(body: BoardCreate, user: dict = Depends(current_user)):
        board_id = uuid.uuid4()
        with database_pool.connection() as conn:
            conn.execute("INSERT INTO boards(id,owner_id,title) VALUES (%s,%s,%s)", (board_id, user["id"], body.title))
        return envelope({"id": str(board_id), "title": body.title, "role": "owner", "serverSeq": 0}, 201)

    @app.get("/api/v1/boards")
    def list_boards(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            rows = conn.execute(
                "SELECT b.id,b.title,b.updated_at,CASE WHEN b.owner_id=%s THEN 'owner' ELSE 'editor' END AS role "
                "FROM boards b LEFT JOIN board_members m ON m.board_id=b.id AND m.user_id=%s "
                "WHERE b.owner_id=%s OR m.user_id=%s ORDER BY b.updated_at DESC,b.id LIMIT %s OFFSET %s",
                (user["id"], user["id"], user["id"], user["id"], limit + 1, offset),
            ).fetchall()
        next_offset = offset + limit if len(rows) > limit else None
        items = [{"id": str(row["id"]), "title": row["title"], "role": row["role"], "updatedAt": iso(row["updated_at"])} for row in rows[:limit]]
        return envelope({"items": items, "nextOffset": next_offset})

    @app.get("/api/v1/boards/{board_id}")
    def read_board(board_id: uuid.UUID, user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            role, board_row = require_role(conn, board_id, user["id"])
            rows = conn.execute("SELECT * FROM board_objects WHERE board_id=%s AND deleted=FALSE ORDER BY created_at,object_id", (board_id,)).fetchall()
            objects = [object_json(conn, row) for row in rows]
            attached = sorted({str(row["attachment_id"]) for row in rows if row["attachment_id"] is not None})
            attachments = []
            if attached:
                found = conn.execute("SELECT id,original_name,mime,size,sha256 FROM board_attachments WHERE board_id=%s AND id=ANY(%s::uuid[])", (board_id, attached)).fetchall()
                attachments = [attachment_json(board_id, row) for row in found]
        return envelope({"id": str(board_id), "title": board_row["title"], "role": role, "serverSeq": int(board_row["server_seq"]), "objects": objects, "attachments": attachments})

    @app.patch("/api/v1/boards/{board_id}")
    async def rename_board(board_id: uuid.UUID, body: BoardRename, user: dict = Depends(current_user)):
        def rename():
            with database_pool.connection() as conn:
                role, _ = require_role(conn, board_id, user["id"])
                if role != "owner":
                    raise ApiError(403, "OWNER_REQUIRED", "Переименовать доску может только владелец.")
                conn.execute("UPDATE boards SET title=%s,updated_at=now() WHERE id=%s", (body.title, board_id))
        await asyncio.to_thread(rename)
        await hub.publish(str(board_id), {"type": "board.updated", "title": body.title})
        return envelope({"id": str(board_id), "title": body.title})

    @app.post("/api/v1/boards/{board_id}/operations")
    async def board_operation(board_id: uuid.UUID, body: OperationInput, user: dict = Depends(current_user)):
        buckets.consume(f"{user['id']}:{board_id}")
        ack, event, replayed = await asyncio.to_thread(apply_operation, database_pool, board_id, user, body)
        if not replayed:
            await hub.publish(str(board_id), event)
        return envelope(ack)

    @app.get("/api/v1/boards/{board_id}/operations")
    def get_operations(board_id: uuid.UUID, after_seq: int = Query(0, alias="afterSeq", ge=0), limit: int = Query(500, ge=1, le=1000), user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            _, board_row = require_role(conn, board_id, user["id"])
            events = conn.execute("SELECT event FROM board_operation_receipts WHERE board_id=%s AND server_seq>%s ORDER BY server_seq LIMIT %s", (board_id, after_seq, limit)).fetchall()
        return envelope({"items": [row["event"] for row in events], "serverSeq": int(board_row["server_seq"]), "nextAfterSeq": int(events[-1]["event"]["serverSeq"]) if len(events) == limit else None})

    @app.get("/api/v1/boards/{board_id}/members")
    def board_members(board_id: uuid.UUID, user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            role, board_row = require_role(conn, board_id, user["id"])
            rows = conn.execute(
                "SELECT id AS user_id,display_name,'owner' AS role FROM users WHERE id=%s "
                "UNION ALL SELECT u.id,u.display_name,'editor' FROM board_members m JOIN users u ON u.id=m.user_id WHERE m.board_id=%s ORDER BY role,user_id",
                (board_row["owner_id"], board_id),
            ).fetchall()
        return envelope({"items": [{"userId": str(row["user_id"]), "displayName": row["display_name"], "role": row["role"]} for row in rows]})

    @app.delete("/api/v1/boards/{board_id}/members/{member_id}")
    async def remove_member(board_id: uuid.UUID, member_id: uuid.UUID, user: dict = Depends(current_user)):
        removed = False
        with database_pool.connection() as conn:
            with conn.transaction():
                role, board_row = require_role(conn, board_id, user["id"], lock=True)
                if role != "owner":
                    raise ApiError(403, "OWNER_REQUIRED", "Управлять участниками может только владелец.")
                if member_id == board_row["owner_id"]:
                    raise ApiError(409, "OWNER_CANNOT_BE_REMOVED", "Владельца нельзя удалить из его доски.")
                deleted = conn.execute("DELETE FROM board_members WHERE board_id=%s AND user_id=%s RETURNING user_id", (board_id, member_id)).fetchone()
                removed = deleted is not None
                if removed:
                    conn.execute("DELETE FROM board_invites WHERE board_id=%s", (board_id,))
        if removed:
            logger.info("board_member_removed actor_id=%s board_id=%s member_id=%s", user["id"], board_id, member_id)
            await hub.close_member(str(board_id), str(member_id))
            await hub.publish(str(board_id), {"type": "member.removed", "userId": str(member_id)})
        return envelope({"removed": removed})

    @app.post("/api/v1/boards/{board_id}/invite")
    def create_invite(board_id: uuid.UUID, user: dict = Depends(current_user)):
        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(days=7)
        with database_pool.connection() as conn:
            with conn.transaction():
                role, _ = require_role(conn, board_id, user["id"], lock=True)
                if role != "owner":
                    raise ApiError(403, "OWNER_REQUIRED", "Создать приглашение может только владелец.")
                conn.execute("INSERT INTO board_invites(board_id,token_hash,expires_at) VALUES (%s,%s,%s) ON CONFLICT(board_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,created_at=now()", (board_id, token_hash(token), expires))
        return envelope({"url": f"{config.public_app_url}/#invite={token}", "expiresAt": iso(expires)})

    @app.delete("/api/v1/boards/{board_id}/invite")
    def revoke_invite(board_id: uuid.UUID, user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            role, _ = require_role(conn, board_id, user["id"], lock=True)
            if role != "owner":
                raise ApiError(403, "OWNER_REQUIRED", "Отозвать приглашение может только владелец.")
            conn.execute("DELETE FROM board_invites WHERE board_id=%s", (board_id,))
        return envelope({"revoked": True})

    @app.post("/api/v1/board-invites/accept")
    def accept_invite(body: InviteAccept, user: dict = Depends(current_user)):
        digest = token_hash(body.token)
        with database_pool.connection() as conn:
            with conn.transaction():
                hint = conn.execute("SELECT board_id FROM board_invites WHERE token_hash=%s", (digest,)).fetchone()
                if not hint:
                    raise ApiError(404, "INVITE_INVALID", "Приглашение недействительно или истекло.")
                _, board_row = _lock_board(conn, hint["board_id"])
                invite = conn.execute("SELECT expires_at FROM board_invites WHERE board_id=%s AND token_hash=%s FOR UPDATE", (hint["board_id"], digest)).fetchone()
                if not invite or invite["expires_at"] <= datetime.now(timezone.utc):
                    raise ApiError(404, "INVITE_INVALID", "Приглашение недействительно или истекло.")
                if board_row["owner_id"] == user["id"]:
                    role = "owner"
                else:
                    conn.execute("INSERT INTO board_members(board_id,user_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (hint["board_id"], user["id"]))
                    role = "editor"
        return envelope({"boardId": str(hint["board_id"]), "role": role})

    @app.post("/api/v1/boards/{board_id}/session")
    def create_session_ticket(board_id: uuid.UUID, user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            require_role(conn, board_id, user["id"])
        ticket, expires = hub.issue_ticket(str(board_id), str(user["id"]))
        return envelope({"ticket": ticket, "expiresAt": iso(expires)})

    @app.websocket("/api/v1/boards/{board_id}/events")
    async def board_events(socket: WebSocket, board_id: uuid.UUID, ticket: str):
        origin = socket.headers.get("origin")
        if origin and origin.rstrip("/") not in config.allowed_origins:
            await socket.close(code=4403, reason="Origin не разрешён")
            return
        user_id = await hub.consume_ticket(ticket, str(board_id))
        if not user_id:
            await socket.close(code=4401, reason="Ticket истёк")
            return
        with database_pool.connection() as conn:
            row = conn.execute("SELECT id,display_name,role,is_active FROM users WHERE id=%s", (user_id,)).fetchone()
            if not row or not row["is_active"]:
                await socket.close(code=4401, reason="Сессия истекла")
                return
            try:
                require_role(conn, board_id, uuid.UUID(user_id))
            except ApiError:
                await socket.close(code=4403, reason="Доступ отозван")
                return
        session = await hub.connect(str(board_id), {"id": user_id, "display_name": row["display_name"]}, socket)
        if session is None:
            await socket.close(code=4429, reason="На доске уже 10 сессий")
            return
        last_event = 0.0
        try:
            while True:
                try:
                    raw = await asyncio.wait_for(socket.receive_text(), timeout=1.0)
                except asyncio.TimeoutError:
                    with database_pool.connection() as conn:
                        still_allowed = conn.execute("SELECT 1 FROM users WHERE id=%s AND is_active=TRUE", (user_id,)).fetchone() is not None
                        if still_allowed:
                            try:
                                require_role(conn, board_id, uuid.UUID(user_id))
                            except ApiError:
                                still_allowed = False
                    if not still_allowed:
                        await socket.close(code=4403, reason="Доступ отозван")
                        break
                    continue
                if len(raw.encode("utf-8")) > 16_384:
                    await socket.close(code=4400, reason="Событие слишком велико")
                    break
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    await socket.close(code=4400, reason="Некорректный JSON")
                    break
                now = time.monotonic()
                if now - last_event < 0.02:
                    continue
                if not valid_ephemeral(message):
                    await socket.close(code=4400, reason="Недопустимое событие")
                    break
                last_event = now
                await hub.publish(str(board_id), {**message, "sessionId": session.id, "userId": session.user_id, "displayName": session.display_name}, except_id=session.id)
        except WebSocketDisconnect:
            pass
        finally:
            await hub.disconnect(session)

    @app.post("/api/v1/boards/{board_id}/attachments", status_code=201)
    async def upload_attachment(board_id: uuid.UUID, file: UploadFile = File(...), idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None, user: dict = Depends(current_user)):
        try:
            upload_id = uuid.UUID(idempotency_key or "")
        except ValueError:
            raise ApiError(422, "INVALID_UPLOAD_ID", "Укажите UUID в заголовке Idempotency-Key.") from None
        chunks, total = [], 0
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                await file.close()
                raise ApiError(413, "FILE_TOO_LARGE", "Максимальный размер файла — 20 МиБ.")
            chunks.append(chunk)
        data = b"".join(chunks)
        if not data:
            raise ApiError(422, "EMPTY_FILE", "Нельзя загрузить пустой файл.")
        name = safe_filename(file.filename or "attachment.bin")
        try:
            mime = detect_mime(name, data)
        except ValueError as exc:
            raise ApiError(415, "UNSUPPORTED_FILE", str(exc)) from None
        digest = sha256(data)
        attachment_id, storage_key = uuid.uuid4(), uuid.uuid4()
        destination = config.file_root / str(storage_key)
        response_code = 201
        with database_pool.connection() as conn:
            with conn.transaction():
                role, _ = require_role(conn, board_id, user["id"], lock=True)
                prior = conn.execute("SELECT id,storage_key,original_name,mime,size,sha256 FROM board_attachments WHERE board_id=%s AND uploaded_by=%s AND upload_id=%s", (board_id, user["id"], upload_id)).fetchone()
                if prior:
                    if prior["sha256"] != digest or prior["original_name"] != name:
                        raise ApiError(409, "UPLOAD_ID_REUSED", "Ключ загрузки уже использован для другого файла.")
                    response_code = 200
                    saved = prior
                else:
                    current_size = conn.execute("SELECT COALESCE(SUM(size),0) AS size FROM board_attachments WHERE board_id=%s", (board_id,)).fetchone()["size"]
                    if int(current_size) + total > MAX_BOARD_BYTES:
                        raise ApiError(409, "BOARD_LIMIT", "Общий размер вложений на доске не должен превышать 200 МиБ.")
                    await asyncio.to_thread(write_atomic, config.file_root, str(storage_key), data)
                    saved = conn.execute(
                        "INSERT INTO board_attachments(id,board_id,uploaded_by,upload_id,storage_key,original_name,mime,size,sha256) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "RETURNING id,storage_key,original_name,mime,size,sha256",
                        (attachment_id, board_id, user["id"], upload_id, storage_key, name, mime, total, digest),
                    ).fetchone()
        return envelope(attachment_json(board_id, saved), response_code)

    @app.get("/api/v1/boards/{board_id}/attachments/{file_id}")
    def download_attachment(board_id: uuid.UUID, file_id: uuid.UUID, user: dict = Depends(current_user)):
        with database_pool.connection() as conn:
            require_role(conn, board_id, user["id"])
            row = conn.execute("SELECT * FROM board_attachments WHERE board_id=%s AND id=%s", (board_id, file_id)).fetchone()
        if not row:
            raise ApiError(404, "ATTACHMENT_NOT_FOUND", "Вложение не найдено.")
        path = config.file_root / str(row["storage_key"])
        if not path.is_file():
            raise ApiError(503, "FILE_UNAVAILABLE", "Файл временно недоступен.")
        ascii_name = "".join(ch if 32 <= ord(ch) < 127 and ch not in '\\"' else "_" for ch in row["original_name"])
        disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(row['original_name'], safe='')}"
        return FileResponse(path, media_type=row["mime"], headers={"Content-Disposition": disposition, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})

    @app.get("/api/v1/admin/users")
    def list_users(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), _: dict = Depends(administrator)):
        with database_pool.connection() as conn:
            rows = conn.execute("SELECT id,email,display_name,role,is_active,created_at FROM users ORDER BY created_at,id LIMIT %s OFFSET %s", (limit + 1, offset)).fetchall()
        next_offset = offset + limit if len(rows) > limit else None
        items = [{"id": str(row["id"]), "email": row["email"], "displayName": row["display_name"], "role": row["role"], "isActive": row["is_active"], "createdAt": iso(row["created_at"])} for row in rows[:limit]]
        return envelope({"items": items, "nextOffset": next_offset})

    @app.patch("/api/v1/admin/users/{target_id}")
    async def update_user(target_id: uuid.UUID, body: AdminUserPatch, admin: dict = Depends(administrator)):
        with database_pool.connection() as conn:
            with conn.transaction():
                conn.execute("SELECT pg_advisory_xact_lock(725639202)")
                target = conn.execute("SELECT id,email,display_name,role,is_active,created_at FROM users WHERE id=%s FOR UPDATE", (target_id,)).fetchone()
                if not target:
                    raise ApiError(404, "USER_NOT_FOUND", "Пользователь не найден.")
                new_role = body.role or target["role"]
                new_active = body.is_active if body.is_active is not None else target["is_active"]
                removes_admin = target["role"] == "admin" and (new_role != "admin" or not new_active)
                if removes_admin:
                    count = conn.execute("SELECT COUNT(*) AS total FROM users WHERE role='admin' AND is_active=TRUE").fetchone()["total"]
                    if count <= 1:
                        raise ApiError(409, "LAST_ADMIN", "Нельзя отключить или понизить единственного администратора.")
                updated = conn.execute("UPDATE users SET role=%s,is_active=%s,token_version=token_version+%s WHERE id=%s RETURNING id,email,display_name,role,is_active,created_at", (new_role, new_active, 1 if not new_active else 0, target_id)).fetchone()
                if not new_active:
                    conn.execute("UPDATE refresh_sessions SET revoked_at=now() WHERE user_id=%s AND revoked_at IS NULL", (target_id,))
        if not new_active:
            await hub.close_user(str(target_id))
        logger.info("admin_user_updated actor_id=%s target_id=%s role=%s active=%s", admin["id"], target_id, new_role, new_active)
        return envelope({"id": str(updated["id"]), "email": updated["email"], "displayName": updated["display_name"], "role": updated["role"], "isActive": updated["is_active"], "createdAt": iso(updated["created_at"])})

    return app


def _lock_board(conn: Connection, board_id: uuid.UUID) -> tuple[str, dict]:
    row = conn.execute("SELECT id,owner_id,title,server_seq,created_at,updated_at FROM boards WHERE id=%s FOR UPDATE", (board_id,)).fetchone()
    if not row:
        raise ApiError(404, "INVITE_INVALID", "Приглашение недействительно или истекло.")
    return "", row


def attachment_json(board_id: uuid.UUID, row: dict) -> dict:
    return {
        "id": str(row["id"]), "originalName": row["original_name"], "mime": row["mime"], "size": int(row["size"]),
        "sha256": row["sha256"], "downloadUrl": f"/api/v1/boards/{board_id}/attachments/{row['id']}",
    }


def apply_operation(pool: ConnectionPool, board_id: uuid.UUID, user: dict, operation: OperationInput) -> tuple[dict, dict, bool]:
    normalized = operation.model_dump(mode="json", by_alias=True, exclude_none=True)
    request_hash = hashlib.sha256(json.dumps(_canonical_numbers(normalized), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    event = None
    with pool.connection() as conn:
        with conn.transaction():
            role, board = require_role(conn, board_id, user["id"], lock=True)
            actor = conn.execute("SELECT is_active,token_version FROM users WHERE id=%s FOR UPDATE", (user["id"],)).fetchone()
            if not actor or not actor["is_active"] or int(actor["token_version"]) != int(user["token_version"]):
                raise ApiError(401, "UNAUTHORIZED", "Сессия завершена. Войдите снова.")
            receipt = conn.execute("SELECT actor_id,request_hash,result FROM board_operation_receipts WHERE board_id=%s AND op_id=%s", (board_id, operation.op_id)).fetchone()
            if receipt:
                if receipt["actor_id"] != user["id"] or receipt["request_hash"] != request_hash:
                    raise ApiError(409, "OP_ID_REUSED", "opId уже использован для другой операции.")
                return receipt["result"], None, True
            current_row = conn.execute("SELECT * FROM board_objects WHERE board_id=%s AND object_id=%s", (board_id, operation.object_id)).fetchone()
            if operation.action == "create":
                if current_row:
                    raise ApiError(409, "OBJECT_EXISTS", "Объект с таким ID уже существует.", {"currentObject": object_json(conn, current_row)})
                active_count = conn.execute("SELECT COUNT(*) AS total FROM board_objects WHERE board_id=%s AND deleted=FALSE", (board_id,)).fetchone()["total"]
                if active_count >= 1000:
                    raise ApiError(409, "BOARD_LIMIT", "На доске уже 1 000 объектов.")
                try:
                    payload, obj_type, attachment_id = validated_object(operation.object or {}, operation.object_id)
                except (ValueError, ValidationError) as exc:
                    raise ApiError(422, "INVALID_OBJECT", str(exc)) from None
                if attachment_id and not conn.execute("SELECT 1 FROM board_attachments WHERE board_id=%s AND id=%s", (board_id, attachment_id)).fetchone():
                    raise ApiError(404, "ATTACHMENT_NOT_FOUND", "Вложение не найдено на этой доске.")
                row = conn.execute(
                    "INSERT INTO board_objects(board_id,object_id,type,payload,attachment_id,revision,deleted) VALUES (%s,%s,%s,%s,%s,1,FALSE) RETURNING *",
                    (board_id, operation.object_id, obj_type, Jsonb(payload), attachment_id),
                ).fetchone()
            else:
                if not current_row:
                    raise missing_object()
                current = object_json(conn, current_row)
                if int(current_row["revision"]) != operation.base_revision:
                    raise ApiError(409, "REVISION_CONFLICT", "Объект уже изменён.", {"opId": str(operation.op_id), "currentObject": current, "serverSeq": int(board["server_seq"])})
                if operation.action == "update":
                    if current_row["deleted"]:
                        raise ApiError(409, "OBJECT_STATE_CONFLICT", "Удалённый объект нельзя изменить.", {"currentObject": current})
                    allowed = {"x", "y", "w", "h", "text", "color"}
                    if current_row["type"] == "stroke":
                        allowed.add("points")
                    if current_row["type"] == "text":
                        allowed.update({"headline", "small"})
                    if not set(operation.patch or {}).issubset(allowed):
                        raise ApiError(422, "INVALID_PATCH", "patch содержит неизменяемое или неизвестное поле.")
                    merged = {"id": str(operation.object_id), "type": current_row["type"], **current_row["payload"], **(operation.patch or {})}
                    if current_row["attachment_id"]:
                        merged["attachmentId"] = str(current_row["attachment_id"])
                    try:
                        payload, obj_type, attachment_id = validated_object(merged, operation.object_id)
                    except (ValueError, ValidationError) as exc:
                        raise ApiError(422, "INVALID_PATCH", str(exc)) from None
                    row = conn.execute("UPDATE board_objects SET payload=%s,revision=revision+1,updated_at=now() WHERE board_id=%s AND object_id=%s RETURNING *", (Jsonb(payload), board_id, operation.object_id)).fetchone()
                elif operation.action == "delete":
                    if current_row["deleted"]:
                        raise ApiError(409, "OBJECT_STATE_CONFLICT", "Объект уже удалён.", {"currentObject": current})
                    row = conn.execute("UPDATE board_objects SET deleted=TRUE,revision=revision+1,updated_at=now() WHERE board_id=%s AND object_id=%s RETURNING *", (board_id, operation.object_id)).fetchone()
                else:
                    if not current_row["deleted"]:
                        raise ApiError(409, "OBJECT_STATE_CONFLICT", "Объект уже восстановлен.", {"currentObject": current})
                    active_count = conn.execute("SELECT COUNT(*) AS total FROM board_objects WHERE board_id=%s AND deleted=FALSE", (board_id,)).fetchone()["total"]
                    if active_count >= 1000:
                        raise ApiError(409, "BOARD_LIMIT", "На доске уже 1 000 объектов.")
                    row = conn.execute("UPDATE board_objects SET deleted=FALSE,revision=revision+1,updated_at=now() WHERE board_id=%s AND object_id=%s RETURNING *", (board_id, operation.object_id)).fetchone()
            seq = int(board["server_seq"]) + 1
            if seq > 9_007_199_254_740_991:
                raise ApiError(409, "SEQUENCE_LIMIT", "Достигнут предел номера операции.")
            conn.execute("UPDATE boards SET server_seq=%s,updated_at=now() WHERE id=%s", (seq, board_id))
            saved = object_json(conn, row)
            ack = {"opId": str(operation.op_id), "serverSeq": seq, "object": saved}
            event = {"type": "operation", **ack, "actorId": str(user["id"])}
            conn.execute(
                "INSERT INTO board_operation_receipts(board_id,op_id,actor_id,request_hash,server_seq,result,event) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (board_id, operation.op_id, user["id"], request_hash, seq, Jsonb(ack), Jsonb(event)),
            )
    return ack, event, False


def _canonical_numbers(value):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_canonical_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonical_numbers(item) for key, item in value.items()}
    return value


def _clean_stale_uploads(pool: ConnectionPool, file_root: Path) -> None:
    cutoff = time.time() - 24 * 60 * 60
    with pool.connection() as conn:
        known = {str(row["storage_key"]) for row in conn.execute("SELECT storage_key FROM board_attachments").fetchall()}
    for path in file_root.iterdir():
        if path.name.startswith(".upload-"):
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        elif path.name not in known and path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)


app = create_app()
