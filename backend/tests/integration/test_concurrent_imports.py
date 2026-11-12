"""Many drafts of one graph at once — people's and imports' — each published onto main, and main
projected into FalkorDB after each, on Postgres and the timing-out fake FalkorDB.

Pins:
- Two connectors import into a graph at the same time, each into a draft of its own (one import
  at a time per draft, any number per graph), keyed by urn. Each updates its own nodes and makes
  the same five new tables and the same edge, alike: their ids are derived from the urns, so both
  name the same entities.
- A person edits a node one of the imports also changes, in another field, in a draft of their own.
- Each import publishes itself. The first lands. The second's publish job finds main moved under
  it, so it pulls main into the draft (the field-level merge a person's "Pull latest" runs) and
  publishes it again: the entities both made merge as one, and it lands. The person pulls and
  publishes too. Main then holds one entity per urn, every update, and the ids the first import
  made.
- An import that changed a field a person changed differently meanwhile pulls, finds the
  conflict, and its job ends refused, the draft waiting for someone to resolve it, saying why. A
  draft past ``SQUASH_PAGED_ABOVE`` changes pulls the same way, reading only what main changed
  too: what main gained meanwhile stays, in a field the file carries unchanged too.
- After each publish, one projection pass brings FalkorDB to main, a window at a time.
"""
import asyncio
import json
import os

import pytest

from backend.app.services.storage.object_store import storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export.resolve import pointer_id
from backend.app.services.versioning.projection import FalkorProjector
from backend.tests.integration._fake_falkor import TimeoutFalkor
from backend.tests.integration.test_versioning_projection import _assert_matches_main

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

_PUBLISHER = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:datasource:publish")


def _table(urn, **props):
    return {"kind": "node", "urn": urn, "entityType": "Table", "displayName": urn.rsplit(":", 1)[-1],
            **{f"prop.{k}": v for k, v in props.items()}}


_SHARED = [_table(f"urn:new:{i}", origin="feed") for i in range(5)] + [
    {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": "urn:new:0", "targetUrn": "urn:t:1"}]


async def _one(body):
    yield body


async def _run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
    from backend.app.services import permission_service
    from backend.app.services.permission_service import PermissionClaims

    async def publisher(_session, _user_id, *_args, **_kwargs):
        return PermissionClaims(sid="", ws_perms={"ws1": _PUBLISHER})

    monkeypatch.setattr(permission_service, "resolve", publisher)
    await models.create_schema_and_partitions()
    svc, ie = get_versioning_service(), get_import_export_service()
    fake = TimeoutFalkor(max_rows=40)
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice",
                                  falkor_graph_name="gvt_" + os.urandom(3).hex(),
                                  owns_falkor_graph=True))["graph_id"]
    main = await svc.main_branch_id(gid)
    scope = await svc.identity_scope(gid)

    async def queued(records, actor):
        key = storage_key("ws1", ds, gid, "e2e", f"{os.urandom(3).hex()}.ndjson")
        await ie.store.put_stream(key, _one("".join(json.dumps(r) + "\n" for r in records).encode()))
        return await ie.create_import_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, actor=actor,
                                          import_format="ndjson", source_uri=key, identifier="urn",
                                          auto_publish=True)

    async def note(job):
        return (await ie.get_job(job["job_id"]))["summary"]["publish"]

    async def projected():
        done = await proj.project_graph(gid)
        assert done["verify_error"] is None, done
        await _assert_matches_main(svc, fake, gid)

    async def main_state():
        return await svc.materialize_state(graph_id=gid, branch_id=main)

    # main: 20 tables, by urn.
    seed = await queued([_table(f"urn:t:{i}", p="0") for i in range(20)], "alice")
    await ie.run_import(seed["job_id"])
    await ie.run_publish((await note(seed))["jobId"])
    await projected()
    t = {i: pointer_id(scope, f"urn:t:{i}") for i in range(20)}

    # A person's draft, open before either import: a note on table 0, which feed A changes too.
    bobs = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=bobs, actor="bob", message="note", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": t[0], "payload": {"properties": {"note": "bob"}}}])

    # Two feeds at once, each into a draft of its own.
    a = await queued([_table(f"urn:t:{i}", p="a") for i in range(5)] + _SHARED, "alice")
    b = await queued([_table(f"urn:t:{i}", p="b") for i in range(5, 10)] + _SHARED, "alice")
    assert a["branch_id"] != b["branch_id"]
    await asyncio.gather(ie.run_import(a["job_id"]), ie.run_import(b["job_id"]))
    first, second = await note(a), await note(b)
    assert (first["state"], second["state"]) == ("queued", "queued"), (first, second)

    assert (await ie.run_publish(first["jobId"])).get("commitId")
    await projected()
    # Main moved under the second: its publish job pulls main into its draft and publishes it.
    assert (await ie.run_publish(second["jobId"])).get("commitId")
    assert await note(b) == {"state": "queued", "jobId": second["jobId"], "pulls": 1}
    await projected()

    # The person pulls what both feeds published, and publishes.
    pulled = await svc.rebase_draft(graph_id=gid, branch_id=bobs, actor="bob")
    assert pulled["clean"], pulled
    await svc.publish(graph_id=gid, branch_id=bobs, actor="bob", message="note")
    await projected()

    state = await main_state()
    by_urn = {}
    for eid, n in state["nodes"].items():
        by_urn.setdefault(n["urn"], []).append(eid)
    assert all(len(ids) == 1 for ids in by_urn.values()), by_urn       # one entity per urn
    assert len(by_urn) == 25
    assert by_urn["urn:new:0"] == [pointer_id(scope, "urn:new:0")]
    props = {i: state["nodes"][t[i]].get("properties", {}) for i in range(20)}
    assert [props[i]["p"] for i in range(12)] == ["a"] * 5 + ["b"] * 5 + ["0"] * 2
    assert props[0]["note"] == "bob"
    assert len(state["edges"]) == 1

    # A field a person changed differently while a feed changed it: a conflict, for review.
    carols = await svc.open_draft(graph_id=gid, owner="carol")
    await svc.apply_ops(graph_id=gid, branch_id=carols, actor="carol", message="p", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": t[15], "payload": {"properties": {"p": "carol"}}}])
    c = await queued([_table("urn:t:15", p="feed")], "alice")
    await ie.run_import(c["job_id"])
    await svc.publish(graph_id=gid, branch_id=carols, actor="carol", message="p")
    await projected()
    held = await ie.run_publish((await note(c))["jobId"])
    assert (held["error"]["detail"]["type"], held["error"]["detail"]["conflicts"]) == ("conflicts", 1), held
    waits = await note(c)
    assert (waits["state"], waits["reason"]["type"], waits["pulls"]) == ("skipped", "conflicts", 1), waits
    assert (await svc.branch_statuses([c["branch_id"]]))[c["branch_id"]] == "open"
    assert (await main_state())["nodes"][t[15]]["properties"]["p"] == "carol"

    # A draft past SQUASH_PAGED_ABOVE changes pulls reading only what main changed too, and lands.
    d = await queued([_table(f"urn:t:{i}", p="d") for i in range(16, 20)], "alice")
    await ie.run_import(d["job_id"])
    eves = await svc.open_draft(graph_id=gid, owner="eve")
    await svc.apply_ops(graph_id=gid, branch_id=eves, actor="eve", message="p", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": t[12], "payload": {"properties": {"p": "eve"}}},
        # A field the file carries, unchanged: main's new value is kept, not the file's old one.
        {"op": "update", "entity_kind": "node", "entity_id": t[16], "payload": {"displayName": "sixteen"}}])
    await svc.publish(graph_id=gid, branch_id=eves, actor="eve", message="p")
    monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 3)
    assert (await ie.run_publish((await note(d))["jobId"])).get("commitId")
    assert (await note(d))["pulls"] == 1
    assert (await svc.branch_statuses([d["branch_id"]]))[d["branch_id"]] == "merged"
    await projected()
    nodes = (await main_state())["nodes"]
    assert [nodes[t[i]]["properties"]["p"] for i in range(16, 20)] == ["d"] * 4
    assert nodes[t[12]]["properties"]["p"] == "eve", "what main gained meanwhile stays"
    assert nodes[t[16]]["displayName"] == "sixteen", "in a field the file carries unchanged too"
    assert sum(1 for n in nodes.values() if n["urn"].startswith("urn:t:")) == 20, "nothing made twice"


def test_drafts_of_one_graph_import_publish_and_pull_at_once(monkeypatch):
    async def run():
        try:
            await _run(monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
