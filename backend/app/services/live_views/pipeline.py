"""Resolve, plan and apply: the one path that writes a view made from a query's members.

Saving a view, *Refresh now*, a definition change and (later) the background
refresher all go through here, in three phases so that no database transaction is
held across a graph call:

1. **SQL, short** — read the view, its definition and the views its queries are
   read in; claim the view (``epoch + 1``, a lease).
2. **Graph, no locks** — resolve each source through the shared cache
   (``view_membership.resolve_cached``: one walk per question, shared with every
   narrowing that asks the same), and read the facts placing needs.
3. **SQL, short, fenced** — lock the view, check the claim is still ours and the
   definition still the one resolved, plan against the view *as it is now* (its
   current layers, people's entries and moves), and write the server's entries
   with a Core UPDATE that stamps ``data_updated_at`` and leaves ``updated_at``
   alone: an update is the data moving, not someone editing the view.

A short answer (out of time, or part of the graph not answering) is never
applied — the view keeps its last good members, and says so. Over the limit,
likewise. A large removal waits to be confirmed.
"""
from __future__ import annotations

import json
import logging
import uuid
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from backend.app.db.models import ViewMembershipStateORM, ViewORM, view_is_live
from backend.app.db.repositories import data_source_repo, view_membership_repo
from backend.app.db.repositories.view_membership_repo import dumps, now_iso
from backend.app.services.graph_cache import get_graph_cache
from backend.app.services.graph_reads import cache_scope, search_data_version, statement_admission
from backend.app.services.layout_config import parse_reference_layout
from backend.app.services.live_views import layouts
from backend.app.services.live_views.plan import (
    Candidate,
    Plan,
    Placer,
    auto_placer,
    candidates,
    fact_urns,
    plan,
    rules_placer,
    source_placer,
    stage_placer,
    top_type_counts,
)
from backend.app.services.view_membership import resolve_cached
from backend.app.services.view_membership_search import make_seed_search, seed_query_for
from backend.app.services.view_placement import NodeFacts, facts_from_graph_node
from backend.common.adapters import ProviderUnavailable
from backend.common.models.graph import NodeQuery
from backend.common.models.view_membership import (
    MACHINE,
    RETRYABLE,
    MembershipDefinition,
    MembershipLayout,
    MembershipPlan,
    MembershipResult,
    MembershipSource,
    PlanLayer,
    read_definition,
)

logger = logging.getLogger(__name__)

#: People's entries + the server's; past it the view stays as it was, and says so.
DEFAULT_ENTRY_LIMIT = 5000
#: A removal at least this large (share of the server's entries, and count) waits to be confirmed.
MASS_REMOVAL_RATIO = 0.5
MASS_REMOVAL_MIN = 50
#: Lease on a view while one run works it out.
LEASE_SECS = 300.0
#: How long a caller is asked to wait when the graph was too busy to answer.
RETRY_SECS = 30.0
FACT_BATCH = 1000

#: An engine for one data source — ``(workspace_id, data_source_id, actor)`` — opened
#: around the graph phase and closed after it: the caller decides which pool and which
#: admission it goes through.
EngineScope = Callable[[str, Optional[str], Optional[str]], AbstractAsyncContextManager]


def entry_limit() -> int:
    """At most this many entries: what a search inside the view can take as its roots."""
    try:
        from backend.app.services.deep_search.settings import get_deep_search_settings

        return min(DEFAULT_ENTRY_LIMIT, get_deep_search_settings().scope_root_urns_cap)
    except Exception:  # noqa: BLE001 — the settings are environment; the limit is not optional
        return DEFAULT_ENTRY_LIMIT


class PipelineError(Exception):
    """Why a view could not be worked out, in words. ``kind`` is the status it
    leaves (``source_missing``, ``frozen``) or how a route answers (``invalid``,
    ``not_found``)."""

    def __init__(self, kind: str, message: str, **detail: Any):
        super().__init__(message)
        self.kind = kind
        self.detail = detail


# ── Graph phase ──────────────────────────────────────────────────────────────

@dataclass
class Resolved:
    results: List[Tuple[MembershipSource, MembershipResult]]
    data_version: str
    facts: Dict[str, NodeFacts] = field(default_factory=dict)

    @property
    def retryable(self) -> List[str]:
        """Limits that say the answer is short of the truth, not just bounded."""
        return sorted({t.reason for _, r in self.results for t in r.truncated if t.reason in RETRYABLE})

    def truncated(self) -> List[dict]:
        seen: Dict[str, dict] = {}
        for _, r in self.results:
            for t in r.truncated:
                seen.setdefault(t.reason, t.model_dump(by_alias=True))
        return list(seen.values())

    def missing_seeds(self) -> int:
        return sum(r.missing_seeds for _, r in self.results)


def _search_refusals(search):
    """A query the search refuses (a predicate this server cannot run) is the
    definition's fault, said in words — not a failure to retry."""
    from backend.app.services.advanced_search_service import ValidationError

    async def run(predicate):
        try:
            return await search(predicate)
        except ValidationError as exc:
            raise PipelineError("invalid", "The query can't be run as it is.", reason=str(exc)) from exc

    return run


async def resolve_sources(
    engine: Any,
    sources: Sequence[MembershipSource],
    *,
    workspace_id: str,
    data_source_id: Optional[str],
    budget_s: float,
    can_read_view: Any = None,
    manager: Any = None,
) -> Resolved:
    """Each source, resolved through the shared cache. A query source runs the search
    panel's own search, in the view it is read in. ``can_read_view`` holds that view
    to a caller; None reads as the system (a refresh: the view was checked when the
    definition was written, and only its existence since)."""
    from backend.app.services.advanced_search_service import AdvancedSearchService, ValidationError

    admit = statement_admission(engine, manager)
    data_version = await search_data_version(engine)
    scope = cache_scope(engine)
    results: List[Tuple[MembershipSource, MembershipResult]] = []
    for source in sources:
        search, boundary = None, ""
        if source.spec.seeds.query is not None:
            svc = AdvancedSearchService(
                engine, session=getattr(engine, "_db_session", None), workspace_id=workspace_id,
                data_source_id=data_source_id, can_read_view=can_read_view,
            )
            query = seed_query_for(source.spec, source.read_in)
            try:
                boundary = (await svc.resolve_scope(query.scope)).scope_hash
            except ValidationError as exc:
                raise PipelineError("source_missing", "The view its query is searched in can't be read.",
                                    reason=str(exc)) from exc
            search = _search_refusals(make_seed_search(svc, query, data_version=data_version, admit=admit))
        result = await resolve_cached(
            engine, source.spec, scope=scope, cache=get_graph_cache(), read_in=source.read_in,
            boundary=boundary, search=search, admit=admit, budget_s=budget_s,
            include_members=True, data_version=data_version,
        )
        results.append((source, result))
    return Resolved(results=results, data_version=data_version)


async def read_facts(engine: Any, urns: Sequence[str], *, manager: Any = None) -> Dict[str, NodeFacts]:
    """What placing reads about each entity: type, name, tags, properties."""
    admit = statement_admission(engine, manager)
    facts: Dict[str, NodeFacts] = {}
    for i in range(0, len(urns), FACT_BATCH):
        batch = list(urns[i:i + FACT_BATCH])
        query = NodeQuery(urns=batch, limit=len(batch), include_child_count=False)
        if admit is None:
            nodes = await engine.get_nodes_query(query)
        else:
            async with admit():
                nodes = await engine.get_nodes_query(query)
        for node in nodes:
            facts[node.urn] = facts_from_graph_node(node)
    return facts


async def gather(
    engine: Any,
    sources: Sequence[MembershipSource],
    layout: MembershipLayout,
    exclude: Sequence[str],
    *,
    workspace_id: str,
    data_source_id: Optional[str],
    budget_s: float,
    limit: int,
    can_read_view: Any = None,
    manager: Any = None,
) -> Resolved:
    """Resolve the sources, then read the facts placing them needs — for every
    candidate, kept out or not, so an entity brought back while this run works is
    placed by its facts too. Nothing more is read when the answer is short (it will
    not be used) or holds more members than a view can (it is over the limit
    whatever placing does)."""
    resolved = await resolve_sources(
        engine, sources, workspace_id=workspace_id, data_source_id=data_source_id,
        budget_s=budget_s, can_read_view=can_read_view, manager=manager,
    )
    if resolved.retryable or layout.kind == "stages":
        return resolved
    every = candidates(resolved.results, nest=layout.nest, exclude=())
    left_out = set(exclude)
    if sum(1 for c in every.values() if c.member and c.urn not in left_out) > limit:
        return resolved
    resolved.facts = await read_facts(engine, fact_urns(every), manager=manager)
    return resolved


# ── Planning ─────────────────────────────────────────────────────────────────

def make_placer(
    definition: MembershipDefinition, *, layers: List[dict], source_config: Optional[dict],
    facts: Dict[str, NodeFacts],
) -> Placer:
    kind = definition.layout.kind
    if kind == "stages":
        return stage_placer()
    if kind == "auto":
        return auto_placer(layouts.type_layer_map(layers), facts)
    if kind == "source" and source_config is not None:
        return source_placer(source_config, layouts.link_map(layers), facts)
    # template / custom — and a source view that is gone: this view's own layer rules.
    return rules_placer(layers, facts)


def plan_definition(
    definition: MembershipDefinition,
    resolved: Resolved,
    *,
    layers: List[dict],
    assignments: Dict[str, dict],
    source_config: Optional[dict],
    limit: int,
) -> Tuple[Dict[str, Candidate], Plan]:
    cands = candidates(resolved.results, nest=definition.layout.nest, exclude=definition.exclude)
    placer = make_placer(definition, layers=layers, source_config=source_config, facts=resolved.facts)
    overrides = {u: o.model_dump(by_alias=True, exclude_none=True) for u, o in definition.overrides.items()}
    out = plan(
        cands, assignments=assignments, layer_ids=layouts.layer_ids(layers), overrides=overrides,
        placer=placer, fallback_layer_id=definition.layout.fallback_layer_id, limit=limit,
        restage=definition.layout.kind == "stages", now=now_iso(),
    )
    return cands, out


def initial_layers(
    definition: MembershipDefinition,
    resolved: Resolved,
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
    if kind == "stages":
        return layouts.stage_layers(definition.sources[0].spec.expand), []
    if kind == "auto":
        cands = candidates(resolved.results, nest=definition.layout.nest, exclude=definition.exclude)
        layers = layouts.auto_layers(top_type_counts(cands, resolved.facts))
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
class Draft:
    """A new view, worked out: the layers it keeps, every layer it was offered (for
    a preview), its entries and what it holds."""
    layers: List[dict]
    all_layers: List[dict]
    display_rules: List[dict]
    definition: MembershipDefinition
    plan: Plan
    resolved: Resolved


def draft_view(
    definition: MembershipDefinition,
    resolved: Resolved,
    *,
    source_config: Optional[dict],
    client_layers: Optional[List[dict]],
    keep: str,
    limit: int,
) -> Draft:
    """The layers and entries a view made from these sources would start with."""
    layers, display_rules = initial_layers(definition, resolved, source_config=source_config,
                                           client_layers=client_layers)
    _, out = plan_definition(definition, resolved, layers=layers, assignments={},
                             source_config=source_config, limit=limit)
    if out.fallback and definition.layout.kind not in ("template", "custom"):
        # Members nothing places get a layer of their own, rather than crowd the first.
        other = layouts.fallback_layer(layers)
        layers = [*layers, other]
        definition = definition.model_copy(update={
            "layout": definition.layout.model_copy(update={"fallback_layer_id": other["id"]})})
        _, out = plan_definition(definition, resolved, layers=layers, assignments={},
                                 source_config=source_config, limit=limit)
    offered = layers
    if keep == "withResults" and definition.layout.kind not in ("template", "custom"):
        # The layers someone chose themselves stay; the ones copied or made for them
        # are kept only when they hold something.
        held = [layer for layer in layers if out.per_layer.get(layer["id"])]
        layers = held or layers[:1]
    return Draft(layers=layers, all_layers=offered, display_rules=display_rules, definition=definition,
                 plan=out, resolved=resolved)


def plan_answer(draft: Draft) -> MembershipPlan:
    """A draft, as the preview shows it: what the view would hold against the
    limit, and each layer offered with its count and whether it is kept."""
    p = draft.plan
    kept = set(layouts.layer_ids(draft.layers))
    return MembershipPlan(
        keys=p.keys, members=p.members, containers=p.containers, included=p.included, limit=p.limit,
        over_cap=p.over_cap,
        layers=[
            PlanLayer(id=layer["id"], name=str(layer.get("name") or ""), color=layer.get("color"),
                      count=p.per_layer.get(layer["id"], 0), link_layer_id=layer.get("linkLayerId"),
                      kept=layer["id"] in kept)
            for layer in draft.all_layers
        ],
        fallback=p.fallback, truncated=draft.resolved.truncated(),
        missing_seeds=draft.resolved.missing_seeds(), data_version=draft.resolved.data_version,
    )


def view_config(draft: Draft, *, icon: Optional[str] = None) -> dict:
    """The new view's config — shaped as the wizard shapes one (so every screen
    treats it as any other view): a curated reference view, its definition beside it."""
    layout: Dict[str, Any] = {"layers": draft.layers, "assignments": draft.plan.assignments}
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


def applied_values(p: Plan, resolved: Resolved, definition: MembershipDefinition, *,
                   status: str) -> Dict[str, Any]:
    """The state row's record of an applied answer."""
    now = now_iso()
    values: Dict[str, Any] = dict(
        status=status,
        status_detail=None,
        resolution_hash=definition.resolution_hash(),
        applied_resolution_hash=definition.resolution_hash(),
        data_version=resolved.data_version,
        member_count=p.members,
        key_count=p.keys,
        counts=dumps({"members": p.members, "containers": p.containers, "included": p.included,
                      "fallback": p.fallback, "missingSeeds": resolved.missing_seeds(),
                      "perLayer": p.per_layer}),
        truncated=dumps(resolved.truncated()),
        last_applied_at=now,
        last_error=None,
        attempts=0,
        held=None,
    )
    if p.changed:
        values["last_diff"] = dumps({**p.diff(), "at": now})
    return values


# ── Refresh ──────────────────────────────────────────────────────────────────

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
    """The config of the view a ``source`` layout copies placements from, while it exists."""
    sid = definition.layout.source_view_id
    if definition.layout.kind != "source" or not sid:
        return None
    source = (await session.execute(select(ViewORM).where(ViewORM.id == sid, view_is_live()))).scalar_one_or_none()
    if source is None or source.workspace_id != workspace_id:
        return None
    return config_of(source)


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


@dataclass
class Outcome:
    """What one refresh did — ``applied``, ``unchanged``, ``held`` (a large removal
    waits to be confirmed), ``over_cap``, ``deferred`` (a short answer: the last good
    members kept), ``busy`` (another run holds the view), ``fenced`` (overtaken),
    ``source_missing`` or ``failed`` — the status it left, and the record of it."""
    outcome: str
    status: str
    detail: Dict[str, Any] = field(default_factory=dict)
    diff: Optional[dict] = None


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
) -> Outcome:
    """Work out a view's members again and apply them — see the module docstring.
    ``session`` serves the two short SQL phases and is committed after each.

    ``only_if_changed`` (the view being opened): nothing is worked out unless the
    data or what the view is made of changed since it last was, and a held removal
    stays held — told from its state and the data's version, before anything is
    claimed (a claim shows the view as updating to everyone looking at it).

    Raises ``PipelineError`` for a view that is not one to refresh, and lets
    ``ProviderUnavailable`` (busy, failing over, down) through once the view is
    released and due again — the caller answers it with a Retry-After."""
    # ── Phase A ──
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view_id, view_is_live()))).scalar_one_or_none()
    if row is None:
        raise PipelineError("not_found", "This view can't be found.")
    definition = read_definition(config_of(row))
    if definition is None:
        raise PipelineError("invalid", "This view isn't made from a query.")
    if definition.mode != "live":
        raise PipelineError("frozen", "This view is a snapshot: its members stay as they are until "
                                      "updates are resumed.")
    state = await view_membership_repo.ensure(session, row)
    if not await _read_in_available(session, definition, row):
        state.status = "source_missing"
        state.status_detail = dumps({"reason": "read_in_missing"})
        await session.commit()
        return Outcome("source_missing", "source_missing")
    workspace_id, data_source_id = row.workspace_id, row.data_source_id
    if only_if_changed:
        if state.status == "held":
            return Outcome("current", "held", {"reason": "held"})
        if (state.status in ("ok", "partial") and state.data_version
                and state.applied_resolution_hash == definition.resolution_hash()):
            async with engine_scope(workspace_id, data_source_id, actor) as engine:
                version = await search_data_version(engine)
            if version and version == state.data_version:
                return Outcome("current", state.status, {"reason": "up_to_date"})
    copied_from = await source_config(session, definition, workspace_id)
    epoch = await view_membership_repo.claim(session, view_id, owner=owner, lease_s=LEASE_SECS)
    await session.commit()
    if epoch is None:
        return Outcome("busy", "updating")
    limit = entry_limit()

    async def release(**values: Any) -> None:
        await view_membership_repo.release(session, view_id, owner=owner, epoch=epoch, **values)
        await session.commit()

    # ── Phase B ──
    try:
        async with engine_scope(workspace_id, data_source_id, actor) as engine:
            resolved = await gather(
                engine, definition.sources, definition.layout, definition.exclude,
                workspace_id=workspace_id, data_source_id=data_source_id, budget_s=budget_s,
                limit=limit, manager=manager,
            )
    except PipelineError as exc:
        status = "source_missing" if exc.kind == "source_missing" else "failed"
        await release(status=status, status_detail=dumps({"reason": str(exc)}), last_error=str(exc)[:500])
        return Outcome(exc.kind, status, {"reason": str(exc)})
    except ProviderUnavailable:
        # Busy, failing over or down: nothing about this view. It keeps its members
        # and is due again shortly; not counted against it.
        await release(status="pending", status_detail=dumps({"reason": "graph_busy"}))
        raise
    except Exception as exc:  # noqa: BLE001 — a failed run keeps the last good members
        logger.warning("live view %s: refresh failed: %s", view_id, exc, exc_info=True)
        await release(status="failed", last_error=str(exc)[:500], attempts=ViewMembershipStateORM.attempts + 1)
        return Outcome("failed", "failed", {"reason": "The graph couldn't be read. Try again in a moment."})

    if resolved.retryable:
        await release(status="pending",
                      status_detail=dumps({"reason": "short_answer", "truncated": resolved.retryable}))
        return Outcome("deferred", "pending", {"truncated": resolved.retryable})

    # ── Phase C ── the view's row first, then its state: the order every layout write takes them in.
    row = (await session.execute(
        select(ViewORM).where(ViewORM.id == view_id).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    mine = await view_membership_repo.locked_if_mine(session, view_id, owner=owner, epoch=epoch)
    if mine is None:
        await session.commit()       # overtaken: a newer run holds the view now
        return Outcome("fenced", "updating")
    live = row is not None and row.deleted_at is None and row.draft_branch_id is None
    config = config_of(row) if live else {}
    current = read_definition(config)
    if (current is None or current.mode != "live" or current.resolution_hash() != definition.resolution_hash()
            or current.layout != definition.layout):
        # The view went, or what it is made of changed while this run read the graph:
        # what was read answers a question nobody is asking any more.
        frozen = current is not None and current.mode != "live"
        await release(status="frozen" if frozen else "pending")
        return Outcome("fenced", "frozen" if frozen else "pending")

    layers, assignments = layout_of(config)
    _, out = plan_definition(current, resolved, layers=layers, assignments=assignments,
                             source_config=copied_from, limit=limit)
    if out.over_cap:
        detail = {"keys": out.keys, "limit": out.limit, "members": out.members, "containers": out.containers}
        await release(status="over_cap", status_detail=dumps(detail))
        return Outcome("over_cap", "over_cap", detail)
    machine_before = sum(1 for e in assignments.values() if e.get("assignedBy") == MACHINE)
    if (not confirm_removals and len(out.removed) >= MASS_REMOVAL_MIN
            and len(out.removed) >= MASS_REMOVAL_RATIO * machine_before):
        held = {"removed": len(out.removed), "of": machine_before, "added": len(out.added),
                "sample": out.removed[:20], "at": now_iso()}
        await release(status="held", held=dumps(held), status_detail=dumps(held))
        return Outcome("held", "held", held)

    status = "partial" if resolved.truncated() else "ok"
    if out.changed:
        ref = config.setdefault("layout", {}).setdefault("referenceLayout", {})
        ref["assignments"] = out.assignments
        config.setdefault("content", {})["entityScope"] = "curated"
        text = json.dumps(config)
        await session.execute(
            update(ViewORM).where(ViewORM.id == view_id)
            # updated_at assigned to itself, so its onupdate does not fire: the data
            # moving is not someone editing the view (as versioning's data stamp).
            .values(config=text, data_updated_at=now_iso(), data_updated_by=actor,
                    updated_at=ViewORM.updated_at)
            .execution_options(synchronize_session=False)
        )
        set_committed_value(row, "config", text)
    values = applied_values(out, resolved, current, status=status)
    values["revision"] = ViewMembershipStateORM.revision + (1 if out.changed else 0)
    await release(**values)
    return Outcome("applied" if out.changed else "unchanged", status, diff=out.diff())
