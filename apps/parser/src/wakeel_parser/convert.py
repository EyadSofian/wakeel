"""Docling conversion with the parser's limits (task 8.2, ADR-040)."""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from functools import lru_cache

from docling.datamodel.base_models import ConversionStatus, DocumentStream, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption
from docling_core.types.doc import DocItemLabel, SectionHeaderItem, TableItem, TitleItem


class ParseFailure(Exception):
    """A document we cannot read; the message is shown to the builder."""


@dataclass(frozen=True)
class Limits:
    max_bytes: int
    max_pages: int
    #: A page with fewer extractable characters than this is returned as an image for the OCR tier.
    low_text_chars: int


@dataclass
class Page:
    number: int
    markdown: str
    chars: int
    image: bytes | None = None


@dataclass
class Result:
    title: str | None
    page_count: int
    pages: list[Page] = field(default_factory=list)
    tables: list[dict[str, object]] = field(default_factory=list)
    headings: list[dict[str, object]] = field(default_factory=list)


#: What the parser reads, by declared type. HTML, Markdown, text and CSV are handled in the worker.
FORMATS: dict[str, InputFormat] = {
    "application/pdf": InputFormat.PDF,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": InputFormat.DOCX,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": InputFormat.PPTX,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": InputFormat.XLSX,
    "image/png": InputFormat.IMAGE,
    "image/jpeg": InputFormat.IMAGE,
}

#: Magic bytes per format: the declared type must match the content (threat T10, MIME sniffing).
_MAGIC: dict[InputFormat, tuple[bytes, ...]] = {
    InputFormat.PDF: (b"%PDF-",),
    InputFormat.DOCX: (b"PK\x03\x04",),
    InputFormat.PPTX: (b"PK\x03\x04",),
    InputFormat.XLSX: (b"PK\x03\x04",),
    InputFormat.IMAGE: (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff"),
}

_EXT = {
    InputFormat.PDF: "pdf",
    InputFormat.DOCX: "docx",
    InputFormat.PPTX: "pptx",
    InputFormat.XLSX: "xlsx",
}


@lru_cache(maxsize=1)
def _converter() -> DocumentConverter:
    # Docling's own OCR is off: Arabic OCR goes to the vision model in the worker, which has the
    # network and the workspace's key; this service has neither.
    pdf = PdfPipelineOptions(do_ocr=False, do_table_structure=True, generate_page_images=True, images_scale=1.5)
    return DocumentConverter(
        allowed_formats=list(set(FORMATS.values())),
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=pdf),
        },
    )


def _png(image: object) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")  # type: ignore[attr-defined]
    return buf.getvalue()


def convert(body: bytes, mime: str, name: str, limits: Limits) -> Result:
    fmt = FORMATS.get(mime)
    if fmt is None:
        raise ParseFailure(f"We cannot read files of type {mime or 'unknown'}")
    if not body:
        raise ParseFailure("The file is empty")
    if not any(body.startswith(m) for m in _MAGIC[fmt]):
        raise ParseFailure(f"The file's content is not a valid {mime} file")

    ext = _EXT.get(fmt) or ("png" if body.startswith(b"\x89PNG") else "jpg")
    stream = DocumentStream(name=f"upload.{ext}", stream=io.BytesIO(body))
    try:
        conv = _converter().convert(stream, raises_on_error=False, max_num_pages=limits.max_pages, max_file_size=limits.max_bytes)
    except Exception as e:  # Docling raises many types for malformed input; the message is enough.
        raise ParseFailure(f"We could not read the file: {type(e).__name__}") from e
    if conv.status not in (ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS):
        raise ParseFailure("We could not read the file; if it has more than the page limit, split it")

    doc = conv.document
    result = Result(title=None, page_count=doc.num_pages() or 1)

    for item, _level in doc.iterate_items():
        if isinstance(item, TitleItem) and result.title is None:
            result.title = item.text.strip() or None
        if isinstance(item, (TitleItem, SectionHeaderItem)):
            level = 1 if isinstance(item, TitleItem) else item.level + 1
            result.headings.append({"level": level, "text": item.text.strip(), "page": _page_of(item)})
        if isinstance(item, TableItem):
            rows = [[cell.text.strip() for cell in row] for row in item.data.grid]
            result.tables.append({"page": _page_of(item), "rows": rows})
    if result.title is None:
        first = next((h for h in result.headings if h["level"] == 1), None)
        result.title = str(first["text"]) if first else None

    if doc.pages:
        for number in sorted(doc.pages):
            md = doc.export_to_markdown(page_no=number, escape_underscores=False)
            chars = _chars(md)
            page = Page(number=number, markdown=md, chars=chars)
            img = doc.pages[number].image
            if chars < limits.low_text_chars and img is not None and img.pil_image is not None:
                page.image = _png(img.pil_image)
            result.pages.append(page)
    else:
        md = doc.export_to_markdown(escape_underscores=False)
        result.pages.append(Page(number=1, markdown=md, chars=_chars(md)))

    del name  # Kept in the signature for logs a caller may add; the parser stores nothing.
    return result


def _page_of(item: object) -> int | None:
    prov = getattr(item, "prov", None) or []
    return prov[0].page_no if prov else None


def _chars(markdown: str) -> int:
    """Letters and digits only: table pipes, image placeholders and whitespace are not text."""
    text = markdown.replace("<!-- image -->", "")
    return sum(1 for ch in text if ch.isalnum())


__all__ = ["DocItemLabel", "Limits", "ParseFailure", "Result", "convert"]
