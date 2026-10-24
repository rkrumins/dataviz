"""A sync refuses to undo people's work or to delete most of a graph — needs Postgres.

A sync's merge base is main as it stood at the last import or sync. Human edits published
before that sync are inside the base, so the next sync reads them as "the source's old value"
and reverts them, and deletes what people created (AUTOVSHUMAN-01). Until the source shadow
(INGEST S1) becomes the base, such a sync is refused with ``CurationAtRisk``, unless an admin
passes ``allow_curation_risk``. A sync deletes by absence, so a snapshot missing rows deletes
them (BOOTSTRAP-3); more deletes than max(SYNC_DELETE_MAX_ABS, SYNC_DELETE_MAX_FRACTION x live)
are refused with ``MassDeleteBlocked``, unless an admin passes ``allow_mass_delete``.

Run: GRAPHVER_E2E=1 pytest backend/tests/integration/test_sync_curation_guard.py
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import CurationAtRisk, MassDeleteBlocked
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")


# ── helpers (as in test_versioning_sync_characterisation.py) ─────────────────

def _node(urn, **kw):
    return {"kind": "node", "urn": urn, "entityType": "Dataset", **kw}


def _eid(state, urn):
    return next(e for e, p in state["nodes"].items() if p and p.get("urn") == urn)


def _find(state, urn):
    for p in state["nodes"].values():
        if p and p.get("urn") == urn:
            return p
    return None


async def _seed(svc, rows):
    g = await svc.create_graph(
        data_source_id="ds_" + os.urandom(5).hex(), workspace_id="ws1", actor="ext",
        falkor_graph_name="gvt_" + os.urandom(4).hex())
    gid, main = g["graph_id"], g["main_branch_id"]
    await svc.bulk_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key="imp")
    return gid, main


async def _user_edits(svc, gid, eid, payload, actor="user"):
    """A human edit, published to main."""
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[
        {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": payload}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message="user edit")


async def _curated(svc):
    """Imported A, then a human renamed it, then a sync landed: the rename is in the base."""
    gid, main = await _seed(svc, [_node("u:A", displayName="A", owner="t1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    eid = _eid(st, "u:A")
    await _user_edits(svc, gid, eid, {**st["nodes"][eid], "displayName": "A-edited"})
    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", displayName="A", owner="t2")],
                          actor="ext")
    return gid, main, eid


async def _commits(svc, gid):
    return await svc.commit_log(graph_id=gid, limit=50)


def _limits(mp, max_abs):
    mp.setattr(config, "SYNC_DELETE_MAX_ABS", max_abs)
    mp.setattr(config, "SYNC_DELETE_MAX_FRACTION", 0.05)


_TEN = [_node(f"u:{i}") for i in range(10)]


# ── curation at risk ─────────────────────────────────────────────────────────

async def _t_second_sync_after_curation_is_refused_and_changes_nothing(mp):
    svc = GraphVersioningService()
    gid, main, _ = await _curated(svc)
    before = len(await _commits(svc, gid))

    with pytest.raises(CurationAtRisk) as refused:
        await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", displayName="A", owner="t2")],
                              actor="ext")

    last = refused.value.detail["lastHumanCommit"]
    assert (last["kind"], last["actor"]) == ("squash_publish", "user")
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert _find(st, "u:A")["displayName"] == "A-edited", "the human rename must survive"
    assert len(await _commits(svc, gid)) == before


async def _t_user_created_node_is_not_deleted_by_a_later_sync(mp):
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", owner="t1")])
    d = await svc.open_draft(graph_id=gid, owner="user")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="user", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "mine:1",
         "payload": {"urn": "u:MINE", "entityType": "Dataset", "displayName": "Hand-made"}}])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="user")
    await svc.publish(graph_id=gid, branch_id=d, actor="user", message="user create")
    await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="t2")], actor="ext")

    with pytest.raises(CurationAtRisk):
        await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", owner="t2")], actor="ext")

    assert _find(await svc.materialize_state(graph_id=gid, branch_id=main), "u:MINE") is not None


async def _t_admin_override_proceeds_and_is_audited(mp):
    svc = GraphVersioningService()
    gid, main, _ = await _curated(svc)

    res = await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", displayName="A", owner="t2")],
                                actor="admin1", allow_curation_risk=True)

    assert res["commit_id"] and res["overrides"] == ["curation_at_risk"]
    newest = (await _commits(svc, gid))[0]
    assert (newest["kind"], newest["actor"]) == ("sync", "admin1")
    assert "admin override: curation_at_risk" in newest["message"]


async def _t_first_sync_after_curation_is_still_allowed(mp):
    """Regression pin: human commits NEWER than the last import are outside the base."""
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", displayName="A", owner="t1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    eid = _eid(st, "u:A")
    await _user_edits(svc, gid, eid, {**st["nodes"][eid], "displayName": "A-edited"})

    res = await svc.sync_ingest(graph_id=gid, rows=[_node("u:A", displayName="A", owner="t2")],
                                actor="ext")

    assert res["commit_id"] and res["overrides"] == []
    a = _find(await svc.materialize_state(graph_id=gid, branch_id=main), "u:A")
    assert (a["displayName"], a["owner"]) == ("A-edited", "t2")


async def _t_idempotent_replay_is_not_blocked(mp):
    svc = GraphVersioningService()
    gid, main = await _seed(svc, [_node("u:A", displayName="A", owner="t1")])
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    eid = _eid(st, "u:A")
    await _user_edits(svc, gid, eid, {**st["nodes"][eid], "displayName": "A-edited"})
    rows = [_node("u:A", displayName="A", owner="t2")]
    r1 = await svc.sync_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key="k1")
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    await _user_edits(svc, gid, eid, {**st["nodes"][eid], "displayName": "A-again"})

    r2 = await svc.sync_ingest(graph_id=gid, rows=rows, actor="ext", idempotency_key="k1")

    assert r2["idempotent_replay"] is True and r2["commit_id"] == r1["commit_id"]


async def _t_resync_from_provider_refuses_before_paging(mp):
    class _Unpageable:
        async def get_nodes(self, *_a, **_kw):
            raise AssertionError("the provider was paged before the curation check")
        get_edges = get_nodes

    svc = GraphVersioningService()
    gid, _main, _ = await _curated(svc)

    with pytest.raises(CurationAtRisk):
        await svc.resync_from_provider(graph_id=gid, provider=_Unpageable(), actor="ext")


# ── mass delete ──────────────────────────────────────────────────────────────

async def _t_mass_delete_is_refused(mp):
    _limits(mp, 2)
    svc = GraphVersioningService()
    gid, main = await _seed(svc, _TEN)

    with pytest.raises(MassDeleteBlocked) as refused:
        await svc.sync_ingest(graph_id=gid, rows=_TEN[:2], actor="ext")

    assert (refused.value.detail["deletes"], refused.value.detail["live"],
            refused.value.detail["limit"]) == (8, 10, 2)
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert sum(1 for p in st["nodes"].values() if p) == 10


async def _t_mass_delete_override(mp):
    _limits(mp, 2)
    svc = GraphVersioningService()
    gid, main = await _seed(svc, _TEN)

    res = await svc.sync_ingest(graph_id=gid, rows=_TEN[:2], actor="admin1",
                                allow_mass_delete=True)

    assert res["overrides"] == ["mass_delete"]
    assert "admin override: mass_delete" in (await _commits(svc, gid))[0]["message"]
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert sum(1 for p in st["nodes"].values() if p) == 2


async def _t_deletes_within_the_limit_pass(mp):
    _limits(mp, 2)
    svc = GraphVersioningService()
    gid, main = await _seed(svc, _TEN)

    res = await svc.sync_ingest(graph_id=gid, rows=_TEN[:9], actor="ext")

    assert res["commit_id"] and res["overrides"] == []
    st = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert sum(1 for p in st["nodes"].values() if p) == 9


# ── runner ───────────────────────────────────────────────────────────────────

_CASES = [v for k, v in sorted(globals().items()) if k.startswith("_t_")]


@pytest.mark.parametrize("case", _CASES, ids=[c.__name__[3:] for c in _CASES])
def test_sync_curation_guard(case, monkeypatch):
    async def go():
        await models.create_schema_and_partitions()
        try:
            await case(monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(go())
