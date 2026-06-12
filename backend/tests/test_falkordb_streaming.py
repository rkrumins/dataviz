"""Unit tests for the constant-memory streaming aggregation rebuild.

These do NOT need a live FalkorDB — they construct a FalkorDBProvider and
monkeypatch its query primitives with an in-memory graph that simulates
the MERGE-on-aggKey semantics, so we can assert the high-value correctness
properties: cross-page ancestor-pair dedup, indexed-cursor checkpointing,
crash-resume idempotency, and the end-of-run stale-generation sweep.
"""
import json
import re

import pytest

from backend.app.providers.falkordb_provider import (
    FalkorDBProvider,
    _is_cluster_redirect,
)


class _Result:
    def __init__(self, result_set=None, relationships_created=0):
        self.result_set = result_set or []
        self.relationships_created = relationships_created


class _FakeGraph:
    """Tiny in-memory simulation of the projection graph for AGGREGATED
    edges keyed by aggKey, honoring the MERGE ON CREATE / ON MATCH epoch
    semantics used by _flush_streaming_pairs."""

    def __init__(self):
        # aggKey -> {"weight": int, "epoch": int}
        self.edges = {}

    def apply_merge(self, batch, epoch):
        created = 0
        for item in batch:
            k = item["k"]
            existing = self.edges.get(k)
            if existing is None:
                self.edges[k] = {"weight": item["w"], "epoch": epoch}
                created += 1
            elif existing["epoch"] == epoch:
                existing["weight"] += item["w"]
            else:  # reused from a prior generation → reset
                existing["weight"] = item["w"]
                existing["epoch"] = epoch
        return created

    def sweep(self, epoch, limit):
        stale = [k for k, v in self.edges.items() if v["epoch"] != epoch]
        chunk = stale[:limit]
        for k in chunk:
            del self.edges[k]
        return len(chunk)

    def count_epoch(self, epoch):
        return sum(1 for v in self.edges.values() if v["epoch"] == epoch)


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = {}
    p._level_digest = ""
    p._bulk_create_batch_size = 1000
    p._bulk_create_timeout_s = 60.0
    p._BULK_WIPE_BATCH_SIZE = 1000

    class _FakeRedis:
        async def set(self, *a, **k):
            return True

        async def get(self, *a, **k):
            return None

    p._redis = _FakeRedis()
    return p


def _wire_fake_graph(p, monkeypatch, *, edges_by_type, ancestors):
    """edges_by_type: {TYPE: [(rid, s_urn, t_urn), ...]} sorted by rid.
    ancestors: {urn: [ancestor_urns...]}.  Returns the _FakeGraph."""
    fake = _FakeGraph()

    type_re = re.compile(r"\[r:`([^`]+)`\]")

    async def fake_ro_query(cypher, params=None, **kw):
        m = type_re.search(cypher)
        etype = m.group(1)
        rid_after = params["rid"]
        limit = params["limit"]
        rows = [
            [rid, s, t]
            for (rid, s, t) in edges_by_type.get(etype, [])
            if rid > rid_after
        ][:limit]
        return _Result(result_set=rows)

    async def fake_ancestors(urns):
        return {u: list(ancestors.get(u, [])) for u in urns}

    async def fake_labels(urns):
        return {u: "L" for u in urns}

    async def fake_proj_query(cypher, params=None, **kw):
        if "MERGE" in cypher:
            created = fake.apply_merge(params["batch"], params["epoch"])
            return _Result(relationships_created=created)
        if "DELETE" in cypher:
            n = fake.sweep(params["epoch"], p._BULK_WIPE_BATCH_SIZE)
            return _Result(result_set=[[n]])
        return _Result()

    async def fake_proj_ro_query(cypher, params=None, **kw):
        return _Result(result_set=[[fake.count_epoch(params["epoch"])]])

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(p, "_ro_query", fake_ro_query)
    monkeypatch.setattr(p, "_proj_query", fake_proj_query)
    monkeypatch.setattr(p, "_proj_ro_query", fake_proj_ro_query)
    monkeypatch.setattr(p, "_compute_and_store_ancestors_bulk", fake_ancestors)
    monkeypatch.setattr(p, "_resolve_urn_labels_bulk", fake_labels)
    monkeypatch.setattr(p, "_warmup_urn_label_cache_for_aggregation", noop)
    monkeypatch.setattr(p, "_ensure_aggregation_streaming_indexes", noop)
    return fake


# ── pure helpers ────────────────────────────────────────────────────

def test_stream_cursor_roundtrip():
    p = _make_provider()
    c = p._make_stream_cursor(1234, 2, 99)
    assert c == "v2:1234:2:99"
    assert p._parse_stream_cursor(c) == (1234, 2, 99)


def test_stream_cursor_rejects_legacy():
    p = _make_provider()
    assert p._parse_stream_cursor(None) is None
    assert p._parse_stream_cursor("some|urn|pipe") is None  # legacy format
    assert p._parse_stream_cursor("v2:bad") is None


@pytest.mark.asyncio
async def test_estimate_reads_cached_stats(monkeypatch):
    p = _make_provider()

    async def fake_get(key):
        return json.dumps({"edgeTypeCounts": {"FLOWS": 100, "CONTAINS": 5, "AGGREGATED": 9}})

    monkeypatch.setattr(p._redis, "get", fake_get)
    assert await p._estimate_lineage_edge_count(["FLOWS"]) == 100
    assert await p._estimate_lineage_edge_count(["FLOWS", "OTHER"]) == 100


@pytest.mark.asyncio
async def test_estimate_returns_zero_on_miss():
    p = _make_provider()
    assert await p._estimate_lineage_edge_count(["FLOWS"]) == 0  # _redis.get returns None


def test_is_cluster_redirect_by_name():
    class MovedError(Exception):
        pass

    class RandomError(Exception):
        pass

    assert _is_cluster_redirect(MovedError("MOVED 1234 host:6379"))
    assert _is_cluster_redirect(ConnectionError("boom"))
    assert not _is_cluster_redirect(RandomError("nope"))


# ── streaming rebuild correctness ───────────────────────────────────

@pytest.mark.asyncio
async def test_cross_page_pair_dedup_sums_weight(monkeypatch):
    """Two leaf edges under the SAME ancestor pair, split across two pages,
    must collapse to ONE AGGREGATED edge whose weight is the sum."""
    p = _make_provider()
    # Hierarchy: both leaves contained by hub 'H'. Targets share parent 'TP'.
    ancestors = {"a1": ["H"], "a2": ["H"], "b1": ["TP"], "b2": ["TP"]}
    # Two FLOWS edges: a1->b1 (rid 1) and a2->b2 (rid 2).
    edges = {"FLOWS": [(1, "a1", "b1"), (2, "a2", "b2")]}
    fake = _wire_fake_graph(p, monkeypatch, edges_by_type=edges, ancestors=ancestors)

    # batch_size=1 forces each edge onto its own page → cross-page merge.
    res = await p._materialize_aggregated_edges_streaming_rebuild(
        batch_size=1,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        last_cursor=None,
    )
    # The pair (H, TP) is produced by BOTH leaf edges → one edge, weight 2.
    htp = [k for k in fake.edges if k == "H|TP"]
    assert htp, f"expected H|TP edge, got {list(fake.edges)}"
    assert fake.edges["H|TP"]["weight"] == 2
    assert res["processed"] == 2
    # final count is authoritative (distinct edges of this epoch)
    assert res["aggregated_edges_affected"] == fake.count_epoch(
        next(iter(fake.edges.values()))["epoch"]
    )


@pytest.mark.asyncio
async def test_resume_from_cursor_does_not_reprocess(monkeypatch):
    """A resume cursor positioned after the first edge must skip it and only
    process the remainder, on the SAME epoch."""
    p = _make_provider()
    ancestors = {"a1": [], "a2": [], "b1": [], "b2": []}
    edges = {"FLOWS": [(10, "a1", "b1"), (20, "a2", "b2")]}
    fake = _wire_fake_graph(p, monkeypatch, edges_by_type=edges, ancestors=ancestors)

    # Resume on epoch=777, type_index 0, after rid 10 → only edge rid 20 left.
    res = await p._materialize_aggregated_edges_streaming_rebuild(
        batch_size=100,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        last_cursor="v2:777:0:10",
    )
    assert res["processed"] == 1  # only the second edge
    assert "a2|b2" in fake.edges
    assert "a1|b1" not in fake.edges
    assert fake.edges["a2|b2"]["epoch"] == 777


@pytest.mark.asyncio
async def test_checkpoint_cursor_is_indexed_and_advances(monkeypatch):
    """Checkpoints must emit a v2 cursor whose rid advances with the scan."""
    p = _make_provider()
    ancestors = {"a1": [], "a2": [], "b1": [], "b2": []}
    edges = {"FLOWS": [(5, "a1", "b1"), (9, "a2", "b2")]}
    _wire_fake_graph(p, monkeypatch, edges_by_type=edges, ancestors=ancestors)

    cursors = []

    async def cb(processed, total, cursor, created, phase):
        if cursor:
            cursors.append((cursor, phase))

    await p._materialize_aggregated_edges_streaming_rebuild(
        batch_size=1,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        progress_callback=cb,
        intra_batch_callback=None,
        should_cancel=None,
        last_cursor=None,
    )
    # Per-page checkpoints (phase="creating"); exclude the terminal
    # "finalizing" cursor which intentionally points past the last type
    # (rid -1) so a crash after it resumes straight into the sweep.
    page_rids = [
        p._parse_stream_cursor(c)[2]
        for c, phase in cursors
        if phase == "creating" and p._parse_stream_cursor(c)
    ]
    assert page_rids == sorted(page_rids)  # monotonically non-decreasing
    assert 9 in page_rids  # reaches the last edge's internal id


@pytest.mark.asyncio
async def test_end_sweep_retires_prior_generation(monkeypatch):
    """An old-generation edge present before the run must be swept once the
    new generation's scan completes."""
    p = _make_provider()
    ancestors = {"a1": [], "b1": []}
    edges = {"FLOWS": [(1, "a1", "b1")]}
    fake = _wire_fake_graph(p, monkeypatch, edges_by_type=edges, ancestors=ancestors)
    # Seed a stale-generation edge that no current pair will touch.
    fake.edges["old|edge"] = {"weight": 5, "epoch": 1}

    res = await p._materialize_aggregated_edges_streaming_rebuild(
        batch_size=100,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["FLOWS"],
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        last_cursor=None,
    )
    assert "old|edge" not in fake.edges  # swept
    assert "a1|b1" in fake.edges
    assert res["aggregated_edges_affected"] == 1


@pytest.mark.asyncio
async def test_no_lineage_types_is_noop(monkeypatch):
    p = _make_provider()
    res = await p._materialize_aggregated_edges_streaming_rebuild(
        batch_size=100,
        containment_edge_types=["CONTAINS"],
        lineage_edge_types=["AGGREGATED"],  # filtered out → empty
        progress_callback=None,
        intra_batch_callback=None,
        should_cancel=None,
        last_cursor=None,
    )
    assert res["processed"] == 0
    assert res["aggregated_edges_affected"] == 0


# ── incremental labeled-MERGE work units (dedicated projection) ──────

@pytest.mark.asyncio
async def test_in_source_yields_single_unlabeled_unit():
    p = _make_provider()
    p._projection_mode = "in_source"
    batch = [{"s": "a", "t": "b", "w": 1, "et": ["X"], "sl": None, "tl": None}]
    units = await p._build_aggregated_merge_units(batch)
    assert len(units) == 1
    cypher, items = units[0]
    assert items == batch
    assert "MERGE (s {urn: item.s})" in cypher  # unlabeled
    assert ":AGGREGATED" in cypher


@pytest.mark.asyncio
async def test_dedicated_groups_labeled_units(monkeypatch):
    p = _make_provider()
    p._projection_mode = "dedicated"

    labels = {"a1": "Dataset", "b1": "Domain", "a2": "Dataset", "b2": "Domain",
              "c": "Table", "d": None}

    async def fake_resolve(urns):
        return {u: labels.get(u) for u in urns}

    ensured = {}

    async def fake_ensure(lbls):
        ensured["labels"] = set(lbls)

    monkeypatch.setattr(p, "_resolve_urn_labels_bulk", fake_resolve)
    monkeypatch.setattr(p, "_ensure_label_urn_indexes", fake_ensure)

    batch = [
        {"s": "a1", "t": "b1", "w": 1, "et": ["X"], "sl": None, "tl": None},
        {"s": "a2", "t": "b2", "w": 1, "et": ["X"], "sl": None, "tl": None},
        {"s": "c", "t": "d", "w": 1, "et": ["X"], "sl": None, "tl": None},  # d unresolved
    ]
    units = await p._build_aggregated_merge_units(batch)

    labeled = [u for u in units if "MERGE (s:" in u[0]]
    unlabeled = [u for u in units if "MERGE (s {urn: item.s})" in u[0]]

    # Both (Dataset,Domain) pairs collapse into ONE labeled unit (2 items).
    assert len(labeled) == 1
    assert "MERGE (s:Dataset {urn: item.s})" in labeled[0][0]
    assert "MERGE (t:Domain {urn: item.t})" in labeled[0][0]
    assert len(labeled[0][1]) == 2
    # The unresolved-label pair falls back to the unlabeled unit.
    assert len(unlabeled) == 1
    assert unlabeled[0][1] == [batch[2]]
    # Per-label URN indexes ensured for the resolved labels only.
    assert ensured["labels"] == {"Dataset", "Domain"}


@pytest.mark.asyncio
async def test_empty_batch_yields_no_units():
    p = _make_provider()
    p._projection_mode = "dedicated"
    assert await p._build_aggregated_merge_units([]) == []
