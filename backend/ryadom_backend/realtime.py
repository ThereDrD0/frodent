from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import json
import math
import secrets
import uuid

from fastapi import WebSocket


@dataclass
class Session:
    id: str
    board_id: str
    user_id: str
    display_name: str
    socket: WebSocket
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class RealtimeHub:
    def __init__(self):
        self.tickets: dict[str, tuple[str, str, datetime]] = {}
        self.sessions: dict[str, Session] = {}
        self.lock = asyncio.Lock()

    def issue_ticket(self, board_id: str, user_id: str) -> tuple[str, datetime]:
        ticket = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(seconds=30)
        self.tickets[ticket] = (board_id, user_id, expires)
        return ticket, expires

    async def consume_ticket(self, ticket: str, board_id: str) -> str | None:
        async with self.lock:
            value = self.tickets.get(ticket)
            if not value or value[2] <= datetime.now(timezone.utc):
                self.tickets.pop(ticket, None)
                return None
            if value[0] != board_id:
                return None
            self.tickets.pop(ticket, None)
            return value[1]

    async def connect(self, board_id: str, user: dict, socket: WebSocket) -> Session | None:
        async with self.lock:
            active = [session for session in self.sessions.values() if session.board_id == board_id]
            if len(active) >= 10:
                return None
            await socket.accept()
            session = Session(str(uuid.uuid4()), board_id, str(user["id"]), user["display_name"], socket)
            participants = [{"sessionId": item.id, "userId": item.user_id, "displayName": item.display_name} for item in active]
            self.sessions[session.id] = session
        await self._send(session, {"type": "ready", "sessionId": session.id, "participants": participants})
        await self.publish(board_id, {"type": "presence.join", "participant": {"sessionId": session.id, "userId": session.user_id, "displayName": session.display_name}}, except_id=session.id)
        return session

    async def disconnect(self, session: Session) -> None:
        async with self.lock:
            self.sessions.pop(session.id, None)
        await self.publish(session.board_id, {"type": "presence.leave", "sessionId": session.id}, except_id=session.id)

    async def publish(self, board_id: str, message: dict, except_id: str | None = None) -> None:
        async with self.lock:
            recipients = [item for item in self.sessions.values() if item.board_id == board_id and item.id != except_id]
        await asyncio.gather(*(self._send(item, message) for item in recipients), return_exceptions=True)

    async def _send(self, session: Session, message: dict) -> None:
        try:
            async with session.lock:
                await session.socket.send_json(message)
        except Exception:
            pass

    async def close_user(self, user_id: str, code: int = 4401) -> None:
        async with self.lock:
            sessions = [item for item in self.sessions.values() if item.user_id == user_id]
        for session in sessions:
            try:
                await session.socket.close(code=code, reason="Доступ отозван")
            except Exception:
                pass

    async def close_member(self, board_id: str, user_id: str) -> None:
        async with self.lock:
            sessions = [item for item in self.sessions.values() if item.board_id == board_id and item.user_id == user_id]
        for session in sessions:
            try:
                await session.socket.close(code=4403, reason="Доступ к доске отозван")
            except Exception:
                pass

    def participants(self, board_id: str) -> list[dict]:
        return [{"sessionId": item.id, "userId": item.user_id, "displayName": item.display_name} for item in self.sessions.values() if item.board_id == board_id]


def valid_ephemeral(message: object) -> bool:
    if not isinstance(message, dict) or message.get("type") not in {"cursor", "selection", "stroke-preview", "editing", "leave"}:
        return False
    if message["type"] == "cursor":
        return set(message) == {"type", "x", "y"} and all(isinstance(message.get(key), (int, float)) and math.isfinite(message[key]) and abs(message[key]) <= 1_000_000 for key in ("x", "y"))
    if message["type"] == "stroke-preview":
        points = message.get("points")
        return set(message) == {"type", "points"} and isinstance(points, list) and len(points) <= 200 and all(isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) and math.isfinite(v) and abs(v) <= 1_000_000 for v in p) for p in points)
    if message["type"] == "selection":
        return set(message).issubset({"type", "objectId"}) and (message.get("objectId") is None or _is_uuid(message.get("objectId")))
    if message["type"] == "editing":
        return set(message).issubset({"type", "objectId"}) and (message.get("objectId") is None or _is_uuid(message.get("objectId")))
    return set(message) == {"type"}


def _is_uuid(value: object) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False
