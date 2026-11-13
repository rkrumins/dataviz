"""Matching properties: an index of a property's values, for the imports that find their rows'
nodes by it (``identifier=prop.<name>``, doc 08 §3b) — what Dataverse calls an alternate key and
Salesforce an external id.

``entity_keys`` holds, for each property an import has matched by, the nodes of ``main`` that hold a
value of it; ``key_index`` how far it describes main (``seq``, a commit of main). The index is built
the first time an import names the property, from main's live nodes a page at a time, and caught up
from main's version log before each import that uses it after that. No write path changes: a node
created or edited on the canvas is found by the next import. A deleted node keeps its last value,
not live, so a row naming it again brings it back under its id. A graph has at most
``GRAPHVER_MAX_MATCHING_PROPERTIES``.

Building and catching up hold an advisory lock per graph and property, a page at a time, and read
the watermark under it: two imports at once never write an older value over a newer one, and each
page of the log is read once.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import Text, bindparam, func, select, text, update
from sqlalchemy.dialects.postgresql import ARRAY, insert as pg_insert

from .. import config, db
from ..models import BranchORM, EntityHeadORM, EntityKeyORM, GraphORM, KeyIndexORM, NodeVersionORM
from .resolve import key_value
from .snapshot import open_snapshot

logger = logging.getLogger(__name__)

#: Version rows (or nodes) one page of a build or a catch-up reads.
_PAGE = 5000
_IDS = bindparam("ids", type_=ARRAY(Text))
_VALUES = bindparam("vals", type_=ARRAY(Text))
#: A deleted node whose page doesn't say its last value: it keeps the one it has, not live.
_KEEP = object()


class MatchingPropertyLimit(Exception):
    """The graph already has ``GRAPHVER_MAX_MATCHING_PROPERTIES`` properties imports match by."""
    code, action = "too_many_matching_properties", "identifier"


class NotOnAFork(Exception):
    """A fork's main is its parent's and its own: matching by a property isn't kept there."""
    code, action = "matching_property_on_fork", "identifier"


class NotIndexed(Exception):
    """A dry run by a property no import has matched by yet: none builds its index."""
    code = "identifier_not_indexed"


async def _lock(s, graph_id: str, name: str) -> None:
    await s.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
                    {"k": f"gv-keys:{graph_id}:{name}"})


async def _main_id(s, graph_id: str) -> str:
    return (await s.execute(select(BranchORM.id).where(
        BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalar_one()


async def ensure(graph_id: str, name: str, *, job_id: Optional[str] = None) -> int:
    """The property's index, built when no import named it before, and caught up to main's head:
    the main commit it describes. :class:`MatchingPropertyLimit` past the graph's limit,
    :class:`NotOnAFork` on a fork."""
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            raise NotOnAFork(
                f"identifier=prop.{name} isn't available on a fork yet: a fork's main is its "
                "parent's and its own. Match its rows by entity_id or urn.")
        row = await s.get(KeyIndexORM, (graph_id, name))
        if row is None:
            others = await s.scalar(select(func.count()).select_from(KeyIndexORM).where(
                KeyIndexORM.graph_id == graph_id, KeyIndexORM.key_name != name))
            if others >= config.MAX_MATCHING_PROPERTIES:
                raise MatchingPropertyLimit(
                    f"this graph's imports already match by {others} properties, its most "
                    f"(GRAPHVER_MAX_MATCHING_PROPERTIES): match by one of them, by entity_id or "
                    f"by urn, or ask an administrator to raise the limit")
        ready = row is not None and row.status == "ready"
    if not ready:
        await _build(graph_id, name, job_id)
    return await _catch_up(graph_id, name)


async def ensure_ready(graph_id: str, name: str) -> int:
    """For a dry run, which builds nothing: the property's index caught up, once an import has built
    it; :class:`NotIndexed` when none has, :class:`NotOnAFork` on a fork."""
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, graph_id)
        if graph is not None and graph.fork_parent_graph_id:
            raise NotOnAFork(
                f"identifier=prop.{name} isn't available on a fork yet: match its rows by "
                "entity_id or urn.")
        row = await s.get(KeyIndexORM, (graph_id, name))
    if row is None or row.status != "ready":
        raise NotIndexed(
            f"no import has matched this graph's nodes by {name} yet, so a dry run can't: import a "
            f"file with identifier=prop.{name} to build its index (it reads every node once), then "
            "check files against it")
    return await _catch_up(graph_id, name)


async def listed(graph_id: str) -> List[Dict[str, Any]]:
    """The properties this graph's imports match by, in the order imports first named them: each
    one's index ``status`` (``building`` or ``ready``), the main commit it describes (``seq``), and
    whether that is main's head (``current``; the next import catches it up either way)."""
    async with db.graphver_session() as s:
        head = int(await s.scalar(select(GraphORM.main_head_commit_seq).where(
            GraphORM.id == graph_id)) or 0)
        rows = (await s.execute(select(KeyIndexORM).where(KeyIndexORM.graph_id == graph_id)
                                .order_by(KeyIndexORM.created_at, KeyIndexORM.key_name))).scalars().all()
    return [{"name": r.key_name, "status": r.status, "seq": int(r.seq),
             "current": r.status == "ready" and not r.cursor and int(r.seq) >= head,
             "createdAt": r.created_at} for r in rows]


def _values_of(page, name: str) -> List[Tuple[str, str]]:
    """``(entity id, value)`` of the nodes in ``page`` that hold one of the property."""
    out = []
    for w in page:
        props = (json.loads(w.payload) if w.payload else {}) or {}
        v = key_value((props.get("properties") or {}).get(name))
        if v is not None:
            out.append((w.entity_id, v))
    return out


async def _build(graph_id: str, name: str, job_id: Optional[str]) -> None:
    """Read every live node of main, as of its head now, into the index, then mark it ready. Each
    build records the commit it reads at before it writes, and the index keeps the earliest: two
    imports building it at once, or a build that died part-way and the one after it, leave rows of
    several commits, and the catch-up from the earliest applies the log again over all of them.
    Each page a build writes takes the index back to its commit, in the page's transaction under
    the lock, and so does its end: once another build's catch-up has moved the index past it (or
    part-way through a commit after it), the next catch-up applies the log again over those rows
    too, whole commits from there, whether or not this build ends (``_apply`` brings each node to
    its last version whatever its rows held)."""
    snap = await open_snapshot(graph_id=graph_id)                   # main, pinned at its head
    async with db.graphver_session() as s:
        stmt = pg_insert(KeyIndexORM).values(
            graph_id=graph_id, key_name=name, status="building", seq=snap.as_of_seq,
            created_by_job=job_id)
        await s.execute(stmt.on_conflict_do_update(
            index_elements=["graph_id", "key_name"],
            set_={"seq": func.least(KeyIndexORM.seq, stmt.excluded.seq)}))
    read = 0
    async for page in snap.iter_live("node", payload=True):
        held = await asyncio.to_thread(_values_of, page, name)
        read += len(page)
        if held:
            async with db.graphver_session() as s:
                await _lock(s, graph_id, name)
                row = await s.get(KeyIndexORM, (graph_id, name), populate_existing=True)
                row.seq, row.cursor = min(int(row.seq), snap.as_of_seq), None
                for i in range(0, len(held), 2000):
                    await s.execute(pg_insert(EntityKeyORM).values([
                        {"graph_id": graph_id, "key_name": name, "key_value": v, "entity_id": e,
                         "live": True} for e, v in held[i:i + 2000]]).on_conflict_do_nothing())
    async with db.graphver_session() as s:
        await _lock(s, graph_id, name)
        row = await s.get(KeyIndexORM, (graph_id, name), populate_existing=True)
        row.status, row.cursor = "ready", None                      # at the earliest build's seq
        row.seq = min(int(row.seq), snap.as_of_seq)
    logger.info("matching property %s of graph %s indexed: %d live nodes read, at main commit %s",
                name, graph_id, read, snap.as_of_seq)


async def _catch_up(graph_id: str, name: str) -> int:
    """Apply main's node versions after the index's commit, a page at a time, each page under the
    lock with the watermark read again there: the main commit it now describes. A page holds whole
    commits; a commit larger than a page is read a page at a time by entity id (``cursor``)."""
    while True:
        async with db.graphver_session() as s:
            await _lock(s, graph_id, name)
            row = await s.get(KeyIndexORM, (graph_id, name), populate_existing=True)
            main_id = await _main_id(s, graph_id)
            value = NodeVersionORM.payload["properties"][name]
            on_main = (NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id)
            if row.cursor:                                      # part-way through one commit
                at, _, after = row.cursor.partition("|")
                rows = (await s.execute(
                    select(NodeVersionORM.commit_seq, NodeVersionORM.entity_id, NodeVersionORM.op, value)
                    .where(*on_main, NodeVersionORM.commit_seq == int(at),
                           NodeVersionORM.entity_id > after)
                    .order_by(NodeVersionORM.entity_id, NodeVersionORM.created_at)
                    .limit(_PAGE))).all()
                await _apply(s, graph_id, name, rows)
                if len(rows) < _PAGE:
                    row.seq, row.cursor = int(at), None
                else:
                    row.cursor = f"{at}|{rows[-1][1]}"
                continue
            rows = (await s.execute(
                select(NodeVersionORM.commit_seq, NodeVersionORM.entity_id, NodeVersionORM.op, value)
                .where(*on_main, NodeVersionORM.commit_seq > row.seq)
                .order_by(NodeVersionORM.commit_seq, NodeVersionORM.entity_id,
                          NodeVersionORM.created_at)
                .limit(_PAGE))).all()
            if not rows:
                return row.seq
            last = rows[-1][0]
            if len(rows) < _PAGE:                               # every commit up to the last whole
                await _apply(s, graph_id, name, rows)
                row.seq = last
            elif rows[0][0] < last:                             # the last may be cut: next page
                whole = [r for r in rows if r[0] < last]
                await _apply(s, graph_id, name, whole)
                row.seq = whole[-1][0]
            else:                                               # one commit, larger than a page
                await _apply(s, graph_id, name, rows)
                row.cursor = f"{last}|{rows[-1][1]}"


async def _apply(s, graph_id: str, name: str, rows) -> None:
    """Bring the index's entries of the page's nodes to what their last version in it says, in
    ``s``: a live node holds its value (none when it has none); a deleted one keeps its last value,
    not live."""
    final: Dict[str, Tuple[bool, Any]] = {}
    for _seq, eid, op, raw in rows:
        if op == "delete":
            prev = final.get(eid)
            final[eid] = (True, prev[1] if prev is not None else _KEEP)
        else:
            final[eid] = (False, key_value(raw))
    replaced = [e for e, (_dead, v) in final.items() if v is not _KEEP]
    gone = [e for e, (dead, v) in final.items() if dead and v is _KEEP]
    mine = (EntityKeyORM.graph_id == graph_id, EntityKeyORM.key_name == name)
    if replaced:
        await s.execute(EntityKeyORM.__table__.delete().where(*mine, EntityKeyORM.entity_id == func.any(_IDS)),
                        {"ids": replaced})
        held = [{"graph_id": graph_id, "key_name": name, "key_value": v, "entity_id": e,
                 "live": not dead} for e, (dead, v) in final.items() if v is not _KEEP and v is not None]
        for i in range(0, len(held), 2000):
            await s.execute(pg_insert(EntityKeyORM).values(held[i:i + 2000]).on_conflict_do_nothing())
    if gone:
        await s.execute(update(EntityKeyORM).where(*mine, EntityKeyORM.entity_id == func.any(_IDS))
                        .values(live=False).execution_options(synchronize_session=False),
                        {"ids": gone})


async def lookup(graph_id: str, name: str, values: Iterable[str]) -> Dict[str, List[Tuple[str, bool]]]:
    """``{value: [(entity id, live)]}``: main's nodes holding each value, as the index says."""
    wanted = sorted({v for v in values if v})
    out: Dict[str, List[Tuple[str, bool]]] = {}
    if not wanted:
        return out
    stmt = (select(EntityKeyORM.key_value, EntityKeyORM.entity_id, EntityKeyORM.live)
            .where(EntityKeyORM.graph_id == graph_id, EntityKeyORM.key_name == name,
                   EntityKeyORM.key_value == func.any(_VALUES)))
    async with db.graphver_session() as s:
        for i in range(0, len(wanted), 2000):
            for v, e, live in (await s.execute(stmt, {"vals": wanted[i:i + 2000]})).all():
                out.setdefault(v, []).append((e, bool(live)))
    return out


async def holders_among(graph_id: str, name: str, entity_ids: Iterable[str]) -> Set[str]:
    """Those of ``entity_ids`` main's index has holding a value of ``name``, live: what a replace
    by that property with ``replaceScope=keyed`` may delete. By the entity index, a chunk at a time."""
    ids = sorted({e for e in entity_ids if e})
    out: Set[str] = set()
    stmt = (select(EntityKeyORM.entity_id)
            .where(EntityKeyORM.graph_id == graph_id, EntityKeyORM.key_name == name,
                   EntityKeyORM.live.is_(True), EntityKeyORM.entity_id == func.any(_IDS))
            .distinct())
    async with db.graphver_session() as s:
        for i in range(0, len(ids), 2000):
            out.update((await s.execute(stmt, {"ids": ids[i:i + 2000]})).scalars())
    return out


async def changed_on_main(graph_id: str, after: int) -> Tuple[List[str], int]:
    """``(ids, seq)``: the nodes main's commits after ``after`` changed, up to main's commit
    ``seq`` (``after`` when none did) — what main's index says of them a draft based at ``after``
    doesn't see. As many as main's changes since, by the version log's branch index."""
    async with db.graphver_session() as s:
        main_id = await _main_id(s, graph_id)
        rows = (await s.execute(
            select(NodeVersionORM.entity_id, func.max(NodeVersionORM.commit_seq))
            .where(NodeVersionORM.graph_id == graph_id, NodeVersionORM.branch_id == main_id,
                   NodeVersionORM.commit_seq > after)
            .group_by(NodeVersionORM.entity_id))).all()
    return [e for e, _seq in rows], max([after, *(int(seq) for _e, seq in rows)])


async def draft_values(graph_id: str, branch_id: str, name: str) -> Dict[str, Optional[str]]:
    """``{entity id: its value, or None}`` of every node the draft itself changed (its own heads):
    what main's index can't say of them. A deleted one has none. The heads first, then their version
    rows' value by id, a chunk at a time — never one join of the two (see
    ``GraphVersioningService._head_index``)."""
    out: Dict[str, Optional[str]] = {}
    after = ""
    while True:
        async with db.graphver_session() as s:
            heads = (await s.execute(
                select(EntityHeadORM.entity_id, EntityHeadORM.head_version_id, EntityHeadORM.is_tombstone)
                .where(EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
                       EntityHeadORM.entity_kind == "node", EntityHeadORM.entity_id > after)
                .order_by(EntityHeadORM.entity_id).limit(_PAGE))).all()
            versions = [vid for _e, vid, tomb in heads if not tomb and vid]
            values: Dict[str, Any] = {}
            if versions:
                values = dict((await s.execute(
                    select(NodeVersionORM.id, NodeVersionORM.payload["properties"][name])
                    .where(NodeVersionORM.graph_id == graph_id, NodeVersionORM.id == func.any(_IDS)),
                    {"ids": versions})).all())
        for eid, vid, tomb in heads:
            out[eid] = None if tomb else key_value(values.get(vid))
        if len(heads) < _PAGE:
            return out
        after = heads[-1][0]
