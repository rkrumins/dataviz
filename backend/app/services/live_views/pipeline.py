"""Resolve, place and apply: the one path that writes the members of a view made from a query.

Saving a view, *Refresh now*, opening a view whose data changed and a definition change all go
through here. A view holds up to ``LIVE_VIEW_MAX_MEMBERS`` members (``view_members``) — more
than one request can work out — so a run is a series of short steps, and whichever request
comes next carries it on at the same epoch (the frontend asks again while it hears
``running``). A request's turn (``TURN_SECS``) ends inside the tier that would cut it off; one
cut off all the same lets go of its lease at once. No database transaction is held across a
graph call:

1. **Claim** — read the view and its definition; claim it (``epoch + 1``, a lease), or take
   over the run already at that epoch once nobody holds its lease (``materialize`` says how
   far it got).
2. **Resolve** — each source is a member set (``services/member_sets``): the scope resolved
   completely, a step at a time, shared with everyone asking the same question. Moved on
   within the request's budget.
3. **Place** — once every set is complete, and holds no more members than a view can, a page
   of members at a time in the order they were found (the first source to name one wins): one
   read of the page and of where its members sat at the last answer, then where they sit in
   the graph and what placing reads of them (a statement each); the rows written at the run's
   epoch, each page fenced on the claim and renewing its lease.
4. **Apply** — a step of its own: the change from the last answer measured in SQL holding
   nothing, and kept with the run (a large removal held there to be confirmed); then the
   view's row and its state locked briefly — the definition still the one resolved — and
   ``members_epoch`` swapped to the new epoch in one commit. Readers see the old members until
   then; the sweeper deletes the old epoch's rows a while after.

A short answer (part of the graph not answering) is never applied — the view keeps its last
good members, and says so. Over the limit, likewise.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from collections import OrderedDict
from contextlib import AbstractAsyncContextManager, nullcontext
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from pydantic import BaseModel
from sqlalchemy import case, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import MemberSetORM, MemberSetRowORM, ViewMembershipStateORM, ViewORM, view_is_live
from backend.app.db.repositories import data_source_repo, view_members_repo, view_membership_repo
from backend.app.db.repositories.view_membership_repo import dumps, later_iso, now_iso
from backend.app.services.graph_cache import ENDPOINT_MEMBERS_DRAFT, CacheScope, get_graph_cache
from backend.app.services.graph_reads import (
    cache_scope,
    known_data_version,
    search_data_version,
    statement_admission,
)
from backend.app.services.layout_config import parse_reference_layout
from backend.app.services.live_views import layouts
from backend.app.services.live_views.plan import (
    Candidate,
    Placed,
    Placer,
    auto_placer,
    plan_page,
    prepared_placer,
    rules_placer,
    source_placer,
    stage_placer,
    top_type_counts,
)
from backend.app.services.member_sets import stepper
from backend.app.services.member_sets import store as sets
from backend.app.services.search_views import followed_base, in_followed_layers, is_subset
from backend.app.services.view_membership_search import make_seed_pages, seed_query_for
from backend.app.services.view_placement import NodeFacts, PlacementSpec, facts_from_graph_node, placement_digest
from backend.common.adapters import ProviderUnavailable
from backend.common.models.graph import NodeQuery
from backend.common.models.member_set import MemberSetProgress, MemberSetStatus
from backend.common.models.view_membership import (
    MACHINE,
    RETRYABLE,
    MembershipCounts,
    MembershipDefinition,
    MembershipPlan,
    MembershipSource,
    PlanLayer,
    read_definition,
)

logger = logging.getLogger(__name__)

#: Members one view made from a query may hold (people's own entries aside); past it the view
#: keeps its last good members, and says so.
LIVE_VIEW_MAX_MEMBERS: int = int(os.getenv("LIVE_VIEW_MAX_MEMBERS", "250000"))
#: A removal at least this large (share of the members, and count) waits to be confirmed.
MASS_REMOVAL_RATIO = 0.5
MASS_REMOVAL_MIN = 50
#: Lease on a view while one request works on it; every page renews it. A turn cut off lets
#: go of it at once: this is for a process that died.
LEASE_SECS = 300.0
#: One request's turn at a run, in seconds; the routes keep it inside the tier that would cut
#: the request off.
TURN_SECS: float = float(os.getenv("LIVE_VIEW_TURN_SECS", "20"))
#: A new view's first turn: short, so saving answers at once.
CREATE_TURN_SECS: float = float(os.getenv("LIVE_VIEW_CREATE_TURN_SECS", "5"))
#: What applying an answer needs of a turn: with less left once every page is placed, it is
#: the next turn's first step.
APPLY_RESERVE_S = 6.0
#: How long a turn cut off has to let go of its lease.
LET_GO_S = 3.0
#: Containers whose facts one turn keeps, so a page reads only those it has not met.
FACTS_KEPT = 20_000
#: A preview's draft is kept this long, for the save that follows it.
DRAFT_TTL_S = 15 * 60
#: How long a caller is asked to wait when the graph was too busy to answer.
RETRY_SECS = 30.0
#: Members placed per page: one transaction, and a statement each for their paths and facts.
PAGE = 1000
#: A preview of more members than this is placed from the first ``SAMPLE`` of them, and says so.
ESTIMATE_ABOVE = 20_000
SAMPLE = 5_000

#: An engine for one data source — ``(workspace_id, data_source_id, actor)`` — opened
#: around the graph phase and closed after it: the caller decides which pool and which
#: admission it goes through.
EngineScope = Callable[[str, Optional[str], Optional[str]], AbstractAsyncContextManager]


def entry_limit() -> int:
    """At most this many members in a view. Containers around them are not entries (the
    canvas draws them from each member's path), and people's own entries are not counted."""
    return LIVE_VIEW_MAX_MEMBERS


class PipelineError(Exception):
    """Why a view could not be worked out, in words. ``kind`` is the status it
    leaves (``source_missing``, ``frozen``) or how a route answers (``invalid``,
    ``not_found``)."""

    def __init__(self, kind: str, message: str, **detail: Any):
        super().__init__(message)
        self.kind = kind
        self.detail = detail


class _Overtaken(Exception):
    """The claim is no longer this run's: a newer run, or an edit, holds the view."""


def _sha(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:32]


def _slot(admit):
    return admit() if admit is not None else nullcontext()


# ── Member sets: each source resolved in full ────────────────────────────────

@dataclass
class Sets:
    """Each source's member set as this request last read it, and the data they are
    resolved on; a query source's search, a page a call (``pages``)."""
    sources: List[MembershipSource]
    rows: List[MemberSetORM] = field(default_factory=list)
    data_version: str = ""
    pages: List[Any] = field(default_factory=list)

    @property
    def ids(self) -> List[str]:
        return [ms.id for ms in self.rows]

    @property
    def complete(self) -> bool:
        return all(ms.status == "complete" for ms in self.rows)

    def truncated(self) -> List[dict]:
        seen: Dict[str, dict] = {}
        for ms in self.rows:
            for t in sets.loads(ms.truncated, []):
                prior = seen.get(t["reason"])
                if prior is None or t["seen"] > prior["seen"]:
                    seen[t["reason"]] = t
        return [seen[r] for r in sorted(seen)]

    @property
    def retryable(self) -> List[str]:
        """Limits that say the answer is short of the truth, not just bounded."""
        return sorted({t["reason"] for t in self.truncated() if t["reason"] in RETRYABLE})

    def missing_seeds(self) -> int:
        return sum(int(sets.loads(ms.state, {}).get("missing") or 0) for ms in self.rows)


async def open_sets(
    session: AsyncSession, engine: Any, sources: Sequence[MembershipSource], *, workspace_id: str,
    data_source_id: Optional[str], data_version: str, ids: Sequence[str] = (), can_read_view: Any = None,
    manager: Any = None, fresh: bool = False,
) -> Sets:
    """Each source's set on ``data_version``: the one ``ids`` names while it is still that
    question and kept, else found or started (``store.open_set``). A query source runs the
    search panel's own search in the view it is read in — the set ``ids`` names is taken as
    it is, its scope resolved when the run began; ``can_read_view`` holds that view to a
    caller, None reads as the system (a refresh: the view was checked when the definition
    was written).

    ``fresh`` (a new refresh): on data whose version is unknown, a complete set is never
    taken as the answer — nothing says the data has not moved since — so it is let go and
    asked again."""
    from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError

    admit = statement_admission(engine, manager)
    scope = cache_scope(engine) or CacheScope(workspace_id=workspace_id, data_source_id=data_source_id or "")
    found = Sets(sources=list(sources), data_version=data_version)
    for i, source in enumerate(sources):
        spec = source.spec.canonical()
        ms = await sets.get(session, ids[i]) if i < len(ids) and ids[i] else None
        read_in, boundary, pages = None, "", None
        if spec.seeds.query is not None:
            svc = AdvancedSearchService(
                engine, session=getattr(engine, "_db_session", None), workspace_id=workspace_id,
                data_source_id=data_source_id, can_read_view=can_read_view,
            )
            query = seed_query_for(spec, source.read_in)
            read_in = source.read_in
            pages = make_seed_pages(svc, query, data_version=data_version, admit=admit)
            if (ms is not None and ms.status in ("running", "complete") and ms.spec_hash == spec.spec_hash()
                    and ms.read_in == read_in and ms.data_version == data_version and not ms.include_edges):
                found.rows.append(ms)
                found.pages.append(pages)
                continue
            try:
                boundary = (await svc.resolve_scope(query.scope)).scope_hash
            except ValidationError as exc:
                raise PipelineError("source_missing", "The view its query is searched in can't be read.",
                                    reason=str(exc)) from exc
        key = sets.set_key(scope, spec.spec_hash(), read_in=read_in, boundary=boundary,
                           data_version=data_version, include_edges=False)
        if fresh and not data_version:
            stale = await sets.by_key(session, key)
            if stale is not None and stale.status == "complete":
                await sets.retire(session, [stale.id])
        if ms is None or ms.key != key or ms.status not in ("running", "complete"):
            ms = await sets.open_set(
                session, key=key, workspace_id=workspace_id,
                data_source_id=getattr(engine, "_data_source_id", None) or data_source_id,
                branch_id=getattr(engine, "_branch_id", None), read_in=read_in,
                spec=json.dumps(spec.model_dump(mode="json", by_alias=True, exclude_none=True)),
                spec_hash=spec.spec_hash(), data_version=data_version, include_edges=False,
            )
        found.rows.append(ms)
        found.pages.append(pages)
    await session.commit()
    return found


async def advance(session: AsyncSession, found: Sets, engine: Any, *, owner: str, deadline: float,
                  manager: Any = None) -> None:
    """Move each set still running on until ``deadline`` (``stepper.drive``: steps while
    this request holds its lease, a wait while another does)."""
    admit = statement_admission(engine, manager)
    for i, ms in enumerate(found.rows):
        if ms.status != "running":
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            await stepper.drive(session, ms.id, engine, owner=owner, wait_s=remaining, admit=admit,
                                seed_pages=found.pages[i])
        except ValueError as exc:
            # The search refuses the query (a predicate this server cannot run): the
            # definition's fault, said in words — not a failure to retry.
            raise PipelineError("invalid", "The query can't be run as it is.", reason=str(exc)) from exc
    found.rows = [await sets.get(session, ms.id) or ms for ms in found.rows]
    await session.commit()


async def resolve_sets(
    session: AsyncSession, engine: Any, sources: Sequence[MembershipSource], *, workspace_id: str,
    data_source_id: Optional[str], wait_s: float, can_read_view: Any = None,
) -> Sets:
    """The sources' sets on the current data, moved on for up to ``wait_s``: what a new
    view or a preview waits on (answering ``resolving`` until each is complete)."""
    found = await open_sets(session, engine, sources, workspace_id=workspace_id, data_source_id=data_source_id,
                            data_version=await search_data_version(engine), can_read_view=can_read_view)
    await advance(session, found, engine, owner=f"web:{uuid.uuid4().hex[:12]}",
                  deadline=time.monotonic() + wait_s)
    return found


async def statuses(session: AsyncSession, found: Sets) -> List[MemberSetStatus]:
    """How far each set has got, as ``POST /graph/member-sets`` answers it."""
    out = []
    for ms in found.rows:
        queued = 0
        if ms.status == "running" and ms.stage in ("upstream", "downstream"):
            queued = await sets.queued(session, ms.id, ms.stage)
        out.append(MemberSetStatus(
            setId=ms.id, specHash=ms.spec_hash, status=ms.status, stage=ms.stage,
            counts=MembershipCounts.model_validate(sets.loads(ms.counts, {})),
            missingSeeds=int(sets.loads(ms.state, {}).get("missing") or 0),
            truncated=sets.loads(ms.truncated, []), dataVersion=ms.data_version,
            progress=MemberSetProgress(steps=ms.step, queued=queued),
            startedAt=ms.created_at, completedAt=ms.completed_at, expiresAt=ms.expires_at,
        ))
    await session.commit()
    return out


async def retire_short(session: AsyncSession, found: Sets) -> None:
    """Let go of the sets that answered short, so the next ask resolves them afresh
    rather than finding the same short answer."""
    await sets.retire(session, [ms.id for ms in found.rows
                                if any(t["reason"] in RETRYABLE for t in sets.loads(ms.truncated, []))])
    await session.commit()


def _chunk(session: AsyncSession, taken: int = 0) -> int:
    return max(1, view_members_repo._params(session) - taken - 1)


async def member_count(session: AsyncSession, found: Sets, exclude: Sequence[str]) -> int:
    """How many members the sets hold together, less what is kept out: decided before
    anything is placed, against the limit."""
    ids = found.ids
    rows = MemberSetRowORM
    if len(ids) == 1:
        total = int(found.rows[0].member_count or 0)
    else:
        total = int((await session.execute(
            select(func.count(func.distinct(rows.urn))).where(rows.set_id.in_(ids)))).scalar() or 0)
    left_out = sorted(set(exclude))
    for i in range(0, len(left_out), _chunk(session, len(ids))):
        part = left_out[i:i + _chunk(session, len(ids))]
        total -= int((await session.execute(
            select(func.count(func.distinct(rows.urn))).where(rows.set_id.in_(ids), rows.urn.in_(part))
        )).scalar() or 0)
    await session.commit()
    return total


# ── A page of members ────────────────────────────────────────────────────────

def _hops(row: Any) -> Optional[int]:
    return row.hops_up if row.via == "upstream" else row.hops_down if row.via == "downstream" else None


async def read_facts(engine: Any, urns: Sequence[str], *, admit: Any = None) -> Dict[str, NodeFacts]:
    """What placing reads about each entity — type, name, tags, properties — in one statement."""
    if not urns:
        return {}
    async with _slot(admit):
        nodes = await engine.get_nodes_query(NodeQuery(urns=list(urns), limit=len(urns), include_child_count=False))
    return {node.urn: facts_from_graph_node(node) for node in nodes}


async def read_chains(engine: Any, urns: Sequence[str], *, admit: Any = None) -> Dict[str, List[str]]:
    """Each entity's containers, parent first, in one statement. A reader with no
    containment walk places members without their paths."""
    if not urns:
        return {}
    try:
        async with _slot(admit):
            return await engine.get_ancestor_chains(list(urns))
    except NotImplementedError:
        return {}


@dataclass
class Page:
    """A page of one set's members, with what placing them reads."""
    members: List[Candidate]
    context: Dict[str, Candidate]
    previous: Dict[str, dict]
    facts: Dict[str, NodeFacts]
    info: Dict[str, Tuple[Optional[str], Optional[str]]]
    last_seq: int
    read: int


async def read_page(
    session: AsyncSession, engine: Any, found: Sets, src: int, after: int, *, size: int,
    exclude: Sequence[str], view_id: Optional[str], members_epoch: Optional[int], facts: bool, admit: Any,
    known: Optional["OrderedDict[str, NodeFacts]"] = None,
) -> Page:
    """Up to ``size`` of set ``src``'s rows after ``after``: those an earlier source does
    not name, less what is kept out, as members — whole when any source says so — and
    the containers on their paths, a member among them as a member. ``known``: the facts
    of containers read before, so only the rest are read (and kept there, ``FACTS_KEPT``)."""
    r = MemberSetRowORM
    columns = (r.set_id, r.urn, r.seq, r.via, r.hops_up, r.hops_down, r.whole, r.name, r.type)
    rows = (await session.execute(
        select(*columns).where(r.set_id == found.rows[src].id, r.seq > after).order_by(r.seq).limit(size)
    )).all()
    await session.commit()
    urns = [row.urn for row in rows]
    chains = await read_chains(engine, urns, admit=admit)
    every = sorted(set(urns) | {a for u in urns for a in chains.get(u, ())})
    index = {sid: i for i, sid in enumerate(found.ids)}
    held: Dict[str, Dict[int, Any]] = {}
    step = _chunk(session, len(index))
    for i in range(0, len(every), step):
        for row in (await session.execute(
                select(*columns).where(r.set_id.in_(found.ids), r.urn.in_(every[i:i + step])))).all():
            held.setdefault(row.urn, {})[index[row.set_id]] = row
    previous = (await view_members_repo.placements(session, view_id, members_epoch, every)
                if view_id is not None else {})
    await session.commit()
    read: Dict[str, NodeFacts] = {}
    if facts:
        kept = known if known is not None else OrderedDict()
        read = await read_facts(engine, [u for u in every if u not in kept], admit=admit)
        for u in every:
            if u in kept:
                read[u] = kept[u]
                kept.move_to_end(u)
        kept.update((a, read[a]) for u in urns for a in chains.get(u, ()) if a in read)
        while len(kept) > FACTS_KEPT:
            kept.popitem(last=False)

    left_out = set(exclude)

    def member(urn: str, there: Dict[int, Any], chain: Tuple[str, ...]) -> Candidate:
        first = min(there)
        row = there[first]
        return Candidate(urn, True, any(x.whole for x in there.values()), row.via, _hops(row),
                         found.sources[first].layer_id, chain)

    members = [member(row.urn, held.get(row.urn) or {src: row}, tuple(chains.get(row.urn, ())))
               for row in rows if row.urn not in left_out and min(held.get(row.urn) or {src: row}) >= src]
    mine = {c.urn for c in members}
    context: Dict[str, Candidate] = {}
    for u in urns:
        chain = tuple(chains.get(u, ()))
        for k, a in enumerate(chain):
            if a in context or a in mine:
                continue
            there = held.get(a)
            context[a] = (member(a, there, chain[k + 1:]) if there and a not in left_out
                          else Candidate(a, False, chain=chain[k + 1:]))
    return Page(members=members, context=context, previous=previous, facts=read,
                info={row.urn: (row.name, row.type) for row in rows},
                last_seq=rows[-1].seq if rows else after, read=len(rows))


# ── Planning ─────────────────────────────────────────────────────────────────

def make_placer(
    definition: MembershipDefinition, *, layers: List[dict], source_config: Optional[dict],
    facts: Dict[str, NodeFacts], source_placed: Optional[Mapping[str, Optional[str]]] = None,
) -> Placer:
    """``source_placed``: where the view made from a query a ``source`` layout copies has
    each candidate (``placed_in_source``) — its member rows, which its config holds none of."""
    kind = definition.layout.kind
    if kind == "stages":
        return stage_placer()
    if kind == "auto":
        return auto_placer(layouts.type_layer_map(layers), facts)
    if kind == "source" and source_placed is not None:
        return prepared_placer(source_placed, layouts.link_map(layers))
    if kind == "source" and source_config is not None:
        return source_placer(source_config, layouts.link_map(layers), facts)
    if kind == "follow" and source_config is not None:
        # The view it follows places each entity, in that view's own layers.
        return source_placer(source_config, {i: i for i in layouts.layer_ids(layers)}, facts)
    # template / custom — and a source view that is gone: this view's own layer rules.
    return rules_placer(layers, facts)


def follow_refusal(base_config: dict) -> Optional[Tuple[str, str]]:
    """Why a view made from a query can't follow the view ``base_config`` is — ``(reason,
    message)`` — or None. A view showing another's layers already (a subset, or one that
    follows a view) is followed by following that one; a view made from a query keeps its
    members' places in its member table, past the config a follower places by."""
    if is_subset(base_config) or followed_base(base_config) is not None:
        return "base_is_subset", ("That view is a subset of another view: make this one follow that "
                                  "view instead.")
    if isinstance(base_config.get("membership"), dict):
        return "base_is_list", ("That view is made from a query, so where its members sit can't be "
                                "followed. Arrange the new view by type or by lineage stage instead.")
    return None


def fallback_of(definition: MembershipDefinition, layers: List[dict]) -> Optional[str]:
    """The layer members nothing places wait in: the definition's — or, following a view,
    the one that view keeps for what it places nowhere (its own, or "Other matches")."""
    if definition.layout.kind == "follow":
        return next((layer["id"] for layer in layers if layer.get("showUnassigned") is True), None)
    return definition.layout.fallback_layer_id


def answered(definition: MembershipDefinition, followed: Optional[dict]) -> str:
    """What an applied answer answers: what the sources resolve to — and, following a
    view, how that view places entities, so a change to that (a type moved to another
    layer, a rule, a layer gone) places the members again the next time it is opened. A
    rename needs nothing: its layers are served from that view on every read."""
    if definition.layout.kind != "follow":
        return definition.resolution_hash()
    return _sha([definition.resolution_hash(), placement_digest(PlacementSpec.from_config(followed))])


@dataclass
class Inputs:
    """What placing reads of the view as it is now: its definition (where people put
    members, what it keeps out), its layers and the entries people placed themselves."""
    definition: MembershipDefinition
    layers: List[dict]
    user: Dict[str, dict]
    source_config: Optional[dict]
    overrides: Dict[str, dict] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.overrides = {u: o.model_dump(by_alias=True, exclude_none=True)
                          for u, o in self.definition.overrides.items()}

    @property
    def digest(self) -> str:
        """What a placed page depends on: when it changes under a run, its pages so far
        answer another question. Where people put members is not in it — a move made
        meanwhile is applied as the run finishes. Following a view, how that view places
        entities is."""
        parts = [self.definition.layout.model_dump(mode="json", by_alias=True),
                 layouts.layer_ids(self.layers), sorted(set(self.definition.exclude)), sorted(self.user)]
        if self.definition.layout.kind == "follow":
            parts.append(placement_digest(PlacementSpec.from_config(self.source_config)))
        return _sha(parts)


def inputs_of(config: dict, definition: MembershipDefinition, source_config: Optional[dict]) -> Inputs:
    """Following a view, its layers are that view's as it is now (it stores none), and
    what people put in a layer that view has since deleted is in its fallback layer.
    Every entry of its config that is not the server's is a person's (``user``): one they
    placed themselves, or a root a view-scoped import pinned in it (``assignedBy:
    "import"``) — drawn where it is put, never a member."""
    layers, assignments = layout_of(config)
    if definition.layout.kind == "follow":
        if source_config is None:
            raise PipelineError("source_missing", "The view it follows can't be read.")
        layers = layouts.followed(source_config)
    inputs = Inputs(definition=definition, layers=layers, source_config=source_config,
                    user={u: e for u, e in assignments.items() if e.get("assignedBy") != MACHINE})
    if definition.layout.kind == "follow":
        inputs.user = in_followed_layers(inputs.user, layers)
        inputs.overrides = in_followed_layers(inputs.overrides, layers)
    return inputs


def place(page: Page, inputs: Inputs, *, now: str,
          source_placed: Optional[Mapping[str, Optional[str]]] = None) -> Tuple[List[Placed], int]:
    """A page's rows. A layout whose placement moves with what is outside the view (lineage
    distances; a followed view's layers) re-places the members it holds, never keeping one
    in a layer only because it sat there. ``source_placed``: see ``make_placer``."""
    d = inputs.definition
    return plan_page(
        page.members, context=page.context, previous=page.previous, user=inputs.user,
        layer_ids=layouts.layer_ids(inputs.layers), overrides=inputs.overrides,
        placer=make_placer(d, layers=inputs.layers, source_config=inputs.source_config, facts=page.facts,
                           source_placed=source_placed),
        fallback_layer_id=fallback_of(d, inputs.layers), exclude=d.exclude,
        restage=d.layout.kind in ("stages", "follow"),
        place_containers=d.layout.nest and d.layout.kind != "stages", nest=d.layout.nest, now=now,
    )


def _rows(view_id: str, epoch: int, page: Page, placed: Sequence[Placed], placing: dict) -> List[dict]:
    """A page's rows, numbered on from where the run is: ``ord`` across the epoch,
    ``label_ord`` within each label."""
    by_urn = {c.urn: c for c in page.members}
    labels = placing.setdefault("labels", {})
    out = []
    for p in placed:
        name, kind = page.info.get(p.urn, (None, None))
        facts = page.facts.get(p.urn)
        name = name or (facts.display_name if facts is not None else None)
        kind = kind or (facts.entity_type if facts is not None else None)
        label = kind or ""
        c = by_urn[p.urn]
        out.append({
            "view_id": view_id, "epoch": epoch, "urn": p.urn, "layer_id": p.layer_id,
            "sort_key": view_members_repo.sort_key(name, p.urn), "ord": placing["ord"], "label": label,
            "label_ord": int(labels.get(label, 0)), "via": c.via, "hops": c.hops, "whole": p.whole,
            "covered": p.covered, "name": name, "type": kind, "assigned_at": p.assigned_at,
            "order_key": p.order_key, "logical_node_id": p.logical_node_id, "in_layer": p.in_layer,
        })
        placing["ord"] += 1
        labels[label] = int(labels.get(label, 0)) + 1
    return out


def initial_layers(
    definition: MembershipDefinition,
    sample: Optional["Sample"],
    *,
    source_config: Optional[dict],
    client_layers: Optional[List[dict]],
) -> Tuple[List[dict], List[dict]]:
    """The layers a new view starts with, and the display rules it inherits."""
    kind = definition.layout.kind
    if kind == "source":
        if source_config is None:
            raise PipelineError("source_missing", "The view to copy the layers of can't be read.")
        ref = parse_reference_layout(source_config)
        layers = layouts.layers_like(ref.layers)
        if not layers:
            raise PipelineError("invalid", "That view has no layers to copy. Arrange the new view by type "
                                           "or by lineage stage instead.")
        raw = (source_config.get("layout") or {}).get("referenceLayout") or {}
        rules = raw.get("displayRules") if isinstance(raw, dict) else None
        return layers, list(rules) if isinstance(rules, list) else []
    if kind == "follow":
        if source_config is None:
            raise PipelineError("source_missing", "The view to follow can't be read.")
        return layouts.followed(source_config), []
    if kind == "stages":
        return layouts.stage_layers(definition.sources[0].spec.expand), []
    if kind == "auto":
        members = {c.urn: c for c in (sample.members if sample is not None else [])}
        layers = layouts.auto_layers(top_type_counts(members, sample.facts if sample is not None else {}))
        return layers or [layouts.fallback_layer([])], []
    layers = [dict(layer) for layer in (client_layers or []) if isinstance(layer, dict)]
    for i, layer in enumerate(layers):
        if not isinstance(layer.get("id"), str) or not layer["id"]:
            layer["id"] = f"layer-{uuid.uuid4().hex[:10]}"
        layer.setdefault("order", i)
    if not layers:
        raise PipelineError("invalid", "A view needs at least one layer.")
    return layers, []


@dataclass
class Sample:
    """The first members of the sets in the order they were found, with what placing
    them reads: what a preview counts, and what a new view's layers are chosen from."""
    members: List[Candidate] = field(default_factory=list)
    context: Dict[str, Candidate] = field(default_factory=dict)
    facts: Dict[str, NodeFacts] = field(default_factory=dict)


async def read_sample(session: AsyncSession, engine: Any, found: Sets, definition: MembershipDefinition,
                      *, size: int) -> Sample:
    admit = statement_admission(engine)
    sample = Sample()
    known: "OrderedDict[str, NodeFacts]" = OrderedDict()
    for src in range(len(found.rows)):
        after = -1
        while len(sample.members) < size:
            page = await read_page(session, engine, found, src, after, size=PAGE, exclude=definition.exclude,
                                   view_id=None, members_epoch=None,
                                   facts=definition.layout.kind != "stages", admit=admit, known=known)
            sample.members += page.members[:size - len(sample.members)]
            sample.context.update(page.context)
            sample.facts.update(page.facts)
            if page.read < PAGE:
                break
            after = page.last_seq
    return sample


@dataclass
class Draft:
    """A new view, worked out: the layers it keeps, every layer it was offered (for a
    preview), and what it would hold — each layer's count, from every member or (above
    ``ESTIMATE_ABOVE``) estimated from the first ``SAMPLE``."""
    layers: List[dict]
    all_layers: List[dict]
    display_rules: List[dict]
    definition: MembershipDefinition
    found: Sets
    members: int
    limit: int
    per_layer: Dict[str, int] = field(default_factory=dict)
    fallback: int = 0
    estimated: bool = False

    @property
    def over_cap(self) -> bool:
        return self.members > self.limit


async def draft_view(
    session: AsyncSession, engine: Any, found: Sets, definition: MembershipDefinition, *,
    source_config: Optional[dict], client_layers: Optional[List[dict]], keep: str, limit: int,
    place_sample: bool = True, estimate_above: Optional[int] = None,
) -> Draft:
    """The layers a view made from these sets would start with, and what each would hold.

    Placed before anything is written, so the view's design — and its first version — is
    never rewritten after it is made: up to ``estimate_above`` (``ESTIMATE_ABOVE``) members
    every one is placed and the answer is exact; above, the first ``SAMPLE`` are, and it is
    ``estimated`` (and keeps a fallback layer for what the sample did not see — and, its
    layers copied from a view, every one of them: a sample can't show one holds nothing)."""
    members = await member_count(session, found, definition.exclude)
    kind = definition.layout.kind
    estimated = members > (ESTIMATE_ABOVE if estimate_above is None else estimate_above)
    sample = (await read_sample(session, engine, found, definition, size=SAMPLE if estimated else members)
              if place_sample or kind == "auto" else None)
    layers, display_rules = initial_layers(definition, sample, source_config=source_config,
                                           client_layers=client_layers)
    # Layers someone chose — or a followed view's, every one of them — are kept as they are.
    others = kind not in ("template", "custom", "follow")
    source = await source_list(session, definition, source_config) if sample is not None else None
    source_placed = None
    if source is not None:
        source_placed = await placed_in_source(session, engine, source,
                                               [*(c.urn for c in sample.members), *sample.context],
                                               admit=statement_admission(engine))

    def planned(layers: List[dict], d: MembershipDefinition) -> Tuple[List[Placed], int]:
        if sample is None:
            return [], 0
        return plan_page(
            sample.members, context=sample.context, previous={}, user={}, layer_ids=layouts.layer_ids(layers),
            overrides={}, placer=make_placer(d, layers=layers, source_config=source_config, facts=sample.facts,
                                             source_placed=source_placed),
            fallback_layer_id=fallback_of(d, layers), exclude=d.exclude, restage=kind == "stages",
            place_containers=d.layout.nest and kind != "stages", nest=d.layout.nest)

    placed, fallback = planned(layers, definition)
    if others and (fallback or (estimated and sample is not None)):
        # Members nothing places get a layer of their own, rather than crowd the first.
        other = layouts.fallback_layer(layers)
        layers = [*layers, other]
        definition = definition.model_copy(update={
            "layout": definition.layout.model_copy(update={"fallback_layer_id": other["id"]})})
        placed, fallback = planned(layers, definition)
    per_layer: Dict[str, int] = {}
    for p in placed:
        per_layer[p.layer_id] = per_layer.get(p.layer_id, 0) + 1
    if estimated and placed:
        scale = members / len(sample.members)
        per_layer = {k: max(1, round(v * scale)) for k, v in per_layer.items()}
        fallback = round(fallback * scale)
    offered = layers
    if keep == "withResults" and others and sample is not None and not (estimated and kind == "source"):
        # The layers someone chose themselves stay; the ones copied or made for them
        # are kept only when they hold something (an estimate's fallback layer always:
        # it is where what the sample did not see waits). Estimated, copied layers all
        # stay: what the sample did not see may be in any of them.
        waiting_room = definition.layout.fallback_layer_id if estimated else None
        held = [layer for layer in layers if per_layer.get(layer["id"]) or layer["id"] == waiting_room]
        layers = held or layers[:1]
    return Draft(layers=layers, all_layers=offered, display_rules=display_rules, definition=definition,
                 found=found, members=members, limit=limit, per_layer=per_layer, fallback=fallback,
                 estimated=estimated)


class _DraftKept(BaseModel):
    """A draft as the graph cache keeps it: what ``draft_view`` worked out, less the sets
    and the definition the caller already holds."""
    layers: List[dict]
    all_layers: List[dict]
    display_rules: List[dict]
    fallback_layer_id: Optional[str] = None
    members: int
    per_layer: Dict[str, int] = {}
    fallback: int = 0
    estimated: bool = False


async def draft_cached(
    session: AsyncSession, engine: Any, found: Sets, definition: MembershipDefinition, *,
    source_config: Optional[dict], client_layers: Optional[List[dict]], keep: str, limit: int,
    place_sample: bool = True, bounded: bool = False,
) -> Draft:
    """``draft_view``, kept in the graph cache for ``DRAFT_TTL_S``: a preview and the save
    that follows it work one draft out, so the view is made with the layers the preview
    showed. Keyed by the sets, the data they were resolved on, and all that placing reads
    (the layout, what is kept, the client's layers, what is kept out, the view whose layers
    are copied or followed as it is now). ``bounded`` (a save): on a miss only the first
    ``SAMPLE`` members are placed, so saving takes no longer however many the view holds."""

    async def compute() -> _DraftKept:
        draft = await draft_view(session, engine, found, definition, source_config=source_config,
                                 client_layers=client_layers, keep=keep, limit=limit, place_sample=place_sample,
                                 estimate_above=SAMPLE if bounded else None)
        return _DraftKept(layers=draft.layers, all_layers=draft.all_layers, display_rules=draft.display_rules,
                          fallback_layer_id=draft.definition.layout.fallback_layer_id, members=draft.members,
                          per_layer=draft.per_layer, fallback=draft.fallback, estimated=draft.estimated)

    scope = cache_scope(engine)
    if scope is None:
        kept = await compute()
    else:
        kept = await get_graph_cache().get_or_compute(
            scope=scope, endpoint=ENDPOINT_MEMBERS_DRAFT, compute=compute, model_cls=_DraftKept,
            ttl_seconds=DRAFT_TTL_S, params={
                "sets": found.ids, "data": found.data_version, "sources": definition.resolution_hash(),
                "layout": definition.layout.model_dump(mode="json", by_alias=True), "keep": keep,
                "layers": client_layers, "exclude": sorted(set(definition.exclude)),
                "source": _sha(source_config) if source_config is not None else None, "sampled": place_sample,
            })
    if kept.fallback_layer_id != definition.layout.fallback_layer_id:
        definition = definition.model_copy(update={
            "layout": definition.layout.model_copy(update={"fallback_layer_id": kept.fallback_layer_id})})
    return Draft(layers=kept.layers, all_layers=kept.all_layers, display_rules=kept.display_rules,
                 definition=definition, found=found, members=kept.members, limit=limit,
                 per_layer=kept.per_layer, fallback=kept.fallback, estimated=kept.estimated)


async def draft_copy(session: AsyncSession, found: Sets, definition: MembershipDefinition, config: dict, *,
                     limit: int) -> Draft:
    """A copy of a view made from a query (a duplicate): its layers as that view has them now,
    nothing placed beforehand — its members are worked out afresh, as any new view's — and
    what it would hold, against the limit."""
    layers, _ = layout_of(config)
    return Draft(layers=layers, all_layers=layers, display_rules=[], definition=definition, found=found,
                 members=await member_count(session, found, definition.exclude), limit=limit)


def plan_answer(draft: Draft) -> MembershipPlan:
    """A draft, as the preview shows it: what the view would hold against the
    limit, and each layer offered with its count and whether it is kept."""
    kept = set(layouts.layer_ids(draft.layers))
    return MembershipPlan(
        keys=draft.members, members=draft.members, containers=0, included=0, limit=draft.limit,
        over_cap=draft.over_cap, estimated=draft.estimated,
        layers=[
            PlanLayer(id=layer["id"], name=str(layer.get("name") or ""), color=layer.get("color"),
                      count=draft.per_layer.get(layer["id"], 0), link_layer_id=layer.get("linkLayerId"),
                      kept=layer["id"] in kept)
            for layer in draft.all_layers
        ],
        fallback=draft.fallback, truncated=draft.found.truncated(), missing_seeds=draft.found.missing_seeds(),
        data_version=draft.found.data_version,
    )


def view_config(draft: Draft, *, icon: Optional[str] = None) -> dict:
    """The new view's config — shaped as the wizard shapes one (so every screen
    treats it as any other view): a curated reference view, its definition beside it.
    Its members are rows of ``view_members``, never entries here. One that follows a view
    stores no layers: it is served that view's (``search_views.served_config``)."""
    follows = draft.definition.layout.kind == "follow"
    layout: Dict[str, Any] = {"layers": [] if follows else draft.layers, "assignments": {}}
    if draft.display_rules:
        layout["displayRules"] = draft.display_rules
    return {
        "icon": icon or "Layout",
        "content": {"visibleEntityTypes": [], "visibleRelationshipTypes": [], "defaultDepth": 5,
                    "maxDepth": 10, "entityScope": "curated"},
        "layout": {"type": "reference", "referenceLayout": layout, "lod": {"enabled": False, "levels": []}},
        "filters": {"entityTypeFilters": [], "fieldFilters": [], "searchableFields": [], "quickFilters": []},
        "entityOverrides": {},
        "membership": draft.definition.model_dump(mode="json", by_alias=True, exclude_none=True),
    }


def applied_values(definition: MembershipDefinition, found: Sets, *, members: int, included: int,
                   per_layer: Dict[str, int], fallback: int, status: str, answered: str) -> Dict[str, Any]:
    """The state row's record of an applied answer, and what it answers (``answered()``)."""
    return dict(
        status=status,
        status_detail=None,
        resolution_hash=definition.resolution_hash(),
        applied_resolution_hash=answered,
        data_version=found.data_version,
        member_count=members,
        key_count=members + included,
        counts=dumps({"members": members, "containers": 0, "included": included, "fallback": fallback,
                      "missingSeeds": found.missing_seeds(), "perLayer": per_layer}),
        truncated=dumps(found.truncated()),
        last_applied_at=now_iso(),
        last_error=None,
        attempts=0,
        held=None,
    )


# ── The view ─────────────────────────────────────────────────────────────────

def layout_of(config: dict) -> Tuple[List[dict], Dict[str, dict]]:
    ref = (config.get("layout") or {}).get("referenceLayout") or {}
    layers = [layer for layer in (ref.get("layers") or []) if isinstance(layer, dict)]
    assignments = {u: e for u, e in (ref.get("assignments") or {}).items() if isinstance(e, dict)}
    return layers, assignments


def config_of(row: ViewORM) -> dict:
    try:
        config = json.loads(row.config or "{}")
    except ValueError:
        return {}
    return config if isinstance(config, dict) else {}


async def source_config(session: AsyncSession, definition: MembershipDefinition,
                        workspace_id: str) -> Optional[dict]:
    """The config of the view a ``source`` layout copies placements from, or a ``follow``
    layout follows, while it exists — as it is read: one that follows a view itself is
    served that view's layers (``view_repo.followed_configs``), so a view made like it
    gets those."""
    from backend.app.db.repositories.view_repo import followed_configs

    sid = definition.layout.source_view_id
    if definition.layout.kind not in ("source", "follow") or not sid:
        return None
    source = (await session.execute(select(ViewORM).where(ViewORM.id == sid, view_is_live()))).scalar_one_or_none()
    if source is None or source.workspace_id != workspace_id:
        return None
    return (await followed_configs(session, [source])).get(source.id) or config_of(source)


@dataclass
class SourceList:
    """The view made from a query a ``source`` layout copies placements from, as
    ``where.place_in_list`` reads it: its config holds none of its members, so where it has
    each entity is read from its member rows, a page at a time."""
    view_id: str
    view: Any               # where.ListView


async def source_list(session: AsyncSession, definition: MembershipDefinition,
                      copied: Optional[dict]) -> Optional[SourceList]:
    """For a ``source`` layout whose view (``copied``: its config, as ``source_config`` reads
    it) is made from a query, that view, to place by its rows. None for any other view — its
    config places entities (``source_placer``) — or for one following a view no longer there."""
    from backend.app.services.live_views import where     # it reads this module

    sid = definition.layout.source_view_id
    if (definition.layout.kind != "source" or not sid or copied is None
            or not isinstance(copied.get("membership"), dict)):
        return None
    row = await _live_row(session, sid)
    config = config_of(row) if row is not None else {}
    theirs = read_definition(config)
    if theirs is None:
        return None
    try:
        return SourceList(view_id=row.id, view=await where.list_view(session, row, config, theirs))
    except where.BaseMissing:
        return None


async def placed_in_source(session: AsyncSession, engine: Any, source: SourceList, urns: Sequence[str], *,
                           admit: Any = None) -> Dict[str, Optional[str]]:
    """Where ``source`` has each of ``urns`` — a member where its row puts it, an entry, what
    is inside one, or where its layout places the rest — ``PAGE`` at a time; None where it
    has one only waiting to be placed (its fallback layer), or nowhere."""
    from backend.app.services.live_views import where

    wanted = sorted(set(urns))
    out: Dict[str, Optional[str]] = {}
    for i in range(0, len(wanted), PAGE):
        found = await where.place_in_list(session, engine, source.view_id, source.view, wanted[i:i + PAGE],
                                          admit=admit)
        out.update({u: w[0] if w[1] not in ("fallback", "none") else None for u, w in found.items()})
    return out


async def effective_data_source(session: AsyncSession, workspace_id: str,
                                data_source_id: Optional[str]) -> Optional[str]:
    """The data source a view reads: its own, else its workspace's primary."""
    if data_source_id:
        return data_source_id
    primary = await data_source_repo.get_primary_data_source(session, workspace_id)
    return primary.id if primary is not None else None


async def read_in_views(session: AsyncSession, definition: MembershipDefinition) -> Dict[str, Optional[ViewORM]]:
    """Each view the definition's queries are searched in, or None where it is gone."""
    ids = sorted({s.read_in for s in definition.sources if s.read_in})
    if not ids:
        return {}
    rows = (await session.execute(select(ViewORM).where(ViewORM.id.in_(ids), view_is_live()))).scalars().all()
    found = {r.id: r for r in rows}
    return {i: found.get(i) for i in ids}


async def _read_in_available(session: AsyncSession, definition: MembershipDefinition, row: ViewORM) -> bool:
    """Every view searched in still there, in this view's workspace and data source."""
    views = await read_in_views(session, definition)
    if not views:
        return True
    mine = await effective_data_source(session, row.workspace_id, row.data_source_id)
    for other in views.values():
        if other is None or other.id == row.id or other.workspace_id != row.workspace_id:
            return False
        if await effective_data_source(session, other.workspace_id, other.data_source_id) != mine:
            return False
    return True


async def _live_row(session: AsyncSession, view_id: str) -> Optional[ViewORM]:
    return (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id, view_is_live()).execution_options(populate_existing=True)
    )).scalar_one_or_none()


@dataclass
class Outcome:
    """What one refresh did — ``applied``, ``unchanged``, ``running`` (a large view, still
    being worked out: ask again to carry on), ``held`` (a large removal waits to be
    confirmed), ``over_cap``, ``deferred`` (a short answer: the last good members kept),
    ``busy`` (another request holds the view), ``fenced`` (overtaken), ``source_missing``
    or ``failed`` — the status it left, and the record of it."""
    outcome: str
    status: str
    detail: Dict[str, Any] = field(default_factory=dict)
    diff: Optional[dict] = None


# ── Refresh ──────────────────────────────────────────────────────────────────

async def refresh(
    view_id: str,
    *,
    session: AsyncSession,
    engine_scope: EngineScope,
    owner: str,
    budget_s: float,
    confirm_removals: bool = False,
    actor: Optional[str] = None,
    manager: Any = None,
    only_if_changed: bool = False,
    page_size: Optional[int] = None,
) -> Outcome:
    """Work out a view's members again and apply them — see the module docstring.
    ``session`` serves the short SQL steps and is committed after each.

    A run already at the view's epoch (one a request before this left ``running``, or
    one that stopped mid-page) is carried on there, without a new epoch: its pages so
    far stand. ``only_if_changed`` (the view being opened): otherwise nothing is worked
    out unless the data or what the view is made of changed since it last was, and a
    held removal stays held — told from its state and the data's version, before
    anything is claimed (a claim shows the view as updating to everyone looking at it).
    The data's version is read without an engine while this process knows the graph
    behind it (``known_data_version``): opening a view that is up to date takes no
    admission, connection or fair-share token.

    Raises ``PipelineError`` for a view that is not one to refresh, and lets
    ``ProviderUnavailable`` (busy, failing over, down) through once the view is
    released and due again — the caller answers it with a Retry-After."""
    deadline = time.monotonic() + budget_s
    row = await _live_row(session, view_id)
    if row is None:
        raise PipelineError("not_found", "This view can't be found.")
    definition = read_definition(config_of(row))
    if definition is None:
        raise PipelineError("invalid", "This view isn't made from a query.")
    state = await view_membership_repo.ensure(session, row)
    progress = view_membership_repo.in_progress(state, definition.resolution_hash())
    if definition.mode != "live" and progress is None and state.members_epoch is not None:
        # A snapshot never answered (one imported without its members) works out its
        # first answer once: then it is frozen like any other.
        raise PipelineError("frozen", "This view is a snapshot: its members stay as they are until "
                                      "updates are resumed.")
    if not await _read_in_available(session, definition, row):
        state.status = "source_missing"
        state.status_detail = dumps({"reason": "read_in_missing"})
        state.materialize = None
        await session.commit()
        return Outcome("source_missing", "source_missing")
    followed = (await source_config(session, definition, row.workspace_id)
                if definition.layout.kind == "follow" else None)
    if definition.layout.kind == "follow" and followed is None:
        # The view it follows is gone, or out of reach: its members stay as they are,
        # and it shows no layers until that view is back.
        state.status = "source_missing"
        state.status_detail = dumps({"reason": "base_missing"})
        state.materialize = None
        await session.commit()
        return Outcome("source_missing", "source_missing")
    workspace_id, data_source_id = row.workspace_id, row.data_source_id
    if only_if_changed:
        if state.status == "held":
            return Outcome("current", "held", {"reason": "held"})
        if (progress is None and state.status in ("ok", "partial") and state.data_version
                and state.applied_resolution_hash == answered(definition, followed)):
            version = await known_data_version(
                workspace_id, await effective_data_source(session, workspace_id, data_source_id))
            if version != state.data_version:
                async with engine_scope(workspace_id, data_source_id, actor) as engine:
                    version = await search_data_version(engine)
            if version and version == state.data_version:
                return Outcome("current", state.status, {"reason": "up_to_date"})
    epoch: Optional[int] = None
    try:
        if progress is not None:
            if not await view_membership_repo.take_over(session, view_id, owner=owner, epoch=state.epoch,
                                                        lease_s=LEASE_SECS):
                # Another request is carrying the run on now: ask again, as while it runs.
                await session.commit()
                return Outcome("running", "updating", {"reason": "busy"})
            epoch = state.epoch
        else:
            epoch = await view_membership_repo.claim(session, view_id, owner=owner, lease_s=LEASE_SECS)
            if epoch is None:
                await session.commit()
                return Outcome("busy", "updating")
            progress = {"epoch": epoch, "hash": definition.resolution_hash(), "sets": []}
            await view_membership_repo.update_mine(session, view_id, owner=owner, epoch=epoch,
                                                   materialize=dumps(progress),
                                                   status_detail=dumps(run_detail(progress)))
        await session.commit()
    except asyncio.CancelledError:
        # Cut off holding the view — its claim may have landed: let go at once, as a turn does.
        if epoch is not None:
            _let_go(view_id, owner=owner, epoch=epoch)
        raise
    return await _Run(session, view_id, owner=owner, epoch=epoch, progress=progress, definition=definition,
                      workspace_id=workspace_id, data_source_id=data_source_id, actor=actor,
                      manager=manager).go(engine_scope, deadline=deadline, confirm_removals=confirm_removals,
                                          page_size=page_size)


async def start(session: AsyncSession, row: ViewORM, definition: MembershipDefinition, found: Sets, *,
                owner: str, members: int) -> int:
    """Claim a new view for its first answer, its sets already resolved and its ``members``
    counted: the run ``carry_on`` then places (or the next request, when it outlasts this
    one). Cut off once it holds the view, it lets go at once — the caller's transaction
    may still land — as a turn does; so does the caller, cut off as it commits."""
    await view_membership_repo.ensure(session, row)
    epoch = await view_membership_repo.claim(session, row.id, owner=owner, lease_s=LEASE_SECS)
    assert epoch is not None, "a view nobody else has seen yet is free to claim"
    try:
        progress = {"epoch": epoch, "hash": definition.resolution_hash(), "sets": found.ids,
                    "dataVersion": found.data_version, "placing": _placing(members)}
        await view_membership_repo.update_mine(session, row.id, owner=owner, epoch=epoch,
                                               materialize=dumps(progress),
                                               status_detail=dumps(run_detail(progress, found)))
    except asyncio.CancelledError:
        _let_go(row.id, owner=owner, epoch=epoch)
        raise
    return epoch


async def carry_on(view_id: str, *, session: AsyncSession, engine_scope: EngineScope, owner: str,
                   budget_s: float, apply_budget_s: Optional[float] = None, actor: Optional[str] = None) -> Outcome:
    """Work out, within ``budget_s``, the run this request holds (``start``) — and apply
    it while ``apply_budget_s`` (the request's own budget, when longer) has room."""
    now = time.monotonic()
    row = await _live_row(session, view_id)
    definition = read_definition(config_of(row)) if row is not None else None
    state = await view_membership_repo.get(session, view_id)
    progress = view_membership_repo.in_progress(state, definition.resolution_hash()) if definition else None
    if progress is None or state.lease_owner != owner:
        await session.commit()
        return Outcome("fenced", "updating")
    await session.commit()
    return await _Run(session, view_id, owner=owner, epoch=state.epoch, progress=progress, definition=definition,
                      workspace_id=row.workspace_id, data_source_id=row.data_source_id,
                      actor=actor).go(engine_scope, deadline=now + budget_s,
                                      apply_by=None if apply_budget_s is None else now + apply_budget_s)


def run_detail(progress: dict, found: Optional[Sets] = None) -> Dict[str, Any]:
    """How far a run has got, for whoever asks while it runs: placing (``placed`` of
    ``members``), or still resolving its sets."""
    placing = progress.get("placing")
    out: Dict[str, Any] = {
        "reason": "placing" if placing else "resolving",
        "sets": [{"setId": ms.id, "status": ms.status, "stage": ms.stage, "members": ms.member_count}
                 for ms in (found.rows if found is not None else [])],
    }
    if placing:
        out.update(placed=placing["placed"], members=placing["members"])
    return out


def _own_session():
    """A session of its own, from the web pool: what a turn cut off lets go of its lease
    through."""
    from backend.app.db.engine import get_async_session

    return get_async_session()


#: Turns cut off, letting go of their leases: held here until done (nobody awaits them).
_letting_go: set = set()


def _let_go(view_id: str, *, owner: str, epoch: int) -> None:
    """Free a turn's lease — its status and progress kept: its pages so far stand — in a
    task of its own, on a session of its own (the turn's may be mid-statement), within
    ``LET_GO_S``. When it can't, the lease runs out (``LEASE_SECS``)."""
    async def free() -> None:
        async with asyncio.timeout(LET_GO_S):
            async with _own_session() as session:
                await view_membership_repo.update_mine(session, view_id, owner=owner, epoch=epoch,
                                                       lease_owner=None, lease_until=None)
                await session.commit()

    def done(task: "asyncio.Task") -> None:
        _letting_go.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.warning("live view %s: a turn cut off left its lease to run out: %s", view_id,
                           task.exception())

    task = asyncio.ensure_future(free())
    _letting_go.add(task)
    task.add_done_callback(done)


class _Run:
    """One request's turn at a run: its claim (``epoch``, the lease ``owner`` holds), how
    far the run has got (``progress``, kept in the state row's ``materialize``), and the
    definition it works out."""

    def __init__(self, session: AsyncSession, view_id: str, *, owner: str, epoch: int, progress: dict,
                 definition: MembershipDefinition, workspace_id: str, data_source_id: Optional[str],
                 actor: Optional[str] = None, manager: Any = None):
        self.session = session
        self.view_id = view_id
        self.owner = owner
        self.epoch = epoch
        self.progress = progress
        self.definition = definition
        self.workspace_id = workspace_id
        self.data_source_id = data_source_id
        self.actor = actor
        self.manager = manager
        self.found: Optional[Sets] = None
        #: Pages are started until ``deadline``; the answer is applied while ``apply_by`` has room.
        self.deadline = self.apply_by = 0.0
        #: The facts of the containers this turn has read.
        self.known: "OrderedDict[str, NodeFacts]" = OrderedDict()
        #: A ``source`` layout's view, when it is made from a query: placed by its rows.
        self.source_list: Optional[SourceList] = None

    async def release(self, **values: Any) -> None:
        await view_membership_repo.release(self.session, self.view_id, owner=self.owner, epoch=self.epoch,
                                           **values)
        await self.session.commit()

    async def _release_or_let_go(self, **values: Any) -> None:
        """``release``, from a handler of ``go``: cut off while it releases, the turn lets go
        at once all the same (outside ``go``'s own guard)."""
        try:
            await self.release(**values)
        except asyncio.CancelledError:
            _let_go(self.view_id, owner=self.owner, epoch=self.epoch)
            raise

    def detail(self, found: Sets) -> Dict[str, Any]:
        """How far the run has got, for whoever asks while it runs."""
        return run_detail(self.progress, found)

    async def renumber(self) -> None:
        """Start placing again at a new epoch: the pages so far answered a view that has
        changed since (their rows are let go; the sweeper deletes them)."""
        result = await self.session.execute(
            update(ViewMembershipStateORM)
            .where(ViewMembershipStateORM.view_id == self.view_id, ViewMembershipStateORM.epoch == self.epoch,
                   ViewMembershipStateORM.lease_owner == self.owner)
            .values(epoch=self.epoch + 1).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            await self.session.rollback()
            raise _Overtaken()
        self.epoch += 1
        self.progress["epoch"] = self.epoch
        if self.progress.get("placing"):
            self.progress["placing"] = _placing(self.progress["placing"]["members"])
        self.progress.pop("held", None)
        self.progress.pop("applying", None)
        try:
            await self._save()
        except asyncio.CancelledError:
            # Cut off saving the new epoch, which may never have landed: the claim at the one
            # before is let go of too (the turn lets go of the new one).
            _let_go(self.view_id, owner=self.owner, epoch=self.epoch - 1)
            raise

    async def _save(self) -> None:
        values: Dict[str, Any] = dict(materialize=dumps(self.progress), lease_until=later_iso(LEASE_SECS))
        if self.found is not None:
            values["status_detail"] = dumps(self.detail(self.found))
        if not await view_membership_repo.update_mine(self.session, self.view_id, owner=self.owner,
                                                      epoch=self.epoch, **values):
            await self.session.rollback()
            raise _Overtaken()
        await self.session.commit()

    async def _running(self, found: Sets) -> Outcome:
        """This turn is spent: the run is left for the next request to carry on."""
        await self.release(status="updating", status_detail=dumps(self.detail(found)),
                           materialize=dumps(self.progress))
        return Outcome("running", "updating", self.detail(found))

    async def go(self, engine_scope: EngineScope, *, deadline: float, apply_by: Optional[float] = None,
                 confirm_removals: bool = False, page_size: Optional[int] = None) -> Outcome:
        self.deadline = deadline
        self.apply_by = deadline if apply_by is None else apply_by
        try:
            async with engine_scope(self.workspace_id, self.data_source_id, self.actor) as engine:
                return await self._work(engine, confirm_removals=confirm_removals, page_size=page_size or PAGE)
        except asyncio.CancelledError:
            # Cut off — the request's tier, or its client gone: let go at once, so the next
            # request carries the run on rather than wait out the lease.
            _let_go(self.view_id, owner=self.owner, epoch=self.epoch)
            raise
        except _Overtaken:
            return Outcome("fenced", "updating")
        except PipelineError as exc:
            status = "source_missing" if exc.kind == "source_missing" else "failed"
            await self._release_or_let_go(status=status, status_detail=dumps({"reason": str(exc)}),
                                          last_error=str(exc)[:500], materialize=None)
            return Outcome(exc.kind, status, {"reason": str(exc)})
        except ProviderUnavailable:
            # Busy, failing over or down: nothing about this view. It keeps its members
            # and its run so far, is due again shortly, and it is not counted against it.
            # One with no members yet (a new view's first turn) is still filling in.
            await self.session.rollback()
            first = ViewMembershipStateORM.members_epoch.is_(None)
            await self._release_or_let_go(status=case((first, "updating"), else_="pending"),
                                          status_detail=dumps({"reason": "graph_busy"}))
            raise
        except Exception as exc:  # noqa: BLE001 — a failed run keeps the last good members
            logger.warning("live view %s: refresh failed: %s", self.view_id, exc, exc_info=True)
            await self.session.rollback()
            await self._release_or_let_go(status="failed", last_error=str(exc)[:500],
                                          attempts=ViewMembershipStateORM.attempts + 1)
            return Outcome("failed", "failed", {"reason": "The graph couldn't be read. Try again in a moment."})

    async def _work(self, engine: Any, *, confirm_removals: bool, page_size: int) -> Outcome:
        session, progress = self.session, self.progress
        data_version = progress.get("dataVersion") or await search_data_version(engine)
        found = self.found = await open_sets(
            session, engine, self.definition.sources, workspace_id=self.workspace_id,
            data_source_id=self.data_source_id, data_version=data_version, ids=progress.get("sets") or (),
            manager=self.manager, fresh=not progress.get("sets"))
        progress.update(sets=found.ids, dataVersion=data_version)
        if progress.get("placing") and not found.complete:
            await self.renumber()       # a set it was placing is no longer kept: resolve it again
            progress.pop("placing", None)
        if not progress.get("placing"):
            await advance(session, found, engine, owner=self.owner, deadline=self.deadline, manager=self.manager)
            if not found.complete:
                return await self._running(found)
            if found.retryable:
                await retire_short(session, found)
                await self.release(status="pending", status_detail=dumps(
                    {"reason": "short_answer", "truncated": found.retryable}), materialize=None)
                return Outcome("deferred", "pending", {"truncated": found.retryable})
            members = await member_count(session, found, self.definition.exclude)
            limit = entry_limit()
            if members > limit:
                detail = {"members": members, "keys": members, "limit": limit}
                await self.release(status="over_cap", status_detail=dumps(detail), materialize=None)
                return Outcome("over_cap", "over_cap", detail)
            progress["placing"] = _placing(members)
        copied_from = await source_config(session, self.definition, self.workspace_id)
        self.source_list = await source_list(session, self.definition, copied_from)
        admit = statement_admission(engine, self.manager)
        while True:
            read_at = now_iso()
            row = await _live_row(session, self.view_id)
            config = config_of(row) if row is not None else {}
            current = read_definition(config)
            if current is None or _changed(current, self.definition):
                frozen = current is not None and current.mode != "live"
                await self.release(status="frozen" if frozen else "pending", materialize=None)
                return Outcome("fenced", "frozen" if frozen else "pending")
            inputs = inputs_of(config, current, copied_from)
            await session.commit()
            placing = progress["placing"]
            if placing.get("digest") not in (None, inputs.digest):
                await self.renumber()
                placing = progress["placing"]
            placing["digest"] = inputs.digest
            if not await self._place(engine, found, inputs, size=page_size, admit=admit):
                return await self._running(found)
            if self.apply_by - time.monotonic() < APPLY_RESERVE_S:
                # Every page is placed, too late in the turn to apply them: the next turn's first step.
                return await self._running(found)
            outcome = await self._apply(found, inputs, read_at=read_at, confirm_removals=confirm_removals,
                                        copied_from=copied_from)
            if outcome is not None:
                return outcome
            await self.renumber()       # the view changed under the last page: place it again

    async def _place(self, engine: Any, found: Sets, inputs: Inputs, *, size: int, admit: Any) -> bool:
        """Place pages until every set's are (True) or the turn has no room for another
        (False): a page is started only while one as long as they have taken, and half
        again, still fits before the deadline."""
        placing = self.progress["placing"]
        state = await view_membership_repo.get(self.session, self.view_id)
        members_epoch = state.members_epoch if state is not None else None
        await self.session.commit()
        while placing["src"] < len(found.rows):
            started = time.monotonic()
            if started + 1.5 * float(placing.get("pageS") or 0.0) >= self.deadline:
                return False
            page = await read_page(self.session, engine, found, placing["src"], placing["after"], size=size,
                                   exclude=inputs.definition.exclude, view_id=self.view_id,
                                   members_epoch=members_epoch, facts=inputs.definition.layout.kind != "stages",
                                   admit=admit, known=self.known)
            source_placed = (await placed_in_source(self.session, engine, self.source_list,
                                                    [*(c.urn for c in page.members), *page.context], admit=admit)
                             if self.source_list is not None else None)
            placed, fallback = place(page, inputs, now=now_iso(), source_placed=source_placed)
            await view_members_repo.insert(self.session, _rows(self.view_id, self.epoch, page, placed, placing))
            placing["placed"] += len(placed)
            placing["fallback"] += fallback
            if page.read < size:
                placing["src"], placing["after"] = placing["src"] + 1, -1
            else:
                placing["after"] = page.last_seq
            took = time.monotonic() - started
            placing["pageS"] = took if not placing.get("pageS") else 0.7 * placing["pageS"] + 0.3 * took
            await self._save()
        return True

    async def _apply(self, found: Sets, inputs: Inputs, *, read_at: str, confirm_removals: bool,
                     copied_from: Optional[dict]) -> Optional[Outcome]:
        """Phase C, a step of its own: the answer measured holding nothing, and kept with
        the run (``applying``) — a turn out of time leaves the swap to the next — then
        swapped in (``_swap``). A large removal waits there to be confirmed. None: the view
        changed under the last page, so it is placed again."""
        applying = self.progress.get("applying")
        if applying is None:
            applying = await self._measure(inputs, since=self.progress["placing"].get("at") or "", at=read_at)
            if time.monotonic() >= self.apply_by:
                return await self._running(found)
        diff, old = applying["diff"], applying["old"]
        if (not confirm_removals and old is not None and diff["removed"] >= MASS_REMOVAL_MIN
                and diff["removed"] >= MASS_REMOVAL_RATIO * diff["before"]):
            # Its rows stay unswapped, kept with the run: confirming applies them as they are.
            held = {"removed": diff["removed"], "of": diff["before"], "added": diff["added"],
                    "sample": diff["removedSample"][:20], "at": now_iso()}
            self.progress["held"] = True
            await self.release(status="held", held=dumps(held), status_detail=dumps(held),
                               materialize=dumps(self.progress))
            return Outcome("held", "held", held)
        return await self._swap(found, applying, copied_from=copied_from)

    async def _measure(self, inputs: Inputs, *, since: str, at: str) -> dict:
        """Where people put members while the run placed them, then each layer's count and
        the change from the last answer — measured in SQL, no lock taken — kept with the
        run. ``at``: when the definition they were measured against was read; a move made
        since is placed as the answer is swapped in."""
        session = self.session
        await self._move(inputs, since)
        state = await view_membership_repo.get(session, self.view_id)
        old = state.members_epoch if state is not None else None
        applying = {"at": at, "old": old,
                    "perLayer": await view_members_repo.per_layer(session, self.view_id, self.epoch),
                    "diff": await view_members_repo.diff(session, self.view_id, old, self.epoch)}
        self.progress["applying"] = applying
        await self._save()
        return applying

    async def _move(self, inputs: Inputs, since: str) -> bool:
        """Place the members people put somewhere at ``since`` or after where they put
        them. True when any was."""
        moved = {u: o for u, o in inputs.overrides.items() if (o.get("at") or "") >= since}
        if not moved:
            return False
        known = await view_members_repo.placements(self.session, self.view_id, self.epoch, moved)
        ids = set(layouts.layer_ids(inputs.layers))
        moves = {u: {**known[u], **{k: v for k, v in o.items() if k in ("orderKey", "logicalNodeId")},
                     "layerId": o["layerId"] if o.get("layerId") in ids else known[u]["layerId"]}
                 for u, o in moved.items() if u in known}
        await view_members_repo.move(self.session, self.view_id, self.epoch, moves)
        return bool(moves)

    async def _swap(self, found: Sets, applying: dict, *, copied_from: Optional[dict]) -> Optional[Outcome]:
        """The view's row first, then its state — the order every layout write takes them
        in — locked only to check the run is still the view's and answers its definition,
        place what people moved since it was measured, and swap ``members_epoch`` in one
        commit."""
        session = self.session
        row = (await session.execute(
            select(ViewORM).where(ViewORM.id == self.view_id).with_for_update()
            .execution_options(populate_existing=True))).scalar_one_or_none()
        mine = await view_membership_repo.locked_if_mine(session, self.view_id, owner=self.owner, epoch=self.epoch)
        if mine is None:
            await session.commit()       # overtaken: a newer run holds the view now
            return Outcome("fenced", "updating")
        live = row is not None and row.deleted_at is None and row.draft_branch_id is None
        config = config_of(row) if live else {}
        current = read_definition(config)
        if current is None or _changed(current, self.definition):
            # The view went, or what it is made of changed while this run worked: what it
            # found answers a question nobody is asking any more.
            frozen = current is not None and current.mode != "live"
            await self.release(status="frozen" if frozen else "pending", materialize=None)
            return Outcome("fenced", "frozen" if frozen else "pending")
        inputs = inputs_of(config, current, copied_from)
        placing = self.progress["placing"]
        if inputs.digest != placing.get("digest"):
            await session.commit()
            return None
        per_layer: Dict[str, int] = dict(applying["perLayer"])
        if await self._move(inputs, applying["at"]):
            per_layer = await view_members_repo.per_layer(session, self.view_id, self.epoch)
        members = sum(per_layer.values())
        for entry in inputs.user.values():
            if isinstance(entry.get("layerId"), str):
                per_layer[entry["layerId"]] = per_layer.get(entry["layerId"], 0) + 1
        diff = applying["diff"]
        status = "frozen" if current.mode != "live" else "partial" if found.truncated() else "ok"
        changed = bool(diff["added"] or diff["removed"] or diff["moved"] or diff["touched"])
        values = applied_values(current, found, members=members, included=len(inputs.user), per_layer=per_layer,
                                fallback=placing["fallback"], status=status,
                                answered=answered(current, copied_from))
        public = {k: diff[k] for k in ("added", "removed", "moved", "addedSample", "removedSample")}
        now = now_iso()
        if changed:
            await session.execute(
                update(ViewORM).where(ViewORM.id == self.view_id)
                # updated_at assigned to itself, so its onupdate does not fire: the data
                # moving is not someone editing the view (as versioning's data stamp).
                .values(data_updated_at=now, data_updated_by=self.actor, updated_at=ViewORM.updated_at)
                .execution_options(synchronize_session=False)
            )
            values.update(members_epoch=self.epoch, revision=ViewMembershipStateORM.revision + 1,
                          last_diff=dumps({**public, "at": now}))
        elif applying["old"] is None:
            # A first answer holding nothing is an answer all the same: a snapshot has its one.
            values.update(members_epoch=self.epoch)
        # Readers have the new epoch (or kept the old): the sweeper deletes the other.
        await self.release(materialize=None, **values)
        return Outcome("applied" if changed else "unchanged", status, diff=public)


def _placing(members: int) -> dict:
    """Where placing starts: the first set's first row, nothing numbered yet."""
    return {"src": 0, "after": -1, "ord": 0, "labels": {}, "placed": 0, "fallback": 0, "members": members,
            "at": now_iso(), "digest": None}


def _changed(current: MembershipDefinition, resolved: MembershipDefinition) -> bool:
    return (current.mode != resolved.mode or current.resolution_hash() != resolved.resolution_hash()
            or current.layout != resolved.layout)
