"""GRAPH.COPY on the FalkorDB this deployment pins (v4.18.11): what building a graph's next version in
a second key, beside the key that serves it (doc 14 §6, New-version builds), can rely on. A spike:
it asserts what a copy must do, and records what one costs, to size the builds' room and pacing.

Asserts:
- the copy holds the source whole: its nodes, edges and properties, its indexes, and the pass marker
  (``_GVProjMeta``) the projector reads;
- the copy is one consistent version: a write that moves a value between two nodes in one statement,
  sent over and over while the copy runs, is in the copy whole or not at all;
- writes to the source after the copy never reach it;
- the source stays readable and writable while it is copied;
- copying onto a key that exists, or from one that doesn't, is refused; the texts are recorded for
  the builds' error classifiers.

Records, as one JSON line (``GRAPH_COPY_REPORT {...}``, read it with ``-s``) and in
``$GRAPH_COPY_REPORT_PATH`` when set:
- how long the copy took, and its rate;
- what the node answered meanwhile: the slowest PING, read of the source, read of another graph, and
  write to the source, and how many writes landed;
- memory before, at its peak and after, and how much the copy took;
- what a copy does on a node without room for it (``maxmemory`` lowered under what it needs);
- whether a copy whose client goes away finishes.

Sizes: ``GRAPH_COPY_NODES`` nodes (default 50,000), two edges each.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_graph_copy_live.py -q -s
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid

import pytest

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the GRAPH.COPY spike.",
    ),
]

NODES = int(os.getenv("GRAPH_COPY_NODES", "50000"))
BATCH = 5000
PROBE_EVERY_S = 0.05


def _db():
    from falkordb.asyncio import FalkorDB

    return FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                    port=int(os.getenv("FALKORDB_PORT", "6379")))


async def _seed(g, n: int) -> None:
    """``n`` tables, each flowing to the next and containing another, an index on urn, and the
    marker a projection pass writes."""
    await g.query("CREATE INDEX FOR (n:Table) ON (n.urn)")
    for lo in range(0, n, BATCH):
        await g.query(
            "UNWIND range($lo, $hi) AS i CREATE (:Table {urn: 'urn:t:' + toString(i), "
            "displayName: 'table ' + toString(i), entityType: 'Table', rows: i})",
            {"lo": lo, "hi": min(n, lo + BATCH) - 1})
    for lo in range(0, n, BATCH):
        await g.query(
            "UNWIND range($lo, $hi) AS i "
            "MATCH (a:Table {urn: 'urn:t:' + toString(i)}), "
            "(b:Table {urn: 'urn:t:' + toString((i + 1) % $n)}), "
            "(c:Table {urn: 'urn:t:' + toString((i * 7 + 3) % $n)}) "
            "CREATE (a)-[:FLOWS {w: i}]->(b), (a)-[:CONTAINS]->(c)",
            {"lo": lo, "hi": min(n, lo + BATCH) - 1, "n": n})
    await g.query("MERGE (m:_GVProjMeta) SET m.seq = 5, m.epoch = 3")
    # The pair a probe moves a value between, in one statement: their sum never changes.
    await g.query("CREATE (:Pair {k: 'a', v: 1000}), (:Pair {k: 'b', v: 0})")


async def _counts(g) -> tuple:
    nodes = (await g.ro_query("MATCH (n) RETURN count(n)")).result_set[0][0]
    edges = (await g.ro_query("MATCH ()-[r]->() RETURN count(r)")).result_set[0][0]
    return nodes, edges


async def _memory(conn) -> dict:
    info = await conn.info("memory")
    return {k: int(info.get(k) or 0) for k in ("used_memory", "used_memory_peak", "maxmemory")}


async def _timed(coro) -> float:
    started = time.perf_counter()
    await coro
    return time.perf_counter() - started


async def _probe(conn, src, other, stop: asyncio.Event, seen: dict) -> None:
    """While the copy runs: the slowest PING, read of the source, read of another graph and write
    to the source, every ``PROBE_EVERY_S``; each write moves 1 from one Pair to the other."""
    while not stop.is_set():
        for name, coro in (
                ("ping", conn.ping()),
                ("read_source", src.ro_query("MATCH (n:Table {urn: 'urn:t:1'}) RETURN n.rows")),
                ("read_other", other.ro_query("MATCH (n) RETURN count(n)")),
                ("write_source", src.query("MATCH (a:Pair {k: 'a'}), (b:Pair {k: 'b'}) "
                                           "SET a.v = a.v - 1, b.v = b.v + 1"))):
            took = await _timed(coro)
            seen[name] = max(seen.get(name, 0.0), took)
        seen["writes"] = seen.get("writes", 0) + 1
        await asyncio.sleep(PROBE_EVERY_S)


async def _copy(conn, src: str, dst: str):
    return await conn.execute_command("GRAPH.COPY", src, dst)


async def _refusal(coro) -> str:
    try:
        await coro
    except Exception as exc:  # noqa: BLE001 — the text is what is recorded
        return f"{type(exc).__name__}: {exc}"
    return ""


async def _run() -> dict:
    db = _db()
    conn = db.connection
    tag = uuid.uuid4().hex[:8]
    names = {k: f"copyspike_{k}_{tag}" for k in ("src", "dst", "other", "cut", "full")}
    src, dst, other = (db.select_graph(names[k]) for k in ("src", "dst", "other"))
    report: dict = {"nodes": NODES, "falkordb": (await conn.info("server")).get("redis_version")}
    try:
        await _seed(src, NODES)
        await other.query("UNWIND range(1, 100) AS i CREATE (:Other {i: i})")
        before_counts = await _counts(src)
        report["memory_before"] = await _memory(conn)

        # The copy, with the node probed meanwhile.
        stop, seen = asyncio.Event(), {}
        prober = asyncio.create_task(_probe(conn, src, other, stop, seen))
        await asyncio.sleep(0.2)                        # the probe is under way first
        started = time.perf_counter()
        await _copy(conn, names["src"], names["dst"])
        report["copy_secs"] = round(time.perf_counter() - started, 3)
        stop.set()
        await prober
        report["during_copy_max_secs"] = {k: round(v, 4) for k, v in seen.items() if k != "writes"}
        report["writes_while_probing"] = seen.get("writes", 0)
        report["memory_after"] = await _memory(conn)
        report["copy_bytes"] = (report["memory_after"]["used_memory"]
                                - report["memory_before"]["used_memory"])
        report["nodes_per_sec"] = round((before_counts[0] + before_counts[1])
                                        / max(report["copy_secs"], 1e-6))

        # Whole: counts, properties, indexes, the marker.
        assert await _counts(dst) == await _counts(src) == before_counts
        row = (await dst.ro_query("MATCH (n:Table {urn: 'urn:t:7'}) RETURN n.displayName, n.rows")
               ).result_set
        assert row == [["table 7", 7]], row
        flows = (await dst.ro_query("MATCH (:Table {urn: 'urn:t:7'})-[r:FLOWS]->(b) "
                                    "RETURN r.w, b.urn")).result_set
        assert flows == [[7, "urn:t:8"]], flows
        indexed = str((await dst.ro_query("CALL db.indexes()")).result_set)
        assert "Table" in indexed and "urn" in indexed, indexed
        marker = (await dst.ro_query("MATCH (m:_GVProjMeta) RETURN m.seq, m.epoch")).result_set
        assert marker == [[5, 3]], marker

        # One version: the Pair's sum is whole in the copy, whatever the probe moved meanwhile.
        pair = dict((await dst.ro_query("MATCH (p:Pair) RETURN p.k, p.v")).result_set)
        assert pair["a"] + pair["b"] == 1000, pair
        report["pair_moves_in_copy"] = pair["b"]

        # After the copy, the source's writes don't reach it.
        await src.query("CREATE (:Table {urn: 'urn:t:after'})")
        assert (await dst.ro_query("MATCH (n:Table {urn: 'urn:t:after'}) RETURN count(n)")
                ).result_set == [[0]]

        # Refused: onto a key that exists, and from one that doesn't.
        report["refused_dest_exists"] = await _refusal(_copy(conn, names["src"], names["dst"]))
        report["refused_source_missing"] = await _refusal(
            _copy(conn, f"copyspike_missing_{tag}", names["cut"]))
        assert report["refused_dest_exists"] and report["refused_source_missing"], report

        # A client that goes away part-way: does the copy finish on the server?
        cut_db = _db()
        task = asyncio.create_task(_copy(cut_db.connection, names["src"], names["cut"]))
        await asyncio.sleep(0.01)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await cut_db.connection.aclose()
        finished = False
        for _ in range(100):                            # up to ~10 s for it to land, or not
            finished = bool(await conn.exists(names["cut"]))
            if finished:
                break
            await asyncio.sleep(0.1)
        report["copy_finishes_after_client_left"] = finished

        # No room: maxmemory just above what is used now, then a copy of a graph that size.
        try:
            limit = (await _memory(conn))["used_memory"] + 1024 * 1024
            await conn.config_set("maxmemory", str(limit))
            try:
                report["no_room"] = await _refusal(_copy(conn, names["src"], names["full"])) \
                    or "copied"
            finally:
                await conn.config_set("maxmemory", str(report["memory_before"]["maxmemory"]))
        except Exception as exc:  # noqa: BLE001 — CONFIG SET may be refused: record it
            report["no_room"] = f"not measured: {type(exc).__name__}: {exc}"
        report["memory_peak"] = (await _memory(conn))["used_memory_peak"]
    finally:
        for name in names.values():
            try:
                await db.select_graph(name).delete()
            except Exception:  # noqa: BLE001 — not every one was made
                pass
        await conn.aclose()
    return report


def test_a_graph_copy_is_whole_one_version_and_leaves_its_source_serving():
    report = asyncio.run(_run())
    line = json.dumps(report, sort_keys=True)
    print(f"GRAPH_COPY_REPORT {line}")
    path = os.getenv("GRAPH_COPY_REPORT_PATH")
    if path:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(line + "\n")
