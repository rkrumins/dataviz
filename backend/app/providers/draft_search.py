"""A draft's rule counts, rule membership and property catalog — as the draft holds the graph.

A draft is main ⊕ a sparse patch set (``draft_overlay_provider``), and main's deep-search answers
come from main's store, which knows nothing of the patch set. Rather than search the draft's
whole state, each answer here is main's, corrected entity by entity for what the draft changed
— the set ``D`` its patch set names (nodes it created, changed or removed, and those main
changed since the draft branched, which the draft reads as they were):

    draft answer = main's answer − main's answer for D + the draft's answer for D

Main's answer for ``D`` is asked of main's own provider (its membership statement, its node
reads), so it agrees with main's answer exactly — the scope, raw properties and all. The
draft's is evaluated in Python on the values the draft holds (``common.predicate_eval``, the
FalkorDB compiler's meaning, as the stub provider answers with it).

* **membership** (≤ 1,000 urns): main's answer, with the urns in ``D`` answered on the draft —
  a removed entity matches nothing, a created one gets its chips.
* **counts**: main's count session (keyed by main's version, so shared with main and kept across
  the draft's commits) plus the correction, read ``BATCH`` entities of ``D`` a step, in a session
  of its own that any request continues. A draft's next commit folds in only what that commit
  wrote — the draft's values before and after it — never ``D`` again.
* **catalog**: main's catalog with each entity of ``D`` taken out as main holds it and put back
  as the draft does (``CatalogStats.add_entity`` / ``folded``). A range can't be narrowed without
  reading again: where the draft took out a value at either end, the range is marked not exact.

A predicate the Python evaluator can't answer for one entity alone — one that follows
relationships, tests the view's layers, reads a field only the platform keeps, or names an entity
the draft changed — keeps main's answer, flagged (``approximate``, a note). Any failure in the
correction does the same: main's answer, said to be main's, never a 500 or a wrong number. So does
a draft too large to read whole: a correction that would read more than ``DRAFT_SEARCH_MAX_DELTA``
entities of ``D`` afresh answers with main's counts and catalog (``TOO_LARGE``, ``TOO_LARGE_CATALOG``); a fold of a later
commit reads only what it wrote, and stays exact at any size.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Mapping, Optional, Sequence, Set, Tuple

from backend.app.providers.falkordb_search.catalog import (
    CatalogStats,
    _skipped_keys,
    answer_of,
)
from backend.app.providers.falkordb_search.session import (
    COMPLETE,
    RUNNING,
    Session,
    SessionStore,
    store_for,
)
from backend.app.services.deep_search import CompileError, SearchRunContext
from backend.app.services.versioning import config as vconfig
from backend.common.interfaces.provider import resolve_identities_by_query
from backend.common.models.graph import GraphNode, NodeQuery
from backend.common.models.search import MatchAllPredicate
from backend.common.predicate_eval import NODE_FIELDS, matches

logger = logging.getLogger(__name__)

#: Entities of ``D`` one step reads: one membership statement's worth, one page of payloads.
BATCH = 1000

#: How long a correction is kept, unused.
_TTL_S = 3600

#: Steps a request runs between saves of its correction: it is saved too when its wait is spent,
#: and when it completes.
SAVE_EVERY = 10

#: The membership column that says an entity is inside the scope at all.
_SCOPE = "__draft_scope__"

# What a rule or a catalog says when part of it is main's. Product copy: no internals.
RELATIONSHIPS = ("This rule follows relationships, so for the entities your draft changed it "
                 "shows the published graph's answer.")
LAYERS = ("This rule tests the view's layers, so for the entities your draft changed it shows "
          "the published graph's answer.")
PLATFORM_FIELD = ("This rule reads a field the platform keeps, so for the entities your draft "
                  "changed it shows the published graph's answer.")
NAMES_CHANGED = ("This rule names an entity your draft changes, so for the entities your draft "
                 "changed it shows the published graph's answer.")
NOT_DRAFT_AWARE = ("Your draft's changes couldn't be counted just now, so this shows the "
                   "published graph — it will catch up.")
CATALOG_NOT_DRAFT_AWARE = ("Your draft's changes couldn't be read into this catalog just now, so "
                           "it shows the published graph.")
CATALOG_RANGES = ("Your draft changed values at the ends of some ranges: their least and greatest "
                  "values still bound every value, but may be wider than they are.")
MEMBERSHIP_MAINS = ("{n} of your rules can't be answered on your draft's values alone — they "
                    "follow relationships, test the view's layers or name what the draft changes: "
                    "for what your draft changed, their chips show the published graph's answer.")
MEMBERSHIP_NOT_DRAFT_AWARE = ("Your draft's changes couldn't be read just now, so the chips show "
                              "the published graph — they will catch up.")
TOO_LARGE = "Your draft changed more than {n:,} entities, so these counts show the published graph."
TOO_LARGE_CATALOG = ("Your draft changed more than {n:,} entities, so these properties and values show "
                     "the published graph.")

#: A rule kind whose answer for an entity depends on other entities or on the view.
_RELATIONAL = frozenset({"related", "degree", "isOrphan", "isLeaf", "isRoot", "hasIncoming",
                         "hasOutgoing", "withinHops", "path", "edges"})


def _platform_only() -> FrozenSet[str]:
    """What FalkorDB keeps on a node that the draft's values don't say."""
    from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS
    return frozenset(_RESERVED_NODE_KEYS) - NODE_FIELDS


def inexact(predicate, changed: Set[str], named: FrozenSet[str] = frozenset()) -> Optional[str]:
    """Why ``predicate`` can't be answered on the draft's values entity by entity — the note to
    show — or None when it can. ``changed``: the draft's ``D``; ``named``: the urns the rule's
    name references resolved to, on the published graph."""
    if named & changed:
        return NAMES_CHANGED
    platform = _platform_only()

    def why(p) -> Optional[str]:
        kind = p.kind
        if kind == "group":
            return next((w for w in (why(c) for c in p.children) if w), None)
        if kind in _RELATIONAL:
            return RELATIONSHIPS
        if kind == "layer" and getattr(p, "_placement", None) is not None:
            return LAYERS
        if kind == "text" and p.target == "property":
            keys = {p.property_key}
        elif kind == "property":
            keys = {p.key, p.value_key}
        elif kind == "hasProperty" and p.key_match == "exact":
            keys = {p.key}
        else:
            keys = set()
        return PLATFORM_FIELD if keys & platform else None

    return why(predicate)


def node_dict(node: GraphNode) -> Dict[str, Any]:
    """The draft's value of a node as FalkorDB would hold it once projected
    (``projection._node_item``): its user properties under their own keys — native or raw, a
    raw-aware search reads both — beside its own fields, its tags a list."""
    from backend.app.providers.falkordb_provider import (
        _RESERVED_NODE_KEYS, _compute_searchable_text, _sanitize_label, _text_properties,
    )
    props = node.properties or {}
    out = {k: v for k, v in props.items() if k not in _RESERVED_NODE_KEYS and v is not None}
    dn, qn, desc = node.display_name or "", node.qualified_name or "", node.description or ""
    tags = list(node.tags or [])
    out.update({
        "urn": node.urn, "entityType": _sanitize_label(node.entity_type or "Entity"),
        "displayName": dn, "qualifiedName": qn, "description": desc, "tags": tags,
        "layerAssignment": node.layer_assignment or "",
        "searchableText": _compute_searchable_text(dn, qn, desc, _text_properties(props),
                                                   tags=tags),
    })
    return out


def _label(entity_type: Optional[str]) -> str:
    from backend.app.providers.falkordb_provider import _sanitize_label
    return _sanitize_label(entity_type or "Entity")


class _Chains:
    """What ``predicate_eval`` asks of a graph to answer ``descendantOf``: a node's ancestors,
    on the draft."""

    def __init__(self, chains: Mapping[str, List[str]]):
        self._held = chains

    def _ancestors(self, node: Dict[str, Any]) -> List[str]:
        return list(self._held.get(node.get("urn"), ()))


def _uses_containment(predicate) -> bool:
    if predicate.kind == "group":
        return any(_uses_containment(c) for c in predicate.children)
    return predicate.kind == "descendantOf"


def changed_set(d) -> Set[str]:
    """``D``: every node urn the patch set names — kept with the patch set."""
    held = d.shared.get("draft-search:changed")
    if held is None:
        held = d.shared["draft-search:changed"] = (
            set(d.node_modified) | set(d.node_upsert) | set(d.node_remove))
    return held


def _changed_order(d) -> List[str]:
    """``D`` in one order, so a step's place in it means the same to every request."""
    held = d.shared.get("draft-search:order")
    if held is None:
        held = d.shared["draft-search:order"] = sorted(changed_set(d))
    return held


def _urn_of_id(d) -> Optional[Dict[str, str]]:
    """Entity id → urn over ``D``, or None when part of the patch set carries no ids."""
    if "draft-search:ids" not in d.shared:
        ids: Optional[Dict[str, str]] = None
        if not any(u not in d.node_modified for u in d.node_upsert) and all(
                d.node_remove_ids.get(u) for u in d.node_remove):
            ids = {eid: urn for urn, eid in d.node_modified.items()}
            ids.update({eid: urn for urn, eid in d.node_remove_ids.items()})
        d.shared["draft-search:ids"] = ids
    return d.shared["draft-search:ids"]


@dataclass
class _State:
    """One entity as one side of a step holds it: counted ``sign`` (+1 now, -1 as it was before
    the commits a step folds in), at ``urn``, with the draft's value (None: not a live node)."""
    sign: int
    urn: str
    node: Optional[GraphNode]


@dataclass
class _Read:
    """What a step read of main for its urns, and of the draft."""
    main_in: Set[str] = field(default_factory=set)            # in the scope, on main
    main_hits: Dict[str, Set[str]] = field(default_factory=dict)
    main_errors: Dict[str, str] = field(default_factory=dict)
    main_types: Dict[str, Optional[str]] = field(default_factory=dict)  # None: not on main
    main_nodes: Dict[str, GraphNode] = field(default_factory=dict)
    chains: Dict[str, List[str]] = field(default_factory=dict)  # on the draft
    moved: Set[str] = field(default_factory=set)
    held: Optional[Set[str]] = None


class DraftSearch:
    """The draft's answers for one request: ``overlay`` (a ``DraftOverlayProvider``), its patch
    set ``d``, the request's ``context`` and ``main`` — the same, keyed by main's version."""

    def __init__(self, overlay, d, context: SearchRunContext, main: SearchRunContext,
                 changed: Set[str]):
        self.overlay, self.d, self.ctx, self.main_ctx = overlay, d, context, main
        self.base = overlay._base
        self.store: SessionStore = store_for(self.base)
        self.changed = changed
        self._sets: Dict[int, Tuple[Set[str], Optional[Set[str]]]] = {}

    def _scope_sets(self, scope) -> Tuple[Set[str], Optional[Set[str]]]:
        """The scope's roots and, in ``visible`` mode, what is on the canvas — as sets, once."""
        held = self._sets.get(id(scope))
        if held is None:
            visible = (set(scope.visible_urns)
                       if scope.scope_mode == "visible" and scope.visible_urns else None)
            held = self._sets[id(scope)] = (_roots(scope), visible)
        return held

    @classmethod
    async def of(cls, overlay, d, context: SearchRunContext, main: SearchRunContext
                 ) -> "DraftSearch":
        # ``D`` of a large draft is a million urns to gather: once per patch set, off the loop.
        return cls(overlay, d, context, main, await asyncio.to_thread(changed_set, d))

    # ---- reads -------------------------------------------------------- #
    async def _admitted(self, call):
        admit = self.ctx.admit
        if admit is None:
            return await call()
        async with admit():
            return await call()

    async def _read(self, scope, rules: Sequence[Tuple[str, Any]], states: Sequence[_State], *,
                    nodes: bool = False, membership: Optional[Dict[str, Any]] = None) -> _Read:
        """Main's side of ``states`` — which are in the scope and which rule each matches, as
        main answers (``membership``: that answer, when the caller has it) — and what the draft's
        side needs: main's types (or, ``nodes``, main's nodes), where each sits on the draft."""
        urns = sorted({s.urn for s in states})
        read = _Read()
        if membership is None:
            membership = await self.base.deep_search_membership(
                scope, [*rules, (_SCOPE, MatchAllPredicate())], urns, context=self.main_ctx)
        found = membership.get("matches") or {}
        read.main_errors = dict(membership.get("errors") or {})
        if _SCOPE in read.main_errors:
            raise CompileError(read.main_errors[_SCOPE])
        read.main_in = set(found.get(_SCOPE) or ())
        read.main_hits = {rid: set(found.get(rid) or ()) for rid, _ in rules}
        if nodes:
            held = await self._admitted(lambda: self.base.get_nodes(
                NodeQuery(urns=urns, limit=len(urns), include_child_count=False)))
            read.main_nodes = {n.urn: n for n in held}
            read.main_types = {u: (read.main_nodes[u].entity_type if u in read.main_nodes else None)
                               for u in urns}
        else:
            lookup = getattr(self.base, "resolve_identities", None)
            ids = await self._admitted(lambda: lookup(urns) if callable(lookup)
                                       else resolve_identities_by_query(self.base, urns))
            read.main_types = {u: (ids.get(u) or {}).get("type") if ids.get(u) else None
                               for u in urns}
        live = [s for s in states if s.node is not None]
        roots = self._scope_sets(scope)[0]
        moves = bool(self.d.cont_added or self.d.cont_removed)
        # Placed by the scope's roots on the draft: what main didn't hold, holds as another type,
        # or — when the draft moved anything — holds under another container.
        placed = roots and (moves or any(
            read.main_types.get(s.urn) is None
            or _label(read.main_types[s.urn]) != _label(s.node.entity_type) for s in live))
        if live and (placed or any(_uses_containment(p) for _, p in rules)):
            want = sorted({s.urn for s in live})
            read.chains = await self.overlay.get_ancestor_chains(want)
            if roots and moves:
                existing = [u for u in want if read.main_types.get(u) is not None]
                if existing:
                    on_main = await self._admitted(lambda: self.base.get_ancestor_chains(existing))
                    read.moved = {u for u in existing
                                  if list(on_main.get(u) or ()) != list(read.chains.get(u) or ())}
        members = self.ctx.members
        if members is not None and live:
            read.held = set(await members.holds(sorted({s.urn for s in live})))
        return read

    def _in_scope(self, scope, read: _Read, state: _State) -> bool:
        """Whether the draft holds ``state`` inside ``scope``: as main does, for an entity main
        holds as the same type in the same place; else as the membership statement decides it
        (``falkordb_search.membership``), on the draft's chain and type."""
        urn, node = state.urn, state.node
        main_type = read.main_types.get(urn)
        if (main_type is not None and urn not in read.moved
                and _label(main_type) == _label(node.entity_type)):
            return urn in read.main_in
        roots, visible = self._scope_sets(scope)
        if visible is not None:
            return urn in visible
        if roots:
            if self.overlay._containment_types:
                depth = int(scope.max_depth or 12)
                under = urn in roots or any(a in roots for a in read.chains.get(urn, ())[:depth])
            else:
                under = urn in roots
            return under or (read.held is not None and urn in read.held)
        if read.held is not None:
            return urn in read.held
        wanted = {t.lower() for t in scope.entity_types or () if t}
        return not wanted or _label(node.entity_type).lower() in wanted

    # ---- membership --------------------------------------------------- #
    async def membership(self, scope, items: Sequence[Tuple[str, Any]], urns: Sequence[str],
                         named: Mapping[str, FrozenSet[str]]) -> Dict[str, Any]:
        """Main's membership for ``urns``, with those the draft changed answered on the draft."""
        started = time.monotonic()
        out = await self.base.deep_search_membership(
            scope, [*items, (_SCOPE, MatchAllPredicate())], urns, context=self.main_ctx)
        mine = [u for u in dict.fromkeys(urns) if u in self.changed]
        result = {"matches": {k: v for k, v in (out.get("matches") or {}).items() if k != _SCOPE},
                  "errors": {k: v for k, v in (out.get("errors") or {}).items() if k != _SCOPE},
                  "elapsedMs": out.get("elapsedMs", 0), "notes": []}
        if not mine:
            return result
        try:
            nodes = {n.urn: n for n in await self.d.served(
                [u for u in mine if u not in self.d.node_remove])}
            states = [_State(1, u, nodes.get(u)) for u in mine]
            exact = [(rid, p) for rid, p in items if rid not in result["errors"]
                     and inexact(p, self.changed, named.get(rid, frozenset())) is None]
            read = await self._read(scope, exact, states, membership=out)
            hits = await asyncio.to_thread(self._hits, scope, read, exact, states)
        except Exception:
            logger.warning("draft membership: answered as main for the draft's changes",
                           exc_info=True)
            result["notes"].append(MEMBERSHIP_NOT_DRAFT_AWARE)
            return result
        mine_set = set(mine)
        main_kept = 0
        for rid, _ in items:
            if rid in result["errors"]:
                continue
            listed = [u for u in result["matches"].get(rid, []) if u not in mine_set]
            if rid in hits:
                listed += [s.urn for i, s in enumerate(states) if i in hits[rid]]
            else:
                main_kept += 1      # main's answer, less what the draft removed
                listed += [u for u in result["matches"].get(rid, [])
                           if u in mine_set and u not in self.d.node_remove]
            result["matches"][rid] = listed
        if main_kept:
            result["notes"].append(MEMBERSHIP_MAINS.format(n=main_kept))
        result["elapsedMs"] = int((time.monotonic() - started) * 1000)
        return result

    def _hits(self, scope, read: _Read, rules, states: Sequence[_State]) -> Dict[str, Set[int]]:
        """Which of ``states`` (by position: a fold holds an entity twice, as it was and as it
        is) each rule matches on the draft — CPU, run off the event loop. A rule the evaluator
        can't answer is left out."""
        depth = int(scope.max_depth or 12)
        graph = _Chains(read.chains)
        live = [(i, node_dict(s.node)) for i, s in enumerate(states)
                if s.node is not None and self._in_scope(scope, read, s)]
        hits: Dict[str, Set[int]] = {}
        for rid, predicate in rules:
            try:
                hits[rid] = {i for i, nd in live if matches(nd, predicate, graph, depth)}
            except CompileError:
                logger.info("draft search: rule %s can't be answered on the draft", rid)
        return hits

    # ---- counts ------------------------------------------------------- #
    async def count_deltas(self, scope, items: Sequence[Tuple[str, Any]],
                           named: Mapping[str, FrozenSet[str]], wait_ms: int) -> Dict[str, Any]:
        """How far each rule's count on the draft is from main's: ``{"deltas": {id: int},
        "approximate": {id: note}, "status", "progress"}``, read a step at a time until
        ``wait_ms`` is spent (at least one step)."""
        approx = {rid: why for rid, p in items
                  for why in [inexact(p, self.changed, named.get(rid, frozenset()))] if why}
        exact = [(rid, p) for rid, p in items if rid not in approx]
        if not exact:
            return {"deltas": {}, "approximate": approx, "status": "complete",
                    "progress": {"scanned": 0, "total": 0}}
        rules_id = [[rid, p.model_dump(mode="json", by_alias=True)] for rid, p in exact]

        async def step(states: List[_State], acc: Dict[str, Any]) -> None:
            read = await self._read(scope, exact, states)
            lost = acc.setdefault("approximate", {})
            for rid, why in read.main_errors.items():
                lost.setdefault(rid, why)
            hits = await asyncio.to_thread(self._hits, scope, read, exact, states)
            for rid, _ in exact:
                if rid not in hits:
                    lost.setdefault(rid, RELATIONSHIPS)
                if rid in lost:
                    continue
                delta = sum(s.sign * ((i in hits[rid]) - (s.urn in read.main_hits[rid]))
                            for i, s in enumerate(states))
                acc["deltas"][rid] = acc["deltas"].get(rid, 0) + delta

        state = await self._advance("counts", scope, rules_id, {"deltas": {}}, step, wait_ms)
        if state.get("tooLarge"):
            note = TOO_LARGE.format(n=vconfig.DRAFT_SEARCH_MAX_DELTA)
            return {"deltas": {}, "approximate": {rid: note for rid, _ in items},
                    "status": "complete", "progress": {"scanned": 0, "total": 0}}
        acc = state["acc"]
        for rid, why in (acc.get("approximate") or {}).items():
            approx.setdefault(rid, why if why in _NOTES else RELATIONSHIPS)
        return {"deltas": {rid: n for rid, n in acc["deltas"].items() if rid not in approx},
                "approximate": approx, "status": state["status"],
                "progress": {"scanned": state["cursor"], "total": state["total"]}}

    # ---- catalog ------------------------------------------------------ #
    async def catalog(self, scope, main_answer: Dict[str, Any], wait_ms: int,
                      values_for: Optional[str] = None) -> Dict[str, Any]:
        """Main's catalog ``main_answer`` with the draft's changes folded in — ``values_for``: a key
        whose every kept value is listed (as main's own catalog lists it)."""
        skip = _skipped_keys()
        # The change's statistics as this request folds them, read from the correction once —
        # and written back to it only when it is saved (``keep``).
        live: Dict[str, CatalogStats] = {}

        def fold(read: _Read, states: List[_State], change: CatalogStats) -> None:
            # Each entity out as main holds it (when main holds it in the scope), and back as
            # the draft does (when the draft does) — CPU, off the event loop.
            for s in states:
                held = read.main_nodes.get(s.urn) if s.urn in read.main_in else None
                if held is not None:
                    change.add_entity(_label(held.entity_type), held.properties, held.tags,
                                      skip, -s.sign)
                if s.node is not None and self._in_scope(scope, read, s):
                    change.add_entity(_label(s.node.entity_type), s.node.properties,
                                      s.node.tags, skip, s.sign)

        async def step(states: List[_State], acc: Dict[str, Any]) -> None:
            read = await self._read(scope, [], states, nodes=True)
            if "stats" not in live:
                live["stats"] = await asyncio.to_thread(CatalogStats.from_json, acc["stats"])
            await asyncio.to_thread(fold, read, states, live["stats"])

        def keep(acc: Dict[str, Any]) -> None:
            if "stats" in live:
                acc["stats"] = live["stats"].to_json()

        state = await self._advance("catalog", scope, [], {"stats": CatalogStats().to_json()},
                                    step, wait_ms, keep)
        if state.get("tooLarge"):
            return {**main_answer, "notes": [*(main_answer.get("notes") or []),
                                             TOO_LARGE_CATALOG.format(n=vconfig.DRAFT_SEARCH_MAX_DELTA)]}
        main_progress = main_answer.get("progress") or {}
        progress = {"scanned": int(main_progress.get("scanned") or 0) + state["cursor"],
                    "total": int(main_progress.get("total") or 0) + state["total"]}
        if main_answer.get("status") != "complete":
            # Main's read so far, as it grows: what the draft changed is folded into the whole.
            return {**main_answer, "status": "running", "dataVersion": self.ctx.data_version,
                    "progress": {**main_progress, **progress}}
        main_sid = main_answer.get("sessionId")
        main_session = await self.store.load(main_sid) if main_sid else None
        raw = await self.store.load_accumulator(main_sid) if main_session is not None else None
        if main_session is None or raw is None:
            raise LookupError("main's catalog is not kept where its session is")
        merged, wide = CatalogStats.from_json(raw).folded(
            live.get("stats") or CatalogStats.from_json(state["acc"]["stats"]))
        answer = answer_of(merged, main_session, self.main_ctx, wide, values_for=values_for)
        answer.update({
            "status": state["status"],
            "entities": sum(merged.entities.values()),
            "dataVersion": self.ctx.data_version or answer.get("dataVersion"),
            "notes": [*answer.get("notes", []), *([CATALOG_RANGES] if wide else [])],
            "progress": {**progress, "matched": sum(merged.entities.values())},
        })
        return answer

    # ---- the correction's session -------------------------------------- #
    async def _advance(self, kind: str, scope, rules_id, fresh: Dict[str, Any], step,
                       wait_ms: int, keep=None) -> Dict[str, Any]:
        """This request's share of a correction: continue the one this draft version has, or
        start it — folding in only the commits since the latest complete one of the same draft,
        rules and scope over the same main, when that is fewer entities than ``D`` — and run its
        steps under its lease until ``wait_ms`` is spent, saving it every ``SAVE_EVERY`` steps,
        when the wait is spent and when it completes (``keep(acc)`` first readies what a step
        holds apart). Returns its state — ``tooLarge``, and nothing run, for a read of all of ``D``
        past ``DRAFT_SEARCH_MAX_DELTA``.

        The corrections a newer one supersedes are deleted, not left to their TTL: the complete one
        of an earlier version, once the newer completes; one still running for an earlier version,
        once the newer starts."""
        version = list(self.overlay._version or ())
        line = _digest([kind, self.overlay._gid, self.overlay._branch, self.main_ctx.data_version,
                        self.ctx.scope_hash, scope.model_dump(mode="json", by_alias=True),
                        rules_id])
        sid = _digest([line, [str(v) for v in version]])
        pointer, running = f"draft-search:{line}", f"draft-search-running:{line}"
        session = await self.store.load(sid)
        state = json.loads(await self.store.load_accumulator(sid) or "null") if session else None
        finished = False
        if session is None or state is None:
            state = await self._plan(version, pointer, fresh)
            if _too_large(state):
                return {**state, "tooLarge": True}
            session = Session(sid, line, self.main_ctx.data_version, None, 0, [], [],
                              state["total"], scope_hash=self.ctx.scope_hash)
            if state["cursor"] >= state["total"]:
                # Nothing to read (a fold of commits that wrote no node): complete as planned.
                session.status = COMPLETE
                state["status"] = "complete"
                await self.store.save(session, None, _TTL_S,
                                      accumulator=json.dumps(state, separators=(",", ":")))
                finished = True
            else:
                await self._supersede_running(running, sid)
        if session.status == RUNNING:
            deadline = time.monotonic() + max(0.0, wait_ms / 1000.0)
            token = await self.store.lease(sid, int(max(wait_ms, 1000) + 30_000))
            if token is not None:
                try:
                    latest = await self.store.load(sid)
                    if latest is not None:
                        session = latest
                        state = json.loads(await self.store.load_accumulator(sid) or "null") or state
                    items = await self._items(state)
                    if items is None:
                        # The commits a fold reads are not what they were: read all of D.
                        state = {**state, "mode": "full", "cursor": 0, "acc": fresh}
                        items = await self._items(state)
                        state["total"] = session.total = len(items)
                        if _too_large(state):
                            return {**state, "tooLarge": True}
                    steps = 0
                    while session.status == RUNNING:
                        batch = items[state["cursor"]:state["cursor"] + BATCH]
                        await step(await self._states(state, batch), state["acc"])
                        state["cursor"] += len(batch)
                        session.scanned = state["cursor"]
                        steps += 1
                        if state["cursor"] >= state["total"]:
                            session.status = COMPLETE
                            state["status"] = "complete"
                        spent = time.monotonic() >= deadline
                        if session.status == COMPLETE or spent or steps % SAVE_EVERY == 0:
                            if keep is not None:
                                await asyncio.to_thread(keep, state["acc"])
                            if not await self.store.save(
                                    session, token, _TTL_S,
                                    accumulator=json.dumps(state, separators=(",", ":"))):
                                break       # the lease went to another request: it carries on
                            finished = session.status == COMPLETE
                        if spent:
                            break
                finally:
                    await self.store.release(sid, token)
        if session.status == COMPLETE:
            before = await self.store.pointed(pointer) if finished else None
            await self.store.point(pointer, sid, _TTL_S)
            if before and before != sid:
                await self.store.delete(before)         # folded into this one
        state["status"] = "complete" if session.status == COMPLETE else "running"
        return state

    async def _supersede_running(self, running: str, sid: str) -> None:
        """``sid`` starts on its line: one still running there for an earlier version is deleted
        (a request stepping it stops at its next save), and ``sid`` is the line's running one."""
        before = await self.store.pointed(running)
        if before and before != sid:
            held = await self.store.load(before)
            if held is not None and held.status == RUNNING:
                await self.store.delete(before)
        await self.store.point(running, sid, _TTL_S)

    async def _plan(self, version: List[Any], pointer: str, fresh: Dict[str, Any]) -> Dict[str, Any]:
        """A new correction for this draft version: a fold of the commits since the latest
        complete one, when that can be, else a read of all of ``D``."""
        order = await asyncio.to_thread(_changed_order, self.d)
        head = await self.overlay._svc.draft_search_window(
            graph_id=self.overlay._gid, branch_id=self.overlay._branch,
            commit_id=version[0] if version else None)
        seq = head.get("seq")
        state = {"seq": seq, "version": [str(v) for v in version[1:]], "mode": "full",
                 "cursor": 0, "total": len(order), "acc": fresh, "status": "running"}
        prev_sid = await self.store.pointed(pointer)
        prev = await self.store.load(prev_sid) if prev_sid else None
        held = (json.loads(await self.store.load_accumulator(prev_sid) or "null")
                if prev is not None and prev.status == COMPLETE else None)
        if (held is None or seq is None or held.get("seq") is None or held["seq"] >= seq
                or held.get("version") != state["version"]
                or await asyncio.to_thread(_urn_of_id, self.d) is None):
            return state
        window = await self.overlay._svc.draft_search_window(
            graph_id=self.overlay._gid, branch_id=self.overlay._branch,
            commit_id=version[0], since_seq=held["seq"], limit=len(order) // 2,
            containment_types=list(self.overlay._containment_types))
        if window.get("edges") or window.get("nodes") is None:
            return state                        # moves, or more than reading D costs
        return {**state, "mode": "fold", "from": held["seq"], "total": len(window["nodes"]),
                "acc": held["acc"]}

    async def _items(self, state: Dict[str, Any]) -> Optional[List[str]]:
        """What the correction steps through: ``D``'s urns, or the entity ids a fold reads —
        None when those are not what the fold was planned on."""
        if state["mode"] == "full":
            return await asyncio.to_thread(_changed_order, self.d)
        window = await self.overlay._svc.draft_search_window(
            graph_id=self.overlay._gid, branch_id=self.overlay._branch,
            commit_id=(self.overlay._version or (None,))[0], since_seq=state["from"],
            limit=state["total"])
        nodes = window.get("nodes")
        return nodes if nodes is not None and len(nodes) == state["total"] else None

    async def _states(self, state: Dict[str, Any], batch: List[str]) -> List[_State]:
        """The two sides of a step's entities: each as the draft holds it now — and, folding,
        as it held it before the commits folded in."""
        d = self.d
        if state["mode"] == "full":
            nodes = {n.urn: n for n in await d.served([u for u in batch if u not in d.node_remove])}
            return [_State(1, u, nodes.get(u)) for u in batch]
        ids = _urn_of_id(d) or {}
        now = {eid: ids[eid] for eid in batch if eid in ids}
        nodes = {n.urn: n for n in await d.served(
            [u for u in now.values() if u not in d.node_remove])}
        before = await self.overlay._svc.draft_nodes_as_of(
            graph_id=self.overlay._gid, branch_id=self.overlay._branch, entity_ids=batch,
            seq=state["from"])
        states = [_State(1, urn, nodes.get(urn)) for urn in now.values()]
        for held in before.values():
            node = GraphNode(**held["node"]) if held.get("node") else None
            states.append(_State(-1, held["urn"], node))
        return states


_NOTES = frozenset({RELATIONSHIPS, LAYERS, PLATFORM_FIELD, NAMES_CHANGED})


def _too_large(state: Dict[str, Any]) -> bool:
    """A correction that would read more of ``D`` afresh than a request may: main answers."""
    return state["mode"] == "full" and state["total"] > vconfig.DRAFT_SEARCH_MAX_DELTA


def _roots(scope) -> Set[str]:
    return set(scope.root_urns or []) if scope.scope_mode == "view" else set()


def _digest(parts: Any) -> str:
    raw = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:32]
