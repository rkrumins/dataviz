"""CHARACTERISATION of `sync_ingest` — what it does today, before we change how it does it.

`sync_ingest` is about to be rewritten: it currently reconstructs the whole graph six times over
to 3-way merge it (MEASURED: 2.03 GB of RSS to compute 808 changes on a 478k graph), and it must
become a bounded, resumable job on the versioning worker.

That rewrite touches conflict detection, `external_wins`, resolutions, urn/edge-triple identity
matching, authoritative deletion, three cascades and referential integrity — on the path that
writes commits to the SOURCE OF TRUTH. It had exactly ONE test.

These tests exist to make the rewrite PROVABLY behaviour-preserving rather than hoped to be.
They describe the current behaviour, warts included — see `test_external_wins_*`, which pins a
real bug on purpose, so that when we fix it the diff SHOWS the semantic change instead of
hiding it.

Run: GRAPHVER_E2E=1 pytest backend/tests/integration/test_versioning_sync_characterisation.py
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict

pytestmark = pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


# ── helpers ──────────────────────────────────────────────────────────────────

def _node(urn, **kw):
    return {"kind": "node", "urn": urn, "entityType": "Dataset", **kw}


def _edge(src, tgt, et="DEPENDS_ON", **kw):
    return {"kind": "edge", "edgeType": et, "source": src, "target": tgt, **kw}


def _eid(state, urn):
    return next(e for e, p in state["nodes"].items() if p and p.get("urn") == urn)


def _find(state, urn):
    """The live payload for `urn`, or None if absent/tombstoned."""
    for p in state["nodes"].values():
        if p and p.get("urn") == urn:
            return p
    return None


async def _new_graph(svc):
    g = await svc.create_graph(
        data_source_id="ds_" + os.urandom(5).hex(), workspace_id="ws1", actor="ext",
        falkor_graph_name="gvt_" + os.urandom(4).hex())
    return g["graph_id"], g["main_branch_id"]


async def _user_edits(svc, gid, eid, payload, actor="user", kind="node"):
    """A human edit, published to main — i.e. `ours` diverges from `base`."""
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[
        {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message="user edit")


async def _user_deletes(svc, gid, eid, actor="user", kind="node"):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[
        {"op": "delete", "entity_kind": kind, "entity_id": eid}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message="user delete")


async def _seed(svc, rows, key="imp"):
    gid, main = await _new_graph(svc)
    await svc.bulk_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key=key)
    return gid, main


# ── 1. the source is AUTHORITATIVE … ─────────────────────────────────────────

async def _t_source_deletion_removes_an_untouched_entity():
    """The snapshot no longer mentions B, and nobody had touched B → B is deleted.
    This is what makes a sync a SYNC rather than an upsert, and it is the single most
    dangerous behaviour in the whole path: absence means delete."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A"), _node("u:B")])

    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A")], actor="ext")   # B absent

    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert _find(st, "u:A") is not None
    assert _find(st, "u:B") is None, "an untouched entity the source dropped must be deleted"


async def _t_source_change_applies_when_the_user_did_not_touch_it():
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="team1")])

    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="team2")], actor="ext")

    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert _find(st, "u:A")["owner"] == "team2"


# ── 2. … but it does NOT get to destroy human work ───────────────────────────

async def _t_a_user_edit_to_an_untouched_field_survives():
    """The whole promise of the feature: the source owns what the source knows, and the human
    owns what they added. A sync must never quietly undo curation."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", displayName="A", owner="team1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    await _user_edits(svc, gid, _eid(st, "u:A"),
                      {"urn": "u:A", "entityType": "Dataset", "displayName": "A",
                       "owner": "team1", "businessOwner": "Jane", "classification": "PII"})

    # the source changes displayName — a field the user never touched
    await svc.sync_ingest(graph_id=gid, rows=[
        _node("u:A", displayName="A-from-source", owner="team1")], actor="ext")

    a = _find(await svc.materialize_state(graph_id=gid, branch_id=main), "u:A")
    assert a["displayName"] == "A-from-source", "the source's change must apply"
    assert a["businessOwner"] == "Jane", "curation the source never touched must survive"
    assert a["classification"] == "PII"


async def _t_an_entity_the_USER_created_is_not_deleted_by_a_sync():
    """A user-authored entity is absent from every snapshot, forever. If 'absent means delete'
    were applied naively it would be destroyed on the very next sync. It must not be."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A")])

    d = await svc.open_draft(graph_id=gid, owner="user")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="user", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "mine:1",
         "payload": {"urn": "u:MINE", "entityType": "Dataset", "displayName": "Hand-made"}}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="user")
    await svc.publish(graph_id=gid, branch_id=d, actor="user", message="user creates")

    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A")], actor="ext")   # source never had u:MINE

    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert _find(st, "u:MINE") is not None, "a sync must not delete what the user authored"


# ── 3. conflicts ─────────────────────────────────────────────────────────────

async def _t_same_field_changed_both_sides_raises_MergeConflict():
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="team1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    await _user_edits(svc, gid, _eid(st, "u:A"),
                      {"urn": "u:A", "entityType": "Dataset", "owner": "user-choice"})

    with pytest.raises(MergeConflict) as exc:
        await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="source-choice")],
                              actor="ext", strategy="merge")

    conflicts = exc.value.conflicts
    assert conflicts, "the conflict list is the payload the UI resolves from"
    assert any(c.get("path") == ["owner"] for c in conflicts), conflicts


async def _t_a_conflict_leaves_main_UNCHANGED():
    """A refused sync must change nothing at all — no half-applied commit."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="team1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    await _user_edits(svc, gid, _eid(st, "u:A"),
                      {"urn": "u:A", "entityType": "Dataset", "owner": "user-choice"})
    before = len(await svc.commit_log(graph_id=gid, limit=50))

    with pytest.raises(MergeConflict):
        await svc.sync_ingest(graph_id=gid, rows=[
            _node("u:A", owner="source-choice"), _node("u:NEW")], actor="ext", strategy="merge")

    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert _find(st, "u:A")["owner"] == "user-choice", "nothing may be applied"
    assert _find(st, "u:NEW") is None, "not even the UNCONFLICTED part of the snapshot"
    assert len(await svc.commit_log(graph_id=gid, limit=50)) == before, "no commit written"


async def _t_resolutions_let_the_caller_settle_a_conflict():
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="team1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    eid = _eid(st, "u:A")
    await _user_edits(svc, gid, eid, {"urn": "u:A", "entityType": "Dataset", "owner": "user-choice"})

    rows = [_node("u:A", owner="source-choice")]
    with pytest.raises(MergeConflict):
        await svc.sync_ingest(graph_id=gid, rows=rows, actor="ext", strategy="merge")

    await svc.sync_ingest(graph_id=gid, rows=rows, actor="ext", strategy="merge",
                          resolutions={eid: {"urn": "u:A", "entityType": "Dataset",
                                             "owner": "decided-by-a-human"}})

    a = _find(await svc.materialize_state(graph_id=gid, branch_id=main), "u:A")
    assert a["owner"] == "decided-by-a-human"


async def _t_source_delete_vs_user_modify_conflicts():
    """The scariest conflict: the source dropped an entity a human was working on."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A"), _node("u:B", owner="t1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    await _user_edits(svc, gid, _eid(st, "u:B"),
                      {"urn": "u:B", "entityType": "Dataset", "owner": "carefully-curated"})

    with pytest.raises(MergeConflict):
        await svc.sync_ingest(graph_id=gid, rows=[_node("u:A")], actor="ext", strategy="merge")


# ── 4. external_wins — PINNING A BUG ON PURPOSE ──────────────────────────────

async def _t_external_wins_TODAY_destroys_untouched_curation():
    """CHARACTERISATION OF A DEFECT, recorded so the fix is a visible semantic change.

    `external_wins` reads as "the source wins the disagreement". It does not. It is

        merged[eid] = theirs.get(eid)          # the ENTIRE external payload

    — the careful field-level merge is DISCARDED. So a single conflicting field takes the whole
    entity down with it: `businessOwner` and `classification`, which the source has never heard
    of and did not touch, are silently deleted.

    The blast radius scales with curation: the more valuable the graph, the more this destroys.
    When we make external_wins field-level, THIS TEST MUST BE REWRITTEN — and that rewrite is
    the record that we changed the contract deliberately.
    """
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="team1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    await _user_edits(svc, gid, _eid(st, "u:A"), {
        "urn": "u:A", "entityType": "Dataset",
        "owner": "user-choice",              # ← conflicts with the source
        "businessOwner": "Jane",             # ← the source has never heard of these
        "classification": "PII",
    })

    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="source-choice")],
                          actor="ext", strategy="external_wins")

    a = _find(await svc.materialize_state(graph_id=gid, branch_id=main), "u:A")
    assert a["owner"] == "source-choice", "the source wins the conflicting field — as intended"
    assert "businessOwner" not in a, (
        "TODAY: untouched curation is DESTROYED. This assertion is the bug, pinned. "
        "After the fix it becomes  a['businessOwner'] == 'Jane'.")
    assert "classification" not in a


# ── 5. identity: a re-sync must UPDATE, never duplicate ──────────────────────

async def _t_nodes_match_by_urn_and_edges_by_endpoint_triple():
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A"), _node("u:B"), _edge("u:A", "u:B")])

    # the same snapshot again, with a changed field — must MATCH IN PLACE
    await svc.sync_ingest(graph_id=gid, rows=[
        _node("u:A", owner="t2"), _node("u:B"), _edge("u:A", "u:B", note="x")], actor="ext")

    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    live_nodes = [p for p in st["nodes"].values() if p]
    assert len([p for p in live_nodes if p.get("urn") == "u:A"]) == 1, "no duplicate node"
    assert len([p for p in st["edges"].values() if p]) == 1, "no duplicate edge"


# ── 6. integrity: a sync may not leave the graph broken ──────────────────────

async def _t_deleting_a_node_cascades_to_its_edges():
    """The source drops B. The A→B edge cannot survive it — a dangling edge is corruption."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A"), _node("u:B"), _edge("u:A", "u:B")])

    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A")], actor="ext")   # B gone

    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert _find(st, "u:B") is None
    assert not [p for p in st["edges"].values() if p], "the incident edge must go with it"


# ── 7. commit shape + idempotency ────────────────────────────────────────────

async def _t_a_sync_lands_as_exactly_one_sync_commit():
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A")])

    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="t2"), _node("u:C")], actor="ext")

    kinds = [c["kind"] for c in await svc.commit_log(graph_id=gid, limit=50)]
    assert kinds.count("sync") == 1, f"one sync commit, got {kinds}"


async def _t_a_no_op_sync_writes_no_commit():
    """Re-syncing an unchanged source must not churn history."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="t1")])
    before = len(await svc.commit_log(graph_id=gid, limit=50))

    res = await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="t1")], actor="ext")

    assert res["commit_id"] is None, "nothing changed → nothing to commit"
    assert len(await svc.commit_log(graph_id=gid, limit=50)) == before


async def _t_idempotency_key_replays_instead_of_reapplying():
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="t1")])
    rows = [_node("u:A", owner="t2")]

    r1 = await svc.sync_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key="s1")
    r2 = await svc.sync_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key="s1")

    assert r1["commit_id"] == r2["commit_id"], "a replay returns the SAME commit"
    kinds = [c["kind"] for c in await svc.commit_log(graph_id=gid, limit=50)]
    assert kinds.count("sync") == 1, "and does not write a second one"


# ── runner ───────────────────────────────────────────────────────────────────

_CASES = [v for k, v in sorted(globals().items()) if k.startswith("_t_")]


@pytest.mark.parametrize("case", _CASES, ids=[c.__name__[3:] for c in _CASES])
def test_sync_characterisation(case):
    async def go():
        await models.create_schema_and_partitions()
        try:
            await case()
        finally:
            await db.dispose_engine()
    asyncio.run(go())
