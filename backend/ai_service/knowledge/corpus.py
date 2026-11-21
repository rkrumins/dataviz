"""The docs corpus as retrievable chunks.

One chunk per section (h2/h3), split further when a section is long, each
carrying the link the in-app reader uses for that section (``href`` with its
heading anchor). FAQ answers are a chunk each. ``{brand}`` tokens stay in the
text until an answer is written, when ``brand`` fills them in.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_PATH = Path(__file__).with_name("docs_corpus.generated.json")
CORPUS_ENV = "AI_DOCS_CORPUS_PATH"
CHUNKER = "sections-v1"
_MAX_CHARS = 1800
_TARGET_CHARS = 1200


@dataclass
class Chunk:
    id: str
    source_id: str
    ord: int
    title: str
    heading: str
    url: str
    text: str
    metadata: dict = field(default_factory=dict)

    @property
    def content_hash(self) -> str:
        return hashlib.sha1(f"{self.title}\x1f{self.heading}\x1f{self.text}".encode()).hexdigest()

    def embed_text(self) -> str:
        head = f"{self.title} — {self.heading}" if self.heading and self.heading != self.title else self.title
        return f"{head}\n{self.text}"[:2000]


def chunk_id(collection: str, source_id: str, ord_: int) -> str:
    return hashlib.sha1(f"{collection}\x1f{source_id}\x1f{ord_}".encode()).hexdigest()


def _split(text: str) -> list[str]:
    if len(text) <= _MAX_CHARS:
        return [text]
    parts, current = [], ""
    for para in re.split(r"\n\s*\n", text):
        if current and len(current) + len(para) > _TARGET_CHARS:
            parts.append(current.strip())
            current = ""
        current += para + "\n\n"
    if current.strip():
        parts.append(current.strip())
    return [p[:_MAX_CHARS * 2] for p in parts]


def load(path: Optional[str] = None) -> Optional[dict]:
    target = Path(path or os.getenv(CORPUS_ENV) or DEFAULT_PATH)
    if not target.exists():
        logger.warning(
            "The docs corpus %s is missing, so the Help persona has no product docs to answer "
            "from. Build it with `npm run gen:ai-docs-corpus` (the AI service's image builds it).",
            target,
        )
        return None
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.error("The docs corpus %s cannot be read: %s", target, exc)
        return None


def chunks(corpus: Optional[dict], collection: str = "docs") -> list[Chunk]:
    out: list[Chunk] = []
    if not corpus:
        return out
    for entry in corpus.get("entries") or []:
        for section in entry.get("sections") or []:
            text = (section.get("text") or "").strip()
            if not text:
                continue
            source_id = f"{entry.get('area')}/{entry.get('slug')}#{section.get('anchor') or ''}"
            for i, part in enumerate(_split(text)):
                out.append(Chunk(
                    id=chunk_id(collection, source_id, i), source_id=source_id, ord=i,
                    title=str(entry.get("title") or entry.get("slug")),
                    heading=str(section.get("heading") or ""),
                    url=str(section.get("href") or entry.get("href") or ""),
                    text=part,
                    metadata={"area": entry.get("area"), "slug": entry.get("slug"),
                              "section": entry.get("section")},
                ))
    for faq in corpus.get("faqs") or []:
        source_id = f"faq/{faq.get('href')}"
        out.append(Chunk(
            id=chunk_id(collection, source_id, 0), source_id=source_id, ord=0,
            title="Frequently asked questions", heading=str(faq.get("question") or ""),
            url=str(faq.get("href") or ""), text=str(faq.get("answer") or ""),
            metadata={"area": faq.get("area"), "kind": "faq", "category": faq.get("category")},
        ))
    return out


def fill_brand(text: str, brand: str) -> str:
    return (text or "").replace("{brandShort}", brand).replace("{brand}", brand)
