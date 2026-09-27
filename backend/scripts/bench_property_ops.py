#!/usr/bin/env python3
"""Measure bulk property operations end to end on a large graph — what the draft cap is set from.

Drives a running API and versioning worker (``GRAPHVER_TRANSFER_INPROCESS=0``) the way the Property
Manager does, on a view of a graph seeded by ``seed_search_bench`` (1M nodes), and prints one JSON
line per step:

* ``apply``   — a new draft; ``set <key> = <tag>`` on every entity whose ``score`` is in
                ``--score`` (about 99.8k on bench_1m): its phase timings and, with
                ``--worker-pid``, the worker's peak RSS.
* ``refuse``  — another draft; a search matching more than a draft may hold (``sourceId > 50000``,
                about 500k): how fast it is refused, and that the draft holds nothing.
* ``undo``    — the apply undone: every entity it changed put back.
* ``publish`` — the operation applied again, the draft published and projected: Advanced Search on
                the published graph then counts exactly the entities it changed.

Run::

    python -m backend.scripts.bench_property_ops --base-url http://localhost:8000 \\
        --email admin@example.com --password … --workspace ws_… --data-source ds_… \\
        --view view_… [--worker-pid 1234]

The key is new on every run (``--key``, a tag value per run), so the publish step's count is exact
whatever earlier runs published. Peak RSS is read from ``/proc/<pid>/status`` (``VmHWM``, reset
before each step), so ``--worker-pid`` needs the worker on this machine.
"""
from __future__ import annotations

import argparse
import json
import time
from typing import Any, Dict, Optional, Tuple

import httpx

_LIVE = ("pending", "running")


class Bench:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.ws, self.ds, self.view = args.workspace, args.data_source, args.view
        self.c = httpx.Client(base_url=args.base_url, timeout=300.0)
        r = self.c.post("/api/v1/auth/login", json={"email": args.email, "password": args.password})
        r.raise_for_status()
        self.c.cookies = dict(r.cookies.items())
        self.c.headers["X-CSRF-Token"] = self.c.cookies.get("nx_csrf") or ""
        resolved = self._ok(self.c.get(f"/api/v1/{self.ws}/versioning/resolve",
                                       params={"dataSourceId": self.ds}))
        self.graph = resolved["graphId"]
        self.base = f"/api/v1/{self.ws}/versioning/graphs/{self.graph}"

    @staticmethod
    def _ok(r: httpx.Response) -> Any:
        if r.status_code >= 400:
            raise RuntimeError(f"{r.request.method} {r.request.url.path} → {r.status_code}: {r.text[:300]}")
        return r.json()

    # ── the worker's memory ───────────────────────────────────────────
    def _reset_peak(self) -> None:
        if self.args.worker_pid:
            with open(f"/proc/{self.args.worker_pid}/clear_refs", "w") as f:
                f.write("5")

    def _peak_mb(self) -> Optional[int]:
        if not self.args.worker_pid:
            return None
        with open(f"/proc/{self.args.worker_pid}/status") as f:
            fields = dict(line.split(":", 1) for line in f if ":" in line)
        return int(fields["VmHWM"].split()[0]) // 1024

    # ── drafts and operations ────────────────────────────────────────
    def draft(self, name: str) -> str:
        return self._ok(self.c.post(f"{self.base}/branches",
                                    json={"name": name, "originatingViewId": self.view}))["branchId"]

    def run(self, branch: str, predicate: Dict[str, Any], op: Dict[str, Any]) -> Tuple[Dict[str, Any], float]:
        """Start an operation and follow it to its end: the finished job, and the seconds it took."""
        started = time.monotonic()
        job = self._ok(self.c.post(f"{self.base}/branches/{branch}/property-ops",
                                   json={"viewId": self.view, "predicate": predicate, "op": op}))
        return self._follow(branch, job["jobId"], started)

    def undo(self, branch: str, job_id: str) -> Tuple[Dict[str, Any], float]:
        started = time.monotonic()
        job = self._ok(self.c.post(f"{self.base}/branches/{branch}/property-ops/{job_id}/undo"))
        return self._follow(branch, job["jobId"], started)

    def _follow(self, branch: str, job_id: str, started: float) -> Tuple[Dict[str, Any], float]:
        while True:
            job = self._ok(self.c.get(f"{self.base}/branches/{branch}/property-ops/{job_id}"))
            if job["status"] not in _LIVE:
                return job, round(time.monotonic() - started, 1)
            if time.monotonic() - started > self.args.timeout:
                raise RuntimeError(f"{job_id} still {job['status']} ({job['phase']}) after {self.args.timeout}s")
            time.sleep(1)

    def draft_changes(self, branch: str) -> int:
        return self._ok(self.c.get(f"{self.base}/branches/{branch}/property-ops"))["draftChanges"]

    def publish(self, branch: str) -> Dict[str, Any]:
        started = time.monotonic()
        r = self.c.post(f"{self.base}/branches/{branch}/publish", json={"message": "bench_property_ops"})
        body = self._ok(r)
        if r.status_code == 202:
            while body.get("status") in (None, *_LIVE):
                time.sleep(2)
                body = self._ok(self.c.get(f"{self.base}/publish-jobs/{body['jobId']}"))
            if body["status"] != "completed":
                raise RuntimeError(f"publish failed: {body.get('error')}")
        published = round(time.monotonic() - started, 1)
        while not self._ok(self.c.get(f"{self.base}/watermark")).get("fresh"):
            if time.monotonic() - started > self.args.timeout:
                raise RuntimeError(f"the published graph wasn't fresh after {self.args.timeout}s")
            time.sleep(2)
        return {"publishS": published, "projectedS": round(time.monotonic() - started - published, 1)}

    def count(self, predicate: Dict[str, Any]) -> Tuple[int, float]:
        """Advanced Search's exact count of ``predicate`` in the view, on the published graph."""
        started, sessions = time.monotonic(), {}
        while True:
            answer = self._ok(self.c.post(
                f"/api/v1/{self.ws}/graph/search/counts", params={"dataSourceId": self.ds},
                json={"scope": {"viewId": self.view, "scopeMode": "view"},
                      "items": [{"id": "n", "predicate": predicate}], "waitMs": 10000,
                      "sessions": sessions}))["counts"]["n"]
            if answer.get("error"):
                raise RuntimeError(f"count failed: {answer['error']}")
            if answer["status"] == "complete":
                return answer["count"], round(time.monotonic() - started, 1)
            sessions = {"n": answer["sessionId"]}


def _row(step: str, job: Dict[str, Any], seconds: float, **extra: Any) -> Dict[str, Any]:
    summary = job.get("summary") or {}
    return {"step": step, "status": job["status"], "error": job.get("error"), "wallS": seconds,
            "timingsMs": summary.get("timings"),
            **{k: v for k, v in summary.items() if k not in ("timings", "commits")},
            "commits": len(summary.get("commits") or []), **extra}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--email", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--data-source", required=True)
    p.add_argument("--view", required=True, help="a view of the whole source")
    p.add_argument("--worker-pid", type=int, help="the versioning worker's pid, for its peak RSS")
    p.add_argument("--score", default="0.2,0.3", help="the score range the apply step matches")
    p.add_argument("--key", default=f"benchRun{int(time.time())}", help="the property the steps set")
    p.add_argument("--timeout", type=float, default=1800.0, help="seconds any one step may take")
    args = p.parse_args()

    bench = Bench(args)
    lo, hi = (float(x) for x in args.score.split(","))
    tag = f"run-{int(time.time())}"
    by_score = {"kind": "property", "key": "score", "op": "between", "value": [lo, hi], "valueType": "number"}
    op = {"kind": "set", "key": args.key, "value": tag, "valueType": "string"}
    print(json.dumps({"graph": bench.graph, "key": args.key, "value": tag}), flush=True)

    draft = bench.draft(f"bench property ops {tag}")
    bench._reset_peak()
    applied, seconds = bench.run(draft, by_score, op)
    print(json.dumps(_row("apply", applied, seconds, workerPeakMb=bench._peak_mb(),
                          draftChanges=bench.draft_changes(draft))), flush=True)

    broad = bench.draft(f"bench property ops {tag} (too broad)")
    refused, seconds = bench.run(broad, {"kind": "property", "key": "sourceId", "op": "gt",
                                         "value": "50000", "valueType": "number"}, op)
    print(json.dumps(_row("refuse", refused, seconds, draftChanges=bench.draft_changes(broad))), flush=True)
    bench._ok(bench.c.post(f"{bench.base}/branches/{broad}/abandon"))

    bench._reset_peak()
    undone, seconds = bench.undo(draft, applied["jobId"])
    print(json.dumps(_row("undo", undone, seconds, workerPeakMb=bench._peak_mb(),
                          restoredAll=(undone.get("summary") or {}).get("restored")
                          == (applied.get("summary") or {}).get("applied"))), flush=True)

    again, seconds = bench.run(draft, by_score, op)
    published = bench.publish(draft)
    found, counted = bench.count({"kind": "property", "key": args.key, "op": "eq", "value": tag,
                                  "valueType": "string"})
    changed = (again.get("summary") or {}).get("applied")
    print(json.dumps(_row("publish", again, seconds, **published, searchCount=found, searchS=counted,
                          searchFindsAll=found == changed)), flush=True)


if __name__ == "__main__":
    main()
