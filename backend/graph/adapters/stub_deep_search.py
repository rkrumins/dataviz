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
from backend.common.search_semantics import (
    SemanticsError,
    element_texts,
    evaluate,
    fold_case,
    resolve_comparison,
    resolve_predicate,
    value_slot,
)
from backend.common.models.search import (
    EntityTypePredicate,
    GroupPredicate,
    HasPropertyPredicate,
    LayerPredicate,
    MatchAllPredicate,
    PropertyPredicate,
    SearchHit,
    SearchQuery,
    SearchResultPage,
    TagPredicate,
    TextPredicate,
)


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
    ) -> None:
        self._nodes: List[Dict[str, Any]] = list(nodes)
        self._edges: List[Dict[str, Any]] = list(edges)

    # --- DeepSearchProvider Protocol -----------------------------------------

    async def deep_search(
        self,
        query: SearchQuery,
        *,
        deadline_ms: Optional[int] = None,
    ) -> SearchResultPage:
        start = time.monotonic()
        matches = [n for n in self._nodes if _matches(n, query.predicate)]

        # Apply scope clamp if root_urns are set. Simple containment:
        # match nodes whose urn IS one of the root_urns OR whose
        # ``ancestorUrns`` list contains a root urn.
        if query.scope.root_urns:
            roots = set(query.scope.root_urns)
            matches = [
                n for n in matches
                if n.get("urn") in roots
                or any(a in roots for a in n.get("ancestorUrns", []))
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
        count = sum(1 for n in self._in_scope(query.scope) if _matches(n, query.predicate))
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
                matches[item_id] = [n["urn"] for n in nodes if _matches(n, predicate)]
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
                     or any(a in roots for a in n.get("ancestorUrns", []))]
        elif scope.entity_types:
            allowed = set(scope.entity_types)
            nodes = [n for n in nodes if n.get("entityType") in allowed]
        return nodes

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


def _matches(node: Dict[str, Any], predicate) -> bool:
    """Walk the predicate tree against an in-memory node dict.

    Only the predicate kinds the test suite exercises today are
    supported. Unsupported kinds raise ``CompileError`` with a clear
    message — the stub is honest about what it can do rather than
    silently returning wrong results.
    """
    if isinstance(predicate, GroupPredicate):
        if predicate.op == "and":
            return all(_matches(node, c) for c in predicate.children)
        if predicate.op == "or":
            return any(_matches(node, c) for c in predicate.children)
        if predicate.op == "not":
            # Validator enforces exactly one child.
            return not _matches(node, predicate.children[0])
        raise CompileError(f"stub: unsupported group op {predicate.op!r}")

    if isinstance(predicate, MatchAllPredicate):
        return True

    if isinstance(predicate, EntityTypePredicate):
        et = node.get("entityType")
        if predicate.op == "in":
            return et in set(predicate.values)
        if predicate.op == "notIn":
            return et not in set(predicate.values)
        raise CompileError(f"stub: unsupported entityType op {predicate.op!r}")

    if isinstance(predicate, LayerPredicate):
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
