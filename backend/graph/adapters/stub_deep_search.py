"""In-memory ``DeepSearchProvider`` for CI tests.

This stub satisfies the ``DeepSearchProvider`` Protocol introduced in
W0.3 (``backend/app/services/deep_search/contracts.py``) without
implementing the full ``GraphDataProvider`` interface. It exists so
that:

  * The Protocol can be exercised end-to-end without FalkorDB running.
  * Service-layer integration tests have a deterministic fixture.
  * Phase 3 HTTP integration tests (W3.4) can boot the FastAPI app
    against an in-memory backend.

Implementation strategy: predicates are evaluated **directly in
Python** against a list of node and edge dicts. There is no Cypher
emission and no Cypher interpreter — the goal is to exercise the
service-layer contract, not to replicate FalkorDB's planner.

Only the most common predicate kinds are evaluated; unsupported kinds
raise ``CompileError`` with a clear message. The covered subset is
deliberately small and matches the predicates the smoke tests
exercise; extend as new test cases need them.
"""
from __future__ import annotations

import time
from collections import Counter
from typing import Any, Dict, List, Optional, Sequence

from backend.app.services.deep_search import CompileError
from backend.app.services.deep_search.settings import get_deep_search_settings
from backend.app.services.view_placement import NodeFacts, place_all
from backend.common.search_semantics import (
    SemanticsError,
    element_texts,
    evaluate,
    evaluate_keys,
    fold_case,
    resolve_comparison,
    resolve_predicate,
    value_slot,
)
from backend.common.derived_artifacts import is_derived_edge_type
from backend.common.edge_properties import EDGE_NATIVE_KEYS, json_holds
from backend.common.models.search import (
    NODE_REF_ANY_DEPTH,
    NODE_REF_MATCHES_MAX,
    AncestorRef,
    DegreePredicate,
    EdgeRef,
    EdgeGroupPredicate,
    EdgeHasPropertyPredicate,
    EdgePropertyPredicate,
    EntityTypePredicate,
    GroupPredicate,
    HasIncomingPredicate,
    HasOutgoingPredicate,
    HasPropertyPredicate,
    IsLeafPredicate,
    IsOrphanPredicate,
    IsPredicate,
    IsRootPredicate,
    LayerPredicate,
    MatchAllPredicate,
    PathHit,
    PathPredicate,
    PropertyPredicate,
    RelatedPredicate,
    SearchHit,
    SearchQuery,
    SearchResultPage,
    TagPredicate,
    TextPredicate,
)

#: How far below its anchor a ``"**"`` in a name path looks.
REF_ANY_DEPTH_MAX = 20


# Fixture node dict shape: keys ``urn`` (str, required), ``entityType``
# (str, used as the label), ``displayName`` / ``qualifiedName`` /
# ``description`` (optional strs), ``tags`` (list[str], optional),
# ``layerAssignment`` (str, optional), and any number of arbitrary
# property keys. Edge dict shape: ``source`` / ``target`` / ``type``
# (all strs) plus optional property keys.

# The fixture fields that are the node's own, not user properties — what a
# search BY property name must not match (the FalkorDB compiler excludes
# ``platform_property_names()`` for the same reason).
_NODE_FIELDS = frozenset({
    "urn", "entityType", "displayName", "qualifiedName", "description",
    "tags", "layerAssignment", "searchableText",
})


class StubDeepSearchProvider:
    """Tiny in-memory backend exercising the DeepSearchProvider Protocol.

    Construct with a fixture graph; pass to the service layer the same
    way a real provider would be (``engine.provider = stub``).
    """

    def __init__(
        self,
        *,
        nodes: Sequence[Dict[str, Any]] = (),
        edges: Sequence[Dict[str, Any]] = (),
        containment_edge_types: Sequence[str] = ("CONTAINS",),
        lineage_edge_types: Optional[Sequence[str]] = None,
    ) -> None:
        self._nodes: List[Dict[str, Any]] = list(nodes)
        self._edges: List[Dict[str, Any]] = list(edges)
        # Containment edges point parent → child, as the graph's do. Lineage
        # is every other type unless named.
        contains = set(containment_edge_types)
        self._containment_types = frozenset(contains)
        self._lineage_types = frozenset(
            lineage_edge_types if lineage_edge_types is not None
            else {e.get("type") for e in self._edges if e.get("type") not in contains})
        self._every_type = frozenset(
            {e.get("type") for e in self._edges} | contains | self._lineage_types)
        self._out: Dict[str, List[int]] = {}
        self._in: Dict[str, List[int]] = {}
        for i, e in enumerate(self._edges):
            self._out.setdefault(e.get("source"), []).append(i)
            self._in.setdefault(e.get("target"), []).append(i)
        self._parents: Dict[str, List[str]] = {}
        self._children: Dict[str, List[str]] = {}
        for e in self._edges:
            if e.get("type") in contains:
                self._children.setdefault(e["source"], []).append(e["target"])
                self._parents.setdefault(e["target"], []).append(e["source"])
        self._by_urn: Dict[str, Dict[str, Any]] = {n["urn"]: n for n in self._nodes}
        self._placed: Dict[int, Any] = {}

    # --- DeepSearchProvider Protocol -----------------------------------------

    async def deep_search(
        self,
        query: SearchQuery,
        *,
        deadline_ms: Optional[int] = None,
    ) -> SearchResultPage:
        start = time.monotonic()
        path = _path_of(query.predicate)
        if path is not None:
            routes = self._routes(path, query.scope)
            return SearchResultPage(
                paths=routes[:path.max_paths], truncated=len(routes) > path.max_paths,
                candidate_count=min(len(routes), path.max_paths), deadline_exceeded=False,
                elapsed_ms=int((time.monotonic() - start) * 1000), cache_hit=False)
        matches = [n for n in self._nodes if _matches(n, query.predicate, self)]

        # Apply scope clamp if root_urns are set. Simple containment:
        # match nodes whose urn IS one of the root_urns OR whose
        # ``ancestorUrns`` list contains a root urn.
        if query.scope.root_urns:
            roots = set(query.scope.root_urns)
            matches = [
                n for n in matches
                if n.get("urn") in roots
                or any(a in roots for a in self._ancestors(n))
            ]
        # Entity-type clamp from scope (resolver-stamped) — skipped when
        # root_urns already bound the search, mirroring the FalkorDB
        # provider: where a containment boundary exists it is the only
        # boundary, or a descendant of another type could never be
        # returned.
        if query.scope.entity_types and not query.scope.root_urns:
            allowed = set(query.scope.entity_types)
            matches = [
                n for n in matches if n.get("entityType") in allowed
            ]

        settings = get_deep_search_settings()
        candidate_count = len(matches)
        truncated = candidate_count >= settings.candidate_cap
        matches = matches[: settings.candidate_cap]

        shape = query.options.results
        hits: Optional[List[SearchHit]] = None
        if shape in ("hits", "both"):
            page_size = query.options.page_size
            hits = [_to_search_hit(n) for n in matches[:page_size]]

        elapsed_ms = int((time.monotonic() - start) * 1000)
        return SearchResultPage(
            hits=hits,
            aggregates=[] if shape in ("aggregates", "both") else None,
            cursor=None,
            truncated=truncated,
            candidate_count=candidate_count,
            # In-memory evaluation counts every match BEFORE the cap
            # slice, so the exact total costs nothing extra.
            total_count=candidate_count,
            deadline_exceeded=False,
            elapsed_ms=elapsed_ms,
            cache_hit=False,
        )

    async def deep_search_count(self, query: SearchQuery, *, context=None,
                                advance: bool = True) -> Dict[str, Any]:
        """A rule's total over the fixture — complete in one answer."""
        count = sum(1 for n in self._in_scope(query.scope)
                    if _matches(n, query.predicate, self))
        return {"count": count, "status": "complete", "sessionId": None,
                "progress": {"scanned": 1, "total": 1, "matched": count},
                "dataVersion": None, "notes": []}

    async def deep_search_membership(self, scope, items, urns, *, context=None) -> Dict[str, Any]:
        """Which of ``urns`` match each rule, inside ``scope``."""
        wanted = set(urns)
        nodes = [n for n in self._in_scope(scope) if n.get("urn") in wanted]
        matches: Dict[str, List[str]] = {}
        errors: Dict[str, str] = {}
        for item_id, predicate in items:
            try:
                matches[item_id] = [n["urn"] for n in nodes if _matches(n, predicate, self)]
            except CompileError as exc:
                errors[item_id] = str(exc)
        return {"matches": matches, "errors": errors, "elapsedMs": 0}

    def _in_scope(self, scope) -> List[Dict[str, Any]]:
        """The fixture nodes inside a resolved scope, as ``deep_search``
        clamps them."""
        nodes = list(self._nodes)
        if scope.root_urns:
            roots = set(scope.root_urns)
            nodes = [n for n in nodes if n.get("urn") in roots
                     or any(a in roots for a in self._ancestors(n))]
        elif scope.entity_types:
            allowed = set(scope.entity_types)
            nodes = [n for n in nodes if n.get("entityType") in allowed]
        return nodes

    async def deep_search_resolve_refs(self, scope, refs, *, context=None,
                                       confined: bool = False,
                                       with_paths: bool = False) -> List[Dict[str, Any]]:
        """Which entities each name reference names — the reference semantics
        the FalkorDB resolver is held to. One answer per reference:
        ``{"urns", "entities", "error"}``, at most 10 entities listed."""
        in_scope = {n["urn"] for n in self._in_scope(scope)}
        if scope.scope_mode == "data_source" and not confined:
            in_scope = {n["urn"] for n in self._nodes}
        out = []
        for ref in refs:
            urns = sorted(self._named(ref, in_scope))
            if confined:
                urns = [u for u in urns if u in in_scope]
            error = None
            if len(urns) > NODE_REF_MATCHES_MAX:
                error = (f"'{ref.label()}' names more than {NODE_REF_MATCHES_MAX} "
                         "entities — name a deeper path or a type")
                urns = []
            out.append({"urns": urns, "error": error,
                        "entities": [self._entity(u, with_paths) for u in urns[:10]]})
        return out

    def _entity(self, urn: str, with_path: bool) -> Dict[str, Any]:
        node = self._by_urn.get(urn, {})
        entity = {"urn": urn, "displayName": node.get("displayName", ""),
                  "entityType": node.get("entityType", "")}
        if with_path:
            chain, at = [], urn
            while self._parents.get(at) and len(chain) < REF_ANY_DEPTH_MAX:
                at = self._parents[at][0]
                chain.append(at)
            entity["ancestorPath"] = [
                {"urn": a, "displayName": self._by_urn.get(a, {}).get("displayName", ""),
                 "entityType": self._by_urn.get(a, {}).get("entityType", "")}
                for a in reversed(chain)]
        return entity

    def _named(self, ref, in_scope) -> set:
        if ref.urn is not None:
            return {ref.urn}
        segments = list(ref.path)

        def named(urn: str, name: str) -> bool:
            have = self._by_urn.get(urn, {}).get("displayName") or ""
            return have == name if ref.case_sensitive else fold_case(have) == fold_case(name)

        if segments[0] == NODE_REF_ANY_DEPTH:
            # Anywhere in the search's scope.
            current = {u for u in in_scope if named(u, segments[1])}
            rest = segments[2:]
        else:
            current = {n["urn"] for n in self._nodes
                       if not self._parents.get(n["urn"]) and named(n["urn"], segments[0])}
            rest = segments[1:]
        while rest:
            if rest[0] == NODE_REF_ANY_DEPTH:
                current = {d for u in current for d in self._descendants(u)
                           if named(d, rest[1])}
                rest = rest[2:]
            else:
                current = {c for u in current for c in self._children.get(u, ())
                           if named(c, rest[0])}
                rest = rest[1:]
        if ref.entity_type:
            wanted = ref.entity_type.lower()
            current = {u for u in current
                       if str(self._by_urn.get(u, {}).get("entityType", "")).lower() == wanted}
        return current

    # --- relationships (the reference semantics) ---------------------------

    def _relation_holds(self, node: Dict[str, Any], p: RelatedPredicate) -> bool:
        related = self._relatives(node["urn"], p)
        if p.where is None:
            meets = [True for _ in related]
        else:
            meets = [_matches(self._by_urn[u], p.where, self) for u in related]
        if p.count is not None:
            return _compare(sum(meets), p.count.op, p.count.value)
        if p.quantifier == "none":
            return not any(meets)
        if p.quantifier == "all":
            return bool(meets) and all(meets)
        return any(meets)

    def _relatives(self, urn: str, p: RelatedPredicate) -> List[str]:
        """R(n): the distinct entities related to ``urn`` along ``p``'s
        axis — never ``urn`` itself — that the fixture holds."""
        lo, hi = p.hop_range()
        if p.axis == "parent":
            found = set(self._parents.get(urn, ()))
        elif p.axis == "child":
            found = set(self._children.get(urn, ()))
        elif p.axis in ("ancestor", "root"):
            found = self._walk(urn, lo, hi, lambda u: self._parents.get(u, ()))
            if p.axis == "root":
                found = {a for a in found if not self._parents.get(a)}
        elif p.axis == "descendant":
            found = self._walk(urn, lo, hi, lambda u: self._children.get(u, ()))
        else:
            found = self._trails(urn, p, lo, hi)
        found.discard(urn)
        return sorted(u for u in found if u in self._by_urn)

    @staticmethod
    def _walk(urn: str, lo: int, hi: int, step) -> set:
        """Entities ``lo``..``hi`` containment steps from ``urn``."""
        found: set = set()
        frontier = {urn}
        for depth in range(1, hi + 1):
            frontier = {nxt for u in frontier for nxt in step(u)}
            if not frontier:
                break
            if depth >= lo:
                found |= frontier
        return found

    def _trails(self, urn: str, p: RelatedPredicate, lo: int, hi: int) -> set:
        """Ends of the lineage routes from ``urn`` of ``lo``..``hi`` edges
        that pass no entity twice (``urn`` included), every edge of an
        allowed type and meeting the edge filter."""
        allowed = self._edge_types(p.edge_class or "lineage", p.edge_types, walk=True)
        found: set = set()

        def steps(at: str):
            if p.axis in ("downstream", "neighbor"):
                for i in self._out.get(at, ()):
                    yield i, self._edges[i]["target"]
            if p.axis in ("upstream", "neighbor"):
                for i in self._in.get(at, ()):
                    yield i, self._edges[i]["source"]

        def walk(at: str, visited: frozenset, depth: int) -> None:
            if depth >= lo:
                found.add(at)
            if depth == hi:
                return
            for i, nxt in steps(at):
                edge = self._edges[i]
                if (nxt in visited or str(edge.get("type")).upper() not in allowed
                        or not _edge_passes(edge, p.edge)):
                    continue
                walk(nxt, visited | {nxt}, depth + 1)

        walk(urn, frozenset({urn}), 0)
        found.discard(urn)
        return found

    def _routes(self, p: PathPredicate, scope) -> List[PathHit]:
        """Every route of 1..``maxHops`` edges from a source to a target,
        passing no entity twice, every edge of the path's types and meeting
        its edge filter — in a stable order (fewest hops, then by urn).

        A named end is its entities; a condition, every entity meeting it
        — for the sources, in the search's scope when the targets are a
        condition too."""
        types = self._edge_types(p.edge_class, p.edge_types)

        def named(urns, refs) -> set:
            return {u for u in [*urns, *(r.urn for r in refs or ())] if u in self._by_urn}

        if p.source_where is None:
            sources = sorted(named(p.source_urns, p.source_refs))
        else:
            pool = self._in_scope(scope) if p.target_where is not None else self._nodes
            sources = sorted(n["urn"] for n in pool if _matches(n, p.source_where, self))
        targets = named(p.target_urns, p.target_refs) if p.target_where is None else None

        def is_target(urn: str) -> bool:
            return urn in targets if targets is not None else _matches(
                self._by_urn[urn], p.target_where, self)

        def steps(at: str):
            if p.direction in ("outgoing", "any"):
                for i in self._out.get(at, ()):
                    yield i, self._edges[i]["target"]
            if p.direction in ("incoming", "any"):
                for i in self._in.get(at, ()):
                    yield i, self._edges[i]["source"]

        routes: List[PathHit] = []

        def walk(nodes: List[str], edges: List[int]) -> None:
            if edges and is_target(nodes[-1]):
                routes.append(self._route(nodes, edges))
            if len(edges) == p.max_hops:
                return
            for i, nxt in steps(nodes[-1]):
                edge = self._edges[i]
                if (nxt in nodes or nxt not in self._by_urn
                        or str(edge.get("type")).upper() not in types
                        or not _edge_passes(edge, p.edge_predicate)):
                    continue
                walk(nodes + [nxt], edges + [i])

        for source in sources:
            walk([source], [])
        return sorted(routes, key=lambda r: (r.hop_count, [n.urn for n in r.nodes]))

    def _route(self, nodes: List[str], edges: List[int]) -> PathHit:
        def ref(urn: str) -> AncestorRef:
            node = self._by_urn[urn]
            return AncestorRef(urn=urn, display_name=str(node.get("displayName") or ""),
                               entity_type=str(node.get("entityType") or ""))

        def edge_ref(i: int) -> EdgeRef:
            e = self._edges[i]
            native = {k: v for k, v in e.items()
                      if k not in ("source", "target", "type", "properties")}
            return EdgeRef(source_urn=e["source"], target_urn=e["target"],
                           edge_type=str(e.get("type")),
                           properties={**(e.get("properties") or {}), **native})

        return PathHit(nodes=[ref(u) for u in nodes], edges=[edge_ref(i) for i in edges],
                       hop_count=len(edges))

    def _degree(self, urn: str, d: DegreePredicate) -> bool:
        types = self._edge_types(d.edge_class, d.edge_types)
        count = 0
        if d.direction in ("in", "both"):
            count += sum(1 for i in self._in.get(urn, ())
                         if str(self._edges[i].get("type")).upper() in types)
        if d.direction in ("out", "both"):
            count += sum(1 for i in self._out.get(urn, ())
                         if str(self._edges[i].get("type")).upper() in types)
        return _compare(count, d.op, d.value)

    def _edge_types(self, edge_class: str, edge_types, *, walk: bool = False) -> set:
        """The edge types, in upper case, a predicate counts or walks: those
        it names, whatever their case, else its class's — ``links`` every
        type but containment, ``any`` every type. ``walk``: a relationship's,
        which leaves out the rollups unless it names them."""
        if edge_types:
            return {str(t).upper() for t in edge_types}
        contains = {str(t).upper() for t in self._containment_types}
        types = {"lineage": self._lineage_types, "containment": self._containment_types,
                 "any": self._every_type}.get(edge_class)
        if types is None:   # links
            types = {t for t in self._every_type if str(t).upper() not in contains}
        if walk:
            types = {t for t in types if not is_derived_edge_type(t)}
        return {str(t).upper() for t in types}

    def _layer_of(self, urn: str, target) -> Optional[str]:
        """The layer the view's canvas draws ``urn`` in: ``place_all`` itself,
        over every node and the containment between them, once per view."""
        placed = self._placed.get(id(target.spec))
        if placed is None:
            facts = {n["urn"]: NodeFacts(
                urn=n["urn"], entity_type=n.get("entityType") or "",
                display_name=n.get("displayName") or None,
                tags=frozenset(t for t in n.get("tags") or () if isinstance(t, str)),
                properties={k: v for k, v in n.items() if k not in _NODE_FIELDS},
                stamp=(n["layerAssignment"] if isinstance(n.get("layerAssignment"), str)
                       and n["layerAssignment"] else None),
            ) for n in self._nodes}
            layers = {u: p.layer_id for u, p in place_all(target.spec, facts, self._parents).items()}
            # The spec is kept with its answer, so its id can't be reused while cached.
            placed = self._placed[id(target.spec)] = (target.spec, layers)
        return placed[1].get(urn)

    def _ancestors(self, node: Dict[str, Any]) -> List[str]:
        """The fixture's ``ancestorUrns`` when it gives them, else every
        container above the node by its containment edges."""
        given = node.get("ancestorUrns")
        if given is not None:
            return list(given)
        found: List[str] = []
        frontier = list(self._parents.get(node.get("urn"), ()))
        while frontier:
            urn = frontier.pop()
            if urn not in found:
                found.append(urn)
                frontier.extend(self._parents.get(urn, ()))
        return found

    def _descendants(self, urn: str) -> set:
        """Everything below ``urn``, one level down to ``REF_ANY_DEPTH_MAX``."""
        found: set = set()
        frontier = [urn]
        for _ in range(REF_ANY_DEPTH_MAX):
            frontier = [c for u in frontier for c in self._children.get(u, ()) if c not in found]
            if not frontier:
                break
            found.update(frontier)
        return found

    async def deep_search_explain(self, query: SearchQuery) -> Dict[str, Any]:
        # The stub doesn't emit Cypher; it returns a diagnostic dict
        # whose shape matches ``explain_deep_search`` enough for the
        # FE to render "compiled query: <stub>" + parameter list.
        return {
            "cypher": "<stub: in-memory evaluator>",
            "hits_cypher": "<stub: in-memory evaluator> RETURN n",
            "params": {},
            "candidate_cap": get_deep_search_settings().candidate_cap,
            "hoisted_root_urns": [],
            "effective_root_urns": (
                list(query.scope.root_urns) if query.scope.root_urns else None
            ),
            "notes": ["stub provider — predicates evaluated in Python"],
        }

    async def deep_search_values(
        self,
        *,
        key: str,
        entity_types: Optional[List[str]] = None,
        q: str = "",
        limit: int = 25,
    ) -> Dict[str, Any]:
        """Every fixture node counted — the FalkorDB query's answer on a
        graph small enough to finish within its budget."""
        start = time.monotonic()
        wanted = {str(t).lower() for t in entity_types} if entity_types else None
        needle = fold_case(q.strip())
        counts: Dict[tuple, int] = {}
        for n in self._nodes:
            if wanted is not None and str(n.get("entityType", "")).lower() not in wanted:
                continue
            stored = n.get(key)
            for v in stored if isinstance(stored, list) else [stored]:
                if not isinstance(v, (str, int, float, bool)):
                    continue
                if needle and needle not in fold_case(element_texts(v)[0]):
                    continue
                slot = value_slot(v)
                counts[slot] = counts.get(slot, 0) + 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0][1])))
        return {
            "key": key,
            "values": [{"value": v, "count": c} for (_, v), c in ordered[:limit]],
            "complete": True,
            "truncated": len(ordered) > limit,
            "elapsedMs": int((time.monotonic() - start) * 1000),
        }

    async def deep_search_discover(
        self,
        *,
        sample_per_label: int = 200,
    ) -> Dict[str, Any]:
        start = time.monotonic()
        settings = get_deep_search_settings()

        # Per-label aggregates. ``key_counts`` tracks how often each
        # property key appears across the sample so we can keep the
        # top-N when a label exceeds the per-label cap — mirrors the
        # FalkorDB discover behaviour (W1.1a).
        labels: Dict[str, Dict[str, Any]] = {}
        missing_searchable_text = 0
        for n in self._nodes[: max(1, sample_per_label) * 32]:
            label = n.get("entityType")
            if not label:
                continue
            entry = labels.setdefault(label, {
                "key_counts": Counter(),
                "sampled": 0,
                "valueSamplesByKey": {},
            })
            if entry["sampled"] >= sample_per_label:
                continue
            entry["sampled"] += 1
            if not n.get("searchableText"):
                # Mirrors the FalkorDB discover diagnostic: absent or
                # empty is unsearchable either way by text(target='any').
                missing_searchable_text += 1
            for k, v in n.items():
                if k in {"urn", "entityType", "tags", "ancestorUrns"}:
                    continue
                entry["key_counts"][k] += 1
                if v is None:
                    continue
                samples = entry["valueSamplesByKey"].setdefault(k, [])
                if (
                    v not in samples
                    and len(samples) < settings.discover_value_samples_per_key
                ):
                    samples.append(v)

        # Finalise: apply per-label key cap by frequency.
        out_labels: Dict[str, Dict[str, Any]] = {}
        for label, entry in labels.items():
            total_keys = len(entry["key_counts"])
            top_keys = {
                k for k, _ in entry["key_counts"].most_common(
                    settings.discover_value_keys_per_label,
                )
            }
            truncated = total_keys > len(top_keys)
            out_labels[label] = {
                "keys": sorted(top_keys),
                "sampled": entry["sampled"],
                "truncatedProperties": truncated,
                "valueSamplesByKey": {
                    k: sorted(map(str, vs))
                    for k, vs in entry["valueSamplesByKey"].items()
                    if k in top_keys
                },
            }

        # Tag value frequencies (top N).
        tag_counter: Counter[str] = Counter()
        for n in self._nodes:
            for t in n.get("tags") or []:
                if isinstance(t, str):
                    tag_counter[t] += 1
        tag_values = dict(
            tag_counter.most_common(settings.discover_tag_values_cap),
        )

        # Edge metadata (by type, with sampled property keys).
        edges: Dict[str, Dict[str, Any]] = {}
        for e in self._edges[: settings.discover_edge_sample_cap]:
            et = e.get("type")
            if not et:
                continue
            entry = edges.setdefault(
                et, {"keys": set(), "sampled": 0, "valueSamplesByKey": {}},
            )
            entry["sampled"] += 1
            for k, v in e.items():
                if k in {"source", "target", "type"}:
                    continue
                entry["keys"].add(k)
                if v is None:
                    continue
                samples = entry["valueSamplesByKey"].setdefault(k, [])
                if (
                    v not in samples
                    and len(samples) < settings.discover_value_samples_per_key
                ):
                    samples.append(v)
        edges_out: Dict[str, Dict[str, Any]] = {}
        for et, entry in edges.items():
            edges_out[et] = {
                "keys": sorted(entry["keys"]),
                "sampled": entry["sampled"],
                "valueSamplesByKey": {
                    k: sorted(map(str, vs))
                    for k, vs in entry["valueSamplesByKey"].items()
                },
            }

        return {
            "labels": out_labels,
            "blobOnlyLabels": [],
            "missingContainment": False,
            "tagValues": tag_values,
            "missingSearchableText": missing_searchable_text,
            "edges": edges_out,
            "elapsedMs": int((time.monotonic() - start) * 1000),
        }


# ---------------------------------------------------------------------------
# Predicate evaluation
# ---------------------------------------------------------------------------


_SUGAR = {
    IsOrphanPredicate: ("both", "eq", 0), IsLeafPredicate: ("out", "eq", 0),
    IsRootPredicate: ("in", "eq", 0), HasIncomingPredicate: ("in", "gt", 0),
    HasOutgoingPredicate: ("out", "gt", 0),
}


def _path_of(predicate) -> Optional[PathPredicate]:
    """The path a query asks for: at its top, or in its top-level AND."""
    if isinstance(predicate, PathPredicate):
        return predicate
    if isinstance(predicate, GroupPredicate) and predicate.op == "and":
        return next((c for c in predicate.children if isinstance(c, PathPredicate)), None)
    return None


def _compare(count: int, op: str, value: int) -> bool:
    return {"eq": count == value, "neq": count != value, "gt": count > value,
            "gte": count >= value, "lt": count < value, "lte": count <= value}[op]


def _edge_passes(edge: Dict[str, Any], ep) -> bool:
    """An edge filter on a fixture edge: its native fields are its own keys,
    a user's properties sit in its ``properties`` (``edge_properties``)."""
    if ep is None:
        return True
    if isinstance(ep, EdgeGroupPredicate):
        if ep.op == "not":
            return not _edge_passes(edge, ep.children[0])
        tests = (_edge_passes(edge, c) for c in ep.children)
        return all(tests) if ep.op == "and" else any(tests)
    if isinstance(ep, EdgeHasPropertyPredicate):
        present = (edge.get(ep.key) is not None if ep.key in EDGE_NATIVE_KEYS
                   else ep.key in (edge.get("properties") or {}))
        return not present if ep.negate else present
    if isinstance(ep, EdgePropertyPredicate):
        if ep.key in EDGE_NATIVE_KEYS:
            return evaluate(edge.get(ep.key), resolve_predicate(ep))
        return json_holds(edge.get("properties"), ep.key, resolve_predicate(ep))
    raise CompileError(f"stub: unsupported edge predicate {type(ep).__name__}")


def _matches(node: Dict[str, Any], predicate, graph=None) -> bool:
    """Walk the predicate tree against an in-memory node dict.

    ``graph`` (the stub) answers what needs more than the node: its
    relationships and degree. Unsupported kinds raise ``CompileError`` with
    a clear message — the stub is honest about what it can do rather than
    silently returning wrong results.
    """
    if isinstance(predicate, GroupPredicate):
        if predicate.op == "and":
            return all(_matches(node, c, graph) for c in predicate.children)
        if predicate.op == "or":
            return any(_matches(node, c, graph) for c in predicate.children)
        if predicate.op == "not":
            # Validator enforces exactly one child.
            return not _matches(node, predicate.children[0], graph)
        raise CompileError(f"stub: unsupported group op {predicate.op!r}")

    if isinstance(predicate, RelatedPredicate) and graph is not None:
        return graph._relation_holds(node, predicate)

    if isinstance(predicate, DegreePredicate) and graph is not None:
        return graph._degree(node["urn"], predicate)

    if type(predicate) in _SUGAR and graph is not None:
        direction, op, value = _SUGAR[type(predicate)]
        return graph._degree(node["urn"], DegreePredicate(
            direction=direction, op=op, value=value, edgeClass=predicate.edge_class,
            edgeTypes=predicate.edge_types))

    if isinstance(predicate, MatchAllPredicate):
        return True

    if isinstance(predicate, IsPredicate):
        urns = set()
        for ref in predicate.refs:
            if ref.urn is None:
                raise CompileError(f"is: the name reference '{ref.label()}' was not resolved")
            urns.add(ref.urn)
        return node.get("urn") in urns

    if isinstance(predicate, EntityTypePredicate):
        et = node.get("entityType")
        if predicate.op == "in":
            return et in set(predicate.values)
        if predicate.op == "notIn":
            return et not in set(predicate.values)
        raise CompileError(f"stub: unsupported entityType op {predicate.op!r}")

    if isinstance(predicate, LayerPredicate):
        target = getattr(predicate, "_placement", None)
        if target is not None and graph is not None:
            return graph._layer_of(node["urn"], target) == target.layer_id
        return node.get("layerAssignment") == predicate.layer_assignment

    if isinstance(predicate, TextPredicate):
        # Mirror the FalkorDB compiler's column mapping (see
        # ``_visit_text`` in ``falkordb_deep_search.py``):
        #   name           → displayName + qualifiedName
        #   qualifiedName  → qualifiedName
        #   description    → description
        #   tags           → tag list
        #   any            → searchableText + displayName + qualifiedName
        # Otherwise the stub silently produces different results than
        # production for the same predicate. Each column is evaluated
        # SEPARATELY (a match on displayName OR a match on
        # qualifiedName) — never a space-joined haystack across fields
        # — so exact/prefix/suffix semantics hold per field.
        target = predicate.target or "any"
        if target == "property" and predicate.property_key:
            # Same typed text comparison the compiler makes for it.
            op = {"exact": "eq", "prefix": "startsWith",
                  "suffix": "endsWith"}.get(predicate.match, "contains")
            return evaluate(
                node.get(predicate.property_key),
                resolve_comparison(op, predicate.value, value_type="string",
                                   case_sensitive=predicate.case_sensitive),
            )
        needle = (predicate.value or "").lower()
        if not needle:
            return True
        if target == "name":
            cols = ("displayName", "qualifiedName")
        elif target == "qualifiedName":
            cols = ("qualifiedName",)
        elif target == "description":
            cols = ("description",)
        elif target == "tags":
            cols = ("tags",)
        elif target == "any":
            cols = ("searchableText", "displayName", "qualifiedName")
        else:
            cols = (target,)

        def _field(key: str) -> str:
            v = node.get(key)
            if isinstance(v, list):
                return " ".join(str(x) for x in v).lower()
            return str(v or "").lower()

        for key in cols:
            value = _field(key)
            if predicate.match == "exact":
                matched = value == needle
            elif predicate.match == "prefix":
                matched = value.startswith(needle)
            elif predicate.match == "suffix":
                matched = value.endswith(needle)
            else:  # substring (default)
                matched = needle in value
            if matched:
                return True
        return False

    if isinstance(predicate, PropertyPredicate):
        # The reference evaluator IS the compiled Cypher's meaning (the
        # live parity test holds them together), so the stub answers a
        # typed comparison exactly as FalkorDB would.
        try:
            cmp = resolve_predicate(predicate)
        except SemanticsError as exc:
            raise CompileError(f"property {predicate.key!r}: {exc}") from exc
        if predicate.value_key:
            return evaluate_keys(node.get(predicate.key), node.get(predicate.value_key), cmp)
        return evaluate(node.get(predicate.key), cmp)

    if isinstance(predicate, HasPropertyPredicate):
        if predicate.key_match == "exact":
            present = node.get(predicate.key) is not None
        else:
            needle = fold_case(predicate.key)
            present = any(
                (fold_case(k).startswith(needle) if predicate.key_match == "prefix"
                 else needle in fold_case(k))
                for k, v in node.items()
                if k not in _NODE_FIELDS and v is not None
            )
        return not present if predicate.negate else present

    if isinstance(predicate, TagPredicate):
        tags = set(node.get("tags") or [])
        wanted = set(predicate.values)
        if predicate.op == "has":
            return bool(wanted & tags) and len(wanted) == 1
        if predicate.op == "hasAny":
            return bool(wanted & tags)
        if predicate.op == "hasAll":
            return wanted <= tags
        if predicate.op == "notHas":
            return not (wanted & tags)
        raise CompileError(f"stub: unsupported tag op {predicate.op!r}")

    raise CompileError(
        f"stub: predicate kind {type(predicate).__name__} not implemented. "
        f"Extend backend/graph/adapters/stub_deep_search.py as tests need it."
    )


def _to_search_hit(node: Dict[str, Any]) -> SearchHit:
    """Coerce a fixture node dict into a ``SearchHit`` for response."""
    return SearchHit(
        node={
            "urn": node["urn"],
            "entityType": node.get("entityType", "unknown"),
            "displayName": node.get("displayName", ""),
            "qualifiedName": node.get("qualifiedName"),
            "description": node.get("description"),
            "tags": node.get("tags") or [],
            "layerAssignment": node.get("layerAssignment"),
        },
        score=1.0,
        matched_predicates=[],
        highlights=[],
        ancestor_path=[],
    )
