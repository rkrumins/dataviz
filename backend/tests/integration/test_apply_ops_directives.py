"""A property operation's directives, applied by ``apply_ops`` to a draft.

Each directive is decided inside the commit on the value the entity has in the DRAFT now, not
on main's and not on what the caller last saw, and ``apply_ops`` says what it did to each entity:
changed, unchanged, not live in the draft, or a rename whose target already has a value. A
batch where nothing changes writes no commit. Values are written as typed, exactly.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

INT64_MAX = 2**63 - 1


def _node(eid, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Dataset", "displayName": eid, "properties": props}}


def _op(eid, **directive):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "directive": directive}


async def _props(svc, gid, branch_id):
    nodes = (await svc.materialize_state(graph_id=gid, branch_id=branch_id))["nodes"]
    return {eid: n.get("properties") for eid, n in nodes.items()}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[
        _node("A", owner="bob", code="42"), _node("B", owner="carol", steward="dave"),
        _node("C", tier="  "), _node("D", owner="erin")])

    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[
        {"op": "delete", "entity_kind": "node", "entity_id": "D"},
        {"op": "update", "entity_kind": "node", "entity_id": "C", "payload": {"properties": {"tier": "gold"}}}])

    # A rename across the draft: each entity decided on its own value.
    outcome = {}
    cid = await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="rename owner",
                              outcome=outcome, ops=[
        _op("A", kind="rename", key="owner", newKey="steward"),
        _op("B", kind="rename", key="owner", newKey="steward"),
        _op("C", kind="rename", key="owner", newKey="steward"),
        _op("D", kind="rename", key="owner", newKey="steward"),
        _op("GHOST", kind="rename", key="owner", newKey="steward")])
    assert cid
    assert outcome == {"changed": ["A"], "unchanged": ["C"], "notInDraft": ["D", "GHOST"],
                       "targetExists": ["B"], "changedSince": []}, outcome
    props = await _props(svc, gid, draft)
    assert props["A"] == {"steward": "bob", "code": "42"}, props["A"]
    assert props["B"] == {"owner": "carol", "steward": "dave"}, props["B"]
    assert (await _props(svc, gid, main))["A"] == {"owner": "bob", "code": "42"}, "main is untouched"

    # Fill empty reads the DRAFT's value: C's tier is blank on main but "gold" in the draft.
    outcome = {}
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", outcome=outcome, ops=[
        _op("A", kind="fillEmpty", key="tier", value="silver"),
        _op("C", kind="fillEmpty", key="tier", value="silver")])
    assert outcome["changed"] == ["A"] and outcome["unchanged"] == ["C"], outcome

    # Set writes as typed and exactly: a stored "42" becomes 42, and the largest int64 survives.
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[
        _op("A", kind="set", key="code", value=42),
        _op("B", kind="set", key="gvId", value=INT64_MAX)])
    props = await _props(svc, gid, draft)
    assert props["A"]["code"] == 42 and type(props["A"]["code"]) is int, props["A"]
    assert props["B"]["gvId"] == INT64_MAX, props["B"]

    # Nothing to change: no commit, and the outcome still says so.
    outcome = {}
    assert await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", outcome=outcome, ops=[
        _op("A", kind="set", key="code", value=42), _op("B", kind="remove", key="nope")]) is None
    assert outcome["unchanged"] == ["A", "B"] and outcome["changed"] == [], outcome

    # Refused: a directive on anything but a node update, two ops on one entity, a malformed one,
    # and a directive through the staged path (it is decided at commit time, never staged).
    for bad in (
        [{"op": "create", "entity_kind": "node", "entity_id": "Z", "payload": {},
          "directive": {"kind": "remove", "key": "k"}}],
        [{"op": "update", "entity_kind": "edge", "entity_id": "E", "directive": {"kind": "remove", "key": "k"}}],
        [_op("A", kind="remove", key="code"),
         {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "x"}}],
        [{"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "x"}},
         _op("A", kind="remove", key="code")],
        [_op("A", kind="rename", key="code", newKey="code")],
    ):
        with pytest.raises(ValueError):
            await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=bad)
    with pytest.raises(ValueError):
        await svc.stage_changes(graph_id=gid, branch_id=draft, actor="alice",
                                ops=[_op("A", kind="remove", key="code")])
    assert (await _props(svc, gid, draft))["A"]["code"] == 42, "nothing refused was written"

    # A draft published or discarded takes no more of an operation.
    await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="publish")
    gone = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.abandon_draft(graph_id=gid, branch_id=gone, actor="alice")
    for closed in (draft, gone):
        with pytest.raises(ValueError, match="merged|abandoned"):
            await svc.apply_ops(graph_id=gid, branch_id=closed, actor="alice",
                                ops=[_op("A", kind="set", key="late", value=1)])
    await db.dispose_engine()


async def _run_publish_waits() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", ops=[_node("A", owner="bob"), _node("B")])
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[_op("B", kind="set", key="x", value=1)])

    # A window part-way through its commit when the publish starts: it has read A's value and not
    # yet written. The publish must wait for it and publish what it wrote.
    real, reading = svc._current_values, asyncio.Event()

    async def slow(*args, **kwargs):
        reading.set()
        await asyncio.sleep(0.5)
        return await real(*args, **kwargs)

    svc._current_values = slow
    window = asyncio.create_task(svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice",
                                               ops=[_op("A", kind="set", key="reviewed", value=True)]))
    await reading.wait()
    svc._current_values = real
    await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="publish")
    assert await window
    main = await svc.main_branch_id(gid)
    assert (await _props(svc, gid, main))["A"] == {"owner": "bob", "reviewed": True}, "the window was published"
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_directives_are_decided_on_the_drafts_value_and_say_what_they_did():
    asyncio.run(_run())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_publish_waits_for_an_operations_window_and_publishes_it():
    asyncio.run(_run_publish_waits())
