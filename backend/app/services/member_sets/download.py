"""A member set as a file: its members (or its edges) in the order they joined.

The file streams as it is read — ``PAGE`` rows to a short read of the set's rows,
each read in a session of its own, so a download of a million rows holds no
connection between pages and memory stays flat. What a set knows about each member
(its name, type, why it is in, its distances, its nearest seed) comes straight from
its rows. Where each sits — its parent and its path — is the graph's containment
chains, read ``LOOKUP`` members to a statement as the page goes out (two short
statements a thousand rows), and so are any other ``columns``: each statement under
its own admission and never held across a yield, so a client that reads slowly
holds no graph slot. Its flows (``part=edges``) carry both their ends the same way:
each end's name and type from the set's rows, where it sits from the graph.

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
from backend.common.models.graph import GraphNode, NodeQuery

#: What every member row carries, first and in this order: what it is, why it is in,
#: and where it sits — its parent, and every container from the top of the graph
#: down to it (by name and by URN).
BASE_COLUMNS = ("urn", "name", "type", "qualifiedName", "via", "hops", "hopsUp", "hopsDown", "nearestSeed",
                "parentUrn", "parentName", "parentType", "path", "pathUrns")
#: How a path is one CSV cell, as the trace dock's own file writes it: names read
#: ``A / B``, URNs (which may hold a ``/``) ``a; b``. NDJSON and JSON keep lists.
_JOINED = {"path": " / ", "pathUrns": "; ", "sourcePath": " / ", "sourcePathUrns": "; ",
           "targetPath": " / ", "targetPathUrns": "; "}
#: Container names kept for one download, so each is read once however many rows
#: sit in it; past it a name is read again rather than held.
_NAMES_MAX = 100_000
#: A flow, with both its ends and where each sits — the members' own columns, so a flow
#: reads without a join (``source, target, type`` first, as before).
_END = ("Name", "Type", "ParentUrn", "ParentName", "ParentType", "Path", "PathUrns")
EDGE_COLUMNS = ("source", "target", "type",
                *(f"source{c}" for c in _END), *(f"target{c}" for c in _END))
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
        writer.writerow([_cell(_JOINED[c].join(r[c]) if c in _JOINED and isinstance(r.get(c), list) else r.get(c))
                         for c in columns])
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
            "nearestSeed": row.nearest_seed,
            "parentUrn": None, "parentName": None, "parentType": None, "path": None, "pathUrns": None}


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
    """Where each member sits: its containment chain, ``LOOKUP`` at a time, and the
    names of containers not seen yet — each statement admitted on its own, the same
    chains the canvas nests members in. ``known`` carries names across a download's
    pages (filled from the members themselves first: a container is often one).

    A chain the graph could not say leaves the cells empty; an entity at the top of
    the graph has an empty path and no parent."""
    for r in records:
        if len(known) < _NAMES_MAX:
            known.setdefault(r["urn"], (r["name"] or r["urn"], r["type"] or ""))
    for i in range(0, len(records), LOOKUP):
        chunk = records[i:i + LOOKUP]
        try:
            async with (admit() if admit is not None else nullcontext()):
                chains = await engine.get_ancestor_chains([r["urn"] for r in chunk])
        except NotImplementedError:
            return
        unnamed = sorted({a for r in chunk for a in chains.get(r["urn"]) or [] if a not in known})
        for j in range(0, len(unnamed), LOOKUP):
            batch = unnamed[j:j + LOOKUP]
            async with (admit() if admit is not None else nullcontext()):
                nodes = await engine.get_nodes_query(NodeQuery(urns=batch, limit=len(batch), include_child_count=False))
            for n in nodes:
                if len(known) < _NAMES_MAX:
                    known[n.urn] = (n.display_name or n.urn, n.entity_type or "")
        for r in chunk:
            chain = chains.get(r["urn"])
            if chain is None:
                continue
            top_down = list(reversed(chain))
            r["pathUrns"] = top_down
            r["path"] = [known.get(a, (a, ""))[0] for a in top_down]
            if top_down:
                r["parentUrn"] = top_down[-1]
                r["parentName"], r["parentType"] = known.get(top_down[-1], (top_down[-1], ""))


async def _rows(sessions: Sessions, set_id: str, fmt: str, columns: Sequence[str], engine, admit,
                first: bool = True, known: Optional[Dict[str, Tuple[str, str]]] = None) -> AsyncIterator[bytes]:
    names = list(BASE_COLUMNS) + list(columns)
    known = {} if known is None else known
    after = -1
    while True:
        rows = await _page(sessions, MemberSetRowORM, set_id, after)
        if not rows:
            return
        after = rows[-1].seq
        records = [_member(r) for r in rows]
        if engine is not None:
            await _place(records, engine, admit, known)
        if columns:
            await _fill(records, columns, engine, admit)
        yield await asyncio.to_thread(_encode, records, fmt, names, first)
        first = False
        if len(rows) < PAGE:
            return


async def _ends(sessions: Sessions, set_id: str, urns: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    """The members ``urns`` name, as a flow's ends: name and type, ``LOOKUP`` at a time (a
    set keeps a flow only between two of its members)."""
    out: Dict[str, Dict[str, Any]] = {}
    for i in range(0, len(urns), LOOKUP):
        async with sessions() as session:
            for urn, name, kind in (await session.execute(
                    select(MemberSetRowORM.urn, MemberSetRowORM.name, MemberSetRowORM.type)
                    .where(MemberSetRowORM.set_id == set_id, MemberSetRowORM.urn.in_(urns[i:i + LOOKUP])))).all():
                out[urn] = {"urn": urn, "name": name, "type": kind}
    for urn in urns:
        out.setdefault(urn, {"urn": urn, "name": None, "type": None})
    for r in out.values():
        r.update(parentUrn=None, parentName=None, parentType=None, path=None, pathUrns=None)
    return out


async def _edges(sessions: Sessions, set_id: str, fmt: str, engine=None, admit=None,
                 known: Optional[Dict[str, Tuple[str, str]]] = None, first: bool = True) -> AsyncIterator[bytes]:
    """The set's flows, a page at a time, each with both its ends and where each sits —
    their chains read once per page for every end it holds (``_place``)."""
    known = {} if known is None else known
    after = -1
    while True:
        edges = await _page(sessions, MemberSetEdgeORM, set_id, after)
        if not edges:
            return
        after = edges[-1].seq
        ends = await _ends(sessions, set_id, sorted({u for e in edges for u in (e.source_urn, e.target_urn)}))
        if engine is not None:
            await _place(list(ends.values()), engine, admit, known)
        records = []
        for e in edges:
            record = {"source": e.source_urn, "target": e.target_urn, "type": e.edge_type}
            for side, urn in (("source", e.source_urn), ("target", e.target_urn)):
                end = ends[urn]
                record.update({f"{side}Name": end["name"], f"{side}Type": end["type"],
                               f"{side}ParentUrn": end["parentUrn"], f"{side}ParentName": end["parentName"],
                               f"{side}ParentType": end["parentType"], f"{side}Path": end["path"],
                               f"{side}PathUrns": end["pathUrns"]})
            records.append(record)
        yield await asyncio.to_thread(_encode, records, fmt, EDGE_COLUMNS, first)
        first = False
        if len(edges) < PAGE:
            return


def _header(columns: Sequence[str]) -> bytes:
    return _csv([dict(zip(columns, columns))], columns)


async def stream(sessions: Sessions, set_id: str, *, fmt: str, part: str = "nodes",
                 columns: Sequence[str] = (), engine=None, admit=None,
                 meta: Optional[Dict[str, Any]] = None) -> AsyncIterator[bytes]:
    """The set's file. ``part`` ``edges`` is its lineage alone (csv or ndjson);
    ``json`` is one document holding both."""
    columns = [c for c in dict.fromkeys(columns) if c not in BASE_COLUMNS]
    if part == "edges":
        if fmt == "csv":
            yield _header(EDGE_COLUMNS)
        async for chunk in _edges(sessions, set_id, fmt, engine, admit):
            yield chunk
        return
    if fmt == "csv":
        yield _header(list(BASE_COLUMNS) + columns)
    if fmt == "json":
        yield ('{"meta":' + json.dumps(meta or {}, ensure_ascii=False) + ',"nodes":[').encode("utf-8")
    # One document reads each container's name once, for its nodes and its flows alike.
    known: Dict[str, Tuple[str, str]] = {}
    async for chunk in _rows(sessions, set_id, fmt, columns, engine, admit, known=known):
        yield chunk
    if fmt == "json":
        yield b'],"edges":['
        async for chunk in _edges(sessions, set_id, fmt, engine, admit, known=known):
            yield chunk
        yield b"]}"
