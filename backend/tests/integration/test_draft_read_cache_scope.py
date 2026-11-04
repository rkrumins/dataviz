"""A draft's cached reads follow its version — needs Postgres.

Graph reads are cached by branch and a per-data-source generation that app writes bump. A write
that bumps nothing — an import job's windows, run by a worker — left a draft's cached children,
top level and assignments as they were before it, for up to an hour. A draft's reads are now keyed
by its version as well (its head, branch point, main's head, status), as a fork's and a revision's
are: any commit to the draft, from anywhere, moves every key of it.
"""
import asyncio
import os

import pytest

from backend.app.db.repositories import data_source_repo
from backend.app.services.context_engine import ContextEngine
from backend.app.services.graph_reads import cache_scope
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_draft_read_routing import _for_workspace

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("N1")])
    draft = await svc.open_draft(graph_id=gid, owner="u")
    try:
        before = cache_scope(await _for_workspace(ds, draft))
        main_before = cache_scope(await _for_workspace(ds, "main"))
        # A commit no request made — as an import window lands one.
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="import",
                            ops=[_node("N2")])
        after = cache_scope(await _for_workspace(ds, draft))
        assert before.branch_id == after.branch_id == draft
        assert before.graph_ns and after.graph_ns and before.graph_ns != after.graph_ns
        # main's reads keep their keys: only the draft moved.
        assert cache_scope(await _for_workspace(ds, "main")).graph_ns == main_before.graph_ns
    finally:
        await db.dispose_engine()


def test_a_commit_to_a_draft_moves_every_cached_read_of_it(monkeypatch):
    async def _noop(self):
        return None

    async def _no_ds(session, ds_id):
        return None
    monkeypatch.setattr(vconfig, "VERSIONED_WRITES_ENABLED", False)
    monkeypatch.setattr(ContextEngine, "_resolve_ontology", _noop)
    monkeypatch.setattr(data_source_repo, "get_data_source_orm", _no_ds)
    asyncio.run(_run())
