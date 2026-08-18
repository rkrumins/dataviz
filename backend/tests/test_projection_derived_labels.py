"""Regression: the cache-vs-committed-main count must exclude EVERY derived
in-graph artifact, not just ``_GVRollupMeta``.

The bug this locks down. Versioned graphs run in ``in_source`` projection mode,
so the aggregation pipeline stamps its ``_AggMeta`` singleton into the very
graph the projector verifies. ``falkor_counts`` excluded only ``_GVRollupMeta``,
so after ANY aggregation job the node count came back one high. That node
carries no tombstone, so ``_sweep_tombstoned`` could not clear it, the verify
reported "FalkorDB has extra entities vs committed main", ``published`` went
False, and ``_apply`` pinned the watermark — every read fell back to Postgres
until a human rebuilt by hand. The aggregation reconciliation sweep then read
those Postgres-backed counts as a wiped overlay and queued another job, which
stamped ``_AggMeta`` again.

The fix is one definition (``config.DERIVED_LABELS``) shared by both call
sites; two copies of the list is what allowed them to drift apart.

Pure unit test — the fake query evaluates the WHERE clause the code actually
emits rather than asserting on its text, so a rewrite that keeps the semantics
still passes.
"""
import asyncio
import re

import pytest

from backend.app.services.versioning import config, reconcile


# One committed-main graph plus every derived artifact that can share it.
_NODES = [
    ["Table"], ["Table"], ["Column"],   # committed main — the only real count
    ["_GVRollupMeta"],                  # projector rollup watermark
    ["_AggMeta"],                       # aggregation run stamp
    ["_Projection"],                    # dedicated-projection scaffolding
]
_EDGES = ["FLOWS_TO", "FLOWS_TO", "AGGREGATED", "AGGREGATED"]

_COMMITTED_NODES = 3
_COMMITTED_EDGES = 2


class _Result:
    def __init__(self, count):
        self.result_set = [[count]]


def _fake_bounded_query(_client, cypher, params=None):
    """Evaluate the emitted cypher against the fixture graph."""
    async def _run():
        if "labels(n)" in cypher or "MATCH (n)" in cypher:
            excluded = set(re.findall(r"NOT '(\w+)' IN labels\(n\)", cypher))
            return _Result(sum(
                1 for labels in _NODES if not (set(labels) & excluded)
            ))
        excluded_types = set(re.findall(r"type\(r\) <> '(\w+)'", cypher))
        return _Result(sum(1 for t in _EDGES if t not in excluded_types))
    return _run()


@pytest.fixture(autouse=True)
def _stub_query(monkeypatch):
    monkeypatch.setattr(reconcile, "_bounded_query", _fake_bounded_query)


def test_falkor_counts_excludes_every_derived_label():
    nodes, edges = asyncio.run(reconcile.falkor_counts(object()))
    assert nodes == _COMMITTED_NODES, (
        "a derived bookkeeping node was counted as committed-main data — "
        "this is what pins the projection watermark"
    )
    assert edges == _COMMITTED_EDGES


def test_agg_meta_alone_does_not_inflate_the_count():
    """The precise production case: a versioned in-source graph that has been
    aggregated once, and nothing else derived present."""
    monkey = [["Table"], ["Table"], ["Column"], ["_AggMeta"]]
    original = _NODES[:]
    try:
        _NODES[:] = monkey
        nodes, _ = asyncio.run(reconcile.falkor_counts(object()))
        assert nodes == _COMMITTED_NODES
    finally:
        _NODES[:] = original


def test_both_call_sites_share_one_definition():
    """The list existed twice and the copies drifted. Assert they cannot
    again — the entity scan and the count must exclude the same labels."""
    from backend.app.services.versioning import bootstrap_worker

    assert bootstrap_worker._DERIVED_LABELS is config.DERIVED_LABELS
    for label in config.DERIVED_LABELS:
        assert f"NOT '{label}' IN labels(n)" in reconcile._NOT_DERIVED
        assert f"NOT '{label}' IN labels(n)" in reconcile._SCAN_NODES
