import uuid
import io
import logging

from conftest import auth_headers
from ryadom_backend.main import logger


def test_registration_login_me_rotation_logout_and_legacy_login(api):
    email = f"auth-{uuid.uuid4()}@example.test"
    registration = api.post("/api/v1/auth/register", json={"email": email, "password": "correct-horse-battery", "displayName": "Анна"})
    assert registration.status_code == 201
    first = registration.json()["data"]
    assert first["user"]["email"] == email
    assert api.get("/api/v1/users/me", headers=auth_headers(first)).json()["data"]["displayName"] == "Анна"
    assert api.post("/api/v1/users/register", json={"email": email, "password": "correct-horse-battery", "displayName": "Дубль"}).status_code == 409
    assert api.post("/api/v1/auth/login", json={"email": email, "password": "wrong password"}).status_code == 401

    legacy_login = api.post("/api/v1/users/login", json={"email": email, "password": "correct-horse-battery"})
    assert legacy_login.status_code == 200
    old_session = legacy_login.json()["data"]
    rotated = api.post("/api/v1/auth/refresh", json={"refresh_token": old_session["refresh_token"]})
    assert rotated.status_code == 200
    fresh = rotated.json()["data"]
    assert api.post("/api/v1/auth/refresh", json={"refresh_token": old_session["refresh_token"]}).status_code == 401
    assert api.post("/api/v1/auth/logout", headers=auth_headers(fresh)).json()["data"]["loggedOut"] is True
    assert api.get("/api/v1/users/me", headers=auth_headers(fresh)).status_code == 401


def test_note_snapshot_routes_preserve_frontend_envelope_and_isolation(api, account):
    snapshot = {"format": "ryadom-board", "version": 1, "title": "Мои идеи", "objects": []}
    created = api.post("/api/v1/notes", headers=auth_headers(account), json={"title": "[Доска] Мои идеи", "content": __import__("json").dumps(snapshot)})
    assert created.status_code == 201
    note_id = created.json()["data"]["id"]
    loaded = api.get(f"/api/v1/notes/{note_id}", headers=auth_headers(account))
    assert loaded.status_code == 200
    assert __import__("json").loads(loaded.json()["data"]["content"]) == snapshot
    other = api.post("/api/v1/auth/register", json={"email": f"other-{uuid.uuid4()}@example.test", "password": "another-secure-pass", "displayName": "Другой"}).json()["data"]
    assert api.get(f"/api/v1/notes/{note_id}", headers=auth_headers(other)).status_code == 404
    assert api.post("/api/v1/notes", headers=auth_headers(account), json={"title": "Плохо", "content": "not json"}).status_code == 422
    assert api.post("/api/v1/notes", json={"title": "Нет сессии", "content": "{}"}).status_code == 401


def test_request_logs_record_result_without_credentials(api, account):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger.addHandler(handler)
    try:
        response = api.get("/api/v1/users/me", headers=auth_headers(account))
    finally:
        logger.removeHandler(handler)
    assert response.status_code == 200
    assert "method=GET path=/api/v1/users/me status=200" in stream.getvalue()
    assert account["access_token"] not in stream.getvalue()
    assert account["email"] not in stream.getvalue()
