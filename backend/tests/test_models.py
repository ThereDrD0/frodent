from uuid import uuid4
import asyncio

import httpx
import pytest
from pydantic import ValidationError
from fastapi import FastAPI, Request

from ryadom_backend.models import BoardCreate, ObjectDraft, OperationInput, RegisterInput, validated_object
from ryadom_backend.main import RequestBodyLimitMiddleware, _canonical_numbers, app as api_app


def object_payload(kind="sticky", **changes):
    data = {"id": str(uuid4()), "type": kind, "x": 12, "y": 20, "w": 240, "h": 180, "text": "Заметка", "color": "mint"}
    data.update(changes)
    return data


def test_account_and_board_inputs_are_normalized():
    user = RegisterInput.model_validate({"email": "  Person@Example.test ", "password": "1234567890", "displayName": "  Анна  "})
    assert user.email == "person@example.test"
    assert user.display_name == "Анна"
    assert BoardCreate(title="  Идеи ").title == "Идеи"


def test_board_title_and_password_limits():
    with pytest.raises(ValidationError):
        BoardCreate(title="  ")
    with pytest.raises(ValidationError):
        RegisterInput(email="bad", password="short", displayName="A")


def test_all_six_object_types_and_specific_fields():
    for kind in ("sticky", "text", "shape", "stroke", "image", "file"):
        extra = {"points": [[0, 0], [1, 1]]} if kind == "stroke" else {}
        if kind in ("image", "file"):
            extra["attachmentId"] = str(uuid4())
        payload, actual_kind, attachment = validated_object(object_payload(kind, **extra))
        assert actual_kind == kind
        assert payload["x"] == 12
        assert attachment is not None if kind in ("image", "file") else attachment is None


def test_image_assets_are_explicit_and_operation_hash_numbers_are_stable():
    payload, kind, attachment = validated_object(object_payload("image", asset="landscape"))
    assert kind == "image" and attachment is None and payload["asset"] == "landscape"
    with pytest.raises(ValidationError):
        ObjectDraft.model_validate(object_payload("image"))
    assert _canonical_numbers({"x": 4.0, "nested": [True, 2.5]}) == {"x": 4, "nested": [True, 2.5]}


@pytest.mark.parametrize("patch", [
    {"x": float("nan")}, {"x": 1_000_001}, {"w": 0}, {"text": "x" * 20_001},
    {"color": "purple"}, {"points": [[1, 2]]}, {"blobId": "local-indexed-db-id"},
])
def test_invalid_object_fields_are_rejected(patch):
    with pytest.raises(ValidationError):
        ObjectDraft.model_validate(object_payload(**patch))


def test_utf16_text_limit_matches_javascript_string_length():
    with pytest.raises(ValidationError):
        ObjectDraft.model_validate(object_payload(text="😀" * 10_001))


def test_strokes_reject_too_many_points_and_bad_coordinate_pairs():
    with pytest.raises(ValidationError):
        ObjectDraft.model_validate(object_payload("stroke", points=[[0, 0]] * 10_001))
    with pytest.raises(ValidationError):
        ObjectDraft.model_validate(object_payload("stroke", points=[[0, 0, 0]]))


def test_operations_validate_action_shapes_and_uuid_match():
    object_id = uuid4()
    request = OperationInput.model_validate({"opId": str(uuid4()), "objectId": str(object_id), "action": "create", "baseRevision": 0, "object": object_payload(id=str(object_id))})
    assert request.object_id == object_id
    with pytest.raises(ValidationError):
        OperationInput.model_validate({"opId": str(uuid4()), "objectId": str(object_id), "action": "create", "baseRevision": 1, "object": object_payload(id=str(object_id))})
    with pytest.raises(ValueError):
        validated_object(object_payload(), uuid4())


def test_http_request_body_limit_returns_413_before_route():
    app = FastAPI()
    app.add_middleware(RequestBodyLimitMiddleware)

    @app.post("/api/v1/notes")
    async def too_large(request: Request):
        return {"bytes": len(await request.body())}

    async def streamed_body():
        yield b"x" * (850 * 1024)
        yield b"x"

    async def send():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/api/v1/notes", content=b"x" * (850 * 1024 + 1)), await client.post("/api/v1/notes", content=streamed_body())
    declared, streamed = asyncio.run(send())
    for response in (declared, streamed):
        assert response.status_code == 413
        assert response.json()["code"] == "REQUEST_TOO_LARGE"


def test_shape_kinds_validation_and_defaults():
    for kind in ("rect", "ellipse", "diamond"):
        payload, obj_type, _ = validated_object(object_payload("shape", shapeKind=kind))
        assert obj_type == "shape"
        assert payload["shapeKind"] == kind

    default_payload, obj_type, _ = validated_object(object_payload("shape"))
    assert obj_type == "shape"
    assert default_payload["shapeKind"] == "rect"

    with pytest.raises(ValidationError):
        ObjectDraft.model_validate(object_payload("sticky", shapeKind="rect"))


def test_openapi_documents_the_frontend_and_board_routes():
    paths = api_app.openapi()["paths"]
    assert "/api/v1/users/login" in paths
    assert "/api/v1/notes" in paths
    assert "/api/v1/boards/{board_id}/operations" in paths
    assert "/api/v1/boards/{board_id}/attachments/{file_id}" in paths
    assert "/api/v1/admin/users/{target_id}" in paths
