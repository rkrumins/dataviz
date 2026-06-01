#!/usr/bin/env python3
"""End-to-end smoke test for the versioned-graph API — run against a LIVE viz-service.

Logs in as the seeded admin (cookie session + CSRF), then drives the whole MVP
flow over HTTP — the browser never touches Postgres directly:

    create graph -> open draft -> stage -> checkpoint -> read state
                 -> publish to main -> history + diff
                 -> fork (copy-on-write) -> diverge on the fork
                 -> open PR -> preview -> merge into base -> verify

Every call is plain HTTP, so this doubles as living documentation of the API and
as the manual E2E you can run on your end.

Usage
-----
    pip install httpx
    # bring the stack up first (docker compose up --build), then:
    python scripts/versioning_smoke.py \
        --base http://localhost:8000 \
        --email admin@synodic.local --password admin123 \
        [--workspace <ws_id>]

If --workspace is omitted the script uses the first workspace from
GET /api/v1/admin/workspaces, falling back to a synthetic id — the admin's
``system:admin`` lets it operate in any workspace, and the versioning store
treats ``workspace_id`` as a logical reference.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import sys
import uuid

import httpx

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


class _LocalhostCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Dev convenience: return ``Secure`` cookies even over http://localhost so the
    smoke works against a plain-http dev stack. Affects only this script."""

    def return_ok_secure(self, cookie, request):  # noqa: D102
        return True


class Smoke:
    def __init__(self, base: str, ws: str, client: httpx.Client):
        self.v = f"{base}/api/v1/{ws}/versioning"
        self.c = client
        self.n = 0

    def _csrf(self) -> dict:
        token = self.c.cookies.get("nx_csrf")
        return {"X-CSRF-Token": token} if token else {}

    def post(self, path: str, body: dict) -> dict:
        r = self.c.post(f"{self.v}{path}", json=body, headers=self._csrf())
        r.raise_for_status()
        return r.json()

    def get(self, path: str, **params) -> dict:
        r = self.c.get(f"{self.v}{path}", params=params or None)
        r.raise_for_status()
        return r.json()

    def ok(self, msg: str) -> None:
        self.n += 1
        print(f"  {GREEN}✓{RESET} {msg}")

    def check(self, cond: bool, msg: str) -> None:
        if not cond:
            raise AssertionError(msg)
        self.ok(msg)


def login(client: httpx.Client, base: str, email: str, password: str) -> None:
    r = client.post(f"{base}/api/v1/auth/login", json={"email": email, "password": password})
    if r.status_code != 200:
        raise SystemExit(f"login failed ({r.status_code}): {r.text[:300]}")
    if not client.cookies.get("nx_access"):
        raise SystemExit("login returned 200 but no nx_access cookie was set")


def pick_workspace(client: httpx.Client, base: str, override: str | None) -> str:
    if override:
        return override
    try:
        r = client.get(f"{base}/api/v1/admin/workspaces")
        if r.status_code == 200 and isinstance(r.json(), list) and r.json():
            return r.json()[0]["id"]
    except Exception:
        pass
    return "ws_smoke_" + uuid.uuid4().hex[:8]


def run(base: str, email: str, password: str, workspace: str | None) -> int:
    jar = http.cookiejar.CookieJar(policy=_LocalhostCookiePolicy())
    with httpx.Client(timeout=30.0, follow_redirects=True, cookies=httpx.Cookies(jar)) as client:
        login(client, base, email, password)
        ws = pick_workspace(client, base, workspace)
        s = Smoke(base, ws, client)
        print(f"{DIM}→ viz-service {base}  workspace={ws}{RESET}")

        # 1. graph + draft
        ds = "ds_smoke_" + uuid.uuid4().hex[:8]
        gid = s.post("/graphs", {"dataSourceId": ds, "workspaceId": ws})["graphId"]
        s.ok(f"created graph {gid}")
        bid = s.post(f"/graphs/{gid}/branches", {"originatingViewId": "smoke"})["branchId"]
        s.ok(f"opened draft {bid}")

        # 2. stage + checkpoint + read
        s.post(f"/graphs/{gid}/branches/{bid}/changes", {"ops": [
            {"op": "create", "entityKind": "node", "entityId": "A", "payload": {"displayName": "Alpha"}},
            {"op": "create", "entityKind": "node", "entityId": "B", "payload": {"displayName": "Beta"}},
            {"op": "create", "entityKind": "edge", "entityId": "E1",
             "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
        ]})
        s.ok("staged 3 changes")
        s.post(f"/graphs/{gid}/branches/{bid}/commit", {"message": "seed"})
        s.ok("checkpointed draft")
        st = s.get(f"/graphs/{gid}/branches/{bid}/state")
        s.check(set(st["nodes"]) == {"A", "B"} and set(st["edges"]) == {"E1"}, "draft state is A,B,E1")

        # 3. publish + audit
        s.post(f"/graphs/{gid}/branches/{bid}/publish", {"message": "publish v1"})
        s.ok("published draft -> main")
        mid = next(b["branchId"] for b in s.get(f"/graphs/{gid}/branches") if b["kind"] == "main")
        ms = s.get(f"/graphs/{gid}/branches/{mid}/state")
        s.check(set(ms["nodes"]) == {"A", "B"} and set(ms["edges"]) == {"E1"}, "main state is A,B,E1")
        hist = s.get(f"/graphs/{gid}/entities/A/history")
        s.check(bool(hist["versions"]), f"entity A history has {len(hist['versions'])} version(s)")
        diff = s.get(f"/graphs/{gid}/branches/{mid}/diff", fromSeq=1, toSeq=2)
        s.check(set(diff["added"]) == {"A", "B", "E1"}, "diff main 1->2 added A,B,E1")

        # 4. fork (copy-on-write) + diverge
        fgid = s.post(f"/graphs/{gid}/forks", {})["graphId"]
        s.ok(f"forked -> {fgid} (copy-on-write, no rows copied)")
        fbid = s.post(f"/graphs/{fgid}/branches", {})["branchId"]
        s.post(f"/graphs/{fgid}/branches/{fbid}/changes", {"ops": [
            {"op": "update", "entityKind": "node", "entityId": "A", "payload": {"displayName": "Alpha (forked)"}},
            {"op": "create", "entityKind": "node", "entityId": "C", "payload": {"displayName": "Gamma"}},
        ]})
        s.post(f"/graphs/{fgid}/branches/{fbid}/commit", {"message": "fork work"})
        s.post(f"/graphs/{fgid}/branches/{fbid}/publish", {"message": "fork v1"})
        s.ok("fork diverged (edited A, added C)")

        # 5. PR -> preview -> merge -> verify
        pr = s.post(f"/graphs/{fgid}/pulls", {})["prId"]
        s.ok(f"opened PR {pr}")
        prev = s.get(f"/pulls/{pr}/preview")
        s.check(prev["clean"] is True, f"PR preview clean (changes={prev['changes']})")
        s.post(f"/pulls/{pr}/merge", {"message": "merge fork PR"})
        s.ok("merged PR into base main")
        final = s.get(f"/graphs/{gid}/branches/{mid}/state")
        s.check(final["nodes"]["A"]["displayName"] == "Alpha (forked)" and "C" in final["nodes"],
                "base reflects merged fork changes (A edited, C added)")

        print(f"\n{GREEN}PASS{RESET} — {s.n} steps over HTTP. The frontend↔Postgres path is API-only, end to end.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="E2E smoke for the versioned-graph API")
    ap.add_argument("--base", default="http://localhost:8000", help="viz-service base URL")
    ap.add_argument("--email", default="admin@synodic.local")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--workspace", default=None, help="workspace id (default: discover or synthesize)")
    args = ap.parse_args()
    try:
        return run(args.base, args.email, args.password, args.workspace)
    except httpx.HTTPStatusError as exc:
        print(f"\n{RED}FAIL{RESET} {exc.request.method} {exc.request.url} -> "
              f"{exc.response.status_code}\n{exc.response.text[:600]}", file=sys.stderr)
        return 1
    except AssertionError as exc:
        print(f"\n{RED}FAIL{RESET} assertion: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
