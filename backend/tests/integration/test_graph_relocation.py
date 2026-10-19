"""Moving a data source re-files its versioned graph, and every job run on it, under the new
workspace (needs Postgres).

The versioning API decides tenancy from ``graphs.workspace_id``, and the bootstrap's status,
retry and abandon read ``jobs.workspace_id``: a graph left behind would stay writable from the
workspace the source left and unreachable from the one it joined. Relocation SETS the workspace
rather than swapping it, so running it again is harmless and heals a split a failure left.

Skipped unless ``GRAPHVER_E2E=1`` is set (and a Postgres is reachable via
``GRAPHVER_DB_URL``/``MANAGEMENT_DB_URL``), so it never runs in the unit lane.
Runs its own event loop, so it needs no pytest-asyncio plugin.
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.services.versioning import db, lifecycle, models
from backend.app.services.versioning.models import JobORM
from backend.app.services.versioning.service import GraphVersioningService


async def _job_workspaces(graph_id: str) -> set:
    async with db.graphver_session() as s:
        return set((await s.execute(
            select(JobORM.workspace_id).where(JobORM.graph_id == graph_id))).scalars().all())


async def _flow() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws_fin", actor="alice"))["graph_id"]
    async with db.graphver_session() as s:
        s.add_all([
            JobORM(job_type="bootstrap", graph_id=gid, workspace_id="ws_fin", status="completed",
                   data_source_id=ds),
            JobORM(job_type="export", graph_id=gid, workspace_id="ws_fin", status="completed",
                   data_source_id=ds),
        ])

    facts = await lifecycle.relocation_facts(ds)
    assert (facts["graphId"], facts["activeJobs"], facts["forks"]) == (gid, [], 0)

    assert await lifecycle.relocate_graph(ds, "ws_risk") == gid
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_risk"
    assert await _job_workspaces(gid) == {"ws_risk"}          # finished jobs too: bootstrap reads them
    assert await lifecycle.relocate_graph(ds, "ws_risk") == gid  # setting it again changes nothing

    # A job writing the graph keeps it where it is — except to put back what a failed move did.
    async with db.graphver_session() as s:
        s.add(JobORM(job_type="export", graph_id=gid, workspace_id="ws_risk", status="running",
                     data_source_id=ds))
    assert (await lifecycle.relocation_facts(ds))["activeJobs"] == ["export"]
    with pytest.raises(lifecycle.GraphBusy):
        await lifecycle.relocate_graph(ds, "ws_fin")
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_risk"
    assert await lifecycle.relocate_graph(ds, "ws_fin", check_busy=False) == gid
    assert (await svc.get_graph(gid))["workspace_id"] == "ws_fin"

    # A source that was never versioned has nothing to move.
    assert await lifecycle.relocation_facts("ds_never_versioned") is None
    assert await lifecycle.relocate_graph("ds_never_versioned", "ws_risk") is None
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_relocating_a_graph_refiles_it_and_its_jobs():
    asyncio.run(_flow())


if __name__ == "__main__":
    asyncio.run(_flow())
    print("graph relocation: OK")
