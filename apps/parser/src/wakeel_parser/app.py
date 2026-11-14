"""The parser service (task 8.2, architecture §8.1, ADR-007 §4, ADR-040).

Converts one uploaded document to Markdown with Docling and answers per-page Markdown, character
counts and, for pages with almost no extractable text, a PNG of the page so the worker can send it
to the vision model (the OCR tier). The service runs without network and without credentials
(threat T10); it never fetches anything and never sees a key.
"""

from __future__ import annotations

import base64
import hmac
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .convert import Limits, ParseFailure, convert

app = FastAPI(title="wakeel-parser", docs_url=None, redoc_url=None, openapi_url=None)


@dataclass(frozen=True)
class Settings:
    token: str
    limits: Limits
    timeout_seconds: float


def _settings() -> Settings:
    token = os.environ.get("PARSER_TOKEN", "")
    if len(token) < 16:
        raise RuntimeError("PARSER_TOKEN must be set to at least 16 characters")
    return Settings(
        token=token,
        limits=Limits(
            max_bytes=int(os.environ.get("PARSER_MAX_BYTES", str(50 * 1024 * 1024))),
            max_pages=int(os.environ.get("PARSER_MAX_PAGES", "500")),
            low_text_chars=int(os.environ.get("PARSER_LOW_TEXT_CHARS", "40")),
        ),
        timeout_seconds=float(os.environ.get("PARSER_TIMEOUT_SECONDS", "180")),
    )


_settings_lock = threading.Lock()
_cached: Settings | None = None


def settings() -> Settings:
    global _cached
    with _settings_lock:
        if _cached is None:
            _cached = _settings()
        return _cached


# One conversion at a time per process: Docling's models are large, and a second big PDF in
# parallel is how a parser runs out of memory. Scale by running more containers.
_pool = ThreadPoolExecutor(max_workers=1)


def problem(status: int, code: str, title: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        media_type="application/problem+json",
        content={"type": f"https://docs.wakeel.dev/errors/{code}", "code": code, "title": title, "status": status},
    )


@app.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/parse")
async def parse(request: Request) -> JSONResponse:
    s = settings()
    auth = request.headers.get("authorization", "")
    if not hmac.compare_digest(auth.encode(), f"Bearer {s.token}".encode()):
        return problem(401, "unauthenticated", "Missing or wrong parser token")

    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    name = request.headers.get("x-file-name") or "document"
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > s.limits.max_bytes:
        return problem(413, "payload_too_large", f"The file is larger than {s.limits.max_bytes} bytes")

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > s.limits.max_bytes:
            return problem(413, "payload_too_large", f"The file is larger than {s.limits.max_bytes} bytes")

    future = _pool.submit(convert, bytes(body), mime, name, s.limits)
    try:
        result = future.result(timeout=s.timeout_seconds)
    except FutureTimeout:
        return problem(504, "document_parse_failed", "Parsing took too long")
    except ParseFailure as e:
        return problem(422, "document_parse_failed", str(e))

    return JSONResponse(
        {
            "title": result.title,
            "pageCount": result.page_count,
            "pages": [
                {
                    "number": p.number,
                    "markdown": p.markdown,
                    "chars": p.chars,
                    **({"image": base64.b64encode(p.image).decode("ascii")} if p.image is not None else {}),
                }
                for p in result.pages
            ],
            "tables": result.tables,
            "headings": result.headings,
        }
    )

