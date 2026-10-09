"""Committed ``:AGGREGATED`` rollups must not make a projection PERMANENTLY unverifiable.

THE OUTAGE (fixed in 6fcf2d6f / 51b9dae9, previously untested). ``falkor_counts``
excludes the derived rollup layer — reconciliation is about RAW committed lineage —
but ``pg_live_counts_projectable`` counted every live edge head, rollups included.
Harmless until a publish commits materialised rollups into the version log: then
Postgres counted 4,959 against FalkorDB's 2,267, a gap of exactly the 2,692 rollups,
and the verify became a comparison NO projection could satisfy. Every heal wrote all
4,959 edges correctly and then failed, the watermark was pinned, every main read fell
back to Postgres — which serves no rollups at all — and the data source lost its
entire aggregated-lineage layer for 14 hours with no self-healing path.

The invariant this locks down: on a graph whose committed main INCLUDES ``AGGREGATED``
edges, the two count functions describe the same set, so a faithful projection
publishes. Needs Postgres.
"""
import asyncio
import os
import re

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.reconcile import (
    falkor_counts,
    pg_live_counts,
    pg_live_counts_projectable,
)
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService

from backend.tests.integration.test_versioning_projection import (
    FakeFalkor,
    FakeGraph,
    _Result,
    _edge,
    _edit_publish,
    _graph_name,
    _node,
)


class _CountingGraph(FakeGraph):
    """``FakeGraph`` plus the count cypher ``falkor_counts`` ACTUALLY emits.

    The base fake string-matches ``MATCH (n) WHERE NOT '_GVRollupMeta' IN labels(n)…``,
    which stopped being what the code emits when ``config.DERIVED_LABELS`` grew to three
    labels. Today that query falls through to the fake's ``raise AssertionError`` — and
    ``_verify_and_heal`` treats ANY count exception as "verify skipped, publish anyway".
    A guard built on the base fake would therefore go green whether the two count
    functions agree or not, which is worse than no guard. Evaluate the emitted WHERE
    clause instead of matching its text, so this cannot rot the same way.
    """

    async def query(self, cypher: str, params: dict = None):
        if cypher.startswith("MATCH (n) WHERE ") and cypher.endswith("RETURN count(n) AS c"):
            excluded = set(re.findall(r"NOT '(\w+)' IN labels\(n\)", cypher))
            return _Result([[sum(1 for n in self.nodes.values()
                                 if n.get("_label") not in excluded)]])
        if cypher.startswith("MATCH ()-[r]->() WHERE ") and cypher.endswith("RETURN count(r) AS c"):
            excluded = set(re.findall(r"type\(r\) <> '(\w+)'", cypher))
            return _Result([[sum(1 for e in self.edges.values()
                                 if e.get("type") not in excluded)]])
        return await super().query(cypher, params)


class _CountingFalkor(FakeFalkor):
    def __call__(self, name: str, provider_id=None) -> _CountingGraph:
        return self.graphs.setdefault(name, _CountingGraph())


async def _seed_with_committed_rollups(svc, name: str) -> str:
    """A graph whose committed main carries BOTH raw lineage and materialised rollups —
    the state a publish of an aggregated draft leaves behind, and the state the outage
    was in."""
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
        {"op": "create", "entity_kind": "node", "entity_id": "C", "payload": _node("Gamma")},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1",
         "payload": _edge("A", "B")},                                    # raw committed lineage
        {"op": "create", "entity_kind": "edge", "entity_id": "R1",
         "payload": _edge("A", "C", etype="AGGREGATED")},                # materialised rollup
        {"op": "create", "entity_kind": "edge", "entity_id": "R2",
         "payload": _edge("B", "C", etype="AGGREGATED")},                # materialised rollup
    ], "publish carrying materialised rollups")
    return gid


async def _run_counts_agree() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    fake = _CountingFalkor()
    name = "gvt_" + os.urandom(3).hex()
    gid = await _seed_with_committed_rollups(svc, name)
    mid = await svc.main_branch_id(gid)

    # Premise: main really does hold three live edges, two of them rollups.
    async with db.graphver_session() as s:
        assert (await pg_live_counts(s, gid, mid))[1] == 3, "premise: three committed edges"
        pg = await pg_live_counts_projectable(s, gid, mid)
    assert pg[1] == 1, (
        f"the projectable edge count is {pg[1]}, not 1 — it is counting the committed "
        f":AGGREGATED rollups that falkor_counts excludes. That is the gap of exactly "
        f"2,692 that made the verify unsatisfiable and cost a data source its entire "
        f"aggregated-lineage layer."
    )

    proj = FalkorProjector(graph_client_factory=fake, batch_size=2)
    r = await proj.project_graph(gid)
    assert not r.get("verify_error"), (
        f"a faithful projection of a graph with committed rollups failed its own verify: "
        f"{r.get('verify_error')!r} — this is the permanent wedge"
    )
    wm = await svc.projection_watermark(gid)
    assert wm["fresh"] is True and wm["projected"] == wm["committed"], wm

    # …and the two count functions agree over the SAME graph, directly.
    g = fake.graphs[await _graph_name(gid)]
    async with db.graphver_session() as s:
        pg = await pg_live_counts_projectable(s, gid, mid)
    fk = await falkor_counts(g)
    assert pg == fk, f"Postgres {pg} vs FalkorDB {fk} — incompatible sets, unsatisfiable verify"
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_projection_verifies_clean_with_committed_rollups_e2e():
    asyncio.run(_run_counts_agree())
