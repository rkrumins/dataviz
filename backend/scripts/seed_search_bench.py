#!/usr/bin/env python3
"""Seed a search-benchmark graph straight into FalkorDB — the S0 spike's data.

Property search has to hold on graphs of millions of entities whose values
are every kind at once, so this writes exactly that, fast (batched ``UNWIND``
Cypher, no provider round trips), in the shape the provider writes:

* a containment hierarchy ``Domain → Container → Dataset → SchemaField``
  over ``CONTAINS`` edges, plus ``TRANSFORMS`` lineage between fields;
* the platform fields every node carries (``urn``, ``displayName``,
  ``qualifiedName``, ``searchableText``) and a range index on ``urn`` per
  label, as ``ensure_indices`` creates;
* typed user properties that exercise every comparison the search engine
  offers — the reported ones first:

    gvHash       int64 across the whole range (the 19-digit ids that broke)
    sourceId     numeric TEXT ("48213") — "15" > 10 must hold
    code         zero-padded text ("00042")
    rowCount     integers (datasets)
    score        floats in [0, 1)
    isPii        booleans, and the text "true"/"false" on some nodes
    updated      ISO timestamps with and without offsets, some date-only
    labels       lists of text
    owner        text from a vocabulary of ``--owners`` values
    tier         gold / silver / bronze, missing on a fifth of the nodes
    mixed        a number on most nodes, text on the rest

Run::

    python -m backend.scripts.seed_search_bench --nodes 1000000 \\
        --host localhost --port 6379 --graph search_bench

The graph is dropped first. Deterministic for a given ``--seed``.
"""
from __future__ import annotations

import argparse
import random
import time
from datetime import datetime, timedelta, timezone

from falkordb import FalkorDB


OWNER_WORDS = ("data", "platform", "analytics", "finance", "sales", "ops",
               "ml", "risk", "growth", "core", "infra", "product")
LABEL_WORDS = ("pii", "gold", "gdpr", "sox", "deprecated", "certified",
               "raw", "curated", "internal", "public")
NOW = datetime(2026, 9, 1, tzinfo=timezone.utc)


def owners(n: int) -> list[str]:
    rng = random.Random(7)
    return [f"{rng.choice(OWNER_WORDS)}-{rng.choice(OWNER_WORDS)}-{i}" for i in range(n)]


def props(rng: random.Random, i: int, owner_pool: list[str]) -> dict:
    """The typed user properties of one node."""
    p: dict = {
        "gvHash": rng.randint(-(2 ** 63), 2 ** 63 - 1),
        "sourceId": str(rng.randint(0, 99_999)),
        "code": f"{rng.randint(0, 99_999):05d}",
        "score": rng.random(),
        "owner": owner_pool[int(rng.paretovariate(1.2)) % len(owner_pool)],
        "labels": rng.sample(LABEL_WORDS, rng.randint(0, 3)),
        "mixed": rng.randint(0, 1000) if rng.random() < 0.9 else f"n/a-{rng.randint(0, 9)}",
    }
    moment = NOW - timedelta(seconds=rng.randint(0, 2 * 365 * 86400))
    shape = rng.random()
    p["updated"] = (moment.date().isoformat() if shape < 0.2
                    else moment.strftime("%Y-%m-%dT%H:%M:%SZ") if shape < 0.8
                    else moment.astimezone(timezone(timedelta(hours=2))).isoformat())
    p["isPii"] = rng.random() < 0.1 if rng.random() < 0.8 else rng.choice(["true", "false"])
    if rng.random() < 0.8:
        p["tier"] = rng.choice(("gold", "silver", "bronze"))
    return p


def node_row(rng, label: str, i: int, parent: str | None, owner_pool) -> dict:
    urn = f"urn:bench:{label.lower()}:{i}"
    name = f"{label.lower()}_{i}"
    qname = f"{parent.rsplit(':', 1)[-1] if parent else 'root'}.{name}"
    row = {
        "urn": urn, "parent": parent,
        "displayName": name, "qualifiedName": qname,
        "searchableText": f"{name} {qname}".lower(),
        **props(rng, i, owner_pool),
    }
    if label == "Dataset":
        row["rowCount"] = rng.randint(0, 50_000_000)
    return row


def seed(host: str, port: int, graph_name: str, total: int, seed_value: int,
         batch: int, owner_count: int) -> None:
    rng = random.Random(seed_value)
    db = FalkorDB(host=host, port=port)
    g = db.select_graph(graph_name)
    try:
        g.delete()
    except Exception:
        pass
    owner_pool = owners(owner_count)
    counts = {
        "Domain": max(1, total // 20_000),
        "Container": max(1, total // 2_000),
        "Dataset": max(1, total // 20),
    }
    counts["SchemaField"] = max(1, total - sum(counts.values()))
    parents = {"Domain": None, "Container": "Domain", "Dataset": "Container",
               "SchemaField": "Dataset"}
    t0 = time.monotonic()
    for label in ("Domain", "Container", "Dataset", "SchemaField"):
        g.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
        parent_label = parents[label]
        rows = []

        def flush() -> None:
            if not rows:
                return
            if parent_label is None:
                g.query(f"UNWIND $rows AS r CREATE (n:{label}) SET n = r, n.parent = null",
                        {"rows": rows})
            else:
                g.query(
                    f"UNWIND $rows AS r MATCH (p:{parent_label} {{urn: r.parent}}) "
                    f"CREATE (p)-[:CONTAINS]->(n:{label}) SET n = r, n.parent = null",
                    {"rows": rows})
            rows.clear()

        for i in range(counts[label]):
            parent = (None if parent_label is None else
                      f"urn:bench:{parent_label.lower()}:{rng.randrange(counts[parent_label])}")
            rows.append(node_row(rng, label, i, parent, owner_pool))
            if len(rows) >= batch:
                flush()
        flush()
        print(f"{label}: {counts[label]} nodes ({time.monotonic() - t0:.1f}s)", flush=True)

    fields = counts["SchemaField"]
    edges = fields // 2
    for start in range(0, edges, batch):
        pairs = [{"a": f"urn:bench:schemafield:{rng.randrange(fields)}",
                  "b": f"urn:bench:schemafield:{rng.randrange(fields)}"}
                 for _ in range(min(batch, edges - start))]
        g.query("UNWIND $pairs AS e MATCH (a:SchemaField {urn: e.a}), (b:SchemaField {urn: e.b}) "
                "CREATE (a)-[:TRANSFORMS]->(b)", {"pairs": pairs})
    print(f"TRANSFORMS: {edges} edges ({time.monotonic() - t0:.1f}s)", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=6379)
    ap.add_argument("--graph", default="search_bench")
    ap.add_argument("--nodes", type=int, default=1_000_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--batch", type=int, default=10_000)
    ap.add_argument("--owners", type=int, default=5_000)
    a = ap.parse_args()
    seed(a.host, a.port, a.graph, a.nodes, a.seed, a.batch, a.owners)


if __name__ == "__main__":
    main()
