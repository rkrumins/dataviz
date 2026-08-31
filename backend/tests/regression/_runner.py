"""Shared runner that exercises a GraphDataProvider through every
ABC method that matters for the reshape and asserts on snapshots.

Every contract test (FalkorDB, Neo4j, Spanner, and any future provider)
delegates here so the behaviour pin is *exactly* identical across
providers (modulo provider-specific field shapes which the snapshot
stabilises before diff). ``make_contract_test`` is the factory a
host:port-addressed provider (FalkorDB, Neo4j, and presumably PR 3's
ArcadeDB) uses to build its whole contract test in ~40 lines; a provider
addressed differently (Spanner has no host:port concept -- see
``catalog/spanner.py``) builds its own ``ProviderSpec`` and calls
``seed``/``run_all`` directly instead -- see
``test_spanner_provider_contract.py``.
"""
from __future__ import annotations

import json
import os
import socket
from typing import Any, Awaitable, Callable, Dict, Optional

import pytest

from backend.common.interfaces.provider import (
    GraphDataProvider,
    ProviderFeature,
    ProviderFeatureUnsupportedError,
    capability_for,
)
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

    The injection setters are called directly, not ``hasattr``-guarded:
    every concrete adapter reaching this function is a real
    ``GraphDataProvider`` built through the catalog, and the six
    ontology-injection setters plus ``ensure_indices`` are base-class
    members with working defaults (see ``GraphDataProvider``'s class
    docstring). ``hasattr`` tolerance is still warranted at production
    call sites that may see a non-``GraphDataProvider`` wrapper (e.g.
    ``VersionedBranchProvider``, which forwards only one of the six --
    see T-C's report) but this harness never constructs one of those.
    """
    provider.set_containment_edge_types(containment_types(), from_ontology=True)
    provider.set_entity_type_levels(ENTITY_LEVELS)
    provider.set_resolved_edge_metadata({}, lineage_types())
    try:
        await provider.ensure_indices(list({n.entity_type for n in fixture_nodes()}))
    except Exception:
        pass
    await provider.save_custom_graph(fixture_nodes(), fixture_edges())


async def run_all(
    provider: GraphDataProvider, *, snapshot_label: str, graph_name: Optional[str] = None,
) -> None:
    """Exercise every ABC method we want to pin and snapshot the output.

    ``graph_name``, when given, is the name ``seed`` wrote the fixture
    under -- used only to check ``list_graphs()`` actually lists it on a
    provider whose descriptor declares ``ProviderFeature.MULTI_GRAPH``.
    """
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

    # --- Stats ------------------------------------------------------------
    stats = await provider.get_stats()
    # Provider field varies; only pin the counts.
    pinned_stats = {
        "nodeCount": int(stats.get("nodeCount") or 0),
        "edgeCount": int(stats.get("edgeCount") or 0),
    }
    assert_snapshot(provider=snapshot_label, name="get_stats", actual=pinned_stats)

    # =====================================================================
    # The rest of the contract: surfaces that either weren't on the ABC at
    # all until T-A, or are optional by design (preflight). Folded into
    # this one function (formerly a separate ``run_extended`` only the
    # FalkorDB test called) so a single ``run_all`` call is the whole
    # contract -- the shape ``make_contract_test`` needs to stay a single
    # factory call per provider.
    # =====================================================================
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
    # get_nodes_batch is a base-class member with a working default
    # (delegates to get_nodes) since T-A -- a plain call, not
    # _call_optional; every GraphDataProvider has it.
    await _pin(
        snapshot_label=snapshot_label, name="get_nodes_batch_mixed",
        call=provider.get_nodes_batch(
            ["urn:test:dataset:d1", "urn:test:schema:s1", "urn:test:missing"],
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
        # `DISTINCT labels(n)[0]` carries no ORDER BY (see falkordb_provider.py);
        # a bare list of strings passes `_stabilize` unsorted (it only sorts
        # lists of dicts). Same treatment as discover_schema_subset's labels
        # above, and for the same reason.
        normalize=lambda values: sorted(values or []),
    )
    # get_node_degrees is also a base-class member with a working default
    # ({}) since T-A -- a plain call, same reasoning as get_nodes_batch.
    await _pin(
        snapshot_label=snapshot_label, name="get_node_degrees_datasets",
        call=provider.get_node_degrees(
            ["urn:test:dataset:d1", "urn:test:dataset:d2"], ltypes,
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
    # trace_closure is a base-class member since T-A, default raises
    # ProviderFeatureUnsupportedError -- _pin pins that as "unsupported"
    # (a declared "will never support this", distinct from the generic
    # "NotImplementedError" bare trace_at_level above pins for "not built
    # out yet"). Same structural idea as trace_at_level's try/except, just
    # expressed through the shared helper since there are three call sites
    # here instead of one.
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
    # An excluded node is still walked FROM -- the response should carry the
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

    # --- Pins whose raw payload isn't deterministic across runs, plus the
    #     two live invariants nothing should silently re-pin as "correct"
    #     if they ever go wrong -----------------------------------------
    counts_fast = await _counts_fast_subset(provider)
    assert_snapshot(provider=snapshot_label, name="counts_fast_subset", actual=counts_fast)
    if counts_fast is not None:
        assert counts_fast == pinned_stats, (
            f"{type(provider).__name__}.get_counts_fast() returned {counts_fast!r}, "
            f"which disagrees with get_stats() {pinned_stats!r}. get_counts_fast() "
            "must be either None (counters can't describe this graph) or agree "
            "with the exact count -- a caller that trusts a faster, wrong number "
            "is worse off than one that always pays for the exact one."
        )

    graphs = await provider.list_graphs()
    assert_snapshot(
        provider=snapshot_label, name="list_graphs_shape",
        actual={
            "isList": isinstance(graphs, list),
            "allStrings": all(isinstance(g, str) for g in graphs),
        },
    )
    if graph_name and capability_for(provider.provider_type).supports(ProviderFeature.MULTI_GRAPH):
        assert graph_name in graphs, (
            f"{type(provider).__name__} declares ProviderFeature.MULTI_GRAPH but "
            f"list_graphs() {graphs!r} does not include the seeded test graph "
            f"{graph_name!r}"
        )

    try:
        pr = await _call_optional(provider, "preflight", deadline_s=2.0)
    except NotImplementedError:
        assert_snapshot(provider=snapshot_label, name="preflight_verdict", actual="NotImplementedError")
    else:
        assert_snapshot(
            provider=snapshot_label, name="preflight_verdict",
            actual={"ok": pr.ok, "reason": pr.reason},
        )
        assert pr.ok is True, (
            f"{type(provider).__name__}.preflight() returned ok={pr.ok!r} "
            f"reason={pr.reason!r} against a live instance this harness just "
            "seeded successfully -- preflight must not report failure here."
        )


async def _pin(
    *,
    snapshot_label: str,
    name: str,
    call: Awaitable[Any],
    normalize: Optional[Callable[[Any], Any]] = None,
) -> None:
    """Await ``call`` and snapshot the result, tolerating a provider that
    doesn't implement this surface yet (e.g. the ArcadeDB adapter arriving
    in a later PR): a bare ``NotImplementedError`` is pinned as the string
    ``"NotImplementedError"``. The more specific
    ``ProviderFeatureUnsupportedError`` -- a *declared* "this provider will
    never support this feature", not merely "not built out yet" -- is
    pinned as ``"unsupported"`` instead. Both replace failing the run.

    ``normalize``, when given, reshapes a *successful* result into its
    deterministic subset before it is snapshotted — for pins whose raw
    payload carries wall-clock timing or other cross-run-unstable data.
    """
    try:
        result: Any = await call
    except ProviderFeatureUnsupportedError:
        result = "unsupported"
    except NotImplementedError:
        result = "NotImplementedError"
    else:
        if normalize is not None:
            result = normalize(result)
    assert_snapshot(provider=snapshot_label, name=name, actual=result)


async def _call_optional(provider: GraphDataProvider, method_name: str, *args: Any, **kwargs: Any) -> Any:
    """Call a provider method that isn't declared on ``GraphDataProvider``.

    Today the only caller is ``preflight``: required by convention, not by
    the ABC (see ``GraphDataProvider``'s class docstring) -- a default here
    would either lie about reachability or wrongly gate every provider as
    permanently down, so there is no base-class fallback to inherit and a
    provider could in principle lack it. (``get_nodes_batch`` and
    ``get_node_degrees`` used to need this same tolerance; T-A made both
    base-class members with working defaults, so ``run_all`` now calls
    them directly.)

    Plain attribute access (``provider.method_name(...)``) raises
    ``AttributeError`` the moment the argument expression is built —
    *before* ``_pin`` is even entered, so its ``NotImplementedError``
    handling never gets a chance to run. A provider missing the method
    entirely is the same "not implemented" signal as one that raises, so
    both are funnelled into that one path here instead of crashing one of
    them.
    """
    fn = getattr(provider, method_name, None)
    if fn is None:
        raise NotImplementedError(f"{type(provider).__name__} has no {method_name}")
    return await fn(*args, **kwargs)


async def _counts_fast_subset(provider: GraphDataProvider) -> Optional[Dict[str, int]]:
    """``get_counts_fast`` is a base-class member (default ``None``) since
    T-A, so this no longer guards against the method being *absent* -- it
    guards the *shape* of what comes back (a present method can itself
    return ``None``, or something that isn't the expected dict, when
    counts can't be trusted), collapsing every one of those cases to plain
    ``None`` so every caller has exactly one thing to check: "trust this
    number, or fall back to get_stats."
    """
    try:
        raw = await provider.get_counts_fast()
    except NotImplementedError:
        return None
    if not isinstance(raw, dict):
        return None
    return {"nodeCount": int(raw.get("nodeCount") or 0), "edgeCount": int(raw.get("edgeCount") or 0)}


def _tcp_reachable(host: str, port: int, timeout: float = 0.5) -> bool:
    """Bare TCP connect check -- the ``_neo4j_reachable`` shape lifted from
    the pre-factory ``test_neo4j_provider_contract.py`` so every contract
    test built through :func:`make_contract_test` shares one reachability
    gate instead of reinventing it.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, ValueError):
        return False


async def _open_connection(provider: GraphDataProvider) -> None:
    """Force a lazily-connecting adapter to open its engine handle.

    Adapters connect on their first query, so a freshly-built instance has
    no handle yet -- and the first two things this harness does need one.
    The pre-run ``cleanup`` callback drives an engine primitive
    (FalkorDB's ``provider._graph.delete()``); against ``None`` that
    raises ``AttributeError`` straight into the callback's own ``except``,
    so the "clean slate" was a **silent no-op**: a run that died mid-way
    left its graph behind and the next run seeded the fixture ON TOP of
    it, then either failed a snapshot or passed one computed over polluted
    data. ``seed``'s ``ensure_indices`` had the same problem one line
    later -- measured, 36/36 index statements failing with ``'NoneType'
    object has no attribute 'query'``, logged at WARNING and swallowed, so
    every contract run was pinning an UNINDEXED graph.

    One read through the ABC fixes both. Its *result* is deliberately
    ignored: on a graph that does not exist yet FalkorDB answers "Invalid
    graph operation on empty key", which is the normal first-run state,
    and ``_tcp_reachable`` has already gated on the endpoint being up.
    What this call is for is the handle -- and the pre-run cleanup on the
    very next line is what proves it opened.
    """
    try:
        await provider.get_node("urn:contract-harness:connect-probe")
    except Exception:
        pass


def make_contract_test(
    type_id: str,
    *,
    env_prefix: str,
    cleanup: Callable[[GraphDataProvider], Awaitable[None]],
    snapshot_label: Optional[str] = None,
) -> Callable[[], Awaitable[None]]:
    """Build a ready-to-run pytest coroutine for ``type_id``'s live
    contract test.

    Skips (never fails) unless ``<env_prefix>_HOST`` is set and
    ``host:port`` accepts a TCP connection -- a developer without a live
    instance handy sees "skipped", and CI only exercises the providers it
    has actually stood up.

    ``cleanup`` is called twice: once before ``seed`` (the clean slate, so
    a crashed previous run cannot pollute this one) and once in a
    ``finally``. It is handed a **connected** provider both times -- the
    factory opens the connection first -- so a callback may drive engine
    primitives directly; it does not have to connect for itself, and it
    must not assume it is the first thing to touch the instance.

    The provider is built **through the catalog**
    (``create_provider_instance(ProviderSpec(...))``) -- the same
    construction path production uses -- so a descriptor defect (a bad
    ``build`` function, a capability mismatch) fails here instead of in a
    deployment. Connection fields read off
    ``<env_prefix>_{HOST,PORT,GRAPH,TLS,USERNAME,PASSWORD,TOKEN,
    EXTRA_CONFIG_JSON}``; unset optional fields are simply omitted rather
    than passed as a literal ``None``/``""``, so a descriptor's own
    defaults (e.g. Neo4j's ``username="neo4j"``) still apply. The port
    falls back to the registered descriptor's ``connection.default_port``
    when ``<env_prefix>_PORT`` is unset.

    This shape fits a provider addressed by host:port (FalkorDB, Neo4j,
    and presumably PR 3's ArcadeDB). It does not fit Spanner, which
    ``catalog/spanner.py`` addresses by project/instance/database rather
    than host:port (its own ``_validate`` rejects host/port outright) --
    ``test_spanner_provider_contract.py`` builds its ``ProviderSpec``
    directly and calls ``run_all`` itself instead of using this factory.
    See the T-P task report for why.
    """
    from backend.common.providers.catalog import create_provider_instance, require_descriptor
    from backend.common.providers.catalog.descriptor import ProviderSpec

    label = snapshot_label or type_id

    async def _run_contract_test() -> None:
        descriptor = require_descriptor(type_id)

        host = os.getenv(f"{env_prefix}_HOST")
        if not host:
            pytest.skip(f"{env_prefix}_HOST not set -- {type_id} contract test needs a live instance")

        port_raw = os.getenv(f"{env_prefix}_PORT")
        port = int(port_raw) if port_raw else int(descriptor.connection.default_port or 0)

        if not _tcp_reachable(host, port):
            pytest.skip(f"{host}:{port} not reachable -- {type_id} contract test needs a live instance")

        credentials: Dict[str, Any] = {}
        for key in ("username", "password", "token"):
            value = os.getenv(f"{env_prefix}_{key.upper()}")
            if value:
                credentials[key] = value

        extra_config_raw = os.getenv(f"{env_prefix}_EXTRA_CONFIG_JSON")
        extra_config = json.loads(extra_config_raw) if extra_config_raw else None

        tls_enabled = (os.getenv(f"{env_prefix}_TLS") or "").strip().lower() in ("1", "true", "yes", "on")
        graph_name = os.getenv(f"{env_prefix}_GRAPH") or f"test_regression_{os.getpid()}"

        spec = ProviderSpec(
            type_id,
            host=host,
            port=port,
            graph_name=graph_name,
            tls_enabled=tls_enabled,
            credentials=credentials,
            extra_config=extra_config,
        )
        provider = create_provider_instance(spec)
        await _open_connection(provider)
        await cleanup(provider)
        try:
            await seed(provider)
            await run_all(provider, snapshot_label=label, graph_name=graph_name)
        finally:
            await cleanup(provider)
            await provider.close()

    return _run_contract_test
