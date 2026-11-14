"""The parser's Python dependencies meet the same licence policy as tools/licences.ts (CLAUDE.md §9).

`pnpm licences` reads node_modules only; this test covers the parser's virtual environment.
"""

from __future__ import annotations

import importlib.metadata as metadata
import re

#: Same as tools/licences.ts ALLOWED, plus the spellings Python metadata uses for them, and the
#: permissive licences that only occur in the Python tree: PSF-2.0 (CPython-derived), CNRI-Python
#: (regex), MIT-CMU (Pillow), BSL-1.0 and Zlib (native bits inside wheels).
ALLOWED = {
    "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC0-1.0", "Unlicense",
    "Python-2.0", "MPL-2.0", "PSF-2.0", "CNRI-Python", "MIT-CMU", "BSL-1.0", "Zlib",
    "LLVM-exception",
}
CLASSIFIERS = {
    "MIT License": "MIT",
    "BSD License": "BSD-3-Clause",
    "Apache Software License": "Apache-2.0",
    "ISC License (ISCL)": "ISC",
    "Python Software Foundation License": "PSF-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
}
FREE_TEXT = {"Apache 2.0 License": "Apache-2.0", "BSD": "BSD-3-Clause"}
DENIED = ("GPL", "AGPL", "LGPL", "SSPL", "FSL", "BUSL", "Elastic", "Commons-Clause", "CC-BY-NC")
OURS = {"wakeel-parser"}
#: Reviewed by hand. pypdfium2 bundles PDFium (BSD-3-Clause, Apache-2.0) and the permissive libraries
#: PDFium itself bundles (FreeType, libjpeg-turbo, OpenJPEG, zlib, lcms2), listed as "dependency licenses".
REVIEWED = {"pypdfium2": {"BSD-3-Clause", "Apache-2.0"}}
SPLIT = re.compile(r"\s+(?:AND|OR|WITH)\s+|[(),]")


def licence_ids(dist: metadata.Distribution) -> set[str]:
    md = dist.metadata
    if dist.metadata["Name"] in REVIEWED:
        return REVIEWED[dist.metadata["Name"]]
    expression = (md.get("License-Expression") or "").strip()
    if expression:
        return {t.strip() for t in SPLIT.split(expression) if t.strip()}
    ids = {CLASSIFIERS.get(c.split(" :: ")[-1], c.split(" :: ")[-1]) for c in md.get_all("Classifier") or [] if c.startswith("License ::")}
    ids.discard("OSI Approved")
    if ids:
        return ids
    text = (md.get("License") or "").strip().splitlines()
    if not text:
        return set()
    return {FREE_TEXT.get(t.strip(), t.strip()) for t in SPLIT.split(text[0]) if t.strip()}


def test_every_installed_distribution_has_an_allowed_licence() -> None:
    problems = []
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        if name in OURS:
            continue
        ids = licence_ids(dist)
        if not ids:
            problems.append(f"{name}: no licence metadata")
        elif any(i.startswith(DENIED) for i in ids):
            problems.append(f"{name}: denied {ids}")
        elif not ids <= ALLOWED:
            problems.append(f"{name}: not on the allowed list {ids - ALLOWED}")
    assert problems == []
