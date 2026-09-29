import uuid

from conftest import auth_headers


def new_board(api, account):
    response = api.post("/api/v1/boards", headers=auth_headers(account), json={"title": "  Команда  "})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def operation(object_id, action, revision, **data):
    return {"opId": str(uuid.uuid4()), "objectId": str(object_id), "action": action, "baseRevision": revision, **data}


def sticky(object_id, text="Идея"):
    return {"id": str(object_id), "type": "sticky", "x": 10, "y": 20, "w": 240, "h": 180, "text": text, "color": "mint"}


def test_board_crud_operations_revision_conflict_receipts_and_sync(api, account):
    board = new_board(api, account)
    board_id = board["id"]
    initial = api.get(f"/api/v1/boards/{board_id}", headers=auth_headers(account)).json()["data"]
    assert initial["objects"] == [] and initial["attachments"] == [] and initial["serverSeq"] == 0
    assert api.get("/api/v1/boards", headers=auth_headers(account)).json()["data"]["items"][0]["id"] == board_id

    object_id = uuid.uuid4()
    create = operation(object_id, "create", 0, object=sticky(object_id))
    created = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=create)
    assert created.status_code == 200, created.text
    first_ack = created.json()["data"]
    assert first_ack["serverSeq"] == 1 and first_ack["object"]["revision"] == 1
    retry = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=create)
    assert retry.status_code == 200 and retry.json()["data"] == first_ack
    mismatch = {**create, "object": sticky(object_id, "другая нагрузка")}
    assert api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=mismatch).json()["code"] == "OP_ID_REUSED"

    update = operation(object_id, "update", 1, patch={"x": 160, "text": "Обновлено"})
    changed = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=update).json()["data"]
    assert changed["serverSeq"] == 2 and changed["object"]["revision"] == 2
    stale = operation(object_id, "update", 1, patch={"text": "Не терять"})
    conflict = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=stale)
    assert conflict.status_code == 409 and conflict.json()["code"] == "REVISION_CONFLICT"
    assert conflict.json()["data"]["currentObject"]["text"] == "Обновлено"

    events = api.get(f"/api/v1/boards/{board_id}/operations?afterSeq=1", headers=auth_headers(account)).json()["data"]
    assert [event["serverSeq"] for event in events["items"]] == [2]
    assert events["serverSeq"] == 2
    deleted = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=operation(object_id, "delete", 2)).json()["data"]
    assert deleted["object"]["deleted"] is True and deleted["object"]["revision"] == 3
    restored = api.post(f"/api/v1/boards/{board_id}/operations", headers=auth_headers(account), json=operation(object_id, "restore", 3)).json()["data"]
    assert restored["object"]["deleted"] is False and restored["object"]["revision"] == 4
    snapshot = api.get(f"/api/v1/boards/{board_id}", headers=auth_headers(account)).json()["data"]
    assert snapshot["objects"][0]["text"] == "Обновлено"


def test_board_roles_invites_and_revocation(api, account):
    board = new_board(api, account)
    outsider = api.post("/api/v1/auth/register", json={"email": f"editor-{uuid.uuid4()}@example.test", "password": "editor-test-password", "displayName": "Редактор"}).json()["data"]
    third = api.post("/api/v1/auth/register", json={"email": f"outsider-{uuid.uuid4()}@example.test", "password": "outsider-test-password", "displayName": "Гость"}).json()["data"]
    board_url = f"/api/v1/boards/{board['id']}"
    assert api.get(board_url, headers=auth_headers(third)).status_code == 404
    invitation = api.post(f"{board_url}/invite", headers=auth_headers(account)).json()["data"]
    token = invitation["url"].split("#invite=", 1)[1]
    accepted = api.post("/api/v1/board-invites/accept", headers=auth_headers(outsider), json={"token": token})
    assert accepted.status_code == 200 and accepted.json()["data"]["role"] == "editor"
    assert api.get(board_url, headers=auth_headers(outsider)).json()["data"]["role"] == "editor"
    members = api.get(f"{board_url}/members", headers=auth_headers(account)).json()["data"]["items"]
    assert {item["role"] for item in members} == {"owner", "editor"}
    assert api.patch(board_url, headers=auth_headers(outsider), json={"title": "Запрещено"}).status_code == 403
    assert api.delete(f"{board_url}/members/{account['user']['id']}", headers=auth_headers(account)).status_code == 409
    assert api.delete(f"{board_url}/members/{outsider['user']['id']}", headers=auth_headers(account)).json()["data"]["removed"] is True
    assert api.get(board_url, headers=auth_headers(outsider)).status_code == 404
    assert api.delete(f"{board_url}/invite", headers=auth_headers(account)).json()["data"]["revoked"] is True
    assert api.post("/api/v1/board-invites/accept", headers=auth_headers(third), json={"token": token}).status_code == 404
    renamed = api.patch(board_url, headers=auth_headers(account), json={"title": "Новое имя"})
    assert renamed.json()["data"]["title"] == "Новое имя"


def test_board_session_ticket_requires_membership_and_is_short_lived(api, account):
    board = new_board(api, account)
    board_url = f"/api/v1/boards/{board['id']}"
    ticket_response = api.post(f"{board_url}/session", headers=auth_headers(account))
    assert ticket_response.status_code == 200
    ticket = ticket_response.json()["data"]["ticket"]
    assert len(ticket) >= 40
    assert api.post(f"{board_url}/session").status_code == 401
    outsider = api.post("/api/v1/auth/register", json={"email": f"ws-{uuid.uuid4()}@example.test", "password": "websocket-secure-password", "displayName": "Гость"}).json()["data"]
    assert api.post(f"{board_url}/session", headers=auth_headers(outsider)).status_code == 404
