#!/usr/bin/env python3
"""Live certification of ``POST /trace/closure`` against a real data source.

Drives the endpoint EXACTLY as the clients do (same request shapes, same
cursors) and compares what arrives with what the graph holds, so a number
in a report is a measurement rather than a belief. Read-only.

    # one page, the Lens's one-hop request, summarised
    scripts/trace_live_probe.py page WS DS URN --depth 1

    # drain the seed cursor to completion and compare with Cypher truth
    scripts/trace_live_probe.py drain WS DS URN --depth 1 --max-nodes 2000 \
        --graph solidatus-test-large --falkordb localhost:6379

Credentials: ADMIN_EMAIL / ADMIN_PASSWORD from ``.env.dev`` (never printed).
The session cookies are Secure, so they are re-sent by hand over http.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("API_BASE", "http://localhost:8000/api/v1")


def _env(key: str) -> str:
    with open(os.path.join(ROOT, ".env.dev")) as fh:
        for line in fh:
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"missing {key} in .env.dev")


class Api:
    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method: str, path: str, body=None, timeout: int = 600):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        cookies = {c.name: c.value for c in self.jar}
        if cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
            if "nx_csrf" in cookies:
                req.add_header("X-CSRF-Token", cookies["nx_csrf"])
        try:
            with self.opener.open(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, json.loads(raw or b"null"), len(raw), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, (e.read() or b"").decode()[:500], 0, {}

    def login(self) -> None:
        st, res, _, _ = self.call("POST", "/auth/login", {"email": _env("ADMIN_EMAIL"), "password": _env("ADMIN_PASSWORD")})
        if st != 200:
            raise SystemExit(f"login failed: {st} {res}")


def closure(api: Api, ws: str, ds: str, body: dict):
    t = time.monotonic()
    st, res, nbytes, headers = api.call("POST", f"/{ws}/graph/trace/closure?dataSourceId={ds}", body)
    ms = (time.monotonic() - t) * 1000
    if st != 200:
        raise SystemExit(f"HTTP {st}: {res}")
    return res, ms, nbytes, headers.get("X-Cache-Status") or headers.get("x-cache-status")


def summarise(res: dict, ms: float, nbytes: int, cache: str | None) -> str:
    fu, fd = res.get("frontierUp") or [], res.get("frontierDown") or []
    kinds = {}
    for f in [*fu, *fd]:
        k = f"{f.get('reason') or '?'}{'+cursor' if f.get('nextCursor') else ''}"
        kinds[k] = kinds.get(k, 0) + 1
    return (
        f"{ms:7.0f} ms  nodes={len(res.get('nodes') or []):5d} edges={len(res.get('edges') or []):5d} "
        f"cont={len(res.get('containmentEdges') or []):5d} up={len(res.get('upstreamUrns') or []):4d} "
        f"down={len(res.get('downstreamUrns') or []):4d} reason={res.get('truncationReason')} "
        f"seedCursor={'yes' if res.get('seedCursor') else 'no'} frontier={kinds} "
        f"bytes={nbytes} cache={cache}"
    )


def cypher_truth(graph: str, falkordb: str, urn: str):
    """Hop-1 truth straight from the graph: every lineage edge incident to the
    focus or any containment descendant (two queries — FalkorDB rejects the
    alias+aggregation form)."""
    from falkordb import FalkorDB  # local dependency, only for --graph

    host, _, port = falkordb.partition(":")
    gr = FalkorDB(host=host, port=int(port or 6379)).select_graph(graph)
    rels = [r[0] for r in gr.ro_query("CALL db.relationshipTypes()").result_set]
    lt = [r for r in rels if r.upper() not in ("AGGREGATED", "HAS", "CONTAINS", "BELONGS_TO", "TAGGED_WITH", "DEFINED_BY")]
    ct = [r for r in rels if r.upper() in ("HAS", "CONTAINS")]
    lt_alt, ct_alt = "|".join(lt), "|".join(ct)
    own = gr.ro_query(
        f"MATCH (f {{urn:$u}})-[r:{lt_alt}]-() RETURN DISTINCT startNode(r).urn, endNode(r).urn",
        {"u": urn}, timeout=60000,
    ).result_set
    below = gr.ro_query(
        f"MATCH (f {{urn:$u}})-[:{ct_alt}*1..16]->(d)-[r:{lt_alt}]-() RETURN DISTINCT startNode(r).urn, endNode(r).urn",
        {"u": urn}, timeout=60000,
    ).result_set
    edges = {(a, b) for a, b in [*own, *below]}
    return edges, lt, ct


def coarse_truth(graph: str, falkordb: str, urn: str):
    """Every `:AGGREGATED` cell incident to the focus, straight from the graph."""
    from falkordb import FalkorDB

    host, _, port = falkordb.partition(":")
    gr = FalkorDB(host=host, port=int(port or 6379)).select_graph(graph)
    row = gr.ro_query(
        "MATCH (f {urn:$u})-[r:AGGREGATED]-(p) RETURN count(r), sum(coalesce(r.weight, 0))",
        {"u": urn}, timeout=60000,
    ).result_set[0]
    return int(row[0]), int(row[1] or 0)


def cmd_page(args: argparse.Namespace) -> None:
    api = Api(); api.login()
    body = {"urn": args.urn, "direction": args.direction, "upstreamDepth": args.depth, "downstreamDepth": args.depth}
    if args.max_nodes:
        body["maxNodes"] = args.max_nodes
    if args.grain:
        body["grain"] = args.grain
    for i in range(args.repeat):
        res, ms, nbytes, cache = closure(api, args.ws, args.ds, body)
        print(f"[page {i + 1}] {summarise(res, ms, nbytes, cache)} grain={res.get('grain')}")
    if args.grain == "coarse" and args.graph:
        cells = [e for e in res.get("edges") or [] if str(e.get("edgeType", "")).upper() == "AGGREGATED"]
        total_w = sum((e.get("properties") or {}).get("weight") or 0 for e in cells)
        n_truth, w_truth = coarse_truth(args.graph, args.falkordb, args.urn)
        print(f"== coarse: {len(cells)} cells shipped (Σweight {total_w}); graph holds {n_truth} incident cells (Σweight {w_truth})")
        print("== VERDICT:", "COMPLETE" if (len(cells) == n_truth and total_w == w_truth) else "INCOMPLETE")


def cmd_drain(args: argparse.Namespace) -> None:
    api = Api(); api.login()
    pages, cursor, known, edges = 0, None, set(), set()
    cols_seen: list[str] = []
    t0 = time.monotonic(); slowest = 0.0
    reasons = set()
    while True:
        body = {"urn": args.urn, "direction": args.direction, "upstreamDepth": args.depth, "downstreamDepth": args.depth}
        if args.max_nodes:
            body["maxNodes"] = args.max_nodes
        if args.grain:
            body["grain"] = args.grain
        if cursor:
            body["seedCursor"] = cursor
            if known:
                body["excludeUrns"] = sorted(known)[:2000]
        res, ms, nbytes, cache = closure(api, args.ws, args.ds, body)
        pages += 1; slowest = max(slowest, ms)
        print(f"[drain page {pages}] {summarise(res, ms, nbytes, cache)}")
        if args.dump:
            os.makedirs(args.dump, exist_ok=True)
            with open(os.path.join(args.dump, f"page_{pages:02d}.json"), "w") as fh:
                json.dump(res, fh)
        for n in res.get("nodes") or []:
            known.add(n["urn"])
        for e in res.get("edges") or []:
            edges.add((e["sourceUrn"], e["targetUrn"]))
        if res.get("truncationReason"):
            reasons.add(res["truncationReason"])
        cursor = res.get("seedCursor")
        if not cursor or pages >= args.max_pages:
            break
    wall = time.monotonic() - t0
    print(f"\n== drained in {pages} pages, {wall:.1f} s wall, slowest page {slowest:.0f} ms, "
          f"{len(edges)} hop-1 edges, {len(known)} nodes known, reasons={sorted(reasons)}, "
          f"cursor {'drained' if not cursor else 'STILL OPEN'}")
    if args.graph:
        truth, lt, ct = cypher_truth(args.graph, args.falkordb, args.urn)
        missing = truth - edges
        extra = edges - truth
        print(f"== Cypher truth ({'|'.join(lt)} under {'|'.join(ct)}): {len(truth)} edges; "
              f"missing from pages: {len(missing)}; not in truth: {len(extra)}")
        if missing:
            print("   e.g. missing:", sorted(missing)[:3])
        print("== VERDICT:", "COMPLETE" if not missing else "INCOMPLETE")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("page", cmd_page), ("drain", cmd_drain)):
        sp = sub.add_parser(name)
        sp.add_argument("ws"); sp.add_argument("ds"); sp.add_argument("urn")
        sp.add_argument("--depth", type=int, default=1)
        sp.add_argument("--direction", default="both")
        sp.add_argument("--max-nodes", type=int, default=0)
        sp.add_argument("--grain", default="", help="'coarse' asks for the rollup cells incident to the focus (Part G)")
        sp.set_defaults(fn=fn)
    sub.choices["page"].add_argument("--repeat", type=int, default=1)
    sub.choices["page"].add_argument("--graph", default="")
    sub.choices["page"].add_argument("--falkordb", default="localhost:6379")
    sub.choices["drain"].add_argument("--max-pages", type=int, default=200)
    sub.choices["drain"].add_argument("--graph", default="")
    sub.choices["drain"].add_argument("--falkordb", default="localhost:6379")
    sub.choices["drain"].add_argument("--dump", default="", help="directory to save each page's JSON into")
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
