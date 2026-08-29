"""Shared runner that exercises a GraphDataProvider through every
ABC method that matters for the reshape and asserts on snapshots.

Both the FalkorDB and Neo4j contract tests delegate here so the
behaviour pin is *exactly* identical across providers (modulo
provider-specific field shapes which the snapshot stabilises before
diff).
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Optional

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import EdgeQuery, NodeQuery

from .fixtures import (
    ENTITY_LEVELS,
    containment_types,
    fixture_edges,
    fixture_nodes,
    lineage_types,
)
from .snapshot import assert_snapshot


async def seed(provider: GraphDataProvider) -> None:
    """Inject the fixture into a clean provider instance.

    Caller is responsible for handing us a graph that has been
    truncated; we don't try to delete-then-recreate here because the
    cleanup primitives differ across providers.
    """
    provider.set_containment_edge_types(containment_types(), from_ontology=True)
    if hasattr(provider, "set_entity_type_levels"):
        provider.set_entity_type_levels(ENTITY_LEVELS)
    if hasattr(provider, "set_resolved_edge_metadata"):
        provider.set_resolved_edge_metadata({}, lineage_types())
    if hasattr(provider, "ensure_indices"):
        try:
            await provider.ensure_indices(list({n.entity_type for n in fixture_nodes()}))
        except Exception:
            pass
    await provider.save_custom_graph(fixture_nodes(), fixture_edges())


async def run_all(provider: GraphDataProvider, *, snapshot_label: str) -> None:
    """Exercise every ABC method we want to pin and snapshot the output."""
    # --- Node ops -------------------------------------------------------
    n = await provider.get_node("urn:test:dataset:d1")
    assert_snapshot(provider=snapshot_label, name="get_node", actual=n)

    nodes = await provider.get_nodes(NodeQuery(entity_types=["dataset"], limit=100))
    assert_snapshot(provider=snapshot_label, name="get_nodes_dataset", actual=nodes)

    found = await provider.search_nodes("Dataset", limit=10)
    assert_snapshot(provider=snapshot_label, name="search_nodes_Dataset", actual=found)

    # --- Edge ops -------------------------------------------------------
    edges = await provider.get_edges(EdgeQuery(edge_types=["CONTAINS"], limit=100))
    assert_snapshot(provider=snapshot_label, name="get_edges_contains", actual=edges)

    # --- Containment ----------------------------------------------------
    children = await provider.get_children("urn:test:domain:root")
    assert_snapshot(provider=snapshot_label, name="get_children_root", actual=children)

    parent = await provider.get_parent("urn:test:dataset:d1")
    assert_snapshot(provider=snapshot_label, name="get_parent_d1", actual=parent)

    cwe = await provider.get_children_with_edges(
        "urn:test:domain:root",
        edge_types=containment_types(),
        lineage_edge_types=lineage_types(),
        limit=100,
    )
    assert_snapshot(provider=snapshot_label, name="get_children_with_edges_root", actual=cwe)

    # --- Lineage --------------------------------------------------------
    lineage_full = await provider.get_full_lineage(
        "urn:test:dataset:d1", upstream_depth=3, downstream_depth=3,
    )
    assert_snapshot(provider=snapshot_label, name="get_full_lineage_d1", actual=lineage_full)

    upstream = await provider.get_upstream("urn:test:dataset:d2", depth=3)
    assert_snapshot(provider=snapshot_label, name="get_upstream_d2", actual=upstream)

    downstream = await provider.get_downstream("urn:test:dataset:d1", depth=3)
    assert_snapshot(provider=snapshot_label, name="get_downstream_d1", actual=downstream)

    # --- Trace v2 -------------------------------------------------------
    # The lineage edges only exist between datasets (level=2), so a
    # level=2 trace should return them; a level=1 trace exercises the
    # inherited-lineage fallback (the schema has no AGGREGATED yet).
    try:
        trace = await provider.trace_at_level(
            "urn:test:dataset:d1", level=2,
            upstream_depth=2, downstream_depth=2,
            lineage_edge_types=lineage_types(),
            containment_edge_types=containment_types(),
            max_nodes=50, timeout_ms=5000,
        )
        assert_snapshot(provider=snapshot_label, name="trace_at_level2_d1", actual=trace)
    except NotImplementedError:
        # Provider may not implement Trace v2 yet; pin the behaviour.
        assert_snapshot(provider=snapshot_label, name="trace_at_level2_d1", actual="NotImplementedError")

    # --- Aggregated edges (read path) -----------------------------------
    agg_count = await provider.count_aggregated_edges()
    assert_snapshot(provider=snapshot_label, name="count_aggregated_initial", actual=agg_count)

    # --- Schema introspection -------------------------------------------
    schema = await provider.discover_schema()
    # Schema can include sample property keys / counts that drift between
    # runs; capture a stable subset.
    schema_subset = {
        "labels": sorted(schema.get("labels") or []),
        "edgeTypes": sorted(
            schema.get("edgeTypes")
            or schema.get("relationshipTypes")
            or []
        ),
    }
    assert_snapshot(provider=snapshot_label, name="discover_schema_subset", actual=schema_subset)

    # --- Stats ----------------------------------------------------------
    stats = await provider.get_stats()
    # Provider field varies; only pin the counts.
    pinned_stats = {
        "nodeCount": int(stats.get("nodeCount") or 0),
        "edgeCount": int(stats.get("edgeCount") or 0),
    }
    assert_snapshot(provider=snapshot_label, name="get_stats", actual=pinned_stats)


async def _pin(
    *,
    snapshot_label: str,
    name: str,
    call: Awaitable[Any],
    normalize: Optional[Callable[[Any], Any]] = None,
) -> None:
    """Await ``call`` and snapshot the result, tolerating a provider that
    doesn't implement this surface yet (e.g. the ArcadeDB adapter arriving
    in a later PR): a ``NotImplementedError`` is pinned as the string
    ``"NotImplementedError"`` instead of failing the run.

    ``normalize``, when given, reshapes a *successful* result into its
    deterministic subset before it is snapshotted — for pins whose raw
    payload carries wall-clock timing or other cross-run-unstable data.
    """
    try:
        result: Any = await call
    except NotImplementedError:
        result = "NotImplementedError"
    else:
        if normalize is not None:
            result = normalize(result)
    assert_snapshot(provider=snapshot_label, name=name, actual=result)


async def _counts_fast_subset(provider: GraphDataProvider) -> Optional[Dict[str, int]]:
    """``get_counts_fast`` isn't on the ABC (it's a FalkorDB-only fast
    path — see ``_runner`` callers reaching it with ``getattr``). Absent,
    unsupported (the method itself returns ``None`` when counts can't be
    trusted), and an unimplemented raise all collapse to plain ``None``:
    every caller's fallback is the same regardless of which of the three
    it was — use ``get_stats`` instead.
    """
    fn = getattr(provider, "get_counts_fast", None)
    if fn is None:
        return None
    try:
        raw = await fn()
    except NotImplementedError:
        return None
    if not isinstance(raw, dict):
        return None
    return {"nodeCount": int(raw.get("nodeCount") or 0), "edgeCount": int(raw.get("edgeCount") or 0)}


async def run_extended(provider: GraphDataProvider, *, snapshot_label: str) -> None:
    """Exercise the surfaces ``run_all`` doesn't reach: top-level browse,
    batch node hydration, descendants/ancestors, layer browse, distinct
    values, node degrees, ontology metadata, aggregated-edge reads,
    aggregated expansion, and the trace-closure walk (the Lens walk).

    Every pin goes through ``_pin`` (or ``_counts_fast_subset``, itself
    optional-tolerant) so a provider missing a surface still produces a
    deterministic, well-defined snapshot instead of an uncaught error.
    """
    ctypes = containment_types()
    ltypes = lineage_types()

    # --- Top-level / orphan browse ---------------------------------------
    await _pin(
        snapshot_label=snapshot_label, name="top_level_default",
        call=provider.get_top_level_or_orphan_nodes(limit=50),
    )
    await _pin(
        snapshot_label=snapshot_label, name="top_level_entity_types_dataset",
        call=provider.get_top_level_or_orphan_nodes(entity_types=["dataset"], limit=50),
    )

    # --- Batch hydration / navigation ------------------------------------
    await _pin(
        snapshot_label=snapshot_label, name="get_nodes_batch_mixed",
        call=provider.get_nodes_batch(
            ["urn:test:dataset:d1", "urn:test:schema:s1", "urn:test:missing"]
        ),
    )
    await _pin(
        snapshot_label=snapshot_label, name="get_descendants_root",
        call=provider.get_descendants("urn:test:domain:root", depth=5, limit=50),
    )
    await _pin(
        snapshot_label=snapshot_label, name="get_ancestors_d1",
        call=provider.get_ancestors("urn:test:dataset:d1", limit=50),
    )
    await _pin(
        snapshot_label=snapshot_label, name="get_nodes_by_layer_empty",
        call=provider.get_nodes_by_layer("no-such-layer", limit=50),
    )

    # --- Vocabulary / degrees / ontology ----------------------------------
    await _pin(
        snapshot_label=snapshot_label, name="get_distinct_values_entity_type",
        call=provider.get_distinct_values("entityType"),
    )
    await _pin(
        snapshot_label=snapshot_label, name="get_node_degrees_datasets",
        call=provider.get_node_degrees(
            ["urn:test:dataset:d1", "urn:test:dataset:d2"], ltypes
        ),
    )
    await _pin(
        snapshot_label=snapshot_label, name="get_ontology_metadata",
        call=provider.get_ontology_metadata(),
    )

    # --- Aggregated edges (read + expand) ---------------------------------
    await _pin(
        snapshot_label=snapshot_label, name="aggregated_between_unmaterialized",
        call=provider.get_aggregated_edges_between(
            source_urns=["urn:test:schema:s1"],
            target_urns=["urn:test:schema:s2"],
            granularity="schema",
            containment_edges=ctypes,
            lineage_edges=ltypes,
        ),
    )
    await _pin(
        snapshot_label=snapshot_label, name="expand_aggregated_s1_s2",
        call=provider.expand_aggregated(
            source_urn="urn:test:schema:s1",
            target_urn="urn:test:schema:s2",
            next_level=2,
            lineage_edge_types=ltypes,
            containment_edge_types=ctypes,
            max_nodes=50,
            timeout_ms=5000,
        ),
    )

    # --- Trace closure (the Lens walk) ------------------------------------
    await _pin(
        snapshot_label=snapshot_label, name="trace_closure_d2_one_hop",
        call=provider.trace_closure(
            urn="urn:test:dataset:d2",
            upstream_depth=1,
            downstream_depth=1,
            lineage_edge_types=ltypes,
            containment_edge_types=ctypes,
            max_nodes=50,
            timeout_ms=5000,
        ),
    )
    # A container focus has no lineage of its own; the walk must seed from
    # its lineage-bearing descendants (d2, d3) instead of the focus itself.
    await _pin(
        snapshot_label=snapshot_label, name="trace_closure_container_s2",
        call=provider.trace_closure(
            urn="urn:test:schema:s2",
            upstream_depth=1,
            downstream_depth=1,
            lineage_edge_types=ltypes,
            containment_edge_types=ctypes,
            max_nodes=50,
            timeout_ms=5000,
        ),
    )
    # An excluded node is still walked FROM — the response should carry the
    # same edges as the one-hop pin above while shipping one fewer node.
    await _pin(
        snapshot_label=snapshot_label, name="trace_closure_d2_excluding_d1",
        call=provider.trace_closure(
            urn="urn:test:dataset:d2",
            upstream_depth=1,
            downstream_depth=1,
            lineage_edge_types=ltypes,
            containment_edge_types=ctypes,
            max_nodes=50,
            timeout_ms=5000,
            exclude_urns=["urn:test:dataset:d1"],
        ),
    )

    # --- Pins whose raw payload isn't deterministic across runs -----------
    assert_snapshot(
        provider=snapshot_label, name="counts_fast_subset",
        actual=await _counts_fast_subset(provider),
    )
    await _pin(
        snapshot_label=snapshot_label, name="list_graphs_shape",
        call=provider.list_graphs(),
        normalize=lambda graphs: {
            "isList": isinstance(graphs, list),
            "allStrings": all(isinstance(g, str) for g in graphs),
        },
    )
    await _pin(
        snapshot_label=snapshot_label, name="preflight_verdict",
        call=provider.preflight(deadline_s=2.0),
        normalize=lambda pr: {"ok": pr.ok, "reason": pr.reason},
    )
