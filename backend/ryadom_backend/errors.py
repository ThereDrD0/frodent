from typing import Any


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, data: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.data = data


def missing_board() -> ApiError:
    return ApiError(404, "BOARD_NOT_FOUND", "Доска не найдена.")


def missing_object() -> ApiError:
    return ApiError(404, "OBJECT_NOT_FOUND", "Объект не найден.")
