"""A member set as a file: its members (or its edges) in the order they joined.

The file streams as it is read — ``PAGE`` rows to a short read of the set's rows,
each read in a session of its own, so a download of a million rows holds no
connection between pages and memory stays flat. What a set knows about each member
(its name, type, why it is in, its distances, its nearest seed) comes straight from
its rows. Where each sits — its parent and its path, unless the download is asked
without them — is the graph's containment chains, read ``LOOKUP`` members to a
statement as the page goes out (two short statements a thousand rows), and so are
any other ``columns``: each statement under its own admission and never held across
a yield, so a client that reads slowly holds no graph slot.

Formats: ``csv`` (a header, then every value as text: exact digits for an integer,
a path as the trace dock's file writes one (``A / B``; its URNs ``a; b``), JSON for
any other list or an object, nothing for a missing one — and never a formula: a
text value a spreadsheet would run starts with ``'``), ``ndjson`` (an object a
line), ``json`` (one document, ``{"meta": …, "nodes": [...], "edges": [...]}``).
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
from contextlib import nullcontext
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select

from backend.app.db.models import MemberSetEdgeORM, MemberSetRowORM
from backend.common import ancestry_columns as ancestry
from backend.common.models.graph import GraphNode, NodeQuery

#: What every member row carries, first and in this order: what it is and why it is in.
MEMBER_COLUMNS = ("urn", "name", "type", "qualifiedName", "via", "hops", "hopsUp", "hopsDown", "nearestSeed")
#: Then, unless the download is asked without them, where it sits — its parent, and every
#: container from the top of the graph down to it (by name and by URN:
#: ``common.ancestry_columns``).
BASE_COLUMNS = (*MEMBER_COLUMNS, *ancestry.ANCESTRY_COLUMNS)
EDGE_COLUMNS = ("source", "target", "type")
#: Rows per read of the set; members per node query for extra columns.
PAGE = 5_000
LOOKUP = 1_000
FORMATS = ("csv", "ndjson", "json")

_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")

Sessions = Callable[[], Any]   # () -> async context manager yielding an AsyncSession


def _cell(value: Any) -> str:
    """A value as CSV text — the search export's rules (exact digits for an integer,
    JSON for a list or an object, nothing for a missing one) — and text a
    spreadsheet would run as a formula defused with a leading ``'``."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return f"'{value}" if value.startswith(_FORMULA_START) else value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _csv(records: Sequence[Dict[str, Any]], columns: Sequence[str]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    for r in records:
        r = ancestry.joined(r)
        writer.writerow([_cell(r.get(c)) for c in columns])
    return buf.getvalue().encode("utf-8")


def _encode(records: Sequence[Dict[str, Any]], fmt: str, columns: Sequence[str], first: bool) -> bytes:
    if fmt == "csv":
        return _csv(records, columns)
    lines = [json.dumps({c: r.get(c) for c in columns}, ensure_ascii=False) for r in records]
    if fmt == "ndjson":
        return "".join(line + "\n" for line in lines).encode("utf-8")
    return (("" if first else ",") + ",".join(lines)).encode("utf-8") if lines else b""


def hops_of(row) -> Optional[int]:
    """A member's distance for the reason it is in: a source's upstream, a consumer's
    downstream, none for anything else."""
    return row.hops_up if row.via == "upstream" else row.hops_down if row.via == "downstream" else None


def _member(row) -> Dict[str, Any]:
    return {"urn": row.urn, "name": row.name, "type": row.type, "qualifiedName": row.qualified_name,
            "via": row.via, "hops": hops_of(row), "hopsUp": row.hops_up, "hopsDown": row.hops_down,
            "nearestSeed": row.nearest_seed, **ancestry.empty()}


def _value(node: GraphNode, column: str) -> Any:
    """A column of a node: one of its own fields by the name the API gives it, else
    one of its properties."""
    fields = node.model_dump(by_alias=True, exclude={"properties"})
    if column in fields:
        return fields[column]
    return (node.properties or {}).get(column)


async def _page(sessions: Sessions, model, set_id: str, after: int) -> List[Any]:
    async with sessions() as session:
        return list((await session.execute(
            select(model).where(model.set_id == set_id, model.seq > after)
            .order_by(model.seq).limit(PAGE)
        )).scalars().all())


async def _fill(records: List[Dict[str, Any]], columns: Sequence[str], engine, admit) -> None:
    """Read the extra ``columns`` for a page of members, ``LOOKUP`` at a time, each
    statement admitted on its own."""
    for i in range(0, len(records), LOOKUP):
        chunk = records[i:i + LOOKUP]
        urns = [r["urn"] for r in chunk]
        async with (admit() if admit is not None else nullcontext()):
            nodes = await engine.get_nodes_query(NodeQuery(urns=urns, limit=len(urns), include_child_count=False))
        by_urn = {n.urn: n for n in nodes}
        for r in chunk:
            node = by_urn.get(r["urn"])
            for c in columns:
                r[c] = _value(node, c) if node is not None else None


async def _place(records: List[Dict[str, Any]], engine, admit, known: Dict[str, Tuple[str, str]]) -> None:
    """Where each member sits: its containment chain and the names of containers not
    seen yet (``ancestry.place``), each statement admitted on its own, the same chains
    the canvas nests members in. ``known`` carries names across a download's pages
    (filled from the members themselves first: a container is often one).

    A chain the graph could not say leaves the cells empty; an entity at the top of
    the graph has an empty path and no parent."""
    for r in records:
        if len(known) < ancestry.NAMES_MAX:
            known.setdefault(r["urn"], (r["name"] or r["urn"], r["type"] or ""))

    async def chains(urns: List[str]) -> Dict[str, List[str]]:
        async with (admit() if admit is not None else nullcontext()):
            return await engine.get_ancestor_chains(urns)

    async def lookup(urns: List[str]) -> Dict[str, Tuple[str, str]]:
        async with (admit() if admit is not None else nullcontext()):
            nodes = await engine.get_nodes_query(NodeQuery(urns=urns, limit=len(urns), include_child_count=False))
        return {n.urn: (n.display_name or n.urn, n.entity_type or "") for n in nodes}

    await ancestry.place(records, chains, lookup, known)


async def _rows(sessions: Sessions, set_id: str, fmt: str, columns: Sequence[str], engine, admit,
                with_path: bool, first: bool = True) -> AsyncIterator[bytes]:
    names = list(BASE_COLUMNS if with_path else MEMBER_COLUMNS) + list(columns)
    known: Dict[str, Tuple[str, str]] = {}
    after = -1
    while True:
        rows = await _page(sessions, MemberSetRowORM, set_id, after)
        if not rows:
            return
        after = rows[-1].seq
        records = [_member(r) for r in rows]
        if engine is not None and with_path:
            await _place(records, engine, admit, known)
        if columns:
            await _fill(records, columns, engine, admit)
        yield await asyncio.to_thread(_encode, records, fmt, names, first)
        first = False
        if len(rows) < PAGE:
            return


async def _edges(sessions: Sessions, set_id: str, fmt: str, first: bool = True) -> AsyncIterator[bytes]:
    after = -1
    while True:
        edges = await _page(sessions, MemberSetEdgeORM, set_id, after)
        if not edges:
            return
        after = edges[-1].seq
        records = [{"source": e.source_urn, "target": e.target_urn, "type": e.edge_type} for e in edges]
        yield await asyncio.to_thread(_encode, records, fmt, EDGE_COLUMNS, first)
        first = False
        if len(edges) < PAGE:
            return


def _header(columns: Sequence[str]) -> bytes:
    return _csv([dict(zip(columns, columns))], columns)


async def stream(sessions: Sessions, set_id: str, *, fmt: str, part: str = "nodes",
                 columns: Sequence[str] = (), engine=None, admit=None,
                 meta: Optional[Dict[str, Any]] = None, with_path: bool = True) -> AsyncIterator[bytes]:
    """The set's file. ``part`` ``edges`` is its lineage alone (csv or ndjson);
    ``json`` is one document holding both. ``with_path``: each member says where it
    sits, as a set's file always has; without it, no chain is read."""
    columns = [c for c in dict.fromkeys(columns) if c not in BASE_COLUMNS]
    if part == "edges":
        if fmt == "csv":
            yield _header(EDGE_COLUMNS)
        async for chunk in _edges(sessions, set_id, fmt):
            yield chunk
        return
    if fmt == "csv":
        yield _header(list(BASE_COLUMNS if with_path else MEMBER_COLUMNS) + columns)
    if fmt == "json":
        yield ('{"meta":' + json.dumps(meta or {}, ensure_ascii=False) + ',"nodes":[').encode("utf-8")
    async for chunk in _rows(sessions, set_id, fmt, columns, engine, admit, with_path):
        yield chunk
    if fmt == "json":
        yield b'],"edges":['
        async for chunk in _edges(sessions, set_id, fmt):
            yield chunk
        yield b"]}"
