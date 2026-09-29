import hashlib
import uuid

from conftest import auth_headers
from test_api_boards import new_board, operation


PNG = b"\x89PNG\r\n\x1a\nboard-fixture"


def upload(api, account, board_id, payload=PNG, name="drawing.png", key=None):
    upload_id = str(key or uuid.uuid4())
    return api.post(
        f"/api/v1/boards/{board_id}/attachments",
        headers={**auth_headers(account), "Idempotency-Key": upload_id},
        files={"file": (name, payload)},
    ), upload_id


def test_attachment_validation_idempotency_storage_and_membership(api, account):
    board = new_board(api, account)
    board_id = board["id"]
    result, key = upload(api, account, board_id)
    assert result.status_code == 201, result.text
    attachment = result.json()["data"]
    assert attachment["mime"] == "image/png"
    assert attachment["size"] == len(PNG)
    assert attachment["sha256"] == hashlib.sha256(PNG).hexdigest()
    replay, _ = upload(api, account, board_id, key=key)
    assert replay.status_code == 200 and replay.json()["data"]["id"] == attachment["id"]
    reused, _ = upload(api, account, board_id, b"different png bytes", key=uuid.UUID(key))
    assert reused.status_code == 409 and reused.json()["code"] == "UPLOAD_ID_REUSED"

    object_id = uuid.uuid4()
    image = {"id": str(object_id), "type": "image", "x": 0, "y": 0, "w": 100, "h": 80, "text": "drawing.png", "color": "mint", "attachmentId": attachment["id"]}
    saved = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=operation(object_id, "create", 0, object=image))
    assert saved.status_code == 200, saved.text
    downloaded = api.get(attachment["downloadUrl"], headers=auth_headers(account))
    assert downloaded.status_code == 200 and downloaded.content == PNG
    assert "attachment" in downloaded.headers["content-disposition"]
    snapshot = api.get(f"/api/v1/boards/{board_id}", headers=auth_headers(account)).json()["data"]
    assert snapshot["objects"][0]["attachmentId"] == attachment["id"]
    assert snapshot["attachments"][0]["sha256"] == attachment["sha256"]
    outsider = api.post("/api/v1/auth/register", json={"email": f"file-reader-{uuid.uuid4()}@example.test", "password": "file-reader-secure", "displayName": "Читатель"}).json()["data"]
    assert api.get(attachment["downloadUrl"], headers=auth_headers(outsider)).status_code == 404
    svg, _ = upload(api, account, board_id, b"<svg xmlns='http://www.w3.org/2000/svg'/>", "bad.svg")
    assert svg.status_code == 415


def test_admin_user_list_updates_and_last_admin_protection(api, account):
    admin = api.post("/api/v1/auth/register", json={"email": "root@example.test", "password": "root-account-secure", "displayName": "Администратор", "adminSetupToken": "tests-only-admin-setup-token-123456789"}).json()["data"]
    assert admin["user"]["role"] == "admin"
    headers = auth_headers(admin)
    listing = api.get("/api/v1/admin/users?limit=1", headers=headers)
    assert listing.status_code == 200 and listing.json()["data"]["nextOffset"] == 1
    assert api.get("/api/v1/admin/users", headers=auth_headers(account)).status_code == 403
    blocked = api.patch(f"/api/v1/admin/users/{account['user']['id']}", headers=headers, json={"isActive": False})
    assert blocked.status_code == 200 and blocked.json()["data"]["isActive"] is False
    assert api.get("/api/v1/users/me", headers=auth_headers(account)).status_code == 401
    assert api.post("/api/v1/auth/login", json={"email": account["email"], "password": "secure-test-password"}).status_code == 401
    last_admin = api.patch(f"/api/v1/admin/users/{admin['user']['id']}", headers=headers, json={"role": "user"})
    assert last_admin.status_code == 409 and last_admin.json()["code"] == "LAST_ADMIN"


def test_attachment_requires_valid_id_and_existing_board(api, account):
    invalid = api.post("/api/v1/boards/not-a-uuid/attachments", headers={**auth_headers(account), "Idempotency-Key": str(uuid.uuid4())}, files={"file": ("drawing.png", PNG)})
    assert invalid.status_code == 422
    missing = api.post(f"/api/v1/boards/{uuid.uuid4()}/attachments", headers={**auth_headers(account), "Idempotency-Key": str(uuid.uuid4())}, files={"file": ("drawing.png", PNG)})
    assert missing.status_code == 404
