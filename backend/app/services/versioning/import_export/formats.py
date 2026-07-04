"""Pluggable format adapters — the key to a generic template (plan §Template).

Each adapter converts one file format <-> raw column-dict records, all feeding the ONE normalized
row model (see :mod:`rowmodel`). Adding a format is one adapter; the pipeline, staging, reconcile,
and diff never change. Everything streams: ``parse`` reassembles records split across byte-chunk
boundaries so an arbitrarily large file is never buffered whole.

v1 ships ndjson, json-lines' sibling csv/tsv here; xlsx and the zip bundle plug in as further
adapters (they need heavier libs, so they live in their own modules and register the same way).
CSV cells must not contain raw newlines — nested/complex property values belong in the single-line
``properties_json`` column.
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any, AsyncIterator, Dict, List, Protocol, Sequence


class FormatAdapter(Protocol):
    fmt: str

    def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]: ...

    def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str]
    ) -> AsyncIterator[bytes]: ...


async def _lines(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Yield complete decoded lines from a byte-chunk stream (reassembling across boundaries)."""
    buf = b""
    async for chunk in chunks:
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line.decode("utf-8")
    tail = buf.decode("utf-8").strip()
    if tail:
        yield tail


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
        async for rec in records:
            yield (json.dumps(rec) + "\n").encode("utf-8")


class DelimitedAdapter:
    """CSV / TSV — line-based, quote-aware via the stdlib csv module."""

    def __init__(self, fmt: str, delimiter: str) -> None:
        self.fmt = fmt
        self._delim = delimiter

    async def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]:
        header: List[str] | None = None
        async for line in _lines(chunks):
            if line == "":
                continue
            row = next(csv.reader([line], delimiter=self._delim))
            if header is None:
                header = row
                continue
            yield {header[i]: row[i] for i in range(min(len(header), len(row)))}

    async def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str]
    ) -> AsyncIterator[bytes]:
        cols = list(columns)
        yield self._row(cols)
        async for rec in records:
            yield self._row(["" if rec.get(c) is None else str(rec.get(c)) for c in cols])

    def _row(self, values: Sequence[str]) -> bytes:
        buf = io.StringIO()
        csv.writer(buf, delimiter=self._delim, lineterminator="\n").writerow(values)
        return buf.getvalue().encode("utf-8")


_ADAPTERS = {
    "ndjson": lambda: NdjsonAdapter(),
    "csv": lambda: DelimitedAdapter("csv", ","),
    "tsv": lambda: DelimitedAdapter("tsv", "\t"),
}


def get_adapter(fmt: str) -> FormatAdapter:
    """Resolve a format name to its adapter. Raises ``ValueError`` for an unknown format."""
    factory = _ADAPTERS.get((fmt or "").lower())
    if factory is None:
        raise ValueError(f"unsupported import/export format {fmt!r} (have {sorted(_ADAPTERS)})")
    return factory()
