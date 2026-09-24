"""Every match of a search, exported — exactly, to a file.

An export reads a search's matches the way its count does: unit by unit,
each unit's matches once (``engine._advance``). Each unit's rows are written,
in the order the graph holds them, to a part of the export in the object
store (``services/storage/object_store``), and the session commits the parts
it has written with the scan's progress. So a part is in the export exactly
when its unit is counted: a unit read again — its lease taken over, or split
under memory or time pressure — is written to a new part, never over one a
commit names, and only committed parts are served. The download is the
header, then the parts in the order they were committed.

There is no cap: an export holds every match. A request moves it on as far
as its wait allows, and the client follows it with the ``sessionId`` until
it is complete — the same request-driven session a count is, so an export
survives a restart of whichever process was writing it.

The object store's own sweep deletes each part ``OBJECT_STORE_TTL_HOURS``
after it was written, so an export is kept only until that sweep could
reach its first part (``_keep_until``), and served only while every part is
there: never a file that stops short.

Values are written as the graph returns them: a 64-bit integer as its
digits, a list or an object as its JSON. A property a node keeps in
``propertiesRaw`` is read from there, and a condition on one is answered as a
search answers it.
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import hashlib
import io
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_deep_search import _safe_property_name
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
from backend.app.providers.falkordb_search.plan import Context, Unit, make_plan, match_statement
from backend.app.providers.falkordb_search.session import (
    COMPLETE,
    FAILED,
    Session,
    SessionStore,
    store_for,
)
from backend.app.services.deep_search import (
    CompileError,
    SearchFailed,
    SearchRunContext,
    get_deep_search_settings,
)
from backend.common.models.search import SearchQuery, export_columns

#: Where exports are kept in the object store: one folder per day an export
#: began.
_ROOT = "search-exports"
#: Rows a walk unit reads per statement (a walk's subtree can be far larger
#: than a chunk); a range unit is one chunk already.
_WALK_PAGE = 50_000
#: Rows encoded and written at a time.
_ENCODE_BATCH = 5_000

_BASE_EXPR = {
    "urn": "n.urn",
    "displayName": "n.displayName",
    "entityType": "labels(n)[0]",
    "qualifiedName": "n.qualifiedName",
    "description": "n.description",
    "tags": "n.tags",
}


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------

def _projection(columns: Sequence[str]) -> str:
    return ", ".join(_BASE_EXPR.get(c) or f"n.{_safe_property_name(c)}" for c in columns)


def _record(row: Sequence[Any], columns: Sequence[str]) -> Dict[str, Any]:
    """One node's values by column — a property it keeps raw read from its
    ``propertiesRaw``, its tags as the list they are."""
    raw_text, values = row[1], row[2:]
    record = dict(zip(columns, values))
    raw: Optional[Dict[str, Any]] = None
    for col in columns:
        if col in _BASE_EXPR:
            continue
        if record.get(col) is None:
            if raw is None:
                raw = _parse_raw(raw_text)
            if col in raw:
                record[col] = raw[col]
    if "tags" in record and isinstance(record["tags"], str):
        try:
            record["tags"] = json.loads(record["tags"])
        except ValueError:
            pass        # not a JSON list: exported as the text it is
    return record


def _parse_raw(text: Any) -> Dict[str, Any]:
    if not isinstance(text, str) or text in ("", "{}"):
        return {}
    try:
        raw = json.loads(text)
    except ValueError:
        return {}
    return raw if isinstance(raw, dict) else {}


def _cell(value: Any) -> str:
    """A value as CSV text: exact digits for an integer, JSON for a list or
    an object, nothing for a missing one."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, str)):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def encode_rows(records: Sequence[Dict[str, Any]], fmt: str, columns: Sequence[str]) -> bytes:
    """Records as the lines of an export — no header."""
    if fmt == "ndjson":
        return "".join(json.dumps({c: r.get(c) for c in columns}, ensure_ascii=False) + "\n"
                       for r in records).encode("utf-8")
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    for r in records:
        writer.writerow([_cell(r.get(c)) for c in columns])
    return buf.getvalue().encode("utf-8")


def header(fmt: str, columns: Sequence[str]) -> bytes:
    if fmt != "csv":
        return b""
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\r\n").writerow(list(columns))
    return buf.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# What a session keeps: which parts are written
# ---------------------------------------------------------------------------

class Manifest:
    """The export's committed parts, in commit order, with its format and
    columns, the folder its parts are in and how many bytes they hold."""

    def __init__(self, fmt: str, columns: List[str], folder: str,
                 parts: Optional[List[List[Any]]] = None, size: int = 0) -> None:
        self.fmt, self.columns, self.folder = fmt, columns, folder
        self.parts: List[List[Any]] = parts or []          # [[key, rows], …]
        self.size = size

    @classmethod
    def from_json(cls, text: Optional[str]) -> Optional["Manifest"]:
        if not text:
            return None
        d = json.loads(text)
        return cls(d["format"], d["columns"], d["folder"], d.get("parts"), d.get("size", 0))

    def to_json(self) -> str:
        return json.dumps({"format": self.fmt, "columns": self.columns,
                           "folder": self.folder, "parts": self.parts, "size": self.size})


def _part_key(folder: str, unit: Unit) -> str:
    """A new part for one reading of a unit. Never the same twice: a writer
    whose lease was taken over may still be writing its reading of the unit
    when the new holder writes and commits its own."""
    digest = hashlib.sha1(json.dumps(unit.to_dict(), sort_keys=True).encode()).hexdigest()
    return f"{folder}/{digest[:24]}-{uuid.uuid4().hex[:12]}.part"


class _ExportWork:
    """What an export takes from each unit: its matches, written to the
    unit's part — committed with the session, so a part counts once."""

    def __init__(self, session: Session, ctx: Context, run, objects, manifest: Manifest) -> None:
        self.session, self.ctx, self.run, self.objects = session, ctx, run, objects
        self.manifest = manifest

    async def begin(self, store: SessionStore) -> None:
        # Read with the lease held: the parts of the latest commit.
        latest = Manifest.from_json(await store.load_accumulator(self.session.sid))
        if latest is not None:
            self.manifest = latest

    async def unit(self, unit: Unit, timeout_s: float) -> Tuple[int, str, int]:
        from backend.app.providers.falkordb_search.engine import unit_context

        ctx = await unit_context(unit, self.ctx, self.run, timeout_s)
        fmt, columns = self.manifest.fmt, self.manifest.columns
        written = 0

        async def chunks() -> AsyncIterator[bytes]:
            # Streamed as read: a walk's subtree is written a page at a time.
            nonlocal written
            batch: List[Dict[str, Any]] = []
            # Encoded in a worker thread: a wide batch is a lot of text, and
            # the pod's other requests share this event loop.
            async for row in _unit_rows(unit, ctx, self.session.clamps, columns,
                                        self.run, timeout_s):
                batch.append(_record(row, columns))
                if len(batch) >= _ENCODE_BATCH:
                    written += len(batch)
                    yield await asyncio.to_thread(encode_rows, batch, fmt, columns)
                    batch = []
            if batch:
                written += len(batch)
                yield await asyncio.to_thread(encode_rows, batch, fmt, columns)

        key = _part_key(self.manifest.folder, unit)
        stat = await self.objects.put_stream(key, chunks())
        return written, key, stat.size

    def fold(self, unit: Unit, result: Tuple[int, str, int]) -> None:
        rows, key, size = result
        self.session.count += rows
        self.manifest.parts.append([key, rows])
        self.manifest.size += size

    def commit(self) -> Dict[str, Any]:
        return {"accumulator": self.manifest.to_json()}


async def _unit_rows(unit: Unit, ctx: Context, clamps, columns: Sequence[str], run,
                     timeout_s: float) -> AsyncIterator[List[Any]]:
    """Every match of one unit: ``[id, propertiesRaw, *columns]``. A walk is
    read a page at a time, in ID order."""
    head, params = match_statement(unit, ctx, clamps)
    project = _projection(columns)
    if unit.kind != "walk":
        res = await run(f"{head} RETURN ID(n), n.propertiesRaw, {project}", params, timeout_s)
        for row in res.result_set or []:
            yield list(row)
        return
    after = -1
    while True:
        res = await run(f"{head} WITH n WHERE ID(n) > $_after WITH n ORDER BY ID(n) "
                        f"LIMIT $_page RETURN ID(n), n.propertiesRaw, {project}",
                        {**params, "_after": after, "_page": _WALK_PAGE}, timeout_s)
        rows = res.result_set or []
        for row in rows:
            yield list(row)
        if len(rows) < _WALK_PAGE:
            return
        after = rows[-1][0]


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

def _query_id(query: SearchQuery, scope_hash: str, fmt: str, columns: Sequence[str]) -> str:
    from backend.app.providers.falkordb_search.engine import query_identity
    return "export:" + hashlib.sha1(json.dumps(
        [query_identity(query, scope_hash, 0), fmt, list(columns)]).encode()).hexdigest()


async def execute_export_session(provider, query: SearchQuery, *, context: SearchRunContext,
                                 fmt: str, columns: Sequence[str], wait_ms: int,
                                 session_id: Optional[str] = None, objects=None
                                 ) -> Dict[str, Any]:
    """This request's share of an export of ``query``'s matches (its scope
    resolved by the caller), answered with how far it has got."""
    from backend.app.providers.falkordb_search.engine import (
        _GRACE_S,
        _advance,
        _compiler_for,
        _containment,
        _find,
        request_deadline,
        session_id as session_id_of,
        unit_budget,
        within_hops,
    )
    from backend.app.services.storage.object_store import get_object_store

    settings = get_deep_search_settings()
    # A unit reads, encodes and writes — a walk a page at a time: two
    # statements' budget.
    unit_s = unit_budget(settings, passes=2)
    deadline = request_deadline(time.monotonic(), wait_ms / 1000.0, unit_s)
    store = store_for(provider)
    objects = objects or get_object_store()
    admit = context.admit

    async def run(cypher: str, params: Dict[str, Any], timeout_s: float):
        async with (admit() if admit else contextlib.nullcontext()):
            return await provider._ro_query(cypher, params=params, timeout=timeout_s)

    cols = export_columns(list(columns))
    compiler, raw_labels = await _compiler_for(provider, run, context, settings)
    where = compiler.compile(query.predicate)
    if compiler.hoisted_path is not None:
        raise CompileError("A path search finds routes, not entities to export.")
    hops, hop_params = within_hops(compiler)
    ctx = Context(
        where=where, params={**compiler.params, **hop_params},
        sort=SortSpec((SortKey("n.urn"),)), containment=_containment(provider),
        max_depth=int(query.scope.max_depth or 12),
        visible=(list(query.scope.visible_urns or [])
                 if query.scope.scope_mode == "visible" else None),
        within_hops=hops, raw_leaves=tuple(compiler.raw_leaves or ()), raw_labels=raw_labels,
    )
    query_id = _query_id(query, context.scope_hash, fmt, cols)
    sid = session_id_of(query_id, context.data_version, None)
    session = await _find(store, session_id, query_id, None) or await store.load(sid)
    if session is not None and time.time() >= _keep_until(session):
        # Its first parts may be swept by now: export afresh.
        await store.delete(session.sid)
        session = None
    created = False
    manifest = None
    if session is None or session.status == FAILED:
        plan = await make_plan(
            provider, query, compiler,
            run=lambda c, p: run(c, p, max(1.0, settings.chunk_timeout_ms / 1000.0)),
            width=settings.chunk_width, walk_max=settings.walk_max,
            timeout_s=max(0.5, deadline + _GRACE_S - time.monotonic()),
        )
        session = Session.start(sid, query_id, context.data_version, None, 0, plan,
                                scope_hash=context.scope_hash)
        created = True
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        manifest = Manifest(fmt, cols, f"{_ROOT}/{day}/{sid}")
    else:
        manifest = (Manifest.from_json(await store.load_accumulator(session.sid))
                    or Manifest(fmt, cols, f"{_ROOT}/unknown/{session.sid}"))
    ttl_s = max(1, min(settings.export_ttl_seconds, int(_keep_until(session) - time.time())))
    work = _ExportWork(session, ctx, run, objects, manifest)
    session = await _advance(session, created, store, work, deadline, settings,
                             ttl_s=ttl_s, unit_s=unit_s)
    if created and session.status == COMPLETE and not work.manifest.parts:
        # Nothing to scan (an empty scope): the manifest is all there is.
        await store.save(session, None, ttl_s, accumulator=work.manifest.to_json())
    if session.status == FAILED:
        raise SearchFailed(f"export failed: {session.error}")
    # The platform's export limit, held as the parts are written: they sit in
    # the store before any download, where a limit on the download can't help.
    from backend.app.services.versioning.import_export.stream import MAX_BYTES
    if work.manifest.size > MAX_BYTES:
        await store.delete(session.sid)
        await objects.delete_prefix(work.manifest.folder)
        raise CompileError(f"This export passed {MAX_BYTES:,} bytes — narrow the search or "
                           "pick fewer columns.")
    return _answer(session, work.manifest)


def _answer(session: Session, manifest: Manifest) -> Dict[str, Any]:
    return {
        "sessionId": session.sid,
        "status": "complete" if session.status == COMPLETE else "running",
        "rows": session.count,
        "progress": {"scanned": session.scanned,
                     "total": max(session.total, session.scanned),
                     "matched": session.count},
        "format": manifest.fmt,
        "columns": manifest.columns,
        "dataVersion": session.data_version,
        "filename": f"search-export-{time.strftime('%Y%m%d', time.gmtime(session.created))}"
                    f".{manifest.fmt}",
    }


async def open_export(provider, session_id: str, *, scope_hash: str, objects=None
                      ) -> Optional[Tuple[Dict[str, Any], AsyncIterator[bytes]]]:
    """A complete export of this scope — its answer, and its bytes to
    stream — or None when there is no such export (never begun, expired, or
    begun in another scope)."""
    from backend.app.services.storage.object_store import get_object_store

    store = store_for(provider)
    session = await store.load(session_id)
    if (session is None or session.status != COMPLETE or session.scope_hash != scope_hash
            or not session.query_id.startswith("export:")
            or time.time() >= _keep_until(session)):
        return None
    manifest = Manifest.from_json(await store.load_accumulator(session.sid))
    if manifest is None:
        return None
    objects = objects or get_object_store()
    # Served whole or not at all: a part gone (swept, or written to a store
    # this pod doesn't share) is no export, never a file that stops short.
    for key, rows in manifest.parts:
        if rows and not (await objects.stat(key)).exists:
            return None

    async def body() -> AsyncIterator[bytes]:
        yield header(manifest.fmt, manifest.columns)
        for key, rows in manifest.parts:
            if rows:
                async for chunk in objects.open_stream(key):
                    yield chunk

    return _answer(session, manifest), body()


def _keep_until(session: Session) -> float:
    """When an export stops being served: before the object store's sweep
    (``OBJECT_STORE_TTL_HOURS`` after a part was written) can reach its first
    part — every part is written after the export began — with a quarter of
    that left for a download already under way."""
    from backend.app.services.versioning import config
    return session.created + 0.75 * config.OBJECT_STORE_TTL_HOURS * 3600
