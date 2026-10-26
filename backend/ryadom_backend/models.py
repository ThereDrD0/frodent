from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RegisterInput(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=10, max_length=256)
    display_name: str = Field(alias="displayName", min_length=1, max_length=80)
    admin_setup_token: str | None = Field(default=None, alias="adminSetupToken", max_length=256)

    @field_validator("email")
    @classmethod
    def email_shape(cls, value: str) -> str:
        value = value.strip().lower()
        if value.count("@") != 1 or any(ch.isspace() for ch in value):
            raise ValueError("Некорректный email.")
        local, domain = value.split("@")
        if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
            raise ValueError("Некорректный email.")
        return value

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Имя не должно быть пустым.")
        return value


class LoginInput(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)

    @field_validator("email")
    @classmethod
    def lower_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshInput(StrictModel):
    refresh_token: str = Field(alias="refresh_token", min_length=20, max_length=256)


class BoardCreate(StrictModel):
    title: str = Field(min_length=1, max_length=180)

    @field_validator("title")
    @classmethod
    def title_trimmed(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Название не должно быть пустым.")
        return value


class BoardRename(BoardCreate):
    pass


class InviteAccept(StrictModel):
    token: str = Field(min_length=32, max_length=128)


class AdminUserPatch(StrictModel):
    is_active: bool | None = Field(default=None, alias="isActive")
    role: Literal["user", "admin"] | None = None

    @model_validator(mode="after")
    def has_update(self):
        if self.is_active is None and self.role is None:
            raise ValueError("Укажите isActive или role.")
        return self


class ObjectDraft(StrictModel):
    id: UUID
    type: Literal["sticky", "text", "shape", "stroke", "image", "file", "connector"]
    x: float
    y: float
    w: float
    h: float
    text: str = Field(max_length=20_000)
    color: Literal["mint", "blue", "neutral"]
    points: list[list[float]] | None = None
    shape_kind: Literal["rect", "ellipse", "diamond"] | None = Field(default=None, alias="shapeKind")
    headline: bool | None = None
    small: bool | None = None
    attachment_id: UUID | None = Field(default=None, alias="attachmentId")
    asset: Literal["landscape"] | None = None
    from_id: UUID | None = Field(default=None, alias="fromId")
    to_id: UUID | None = Field(default=None, alias="toId")
    from_side: Literal["top", "right", "bottom", "left"] | None = Field(default=None, alias="fromSide")
    to_side: Literal["top", "right", "bottom", "left"] | None = Field(default=None, alias="toSide")
    start_x: float | None = Field(default=None, alias="startX")
    start_y: float | None = Field(default=None, alias="startY")
    end_x: float | None = Field(default=None, alias="endX")
    end_y: float | None = Field(default=None, alias="endY")
    style: Literal["curved", "straight", "orthogonal"] | None = None

    @field_validator("x", "y", "start_x", "start_y", "end_x", "end_y")
    @classmethod
    def position_limit(cls, value: float | None) -> float | None:
        if value is not None and not -1_000_000 <= value <= 1_000_000:
            raise ValueError("Координата выходит за допустимые границы.")
        return value

    @field_validator("w", "h")
    @classmethod
    def size_limit(cls, value: float) -> float:
        if not 0 < value <= 1_000_000:
            raise ValueError("Размер должен быть больше нуля и не превышать 1 000 000.")
        return value

    @field_validator("text")
    @classmethod
    def utf16_text_limit(cls, value: str) -> str:
        if len(value.encode("utf-16-le")) // 2 > 20_000:
            raise ValueError("Текст не должен превышать 20 000 символов UTF-16.")
        return value

    @model_validator(mode="after")
    def type_fields(self):
        if self.type == "stroke":
            if self.points is None or not 1 <= len(self.points) <= 10_000:
                raise ValueError("Штрих должен содержать от 1 до 10 000 точек.")
            if any(len(point) != 2 or any(not -1_000_000 <= value <= 1_000_000 for value in point) for point in self.points):
                raise ValueError("Координаты штриха выходят за допустимые границы.")
        elif self.points is not None:
            raise ValueError("Точки допустимы только у штриха.")
        if self.type == "shape":
            if self.shape_kind is None:
                self.shape_kind = "rect"
        elif self.shape_kind is not None:
            raise ValueError("shapeKind допустим только у объекта типа shape.")
        if self.type == "file" and self.attachment_id is None:
            raise ValueError("Для файла требуется attachmentId.")
        if self.type == "image" and ((self.attachment_id is None and self.asset is None) or (self.attachment_id is not None and self.asset is not None)):
            raise ValueError("Для изображения укажите attachmentId или допустимый asset.")
        if self.type not in ("image", "file") and self.attachment_id is not None:
            raise ValueError("attachmentId допустим только у файла или изображения.")
        if self.type != "image" and self.asset is not None:
            raise ValueError("asset допустим только у изображения.")
        if self.type != "text" and (self.headline is not None or self.small is not None):
            raise ValueError("headline и small допустимы только у текстового объекта.")
        if self.type == "connector":
            if self.style is None:
                self.style = "curved"
            if any(v is not None for v in (self.points, self.headline, self.small, self.attachment_id, self.asset, self.shape_kind)):
                raise ValueError("Поля других типов недопустимы у коннектора.")
        else:
            if any(v is not None for v in (self.from_id, self.to_id, self.from_side, self.to_side, self.start_x, self.start_y, self.end_x, self.end_y, self.style)):
                raise ValueError("Поля связи допустимы только у объекта типа connector.")
        return self


class OperationInput(StrictModel):
    op_id: UUID = Field(alias="opId")
    object_id: UUID = Field(alias="objectId")
    action: Literal["create", "update", "delete", "restore"]
    base_revision: int = Field(alias="baseRevision", ge=0, le=9_007_199_254_740_991)
    object: dict[str, Any] | None = None
    patch: dict[str, Any] | None = None

    @model_validator(mode="after")
    def action_fields(self):
        if self.action == "create" and (self.object is None or self.patch is not None or self.base_revision != 0):
            raise ValueError("create требует object и baseRevision=0.")
        if self.action == "update" and (not self.patch or self.object is not None):
            raise ValueError("update требует непустой patch.")
        if self.action in ("delete", "restore") and (self.patch is not None or self.object is not None):
            raise ValueError("delete и restore не принимают object или patch.")
        return self


def validated_object(data: dict[str, Any], expected_id: UUID | None = None) -> tuple[dict[str, Any], str, UUID | None]:
    draft = ObjectDraft.model_validate(data)
    if expected_id is not None and draft.id != expected_id:
        raise ValueError("object.id должен совпадать с objectId.")
    attachment_id = draft.attachment_id
    payload = draft.model_dump(mode="json", by_alias=True, exclude={"id", "type", "attachment_id"}, exclude_none=True)
    payload["color"] = draft.color
    return payload, draft.type, attachment_id
