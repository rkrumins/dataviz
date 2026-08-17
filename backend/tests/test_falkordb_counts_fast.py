"""``get_counts_fast`` — the O(1) drift probe that replaces ``get_stats``'s scans.

FalkorDB's ``reduce_count`` optimization collapses ``count()`` over an
unfiltered pattern to a constant read of the label/relation matrix counters, so
``db.labels()`` + one count per label reproduces ``get_stats``'s per-type
breakdown without touching a single node. Measured on a 500k-node / 850k-edge
graph: ~1.3ms versus ~514ms of scanning.

Every assertion below encodes something verified against a live
``falkordb/falkordb:v4.18.11`` instance, because the two ways this can go
subtly wrong are both invisible to a fake:

* ``db.labels()`` keeps listing a label after its last node is deleted, where
  ``get_stats`` emits no row for it. A ``{"Ghost": 0}`` key and an absent key
  hash differently, so keeping it would fire ``raw_drift`` on the first probe.
* Unlabelled nodes are invisible to per-label counts. ``get_stats`` buckets
  them as ``"unknown"`` via ``labels(n)[0] or "unknown"``, so the probe has to
  derive them from the total. When the label sum comes out ABOVE the total the
  graph has multi-label nodes, per-label counting is no longer equivalent, and
  the probe must refuse rather than report a shape that is quietly wrong.
"""
import pytest
from redis.exceptions import ResponseError

from backend.app.providers.falkordb_provider import FalkorDBProvider


_EMPTY_KEY = ResponseError("Invalid graph operation on empty key")


class _Res:
    def __init__(self, rows):
        self.result_set = rows


def _make_provider(counts, labels=(), rel_types=()):
    """Provider whose query layer answers only the probe's query shapes.

    ``counts`` maps a label/type name to its count; ``"*nodes"`` / ``"*edges"``
    carry the two unfiltered totals. Any query the probe is not supposed to
    issue raises, so a regression that reintroduces a scan fails loudly.
    """
    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    issued = []

    async def _ro_query(cypher, params=None, **kw):
        issued.append(cypher)
        if "db.labels()" in cypher:
            return _Res([[n] for n in labels])
        if "db.relationshipTypes()" in cypher:
            return _Res([[t] for t in rel_types])
        if cypher == "MATCH (n) RETURN count(n)":
            return _Res([[counts["*nodes"]]])
        if cypher == "MATCH ()-[r]->() RETURN count(r)":
            return _Res([[counts["*edges"]]])
        for name in list(labels) + list(rel_types):
            # The probe backticks identifiers after stripping any backtick they
            # contain, so match on the sanitised form the query actually carries.
            if f"`{str(name).replace('`', '')}`" in cypher:
                return _Res([[counts.get(name, 0)]])
        raise AssertionError(f"unexpected query: {cypher}")

    p._ro_query = _ro_query
    p._issued = issued
    return p


# ── equivalence with get_stats ───────────────────────────────────────

@pytest.mark.asyncio
async def test_reproduces_get_stats_shape():
    p = _make_provider(
        {"*nodes": 500500, "*edges": 850000,
         "Asset": 200000, "Field": 300000, "System": 500,
         "CONTAINS": 500000, "FLOWS_TO": 300000, "AGGREGATED": 50000},
        labels=("Asset", "Field", "System"),
        rel_types=("CONTAINS", "FLOWS_TO", "AGGREGATED"),
    )
    assert await p.get_counts_fast() == {
        "nodeCount": 500500,
        "edgeCount": 850000,
        "entityTypeCounts": {"Asset": 200000, "Field": 300000, "System": 500},
        "edgeTypeCounts": {
            "CONTAINS": 500000, "FLOWS_TO": 300000, "AGGREGATED": 50000,
        },
    }


@pytest.mark.asyncio
async def test_issues_no_scanning_query():
    """The whole point: never project ``labels(n)`` or ``type(r)``, which is
    what loses the optimization and turns this back into a full scan."""
    p = _make_provider(
        {"*nodes": 1, "*edges": 0, "Asset": 1},
        labels=("Asset",), rel_types=(),
    )
    await p.get_counts_fast()
    assert p._issued, "probe issued no queries"
    for cypher in p._issued:
        assert "labels(n)" not in cypher
        assert "type(r)" not in cypher


# ── trap 1: stale label catalogue ────────────────────────────────────

@pytest.mark.asyncio
async def test_drops_zero_count_buckets():
    """``db.labels()`` still lists a label whose last node was deleted."""
    p = _make_provider(
        {"*nodes": 10, "*edges": 0, "Asset": 10, "Ghost": 0},
        labels=("Asset", "Ghost"), rel_types=(),
    )
    result = await p.get_counts_fast()
    assert result["entityTypeCounts"] == {"Asset": 10}
    assert "Ghost" not in result["entityTypeCounts"]


@pytest.mark.asyncio
async def test_drops_zero_count_edge_types():
    p = _make_provider(
        {"*nodes": 10, "*edges": 5, "Asset": 10, "CONTAINS": 5, "DEAD": 0},
        labels=("Asset",), rel_types=("CONTAINS", "DEAD"),
    )
    result = await p.get_counts_fast()
    assert result["edgeTypeCounts"] == {"CONTAINS": 5}


# ── trap 2: unlabelled and multi-label nodes ─────────────────────────

@pytest.mark.asyncio
async def test_derives_unknown_bucket_for_unlabelled_nodes():
    """Matches ``get_stats``'s ``labels(n)[0] or "unknown"`` bucket exactly."""
    p = _make_provider(
        {"*nodes": 500510, "*edges": 0, "Asset": 200000, "Field": 300000,
         "System": 500},
        labels=("Asset", "Field", "System"), rel_types=(),
    )
    result = await p.get_counts_fast()
    assert result["entityTypeCounts"]["unknown"] == 10
    assert result["nodeCount"] == 500510


@pytest.mark.asyncio
async def test_refuses_when_label_sum_exceeds_total():
    """Sum above total means multi-label nodes, so per-label counting is not
    equivalent to ``labels(n)[0]``. Refuse, and let the caller decide what to
    do about it (the probe handler defers to the stats poll).

    These are the measured numbers from the live spike: 20 ``:Asset:Field``
    nodes count twice (+20) and 10 unlabelled nodes count zero (-10), so the
    label sum lands 10 ABOVE the true total.
    """
    p = _make_provider(
        {"*nodes": 500530, "*edges": 0,
         "Asset": 200020, "Field": 300020, "System": 500},
        labels=("Asset", "Field", "System"), rel_types=(),
    )
    assert await p.get_counts_fast() is None


@pytest.mark.asyncio
async def test_refuses_when_edge_type_sum_disagrees():
    """Every edge has exactly one type, so a mismatch means the catalogue is
    not telling the truth. There is no honest ``unknown`` bucket to derive."""
    p = _make_provider(
        {"*nodes": 10, "*edges": 100, "Asset": 10, "CONTAINS": 40},
        labels=("Asset",), rel_types=("CONTAINS",),
    )
    assert await p.get_counts_fast() is None


# ── empty / missing graph ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_empty_graph_returns_zeros_like_get_stats(monkeypatch):
    p = _make_provider({"*nodes": 0, "*edges": 0})

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    assert await p.get_counts_fast() == {
        "nodeCount": 0,
        "edgeCount": 0,
        "entityTypeCounts": {},
        "edgeTypeCounts": {},
    }


@pytest.mark.asyncio
async def test_propagates_real_errors(monkeypatch):
    p = _make_provider({"*nodes": 0, "*edges": 0})

    async def _raise(*a, **k):
        raise ResponseError("syntax error")

    monkeypatch.setattr(p, "_ro_query", _raise)
    with pytest.raises(ResponseError):
        await p.get_counts_fast()


# ── identifier safety ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_strips_backticks_from_identifiers():
    """A label carrying a backtick would otherwise break out of the quoted
    identifier. Same sanitisation the materializer uses."""
    p = _make_provider(
        {"*nodes": 3, "*edges": 0, "Ev`il": 3},
        labels=("Ev`il",), rel_types=(),
    )
    await p.get_counts_fast()
    label_queries = [c for c in p._issued if c.startswith("MATCH (n:")]
    assert label_queries == ["MATCH (n:`Evil`) RETURN count(n)"]


# ── the probe handler defers rather than scanning ────────────────────

@pytest.mark.asyncio
async def test_probe_skips_a_provider_that_cannot_count_cheaply(monkeypatch):
    """When counters cannot answer, the probe must SKIP, not scan.

    Falling back to ``get_stats`` here would put minutes of full-scan work in
    a lane budgeted for milliseconds and blow the probe's fixed timeout. The
    source keeps exactly the behaviour it has today — the stats poll refreshes
    it on the usual interval — because the probe is an accelerator, never a
    dependency.
    """
    from backend.insights_service import collector
    from backend.insights_service.schemas import ProbeJobEnvelope
    from datetime import datetime, timezone

    scanned = []

    class _Provider:
        async def get_counts_fast(self):
            return None  # multi-label graph: refuses rather than mis-reporting

        async def get_stats(self, bypass_cache=False):
            scanned.append(True)
            return {"nodeCount": 1, "edgeCount": 0,
                    "entityTypeCounts": {}, "edgeTypeCounts": {}}

    async def _ctx(envelope, *, resolve_ontology):
        return None, _Provider(), "prov_1", None, None

    written = []

    async def _upsert(**kw):
        written.append(kw)

    monkeypatch.setattr(collector, "_open_context", _ctx)
    monkeypatch.setattr(collector, "upsert_data_source_stats_counts", _upsert)

    await collector.probe_counts(ProbeJobEnvelope(
        data_source_id="ds_1", workspace_id="ws_1",
        enqueued_at=datetime.now(timezone.utc),
    ))

    assert scanned == [], "probe must not fall back to a full scan"
    assert written == [], "nothing to record when the probe could not answer"
