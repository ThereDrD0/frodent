"""Validated board attachment storage helpers."""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import re
import tempfile
import zipfile

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_BOARD_BYTES = 200 * 1024 * 1024
ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".ppt", ".pptx", ".txt", ".md", ".csv", ".odt", ".ods", ".odp", ".rtf",
}
MIMES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".odp": "application/vnd.oasis.opendocument.presentation", ".rtf": "application/rtf",
}
ZIP_MIMES = {".odt": b"application/vnd.oasis.opendocument.text", ".ods": b"application/vnd.oasis.opendocument.spreadsheet", ".odp": b"application/vnd.oasis.opendocument.presentation"}


def safe_filename(name: str) -> str:
    clean = name.replace("\\", "/").split("/")[-1]
    clean = "".join(ch for ch in clean if ch >= " " and ch not in "\x7f<>:\"|?*").strip().strip(".")
    return clean[:255] or "attachment.bin"


def detect_mime(name: str, data: bytes) -> str:
    extension = Path(safe_filename(name)).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError("Неподдерживаемый тип файла.")
    signatures = {
        ".png": data.startswith(b"\x89PNG\r\n\x1a\n"), ".jpg": data.startswith(b"\xff\xd8\xff"),
        ".jpeg": data.startswith(b"\xff\xd8\xff"), ".gif": data.startswith((b"GIF87a", b"GIF89a")),
        ".webp": len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
        ".pdf": data.startswith(b"%PDF-"), ".rtf": data.lstrip().startswith(b"{\\rtf"),
        ".doc": data.startswith(bytes.fromhex("D0CF11E0A1B11AE1")), ".xls": data.startswith(bytes.fromhex("D0CF11E0A1B11AE1")),
        ".ppt": data.startswith(bytes.fromhex("D0CF11E0A1B11AE1")),
    }
    if extension in (".txt", ".md", ".csv"):
        try:
            data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("Текстовый файл должен быть в UTF-8.") from exc
        if b"\x00" in data:
            raise ValueError("Текстовый файл содержит недопустимые байты.")
        return MIMES[extension]
    if extension in (".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"):
        if not data.startswith(b"PK\x03\x04"):
            raise ValueError("Сигнатура файла не совпадает с расширением.")
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                infos = archive.infolist()
                if len(infos) > 5000 or sum(info.file_size for info in infos) > 100 * 1024 * 1024:
                    raise ValueError("Структура документа слишком велика.")
                if any(info.compress_size and info.file_size / info.compress_size > 1000 for info in infos):
                    raise ValueError("Недопустимая степень сжатия в документе.")
                names = set(archive.namelist())
                if extension in ZIP_MIMES:
                    actual = archive.read("mimetype") if "mimetype" in names else b""
                    if actual != ZIP_MIMES[extension]:
                        raise ValueError("Сигнатура файла не совпадает с расширением.")
                else:
                    required = {"[Content_Types].xml", "word/document.xml" if extension == ".docx" else "xl/workbook.xml" if extension == ".xlsx" else "ppt/presentation.xml"}
                    if not required.issubset(names):
                        raise ValueError("Структура Office-документа некорректна.")
        except (zipfile.BadZipFile, KeyError) as exc:
            raise ValueError("Повреждённый архив документа.") from exc
    elif extension not in signatures or not signatures[extension]:
        raise ValueError("Сигнатура файла не совпадает с расширением.")
    return MIMES[extension]


def write_atomic(root: Path, key: str, data: bytes) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    destination = root / key
    fd, temporary = tempfile.mkstemp(prefix=".upload-", dir=root)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return destination


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
