"""Identity invariants for re-sync — AND A WARNING ABOUT THIS FILE.

READ THIS BEFORE TRUSTING IT.

A bounded re-sync was written, passed all 15 characterisation tests, and then deleted and
re-created an entire 478,430-entity graph (956,860 deltas where the correct answer was 808).
It was reverted.

These tests were written to catch that. **THEY DO NOT.** Verified: the graph-destroying code was
re-applied and all three still passed. They are kept because the properties they pin are real and
worth pinning — identity is stable across a re-sync, edges are matched rather than
deleted-and-recreated, an unchanged source barely changes anything — but they DO NOT close the
hole, and believing they do is precisely the mistake that shipped the bug.

WHY THEY DON'T WORK
-------------------
They build their graph with `bulk_ingest`, feeding it rows SHAPED like the bootstrap's. Shape is
not the writer. The bug lives in `entity_id` derivation, and only the ACTUAL BOOTSTRAP WORKER
derives ids the way real graphs have them (node eid = `node.urn`, edge eid = `edge.id`, and the
row is CANONICALISED before the id is taken — so the graph stores the canonical `edge_type` while
a provider hands back the physical one). Simulating that in a test did not reproduce it. Only the
real writer does.

WHAT THE REAL TEST MUST DO — and nothing less will do
-----------------------------------------------------
  1. push a small graph into a real FalkorDB;
  2. run the BOOTSTRAP WORKER against it (`create_bootstrap_job` + `BootstrapRunner.run_job`) —
     not bulk_ingest, not a hand-rolled imitation of it;
  3. `resync_from_provider` against that same, UNCHANGED source;
  4. assert the delta count is near zero.

Step 2 is the whole test. Everything else is scaffolding.

Until that exists, ANY change to the sync identity path (`_external_state`, the urn/edge-triple
indexes, any bounded or streaming rewrite) is unverified, no matter how many suites are green.
When identity is wrong the failure is not a wrong number — it is MASS DELETION, because deletion
is defined by absence, and the wrong ids make everything look absent.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _node(urn, **kw):
    return {"kind": "node", "id": urn, "urn": urn, "entityType": "Dataset", **kw}


def _edge(src, tgt, et="FLOWS_TO", **kw):
    """Physical edge shape, as a PROVIDER emits it: `id` is the endpoint triple, `edgeType` is
    the source system's own spelling — which is NOT necessarily what the graph stored."""
    return {"kind": "edge", "id": f"{src}|{et}|{tgt}", "edgeType": et,
            "source": src, "target": tgt, **kw}


async def _bootstrap_shaped_graph(svc):
    """A graph whose entity ids are derived the way the BOOTSTRAP WORKER derives them —
    node eid = urn, edge eid = the provider's edge id — rather than however `bulk_ingest`
    happens to. This is the writer that made the real graphs."""
    g = await svc.create_graph(
        data_source_id="ds_" + os.urandom(5).hex(), workspace_id="ws1", actor="ext",
        falkor_graph_name="gvt_" + os.urandom(4).hex())
    gid, main = g["graph_id"], g["main_branch_id"]
    rows = [_node("u:A"), _node("u:B"), _node("u:C"),
            _edge("u:A", "u:B"), _edge("u:B", "u:C")]
    await svc.bulk_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key="imp")
    return gid, main, rows


async def _t_resyncing_an_UNCHANGED_source_barely_changes_anything():
    """THE INVARIANT.

    If the source has not changed, a re-sync has almost nothing to do. Anything approaching the
    SIZE OF THE GRAPH means identity resolution has failed and the sync is about to delete
    everything and re-create it under new ids — which is exactly what happened, and exactly what
    no amount of "the merge semantics are correct" will save you from.
    """
    svc = GraphVersioningService()
    gid, main, rows = await _bootstrap_shaped_graph(svc)
    total = len(rows)

    res = await svc.sync_ingest(graph_id=gid, rows=list(rows), actor="ext")

    applied = res.get("applied") or 0
    assert applied < total, (
        f"re-syncing an UNCHANGED source applied {applied} deltas to a {total}-entity graph. "
        "Anything near (or above) the graph size means the external rows did not resolve back "
        "to the ids the graph actually holds: everything looks new (mass create) AND everything "
        "held looks absent from the snapshot (mass delete). This is the failure that shipped.")


async def _t_a_resync_does_not_change_the_entity_ids():
    """Identity must be STABLE across a re-sync. New ids for the same urns is the tell-tale of
    the mass delete/create failure, and it is visible long before the delta count is."""
    svc = GraphVersioningService()
    gid, main, rows = await _bootstrap_shaped_graph(svc)

    before = await svc.materialize_state(graph_id=gid, branch_id=main)
    ids_before = {e for e, p in before["nodes"].items() if p} | \
                 {e for e, p in before["edges"].items() if p}

    await svc.sync_ingest(graph_id=gid, rows=list(rows), actor="ext")

    after = await svc.materialize_state(graph_id=gid, branch_id=main)
    ids_after = {e for e, p in after["nodes"].items() if p} | \
                {e for e, p in after["edges"].items() if p}

    assert ids_after == ids_before, (
        f"a re-sync of an unchanged source changed the entity ids. "
        f"gone: {sorted(ids_before - ids_after)[:5]} … new: {sorted(ids_after - ids_before)[:5]}")


async def _t_an_edge_survives_a_resync_even_though_the_provider_spells_its_type_physically():
    """The specific seam that broke it.

    The bootstrap CANONICALISES a row before deriving its id, so the graph stores the canonical
    `edge_type`. A provider hands back the PHYSICAL spelling. Any identity lookup keyed on
    (source, target, edge_type) must therefore agree with whichever spelling was STORED — or the
    edge will not be found, a duplicate will be created, and the original will be deleted as
    "absent from the snapshot".
    """
    svc = GraphVersioningService()
    gid, main, rows = await _bootstrap_shaped_graph(svc)

    before = len([p for p in (await svc.materialize_state(
        graph_id=gid, branch_id=main))["edges"].values() if p])

    await svc.sync_ingest(graph_id=gid, rows=list(rows), actor="ext")

    after = [p for p in (await svc.materialize_state(
        graph_id=gid, branch_id=main))["edges"].values() if p]
    assert len(after) == before, (
        f"edge count went {before} -> {len(after)} on an unchanged source. An edge that is not "
        "matched in place is created anew AND its original is deleted — silently, and doubly.")


_CASES = [v for k, v in sorted(globals().items()) if k.startswith("_t_")]


@pytest.mark.parametrize("case", _CASES, ids=[c.__name__[3:] for c in _CASES])
def test_resync_identity(case):
    async def go():
        await models.create_schema_and_partitions()
        try:
            await case()
        finally:
            await db.dispose_engine()
    asyncio.run(go())
