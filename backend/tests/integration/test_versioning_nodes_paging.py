"""Paging a TYPE over the versioned store is lossless — Postgres.

The draft/as-of reader (`get_nodes_from_state`) picks a window of candidate ids,
then sorts it by display name and cuts the page. The window was taken in
entity_id order: every page looked at a different, larger slice that was not
the start of the NAME order, so deep pages skipped rows and repeated others (a
1,000-node type delivered 464 distinct nodes). The window is now taken in the
order the page is cut from.

Pinned against a real Postgres: 1,000 nodes whose name order is unrelated to
their id order — with duplicated names and nodes that store no name — paged 200
at a time through the provider's `get_nodes_page`, main and a draft that renames,
adds and deletes: every node exactly once, and the last page says so.

Run:  GRAPHVER_E2E=1 (+ GRAPHVER_DB_URL / MANAGEMENT_DB_URL) pytest this file
"""
import asyncio
import os

import pytest

from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.graph import NodeQuery

N, PAGE = 1000, 200


def _node(i: int) -> dict:
    payload = {"urn": f"urn:pgp:{i:04d}", "entityType": "Table"}
    if i % 50 == 7:
        pass                                       # stores no display name at all
    elif i % 10 == 3:
        payload["displayName"] = "Same Name"       # a long run of one name
    else:
        payload["displayName"] = f"N{(i * 7919) % N:04d}"   # name order ≠ id order
    return {"op": "create", "entity_kind": "node", "entity_id": f"E{i:04d}", "payload": payload}


async def _walk(provider) -> list:
    got, offset = [], 0
    for _ in range(N // PAGE + 3):
        page = await provider.get_nodes_page(NodeQuery(entityTypes=["Table"], limit=PAGE, offset=offset))
        got += [n.urn for n in page.nodes]
        assert page.next_offset == offset + len(page.nodes)
        offset = page.next_offset
        if not page.has_more:
            return got
    raise AssertionError("runaway paging")


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = g["graph_id"], g["main_branch_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node(i) for i in range(N)])

    got = await _walk(VersionedBranchProvider(svc=svc, graph_id=gid, branch_id=main))
    assert len(got) == N, f"main: {len(got)} rows for {N} nodes"
    assert len(set(got)) == N, f"main: {N - len(set(got))} nodes never shown"

    # A draft: rename one, delete one, add one.
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="edits", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "E0001",
         "payload": {"urn": "urn:pgp:0001", "entityType": "Table", "displayName": "AAA first now"}},
        {"op": "delete", "entity_kind": "node", "entity_id": "E0002", "payload": None},
        {"op": "create", "entity_kind": "node", "entity_id": "Enew",
         "payload": {"urn": "urn:pgp:new", "entityType": "Table", "displayName": "zzz new"}},
    ])
    got = await _walk(VersionedBranchProvider(svc=svc, graph_id=gid, branch_id=draft))
    expected = {f"urn:pgp:{i:04d}" for i in range(N)} - {"urn:pgp:0002"} | {"urn:pgp:new"}
    assert len(got) == len(expected) and set(got) == expected, (
        f"draft: {len(got)} rows, {len(set(got))} distinct, {len(expected - set(got))} missing")

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_nodes_paging_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioned-store type paging: OK")
