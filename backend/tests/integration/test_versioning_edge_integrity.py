"""Authoritative edge integrity on the canvas save path (apply_ops) — needs Postgres.

Proves the backend rejects, regardless of ontology_enforcement:
  * a SECOND containment parent for a node ("create Contains when one exists");
  * a DUPLICATE edge (same source+target+type), containment OR lineage;
  * a containment CYCLE (incl. self-containment);
and ALLOWS a legitimate reparent that stages delete(old parent)+create(new) in one batch.

Run inside the dev backend container:
  PYTHONPATH=/app GRAPHVER_E2E=1 python -m pytest backend/tests/integration/test_versioning_edge_integrity.py
or directly:  PYTHONPATH=/app GRAPHVER_E2E=1 python backend/tests/integration/test_versioning_edge_integrity.py
"""
import asyncio
import os

try:
    import pytest
except ModuleNotFoundError:  # the dev container has no pytest — direct-run path still works
    class _PytestStub:
        class mark:
            @staticmethod
            def skipif(*_a, **_k):
                return lambda fn: fn
    pytest = _PytestStub()  # type: ignore

from backend.app.services.versioning import models
from backend.app.services.versioning.service import GraphVersioningService, OntologyViolation, NotUpToDate

CET = ["CONTAINS"]


def _node(urn):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": "dataset", "displayName": urn[-6:]}}


def _edge(eid, src, tgt, etype="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _del(eid, kind="edge"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _apply(svc, gid, bid, ops):
    return await svc.apply_ops(graph_id=gid, branch_id=bid, actor="bot", ops=ops, containment_edge_types=CET)


async def _expect_violation(coro):
    try:
        await coro
    except OntologyViolation:
        return True
    return False


async def _expect_not_up_to_date(coro):
    try:
        await coro
    except NotUpToDate:
        return True
    return False


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    sfx = os.urandom(3).hex()
    g = await svc.create_graph(data_source_id="ds_ei_" + sfx, workspace_id="ws_ei", actor="bot")
    gid, _main = g["graph_id"], g["main_branch_id"]
    d = await svc.open_draft(graph_id=gid, owner="bot")

    P = f"urn:li:dataset:eiP_{sfx}"
    P2 = f"urn:li:dataset:eiP2_{sfx}"
    C = f"urn:li:dataset:eiC_{sfx}"
    await _apply(svc, gid, d, [_node(P), _node(P2), _node(C)])

    # Baseline containment P → C succeeds.
    await _apply(svc, gid, d, [_edge(f"e1_{sfx}", P, C)])

    # (1) SECOND containment parent (P2 → C) is rejected.
    assert await _expect_violation(_apply(svc, gid, d, [_edge(f"e2_{sfx}", P2, C)])), "second parent allowed!"

    # (2) DUPLICATE containment edge (P → C again, new id) is rejected.
    assert await _expect_violation(_apply(svc, gid, d, [_edge(f"e1dup_{sfx}", P, C)])), "duplicate allowed!"

    # (3) Legitimate REPARENT in one batch: delete old parent edge + add new (P2 → C) → SUCCEEDS.
    await _apply(svc, gid, d, [_del(f"e1_{sfx}"), _edge(f"e3_{sfx}", P2, C)])
    # C is now under P2; the old edge is gone.

    # (4) CYCLE: C now contains nothing, P2 is its parent. Adding C → P2 would loop.
    assert await _expect_violation(_apply(svc, gid, d, [_edge(f"ecyc_{sfx}", C, P2)])), "cycle allowed!"

    # (5) SELF containment is rejected.
    assert await _expect_violation(_apply(svc, gid, d, [_edge(f"eself_{sfx}", C, C)])), "self-containment allowed!"

    # (6) DUPLICATE LINEAGE edge (same source+target+type) is rejected; a different type is fine.
    await _apply(svc, gid, d, [_edge(f"lin1_{sfx}", P, P2, "FLOWS_TO")])
    assert await _expect_violation(
        _apply(svc, gid, d, [_edge(f"lin1dup_{sfx}", P, P2, "FLOWS_TO")])), "duplicate lineage allowed!"
    await _apply(svc, gid, d, [_edge(f"lin2_{sfx}", P, P2, "DERIVES_FROM")])  # different type → ok

    # (7) The PROVIDER write path (direct API: POST /edges → provider.create_edge → apply_ops)
    #     enforces the same integrity once the engine's ontology push-down arms it with the
    #     containment types. C is under P2 here, so P → C is a second parent.
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    from backend.common.models.graph import GraphEdge
    prov = VersionedBranchProvider(svc, graph_id=gid, branch_id=d, actor="bot")
    prov.set_containment_edge_types(CET, from_ontology=True)
    assert await _expect_violation(
        prov.create_edge(GraphEdge(id=f"e2ndprov_{sfx}", sourceUrn=P, targetUrn=C,
                                   edgeType="CONTAINS"))), "provider path allowed a second parent!"

    # (8) One-batch parent/child SWAP is legitimate: delete P2→C and create C→P2 together.
    #     The cycle check must honour the batch's deletes (P2→C is gone in the effective graph).
    await _apply(svc, gid, d, [_del(f"e3_{sfx}"), _edge(f"eswap_{sfx}", C, P2)])

    # (9) A cycle built ENTIRELY inside one batch (X→Y and Y→X) is rejected — neither edge is
    #     live yet, so only a batch-aware ancestor walk can see it.
    X = f"urn:li:dataset:eiX_{sfx}"
    Y = f"urn:li:dataset:eiY_{sfx}"
    await _apply(svc, gid, d, [_node(X), _node(Y)])
    assert await _expect_violation(
        _apply(svc, gid, d, [_edge(f"exy_{sfx}", X, Y), _edge(f"eyx_{sfx}", Y, X)])), \
        "same-batch containment cycle allowed!"

    # (10) CROSS-BRANCH merge integrity: two drafts each add a DIFFERENT parent to the same
    #      (parentless) node — each is clean in isolation, so only the merge-time re-check
    #      (_apply_draft_squash → _validate_edge_integrity) can stop the SECOND publish from
    #      composing a two-parent hierarchy onto main.
    N = f"urn:li:dataset:eiN_{sfx}"
    Q1 = f"urn:li:dataset:eiQ1_{sfx}"
    Q2 = f"urn:li:dataset:eiQ2_{sfx}"
    d0 = await svc.open_draft(graph_id=gid, owner="seed")
    await _apply(svc, gid, d0, [_node(N), _node(Q1), _node(Q2)])
    await svc.publish(graph_id=gid, branch_id=d0, actor="seed", message="seed",
                      containment_edge_types=CET)
    dA = await svc.open_draft(graph_id=gid, owner="alice")
    dB = await svc.open_draft(graph_id=gid, owner="bob")
    await _apply(svc, gid, dA, [_edge(f"epA_{sfx}", Q1, N)])
    await _apply(svc, gid, dB, [_edge(f"epB_{sfx}", Q2, N)])
    await svc.publish(graph_id=gid, branch_id=dA, actor="alice", message="parent Q1",
                      containment_edge_types=CET)
    # dB is now behind → the later arrival is HARD-GATED and must PULL first. The pull is clean
    # (different edges), but the post-pull publish's merge-time re-check still stops the two-parent.
    assert await _expect_not_up_to_date(
        svc.publish(graph_id=gid, branch_id=dB, actor="bob", message="parent Q2",
                    containment_edge_types=CET)), "behind publish was not gated!"
    assert (await svc.rebase_draft(graph_id=gid, branch_id=dB, actor="bob"))["clean"] is True
    assert await _expect_violation(
        svc.publish(graph_id=gid, branch_id=dB, actor="bob", message="parent Q2",
                    containment_edge_types=CET)), "cross-branch merge composed a second parent!"

    print("EDGE-INTEGRITY OK")


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs Postgres (set GRAPHVER_E2E=1)")
def test_edge_integrity():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
