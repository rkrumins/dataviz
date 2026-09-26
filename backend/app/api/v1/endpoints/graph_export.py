"""Graph data export for a data source without version control: a cold copy, streamed from its graph.

A version-controlled data source exports from its version store (``versioning.py``'s
``/exports/plan`` and ``/exports/stream``). A source without version control has only its live
graph, so this reads the graph provider a page at a time (import_export/live.py) into the same
formats. Either way the file streams as it is produced: nothing is stored, any pod serves it, and
memory stays flat at any size. The helpers both share live here.
"""
from __future__ import annotations

import contextlib
import logging
import re
from typing import AsyncIterator, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_graph_read_db_session
from backend.app.db.repositories import data_source_repo
from backend.app.providers.manager import provider_manager
from backend.app.services.context_engine import ContextEngine
from backend.app.services.versioning.import_export import live, stream
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()

_READ = "workspace:datasource:read"
_GATE_GRAPH_EXPORT = require_feature("graphExportEnabled")


def export_format(fmt: str) -> str:
    """The format, lower-cased, or 422 when there is no writer for it."""
    from backend.app.services.versioning.import_export.formats import get_adapter
    try:
        get_adapter(fmt)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return fmt.lower()


def excel_limit(fmt: str, counts: dict) -> Optional[str]:
    """Why an xlsx export can't hold these counts, or ``None``."""
    if fmt != "xlsx" or counts.get("nodes") is None:
        return None
    return stream.excel_overflow({"node": counts["nodes"], "edge": counts["edges"]})


async def take_turn() -> int:
    """This export's turn on the server, once one frees up; 429 when none does in time."""
    turn = await stream.slots.acquire(stream.SLOT_WAIT_S)
    if turn is None:
        raise HTTPException(status_code=429, headers={"Retry-After": "120"}, detail={
            "code": "EXPORTS_BUSY", "message": "Too many exports are running right now. Try again in a few minutes."})
    return turn


async def xlsx_columns(pages, fmt: str, props=()) -> Optional[stream.Columns]:
    """An xlsx export's columns, found before the first byte so that one an Excel sheet can't
    hold is refused (422) rather than cut off. ``None`` for the other formats: csv/tsv find theirs
    once the download has started, so a large one doesn't sit silent while they are counted."""
    if fmt != "xlsx":
        return None
    columns = await stream.columns_of(pages, props)
    reason = stream.excel_overflow(columns.counts)
    if reason:
        raise HTTPException(status_code=422, detail={"code": "EXCEL_ROW_LIMIT", "message": reason})
    return columns


def download_name(stem: str, fmt: str) -> str:
    """A safe download name: letters, digits and ``._-`` only (it goes in a header)."""
    safe = "".join(c if c.isalnum() or c in "._-" else "-" for c in stem).strip("-.") or "export"
    return f"{safe[:120]}.{fmt}"


class ExportStreamResponse(StreamingResponse):
    """A streamed export that gives its turn back however the response ends: finished, failed,
    or the client gone."""

    def __init__(self, content, *, turn: int, fmt: str, filename: str, headers: Optional[dict] = None) -> None:
        super().__init__(content, media_type=stream.MEDIA_TYPES[fmt], headers={
            "Content-Disposition": f'attachment; filename="{download_name(filename, fmt)}"',
            "Cache-Control": "no-store", **(headers or {})})
        self.turn = turn

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        except Exception:
            logger.exception("streamed export failed after it started")
            raise
        finally:
            stream.slots.release(self.turn)


# ── A stored export's download, which resumes ───────────────────────────────

_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def byte_range(header: Optional[str], size: int) -> Optional[Tuple[int, int]]:
    """The bytes a ``Range`` header asks for, ``(first, last)`` inclusive; ``None`` for the whole
    file: no header, or one this doesn't serve (several ranges, another unit, not valid), which HTTP
    lets a server answer with the whole file. :class:`ValueError` when no byte of it is in the file
    (a 416)."""
    match = _RANGE.fullmatch((header or "").strip())
    if not match or match.groups() == ("", ""):
        return None
    first, last = match.groups()
    if not first:                                       # the last N bytes
        if int(last) == 0 or size == 0:
            raise ValueError("no bytes in range")
        return max(0, size - int(last)), size - 1
    if last and int(last) < int(first):
        return None
    if int(first) >= size:
        raise ValueError("range starts past the end")
    return int(first), min(int(last), size - 1) if last else size - 1


async def _first_bytes(chunks: AsyncIterator[bytes], n: int) -> AsyncIterator[bytes]:
    """The first ``n`` bytes of ``chunks``, which are closed once those are read."""
    async with contextlib.aclosing(chunks):
        async for chunk in chunks:
            if n <= 0:
                break
            yield chunk[:n]
            n -= len(chunk)


def stored_download(store, key: str, *, size: int, etag: str, modified: Optional[str], filename: str,
                    media_type: str, range_header: Optional[str], if_range: Optional[str]) -> Response:
    """A stored file as a download that resumes: its size, validators and ``Accept-Ranges`` up
    front, then the part a ``Range`` asks for (206), or the whole file (200) when ``If-Range``
    names a version other than this one."""
    if if_range and if_range.strip() not in (etag, modified):
        range_header = None
    try:
        wanted = byte_range(range_header, size)
    except ValueError:
        return Response(status_code=416, headers={"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"})
    first, last = wanted or (0, size - 1)
    headers = {"Accept-Ranges": "bytes", "ETag": etag, "Content-Length": str(last - first + 1),
               "Content-Disposition": f'attachment; filename="{filename}"'}
    if modified:
        headers["Last-Modified"] = modified
    if wanted:
        headers["Content-Range"] = f"bytes {first}-{last}/{size}"
    return StreamingResponse(_first_bytes(store.open_stream(key, start=first), last - first + 1),
                             status_code=206 if wanted else 200, media_type=media_type, headers=headers)


async def _provider(ws_id: str, data_source_id: str, session: AsyncSession, user: User):
    """The data source's graph provider — 404 unless the source is live in this workspace (the
    same tenant binding as the graph routes' gate; the workspace permission alone says nothing
    about which workspace a source belongs to)."""
    row = await data_source_repo.get_data_source_orm(session, data_source_id)
    if row is None or row.workspace_id != ws_id:
        raise HTTPException(status_code=404, detail=f"Data source '{data_source_id}' not found")
    try:
        engine = await ContextEngine.for_workspace(
            ws_id, provider_manager, session, data_source_id=data_source_id, actor=user.id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return engine.provider


@router.get("/plan", dependencies=[Depends(_GATE_GRAPH_EXPORT)])
async def plan_live_export(
    ws_id: str,
    data_source_id: str = Query(..., alias="dataSourceId"),
    format: str = Query("ndjson"),
    user: User = Depends(requires(_READ, workspace="ws_id")),
    session: AsyncSession = Depends(get_graph_read_db_session, scope="function"),
):
    """What a live export would hold: node and edge counts from the graph's statistics (an
    estimate), whether it is empty, and whether the format can hold it."""
    fmt = export_format(format)
    counts = await live.counts(await _provider(ws_id, data_source_id, session, user))
    return {"format": fmt, **counts, "empty": counts["nodes"] + counts["edges"] == 0,
            "formatLimit": excel_limit(fmt, counts), "maxBytes": stream.MAX_BYTES}


@router.get("/stream", dependencies=[Depends(_GATE_GRAPH_EXPORT)])
async def stream_live_export(
    ws_id: str,
    data_source_id: str = Query(..., alias="dataSourceId"),
    format: str = Query("ndjson"),
    props: Optional[str] = Query(None, description="Comma-separated property names to add as empty columns to fill"),
    filename: Optional[str] = Query(None, description="The download's name, without its extension"),
    user: User = Depends(requires(_READ, workspace="ws_id")),
    # Closed before the body streams: a long download holds no database connection.
    session: AsyncSession = Depends(get_graph_read_db_session, scope="function"),
):
    """Download the data source's whole graph as it is read, in any format: a cold copy whose
    rows re-import by URN. Exports take turns (``GRAPH_EXPORT_CONCURRENCY`` per server): one
    waits for a turn, and gets 429 with ``Retry-After`` if none frees up in time."""
    fmt = export_format(format)
    extra = [p.strip() for p in (props or "").split(",") if p.strip()]
    provider = await _provider(ws_id, data_source_id, session, user)
    turn = await take_turn()
    try:
        columns = await xlsx_columns(live.record_pages(provider), fmt, extra)
    except BaseException:
        stream.slots.release(turn)
        raise
    return ExportStreamResponse(
        stream.write_export(lambda: live.record_pages(provider), fmt=fmt, columns=columns, props=extra),
        turn=turn, fmt=fmt, filename=filename or f"{data_source_id}-export")
