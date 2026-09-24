"""Snapshot reader — a versioned graph's state, read in pages, pinned to one commit.

What an export streams from. ``materialize_state`` builds a branch's whole state in memory, which
is fine for a canvas but not for a multi-GB export (every node and edge several times over, on a
1–2 GiB pod). This reads the same state a page at a time and holds only that page.

The state is a stack of LAYERS, bottom to top, each a set of version rows:

* a graph's ``main`` at a commit (a copy-on-write fork's ``main`` sits on its parent's ``main`` at
  the fork point, recursively) — :class:`VersionLayer`;
* a draft at a commit (an as-of export of a draft) — :class:`VersionLayer` on the draft branch;
* a draft's current staged state — :class:`HeadsLayer` over its ``entity_heads``.

An entity's state is the one in the TOPMOST layer that has a row for it (a delete there hides it),
exactly as ``_composed_state``/``_state_as_of`` compose it. Streaming a layer, each page drops the
entities a higher layer decides, found with one indexed point lookup per higher layer, so every
live entity comes out once, from its deciding layer, with no global sort or in-memory map.

Pages are keyset-paged on ``entity_id`` in the database's own collation (the cursor compares in the
same one), each in a short session: a commit landing mid-export can't shift a page, and pinning
``main`` to a commit seq makes the whole export one consistent snapshot.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import AsyncIterator, Dict, Iterable, List, Optional, Sequence, Set, Union

from sqlalchemy import Text, cast, func, select

from .. import db
from ..models import BranchORM, EdgeVersionORM, EntityHeadORM, GraphORM, NodeVersionORM

#: Rows per page. Big enough that per-page overhead is noise, small enough to hold comfortably.
PAGE_SIZE = int(os.getenv("GRAPH_EXPORT_PAGE_SIZE", "2000"))
#: Ids per point lookup (an IN list).
_LOOKUP_CHUNK = 5000


@dataclass(frozen=True)
class Winner:
    """An entity's deciding row in one layer: its version (or that it was deleted there)."""

    entity_id: str
    live: bool
    version_id: Optional[str] = None
    graph_id: Optional[str] = None        # the graph whose rows hold the version (a fork's base)
    content_hash: Optional[str] = None
    urn: Optional[str] = None             # node
    qualified_name: Optional[str] = None  # node
    entity_type: Optional[str] = None     # node
    source_id: Optional[str] = None       # edge
    target_id: Optional[str] = None       # edge
    edge_type: Optional[str] = None       # edge
    #: The version's payload as JSON text, when the read asked for it (an export's pages do). Text,
    #: so the event loop only moves bytes and the caller parses it off the loop.
    payload: Optional[str] = field(default=None, compare=False)


def _model(kind: str):
    return NodeVersionORM if kind == "node" else EdgeVersionORM


def _columns(model, kind: str, payload: bool = False):
    base = [model.entity_id, model.id, model.op, model.content_hash]
    if kind == "node":
        base += [model.urn, model.qualified_name, model.entity_type]
    else:
        base += [model.source_entity_id, model.target_entity_id, model.edge_type]
    return base + [cast(model.payload, Text)] if payload else base


def _winner(kind: str, graph_id: str, row) -> Winner:
    live = row[2] != "delete"
    payload = row[7] if len(row) > 7 else None
    if kind == "node":
        return Winner(row[0], live, row[1], graph_id, row[3],
                      urn=row[4], qualified_name=row[5], entity_type=row[6], payload=payload)
    return Winner(row[0], live, row[1], graph_id, row[3],
                  source_id=row[4], target_id=row[5], edge_type=row[6], payload=payload)


def _chunks(items: Sequence[str], n: int) -> Iterable[Sequence[str]]:
    for i in range(0, len(items), n):
        yield items[i:i + n]


@dataclass(frozen=True)
class VersionLayer:
    """A branch's version rows at ``commit_seq <= seq`` — the winner per entity is its newest."""

    graph_id: str
    branch_id: str
    seq: int

    def _winners(self, kind: str, payload: bool = False):
        model = _model(kind)
        return (select(*_columns(model, kind, payload))
                .where(model.graph_id == self.graph_id, model.branch_id == self.branch_id,
                       model.commit_seq <= self.seq)
                .order_by(model.entity_id, model.commit_seq.desc(), model.created_at.desc())
                .distinct(model.entity_id))

    async def page(self, kind: str, after: Optional[str], limit: int, payload: bool = False) -> List[Winner]:
        model = _model(kind)
        stmt = self._winners(kind, payload)
        if after is not None:
            stmt = stmt.where(model.entity_id > after)
        async with db.graphver_session() as s:
            rows = (await s.execute(stmt.limit(limit))).all()
        return [_winner(kind, self.graph_id, r) for r in rows]

    async def lookup(self, kind: str, entity_ids: Sequence[str]) -> Dict[str, Winner]:
        model = _model(kind)
        out: Dict[str, Winner] = {}
        for chunk in _chunks(list(entity_ids), _LOOKUP_CHUNK):
            async with db.graphver_session() as s:
                rows = (await s.execute(self._winners(kind).where(model.entity_id.in_(chunk)))).all()
            for r in rows:
                out[r[0]] = _winner(kind, self.graph_id, r)
        return out


@dataclass(frozen=True)
class HeadsLayer:
    """A draft's current state: its own ``entity_heads`` (staged and committed changes alike)."""

    graph_id: str
    branch_id: str

    def _heads(self, kind: str, payload: bool = False):
        model = _model(kind)
        return (select(EntityHeadORM.entity_id, EntityHeadORM.head_version_id, EntityHeadORM.is_tombstone,
                       EntityHeadORM.content_hash, *_columns(model, kind, payload)[4:])
                .select_from(EntityHeadORM)
                .outerjoin(model, (model.graph_id == EntityHeadORM.graph_id)
                           & (model.id == EntityHeadORM.head_version_id))
                .where(EntityHeadORM.graph_id == self.graph_id, EntityHeadORM.branch_id == self.branch_id,
                       EntityHeadORM.entity_kind == kind))

    def _winner(self, kind: str, row) -> Winner:
        eid, vid, tomb, chash = row[0], row[1], row[2], row[3]
        return _winner(kind, self.graph_id, (eid, vid, "delete" if tomb else "update", chash, *row[4:]))

    async def page(self, kind: str, after: Optional[str], limit: int, payload: bool = False) -> List[Winner]:
        stmt = self._heads(kind, payload).order_by(EntityHeadORM.entity_id)
        if after is not None:
            stmt = stmt.where(EntityHeadORM.entity_id > after)
        async with db.graphver_session() as s:
            rows = (await s.execute(stmt.limit(limit))).all()
        return [self._winner(kind, r) for r in rows]

    async def lookup(self, kind: str, entity_ids: Sequence[str]) -> Dict[str, Winner]:
        out: Dict[str, Winner] = {}
        for chunk in _chunks(list(entity_ids), _LOOKUP_CHUNK):
            async with db.graphver_session() as s:
                rows = (await s.execute(self._heads(kind).where(EntityHeadORM.entity_id.in_(chunk)))).all()
            for r in rows:
                out[r[0]] = self._winner(kind, r)
        return out


Layer = Union[VersionLayer, HeadsLayer]


class Snapshot:
    """One pinned view of a versioned graph's state, readable a page at a time."""

    def __init__(self, layers: List[Layer], *, graph_id: str, branch_id: str, main_branch_id: str,
                 as_of_seq: Optional[int], page_size: int = PAGE_SIZE) -> None:
        self.layers = layers
        self.graph_id = graph_id
        self.branch_id = branch_id
        self.main_branch_id = main_branch_id
        #: The commit ``main`` is pinned to (the seq an export reports and a re-read repeats).
        self.as_of_seq = as_of_seq
        self.page_size = page_size

    @property
    def is_draft(self) -> bool:
        return self.branch_id != self.main_branch_id

    async def iter_live(self, kind: str, payload: bool = False) -> AsyncIterator[List[Winner]]:
        """Every live entity of ``kind``, once each, a page at a time (order: by layer, then id),
        with each version's payload when ``payload``."""
        for i, layer in enumerate(self.layers):
            above = self.layers[i + 1:]
            after: Optional[str] = None
            while True:
                page = await layer.page(kind, after, self.page_size, payload)
                if not page:
                    break
                after = page[-1].entity_id
                decided: Set[str] = set()
                ids = [w.entity_id for w in page]
                for upper in above:
                    decided |= (await upper.lookup(kind, ids)).keys()
                live = [w for w in page if w.live and w.entity_id not in decided]
                if live:
                    yield live
                if len(page) < self.page_size:
                    break

    async def lookup_live(self, kind: str, entity_ids: Iterable[str]) -> Dict[str, Winner]:
        """The live entities among ``entity_ids`` (deciding layer first, top down)."""
        remaining = set(entity_ids)
        out: Dict[str, Winner] = {}
        for layer in reversed(self.layers):
            if not remaining:
                break
            found = await layer.lookup(kind, list(remaining))
            for eid, w in found.items():
                if w.live:
                    out[eid] = w
            remaining -= found.keys()
        return out

    async def nodes_by_urn(self, urns: Iterable[str]) -> Dict[str, str]:
        """``urn -> entity_id`` for the live nodes carrying these URNs."""
        wanted = [u for u in dict.fromkeys(urns) if u]
        candidates: Set[str] = set()
        for graph_id in {layer.graph_id for layer in self.layers}:
            for chunk in _chunks(wanted, _LOOKUP_CHUNK):
                async with db.graphver_session() as s:
                    rows = (await s.execute(
                        select(NodeVersionORM.entity_id).where(
                            NodeVersionORM.graph_id == graph_id, NodeVersionORM.urn.in_(chunk)).distinct())).all()
                candidates.update(r[0] for r in rows)
        live = await self.lookup_live("node", candidates)
        wanted_set = set(wanted)
        return {w.urn: eid for eid, w in live.items() if w.urn in wanted_set}

    async def containment_descendants(self, roots: Iterable[str], containment_types: Set[str]) -> Set[str]:
        """Every node reachable from ``roots`` down live containment edges (the roots excluded)."""
        found: Set[str] = set()
        seen: Set[str] = set(roots)
        frontier = list(seen)
        graphs = {layer.graph_id for layer in self.layers}
        while frontier:
            nxt: List[str] = []
            for chunk in _chunks(frontier, _LOOKUP_CHUNK):
                candidates: Set[str] = set()
                for graph_id in graphs:
                    async with db.graphver_session() as s:
                        rows = (await s.execute(
                            select(EdgeVersionORM.entity_id).where(
                                EdgeVersionORM.graph_id == graph_id,
                                EdgeVersionORM.source_entity_id.in_(chunk)).distinct())).all()
                    candidates.update(r[0] for r in rows)
                parents = set(chunk)
                for w in (await self.lookup_live("edge", candidates)).values():
                    if (str(w.edge_type or "").upper() in containment_types and w.source_id in parents
                            and w.target_id and w.target_id not in seen):
                        seen.add(w.target_id)
                        found.add(w.target_id)
                        nxt.append(w.target_id)
            frontier = nxt
        return found

    async def head_counts(self) -> Optional[Dict[str, int]]:
        """Live nodes and edges from ``main``'s head pointers, in one indexed count: only for a
        graph's own ``main`` at its current head (no fork parent, not a draft, not as of an earlier
        commit). ``None`` otherwise."""
        if self.is_draft or len(self.layers) != 1:
            return None
        async with db.graphver_session() as s:
            graph = await s.get(GraphORM, self.graph_id)
            if graph is None or graph.main_head_commit_seq != self.as_of_seq:
                return None
            rows = (await s.execute(
                select(EntityHeadORM.entity_kind, func.count()).where(
                    EntityHeadORM.graph_id == self.graph_id, EntityHeadORM.branch_id == self.main_branch_id,
                    EntityHeadORM.is_tombstone.is_(False)).group_by(EntityHeadORM.entity_kind))).all()
        return {"node": 0, "edge": 0, **{kind: n for kind, n in rows}}


async def _main_layers(s, graph_id: str, seq: int) -> List[Layer]:
    """A graph's ``main`` at ``seq``: its fork parent's ``main`` at the fork point first (recursively)."""
    graph = await s.get(GraphORM, graph_id)
    main_id = (await s.execute(select(BranchORM.id).where(
        BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalar_one()
    layers: List[Layer] = []
    if graph is not None and graph.fork_parent_graph_id:
        layers += await _main_layers(s, graph.fork_parent_graph_id, graph.fork_base_commit_seq or 0)
    layers.append(VersionLayer(graph_id, main_id, seq))
    return layers


async def open_snapshot(*, graph_id: str, branch_id: Optional[str] = None, as_of_seq: Optional[int] = None,
                        page_size: int = PAGE_SIZE) -> Snapshot:
    """The layers for ``graph_id`` on ``branch_id`` (default: published ``main``) at ``as_of_seq``
    (default: now — ``main`` pinned to its current head, so a long export is one snapshot)."""
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, graph_id)
        if graph is None:
            raise LookupError(f"unknown graph {graph_id}")
        main_id = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalar_one()
        branch_id = branch_id or main_id
        if branch_id == main_id:
            seq = graph.main_head_commit_seq if as_of_seq is None else as_of_seq
            return Snapshot(await _main_layers(s, graph_id, seq), graph_id=graph_id, branch_id=branch_id,
                            main_branch_id=main_id, as_of_seq=seq, page_size=page_size)
        branch = await s.get(BranchORM, branch_id)
        if branch is None or branch.graph_id != graph_id:
            raise LookupError(f"unknown branch {branch_id}")
        base_seq = branch.base_commit_seq or 0
        if as_of_seq is None:
            # A draft as it stands now: main where it branched, then its own (staged) changes.
            layers = await _main_layers(s, graph_id, base_seq) + [HeadsLayer(graph_id, branch_id)]
        else:
            layers = (await _main_layers(s, graph_id, min(as_of_seq, base_seq))
                      + [VersionLayer(graph_id, branch_id, as_of_seq)])
        return Snapshot(layers, graph_id=graph_id, branch_id=branch_id, main_branch_id=main_id,
                        as_of_seq=as_of_seq, page_size=page_size)
