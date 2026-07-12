#!/usr/bin/env python3
"""End-to-end smoke test for the versioned-graph API — run against a LIVE viz-service.

Logs in as the seeded admin (cookie session + CSRF), then drives the whole flow
over HTTP — the browser never touches Postgres directly:

    create graph -> open draft -> stage -> checkpoint -> read state
                 -> publish to main -> history + diff
                 -> fork (copy-on-write) -> diverge on the fork
                 -> open PR -> preview -> merge into base -> verify
                 -> REVERT the merged PR -> RESTORE to an earlier revision
                 -> the admin versioningEnabled flag (writes 403, reads keep working)
                 -> [--enable-data-source] "enable version control" on a REAL data
                    source: 202 + job, live phases, then its integrity report

Every call is plain HTTP, so this doubles as living documentation of the API and
as the manual E2E you can run on your end.

Usage
-----
    pip install httpx
    # bring the stack up first (docker compose up --build), then:
    python scripts/versioning_smoke.py \
        --base http://localhost:8000 \
        --email admin@synodic.local --password admin123 \
        [--workspace <ws_id>] \
        [--enable-data-source ds_xxx]   # needs a versioning worker running

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


def run(base: str, email: str, password: str, workspace: str | None,
        enable_ds: str | None = None, bootstrap_timeout: int = 900) -> int:
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
        merge_commit = s.post(f"/pulls/{pr}/merge", {"message": "merge fork PR"})["commitId"]
        s.ok("merged PR into base main")
        final = s.get(f"/graphs/{gid}/branches/{mid}/state")
        s.check(final["nodes"]["A"]["displayName"] == "Alpha (forked)" and "C" in final["nodes"],
                "base reflects merged fork changes (A edited, C added)")

        # 6. ROLLBACK — undo the merged PR, then restore the graph to a point in time.
        #    Both write a NEW commit; history is never rewritten.
        s.post(f"/graphs/{gid}/commits/{merge_commit}/revert", {"message": "revert the merge"})
        s.ok("reverted the merged PR (a new `revert` revision)")
        reverted = s.get(f"/graphs/{gid}/branches/{mid}/state")
        s.check(reverted["nodes"]["A"]["displayName"] == "Alpha" and "C" not in reverted["nodes"],
                "main is back to its pre-merge state (A restored, C gone)")

        # A restore is a point-in-time RESET of main, not just an undo: it puts the graph
        # back exactly as it was at the chosen revision — including undoing the revert we
        # just made. (A no-op restore writes nothing, so we restore to a state that differs.)
        pv = s.get(f"/graphs/{gid}/commits/{merge_commit}/restore-preview")
        s.check(pv["commitsUndone"] >= 1,
                f"restore preview: rolls back {pv['commitsUndone']} revision(s), "
                f"{pv['nodes']} nodes / {pv['edges']} edges")
        s.post(f"/graphs/{gid}/commits/{merge_commit}/restore", {"message": "restore to the merge"})
        s.ok("restored the graph to the merged revision (the revert itself is rolled back)")
        restored = s.get(f"/graphs/{gid}/branches/{mid}/state")
        s.check(restored["nodes"]["A"]["displayName"] == "Alpha (forked)" and "C" in restored["nodes"],
                "main is exactly the merged state again")

        # ...and back to the first publish. A restore NEVER conflicts, which is what makes it
        # the escape hatch when a revert is blocked.
        log = s.get(f"/graphs/{gid}/commits")
        commits = log["commits"] if isinstance(log, dict) else log
        first_publish = next(c for c in reversed(commits) if c["kind"] == "squash_publish")
        s.post(f"/graphs/{gid}/commits/{first_publish['commit_id']}/restore", {})
        s.ok("restored the graph to its first published revision")
        restored = s.get(f"/graphs/{gid}/branches/{mid}/state")
        s.check(set(restored["nodes"]) == {"A", "B"} and restored["nodes"]["A"]["displayName"] == "Alpha",
                "main is exactly the first published state")

        kinds = [c["kind"] for c in (s.get(f"/graphs/{gid}/commits")["commits"])]
        s.check(kinds.count("restore") == 2 and "revert" in kinds,
                f"every step is kept in history (oldest→newest: {', '.join(reversed(kinds))})")

        # 7. the admin flag, and (optionally) enabling version control on a REAL
        #    data source — the async, integrity-checked copy.
        run_flag(base, client, ws)
        if enable_ds:
            run_bootstrap(base, client, ws, enable_ds, bootstrap_timeout)

        print(f"\n{GREEN}PASS{RESET} — every step over HTTP. The frontend↔Postgres path is API-only, end to end.")
        return 0


def run_flag(base: str, client: httpx.Client, ws: str) -> None:
    """The admin `versioningEnabled` flag: writes are refused, reads keep working."""
    print(f"\n{DIM}→ admin feature flag{RESET}")
    s = Smoke(base, ws, client)
    values = client.get(f"{base}/api/v1/features/values").json()["values"]
    s.check("versioningEnabled" in values, "public /features/values serves the flag (no auth needed)")

    def set_flag(on: bool) -> None:
        cur = client.get(f"{base}/api/v1/admin/features").json()
        r = client.patch(f"{base}/api/v1/admin/features",
                         json={"version": cur["version"], "versioningEnabled": on},
                         headers={"X-CSRF-Token": client.cookies.get("nx_csrf") or ""})
        r.raise_for_status()

    set_flag(False)
    try:
        r = client.post(f"{base}/api/v1/{ws}/versioning/resolve", json={"dataSourceId": "ds_flag_probe"},
                        headers={"X-CSRF-Token": client.cookies.get("nx_csrf") or ""})
        s.check(r.status_code == 403 and r.json()["detail"]["type"] == "feature_disabled",
                "flag OFF → a versioning WRITE is refused (403 feature_disabled)")
        r = client.get(f"{base}/api/v1/{ws}/versioning/resolve", params={"dataSourceId": "ds_flag_probe"})
        s.check(r.status_code != 403, "flag OFF → READS still work (existing graphs stay viewable)")
    finally:
        set_flag(True)
    s.ok("flag restored to ON")


def run_bootstrap(base: str, client: httpx.Client, ws: str, ds: str, timeout_s: int) -> None:
    """"Enable version control" as an async, resumable, integrity-checked job."""
    import time
    print(f"\n{DIM}→ enable version control on {ds}{RESET}")
    s = Smoke(base, ws, client)
    hdr = {"X-CSRF-Token": client.cookies.get("nx_csrf") or ""}
    r = client.post(f"{base}/api/v1/{ws}/graph/bootstrap", params={"dataSourceId": ds}, headers=hdr)
    r.raise_for_status()
    body = r.json()
    if body.get("alreadyEnabled"):
        s.ok("already versioned — nothing to do (idempotent)")
        return
    s.check(r.status_code == 202 and body["jobId"],
            f"202 + job {body['jobId']} (the request never blocks on the copy)")

    deadline = time.time() + timeout_s
    job, last = None, None
    while time.time() < deadline:
        job = client.get(f"{base}/api/v1/{ws}/graph/bootstrap/status", params={"dataSourceId": ds}).json()
        if job["status"] in ("completed", "failed"):
            break
        cur = (job["phase"], job["percent"])
        if cur != last:
            print(f"    {DIM}{job['phase']:<9} {job['percent']:>3}%  "
                  f"{job['processed']:,}/{job['total']:,}{RESET}")
            last = cur
        time.sleep(2)
    if not job or job["status"] != "completed":
        raise AssertionError(f"bootstrap did not complete: {job}")

    rep = job["report"]
    s.check(all(c["ok"] for c in rep["checks"]), f"all {len(rep['checks'])} integrity checks passed")
    s.check(rep["stored"]["nodes"] == rep["source"]["nodes"],
            f"every item copied ({rep['stored']['nodes']:,} of {rep['source']['nodes']:,})")
    s.check(len(rep["edgeTypes"]) > 0 or rep["source"]["edges"] == 0,
            f"{len(rep['edgeTypes'])} relationship type(s) preserved (containment + lineage)")
    s.check(rep["sampleChecked"] > 0 and not rep["sampleMismatched"],
            f"{rep['sampleChecked']} random items re-read from the source match exactly")


def main() -> int:
    ap = argparse.ArgumentParser(description="E2E smoke for the versioned-graph API")
    ap.add_argument("--base", default="http://localhost:8000", help="viz-service base URL")
    ap.add_argument("--email", default="admin@synodic.local")
    ap.add_argument("--password", default="admin123")
    ap.add_argument("--workspace", default=None, help="workspace id (default: discover or synthesize)")
    ap.add_argument("--enable-data-source", default=None, metavar="DS_ID",
                    help="also run 'enable version control' on this REAL data source and "
                         "assert its integrity report (needs a versioning worker running)")
    ap.add_argument("--bootstrap-timeout", type=int, default=900,
                    help="seconds to wait for the copy (default 900; a 10M-entity graph "
                         "takes minutes)")
    args = ap.parse_args()
    try:
        return run(args.base, args.email, args.password, args.workspace,
                   args.enable_data_source, args.bootstrap_timeout)
    except httpx.HTTPStatusError as exc:
        print(f"\n{RED}FAIL{RESET} {exc.request.method} {exc.request.url} -> "
              f"{exc.response.status_code}\n{exc.response.text[:600]}", file=sys.stderr)
        return 1
    except AssertionError as exc:
        print(f"\n{RED}FAIL{RESET} assertion: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
