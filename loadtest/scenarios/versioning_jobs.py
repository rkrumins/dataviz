"""Locust tasks for version-controlled transfer jobs (plan P0.4): the polling that follows them.

Every open import/export dialog, "Enable version control" panel and package upload polls its job
while the versioning worker's transfer and bootstrap lanes work through them. At a few hundred
users that polling, and the small jobs people start meanwhile, IS the web tier's load during a
large import — and it must stay fast while the lanes are busy. Phase 0 covers today's endpoints:

* ``GET /api/v1/{ws}/graph/bootstrap/status?dataSourceId=``     bootstrap progress (404: none yet)
* ``GET /api/v1/{ws}/versioning/graphs/{gid}/imports``           a data source's import history
* ``GET /api/v1/{ws}/versioning/graphs/{gid}/imports/{job}``     one job's progress
* ``POST …/graphs/{gid}/exports?ids=…`` then its status           a small export, followed to the end
* ``POST /api/v1/views/transfer/packages/uploads`` + part + complete, then the upload's status
                                                                  a small package, inspected
* ``GET /api/v1/health/deps``                                     the web loop's lag p99, sampled

Run it at 200 users beside one 100k+100k import and one bootstrap (``python -m
backend.scripts.bench_versioning e2e …`` against the same stack)::

    locust -f scenarios/versioning_jobs.py --headless -u 200 -r 20 -t 10m --csv results/versioning_jobs

The package each upload sends is ``SYNODIC_PACKAGE_FILE`` when set (a small real one:
``bench_versioning gen-package --nodes 50 --edges 50``); otherwise a tiny archive built here, whose
check ends ``invalid`` — the inspect queue is exercised either way.

SLO gate (plan P0.4), checked when the run ends (exit code 1 on a miss)::

* web GET p99 < 300 ms, for every GET named here;
* ``/health/deps`` loop-lag p99 < 50 ms (the worst sample of the run);
* 0 pool timeouts (503 "temporarily unavailable");
* inspect queue wait p95 < 10 s (upload completed → checked);
* fairness: per-workspace max / median queue wait ≤ 3 (each workspace's median export wait).

The latency part also checks from a CSV after the fact::

    python -m scenarios.versioning_jobs results/versioning_jobs_stats.csv
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import random
import statistics
import sys
import threading
import time
import zipfile
from typing import Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from locust import HttpUser, TaskSet, between, events, tag, task  # noqa: E402

from config import SETTINGS  # noqa: E402
from lib.auth import authenticate  # noqa: E402
from lib.data import IdPool, discover  # noqa: E402
from lib.slo import SLO, assert_slos  # noqa: E402

logger = logging.getLogger(__name__)

TAG = "versioning_jobs"
#: The GETs held to the web p99 target.
POLLS = ("versioning:bootstrap-status", "versioning:jobs-list", "versioning:job-status",
         "versioning:export-status", "packages:upload-status")
VERSIONING_SLOS: List[SLO] = [SLO(name=name, p99_ms_max=300.0) for name in POLLS]
LOOP_LAG_P99_MS = 50.0
INSPECT_WAIT_P95_S = 10.0
FAIRNESS_MAX_RATIO = 3.0

# How a dialog follows a job (the frontend's pollJob): 1 s, then 2 s, then every 5 s.
_POLL_DELAYS = (1.0, 2.0, 5.0)
_FOLLOW_SECS = 120.0
_TERMINAL = ("completed", "failed", "cancelled")

# What the run measured beyond request latency, for the gate at its end. Locust users are
# greenlets of one process: a lock keeps the appends whole.
_lock = threading.Lock()
_inspect_waits: List[float] = []
_queue_waits: Dict[str, List[float]] = {}
_loop_p99_ms: List[float] = []
_pool_timeouts = 0

# The versioned graphs behind the discovered data sources, found once per process:
# [(workspace, data source, graph)], and the jobs seen per graph.
_graphs_lock = threading.Lock()
_graphs: Optional[List[Tuple[str, str, str]]] = None
_jobs: Dict[str, List[str]] = {}
_package: Optional[bytes] = None


def _tiny_package() -> bytes:
    """A view package's layout with ten nodes and a views' file the check will refuse."""
    data = b"".join(json.dumps({"kind": "node", "entity_id": f"lt_{i}", "urn": f"urn:loadtest:{i}",
                                "entityType": "dataset", "displayName": f"loadtest {i}"}).encode() + b"\n"
                    for i in range(10))
    bundle = json.dumps({"format": "view-bundle", "views": []}).encode()
    parts = {name: {"sha256": "sha256:" + hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
             for name, raw in (("view-bundle.json", bundle), ("data/graph.ndjson", data))}
    manifest = {"format": "view-package", "formatVersion": 1, "scope": "source",
                "data": {"version": "published", "nodes": 10, "edges": 0}, "parts": parts}
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("view-bundle.json", bundle)
        z.writestr("data/graph.ndjson", data)
        z.writestr("package.json", json.dumps(manifest))
    return out.getvalue()


def _package_bytes() -> bytes:
    global _package
    if _package is None:
        path = os.getenv("SYNODIC_PACKAGE_FILE")
        if path:
            with open(path, "rb") as f:
                _package = f.read()
        else:
            _package = _tiny_package()
    return _package


class VersioningJobsTasks(TaskSet):
    """One user's dialogs: polling jobs and bootstraps, starting a small export or upload now and
    then and following it to the end."""

    def _versioned_graphs(self) -> List[Tuple[str, str, str]]:
        global _graphs
        with _graphs_lock:
            if _graphs is None:
                found = []
                pool: IdPool = self.user.id_pool
                pairs = [(ws, ds) for ws, dss in pool.ws_to_ds.items() for ds in dss][:20]
                for ws, ds in pairs:
                    with self.client.get(f"/api/v1/{ws}/versioning/resolve", params={"dataSourceId": ds},
                                         name="discover:versioning-resolve", catch_response=True) as resp:
                        resp.success()             # 404: the data source isn't versioned
                        if resp.status_code == 200:
                            found.append((ws, ds, resp.json()["graphId"]))
                _graphs = found
                logger.info("versioning_jobs: %d versioned graph(s) among %d data source(s)",
                            len(found), len(pairs))
        return _graphs

    def _get(self, url: str, name: str, ok=(200,), **kwargs):
        """A GET whose ``ok`` statuses count as successes; the response's JSON, or None."""
        with self.client.get(url, name=name, catch_response=True, **kwargs) as resp:
            if resp.status_code in ok:
                resp.success()
                return resp.json() if resp.status_code == 200 and resp.text else None
            resp.failure(f"HTTP {resp.status_code}")
            return None

    def _follow(self, url: str, name: str, done) -> Tuple[Optional[dict], Optional[float]]:
        """Poll ``url`` as a dialog does until ``done(body)``: the last body, and how long the job
        waited before a worker took it (None if it never left the queue while followed)."""
        started, waited, body, n = time.monotonic(), None, None, 0
        while time.monotonic() - started < _FOLLOW_SECS:
            time.sleep(_POLL_DELAYS[min(n, len(_POLL_DELAYS) - 1)])
            n += 1
            body = self._get(url, name)
            if body is None:
                return None, waited
            if waited is None and not (body.get("status") == "pending" and body.get("phase") in (None, "queued")):
                waited = time.monotonic() - started
            if done(body):
                break
        return body, waited

    @tag(TAG)
    @task(5)
    def bootstrap_status(self) -> None:
        pair = self.user.id_pool.pick_ws_ds()
        if pair is None:
            return
        ws, ds = pair
        self._get(f"/api/v1/{ws}/graph/bootstrap/status", "versioning:bootstrap-status", ok=(200, 404),
                  params={"dataSourceId": ds})

    @tag(TAG)
    @task(5)
    def job_status(self) -> None:
        graphs = [g for g in self._versioned_graphs() if _jobs.get(g[2])]
        if not graphs:
            self.jobs_list()
            return
        ws, _ds, gid = random.choice(graphs)
        self._get(f"/api/v1/{ws}/versioning/graphs/{gid}/imports/{random.choice(_jobs[gid])}",
                  "versioning:job-status")

    @tag(TAG)
    @task(2)
    def jobs_list(self) -> None:
        graphs = self._versioned_graphs()
        if not graphs:
            return
        ws, _ds, gid = random.choice(graphs)
        jobs = self._get(f"/api/v1/{ws}/versioning/graphs/{gid}/imports", "versioning:jobs-list")
        if jobs:
            _jobs[gid] = [j["jobId"] for j in jobs[:20]]

    @tag(TAG)
    @task(1)
    def small_export(self) -> None:
        """An export of a few entities, followed to the end; its queue wait counts per workspace."""
        graphs = [g for g in self._versioned_graphs() if self.user.id_pool.ws_to_urns.get(g[0])]
        if not graphs:
            return
        ws, _ds, gid = random.choice(graphs)
        ids = ",".join(self.user.id_pool.ws_to_urns[ws][:3])
        with self.client.post(f"/api/v1/{ws}/versioning/graphs/{gid}/exports",
                              params={"format": "ndjson", "ids": ids}, name="versioning:export-create",
                              catch_response=True) as resp:
            if resp.status_code != 202:
                resp.failure(f"HTTP {resp.status_code}")
                return
            resp.success()
            job_id = resp.json()["jobId"]
        body, waited = self._follow(f"/api/v1/{ws}/versioning/graphs/{gid}/exports/{job_id}",
                                    "versioning:export-status", lambda b: b.get("status") in _TERMINAL)
        if waited is not None:
            with _lock:
                _queue_waits.setdefault(ws, []).append(waited)

    @tag(TAG)
    @task(1)
    def small_package(self) -> None:
        """A small package uploaded in parts and completed; how long until its check finished."""
        raw = _package_bytes()
        base = "/api/v1/views/transfer/packages/uploads"
        with self.client.post(base, json={"fileName": "loadtest.view-package.zip", "size": len(raw)},
                              name="packages:upload-create", catch_response=True) as resp:
            if resp.status_code != 201:
                resp.failure(f"HTTP {resp.status_code}")
                return
            resp.success()
            upload = resp.json()
        for n in range(upload["parts"]):
            part = raw[n * upload["partBytes"]:(n + 1) * upload["partBytes"]]
            self.client.put(f"{base}/{upload['uploadId']}/parts/{n}", data=part, name="packages:upload-part")
        with self.client.post(f"{base}/{upload['uploadId']}/complete", name="packages:upload-complete",
                              catch_response=True) as resp:
            if resp.status_code != 202:
                resp.failure(f"HTTP {resp.status_code}")
                return
            resp.success()
        started = time.monotonic()
        body, _ = self._follow(f"{base}/{upload['uploadId']}", "packages:upload-status",
                               lambda b: b.get("status") in ("ready", "invalid"))
        if body is not None and body.get("status") in ("ready", "invalid"):
            with _lock:
                _inspect_waits.append(time.monotonic() - started)

    @tag(TAG)
    @task(1)
    def loop_lag(self) -> None:
        body = self._get("/api/v1/health/deps", "health:deps", ok=(200, 503))
        lag = ((body or {}).get("dependencies") or {}).get("event_loop_lag_p99_ms")
        if lag is not None:
            with _lock:
                _loop_p99_ms.append(float(lag))


class VersioningJobsUser(HttpUser):
    """For ``locust -f scenarios/versioning_jobs.py``: this scenario alone."""

    host = SETTINGS.host
    wait_time = between(SETTINGS.think_min, SETTINGS.think_max)
    tasks = {VersioningJobsTasks: 1}
    id_pool: IdPool

    def on_start(self) -> None:
        authenticate(self.client)
        self.id_pool = discover(self.client)


@events.request.add_listener
def _count_pool_timeouts(request_type, name, response_time, response_length, response=None,
                         exception=None, **_kwargs) -> None:
    """A 503 "temporarily unavailable" is the API's answer when a DB pool checkout timed out."""
    global _pool_timeouts
    if response is not None and response.status_code == 503 and "temporarily unavailable" in (response.text or ""):
        with _lock:
            _pool_timeouts += 1


def _p(values: List[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, int(round(q * len(ordered))) - 1)] if ordered else 0.0


def gate(stats) -> List[str]:
    """The plan's P0.4 SLOs against this process's run: ``stats`` is Locust's ``RequestStats``."""
    misses = []
    for slo in VERSIONING_SLOS:
        entry = stats.get(slo.name, "GET")
        if entry.num_requests and entry.get_response_time_percentile(0.99) > slo.p99_ms_max:
            misses.append(f"[{slo.name}] p99 = {entry.get_response_time_percentile(0.99):.0f} ms "
                          f"(> {slo.p99_ms_max:.0f} ms)")
    if _loop_p99_ms and max(_loop_p99_ms) >= LOOP_LAG_P99_MS:
        misses.append(f"[health:deps] loop-lag p99 reached {max(_loop_p99_ms):.0f} ms (< {LOOP_LAG_P99_MS:.0f} ms)")
    if _pool_timeouts:
        misses.append(f"{_pool_timeouts} pool timeout(s) (503 temporarily unavailable; 0 allowed)")
    if _inspect_waits and _p(_inspect_waits, 0.95) >= INSPECT_WAIT_P95_S:
        misses.append(f"inspect wait p95 = {_p(_inspect_waits, 0.95):.1f} s (< {INSPECT_WAIT_P95_S:.0f} s)")
    medians = [statistics.median(w) for w in _queue_waits.values() if w]
    if len(medians) > 1 and statistics.median(medians) > 0:
        ratio = max(medians) / statistics.median(medians)
        if ratio > FAIRNESS_MAX_RATIO:
            misses.append(f"per-workspace queue wait max/median = {ratio:.1f} (≤ {FAIRNESS_MAX_RATIO:.0f})")
    return misses


@events.quitting.add_listener
def _gate_at_quit(environment, **_kwargs) -> None:
    misses = gate(environment.stats)
    logger.info("versioning_jobs: %d inspect wait(s), %d export wait(s) over %d workspace(s), "
                "%d loop-lag sample(s), %d pool timeout(s)", len(_inspect_waits),
                sum(len(w) for w in _queue_waits.values()), len(_queue_waits), len(_loop_p99_ms),
                _pool_timeouts)
    if misses:
        for miss in misses:
            logger.error("versioning_jobs SLO miss: %s", miss)
        environment.process_exit_code = 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python -m scenarios.versioning_jobs <stats.csv>", file=sys.stderr)
        sys.exit(2)
    violations = assert_slos(sys.argv[1], slos=VERSIONING_SLOS, skip_missing=True)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    print("SLO check passed" if not violations else "SLO violations", file=sys.stderr if violations else sys.stdout)
    sys.exit(1 if violations else 0)
