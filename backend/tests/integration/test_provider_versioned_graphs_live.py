"""Which versioned graphs a provider hosts, read from Postgres.

* ``versioned_sources.graphs_pinned_to`` lists every graph whose projection is pinned to the
  provider, trashed ones marked, and none pinned elsewhere. A graph whose version control is
  still being enabled (an unfinished bootstrap) is marked too. So is a graph moved off the
  provider whose old key there is still waiting to be dropped.
* The provider delete guard counts them, and a blank model's manual data source, which has no
  catalog item.
* The impact report lists each pinned graph's key.

Needs ``GRAPHVER_E2E=1`` and Postgres.
"""
import asyncio
import os

import pytest

from backend.app.services import versioned_sources
from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import GraphORM, JobORM, ProjectionStateORM

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


@pytest.fixture(autouse=True)
def _no_graphs_pinned_to_providers():
    """Overrides tests/conftest.py's stub of the same name: this file reads the real store."""


async def _seed_graph(gid, *, ds, provider, kind="manual", deleted=False):
    async with db.graphver_session() as s:
        s.add(GraphORM(id=gid, data_source_id=ds, workspace_id="ws_any", kind=kind,
                       main_head_commit_seq=1, deleted_at=models._now() if deleted else None))
        s.add(ProjectionStateORM(graph_id=gid, projected_commit_seq=1, target_commit_seq=1,
                                 falkor_provider=provider, falkor_graph_name=f"key_{gid}"))


async def _run() -> None:
    from backend.app.db.engine import close_db, get_async_session
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
    from backend.app.db.repositories import provider_repo

    await models.create_schema_and_partitions()
    tag = os.urandom(4).hex()
    blank_prov, fork_prov, empty_prov = (f"prov_{n}_{tag}" for n in ("blank", "fork", "empty"))
    ws, ds = f"ws_pin_{tag}", f"ds_pin_{tag}"
    async with get_async_session() as s:
        s.add(WorkspaceORM(id=ws, name=f"Workspace {ws}"))
        for p in (blank_prov, fork_prov, empty_prov):
            s.add(ProviderORM(id=p, name=p, provider_type="falkordb"))
        await s.flush()
        s.add(WorkspaceDataSourceORM(id=ds, workspace_id=ws, provider_id=blank_prov,
                                     graph_name=f"blank_{ds}"))
        await s.commit()

    blank, fork, trashed = (f"g_{tag}_{n}" for n in ("a_blank", "b_fork", "c_trashed"))
    await _seed_graph(blank, ds=ds, provider=blank_prov, kind="blank")
    await _seed_graph(fork, ds=f"dsfork_{tag}", provider=fork_prov)
    await _seed_graph(trashed, ds=f"ds_gone_{tag}", provider=fork_prov, deleted=True)

    pinned = await versioned_sources.graphs_pinned_to(fork_prov)
    assert [(g.graph_id, g.falkor_graph_name, g.trashed) for g in pinned] == [
        (fork, f"key_{fork}", False), (trashed, f"key_{trashed}", True)]
    assert await versioned_sources.graphs_pinned_to(empty_prov) == []
    assert not any(g.bootstrapping for g in pinned)

    boot_prov = f"prov_boot_{tag}"
    enabling, enabled = (f"g_{tag}_{n}" for n in ("a_enabling", "b_enabled"))
    await _seed_graph(enabling, ds=f"dsboot_{tag}", provider=boot_prov)
    await _seed_graph(enabled, ds=f"dsdone_{tag}", provider=boot_prov)
    async with db.graphver_session() as s:
        s.add(JobORM(job_type="bootstrap", graph_id=enabling, workspace_id="ws_any",
                     status="failed"))
        s.add(JobORM(job_type="bootstrap", graph_id=enabled, workspace_id="ws_any",
                     status="completed"))
    assert [(g.graph_id, g.bootstrapping)
            for g in await versioned_sources.graphs_pinned_to(boot_prov)] == [
        (enabling, True), (enabled, False)]

    # A graph moved away still has its old key on the provider until that key is dropped.
    left_prov, moved = f"prov_left_{tag}", f"g_{tag}_a_moved"
    await _seed_graph(moved, ds=f"dsmoved_{tag}", provider=f"prov_new_{tag}")
    async with db.graphver_session() as s:
        (await s.get(ProjectionStateORM, moved)).retired_keys = [
            {"name": f"old_{moved}", "provider": left_prov, "retireAfter": models._now(),
             "afterSeq": 1, "movedBy": "admin"}]
    assert [g.graph_id for g in await versioned_sources.graphs_pinned_to(left_prov)] == [moved]

    async with get_async_session() as s:
        assert await provider_repo.has_workspaces(s, left_prov) is True, \
            "an old key still waiting to be dropped there"
        assert await provider_repo.has_workspaces(s, blank_prov) is True
        assert await provider_repo.has_workspaces(s, fork_prov) is True, \
            "pinned graphs alone, with no management row naming the provider"
        assert await provider_repo.has_workspaces(s, empty_prov) is False

        impact = await provider_repo.get_provider_impact(s, blank_prov)
        assert [w.id for w in impact.workspaces] == [ws]
        assert [(g.id, g.name) for g in impact.versionedGraphs] == [(blank, f"key_{blank}")]
        impact = await provider_repo.get_provider_impact(s, fork_prov)
        assert [(g.id, g.name) for g in impact.versionedGraphs] == [
            (fork, f"key_{fork}"), (trashed, f"key_{trashed} (in trash)")]

    await db.dispose_engine()
    await close_db()


def test_the_graphs_pinned_to_a_provider_guard_its_delete_and_fill_its_impact():
    asyncio.run(_run())
