#!/usr/bin/env python3
"""E2E smoke for the COHESIVE draft journey — run against a LIVE full stack (viz-service).

Unlike ``versioning_smoke.py`` (which edits a draft via the versioning router's
stage/checkpoint ops API), this drives the journey the frontend will use: the normal
``/graph`` endpoints gated by ``?branchId=``. It is living documentation of the
"create → import → edit-on-a-draft → publish" path:

    login -> create provider+workspace+data source
          -> create versioned graph -> IMPORT (ndjson bulk-ingest)
          -> open draft -> edit via POST /graph/nodes/create?branchId=… , /edges , /save
          -> read-your-writes via /graph/nodes/query?branchId=…
          -> isolation: main read (no branchId) does NOT show the draft edit
          -> publish draft -> main -> verify on main (versioning /state)

Usage
-----
    pip install httpx
    ./dev.sh up            # bring the full stack up first
    python scripts/draft_journey_smoke.py \
        --base http://localhost:8000 \
        --email admin@nexuslineage.local --password admin123 \
        [--falkor-host localhost --falkor-port 6379]
"""
from __future__ import annotations

import argparse
import http.cookiejar
import sys
import uuid

import httpx

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


class _LocalhostCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Dev convenience: accept ``Secure`` cookies over http://localhost."""
    def return_ok_secure(self, cookie, request):  # noqa: D102
        return True


class Client:
    def __init__(self, base: str, client: httpx.Client):
        self.base = base.rstrip("/")
        self.c = client
        self.n = 0

    def _csrf(self) -> dict:
        token = self.c.cookies.get("nx_csrf")
        return {"X-CSRF-Token": token} if token else {}

    def post(self, path: str, body=None, *, params=None, content=None) -> httpx.Response:
        return self.c.post(f"{self.base}{path}", json=body, params=params,
                           content=content, headers=self._csrf())

    def get(self, path: str, **params) -> httpx.Response:
        return self.c.get(f"{self.base}{path}", params=params or None)

    def ok(self, msg: str) -> None:
        self.n += 1
        print(f"  {GREEN}✓{RESET} {msg}")

    def check(self, cond: bool, msg: str) -> None:
        if not cond:
            raise AssertionError(msg)
        self.ok(msg)


def _json(r: httpx.Response) -> dict:
    r.raise_for_status()
    return r.json()


def run(base: str, email: str, password: str, fhost: str, fport: int) -> int:
    jar = http.cookiejar.CookieJar(policy=_LocalhostCookiePolicy())
    with httpx.Client(timeout=60.0, follow_redirects=True, cookies=httpx.Cookies(jar)) as raw:
        r = raw.post(f"{base}/api/v1/auth/login", json={"email": email, "password": password})
        if r.status_code != 200:
            raise SystemExit(f"login failed ({r.status_code}): {r.text[:300]}")
        s = Client(base, raw)
        print(f"{DIM}→ viz-service {base}{RESET}")

        # 1. infrastructure: a provider, an ontology, and a workspace whose
        # data source is ONBOARDED with that ontology. The ontology is
        # required for the main-path /graph read (step 6): the resolution
        # gate refuses un-onboarded data sources — there is no system-default
        # fallback — so without it the live provider's get_nodes() raises
        # ProviderConfigurationError. Resolved containment is derived from the
        # relationship defs' isContainment flag (not the flat list field), and
        # "assigned" resolution requires entity/relationship definitions.
        sfx = uuid.uuid4().hex[:8]
        prov = _json(s.post("/api/v1/admin/providers", {
            "name": f"smoke-falkor-{sfx}", "providerType": "falkordb",
            "host": fhost, "port": fport}))
        s.ok(f"created provider {prov['id']}")
        ont = _json(s.post("/api/v1/admin/ontologies", {
            "name": f"smoke-ont-{sfx}", "scope": "workspace",
            "entityTypeDefinitions": {
                "Domain": {"name": "Domain", "hierarchy": {"level": 0, "canContain": ["Table"]}},
                "Table": {"name": "Table", "hierarchy": {"level": 1, "canBeContainedBy": ["Domain"]}},
            },
            "relationshipTypeDefinitions": {
                "CONTAINS": {"name": "Contains", "isContainment": True, "isLineage": False,
                             "sourceTypes": ["Domain"], "targetTypes": ["Table"]},
                "LINEAGE": {"name": "Lineage", "isContainment": False, "isLineage": True},
            }}))
        s.ok(f"created ontology {ont['id']}")
        ws = _json(s.post("/api/v1/admin/workspaces", {
            "name": f"smoke-ws-{sfx}",
            "dataSources": [{"providerId": prov["id"], "graphName": f"smoke_{sfx}",
                             "ontologyId": ont["id"]}]}))
        ws_id, ds = ws["id"], ws["dataSources"][0]["id"]
        s.ok(f"created workspace {ws_id} + data source {ds} (ontology assigned)")

        V, GP = f"/api/v1/{ws_id}/versioning", f"/api/v1/{ws_id}/graph"

        # 2. versioned graph + IMPORT an existing graph (ndjson)
        g = _json(s.post(f"{V}/graphs", {"dataSourceId": ds, "workspaceId": ws_id}))
        gid, main_id = g["graphId"], g["mainBranchId"]
        s.ok(f"created graph {gid}")
        ndjson = "\n".join([
            '{"kind":"node","id":"urn:t:root","urn":"urn:t:root","entityType":"Domain","displayName":"Imported Root"}',
            '{"kind":"node","id":"urn:t:child","urn":"urn:t:child","entityType":"Table","displayName":"Imported Child"}',
            '{"kind":"edge","id":"e_rc","edgeType":"CONTAINS","source":"urn:t:root","target":"urn:t:child"}',
        ])
        imp = _json(s.post(f"{V}/graphs/{gid}/bulk-ingest", content=ndjson))
        s.check(imp.get("ingested") == 3, f"imported existing graph (ingested={imp.get('ingested')})")

        # 3. open a draft
        draft = _json(s.post(f"{V}/graphs/{gid}/branches", {}))["branchId"]
        s.ok(f"opened draft {draft}")

        # 4. EDIT the draft through the normal graph endpoints (?branchId=)
        qd = {"dataSourceId": ds, "branchId": draft}
        node = _json(s.post(f"{GP}/nodes/create", {
            "entityType": "Table", "displayName": "Draft Node", "parentUrn": "urn:t:root"}, params=qd))
        new_urn = node["node"]["urn"]
        s.ok(f"created node on draft via /graph/nodes/create  -> {new_urn}")
        _json(s.post(f"{GP}/edges", {
            "sourceUrn": "urn:t:child", "targetUrn": new_urn, "edgeType": "LINEAGE"}, params=qd))
        s.ok("created edge on draft via /graph/edges")

        # 5. read-your-writes on the draft
        nodes = _json(s.post(f"{GP}/nodes/query", {"query": {}}, params=qd))
        urns = {n["urn"] for n in nodes}
        s.check({"urn:t:root", "urn:t:child", new_urn} <= urns, f"draft read shows import + edit ({sorted(urns)})")

        # 6. isolation: main (no branchId) does not show the draft edit yet
        main_urns = {n["urn"] for n in _json(s.post(f"{GP}/nodes/query", {"query": {}}, params={"dataSourceId": ds}))}
        s.check(new_urn not in main_urns, "main read (no branchId) does NOT show the draft node")

        # 7. publish draft -> main, then verify on main via the versioning state endpoint
        _json(s.post(f"{V}/graphs/{gid}/branches/{draft}/publish", {"message": "publish smoke draft"}))
        s.ok("published draft -> main")
        st = _json(s.get(f"{V}/graphs/{gid}/branches/{main_id}/state"))
        s.check({"urn:t:root", "urn:t:child", new_urn} <= set(st["nodes"]),
                "main state now carries the import + the published draft edit")

        print(f"\n{GREEN}PASS{RESET} — {s.n} steps over HTTP. The draft journey is the normal "
              f"/graph API + ?branchId=, end to end.\n{DIM}(main /graph reads reflect this once the "
              f"FalkorDB projection catches up; verified here via /versioning state.){RESET}")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="E2E smoke for the cohesive draft journey")
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--email", default="admin@nexuslineage.local")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--falkor-host", default="localhost")
    ap.add_argument("--falkor-port", type=int, default=6379)
    args = ap.parse_args()
    try:
        return run(args.base, args.email, args.password, args.falkor_host, args.falkor_port)
    except httpx.HTTPStatusError as exc:
        print(f"\n{RED}FAIL{RESET} {exc.request.method} {exc.request.url} -> "
              f"{exc.response.status_code}\n{exc.response.text[:600]}", file=sys.stderr)
        return 1
    except AssertionError as exc:
        print(f"\n{RED}FAIL{RESET} assertion: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
