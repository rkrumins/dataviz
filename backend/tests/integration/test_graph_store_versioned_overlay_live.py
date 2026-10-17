"""The graph store page's versioned-graph overlay, read from Postgres.

* Every live versioned graph that projects into a swept provider is attributed to its
  ``(provider, key)``: a data source's own graph, a fork and an orphan alike, each with whether
  the platform owns the key, its projection status and how far behind it is.
* A deleted graph, a graph with no key yet and a graph on another provider are not.

Needs ``GRAPHVER_E2E=1`` and Postgres.
"""
import asyncio
import os

import pytest

from backend.app.services.graph_store import topology
from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


async def _seed_graph(gid, *, provider, key, head=3, projected=3, status="idle", owned=False,
                      fork_of=None, deleted=False):
    async with db.graphver_session() as s:
        s.add(GraphORM(id=gid, data_source_id=f"ds_{gid}", workspace_id="ws_overlay",
                       kind="manual", main_head_commit_seq=head, fork_parent_graph_id=fork_of,
                       deleted_at=models._now() if deleted else None))
        s.add(ProjectionStateORM(graph_id=gid, projected_commit_seq=projected,
                                 target_commit_seq=projected, status=status,
                                 falkor_provider=provider, falkor_graph_name=key,
                                 owns_falkor_graph=owned))


async def _run() -> None:
    await models.create_schema_and_partitions()
    tag = os.urandom(4).hex()
    prov, other = f"falkor_{tag}", f"falkor2_{tag}"
    main, fork, orphan, gone, unkeyed, elsewhere = (
        f"graph_{tag}_{n}" for n in ("main", "fork", "orphan", "gone", "unkeyed", "other"))
    await _seed_graph(main, provider=prov, key=f"customer_{tag}")
    await _seed_graph(fork, provider=prov, key=f"customer_{tag}__fork_{fork}", owned=True,
                      head=5, projected=2, fork_of=main)
    await _seed_graph(orphan, provider=prov, key=f"gv_{orphan}", owned=True, status="evicted",
                      projected=0)
    await _seed_graph(gone, provider=prov, key=f"gv_{gone}", deleted=True)
    await _seed_graph(unkeyed, provider=prov, key=None)
    await _seed_graph(elsewhere, provider=other, key=f"gv_{elsewhere}")

    found = await topology._versioned_graphs([prov])
    assert {k: v.model_dump(by_alias=True) for k, v in found.items()} == {
        (prov, f"customer_{tag}"): {
            "graphId": main, "kind": "main", "owned": False, "status": "idle", "lag": 0},
        (prov, f"customer_{tag}__fork_{fork}"): {
            "graphId": fork, "kind": "fork", "owned": True, "status": "idle", "lag": 3},
        (prov, f"gv_{orphan}"): {
            "graphId": orphan, "kind": "main", "owned": True, "status": "evicted", "lag": 3},
    }
    assert await topology._versioned_graphs([]) == {}

    await db.dispose_engine()


def test_every_live_versioned_key_on_a_swept_provider_is_attributed():
    asyncio.run(_run())
