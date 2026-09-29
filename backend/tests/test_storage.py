import io
import zipfile

import pytest

from ryadom_backend.storage import detect_mime, safe_filename, sha256, write_atomic


def test_image_and_document_signatures():
    assert detect_mime("space.png", b"\x89PNG\r\n\x1a\nfixture") == "image/png"
    assert detect_mime("space.pdf", b"%PDF-1.7\nfixture") == "application/pdf"
    assert detect_mime("readme.txt", "доска".encode()) == "text/plain"
    assert detect_mime("report.rtf", b"{\\rtf1 fixture}") == "application/rtf"


@pytest.mark.parametrize("name,data", [
    ("upload.svg", b"<svg/>",), ("page.html", b"<html>",), ("spoof.png", b"not an image"),
    ("invalid.txt", b"\xff\x00"), ("executable.exe", b"MZ"),
])
def test_unsafe_or_mismatched_files_rejected(name, data):
    with pytest.raises(ValueError):
        detect_mime(name, data)


def test_office_zip_container_structure_is_checked():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
    assert detect_mime("notes.docx", stream.getvalue()).endswith("wordprocessingml.document")
    with pytest.raises(ValueError):
        detect_mime("notes.xlsx", stream.getvalue())


def test_filename_storage_and_checksum_are_safe(tmp_path):
    assert safe_filename(r"C:\\Users\\person\\a<bad>.png") == "abad.png"
    payload = b"image bytes"
    path = write_atomic(tmp_path, "f" * 36, payload)
    assert path.read_bytes() == payload
    assert sha256(payload) == "de7030234493a8bea844dbe1d8676e68a2c1a4b014c721f0425a22b6df66faec"
