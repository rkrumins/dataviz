"""Finding a relationship between two known nodes when one of them is a hub, on the FalkorDB this
deployment pins (v4.18.11).

The projector finds a relationship between two nodes it knows by urn in four ways: reading its
fingerprint, deleting it by its ends or by its id, and reading or deleting a summary cell
(``projection._between``). This asserts, for each of those statements, that:
- a row costs on a hub about what it costs on a node with one relationship. The hub's source holds
  ``HUB_CHILDREN`` relationships of each type (default 200,000);
- the statement finds exactly what it should.

It records what the shapes the projector sent before cost, as the reason for the one it sends now.

Why: in the 1M nodes + 2M edges scale run, the bench graph's root held 500,000 children, the first
500,000 edges a rebuild reads. Each row cost about 70 ms, with the ends either walked to from the
root or found first in the same query part. The rebuild timed out at any batch size for four
hours.

Records, as one JSON line (``HUB_LOOKUP_REPORT {...}``, read it with ``-s``) and in
``$HUB_LOOKUP_REPORT_PATH`` when set:
- each shape's milliseconds per row, on the hub and on a leaf;
- each shape's plan (``GRAPH.EXPLAIN``).

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_hub_lookups_live.py -q -s
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
import uuid

import pytest

from backend.app.services.versioning import projection

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the hub lookups.",
    ),
]

HUB_CHILDREN = int(os.getenv("HUB_CHILDREN", "200000"))
#: Rows per statement: the projector's shapes, and the slow shapes it sent before.
ROWS = 400
OLD_ROWS = 100
BATCH = 10000
TIMEOUT_MS = 120000
#: A row on the hub may cost this many times a row on a leaf, or this many ms, whichever is more.
RATIO, FLOOR_MS = 10.0, 2.0

HUB = ("Layer", "urn:root")


def _db():
    from falkordb.asyncio import FalkorDB

    return FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"),
                    port=int(os.getenv("FALKORDB_PORT", "6379")))


async def _seed(g, n: int, leaves: int) -> None:
    """A root holding ``n`` children, a ``HAS`` and a summary cell to each. The first ``leaves``
    children each hold one leaf the same two ways, so a lookup from one of them is one from a
    node with one relationship of each type."""
    for label in ("Layer", "Object", "Attribute"):
        await g.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    await g.query("CREATE (:Layer {urn: 'urn:root'})")
    for lo in range(0, n, BATCH):
        hi = min(n, lo + BATCH) - 1
        await g.query("UNWIND range($lo, $hi) AS i CREATE (:Object {urn: 'urn:o:' + toString(i)})",
                      {"lo": lo, "hi": hi})
        await g.query(
            "MATCH (h:Layer {urn: 'urn:root'}) UNWIND range($lo, $hi) AS i "
            "MATCH (o:Object {urn: 'urn:o:' + toString(i)}) "
            "CREATE (h)-[:HAS {id: 'h' + toString(i), gvHash: i}]->(o), "
            "(h)-[:AGGREGATED {weight: i % 7 + 1, sourceEdgeTypes: ['FLOWS'], gvSeq: 1}]->(o)",
            {"lo": lo, "hi": hi})
    await g.query("UNWIND range(0, $k - 1) AS i CREATE (:Attribute {urn: 'urn:a:' + toString(i)})",
                  {"k": leaves})
    await g.query(
        "UNWIND range(0, $k - 1) AS i MATCH (o:Object {urn: 'urn:o:' + toString(i)}), "
        "(a:Attribute {urn: 'urn:a:' + toString(i)}) "
        "CREATE (o)-[:HAS {id: 'l' + toString(i), gvHash: i}]->(a), "
        "(o)-[:AGGREGATED {weight: i % 7 + 1, sourceEdgeTypes: ['FLOWS'], gvSeq: 1}]->(a)",
        {"k": leaves})


def _rows(at: str, ks, **extra) -> list:
    """Items naming relationships ``at`` the hub (root → child k) or a leaf (child k → leaf k)."""
    if at == "hub":
        return [{"src": HUB[1], "tgt": f"urn:o:{k}", **extra} for k in ks]
    return [{"src": f"urn:o:{k}", "tgt": f"urn:a:{k}", **extra} for k in ks]


def _labels(at: str):
    return ("Layer", "Object") if at == "hub" else ("Object", "Attribute")


def _cells(items: list) -> list:
    return [{"s": it["src"], "t": it["tgt"]} for it in items]


async def _timed(call, cypher: str, items: list):
    """Run ``cypher`` over ``items`` once; ms per row and the result."""
    started = time.perf_counter()
    res = await call(cypher, {"batch": items}, timeout=TIMEOUT_MS)
    return 1000.0 * (time.perf_counter() - started) / max(1, len(items)), res


async def _per_row(g, cypher: str, items: list) -> tuple:
    """A read's ms per row: the better of two runs, the first also planning it."""
    first, _ = await _timed(g.ro_query, cypher, items)
    second, res = await _timed(g.ro_query, cypher, items)
    return min(first, second), res


async def _plan(g, cypher: str, items: list) -> str:
    try:
        return str(await g.explain(cypher, {"batch": items}))
    except Exception as exc:  # noqa: BLE001 — the plan is a record, not an assertion
        return f"unavailable: {exc}"


async def _held(g, at: str, rel: str, ks) -> int:
    sl, tl = _labels(at)
    res = await g.ro_query(
        f"UNWIND $batch AS it {projection._between(rel, sl, tl, item='it')} RETURN count(r)",
        {"batch": _rows(at, ks)}, timeout=TIMEOUT_MS)
    return int(res.result_set[0][0])


async def _hub_has(g) -> int:
    """How many ``HAS`` the hub holds: its relationships walked once."""
    res = await g.ro_query("MATCH (:Layer {urn: 'urn:root'})-[r:HAS]->() RETURN count(r)",
                           timeout=TIMEOUT_MS)
    return int(res.result_set[0][0])


def _bounded(report: dict, name: str) -> bool:
    hub, leaf = report[name]["hub_ms_per_row"], report[name]["leaf_ms_per_row"]
    return hub <= max(RATIO * leaf, FLOOR_MS)


async def _run(report: dict) -> None:
    db = _db()
    g = db.select_graph(f"hub_lookups_{uuid.uuid4().hex[:8]}")
    report["hub_children"], report["rows"] = HUB_CHILDREN, ROWS
    step = max(1, HUB_CHILDREN // ROWS)
    # The rows each statement looks up: on the hub spread over its children, on the leaves the
    # first children's; each delete takes rows of its own.
    picks = {name: [k * step + j for k in range(ROWS)]
             for j, name in enumerate(("read", "by_key", "by_id", "by_rid", "cell_delete"))}
    leaf_picks = {name: list(range(j * ROWS, (j + 1) * ROWS))
                  for j, name in enumerate(("read", "by_key", "by_id", "by_rid", "cell_delete"))}
    try:
        started = time.perf_counter()
        await _seed(g, HUB_CHILDREN, 6 * ROWS)
        report["seed_s"] = round(time.perf_counter() - started, 1)

        # ── The shapes the projector sent before: recorded, not asserted ──
        old = {
            "walked_from_one_end": lambda sl, tl: (
                f"UNWIND $batch AS it MATCH (a:{sl} {{urn: it.src}})-[r:HAS]->"
                f"(b:{tl} {{urn: it.tgt}}) RETURN it.src, it.tgt, r.gvHash"),
            "ends_found_in_the_same_query_part": lambda sl, tl: (
                f"UNWIND $batch AS it MATCH (a:{sl} {{urn: it.src}}) "
                f"MATCH (b:{tl} {{urn: it.tgt}}) MATCH (a)-[r:HAS]->(b) "
                "RETURN it.src, it.tgt, r.gvHash"),
        }
        for name, shape in old.items():
            entry = report.setdefault(name, {})
            for at, ks in (("hub", picks["read"][:OLD_ROWS]), ("leaf", leaf_picks["read"][:OLD_ROWS])):
                cypher = shape(*_labels(at))
                try:
                    entry[f"{at}_ms_per_row"] = round((await _per_row(g, cypher, _rows(at, ks)))[0], 3)
                except Exception as exc:  # noqa: BLE001 — a timeout is a result here
                    entry[f"{at}_ms_per_row"] = None
                    entry[f"{at}_error"] = str(exc)[:200]
            entry["plan"] = await _plan(g, shape(*_labels("hub")), _rows("hub", picks["read"][:2]))

        # The web tier's read of the relationships between a few known entities
        # (``FalkorDBProvider._edges_between_pairs``), one pair a call, and the same with a WITH.
        pair_read = (
            "MATCH (a:{sl}) WHERE a.urn IN $sourceUrns MATCH (b:{tl}) WHERE b.urn IN $targetUrns "
            "{bind}MATCH (a)-[r:HAS]->(b) RETURN a.urn AS src, b.urn AS tgt, type(r) AS relType, "
            "properties(r) AS rprops LIMIT $limit")
        for name, with_ in (("web_pair_read", ""), ("web_pair_read_with", "WITH a, b ")):
            entry = report.setdefault(name, {})
            for at, ks in (("hub", picks["read"][::20]), ("leaf", leaf_picks["read"][::20])):
                sl, tl = _labels(at)
                cypher = pair_read.format(sl=sl, tl=tl, bind=with_)
                took = []
                for it in _rows(at, ks):
                    started = time.perf_counter()
                    await g.ro_query(cypher, {"sourceUrns": [it["src"]], "targetUrns": [it["tgt"]],
                                              "limit": 10}, timeout=TIMEOUT_MS)
                    took.append(1000.0 * (time.perf_counter() - started))
                entry[f"{at}_ms_per_call"] = round(statistics.median(took[1:] or took), 3)
                entry[f"{at}_ms_per_call_max"] = round(max(took), 3)
            entry["plan"] = await _plan(g, pair_read.format(sl="Layer", tl="Object", bind=with_)
                                        .replace("$sourceUrns", "['urn:root']")
                                        .replace("$targetUrns", "['urn:o:1']")
                                        .replace("$limit", "10"), [])

        # ── What the projector sends now ──
        entry = report.setdefault("fingerprints", {})
        for at, ks in (("hub", picks["read"]), ("leaf", leaf_picks["read"])):
            cypher = projection._edge_fingerprints_cypher("HAS", *_labels(at))
            ms, res = await _per_row(g, cypher, _rows(at, ks))
            entry[f"{at}_ms_per_row"] = round(ms, 3)
            got = sorted((str(t), int(fp)) for _s, t, fp in res.result_set)
            want = sorted((it["tgt"], k) for it, k in zip(_rows(at, ks), ks))
            entry[f"{at}_exact"] = got == want
        entry["plan"] = await _plan(g, projection._edge_fingerprints_cypher("HAS", *_labels("hub")),
                                    _rows("hub", picks["read"][:2]))

        entry = report.setdefault("summary_read", {})
        for at, ks in (("hub", picks["read"]), ("leaf", leaf_picks["read"])):
            cypher = projection._rollup_read_cypher(*_labels(at))
            ms, res = await _per_row(g, cypher, _cells(_rows(at, ks)))
            entry[f"{at}_ms_per_row"] = round(ms, 3)
            got = sorted((str(t), int(w)) for _s, t, w, _types, _gv in res.result_set)
            want = sorted((it["tgt"], k % 7 + 1) for it, k in zip(_rows(at, ks), ks))
            entry[f"{at}_exact"] = got == want

        # Deletes, each on rows of its own; what is left is counted after.
        hub_has_before = await _hub_has(g)
        deletes = (
            ("delete_by_key", "by_key", "HAS",
             lambda sl, tl: projection._delete_edges_by_key_cypher("HAS", sl, tl),
             lambda at, ks: _rows(at, ks)),
            ("delete_by_id", "by_id", "HAS",
             lambda sl, tl: projection._delete_edges_cypher("HAS", sl, tl),
             lambda at, ks: [{**it, "eid": ("h" if at == "hub" else "l") + str(k), "pid": None}
                             for it, k in zip(_rows(at, ks), ks)]),
            ("summary_delete", "cell_delete", "AGGREGATED",
             lambda sl, tl: projection._rollup_delete_cypher(sl, tl),
             lambda at, ks: _cells(_rows(at, ks))),
        )
        for name, pick, rel, statement, items_of in deletes:
            entry = report.setdefault(name, {})
            for at, ks in (("hub", picks[pick]), ("leaf", leaf_picks[pick])):
                ms, _ = await _timed(g.query, statement(*_labels(at)), items_of(at, ks))
                entry[f"{at}_ms_per_row"] = round(ms, 3)
                entry[f"{at}_left"] = await _held(g, at, rel, ks)

        # By internal id: the ids read first, as the reconcile's page of relationships reads them.
        entry = report.setdefault("delete_by_internal_id", {})
        for at, ks in (("hub", picks["by_rid"]), ("leaf", leaf_picks["by_rid"])):
            sl, tl = _labels(at)
            res = await g.ro_query(
                f"UNWIND $batch AS it {projection._between('HAS', sl, tl, item='it')} "
                "RETURN it.tgt, id(r)", {"batch": _rows(at, ks)}, timeout=TIMEOUT_MS)
            rid = {str(t): int(i) for t, i in res.result_set}
            items = [{**it, "rid": rid[it["tgt"]]} for it in _rows(at, ks)]
            ms, _ = await _timed(g.query, projection._delete_edge_ids_cypher("`HAS`", sl, tl), items)
            entry[f"{at}_ms_per_row"] = round(ms, 3)
            entry[f"{at}_left"] = await _held(g, at, "HAS", ks)
        report["hub_has_deleted"] = hub_has_before - await _hub_has(g)
    finally:
        try:
            await g.delete()
        finally:
            await db.connection.aclose()


def test_a_relationship_between_two_known_nodes_costs_the_same_from_a_hub():
    report: dict = {}
    try:
        asyncio.run(_run(report))
    finally:
        line = json.dumps(report, sort_keys=True)
        print(f"\nHUB_LOOKUP_REPORT {line}")
        path = os.getenv("HUB_LOOKUP_REPORT_PATH")
        if path:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(line + "\n")
    for name in ("fingerprints", "summary_read"):
        assert report[name]["hub_exact"] and report[name]["leaf_exact"], (name, report[name])
    for name in ("delete_by_key", "delete_by_id", "summary_delete", "delete_by_internal_id"):
        assert report[name]["hub_left"] == 0 and report[name]["leaf_left"] == 0, (name, report[name])
    # Each delete took its own rows on the hub and nothing else.
    assert report["hub_has_deleted"] == 3 * ROWS, report["hub_has_deleted"]
    slow = [name for name in ("fingerprints", "summary_read", "delete_by_key", "delete_by_id",
                              "summary_delete", "delete_by_internal_id")
            if not _bounded(report, name)]
    assert not slow, {name: report[name] for name in slow}
