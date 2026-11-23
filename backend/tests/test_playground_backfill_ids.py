"""``scripts/playground_backfill_ids.py``: a Playground graph made before graphs there were
identified by ``id`` is given that identifier — one commit writing ``id = urn`` onto each thing
without one, THEN its data source identified by ``id`` — dry run by default, and idempotent.
"""
from __future__ import annotations

import json

import pytest

from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.scripts.playground_backfill_ids import backfill, plan_id_backfill


def test_each_thing_without_an_id_is_given_its_urn():
    ops = plan_id_backfill({
        "n2": {"urn": "urn:b", "properties": {"owner": "x"}},
        "n1": {"urn": "urn:a"},
        "n3": {"urn": "urn:c", "properties": {"id": "urn:c"}},        # has one: left alone
        "n4": {"properties": {"id": "  "}},                            # blank, and no urn: its id
        "n5": None,
    })
    assert ops == [
        {"op": "update", "entity_kind": "node", "entity_id": "n1", "payload": {"properties": {"id": "urn:a"}}},
        {"op": "update", "entity_kind": "node", "entity_id": "n2", "payload": {"properties": {"id": "urn:b"}}},
        {"op": "update", "entity_kind": "node", "entity_id": "n4", "payload": {"properties": {"id": "n4"}}},
    ]


class _Graphs:
    """The version store: a graph per data source but ``ds_none``; what was committed, and the
    data source's identity at the moment of each commit."""

    def __init__(self, session):
        self.session = session
        self.commits: list = []

    async def get_graph_by_data_source(self, ds_id):
        return None if ds_id == "ds_none" else {"graph_id": f"g_{ds_id}"}

    async def main_branch_id(self, graph_id):
        return f"main_{graph_id}"

    async def materialize_state(self, *, graph_id, branch_id):
        return {"nodes": {"n1": {"urn": "urn:a"}, "n2": {"urn": "urn:b", "properties": {"id": "urn:b"}}}, "edges": {}}

    async def apply_ops(self, *, graph_id, ops, actor, message):
        ds = await self.session.get(WorkspaceDataSourceORM, graph_id.removeprefix("g_"))
        self.commits.append((graph_id, [o["entity_id"] for o in ops], actor, ds.identity_property))
        return f"c_{len(self.commits)}"


@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        ProviderORM(id="prov_1", name="Sandbox", provider_type="falkordb"),
        WorkspaceORM(id="ws_play", name="Playground", kind="playground",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_1"})),
        WorkspaceORM(id="ws_team", name="Team"),
    ])
    await db_session.flush()
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_old", workspace_id="ws_play", provider_id="prov_1", graph_name="a", label="Old"),
        WorkspaceDataSourceORM(id="ds_new", workspace_id="ws_play", provider_id="prov_1", graph_name="b", label="New",
                               identity_property="id"),
        WorkspaceDataSourceORM(id="ds_none", workspace_id="ws_play", provider_id="prov_1", graph_name="c", label="None"),
        WorkspaceDataSourceORM(id="ds_team", workspace_id="ws_team", provider_id="prov_1", graph_name="d", label="Team"),
    ])
    await db_session.commit()


async def _identity(db_session, ds_id):
    db_session.expire_all()
    return (await db_session.get(WorkspaceDataSourceORM, ds_id)).identity_property


@pytest.mark.asyncio
async def test_a_dry_run_says_what_it_would_do_and_does_nothing(db_session, estate):
    graphs = _Graphs(db_session)
    said: list = []
    totals = await backfill(db_session, graphs, apply=False, actor="ops", log=said.append)
    assert totals == {"would_backfill": 1, "already": 1, "skipped": 1}
    assert graphs.commits == [] and await _identity(db_session, "ds_old") is None
    assert any("ds_old (Old): graph g_ds_old, 2 things, 1 without an id" in line for line in said)


@pytest.mark.asyncio
async def test_it_writes_the_ids_then_identifies_the_graph_by_them_once(db_session, estate, monkeypatch):
    from backend.scripts import playground_backfill_ids as script
    dropped: list = []

    async def _invalidate(_session, scopes, reason):
        dropped.append((scopes, reason))
    monkeypatch.setattr(script, "invalidate_node_identity", _invalidate)
    graphs = _Graphs(db_session)
    totals = await backfill(db_session, graphs, apply=True, actor="ops", log=lambda _line: None)
    assert totals == {"backfilled": 1, "already": 1, "skipped": 1}
    # The ids were written while the graph was still identified by its urn; then by its id, and
    # what served the old mapping dropped.
    assert graphs.commits == [("g_ds_old", ["n1"], "ops", None)]
    assert await _identity(db_session, "ds_old") == "id"
    assert dropped == [([("ws_play", "ds_old")], "playground-backfill-ids")]
    assert await _identity(db_session, "ds_team") is None              # never outside the Playground

    again = await backfill(db_session, graphs, apply=True, actor="ops", log=lambda _line: None)
    assert again == {"already": 2, "skipped": 1} and len(graphs.commits) == 1
