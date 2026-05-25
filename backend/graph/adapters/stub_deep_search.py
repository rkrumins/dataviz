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
from backend.common.models.search import (
    EntityTypePredicate,
    GroupPredicate,
    HasPropertyPredicate,
    LayerPredicate,
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
        # Entity-type clamp from scope (resolver-stamped).
        if query.scope.entity_types:
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
            deadline_exceeded=False,
            elapsed_ms=elapsed_ms,
            cache_hit=False,
        )

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
        # Default target='any' searches displayName + qualifiedName +
        # description + tag list. Match modes: substring, exact, prefix.
        target = predicate.target or "any"
        needle = (predicate.value or "").lower()
        if not needle:
            return True
        if target == "any":
            haystack = " ".join(
                str(node.get(k) or "") for k in
                ("displayName", "qualifiedName", "description")
            ).lower()
            tags_text = " ".join(node.get("tags") or []).lower()
            haystack = f"{haystack} {tags_text}"
        else:
            haystack = str(node.get(target) or "").lower()
        if predicate.match == "exact":
            return haystack == needle
        if predicate.match == "prefix":
            return haystack.startswith(needle)
        # default substring
        return needle in haystack

    if isinstance(predicate, PropertyPredicate):
        v = node.get(predicate.key)
        op = predicate.op
        target = predicate.value
        if op == "eq":
            return v == target
        if op == "neq":
            return v != target
        if op == "gt":
            return v is not None and v > target
        if op == "gte":
            return v is not None and v >= target
        if op == "lt":
            return v is not None and v < target
        if op == "lte":
            return v is not None and v <= target
        if op == "in":
            return v in set(target or [])
        if op == "notIn":
            return v not in set(target or [])
        if op == "contains":
            return v is not None and str(target) in str(v)
        if op == "startsWith":
            return isinstance(v, str) and v.startswith(str(target))
        if op == "endsWith":
            return isinstance(v, str) and v.endswith(str(target))
        if op == "between":
            lo, hi = target  # validator ensures 2-tuple
            return v is not None and lo <= v <= hi
        raise CompileError(f"stub: unsupported property op {op!r}")

    if isinstance(predicate, HasPropertyPredicate):
        return predicate.key in node and node[predicate.key] is not None

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
