"""``POST /graph/commands/batch`` lands as ONE commit on a versioned graph (doc 19 §3.8).

It used to commit each command on its own, so a script's hundred commands were a hundred commits
and the change they made together was lost among them. Now the versioned provider holds each
command's write (``write_batch``) and the route commits them together — down both of main's
paths: from Postgres while the projection is behind, and through the write-through wrapper once
it has caught up.
- A command the engine refuses (an edge to a node that isn't there) is that command's result, and
  the rest land.
- A busy graph lands nothing: the batch can be sent again as it was.
- A batch the store refuses as a whole runs again command by command, so each result says whether
  that command landed.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.errors import LockBusy
from backend.app.services.versioning.service import GraphVersioningService

from .test_versioning_main_write_publish import GP, PAT, V1, _app, _seed, no_flag_or_projector  # noqa: F401

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _table(name):
    return {"op": "create_node", "payload": {"entityType": "Table", "displayName": name}}


async def _main(svc, gid):
    return await svc.commit_log(graph_id=gid)


async def _run(provider_cls_name: str, monkeypatch, with_edges: bool) -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.providers import versioned_branch_provider, versioned_write_provider
    from .test_api_graph_draft_journey import _StubCache, _StubManager

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    provider = {"VersionedBranchProvider": versioned_branch_provider.VersionedBranchProvider,
                "VersionedWriteProvider": versioned_write_provider.VersionedWriteProvider
                }[provider_cls_name]
    used = []
    real = provider.commit_deferred

    async def counted(self, ops, message):
        used.append(len(ops))
        return await real(self, ops, message)
    monkeypatch.setattr(provider, "commit_deferred", counted)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=PAT)
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            await svc.apply_ops(graph_id=gid, actor="seed", message="seed", ops=_seed("e1", "N", "M"))
            q = {"dataSourceId": ds}

            # Five commands, one commit. (The stub store behind the projection holds no nodes, so
            # an edge between main's nodes is made only where main is read from Postgres.)
            before = await _main(svc, gid)
            commands = [_table("one"), _table("two"), _table("three")]
            if with_edges:
                commands += [
                    {"op": "create_edge", "payload": {"sourceUrn": "M", "targetUrn": "N",
                                                      "edgeType": "LINEAGE"}},
                    {"op": "delete_edge", "payload": {"edgeId": "e1"}}]
            else:
                commands += [_table("three and a half"), {"op": "delete_edge", "payload": {"edgeId": "e1"}}]
            r = await c.post(f"{GP}/commands/batch", params=q, headers=PAT, json={"commands": commands})
            assert r.status_code == 200, r.text
            assert r.json()["succeeded"] == 5, r.text
            after = await _main(svc, gid)
            assert len(after) == len(before) + 1, [c["message"] for c in after]
            batch = after[0]
            assert (batch["kind"], batch["message"], batch["actor"]) == ("edit", "batch: 5 commands", "pat")
            assert batch["stats"]["create"] == 4 and batch["stats"]["delete"] == 1, batch["stats"]
            assert used and used[-1] >= 5, used
            assert await svc.entity_value(graph_id=gid, entity_id="e1") is None

            # A command the engine refuses is its own result; the others land, together.
            before = await _main(svc, gid)
            r = await c.post(f"{GP}/commands/batch", params=q, headers=PAT, json={
                "fail_fast": False, "commands": [
                    _table("four"),
                    {"op": "create_edge", "payload": {"sourceUrn": "nope", "targetUrn": "N",
                                                      "edgeType": "LINEAGE"}},
                    _table("five")]})
            body = r.json()
            assert [x["success"] for x in body["results"]] == [True, False, True], body
            assert "not found" in body["results"][1]["error"], body
            assert len(await _main(svc, gid)) == len(before) + 1

            # A busy graph lands nothing: a 503 to send again.
            async def busy(self, ops, message):
                raise LockBusy(gid)
            monkeypatch.setattr(provider, "commit_deferred", busy)
            before = await _main(svc, gid)
            r = await c.post(f"{GP}/commands/batch", params=q, headers=PAT,
                             json={"commands": [_table("six"), _table("seven")]})
            assert r.status_code == 503, r.text
            assert len(await _main(svc, gid)) == len(before)

            # Refused as a whole: run again one command at a time, each its own commit.
            async def refused(self, ops, message):
                raise ValueError("the batch, as a whole, breaks a rule")
            monkeypatch.setattr(provider, "commit_deferred", refused)
            r = await c.post(f"{GP}/commands/batch", params=q, headers=PAT,
                             json={"commands": [_table("eight"), _table("nine")]})
            assert r.status_code == 200 and r.json()["succeeded"] == 2, r.text
            assert len(await _main(svc, gid)) == len(before) + 2
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


def test_a_batch_from_postgres_is_one_commit(data_sources, no_flag_or_projector, monkeypatch):
    asyncio.run(_run("VersionedBranchProvider", monkeypatch, with_edges=True))


def test_a_batch_through_the_projection_is_one_commit(data_sources, no_flag_or_projector, monkeypatch):
    async def _fresh(self, graph_id):
        return {"fresh": True, "committed": 1, "projected": 1}
    monkeypatch.setattr(GraphVersioningService, "projection_watermark", _fresh)
    asyncio.run(_run("VersionedWriteProvider", monkeypatch, with_edges=False))
