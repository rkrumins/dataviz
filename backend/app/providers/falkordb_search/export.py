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

A Connections search exports its edges (``_EdgeExportWork``): the units its
search reads (``edges``), each edge once, with its two ends and their
parents, read a page at a time — never more rows to a reply than FalkorDB
sends (``RESULTSET_SIZE``, 10,000 on the stock image).
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import dataclasses
import hashlib
import io
import json
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_deep_search import _edge_properties, _safe_property_name
from backend.app.providers.falkordb_search.edges import EdgeContext, _plan, edge_context, edge_match
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
from backend.app.providers.falkordb_search.plan import (
    REPLY_ROWS_MAX,
    Context,
    Unit,
    _rel,
    make_plan,
    match_statement,
)
from backend.app.providers.falkordb_search.relevance import display_name_expr
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
#: Rows a unit reads per statement, in node ID order: never more than a
#: reply holds (FalkorDB cuts it there silently). A walk's subtree can be far
#: larger than a page, and so can a range whose nodes outnumber its guess.
_PAGE = REPLY_ROWS_MAX
#: Rows encoded and written at a time.
_ENCODE_BATCH = 5_000
#: Edges a Connections export's unit reads per statement: a reply holds no
#: more rows than FalkorDB sends.
_EDGE_PAGE = 10_000

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
                 parts: Optional[List[List[Any]]] = None, size: int = 0,
                 state: Optional[Dict[str, Any]] = None) -> None:
        self.fmt, self.columns, self.folder = fmt, columns, folder
        self.parts: List[List[Any]] = parts or []          # [[key, rows], …]
        self.size = size
        # A Connections export's plan: which end anchors, what the far end's
        # scope check reads (``edges._plan``).
        self.state = state

    @classmethod
    def from_json(cls, text: Optional[str]) -> Optional["Manifest"]:
        if not text:
            return None
        d = json.loads(text)
        return cls(d["format"], d["columns"], d["folder"], d.get("parts"), d.get("size", 0),
                   d.get("state"))

    def to_json(self) -> str:
        return json.dumps({"format": self.fmt, "columns": self.columns,
                           "folder": self.folder, "parts": self.parts, "size": self.size,
                           **({"state": self.state} if self.state is not None else {})})


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
        records = await self.records(unit, timeout_s)
        fmt, columns = self.manifest.fmt, self.manifest.columns
        written = 0

        async def chunks() -> AsyncIterator[bytes]:
            # Streamed as read: a walk's subtree is written a page at a time.
            nonlocal written
            batch: List[Dict[str, Any]] = []
            # Encoded in a worker thread: a wide batch is a lot of text, and
            # the pod's other requests share this event loop.
            async for record in records:
                batch.append(record)
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

    async def records(self, unit: Unit, timeout_s: float) -> AsyncIterator[Dict[str, Any]]:
        """This unit's matches as records — the values its nodes keep raw
        answered first (``engine.unit_context``)."""
        from backend.app.providers.falkordb_search.engine import unit_context

        ctx = dataclasses.replace(self.ctx, clamp_depths=tuple(self.session.clamp_depths))
        ctx = await unit_context(unit, ctx, self.run, timeout_s)
        columns = self.manifest.columns

        async def read() -> AsyncIterator[Dict[str, Any]]:
            async for row in _unit_rows(unit, ctx, self.session.clamps, columns,
                                        self.run, timeout_s):
                yield _record(row, columns)

        return read()

    def fold(self, unit: Unit, result: Tuple[int, str, int]) -> None:
        rows, key, size = result
        self.session.count += rows
        self.manifest.parts.append([key, rows])
        self.manifest.size += size

    def commit(self) -> Dict[str, Any]:
        return {"accumulator": self.manifest.to_json()}


class _EdgeExportWork(_ExportWork):
    """What a Connections export takes from each unit: its edges, each
    with its ends and their parents, written to the unit's part."""

    def __init__(self, session: Session, ectx: EdgeContext, run, objects, manifest: Manifest,
                 containment: Sequence[str]) -> None:
        super().__init__(session, ectx.anchor, run, objects, manifest)
        self.ectx, self.containment = ectx, containment

    async def records(self, unit: Unit, timeout_s: float) -> AsyncIterator[Dict[str, Any]]:
        anchor = dataclasses.replace(self.ectx.anchor,
                                     clamp_depths=tuple(self.session.clamp_depths))
        ectx = dataclasses.replace(self.ectx, anchor=anchor)
        columns = self.manifest.columns

        async def read() -> AsyncIterator[Dict[str, Any]]:
            async for row in _edge_rows(unit, ectx, self.session.clamps, self.containment,
                                        self.run, timeout_s):
                yield _edge_record(row, columns)

        return read()


async def _edge_rows(unit: Unit, ectx: EdgeContext, clamps, containment: Sequence[str], run,
                     timeout_s: float) -> AsyncIterator[List[Any]]:
    """Every edge of one unit, a page at a time in (anchor, edge) ID order:
    ``[edge ID, type, its properties, *source, *target]``, each end its urn,
    name, label and ``[urn, name]`` of its parent."""
    match, params, src, tgt = edge_match(unit, ectx, clamps)
    rel = _rel(containment)

    def end(v: str, k: str) -> str:
        # A head over a comprehension, never OPTIONAL MATCH, which would
        # widen a row per parent; each comprehension its own name (S0 §15).
        parent = (f"head([({v})<-[:{rel}]-(_xp{k}) | "
                  f"[_xp{k}.urn, {display_name_expr(ectx.name_key, f'_xp{k}')}]])"
                  if rel else "null")
        return f"{v}.urn, {display_name_expr(ectx.name_key, v)}, labels({v})[0], {parent}"

    after_n, after_e = -1, -1
    while True:
        res = await run(
            f"{match} WITH n, e, m WHERE ID(n) > $_an OR (ID(n) = $_an AND ID(e) > $_ae) "
            "WITH n, e, m ORDER BY ID(n), ID(e) LIMIT $_page "
            f"RETURN ID(n), ID(e), type(e), properties(e), {end(src, 'a')}, {end(tgt, 'b')}",
            {**params, "_an": after_n, "_ae": after_e, "_page": _EDGE_PAGE}, timeout_s)
        rows = res.result_set or []
        for row in rows:
            yield list(row[1:])
        if len(rows) < _EDGE_PAGE:
            return
        after_n, after_e = rows[-1][0], rows[-1][1]


def _edge_record(row: Sequence[Any], columns: Sequence[str]) -> Dict[str, Any]:
    """One edge's values by column — a chosen column, one of its own
    properties (``_edge_properties``: a user's from its JSON, beside the
    platform's own)."""
    eid, edge_type, native, su, sn, sl, sp, tu, tn, tl, tp = row
    props = _edge_properties(native)
    record: Dict[str, Any] = {
        "edgeKey": str(eid),
        "edgeId": (native or {}).get("id") or f"{su}|{edge_type}|{tu}",
        "edgeType": edge_type,
        "sourceUrn": su, "sourceName": sn, "sourceType": sl,
        "sourceParentUrn": sp[0] if sp else None, "sourceParentName": sp[1] if sp else None,
        "targetUrn": tu, "targetName": tn, "targetType": tl,
        "targetParentUrn": tp[0] if tp else None, "targetParentName": tp[1] if tp else None,
        "properties": props,
    }
    for col in columns:
        if col not in record:
            record[col] = props.get(col)
    return record


def _page_sized(units: Sequence[Unit]) -> List[Unit]:
    """Each range cut until it likely holds no more nodes than a page: read
    in one statement, rather than paged with every page reading the range
    again. Paging still catches a range whose nodes outnumber its guess."""
    out: List[Unit] = []
    pending = list(units)
    while pending:
        unit = pending.pop(0)
        halves = unit.split() if unit.kind == "range" and unit.size > _PAGE else None
        if halves:
            pending[0:0] = halves
        else:
            out.append(unit)
    return out


async def _unit_rows(unit: Unit, ctx: Context, clamps, columns: Sequence[str], run,
                     timeout_s: float) -> AsyncIterator[List[Any]]:
    """Every match of one unit: ``[id, propertiesRaw, *columns]``, read a
    page at a time, in ID order."""
    head, params = match_statement(unit, ctx, clamps)
    project = _projection(columns)
    after = -1
    while True:
        res = await run(f"{head} WITH n WHERE ID(n) > $_after WITH n ORDER BY ID(n) "
                        f"LIMIT $_page RETURN ID(n), n.propertiesRaw, {project}",
                        {**params, "_after": after, "_page": _PAGE}, timeout_s)
        rows = res.result_set or []
        for row in rows:
            yield list(row)
        if len(rows) < _PAGE:
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

    edges = query.predicate.kind == "edges"
    cols = export_columns(list(columns), edges=edges)
    if not edges:
        compiler, raw_labels = await _compiler_for(provider, run, context, settings)
        where = compiler.compile(query.predicate, scope_depth=query.scope.max_depth)
        if compiler.hoisted_path is not None:
            raise CompileError("A path search finds routes, not entities to export.")
        hops, hop_params, hop_parts = within_hops(compiler)
        ctx = Context(
            where=where, params={**compiler.params, **hop_params},
            sort=SortSpec((SortKey("n.urn"),)), containment=_containment(provider),
            max_depth=int(query.scope.max_depth or 12),
            visible=(list(query.scope.visible_urns or [])
                     if query.scope.scope_mode == "visible" else None),
            within_hops=hops, hop_parts=hop_parts, tail=tuple(compiler.tail),
            raw_leaves=tuple(compiler.raw_leaves or ()), raw_labels=raw_labels,
        )
    query_id = _query_id(query, context.scope_hash, fmt, cols)
    sid = session_id_of(query_id, context.data_version, None)
    session = await _find(store, session_id, query_id, None)
    if session is not None and session.status == FAILED:
        raise SearchFailed(f"export failed: {session.error}")
    session = session or await store.load(sid)
    if session is not None and time.time() >= _keep_until(session):
        # Its first parts may be swept by now: export afresh.
        await store.delete(session.sid)
        session = None
    created = False
    manifest = None
    if session is None or session.status == FAILED:
        state = None
        if edges:
            plan, state = await _plan(provider, query, run, settings, deadline + _GRACE_S)
        else:
            plan = await make_plan(
                provider, query, compiler,
                run=lambda c, p: run(c, p, max(1.0, settings.chunk_timeout_ms / 1000.0)),
                width=settings.chunk_width, walk_max=settings.walk_max,
                timeout_s=max(0.5, deadline + _GRACE_S - time.monotonic()),
            )
            plan.units = _page_sized(plan.units)
        session = Session.start(sid, query_id, context.data_version, None, 0, plan,
                                scope_hash=context.scope_hash)
        created = True
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        manifest = Manifest(fmt, cols, f"{_ROOT}/{day}/{sid}", state=state)
    else:
        manifest = (Manifest.from_json(await store.load_accumulator(session.sid))
                    or Manifest(fmt, cols, f"{_ROOT}/unknown/{session.sid}"))
    ttl_s = max(1, min(settings.export_ttl_seconds, int(_keep_until(session) - time.time())))
    if edges:
        work: _ExportWork = _EdgeExportWork(
            session, edge_context(provider, query, manifest.state or {}), run, objects,
            manifest, _containment(provider))
    else:
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
