"""LIVE FalkorDB: twenty seeds' every source and consumer — fifty thousand
entities — resolved as a member set across many short requests, then
downloaded, exactly.

The fake graph (``tests/fixtures/membership_graph.py``) pins the walk's rules;
this pins them on the real closure walk, at the size the dock's "Everything it
reaches…" exists for: hubs wider than a step's budget, a frontier re-rooted in
batches, seeds whose lineage meets, a source several seeds share. Each request
takes a few seconds and is a different "replica" (a new lease owner), so the
answer has to be carried in the set's rows, never in a process.

What it must hold: every entity the seeds reach, each once, at its shortest
distance and with the reason it is in; every flow between them; the same in
the downloaded file.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_member_sets_live.py -q
"""
from __future__ import annotations

import csv
import io
import json
import os
import time
import uuid
from collections import deque

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

SEEDS = 20
#: Consumers per node, hop by hop below each seed: 7, 21, 63, 189, 567, 1,701.
FANOUT = (7, 3, 3, 3, 3, 3)
LINEAGE = "TRANSFORMS"


def _graph():
    """(nodes {urn: domain}, edges [(source, target)]): a seed's consumers fan out
    six hops down; every 40th third-hop consumer also feeds a fourth-hop one of the
    next seed (their lineage meets); each seed has two sources with two of their own,
    and one source feeds five seeds."""
    nodes, edges = {}, []
    for s in range(SEEDS):
        dom = f"urn:domain:{s}"
        seed = f"urn:seed:{s}"
        nodes[seed] = dom
        level = [seed]
        for hop, fan in enumerate(FANOUT, start=1):
            nxt = []
            for parent in level:
                for k in range(fan):
                    urn = f"{parent}/{k}" if parent != seed else f"urn:d:{s}:{k}"
                    nodes[urn] = dom
                    edges.append((parent, urn))
                    nxt.append(urn)
            level = nxt
        for a in range(2):
            src = f"urn:src:{s}:{a}"
            nodes[src] = dom
            edges.append((src, seed))
            for b in range(2):
                far = f"{src}/{b}"
                nodes[far] = dom
                edges.append((far, src))
    shared = "urn:src:shared"
    nodes[shared] = "urn:domain:0"
    edges += [(shared, f"urn:seed:{s}") for s in range(5)]
    # Lineage that meets: third-hop consumers of seed s feeding fourth-hop ones of seed s+1.
    third = {s: [u for u in nodes if u.startswith(f"urn:d:{s}:") and u.count("/") == 2] for s in range(SEEDS)}
    fourth = {s: [u for u in nodes if u.startswith(f"urn:d:{s}:") and u.count("/") == 3] for s in range(SEEDS)}
    for s in range(SEEDS - 1):
        for i, u in enumerate(third[s][::40]):
            edges.append((u, fourth[s + 1][i * 7]))
    return nodes, edges


def _expected(nodes, edges):
    """Each entity's shortest distance from the nearest seed, each way."""
    seeds = [f"urn:seed:{s}" for s in range(SEEDS)]
    out, inn = {}, {}
    for a, b in edges:
        out.setdefault(a, []).append(b)
        inn.setdefault(b, []).append(a)

    def bfs(adj):
        dist = {s: 0 for s in seeds}
        queue = deque(seeds)
        while queue:
            u = queue.popleft()
            for v in adj.get(u, []):
                if v not in dist:
                    dist[v] = dist[u] + 1
                    queue.append(v)
        return {u: d for u, d in dist.items() if d > 0}

    return bfs(inn), bfs(out)


class LiveEngine:
    """The three reads a member set makes, as ``ContextEngine`` makes them, over the
    live provider (no ontology to resolve: the edge types are given)."""

    def __init__(self, provider):
        self.provider = provider
        self.closures = 0

    async def trace_closure(self, req):
        self.closures += 1
        return await self.provider.trace_closure(
            urn=req.urn,
            upstream_depth=req.upstream_depth if req.direction in ("upstream", "both") else 0,
            downstream_depth=req.downstream_depth if req.direction in ("downstream", "both") else 0,
            lineage_edge_types=[LINEAGE], containment_edge_types=["CONTAINS"],
            max_nodes=min(req.max_nodes or 2000, 10_000), timeout_ms=60_000,
            seed_urns=req.seed_urns, exclude_urns=req.exclude_urns,
            after_cursor=req.after_cursor, seed_cursor=req.seed_cursor,
        )

    async def get_nodes_query(self, query):
        return await self.provider.get_nodes(query)

    async def get_descendants(self, urn, **kw):
        return await self.provider.get_descendants(urn, **kw)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def graph():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"member_sets_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    nodes, edges = _graph()
    await p._graph.query("CREATE INDEX FOR (n:Domain) ON (n.urn)")
    await p._graph.query("CREATE INDEX FOR (n:Dataset) ON (n.urn)")
    await p._graph.query("UNWIND $rows AS r CREATE (:Domain {urn: r, displayName: r})",
                         {"rows": sorted(set(nodes.values()))})
    rows = [{"urn": u, "dom": d} for u, d in nodes.items()]
    for i in range(0, len(rows), 5000):
        await p._graph.query(
            "UNWIND $rows AS r MATCH (d:Domain {urn: r.dom}) "
            "CREATE (d)-[:CONTAINS]->(:Dataset {urn: r.urn, displayName: r.urn})", {"rows": rows[i:i + 5000]})
    pairs = [{"a": a, "b": b} for a, b in edges]
    for i in range(0, len(pairs), 5000):
        await p._graph.query(
            f"UNWIND $rows AS r MATCH (a:Dataset {{urn: r.a}}), (b:Dataset {{urn: r.b}}) "
            f"CREATE (a)-[:{LINEAGE}]->(b)", {"rows": pairs[i:i + 5000]})
    try:
        yield p, nodes, edges
    finally:
        await p._graph.delete()


@pytest_asyncio.fixture(loop_scope="module")
async def maker(tmp_path):
    from backend.app.db.engine import Base

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'sets.db'}")
    agg_path = tmp_path / "aggregation.db"

    @event.listens_for(engine.sync_engine, "connect")
    def _connect(dbapi_conn, _record):
        dbapi_conn.execute(f"ATTACH DATABASE '{agg_path}' AS aggregation")
        dbapi_conn.isolation_level = None

    @event.listens_for(engine.sync_engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(bind=engine, expire_on_commit=False)
    await engine.dispose()


async def test_twenty_seeds_every_source_and_consumer_exactly(graph, maker):
    from backend.app.db.models import MemberSetEdgeORM, MemberSetRowORM
    from backend.app.services.member_sets import download, stepper
    from backend.app.services.member_sets import store as sets
    from backend.common.models.view_membership import MembershipSpec

    provider, nodes, edges = graph
    up, down = _expected(nodes, edges)
    seeds = [f"urn:seed:{s}" for s in range(SEEDS)]
    assert len(up) + len(down) > 50_000

    spec = MembershipSpec.model_validate({"seeds": {"urns": seeds}, "expand": {"upstream": "all", "downstream": "all"}})
    async with maker() as session:
        ms = await sets.open_set(
            session, key=spec.spec_hash(), workspace_id="ws", data_source_id="ds",
            spec=json.dumps(spec.model_dump(mode="json", by_alias=True, exclude_none=True)),
            spec_hash=spec.spec_hash(), data_version="1", include_edges=True)
        await session.commit()
        set_id = ms.id

    engine = LiveEngine(provider)
    started, requests = time.monotonic(), 0
    while True:
        requests += 1
        assert requests < 2_000, "the set never finished"
        # Each request a different replica, a few seconds long.
        async with maker() as session:
            await stepper.drive(session, set_id, engine, owner=uuid.uuid4().hex, wait_s=3.0)
            ms = await sets.get(session, set_id)
            await session.commit()
        if ms.status != "running":
            break
    elapsed = time.monotonic() - started
    assert ms.status == "complete", ms.error
    assert sets.loads(ms.truncated, []) == []

    async with maker() as session:
        rows = {r.urn: r for r in (await session.execute(
            select(MemberSetRowORM).where(MemberSetRowORM.set_id == set_id))).scalars().all()}
        kept_edges = {(e.source_urn, e.target_urn) for e in (await session.execute(
            select(MemberSetEdgeORM).where(MemberSetEdgeORM.set_id == set_id))).scalars().all()}

    assert set(rows) == set(seeds) | set(up) | set(down)
    for urn in seeds:
        assert rows[urn].via == "seed"
    for urn, hops in up.items():
        assert (rows[urn].via, rows[urn].hops_up) == ("upstream", hops), urn
    for urn, hops in down.items():
        assert (rows[urn].via, rows[urn].hops_down) == ("downstream", hops), urn
    # Every flow between members, once.
    assert kept_edges == {(a, b) for a, b in edges if a in rows and b in rows}

    sessions = maker
    text = b"".join([c async for c in download.stream(sessions, set_id, fmt="csv")]).decode("utf-8")
    listed = list(csv.DictReader(io.StringIO(text)))
    assert len(listed) == len(rows)
    assert {r["urn"] for r in listed} == set(rows)
    flows = b"".join([c async for c in download.stream(sessions, set_id, fmt="csv", part="edges")]).decode("utf-8")
    assert len(flows.strip().splitlines()) - 1 == len(kept_edges)

    print(f"\n{len(rows):,} members, {len(kept_edges):,} flows: {requests} requests, "
          f"{engine.closures} closure steps, {elapsed:.1f} s")
