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

And at the column grain (tables of columns in domains, lineage between columns
only): a trace kept with the tables its sources and consumers sit in, what is
inside those tables, and those tables' own lineage — each at the distance a
model of the rule computes.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_member_sets_live.py -q
"""
from __future__ import annotations

import csv
import heapq
import io
import json
import math
import os
import random
import time
import uuid
from collections import Counter, deque

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


#: The column grain: domains of tables of columns, each column fed by up to two
#: columns of the tables just before it (anywhere in the estate).
DOMAINS, TABLES, COLUMNS, WINDOW = 8, 150, 6, 60


def _column_graph():
    """(parent {child: container}, types {urn: label}, lineage [(source, target)], seeds)."""
    rng = random.Random(7)
    parent, types, lineage = {}, {}, set()
    for d in range(DOMAINS):
        types[f"urn:dom:{d}"] = "domain"
        for i in range(TABLES):
            types[f"urn:tbl:{d}:{i}"], parent[f"urn:tbl:{d}:{i}"] = "dataset", f"urn:dom:{d}"
    order = sorted((t for t, kind in types.items() if kind == "dataset"),
                   key=lambda t: (int(t.rsplit(":", 1)[1]), t))
    for k, table in enumerate(order):
        for j in range(COLUMNS):
            col = f"{table}/c{j}"
            types[col], parent[col] = "schemaField", table
            if k >= 4:
                for _ in range(rng.choice((0, 0, 1, 1, 2))):
                    source = order[rng.randrange(max(0, k - WINDOW), k)]
                    lineage.add((f"{source}/c{rng.randrange(COLUMNS)}", col))
    seeds = [f"{order[600]}/c0", f"{order[610]}/c3", f"{order[900]}/c2"]
    return parent, types, sorted(lineage), seeds


def _with_hosts(parent, types, lineage, seeds):
    """What the column trace of ``seeds`` holds with the tables its partners sit in,
    one level inside those, and their lineage, as ``{urn: (via, hops)}``. Each way: a
    column one hop from where the walk stands joins, and so does its table at the same
    distance; the walk then stands on every column of that table at the table's
    distance. Containment is never a hop."""
    kids, toward = {}, {"upstream": {}, "downstream": {}}
    for child, container in parent.items():
        kids.setdefault(container, []).append(child)
    for a, b in lineage:
        toward["downstream"].setdefault(a, []).append(b)
        toward["upstream"].setdefault(b, []).append(a)

    def walk(adj):
        dist, stand = {}, {s: 0 for s in seeds}
        heap = [(0, s) for s in seeds]

        def stand_on(urn, d):
            if d < stand.get(urn, math.inf):
                stand[urn] = d
                heapq.heappush(heap, (d, urn))

        while heap:
            d, u = heapq.heappop(heap)
            if d > stand.get(u, math.inf):
                continue
            for v in adj.get(u, ()):
                if v in seeds or d + 1 >= dist.get(v, math.inf):
                    continue
                dist[v] = d + 1
                stand_on(v, d + 1)
                host = parent.get(v) if types[v] == "schemaField" else None
                if host is not None and d + 1 < dist.get(host, math.inf):
                    dist[host] = d + 1
                    for col in kids[host]:
                        stand_on(col, d + 1)
        return dist

    members = {s: ("seed", None) for s in seeds}
    for via in ("upstream", "downstream"):
        for urn, hops in walk(toward[via]).items():
            members.setdefault(urn, (via, hops))
    for urn in [u for u, (via, _) in members.items() if via in ("upstream", "downstream")]:
        for child in kids.get(urn, ()):
            members.setdefault(child, ("partnerInside", None))
    return members


class LiveEngine:
    """The reads a member set makes, as ``ContextEngine`` makes them, over the live
    provider (no ontology to resolve: the edge types and the column grain's two types
    are given)."""

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

    async def get_ancestor_chains(self, urns):
        return await self.provider.get_ancestor_chains(urns)

    async def get_resolved_ontology(self):
        from backend.app.ontology.models import EntityHierarchyData, EntityTypeDefEntry, ResolvedOntology

        return ResolvedOntology(entity_type_definitions={
            "dataset": EntityTypeDefEntry(hierarchy=EntityHierarchyData(can_contain=["schemaField"])),
            "schemaField": EntityTypeDefEntry(hierarchy=EntityHierarchyData(can_contain=[])),
        })


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def columns():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"member_sets_columns_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    parent, types, lineage, seeds = _column_graph()
    for label in ("domain", "dataset", "schemaField"):
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    await p._graph.query("UNWIND $rows AS r CREATE (:domain {urn: r, displayName: r})",
                         {"rows": [u for u, kind in types.items() if kind == "domain"]})
    for label, inside in (("dataset", "domain"), ("schemaField", "dataset")):
        rows = [{"urn": u, "parent": parent[u]} for u, kind in types.items() if kind == label]
        for i in range(0, len(rows), 5000):
            await p._graph.query(
                f"UNWIND $rows AS r MATCH (c:{inside} {{urn: r.parent}}) "
                f"CREATE (c)-[:CONTAINS]->(:{label} {{urn: r.urn, displayName: r.urn}})", {"rows": rows[i:i + 5000]})
    pairs = [{"a": a, "b": b} for a, b in lineage]
    for i in range(0, len(pairs), 5000):
        await p._graph.query(
            f"UNWIND $rows AS r MATCH (a:schemaField {{urn: r.a}}), (b:schemaField {{urn: r.b}}) "
            f"CREATE (a)-[:{LINEAGE}]->(b)", {"rows": pairs[i:i + 5000]})
    try:
        yield p, parent, types, lineage, seeds
    finally:
        await p._graph.delete()


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
    started_download = time.monotonic()
    text = b"".join([c async for c in download.stream(sessions, set_id, fmt="csv", engine=engine)]).decode("utf-8")
    downloaded = time.monotonic() - started_download
    listed = list(csv.DictReader(io.StringIO(text)))
    assert len(listed) == len(rows)
    assert {r["urn"] for r in listed} == set(rows)
    # Where each sits: the domain that contains it, by URN, name and type — read from the graph.
    for r in listed:
        dom = nodes[r["urn"]]
        assert (r["parentUrn"], r["parentName"], r["path"], r["pathUrns"]) == (dom, dom, dom, dom), r
        assert r["parentType"], r
    flows = b"".join([c async for c in download.stream(sessions, set_id, fmt="csv", part="edges")]).decode("utf-8")
    assert len(flows.strip().splitlines()) - 1 == len(kept_edges)

    print(f"\n{len(rows):,} members, {len(kept_edges):,} flows: {requests} requests, "
          f"{engine.closures} closure steps, {elapsed:.1f} s; downloaded with where each sits in {downloaded:.1f} s")


async def test_a_column_trace_with_its_tables_their_insides_and_their_lineage_exactly(columns, maker):
    from backend.app.db.models import MemberSetRowORM
    from backend.app.services.member_sets import stepper
    from backend.app.services.member_sets import store as sets
    from backend.common.models.view_membership import MembershipSpec

    provider, parent, types, lineage, seeds = columns
    expected = _with_hosts(parent, types, lineage, seeds)
    spec = MembershipSpec.model_validate({"seeds": {"urns": seeds}, "expand": {
        "upstream": "all", "downstream": "all", "partnerChildren": 1, "partnerHosts": True, "partnerLineage": True}})
    async with maker() as session:
        ms = await sets.open_set(
            session, key=spec.spec_hash(), workspace_id="ws", data_source_id="ds",
            spec=json.dumps(spec.model_dump(mode="json", by_alias=True, exclude_none=True)),
            spec_hash=spec.spec_hash(), data_version="1", include_edges=False)
        await session.commit()
        set_id = ms.id

    engine = LiveEngine(provider)
    started, requests = time.monotonic(), 0
    while True:
        requests += 1
        assert requests < 2_000, "the set never finished"
        # Each request a different replica, a second long.
        async with maker() as session:
            await stepper.drive(session, set_id, engine, owner=uuid.uuid4().hex, wait_s=1.0)
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
    held = {u: (r.via, r.hops_up if r.via == "upstream" else r.hops_down if r.via == "downstream" else None)
            for u, r in rows.items()}
    assert held == expected
    tables = sum(1 for u, (via, _) in held.items() if via in ("upstream", "downstream") and types[u] == "dataset")
    assert tables > 500 and Counter(via for via, _ in held.values())["partnerInside"] > 1000

    print(f"\n{len(rows):,} members ({tables:,} tables the trace's columns sit in): {requests} requests, "
          f"{engine.closures} closure steps, {elapsed:.1f} s")
