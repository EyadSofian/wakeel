"""Task 8.2 acceptance for the parser service, against real Docling and the committed fixtures.

Arabic text-layer PDF pages are returned with an image for the vision OCR tier (ADR-040); the
worker's tests (packages/retrieval/test/parse.test.ts) cover what happens to them next.
"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-parser-token-0123456789"
FIXTURES = Path(__file__).parent / "fixtures"
PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@pytest.fixture(scope="module")
def client() -> TestClient:
    import os

    os.environ["PARSER_TOKEN"] = TOKEN
    os.environ["PARSER_MAX_BYTES"] = str(2 * 1024 * 1024)
    from wakeel_parser import app as module

    module._cached = None
    return TestClient(module.app)


def parse(client: TestClient, name: str, mime: str, body: bytes | None = None, token: str = TOKEN):
    return client.post(
        "/v1/parse",
        content=body if body is not None else (FIXTURES / name).read_bytes(),
        headers={"authorization": f"Bearer {token}", "content-type": mime, "x-file-name": name},
    )


def test_docx_headings_paragraphs_and_table_cells(client: TestClient) -> None:
    res = parse(client, "arabic.docx", DOCX)
    assert res.status_code == 200, res.text
    body = res.json()
    assert [h["text"] for h in body["headings"]] == ["سياسة الخصوصية", "البيانات التي نجمعها", "مدة الاحتفاظ"]
    levels = [h["level"] for h in body["headings"]]
    assert levels[0] < levels[1] == levels[2]
    assert body["tables"][0]["rows"] == [
        ["نوع البيان", "مدة الاحتفاظ"],
        ["رقم الهاتف", "سنتان"],
        ["عنوان التوصيل", "سنة واحدة"],
    ]
    md = body["pages"][0]["markdown"]
    assert "نحتفظ بالبيانات لمدة سنتين ثم نحذفها تلقائيًا." in md
    # A DOCX has no rendered pages and its text is logical order: nothing goes to OCR.
    assert all("image" not in p for p in body["pages"])


def test_born_digital_arabic_pdf_keeps_headings_and_sends_pages_to_ocr(client: TestClient) -> None:
    res = parse(client, "arabic-born-digital.pdf", PDF)
    assert res.status_code == 200, res.text
    body = res.json()
    assert [h["text"] for h in body["headings"]] == ["دليل خدمة العملاء", "سياسة الاسترجاع", "الشحن والتوصيل"]
    assert body["pageCount"] == 1
    page = body["pages"][0]
    assert page["ocrReason"] == "arabic"
    assert base64.b64decode(page["image"]).startswith(b"\x89PNG")


def test_table_across_a_page_break_is_found_on_every_page(client: TestClient) -> None:
    res = parse(client, "table-page-break.pdf", PDF)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["pageCount"] >= 2
    pages = sorted({t["page"] for t in body["tables"]})
    assert len(pages) >= 2, "the table continues past the first page"
    for t in body["tables"]:
        assert len(t["rows"][0]) == 3
        assert set(t["rows"][0]) == {"المنتج", "السعر", "الحالة"}, "the header repeats on each page"
    data_rows = sum(len(t["rows"]) - 1 for t in body["tables"])
    assert data_rows == 60
    # Every page is Arabic, so every page goes to the vision model with its image.
    assert all(p.get("ocrReason") == "arabic" for p in body["pages"])


def test_scanned_page_has_no_text_and_comes_back_as_an_image(client: TestClient) -> None:
    res = parse(client, "scanned-arabic.pdf", PDF)
    assert res.status_code == 200, res.text
    page = res.json()["pages"][0]
    assert page["chars"] == 0
    assert page["ocrReason"] == "low_text"
    assert base64.b64decode(page["image"]).startswith(b"\x89PNG")


def test_refuses_a_wrong_token(client: TestClient) -> None:
    assert parse(client, "arabic.docx", DOCX, token="wrong-token-wrong-token").status_code == 401


def test_refuses_a_type_it_does_not_read(client: TestClient) -> None:
    res = parse(client, "x.zip", "application/zip", body=b"PK\x03\x04rest")
    assert res.status_code == 422
    assert res.json()["code"] == "document_parse_failed"


def test_refuses_content_that_does_not_match_the_declared_type(client: TestClient) -> None:
    res = parse(client, "fake.pdf", PDF, body=b"MZ\x90\x00 not a pdf")
    assert res.status_code == 422
    assert "not a valid application/pdf" in res.json()["title"]


def test_refuses_an_empty_file(client: TestClient) -> None:
    assert parse(client, "empty.pdf", PDF, body=b"").status_code == 422


def test_refuses_a_file_over_the_size_limit(client: TestClient) -> None:
    res = parse(client, "big.pdf", PDF, body=b"%PDF-" + b"0" * (2 * 1024 * 1024))
    assert res.status_code == 413
    assert res.json()["code"] == "payload_too_large"


def test_a_malformed_pdf_is_a_parse_failure_not_a_crash(client: TestClient) -> None:
    res = parse(client, "broken.pdf", PDF, body=b"%PDF-1.7\n" + b"\x00garbage" * 200)
    assert res.status_code == 422
    assert res.json()["code"] == "document_parse_failed"
