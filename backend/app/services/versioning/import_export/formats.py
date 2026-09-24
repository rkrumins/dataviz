"""Pluggable format adapters — the key to a generic template (plan §Template).

Each adapter converts one file format <-> raw column-dict records, all feeding the ONE normalized
row model (see :mod:`rowmodel`). Adding a format is one adapter; the pipeline, staging, reconcile,
and diff never change. Everything streams: ``parse`` reassembles records split across byte-chunk
boundaries so an arbitrarily large file is never buffered whole.

v1 ships ndjson, json-lines' sibling csv/tsv here; xlsx and the zip bundle plug in as further
adapters (they need heavier libs, so they live in their own modules and register the same way).
A quoted CSV cell may span lines (a record is read until no quoted cell is left open);
nested/complex property values belong in the single-line ``properties_json`` column.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
from typing import Any, AsyncIterator, Dict, List, Protocol, Sequence

from .rowmodel import cell_text, parse_list_cells


class FormatAdapter(Protocol):
    fmt: str

    def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]: ...

    def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str]
    ) -> AsyncIterator[bytes]: ...


def decode_bytes(raw: bytes) -> str:
    """Robustly decode bytes to text — UNIVERSAL across OSes/apps. Real-world files aren't always
    clean UTF-8: Excel/Windows export CSVs as **Windows-1252/Latin-1** and add a **UTF-8 BOM** to
    "CSV UTF-8"; both used to crash the import with a cryptic ``'utf-8' codec can't decode byte``.
    Strip a leading BOM, try UTF-8, then fall back to cp1252 (a superset of Latin-1 that decodes
    every byte, so it never raises)."""
    if raw.startswith(b"\xef\xbb\xbf"):   # UTF-8 BOM (Excel "CSV UTF-8")
        raw = raw[3:]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")   # Excel/Windows files; never raises


def _decode_line(raw: bytes, *, first: bool) -> str:
    """Decode one line (BOM only meaningful on the first) and tolerate CRLF endings."""
    text = decode_bytes(raw) if first else _decode_no_bom(raw)
    return text.rstrip("\r")   # CRLF -> strip the trailing \r left after splitting on \n


def _decode_no_bom(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


async def _lines(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Yield complete decoded lines from a byte-chunk stream (reassembling across boundaries).
    Linear: each chunk is scanned once with ``find`` and only the unfinished line's pieces carry
    over (re-splitting the whole remaining buffer per line was quadratic)."""
    tail: List[bytes] = []
    seen = False
    async for chunk in chunks:
        start = 0
        end = chunk.find(b"\n")
        while end != -1:
            tail.append(chunk[start:end])
            yield _decode_line(b"".join(tail), first=not seen)
            tail = []
            seen = True
            start = end + 1
            end = chunk.find(b"\n", start)
        tail.append(chunk[start:])
    rest = b"".join(tail)
    if rest.strip():
        yield _decode_line(rest, first=not seen)


async def _csv_records(lines: AsyncIterator[str], delim: str) -> AsyncIterator[str]:
    """Group physical lines into logical CSV records: a quoted cell may contain newlines, so lines
    are joined while one is left open. Same rule as the csv reader: a quote opens a quoted cell
    only at the start of a cell (anywhere else it is literal, e.g. ``5" screen``), and inside one
    ``""`` is an escaped quote. A line with no quote costs one ``find``."""
    record: List[str] = []
    quoted = False
    async for line in lines:
        if line == "" and not record:
            continue
        record.append(line)
        i = line.find('"')
        while i != -1:
            if quoted:
                if line.startswith('"', i + 1):   # "" — an escaped quote; the cell goes on
                    i = line.find('"', i + 2)
                    continue
                quoted = False                    # the closing quote
            elif i == 0 or line[i - 1] == delim:
                quoted = True                     # a quote opening a cell
            i = line.find('"', i + 1)
        if not quoted:
            yield "\n".join(record)
            record = []
    if record:
        yield "\n".join(record)   # a quoted cell still open at EOF: the csv reader closes it


class NdjsonAdapter:
    fmt = "ndjson"

    async def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]:
        async for line in _lines(chunks):
            line = line.strip()
            if line:
                yield json.loads(line)

    async def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str] = ()
    ) -> AsyncIterator[bytes]:
        async for chunk in self.write_pages(pages_of(records)):
            yield chunk

    async def write_pages(
        self, pages: AsyncIterator[List[Dict[str, Any]]], *, columns: Sequence[str] = ()
    ) -> AsyncIterator[bytes]:
        async for page in pages:
            yield await asyncio.to_thread(_ndjson_lines, page)


class DelimitedAdapter:
    """CSV / TSV — line-based, quote-aware via the stdlib csv module."""

    def __init__(self, fmt: str, delimiter: str) -> None:
        self.fmt = fmt
        self._delim = delimiter

    async def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]:
        header: List[str] | None = None
        async for record in _csv_records(_lines(chunks), self._delim):
            row = next(csv.reader([record], delimiter=self._delim))
            if header is None:
                header = row
                continue
            yield parse_list_cells({header[i]: row[i] for i in range(min(len(header), len(row)))})

    async def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str]
    ) -> AsyncIterator[bytes]:
        async for chunk in self.write_pages(pages_of(records), columns=columns):
            yield chunk

    async def write_pages(
        self, pages: AsyncIterator[List[Dict[str, Any]]], *, columns: Sequence[str]
    ) -> AsyncIterator[bytes]:
        cols = list(columns)
        yield self._rows([cols])
        async for page in pages:
            yield await asyncio.to_thread(self._rows, [[cell_text(r.get(c)) for c in cols] for r in page])

    def _rows(self, rows: Sequence[Sequence[str]]) -> bytes:
        buf = io.StringIO()
        csv.writer(buf, delimiter=self._delim, lineterminator="\n").writerows(rows)
        return buf.getvalue().encode("utf-8")


class JsonAdapter:
    """A single JSON array of records: ``[{...}, ...]``. Written as it streams, one record per line;
    read whole, since an array isn't line-streamable (ndjson/csv are the formats for millions)."""

    fmt = "json"

    async def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]:
        buf = bytearray()   # amortized appends; `bytes +=` re-copied the whole buffer per chunk
        async for chunk in chunks:
            buf += chunk
        text = decode_bytes(buf).strip()
        if not text:
            return
        data = json.loads(text)
        if isinstance(data, dict):                       # {"records": [...]} or a single object
            data = data.get("records") or data.get("rows") or [data]
        for rec in data:
            if isinstance(rec, dict):
                yield rec

    async def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str] = ()
    ) -> AsyncIterator[bytes]:
        async for chunk in self.write_pages(pages_of(records)):
            yield chunk

    async def write_pages(
        self, pages: AsyncIterator[List[Dict[str, Any]]], *, columns: Sequence[str] = ()
    ) -> AsyncIterator[bytes]:
        """Valid JSON whatever the count: ``[]`` when there is nothing to write."""
        first = True
        yield b"["
        async for page in pages:
            if page:
                yield await asyncio.to_thread(_json_items, page, first)
                first = False
        yield b"]\n" if first else b"\n]\n"


#: Records per page when a writer is handed records one at a time.
_PAGE = 2000


async def pages_of(records: AsyncIterator[Dict[str, Any]], size: int = _PAGE) -> AsyncIterator[List[Dict[str, Any]]]:
    """Group a record stream into pages: writers encode a page at a time, off the event loop."""
    page: List[Dict[str, Any]] = []
    async for rec in records:
        page.append(rec)
        if len(page) >= size:
            yield page
            page = []
    if page:
        yield page


def _ndjson_lines(page: List[Dict[str, Any]]) -> bytes:
    return "".join(json.dumps(r) + "\n" for r in page).encode("utf-8")


def _json_items(page: List[Dict[str, Any]], first: bool) -> bytes:
    return (("\n" if first else ",\n") + ",\n".join(json.dumps(r) for r in page)).encode("utf-8")


def _xlsx_adapter():
    from .xlsx_adapter import XlsxAdapter   # lazy: needs openpyxl; a missing lib won't break others
    return XlsxAdapter()


_ADAPTERS = {
    "ndjson": lambda: NdjsonAdapter(),
    "json": lambda: JsonAdapter(),
    "csv": lambda: DelimitedAdapter("csv", ","),
    "tsv": lambda: DelimitedAdapter("tsv", "\t"),
    "xlsx": _xlsx_adapter,
}


def get_adapter(fmt: str) -> FormatAdapter:
    """Resolve a format name to its adapter. Raises ``ValueError`` for an unknown format."""
    factory = _ADAPTERS.get((fmt or "").lower())
    if factory is None:
        raise ValueError(f"unsupported import/export format {fmt!r} (have {sorted(_ADAPTERS)})")
    return factory()
