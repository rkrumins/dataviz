"""REPRODUCTION HARNESS for the re-sync identity failure. NOT a passing test — a tool.

  docker exec -e GRAPHVER_RESYNC_MAX_ENTITIES=0 <container> python backend/scripts/resync_identity_repro.py

THE BUG. A bounded re-sync (reverted, see 3643a191) turned 808 deltas into 956,860 on a real
478,430-entity graph — deleting it and re-creating it under new ids. Identity resolution failed,
and because deletion is defined by ABSENCE, the wrong ids made every existing entity look absent.

WHAT THIS HARNESS DOES. Pushes a small graph into a real FalkorDB, runs the ACTUAL BOOTSTRAP
WORKER against it (not bulk_ingest, not an imitation — that writer is the whole point, because
it is the one that made the real graphs), then re-syncs the UNCHANGED source twice and counts the
deltas. An unchanged source must converge to ~0.

WHAT IT DOES NOT DO — READ THIS. It does NOT currently reproduce the bug. Verified: the broken
code was re-applied and the run was IDENTICAL (3 deltas, then 0, PASS). Four attempts have now
failed to reproduce it:

    characterisation x15   (bulk_ingest)                        passes on broken code
    identity invariants x3 (bulk_ingest, bootstrap-shaped)      passes on broken code
    this harness           (REAL bootstrap worker + FalkorDB)   passes on broken code
    this harness, x2 resync (the exact sequence that failed)    passes on broken code

So the failure is SCALE- or SHAPE-dependent, and 6 entities is not enough to surface it.

THE NEXT STEP, and it is mechanical: BISECT THE SIZE. Run this at 100 / 1k / 10k / 100k entities
until it breaks, then shrink from there. Until it reproduces, the sync identity path CANNOT be
safely rewritten — a green suite means nothing when the bug is invisible to every suite you have.

Also worth explaining while you are here: resync #1 of an UNCHANGED source is not free — it
rewrites every edge (3 of 3 here). #2 is 0, so it converges, but that first pass is doing
something it should not have to, and it is probably the same seam.
"""
"""(original docstring) THE REAL TEST: bootstrap worker → resync → count the deltas.

Not bulk_ingest. Not an imitation of the bootstrap's row shape. The actual worker, against an
actual FalkorDB graph — because that is the only writer that produces the entity ids real graphs
have, and identity is the seam the whole sync path lives or dies on.

An UNCHANGED source must produce ~0 deltas. Anything near the graph size means identity failed
and the sync is about to delete everything and re-create it under new ids.
"""
import asyncio
import os
import sys

GRAPH = "gvt_identity_" + os.urandom(3).hex()
DS = "ds_ident_" + os.urandom(4).hex()
WS = "ws_dac6bb481489"
PROV = "prov_d55c3367e3d8"


async def push_source():
    """A tiny graph, shaped like a real one: urn-bearing nodes, typed edges."""
    from redis.asyncio import Redis
    r = Redis(host=os.getenv("FALKORDB_HOST", "falkordb"), port=6379)
    await r.execute_command("GRAPH.QUERY", GRAPH, """
        CREATE (a:Node {urn:'u:A', displayName:'A'}),
               (b:Node {urn:'u:B', displayName:'B'}),
               (c:Node {urn:'u:C', displayName:'C'}),
               (a)-[:FLOWS_TO]->(b), (b)-[:FLOWS_TO]->(c), (a)-[:HAS]->(c)
    """)
    n = await r.execute_command("GRAPH.QUERY", GRAPH, "MATCH (n) RETURN count(n)")
    e = await r.execute_command("GRAPH.QUERY", GRAPH, "MATCH ()-[r]->() RETURN count(r)")
    await r.aclose()
    return int(n[1][0][0]), int(e[1][0][0])


def graph_factory():
    from falkordb.asyncio import FalkorDB

    def _f(name, provider_id=None):
        return FalkorDB(host=os.getenv("FALKORDB_HOST", "falkordb"), port=6379).select_graph(name)
    return _f


async def main():
    from backend.app.providers.falkordb_connection import assert_standalone_env
    assert_standalone_env("resync_identity_repro.py")

    from backend.app.services.versioning import models
    from backend.app.services.versioning.bootstrap_worker import (
        BootstrapRunner, create_bootstrap_job)
    from backend.app.services.versioning.service import GraphVersioningService
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    await models.create_schema_and_partitions()
    nodes, edges = await push_source()
    total = nodes + edges
    print(f"  source: {nodes} nodes + {edges} edges = {total} entities", flush=True)

    # ── 1. THE REAL WRITER ───────────────────────────────────────────────────
    job = await create_bootstrap_job(
        data_source_id=DS, workspace_id=WS, actor="test",
        falkor_graph_name=GRAPH, falkor_provider=PROV)
    gid = job["graph_id"]
    runner = BootstrapRunner(graph_factory(), consumer="identity-test")
    claimed = await runner.claim_one()
    res = await runner.run_job(claimed)
    print(f"  bootstrap: {res['status']}", flush=True)
    if res["status"] != "completed":
        print("  !! bootstrap did not complete; cannot test identity", flush=True)
        return 2

    svc = GraphVersioningService()
    st = await svc.materialize_state(graph_id=gid, branch_id=(await svc.resolve_graph(
        data_source_id=DS, actor="test", workspace_id=WS, open_draft_if_absent=False
    ))["main_branch_id"])
    live = len([p for p in st["nodes"].values() if p]) + len([p for p in st["edges"].values() if p])
    print(f"  bootstrapped into: {live} entities", flush=True)

    # ── 2. RESYNC THE **UNCHANGED** SOURCE ───────────────────────────────────
    prov = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "falkordb"), port=6379,
                            graph_name=GRAPH, auth_enabled=False)
    prov.set_containment_edge_types(["HAS"])
    r1 = await svc.resync_from_provider(graph_id=gid, provider=prov, actor="test")
    a1 = r1.get("applied") or 0
    print(f"  resync #1 (unchanged source): {a1} deltas", flush=True)

    # THE SEQUENCE THAT BROKE. On the 478k graph the failure was the SECOND resync — the first
    # had already run and rewritten things. If a resync is not idempotent against itself, the
    # next one has nothing stable to resolve against.
    r = await svc.resync_from_provider(graph_id=gid, provider=prov, actor="test")
    applied = r.get("applied") or 0

    print(f"\n  RESYNC #2 OF THE SAME UNCHANGED SOURCE APPLIED: {applied} deltas", flush=True)
    print(f"  (graph holds {live}; ~2x = delete-and-recreate = IDENTITY FAILURE)", flush=True)

    ok = applied < live
    print(f"\n  {'PASS — identity resolved' if ok else 'FAIL — IDENTITY BROKEN'}", flush=True)

    # cleanup
    from redis.asyncio import Redis
    rr = Redis(host=os.getenv("FALKORDB_HOST", "falkordb"), port=6379)
    try:
        await rr.execute_command("GRAPH.DELETE", GRAPH)
    except Exception:
        pass
    await rr.aclose()
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
