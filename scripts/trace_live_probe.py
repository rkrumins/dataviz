#!/usr/bin/env python3
"""Live certification probe for POST /graph/trace/closure.

Answers, against a RUNNING stack and a REAL data source, the three
questions Stage 2 of the trace-overlay rebuild is accountable for:

  1. Does containment ALWAYS ship?  Every lineage participant that has a
     containment parent in the graph must arrive with that parent's edge
     in ``containmentEdges`` — never a silent ``[]`` (F18). The probe
     reports coverage, and with ``--verify-parents`` it asks the graph
     itself (``GET /nodes/{urn}/ancestors?limit=1``) whether an UNCOVERED
     participant really has no parent or whether the closure dropped it.
  2. Is ``childCount`` counted from the graph?  Every node that appears as
     a containment PARENT in the response must report ``childCount > 0``
     (F20). A parent with ``childCount`` 0/None is a missing chevron —
     the node the user cannot expand. That is reported as a VIOLATION.
  3. What does it cost?  Per-request and cumulative wall time, request
     count, and (with ``--pages``) how many requests a frontier-following
     walk needs before it is exhausted.

Credentials come from ``.env.dev`` (``ADMIN_EMAIL`` / ``ADMIN_PASSWORD``)
and are never printed; neither are cookies or tokens.

Usage
-----
    # what is on the stack
    python3 scripts/trace_live_probe.py --list

    # certify one focus
    python3 scripts/trace_live_probe.py \
        --source "Nexus Lineage" \
        --urn "urn:li:dashboard:cfo_revenue_dashboard_3c4328f1" \
        --pages 12 --verify-parents 25
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("This probe needs `requests` (pip install requests).")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(REPO_ROOT, ".env.dev")


# --------------------------------------------------------------------------- #
# Session
# --------------------------------------------------------------------------- #
def _read_credentials(env_file: str) -> Tuple[str, str]:
    """Pull ADMIN_EMAIL / ADMIN_PASSWORD out of .env.dev.

    The values are returned, never logged. The environment wins when set,
    matching how the dev stack itself resolves them.
    """
    values: Dict[str, str] = {}
    try:
        with open(env_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                values[key.strip()] = val.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    email = os.getenv("ADMIN_EMAIL") or values.get("ADMIN_EMAIL", "")
    password = os.getenv("ADMIN_PASSWORD") or values.get("ADMIN_PASSWORD", "")
    if not email or not password:
        sys.exit(f"ADMIN_EMAIL / ADMIN_PASSWORD not found in {env_file}")
    return email, password


class Api:
    """Cookie-session client that speaks the same CSRF double-submit the SPA does."""

    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.s = requests.Session()
        self.requests_made = 0
        self.total_request_secs = 0.0
        # The session cookies are minted Secure (and on a .local domain), so a
        # cookie jar will NOT replay them over plain http://localhost — every
        # follow-up call came back 401 "Not authenticated" until they were
        # attached by hand. The browser does not hit this because it talks to
        # the stack over https. Values are held here and never printed.
        self._cookies: Dict[str, str] = {}

    def login(self, email: str, password: str) -> str:
        r = self._call("POST", "/api/v1/auth/login",
                       json={"email": email, "password": password}, csrf=False)
        r.raise_for_status()
        self._cookies = {c.name: c.value for c in self.s.cookies}
        if "nx_access" not in " ".join(self._cookies):
            sys.exit("Login returned no session cookie.")
        # Confirm WHO without printing it: probe output gets pasted into
        # reports and tickets, and the admin's address is not needed to know
        # the session is good.
        user = r.json().get("user") or {}
        return user.get("id") or "<signed in>"

    def _csrf(self) -> Optional[str]:
        # The CSRF cookie may be environment-scoped (nx_csrf_<env>); match by prefix.
        for name, value in self._cookies.items():
            if name.startswith("nx_csrf"):
                return value
        return None

    def _call(self, method: str, path: str, *, csrf: bool = True, **kw):
        headers = dict(kw.pop("headers", {}) or {})
        if self._cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self._cookies.items())
        if csrf:
            token = self._csrf()
            if token:
                headers["X-CSRF-Token"] = token
        started = time.perf_counter()
        r = self.s.request(method, f"{self.base}{path}", headers=headers,
                           timeout=kw.pop("timeout", 180), **kw)
        elapsed = time.perf_counter() - started
        self.requests_made += 1
        self.total_request_secs += elapsed
        r.elapsed_secs = elapsed  # type: ignore[attr-defined]
        return r

    def get(self, path: str, **kw):
        r = self._call("GET", path, **kw)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, **kw):
        r = self._call("POST", path, **kw)
        if r.status_code >= 400:
            sys.exit(f"POST {path} -> {r.status_code}: {r.text[:600]}")
        return r.json(), r.elapsed_secs  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #
def list_sources(api: Api) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for ws in api.get("/api/v1/admin/workspaces"):
        ws_id = ws.get("id")
        try:
            sources = api.get(f"/api/v1/admin/workspaces/{ws_id}/data-sources")
        except Exception as exc:
            print(f"  ! workspace {ws_id}: {exc}", file=sys.stderr)
            continue
        for ds in sources:
            out.append({
                "workspaceId": ws_id,
                "workspaceName": ws.get("name") or ws.get("label") or "",
                "dataSourceId": ds.get("id"),
                "label": ds.get("label") or "",
                "graphName": ds.get("graphName") or "",
                "ontologyId": ds.get("ontologyId") or "",
                "isActive": ds.get("isActive"),
            })
    return out


def resolve_source(api: Api, needle: str, workspace: Optional[str]) -> Dict[str, Any]:
    candidates = list_sources(api)
    if workspace:
        candidates = [c for c in candidates
                      if workspace in (c["workspaceId"], c["workspaceName"])]
    exact_id = [c for c in candidates if c["dataSourceId"] == needle]
    if exact_id:
        return exact_id[0]
    by_label = [c for c in candidates if c["label"].lower() == needle.lower()]
    if not by_label:
        by_label = [c for c in candidates if needle.lower() in c["label"].lower()]
    if not by_label:
        sys.exit(f"No data source matching {needle!r}. Run with --list.")
    if len(by_label) > 1:
        print(f"  ! {len(by_label)} sources match {needle!r}; using "
              f"{by_label[0]['dataSourceId']} — pass the id to disambiguate:")
        for c in by_label:
            print(f"      {c['dataSourceId']}  ws={c['workspaceId']}  graph={c['graphName']}")
    return by_label[0]


def resolve_view(api: Api, ws_id: str, ds_id: str) -> Optional[str]:
    """First view over this (workspace, source), the way the canvas opens one."""
    try:
        payload = api.get(f"/api/v1/views/?workspaceId={ws_id}&dataSourceId={ds_id}&limit=1")
    except Exception:
        return None
    items = payload.get("items") if isinstance(payload, dict) else payload
    if isinstance(items, list) and items:
        return items[0].get("id")
    return None


# --------------------------------------------------------------------------- #
# The walk
# --------------------------------------------------------------------------- #
class Closure:
    """Accumulates one or more /trace/closure responses into one picture."""

    def __init__(self) -> None:
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.edges: Dict[str, Dict[str, Any]] = {}
        self.containment: Dict[str, Dict[str, Any]] = {}
        self.upstream: set = set()
        self.downstream: set = set()
        self.truncation_reasons: List[str] = []
        self.page_times: List[float] = []
        # The FIRST response's frontier is the walk's boundary; a cursor page
        # afterwards reports only the one node it paged, so overwriting with
        # the last page would understate the boundary to zero.
        self.frontier_up: List[Dict[str, Any]] = []
        self.frontier_down: List[Dict[str, Any]] = []
        self.frontier_entries_seen = 0
        self.seed_cursor: Optional[str] = None
        self.seed_truncated = False
        self._first = True
        #: Walk mode: keep the frontier LIVE (merged per response) instead of
        #: frozen at the first page.
        self.live_frontier = False

    def merge(self, res: Dict[str, Any], secs: float) -> None:
        for n in res.get("nodes") or []:
            self.nodes[n["urn"]] = n
        for e in res.get("edges") or []:
            self.edges[e["id"]] = e
        for e in res.get("containmentEdges") or []:
            self.containment[e["id"]] = e
        self.upstream |= set(res.get("upstreamUrns") or [])
        self.downstream |= set(res.get("downstreamUrns") or [])
        if res.get("truncationReason"):
            self.truncation_reasons.append(res["truncationReason"])
        self.frontier_entries_seen += len(res.get("frontierUp") or []) + len(res.get("frontierDown") or [])
        if self.live_frontier:
            # WALK MODE: the frontier is state, not a report — merged the way
            # the client merges it, so following it terminates. The response is
            # authoritative for the anchor it was asked about (its entry goes),
            # and every entry it DOES carry is upserted.
            self._merge_frontier(res)
        if self._first:
            self.frontier_up = res.get("frontierUp") or []
            self.frontier_down = res.get("frontierDown") or []
            self.seed_cursor = res.get("seedCursor")
            self.seed_truncated = bool(res.get("seedTruncated"))
            self._first = False
        self.page_times.append(secs)

    def _merge_frontier(self, res: Dict[str, Any]) -> None:
        anchor = (res.get("focus") or {}).get("urn")
        for attr, key in (("frontier_up", "frontierUp"), ("frontier_down", "frontierDown")):
            by_urn = {e["urn"]: e for e in getattr(self, attr)}
            by_urn.pop(anchor, None)
            for e in res.get(key) or []:
                by_urn[e["urn"]] = e
            setattr(self, attr, list(by_urn.values()))

    def drop_drained(self, urns: List[str], direction: str) -> None:
        """A bulk drain answered for every seed it carried; the response can
        only clear the one anchor it was nominally asked about."""
        attr = "frontier_up" if direction == "upstream" else "frontier_down"
        drop = set(urns)
        setattr(self, attr, [
            e for e in getattr(self, attr)
            if e["urn"] not in drop or e.get("nextCursor")
        ])

    def merge_all(self, other: "Closure") -> None:
        """Fold a whole sub-walk (one drill and its pages) into this one."""
        self.nodes.update(other.nodes)
        self.edges.update(other.edges)
        self.containment.update(other.containment)
        self.upstream |= other.upstream
        self.downstream |= other.downstream
        self.truncation_reasons += other.truncation_reasons
        self.page_times += other.page_times
        self.frontier_entries_seen += other.frontier_entries_seen


def closure_body(urn: str, depth: int, direction: str,
                 max_nodes: Optional[int], grain: Optional[str] = None,
                 drill: bool = False) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "urn": urn,
        "direction": direction,
        "upstreamDepth": depth,
        "downstreamDepth": depth,
    }
    if max_nodes:
        body["maxNodes"] = max_nodes
    if grain:
        body["grain"] = grain
    if drill:
        # The lazy drill anchors on the card the reader opened; the walk
        # contract already spells that `seedUrns`.
        body["drill"] = True
        body["seedUrns"] = [urn]
    return body


def run_lazy(api: Api, path: str, urn: str, max_nodes: Optional[int],
             pages: int, drill: bool, label: str) -> Tuple[Closure, float, int]:
    """One LAZY request (coarse first paint, or one drill) followed to
    exhaustion: `seedCursor` pages more of the card's contents, a frontier
    `nextCursor` pages more of an anchor's edges. Neither is a truncation —
    this loop is what "no caps" actually costs in requests.

    Returns (accumulated closure, FIRST-page seconds, request count).
    """
    acc = Closure()
    body = closure_body(urn, 1, "both", max_nodes,
                        grain=None if drill else "coarse", drill=drill)
    res, first_secs = api.post(path, json=body)
    acc.merge(res, first_secs)
    requests = 1
    print(f"  {label:<10} page 1  ({first_secs * 1000:8.0f} ms)  "
          f"nodes={len(res.get('nodes') or []):>6} "
          f"edges={len(res.get('edges') or []):>6} "
          f"containment={len(res.get('containmentEdges') or []):>6} "
          f"frontier={len(res.get('frontierUp') or [])}/{len(res.get('frontierDown') or [])} "
          f"seedCursor={'yes' if res.get('seedCursor') else 'no'} "
          f"truncation={res.get('truncationReason')}")

    pending: List[Dict[str, Any]] = []

    def enqueue(res_obj: Dict[str, Any]) -> None:
        if res_obj.get("seedCursor"):
            b = closure_body(urn, 1, "both", max_nodes,
                             grain=None if drill else "coarse", drill=drill)
            b["seedCursor"] = res_obj["seedCursor"]
            pending.append({"body": b, "what": "contents", "carries_seed": True})
        for key, direction in (("frontierUp", "upstream"), ("frontierDown", "downstream")):
            for entry in res_obj.get(key) or []:
                cursor = entry.get("nextCursor")
                if not cursor:
                    continue
                pending.append({
                    "what": f"edges {direction} {entry['urn'][-24:]}",
                    "carries_seed": False,
                    "body": {
                        "urn": entry["urn"],
                        "direction": direction,
                        "upstreamDepth": 1 if direction == "upstream" else 0,
                        "downstreamDepth": 1 if direction == "downstream" else 0,
                        "afterCursor": cursor,
                        "grain": "coarse",
                        **({"maxNodes": max_nodes} if max_nodes else {}),
                    },
                })

    enqueue(res)
    seen: set = set()
    while pending and requests < pages:
        job = pending.pop(0)
        key = json.dumps(job["body"], sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        page_res, secs = api.post(path, json=job["body"])
        requests += 1
        acc.merge(page_res, secs)
        enqueue(page_res)
        print(f"  {label:<10} page {requests:<2} ({secs * 1000:8.0f} ms)  "
              f"+nodes={len(page_res.get('nodes') or []):>5} "
              f"+edges={len(page_res.get('edges') or []):>5} "
              f"+containment={len(page_res.get('containmentEdges') or []):>5} "
              f"[{job['what']}]")

    if pending:
        print(f"  {label:<10} ... {len(pending)} page(s) left unfollowed (--pages {pages})")
    else:
        print(f"  {label:<10} EXHAUSTED after {requests} request(s)")
    return acc, first_secs, requests


def run_walk(api: Api, ws: str, ds: str, view: Optional[str], urn: str,
             depth: int, max_nodes: Optional[int], pages: int) -> Closure:
    path = f"/api/v1/{ws}/graph/trace/closure?dataSourceId={ds}"
    if view:
        path += f"&viewId={view}"

    acc = Closure()
    res, secs = api.post(path, json=closure_body(urn, depth, "both", max_nodes))
    acc.merge(res, secs)
    print(f"  page 1  ({secs * 1000:8.0f} ms)  nodes={len(res.get('nodes') or []):>6} "
          f"edges={len(res.get('edges') or []):>6} "
          f"containment={len(res.get('containmentEdges') or []):>6} "
          f"frontier={len(res.get('frontierUp') or [])}/{len(res.get('frontierDown') or [])} "
          f"truncation={res.get('truncationReason')}")

    # Frontier following: a frontier entry carries a cursor exactly when it can
    # be RESUMED, and a cursor page is a single node, single direction, depth 1.
    pending: List[Tuple[str, str, str]] = []

    def enqueue(res_obj: Dict[str, Any]) -> None:
        for key, direction in (("frontierUp", "upstream"), ("frontierDown", "downstream")):
            for entry in res_obj.get(key) or []:
                cursor = entry.get("nextCursor")
                if cursor:
                    pending.append((entry["urn"], direction, cursor))

    enqueue(res)
    seen_pages: set = set()
    page_no = 1
    while pending and page_no < pages:
        node_urn, direction, cursor = pending.pop(0)
        key = (node_urn, direction, cursor)
        if key in seen_pages:
            continue
        seen_pages.add(key)
        body = {
            "urn": node_urn,
            "direction": direction,
            "upstreamDepth": 1 if direction == "upstream" else 0,
            "downstreamDepth": 1 if direction == "downstream" else 0,
            "afterCursor": cursor,
        }
        if max_nodes:
            body["maxNodes"] = max_nodes
        page_res, secs = api.post(path, json=body)
        page_no += 1
        acc.merge(page_res, secs)
        enqueue(page_res)
        print(f"  page {page_no:<2} ({secs * 1000:8.0f} ms)  +nodes={len(page_res.get('nodes') or []):>5} "
              f"+edges={len(page_res.get('edges') or []):>5} "
              f"+containment={len(page_res.get('containmentEdges') or []):>5} "
              f"[{direction} {node_urn[:44]}]")

    if pending:
        print(f"  ... {len(pending)} frontier pages left unfollowed (--pages {pages} budget)")
    else:
        print(f"  frontier EXHAUSTED after {page_no} request(s)")
    return acc


# --------------------------------------------------------------------------- #
# Verdict
# --------------------------------------------------------------------------- #
#: Seeds one bulk drain carries; the wire caps `seedUrns` at 500.
BULK_SEEDS = 200


def run_full_walk(api: Api, path: str, focus: str, acc: Closure,
                  max_requests: int, concurrency: int = 4) -> Tuple[int, float]:
    """The DRIVER's background walk, over HTTP: after the coarse paint, one
    fine hop from the focus, then every frontier entry followed — paged where
    it carries a cursor, re-rooted where it does not — until none remain.

    Sequential here rather than 4-wide (the probe is a script, not the
    driver); `concurrency` is reported so the wall time can be read as what
    the browser would see. Returns (requests, seconds).
    """
    started = time.perf_counter()
    requests = 0
    fired: Dict[str, int] = {}
    failed: set = set()
    #: Boundaries finished with — the response that answered them was not
    #: truncated. `excludeUrns` is capped at 2,000 by the wire, so past that
    #: the server re-files nodes the client already holds; without this the
    #: frontier grows faster than the walk drains it.
    settled: set = set()

    def known() -> List[str]:
        return list(acc.nodes.keys())[:2000]

    def fire(urns: List[str], direction: str, cursor: Optional[str]) -> None:
        nonlocal requests
        body: Dict[str, Any] = {
            "urn": urns[0],
            "direction": direction,
            "upstreamDepth": 1 if direction == "upstream" else 0,
            "downstreamDepth": 1 if direction == "downstream" else 0,
        }
        if cursor:
            body["afterCursor"] = cursor
        else:
            # ONE request for the whole ring — the server walks a SET.
            body["seedUrns"] = urns[:BULK_SEEDS]
            body["excludeUrns"] = known()
        try:
            res, secs = api.post(path, json=body)
        except Exception as exc:                       # noqa: BLE001 - operator-facing
            for u in urns:
                failed.add(f"{direction}:{u}")
            print(f"  walk       op failed [{direction} x{len(urns)}]: {str(exc)[:70]}")
            return
        requests += 1
        if os.getenv("PROBE_WALK_DEBUG") and requests <= 12:
            print(f"    op[{requests}] seeds={len(urns)} cursor={cursor} -> "
                  f"nodes={len(res.get('nodes') or [])} edges={len(res.get('edges') or [])} "
                  f"fUp={len(res.get('frontierUp') or [])} fDn={len(res.get('frontierDown') or [])} "
                  f"trunc={res.get('truncationReason')}")
        acc.merge(res, secs)
        if not res.get("truncated"):
            for u in urns:
                settled.add(f"{direction}:{u}")
        if len(urns) > 1:
            acc.drop_drained(urns, direction)

    # The focus's own fine hop first — the coarse paint answered it at card
    # grain, so the raw hops into its contents have not been asked for.
    fire([focus], "upstream", None)
    fire([focus], "downstream", None)

    while requests < max_requests:
        ops: List[Tuple[List[str], str, Optional[str]]] = []
        cursor_ops: List[Tuple[List[str], str, Optional[str]]] = []
        for key, direction in (("frontier_up", "upstream"), ("frontier_down", "downstream")):
            bulk: List[str] = []
            for entry in getattr(acc, key) or []:
                urn, cursor = entry["urn"], entry.get("nextCursor")
                op_key = f"{direction}:{urn}:{cursor or 'root'}"
                if f"{direction}:{urn}" in failed or f"{direction}:{urn}" in settled:
                    continue
                if fired.get(op_key, -1) >= len(acc.nodes):
                    continue
                if cursor:
                    fired[op_key] = len(acc.nodes)
                    cursor_ops.append(([urn], direction, cursor))
                elif len(bulk) < BULK_SEEDS:
                    fired[op_key] = len(acc.nodes)
                    bulk.append(urn)
            if bulk:
                ops.append((bulk, direction, None))
        # Bulk drains first: a truncated hop files its whole ring as resumable,
        # and letting those one-node cursor pages go first starves the drains
        # that are actually covering the flow.
        ops = (ops + cursor_ops)[:max(concurrency, len(ops))]
        if not ops:
            break
        for urns, direction, cursor in ops:
            fire(urns, direction, cursor)
        if requests % 25 < concurrency:
            print(f"  walk       {requests:>5} requests   {len(acc.nodes):>6} nodes   "
                  f"{len(acc.edges):>6} edges   frontier {len(acc.frontier_up)}/{len(acc.frontier_down)}   "
                  f"{(time.perf_counter() - started):.0f}s")

    elapsed = time.perf_counter() - started
    done = not (acc.frontier_up or acc.frontier_down)
    print(f"  walk       {'EXHAUSTED' if done else 'BUDGET SPENT'} after {requests} requests, "
          f"{elapsed:.1f}s — {len(acc.nodes)} nodes, {len(acc.edges)} edges, "
          f"frontier {len(acc.frontier_up)}/{len(acc.frontier_down)} left")
    return requests, elapsed


def report(api: Api, acc: Closure, focus: str, ws: str, ds: str,
           view: Optional[str], container_types: List[str],
           verify_parents: int) -> None:
    parents_in_response = {e["sourceUrn"] for e in acc.containment.values()}
    children_in_response = {e["targetUrn"] for e in acc.containment.values()}
    participants = (acc.upstream | acc.downstream | {focus}) & set(acc.nodes)

    covered = participants & children_in_response
    uncovered = sorted(participants - children_in_response)
    pct = (100.0 * len(covered) / len(participants)) if participants else 0.0

    print()
    print("  ── shipped ──────────────────────────────────────────────")
    print(f"  nodes                  {len(acc.nodes)}")
    print(f"  lineage edges          {len(acc.edges)}")
    print(f"  containmentEdges       {len(acc.containment)}")
    print(f"  lineage participants   {len(participants)}  "
          f"(upstream {len(acc.upstream)}, downstream {len(acc.downstream)})")
    print(f"  truncationReason       {acc.truncation_reasons or [None]}")
    print(f"  frontier up/down       {len(acc.frontier_up)}/{len(acc.frontier_down)} on the first page"
          f"   ({acc.frontier_entries_seen} entries across all pages)")
    print(f"  seedTruncated          {acc.seed_truncated}  seedCursor={acc.seed_cursor}")

    print()
    print("  ── containment coverage (F18) ───────────────────────────")
    print(f"  participants with a containment parent shipped: "
          f"{len(covered)}/{len(participants)} = {pct:.1f}%")
    if uncovered:
        print(f"  participants with NO parent shipped:  {len(uncovered)}")
        for u in uncovered[:5]:
            print(f"      {u}")
        if len(uncovered) > 5:
            print(f"      ... and {len(uncovered) - 5} more")

    if uncovered and verify_parents:
        # Ask the graph whether the uncovered ones really are top-level. Any
        # that DOES have a parent is containment the closure failed to ship.
        sample = uncovered[:verify_parents]
        really_rootless, actually_has_parent, errors = 0, [], 0
        for u in sample:
            try:
                anc = api.get(
                    f"/api/v1/{ws}/graph/nodes/{requests.utils.quote(u, safe='')}"
                    f"/ancestors?limit=1&dataSourceId={ds}"
                    + (f"&viewId={view}" if view else "")
                )
            except Exception:
                errors += 1
                continue
            if anc:
                actually_has_parent.append((u, anc[0].get("urn")))
            else:
                really_rootless += 1
        print(f"  verified {len(sample)} uncovered against the graph: "
              f"{really_rootless} genuinely top-level, "
              f"{len(actually_has_parent)} HAVE a parent (missing containment), "
              f"{errors} lookup error(s)")
        for u, p in actually_has_parent[:5]:
            print(f"      MISSING: {u}  <-  {p}")

    print()
    print("  ── childCount (F20) ─────────────────────────────────────")
    with_children = [n for n in acc.nodes.values() if (n.get("childCount") or 0) > 0]
    null_count = [n for n in acc.nodes.values() if n.get("childCount") is None]
    print(f"  nodes with childCount > 0:   {len(with_children)}/{len(acc.nodes)}")
    print(f"  nodes with childCount null:  {len(null_count)}")

    # THE invariant: anything that parents a shipped containment edge must
    # report a chevron-worthy count. A violation here is a node the user
    # sees children under but cannot expand.
    violations = [
        u for u in parents_in_response
        if u in acc.nodes and (acc.nodes[u].get("childCount") or 0) <= 0
    ]
    print(f"  containment parents in response: {len(parents_in_response & set(acc.nodes))}")
    print(f"  ...of those with childCount <= 0: {len(violations)}  "
          f"{'<-- VIOLATION' if violations else '(none — invariant holds)'}")
    for u in violations[:5]:
        print(f"      {u}  childCount={acc.nodes[u].get('childCount')!r}")

    by_type: Dict[str, Counter] = defaultdict(Counter)
    for n in acc.nodes.values():
        t = n.get("entityType") or "?"
        by_type[t]["nodes"] += 1
        if (n.get("childCount") or 0) > 0:
            by_type[t]["withChildren"] += 1
        if n.get("childCount") is None:
            by_type[t]["null"] += 1
    print()
    print(f"  {'entityType':<28}{'nodes':>8}{'childCount>0':>14}{'null':>8}")
    for t in sorted(by_type, key=lambda k: -by_type[k]["nodes"]):
        c = by_type[t]
        marker = " *" if container_types and t.lower() in container_types else ""
        print(f"  {t:<28}{c['nodes']:>8}{c['withChildren']:>14}{c['null']:>8}{marker}")
    if container_types:
        ct_nodes = [n for n in acc.nodes.values()
                    if (n.get("entityType") or "").lower() in container_types]
        ct_with = [n for n in ct_nodes if (n.get("childCount") or 0) > 0]
        print(f"  * container-typed: {len(ct_with)}/{len(ct_nodes)} report childCount > 0")

    print()
    print("  ── cost ─────────────────────────────────────────────────")
    print(f"  closure requests       {len(acc.page_times)}")
    print(f"  first page             {acc.page_times[0] * 1000:.0f} ms")
    print(f"  closure wall time      {sum(acc.page_times) * 1000:.0f} ms")
    print(f"  total HTTP requests    {api.requests_made} "
          f"({api.total_request_secs * 1000:.0f} ms in-flight, resolution included)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=os.getenv("PROBE_BASE_URL", "http://localhost:8000"))
    ap.add_argument("--env-file", default=ENV_FILE)
    ap.add_argument("--list", action="store_true", help="list workspaces/data sources and exit")
    ap.add_argument("--source", help="data source label or id")
    ap.add_argument("--workspace", help="workspace id or name (disambiguates --source)")
    ap.add_argument("--view", help="view id (default: first view over the source, or none)")
    ap.add_argument("--no-view", action="store_true", help="do not send viewId")
    ap.add_argument("--urn", help="focus urn")
    ap.add_argument("--depth", type=int, default=25)
    ap.add_argument("--max-nodes", type=int, default=None)
    ap.add_argument("--pages", type=int, default=1,
                    help="max closure requests including the first (frontier following)")
    ap.add_argument("--container-types", default="",
                    help="comma-separated entity types to summarise as containers")
    ap.add_argument("--verify-parents", type=int, default=0,
                    help="ask the graph whether N uncovered participants really are top-level")
    ap.add_argument("--grain", choices=("coarse", "fine"), default=None,
                    help="'coarse' probes the LAZY first paint instead of the eager walk")
    ap.add_argument("--drill", action="append", default=[],
                    help="after the first paint, drill this card (repeatable, in order)")
    ap.add_argument("--journey", action="store_true",
                    help="coarse -> drill the biggest partner -> drill inside it, timed")
    ap.add_argument("--walk", type=int, default=0, metavar="MAX_REQUESTS",
                    help="after the coarse paint, run the driver's BACKGROUND walk to "
                         "exhaustion (or this many requests) and report what it reached")
    args = ap.parse_args()

    email, password = _read_credentials(args.env_file)
    api = Api(args.base)
    who = api.login(email, password)
    print(f"signed in ({who})  ->  {args.base}")

    if args.list:
        print(f"\n{'workspace':<26}{'dataSourceId':<24}{'label':<34}graph")
        for c in list_sources(api):
            print(f"{(c['workspaceName'] or c['workspaceId'])[:24]:<26}"
                  f"{c['dataSourceId']:<24}{c['label'][:32]:<34}{c['graphName']}")
        return

    if not args.source or not args.urn:
        sys.exit("--source and --urn are required (or use --list)")

    src = resolve_source(api, args.source, args.workspace)
    view = None if args.no_view else (args.view or resolve_view(api, src["workspaceId"], src["dataSourceId"]))
    print(f"source  {src['label']!r}  id={src['dataSourceId']}  graph={src['graphName']}")
    print(f"        workspace={src['workspaceId']}  view={view}")
    print(f"focus   {args.urn}")
    print(f"walk    direction=both depth={args.depth} maxNodes={args.max_nodes} pages={args.pages}")
    print()

    started = time.perf_counter()
    if args.grain == "coarse" or args.drill or args.journey or args.walk:
        path = f"/api/v1/{src['workspaceId']}/graph/trace/closure?dataSourceId={src['dataSourceId']}"
        if view:
            path += f"&viewId={view}"
        acc, coarse_ms, coarse_reqs = run_lazy(
            api, path, args.urn, args.max_nodes, args.pages, drill=False, label="coarse",
        )
        timings = [("coarse", coarse_ms * 1000, coarse_reqs)]

        if args.walk:
            acc.live_frontier = True
            walk_reqs, walk_secs = run_full_walk(api, path, args.urn, acc, args.walk)
            timings.append(("background walk to exhaustion", walk_secs * 1000, walk_reqs))

        cards = list(args.drill)
        if args.journey and not cards:
            # The biggest partner first (most children = most to reveal),
            # then the biggest thing INSIDE it — the journey a reader takes.
            def _kids(u):
                return acc.nodes.get(u, {}).get("childCount") or 0
            partners = sorted((acc.upstream | acc.downstream), key=_kids, reverse=True)
            cards = partners[:1]

        drilled: List[str] = []
        while cards:
            card = cards.pop(0)
            sub, ms, reqs = run_lazy(
                api, path, card, args.max_nodes, args.pages, drill=True,
                label=f"drill{len(drilled) + 1}",
            )
            acc.merge_all(sub)
            drilled.append(card)
            timings.append((f"drill {card[-28:]}", ms * 1000, reqs))
            if args.journey and len(drilled) < 3:
                inside = sorted(
                    (u for u, e in sub.containment.items()
                     if e["sourceUrn"] == card for u in [e["targetUrn"]]),
                    key=lambda u: sub.nodes.get(u, {}).get("childCount") or 0, reverse=True,
                )
                inside = [u for u in inside if u not in drilled]
                if inside:
                    cards.append(inside[0])

        print()
        for name, ms, reqs in timings:
            print(f"  {name:<40} {ms:8.0f} ms   {reqs} request(s)")
        print()
    else:
        acc = run_walk(api, src["workspaceId"], src["dataSourceId"], view,
                       args.urn, args.depth, args.max_nodes, args.pages)
    container_types = [t.strip().lower() for t in args.container_types.split(",") if t.strip()]
    report(api, acc, args.urn, src["workspaceId"], src["dataSourceId"], view,
           container_types, args.verify_parents)
    print(f"  end-to-end             {(time.perf_counter() - started) * 1000:.0f} ms")


if __name__ == "__main__":
    main()
