"""Cypher-text golden for FalkorDBProvider (PR1 decoupling, safety net #2).

The contract snapshot (``backend/tests/regression``) pins the provider's
ANSWERS — the same fixture in, the same rows out, regardless of which module
the code that produced them lives in after the carve. It cannot tell an
index-seeking query from a scanning one that happens to return the same six
rows today and cost 300ms/call on a two-million-node graph tomorrow.

This test pins the QUESTIONS: the literal Cypher text (and the shape of the
parameters bound to it) FalkorDBProvider sends to the database, for one
fixed, ordered script of calls covering every surface two later steps of the
PR1 decoupling touch — an executor behind the five query chokepoints
(step 11), then a dialect object for ~20 hard-coded Cypher fragments
(step 12: ``CALL db.labels()``, index DDL, the ``CALL {} … UNION``
label-union builder, the ``NOT (n)<-[:T]-()`` negation predicate, among
others). Both must be byte-identical in the Cypher they emit; this golden
is the gate that proves it.

Recorded against the UN-refactored provider (11,333 lines, untouched) so the
captured strings are the pre-refactor truth.

Recording technique
--------------------
Same shape as ``backend/tests/test_cypher_shapes.py``: a ``FalkorDBProvider``
built directly (no real connection — ``_ensure_connected`` is a no-op), with
recording fakes standing in for every place Cypher can leave the provider:

* the five query chokepoints (``_ro_query``, ``_ro_query_tolerant``,
  ``_query``, ``_proj_ro_query``, ``_proj_query``) are replaced directly,
  each tagged with its own name;
* the direct driver-handle bypasses that skip the chokepoints entirely
  (``self._graph.query`` / ``.ro_query``, ``self._proj.query`` /
  ``.ro_query`` — see ``_FakeGraphHandle`` below for exactly which methods
  reach these) are caught by fakes on ``p._graph`` and ``p._proj_graph``,
  kept as two DISTINCT objects by constructing with
  ``projection_mode="dedicated"`` — with the default "in_source" mode
  ``self._proj`` just returns ``self._graph`` and the two bypass families
  would be indistinguishable in the golden;
* the urn→label cache (``_get_cached_label``, ``_label_buckets``) is a
  small fixed dict, exactly as ``test_cypher_shapes.py`` stubs it, so
  anchors take the label-QUALIFIED (index-seeking) shape without a live
  graph to resolve labels against;
* the cache Redis (``p._redis``) is a permanent-miss fake. Every call site
  it reaches (ancestor-chain cache, regime/stats memoization) is ALREADY
  designed to degrade to a live-Cypher fallback when the cache Redis is
  unreachable (see ``_redis_available`` in ``_ensure_connected``) — this
  fake exercises exactly that already-supported path instead of raising
  AttributeError on an attribute ``_ensure_connected`` never got to set.
  A permanent miss is not the same as a REACHABLE-and-WARM cache, though:
  ``get_stats`` and ``get_ontology_metadata`` both return on a cache HIT
  before issuing any Cypher at all, so this golden only pins their COLD
  path — see task-2-report.md.

Every chokepoint call succeeds with an EMPTY result set (test_cypher_shapes.py's
own default). No driven call needs a populated row to reach ITS OWN Cypher —
every call attempts its query regardless of what comes back — so the walks in
trace_at_level / trace_closure / trace_closure_coarse / expand_aggregated
terminate after their first wave instead of hydrating a synthetic graph. What
this golden pins is the SHAPE of the question each surface asks first, not an
exhaustive walk of every internal branch a populated graph could reach — see
task-2-report.md for what that does and doesn't cover.

Determinism
-----------
``_get_containment_edge_types()`` / ``_get_lineage_edge_types()`` return
``Set[str]``; Python hash-randomises string hashing per process, so an
unsorted ``"|".join(some_set)`` relationship-type alternation renders in a
different member order on every run. That non-determinism is already in
production; a golden that fails on it is a golden nobody can keep green.

``_sort_rel_alternation`` sorts the ``|``-separated members inside every
bracketed relationship pattern (``[r:A|B]``, ``[:A|B|C]``, ``[c:A|B*1..10]``)
— nothing else about the string is touched, so a MEMBERSHIP change
(``A|B`` vs ``A|B|C``) still fails the diff. ``_normalize_params`` does the
same for list-VALUED params: some call sites (e.g. ``get_children`` with
more than one containment type) pass the type set to Cypher as a bound
``$relTypes`` list rather than baking it into the text, and a bare
``list(some_set)`` is exactly as hash-order-random as the text form.

Multi-element ontology types (``["CONTAINS", "HAS_PART"]`` containment,
``["DERIVES_FROM", "FLOWS_TO"]`` lineage) are injected for exactly this
reason — a single-element set is trivially stable and would exercise no
alternation-building code at all.

Do not extend either normaliser to "fix" a future failure it did not
already cover — a new failure means the provider changed what it asks,
which is precisely what this golden exists to catch.

Verify
------
Capture:      UPDATE_CYPHER_GOLDEN=1 "$PY" -m pytest tests/test_falkordb_cypher_golden.py -q
Compare (x3): "$PY" -m pytest tests/test_falkordb_cypher_golden.py -q
No database:  this provider is never connected — stopping the FalkorDB
              container this file's neighbours use does not affect it.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from backend.app.providers.falkordb_provider import FalkorDBProvider, _encode_keyset_cursor
from backend.common.models.graph import EdgeQuery, GraphEdge, GraphNode, NodeQuery

GOLDEN_PATH = Path(__file__).parent / "golden" / "falkordb_cypher.json"


class _FakeResult:
    """Stand-in for a FalkorDB query result — always empty. No driven call
    in this script needs a populated row to reach its OWN Cypher; see the
    module docstring for what that does and doesn't exercise downstream."""

    def __init__(self, rows: Optional[list] = None) -> None:
        self.result_set = rows or []


class _FakePipeline:
    """No-op chainable Redis pipeline. Every queued op (``hget``, ``hset``,
    ``execute_command``, ...) is answered generically via ``__getattr__``;
    ``.execute()`` raises so a pipelined cache lookup — always wrapped in
    try/except in the provider — degrades to a clean cache-miss instead of
    returning a reply list whose length doesn't match the queued op count."""

    def __getattr__(self, _name: str):
        def _queue(*_a: Any, **_k: Any) -> "_FakePipeline":
            return self
        return _queue

    async def execute(self) -> list:
        raise RuntimeError("fake pipeline: no batched replies")


class _FakeRedis:
    """Permanent cache-miss stand-in for the cache Redis client. ``self._redis``
    is only ever assigned inside ``_ensure_connected`` (stubbed to a no-op
    below), so without this every ``self._redis.*`` call site a driven call
    reaches (urn-label cache, ancestor-chain cache, regime/stats
    memoization) would raise AttributeError instead of degrading the way
    the provider already does when the cache Redis is unreachable in
    production (``_redis_available = False``)."""

    async def get(self, *_a: Any, **_k: Any) -> None: return None
    async def set(self, *_a: Any, **_k: Any) -> bool: return True
    async def setex(self, *_a: Any, **_k: Any) -> bool: return True
    async def hget(self, *_a: Any, **_k: Any) -> None: return None
    async def hset(self, *_a: Any, **_k: Any) -> int: return 0
    async def hdel(self, *_a: Any, **_k: Any) -> int: return 0
    async def expire(self, *_a: Any, **_k: Any) -> bool: return True
    async def delete(self, *_a: Any, **_k: Any) -> int: return 0
    async def scan(self, cursor: int = 0, match: Any = None, count: Any = None) -> tuple:
        return (0, [])
    async def execute_command(self, *_a: Any, **_k: Any) -> None: return None
    async def aclose(self) -> None: return None

    def pipeline(self, transaction: bool = False) -> _FakePipeline:
        return _FakePipeline()


class _FakeGraphHandle:
    """Stands in for the redis-py FalkorDB Graph handle (``p._graph`` /
    ``p._proj_graph``) for the call sites that skip the query chokepoints
    entirely: ``ensure_indices`` and ``_check_levels_backfilled`` call
    ``self._graph.query`` directly; ``_log_aggregation_index_health`` and
    ``_ensure_label_urn_indexes`` call ``self._proj.query`` / ``.ro_query``
    directly. ``_ensure_label_urn_indexes`` is LIVE (not reached by this
    script — it fires from ``falkordb_materialize.AggregationPipeline
    ._write_items`` when aggregation writes hit a new label; see
    task-2-report.md), not the dead code an earlier version of this file
    claimed. ``sink`` names which attribute this instance stands in for,
    so a bypass call stays distinguishable from a chokepoint call in the
    recorded golden."""

    def __init__(self, store: List[Dict[str, Any]], sink: str) -> None:
        self._store = store
        self._sink = sink

    async def query(self, cypher: str, params: Optional[dict] = None, *_a: Any, **_k: Any) -> _FakeResult:
        _record(self._store, f"{self._sink}.query", cypher, params)
        return _FakeResult()

    async def ro_query(self, cypher: str, params: Optional[dict] = None, *_a: Any, **_k: Any) -> _FakeResult:
        _record(self._store, f"{self._sink}.ro_query", cypher, params)
        return _FakeResult()


# ---------------------------------------------------------------------------
# Normalisation — see "Determinism" in the module docstring. This is the
# ONLY massaging a recorded string/param ever gets:
#   1. sort the `|`-separated members inside a bracketed relationship
#      pattern ([r:A|B], [:A|B|C], [c:A|B*1..10]);
#   2. sort any list-VALUED param (a Set->list conversion is exactly as
#      hash-order-random as the text form above).
# A membership change (A|B -> A|B|C, or a param gaining/losing an entry)
# still fails the diff — only run-to-run ORDER noise is removed.
# ---------------------------------------------------------------------------
_REL_ALTERNATION = re.compile(
    r"\[([a-zA-Z_][a-zA-Z0-9_]*)?:([A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)+)((?:\*[^\]]*)?)\]"
)


def _sort_rel_alternation(cypher: str) -> str:
    def _sub(m: "re.Match[str]") -> str:
        var, alternation, suffix = m.group(1) or "", m.group(2), m.group(3) or ""
        return f"[{var}:{'|'.join(sorted(alternation.split('|')))}{suffix}]"
    return _REL_ALTERNATION.sub(_sub, cypher)


def _normalize_params(params: Optional[dict]) -> dict:
    if not params:
        return {}
    return {
        k: (sorted(v, key=str) if isinstance(v, list) else v)
        for k, v in params.items()
    }


def _record(store: List[Dict[str, Any]], sink: str, cypher: str, params: Optional[dict]) -> None:
    store.append({
        "sink": sink,
        "cypher": _sort_rel_alternation(cypher),
        "params": _normalize_params(params),
    })


def _make_chokepoint(store: List[Dict[str, Any]], sink: str):
    async def _rec(cypher: str, params: Optional[dict] = None, *, timeout: Any = None, op: Any = None) -> _FakeResult:
        _record(store, sink, cypher, params)
        return _FakeResult()
    return _rec


# ---------------------------------------------------------------------------
# Fixture identities. Every chokepoint returns empty rows (no live graph),
# so what matters is which URNs carry a KNOWN label — the label-qualified,
# index-seeking anchor shape — and which don't (the unlabeled residue-
# bucket shape); see `_get_cached_label` / `_label_buckets` in
# `_make_provider` below.
# ---------------------------------------------------------------------------
URN_ROOT = "urn:golden:domain:root"
URN_CONTAINER = "urn:golden:container:c1"
URN_D1 = "urn:golden:dataset:d1"
URN_D2 = "urn:golden:dataset:d2"
URN_D3 = "urn:golden:dataset:d3"
URN_UNKNOWN = "urn:golden:dataset:unknown"  # no entry below -> residue bucket

_LABELS = {
    URN_ROOT: "Domain",
    URN_CONTAINER: "Container",
    URN_D1: "Dataset",
    URN_D2: "Dataset",
    URN_D3: "Dataset",
}

# Multi-element on purpose — see "Determinism" above.
CONTAINMENT_TYPES = ["CONTAINS", "HAS_PART"]
LINEAGE_TYPES = ["DERIVES_FROM", "FLOWS_TO"]


def _make_provider() -> FalkorDBProvider:
    """A FalkorDBProvider wired exactly like ``test_cypher_shapes.py``'s
    ``_make_provider``, extended to cover the four query-chokepoint
    bypasses and the cache Redis (see module docstring)."""
    p = FalkorDBProvider(
        host="cypher-golden", port=16379, graph_name="cypher-golden-graph",
        # "dedicated" so `self._proj` resolves to `self._proj_graph` — a
        # SEPARATE fake from `self._graph` — instead of aliasing it, which
        # is what the default "in_source" mode does; aliased, the two
        # bypass families below would be indistinguishable in the golden.
        projection_mode="dedicated",
    )
    recorded: List[Dict[str, Any]] = []
    p.recorded = recorded

    async def _noop() -> None:
        return None
    p._ensure_connected = _noop

    for sink in ("_ro_query", "_ro_query_tolerant", "_query", "_proj_ro_query", "_proj_query"):
        setattr(p, sink, _make_chokepoint(recorded, sink))

    p._graph = _FakeGraphHandle(recorded, "graph")
    p._proj_graph = _FakeGraphHandle(recorded, "proj_graph")
    p._redis = _FakeRedis()

    labels = dict(_LABELS)

    async def _cached_label(urn: str) -> Optional[str]:
        return labels.get(urn)

    async def _buckets(urns: List[str]) -> List[Tuple[str, List[str]]]:
        by: Dict[str, List[str]] = {}
        for u in dict.fromkeys(u for u in urns if u):
            by.setdefault(labels.get(u) or "", []).append(u)
        return sorted(by.items())

    p._get_cached_label = _cached_label
    p._label_buckets = _buckets

    p.set_containment_edge_types(CONTAINMENT_TYPES, from_ontology=True)
    p.set_resolved_edge_metadata({}, LINEAGE_TYPES)
    return p


async def _step(entries: List[Dict[str, Any]], recorded: List[Dict[str, Any]], name: str, coro: Any) -> None:
    start = len(recorded)
    try:
        await coro
    except Exception as exc:
        raise AssertionError(
            f"driving {name!r} raised {exc!r} before/while emitting Cypher — "
            "that is a bug in the driver, not an acceptable outcome (every "
            "call in the drive list must contribute a recorded query)."
        ) from exc
    queries = recorded[start:]
    if not queries:
        raise AssertionError(f"{name!r} reached no chokepoint/bypass — emitted zero Cypher")
    entries.append({"call": name, "queries": queries})


async def _drive(p: FalkorDBProvider) -> List[Dict[str, Any]]:
    """One fixed, ordered script — see the task-2 brief's "What to drive"
    list, which this mirrors in order.

    Order matters for ``_type_casing_maps`` at the end: it has its own 60s
    in-process TTL cache, and ``save_custom_graph`` / ``create_node`` /
    ``create_edge`` above call it internally too — whichever call reaches
    it FIRST owns the ``CALL db.relationshipTypes()`` / ``CALL db.labels()``
    probe for the rest of the window. The explicit reset right before the
    dedicated call (below) is what keeps ITS entry from silently recording
    zero queries as a cache hit.
    """
    entries: List[Dict[str, Any]] = []
    recorded = p.recorded

    async def step(name: str, coro: Any) -> None:
        await _step(entries, recorded, name, coro)

    # -- node reads ----------------------------------------------------
    await step("get_node", p.get_node(URN_D1))
    await step(
        "get_nodes:by_urns",
        p.get_nodes(NodeQuery(urns=[URN_D1, URN_D2, URN_UNKNOWN], include_child_count=True)),
    )
    await step(
        "get_nodes:by_entity_types",
        p.get_nodes(NodeQuery(entity_types=["Dataset", "Container"], limit=50)),
    )
    await step("get_nodes:bare", p.get_nodes(NodeQuery(limit=10)))

    # -- edge reads ------------------------------------------------------
    await step("get_edges:typed", p.get_edges(EdgeQuery(edge_types=LINEAGE_TYPES, limit=100)))
    await step(
        "get_edges:anchored_by_source_urns",
        p.get_edges(EdgeQuery(source_urns=[URN_D1, URN_D2], edge_types=["DERIVES_FROM"], limit=50)),
    )

    # -- containment reads -------------------------------------------------
    await step("get_children:first_page", p.get_children(URN_ROOT, limit=20))
    cursor = _encode_keyset_cursor("Container A", URN_CONTAINER, "asc")
    await step("get_children:cursor", p.get_children(URN_ROOT, limit=20, cursor=cursor))
    await step("get_children_with_edges", p.get_children_with_edges(URN_ROOT, limit=20))
    await step("get_parent", p.get_parent(URN_D1))

    await step("get_top_level_or_orphan_nodes:default", p.get_top_level_or_orphan_nodes(limit=20))
    await step(
        "get_top_level_or_orphan_nodes:entity_types",
        p.get_top_level_or_orphan_nodes(entity_types=["Dataset", "Container"], limit=20),
    )
    await step(
        "get_top_level_or_orphan_nodes:cursor",
        p.get_top_level_or_orphan_nodes(limit=20, cursor=cursor),
    )

    await step("get_nodes_by_layer", p.get_nodes_by_layer("layer-1", limit=20))
    await step("get_descendants", p.get_descendants(URN_ROOT, depth=3, limit=20))
    await step("get_ancestors", p.get_ancestors(URN_D1, limit=20))
    await step("get_nodes_by_tag", p.get_nodes_by_tag("pii", limit=20))
    await step("get_nodes_batch", p.get_nodes_batch([URN_D1, URN_D2, URN_UNKNOWN]))
    await step("get_node_degrees", p.get_node_degrees([URN_D1, URN_D2], LINEAGE_TYPES))

    # -- stats / schema / ontology introspection ---------------------------
    await step("get_stats", p.get_stats())
    await step("get_counts_fast", p.get_counts_fast())
    await step("get_schema_stats", p.get_schema_stats())
    await step("get_ontology_metadata", p.get_ontology_metadata())
    await step("get_distinct_values", p.get_distinct_values("sourceSystem"))

    # -- schema reconciliation ---------------------------------------------
    await step("ensure_indices", p.ensure_indices(["GoldenType"]))
    await step("ensure_projections", p.ensure_projections())

    # -- trace v2 ------------------------------------------------------------
    await step(
        "trace_at_level",
        p.trace_at_level(
            URN_D1, level=0, upstream_depth=1, downstream_depth=1,
            lineage_edge_types=LINEAGE_TYPES, containment_edge_types=CONTAINMENT_TYPES,
            max_nodes=50, timeout_ms=5000,
        ),
    )
    await step(
        "trace_closure",
        p.trace_closure(
            URN_D1, upstream_depth=1, downstream_depth=1,
            lineage_edge_types=LINEAGE_TYPES, containment_edge_types=CONTAINMENT_TYPES,
            max_nodes=50, timeout_ms=5000,
        ),
    )
    await step(
        "trace_closure_coarse",
        p.trace_closure_coarse(
            URN_D1, direction="both", aggregated_edge_type="AGGREGATED",
            containment_edge_types=CONTAINMENT_TYPES, max_cells=20, timeout_ms=5000,
        ),
    )
    await step(
        "expand_aggregated",
        p.expand_aggregated(
            URN_D1, URN_D2, next_level=1,
            lineage_edge_types=LINEAGE_TYPES, containment_edge_types=CONTAINMENT_TYPES,
            max_nodes=50, timeout_ms=5000,
        ),
    )
    await step(
        "get_aggregated_edges_between",
        p.get_aggregated_edges_between([URN_D1, URN_D2], None, None, CONTAINMENT_TYPES, LINEAGE_TYPES),
    )

    # -- write path ----------------------------------------------------------
    await step(
        "save_custom_graph",
        p.save_custom_graph(
            nodes=[
                GraphNode(urn=URN_ROOT, entityType="Domain", displayName="Root"),
                GraphNode(urn=URN_D1, entityType="Dataset", displayName="D1"),
                GraphNode(urn=URN_D2, entityType="Dataset", displayName="D2"),
            ],
            edges=[
                GraphEdge(id="golden-c1", sourceUrn=URN_ROOT, targetUrn=URN_D1, edgeType="CONTAINS"),
                GraphEdge(id="golden-l1", sourceUrn=URN_D1, targetUrn=URN_D2, edgeType="DERIVES_FROM"),
            ],
        ),
    )
    await step(
        "create_node",
        p.create_node(
            GraphNode(urn=URN_D3, entityType="Dataset", displayName="D3"),
            containment_edge=GraphEdge(id="golden-c2", sourceUrn=URN_ROOT, targetUrn=URN_D3, edgeType="CONTAINS"),
        ),
    )
    await step(
        "create_edge",
        p.create_edge(GraphEdge(id="golden-l2", sourceUrn=URN_D3, targetUrn=URN_D2, edgeType="FLOWS_TO")),
    )
    await step("update_edge", p.update_edge("golden-l2", {"note": "golden"}))
    await step("delete_edge", p.delete_edge("golden-l2"))

    # See the "Order matters" note in this function's docstring.
    p._casing_maps_cache = None
    await step("_type_casing_maps", p._type_casing_maps())

    return entries


def _diff_message(expected: List[Dict[str, Any]], actual: List[Dict[str, Any]]) -> str:
    expected_by_call = {e["call"]: e["queries"] for e in expected}
    actual_by_call = {e["call"]: e["queries"] for e in actual}
    blocks = []
    for call in sorted(set(expected_by_call) | set(actual_by_call)):
        exp_q, act_q = expected_by_call.get(call), actual_by_call.get(call)
        if exp_q != act_q:
            blocks.append(
                f"--- {call} ---\n"
                f"expected:\n{json.dumps(exp_q, indent=2, sort_keys=True)}\n"
                f"actual:\n{json.dumps(act_q, indent=2, sort_keys=True)}"
            )
    return (
        "Cypher golden mismatch — the provider is asking the database a "
        "DIFFERENT question than before.\n"
        "To re-capture (only after confirming the new Cypher is correct):\n"
        f"  UPDATE_CYPHER_GOLDEN=1 \"$PY\" -m pytest {__file__} -q\n\n"
        + "\n\n".join(blocks)
    )


def test_falkordb_cypher_golden() -> None:
    p = _make_provider()
    entries = asyncio.new_event_loop().run_until_complete(_drive(p))
    encoded = json.dumps(entries, indent=2, sort_keys=True, default=str)

    if os.getenv("UPDATE_CYPHER_GOLDEN") == "1" or not GOLDEN_PATH.exists():
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(encoded + "\n", encoding="utf-8")
        return

    expected = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    actual = json.loads(encoded)
    if expected != actual:
        raise AssertionError(_diff_message(expected, actual))
