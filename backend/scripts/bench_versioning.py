"""Benchmark harness for version-controlled transfer jobs (plan Phase 0, P0.1).

Drives the REAL service classes and jobs in-process — each job created and queued the way its
HTTP route does it, claimed through ``job_lease.claim`` and run on its lease by the lane's own
runner (``TransferRunner`` / ``BootstrapRunner``) — against Postgres (graphver, and the management
DB that holds the default ``database`` object store) and a live FalkorDB, and measures what the
plan's targets (§9) are written in:

  statements    every SQL statement the process sent (``before_cursor_execute``), by verb
  FalkorDB      queries and seconds, per statement template
  peak RSS      sampled while the job runs, and the process high-water mark (getrusage)
  loop lag      a task ticking every 20 ms: p50/p99/max, and the worst per phase. The job runs on
                the same loop, so this is how long its work holds a worker's loop — or, in the dev
                in-process mode, the web tier's
  object store  bytes written and read, and ``open_stream`` calls
  publish lock  how long ``_lock_graph``'s advisory lock is waited for and held
  windows       each unit of work's duration, per kind; flagged when the last decile is more than
                20% slower than the first (work that grows with what is already there)

Usage, from the repository root, with the backend's environment (MANAGEMENT_DB_URL, FALKORDB_HOST,
FALKORDB_PORT; OBJECT_STORE_BACKEND picks the store, ``database`` by default)::

  python -m backend.scripts.bench_versioning gen-package --nodes 100000 --edges 100000 --out /tmp/p100k.zip
  python -m backend.scripts.bench_versioning run inspect --package /tmp/p100k.zip --check
  python -m backend.scripts.bench_versioning run import --target empty --check
  python -m backend.scripts.bench_versioning run publish --check
  python -m backend.scripts.bench_versioning run export --check
  python -m backend.scripts.bench_versioning gen-package --nodes 100000 --edges 100000 \\
      --offset 100000 --out /tmp/p100k_b.zip
  python -m backend.scripts.bench_versioning run import --package /tmp/p100k_b.zip --target published --check
  python -m backend.scripts.bench_versioning run seed --check
  python -m backend.scripts.bench_versioning gen-falkor --graph gvt_bench_dupes --nodes 100000 \\
      --edges 100000 --dupes 1000 --cross-label 0.5
  python -m backend.scripts.bench_versioning run bootstrap --graph gvt_bench_dupes --auto-decide --check
  python -m backend.scripts.bench_versioning report --md /tmp/bench.md
  python -m backend.scripts.bench_versioning e2e --base http://localhost:8000 --package /tmp/p100k.zip \\
      --provider <falkordb provider id>

Each run records what it made (the inspected upload, the import's draft, the published graph) in a
state file (``--state``) for the next run to pick up, and appends its result there; ``report``
writes every result as one Markdown table. Run each job in its own process: peak RSS is per process.
``--check`` exits non-zero when a target is missed (the targets are the plan's, for 100k+100k).

What is NOT the production path, and why:
* ``run export`` builds the views' file from a bench view (there are no views in the management DB
  to seal); the bundle is a few KB of the job's work, the data is everything else.
* ``run publish``'s hook publishes with ``--containment-types`` given here, where the API's hook
  reads them from the data source's ontology in the management DB; the cache bump and view
  touches that follow a publish there are left out (they are per-publish, not per-entity).
* ``run seed``/``run bootstrap`` use the env FalkorDB instance (no provider registry) and no
  rollup rebuild (a bench graph has no rollups).
* ``e2e`` does not kill or terminate lane workers (``--kill``/``--term`` in the plan): that needs
  the workers' processes, which a client of the HTTP API does not have.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import http.cookiejar
import inspect
import json
import math
import os
import random
import re
import resource
import sys
import tempfile
import time
import uuid
from types import SimpleNamespace
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Sequence, Tuple

WORKSPACE = "ws_bench"
ACTOR = "bench"
TICK_SECS = 0.02
DEFAULT_STATE = os.path.join(tempfile.gettempdir(), "bench_versioning_state.json")

# The containment relationship the bench graphs are built with (the layered-lineage model's).
CONTAINS = "HAS"
LINEAGE = "FLOWS_TO"

# Plan §9 / the detailed plan's "Benchmark targets", for 100k nodes + 100k edges:
# (metric, comparison, target, what the plan calls it). Every run is also held to the loop-lag
# p99 and the per-window linearity targets (``_COMMON``).
TARGETS: Dict[str, List[Tuple[str, str, Any, str]]] = {
    "export": [("total_s", "<=", 30, "export job ≤30 s"),
               ("store_open_streams", "==", 0, "0 store reads"),
               ("write_amplification", "<=", 1.05, "writes ≈ 1× the zip")],
    "inspect": [("total_s", "<=", 10, "inspect job ≤10 s")],
    "import": [("total_s", "<=", 180, "import ≤3 min"),
               ("rss_peak_mb", "<=", 600, "RSS ≤600 MB"),
               ("draft_merkle_rows", "==", 0, "0 draft Merkle rows"),
               ("window_max_s", "<=", 15, "no window >15 s"),
               ("loop_max_ms", "<=", 250, "job-loop max lag ≤250 ms")],
    "publish": [("total_s", "<=", 120, "publish of 200k ≤120 s"),
                ("lock_hold_s", "<=", 60, "lock held ≤60 s"),
                ("rss_peak_mb", "<=", 300, "RSS ≤300 MB")],
    "seed": [("total_s", "<=", 240, "seed ≤4 min"),
             ("rss_peak_mb", "<", 300, "RSS <300 MB"),
             ("falkor_eq_pg", "==", True, "FalkorDB == Postgres"),
             ("loop_max_ms", "<=", 500, "job-loop max lag ≤500 ms")],
    "bootstrap": [("pause_s", "<=", 10, "pauses ≤10 s"),
                  ("version_rows_at_pause", "==", 0, "0 version rows at the pause"),
                  ("after_decision_s", "<=", 120, "≤2 min after the decision"),
                  ("falkor_eq_pg", "==", True, "FalkorDB == Postgres"),
                  ("verify_clean", "==", True, "first verify clean"),
                  ("loop_max_ms", "<=", 500, "job-loop max lag ≤500 ms")],
}
_COMMON = [("loop_p99_ms", "<", 50, "loop-lag p99 <50 ms"),
           ("decile_growth", "<", 0.2, "per-window decile growth <20%")]
_OPS = {"<=": lambda a, b: a <= b, "<": lambda a, b: a < b, "==": lambda a, b: a == b}


# ── Probes ────────────────────────────────────────────────────────────────────


def _rss_mb() -> float:
    """This process's resident memory now (psutil when installed, else /proc)."""
    try:
        import psutil
        return psutil.Process().memory_info().rss / 2 ** 20
    except ImportError:
        pass
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2 ** 20
    except OSError:
        return 0.0


def _maxrss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 2 ** 20 if sys.platform == "darwin" else peak / 1024


def _pct(values: Sequence[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


class CountingStore:
    """The configured object store, counting what moves through it. Everything else is the store's
    own (``__getattr__``), so the jobs see the store they would in production."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self.put_bytes = self.read_bytes = self.puts = self.open_streams = 0
        self.probes: Optional["Probes"] = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def counters(self) -> Dict[str, int]:
        return {"putBytes": self.put_bytes, "puts": self.puts, "readBytes": self.read_bytes,
                "openStreams": self.open_streams}

    async def put_stream(self, key, chunks):
        self.puts += 1

        async def counted():
            last = time.monotonic()
            async for chunk in chunks:
                if self.probes is not None:          # the time to produce each chunk: a page
                    now = time.monotonic()
                    self.probes.record_window("write", now - last)
                    last = now
                self.put_bytes += len(chunk)
                yield chunk
        return await self._inner.put_stream(key, counted())

    def open_stream(self, key, **kw):
        self.open_streams += 1
        inner = self._inner.open_stream(key, **kw)

        async def counted():
            async with contextlib.aclosing(inner):
                async for chunk in inner:
                    self.read_bytes += len(chunk)
                    yield chunk
        return counted()


class Probes:
    """What one run measures. Installed by :func:`probing` for the run's measured part and
    removed after, so runs (and tests) never see each other's patches or counts."""

    def __init__(self, store: Optional[CountingStore] = None) -> None:
        self.store = store
        self.started = time.monotonic()
        self.phase = "start"
        self.marks: List[Tuple[str, float]] = [("start", self.started)]
        self.windows: Dict[str, List[float]] = {}
        self.statements: Dict[str, int] = {}
        self.falkor: Dict[str, List[float]] = {}
        self.lags: List[float] = []
        self.lag_by_phase: Dict[str, float] = {}
        self.rss_start = self.rss_peak = _rss_mb()
        self.locks: List[Tuple[float, float]] = []
        self.ended: Optional[float] = None
        self._store_at = self._store_end = store.counters() if store is not None else None
        self._patches: List[Tuple[Any, str, Any]] = []
        self.slowest: List[Tuple[float, str, str]] = []
        # One bound method each: what ``event.remove`` matches.
        self._sql, self._sql_done = self._on_sql, self._after_sql

    def mark(self, phase: Optional[str]) -> None:
        if phase and phase != self.phase:
            self.phase = phase
            self.marks.append((phase, time.monotonic()))

    def record_window(self, label: str, secs: float) -> None:
        self.windows.setdefault(label, []).append(secs)

    # The SQL statement counter: every engine of the process (graphver's, the management DB's —
    # where the database object store lives — and the lease keeper's).
    def _on_sql(self, conn, _cursor, statement, *_args) -> None:
        verb = statement.lstrip().split(None, 1)[0].upper() if statement.strip() else "?"
        if verb not in ("SELECT", "INSERT", "UPDATE", "DELETE", "WITH"):
            verb = "OTHER"
        self.statements[verb] = self.statements.get(verb, 0) + 1
        conn.info["bench_sql_at"] = time.monotonic()

    def _after_sql(self, conn, _cursor, statement, *_args) -> None:
        """Keep the slowest statements (their opening words, the phase they ran in)."""
        secs = time.monotonic() - conn.info.pop("bench_sql_at", time.monotonic())
        if len(self.slowest) < 5 or secs > self.slowest[-1][0]:
            self.slowest.append((secs, self.phase, " ".join(statement.split())[:160]))
            self.slowest.sort(key=lambda row: -row[0])
            del self.slowest[5:]

    def _patch(self, owner, name: str, make: Callable[[Any], Any]) -> None:
        original = inspect.getattr_static(owner, name)
        self._patches.append((owner, name, original))
        setattr(owner, name, make(original))

    def install(self) -> None:
        from falkordb.asyncio.graph import AsyncGraph
        from sqlalchemy import event
        from sqlalchemy.engine import Engine

        from backend.app.services.versioning.bootstrap_worker import BootstrapRunner
        from backend.app.services.versioning.import_export.import_worker import ImportWorker
        from backend.app.services.versioning.job_lease import Lease
        from backend.app.services.versioning.service import GraphVersioningService

        event.listen(Engine, "before_cursor_execute", self._sql)
        event.listen(Engine, "after_cursor_execute", self._sql_done)
        probes = self

        def falkor(original):
            async def _query(graph, q, *args, **kwargs):
                t = time.monotonic()
                try:
                    return await original(graph, q, *args, **kwargs)
                finally:
                    entry = probes.falkor.setdefault(" ".join(q.split())[:72], [0, 0.0])
                    entry[0] += 1
                    entry[1] += time.monotonic() - t
            return _query

        def checkpoint(original):
            # Every job names its phase in its fenced checkpoints (import: parse/nodes/edges,
            # export: bundle/data, inspect: spool/verify).
            async def _checkpoint(lease, s, **kwargs):
                probes.mark(kwargs.get("current_phase"))
                return await original(lease, s, **kwargs)
            return _checkpoint

        def import_window(original):
            async def _next_window(worker, *args, **kwargs):
                t = time.monotonic()
                more = await original(worker, *args, **kwargs)
                if more:
                    probes.record_window(getattr(worker, "_bench_kind", "window"), time.monotonic() - t)
                return more
            return _next_window

        def import_kind(original):
            async def _window(worker, job_id, kind, after):
                worker._bench_kind = f"{kind}s"
                probes.mark(worker._bench_kind)
                return await original(worker, job_id, kind, after)
            return _window

        def import_stage(original):
            # The parse starts by spooling the upload; its first checkpoint is a batch later.
            async def _stage(worker, *args, **kwargs):
                probes.mark("parse")
                return await original(worker, *args, **kwargs)
            return _stage

        def parse_batch(original):
            async def _flush(worker, batch):
                t = time.monotonic()
                try:
                    return await original(worker, batch)
                finally:
                    probes.record_window("parse", time.monotonic() - t)
            return _flush

        def bootstrap_unit(original):
            async def _run_phase(runner, lease, unit, graph_id, phase):
                probes.mark(phase)
                t = time.monotonic()
                try:
                    return await original(runner, lease, unit, graph_id, phase)
                finally:
                    probes.record_window(phase, time.monotonic() - t)
            return _run_phase

        def graph_lock(original):
            # Transaction-scoped: held from here until the transaction that took it ends.
            take = original.__func__

            async def _lock_graph(s, graph_id):
                t = time.monotonic()
                await take(s, graph_id)
                held_from = time.monotonic()
                done = []

                def released(*_args):
                    if not done:
                        done.append(True)
                        probes.locks.append((held_from - t, time.monotonic() - held_from))
                event.listen(s.sync_session, "after_commit", released, once=True)
                event.listen(s.sync_session, "after_rollback", released, once=True)
            return staticmethod(_lock_graph)

        self._patch(AsyncGraph, "_query", falkor)
        self._patch(Lease, "checkpoint", checkpoint)
        self._patch(ImportWorker, "_next_window", import_window)
        self._patch(ImportWorker, "_window", import_kind)
        self._patch(ImportWorker, "_flush", parse_batch)
        self._patch(ImportWorker, "_stage", import_stage)
        self._patch(BootstrapRunner, "_run_phase", bootstrap_unit)
        self._patch(GraphVersioningService, "_lock_graph", graph_lock)
        if self.store is not None:
            self.store.probes = self

    def uninstall(self) -> None:
        from sqlalchemy import event
        from sqlalchemy.engine import Engine

        event.remove(Engine, "before_cursor_execute", self._sql)
        event.remove(Engine, "after_cursor_execute", self._sql_done)
        for owner, name, original in reversed(self._patches):
            setattr(owner, name, original)
        self._patches.clear()
        if self.store is not None:
            self.store.probes = None

    async def tick(self) -> None:
        loop = asyncio.get_running_loop()
        n = 0
        while True:
            t = loop.time()
            await asyncio.sleep(TICK_SECS)
            lag = max(0.0, loop.time() - t - TICK_SECS)
            self.lags.append(lag)
            if lag > self.lag_by_phase.get(self.phase, 0.0):
                self.lag_by_phase[self.phase] = lag
            n += 1
            if n % 5 == 0:
                self.rss_peak = max(self.rss_peak, _rss_mb())

    def summary(self) -> Dict[str, Any]:
        end = self.ended or time.monotonic()
        marks = self.marks + [("end", end)]
        phases: Dict[str, float] = {}
        for (name, at), (_next, until) in zip(marks, marks[1:]):
            phases[name] = round(phases.get(name, 0.0) + until - at, 2)
        windows = {}
        for label, secs in self.windows.items():
            k = max(1, len(secs) // 10)
            first, last = sum(secs[:k]) / k, sum(secs[-k:]) / k
            growth = (last / first - 1) if len(secs) >= 10 and first > 0 else None
            windows[label] = {"n": len(secs), "p50": round(_pct(secs, 0.5), 3),
                              "max": round(max(secs), 3), "total": round(sum(secs), 2),
                              "decileGrowth": None if growth is None else round(growth, 3),
                              "flagged": growth is not None and growth > 0.2}
        store = None
        if self.store is not None:
            store = {k: self._store_end[k] - self._store_at[k] for k in self._store_end}
        top = sorted(self.falkor.items(), key=lambda kv: -kv[1][1])[:8]
        return {
            "totalSecs": round(end - self.started, 2),
            "phases": phases,
            "windows": windows,
            "statements": {"total": sum(self.statements.values()), **self.statements},
            "slowestStatements": [{"secs": round(t, 2), "phase": phase, "sql": sql}
                                  for t, phase, sql in self.slowest],
            "falkor": {"queries": int(sum(v[0] for v in self.falkor.values())),
                       "secs": round(sum(v[1] for v in self.falkor.values()), 2),
                       "top": [{"template": q, "n": int(n), "secs": round(s, 2)} for q, (n, s) in top]},
            "loopLagMs": {"p50": round(_pct(self.lags, 0.5) * 1000, 1),
                          "p99": round(_pct(self.lags, 0.99) * 1000, 1),
                          "max": round(max(self.lags or [0.0]) * 1000, 1),
                          "maxByPhase": {k: round(v * 1000) for k, v in self.lag_by_phase.items()}},
            "rssMb": {"start": round(self.rss_start), "peak": round(self.rss_peak),
                      "maxrss": round(_maxrss_mb())},
            "store": store,
            "lock": {"acquired": len(self.locks),
                     "waitMaxSecs": round(max((w for w, _ in self.locks), default=0.0), 2),
                     "holdMaxSecs": round(max((h for _, h in self.locks), default=0.0), 2)}
            if self.locks else None,
        }


@contextlib.asynccontextmanager
async def probing(store: Optional[CountingStore] = None) -> AsyncIterator[Probes]:
    """Measure the block: the probes installed, the loop ticking, and everything restored after."""
    probes = Probes(store)
    probes.install()
    ticker = asyncio.create_task(probes.tick())
    try:
        yield probes
    finally:
        probes.ended = time.monotonic()
        probes.rss_peak = max(probes.rss_peak, _rss_mb())
        if store is not None:
            probes._store_end = store.counters()
        ticker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await ticker
        probes.uninstall()


def _metrics(summary: Dict[str, Any]) -> Dict[str, Any]:
    """The probes' summary, flattened to what targets are written in."""
    windows = summary["windows"]
    growth = [w["decileGrowth"] for w in windows.values() if w["decileGrowth"] is not None]
    store = summary["store"] or {}
    return {
        "total_s": summary["totalSecs"],
        "rss_peak_mb": summary["rssMb"]["peak"],
        "loop_p50_ms": summary["loopLagMs"]["p50"],
        "loop_p99_ms": summary["loopLagMs"]["p99"],
        "loop_max_ms": summary["loopLagMs"]["max"],
        "statements": summary["statements"]["total"],
        "falkor_queries": summary["falkor"]["queries"],
        "store_put_mb": round(store.get("putBytes", 0) / 2 ** 20, 1),
        "store_read_mb": round(store.get("readBytes", 0) / 2 ** 20, 1),
        "store_open_streams": store.get("openStreams", 0),
        "window_max_s": max((w["max"] for w in windows.values()), default=0.0),
        "decile_growth": max(growth) if growth else None,
        **({"lock_hold_s": summary["lock"]["holdMaxSecs"], "lock_wait_s": summary["lock"]["waitMaxSecs"]}
           if summary["lock"] else {}),
    }


def evaluate(run: str, metrics: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every target of ``run`` against ``metrics``; a metric the run did not produce is skipped."""
    checks = []
    for metric, op, target, label in TARGETS.get(run, []) + _COMMON:
        actual = metrics.get(metric)
        if actual is None:
            continue
        checks.append({"metric": metric, "target": f"{op} {target}", "label": label,
                       "actual": actual, "ok": bool(_OPS[op](actual, target))})
    return checks


# ── The bench graph ───────────────────────────────────────────────────────────


def _level_types(depth: int) -> List[str]:
    if depth <= 1:
        return ["attribute"]
    if depth == 2:
        return ["layer", "attribute"]
    return ["layer", "object"] + ["group"] * (depth - 3) + ["attribute"]


def plan_graph(nodes: int, edges: int, *, containment: float = 0.5, depth: int = 3,
               seed: int = 7) -> Tuple[List[str], List[int], List[Tuple[int, int]]]:
    """The bench graph's shape — the layered-lineage model's (``generate_layered_lineage_model``):
    a containment forest (``HAS``: layer → object → … → attribute, ``depth`` levels) holding
    ``containment`` of the edges, every child under exactly one parent, and lineage (``FLOWS_TO``)
    between the deepest level's nodes for the rest, no pair twice. Returns each node's type, each
    node's parent (-1 for a root) and the lineage pairs. Deterministic for a ``seed``."""
    rng = random.Random(seed)
    contained = 0 if depth < 2 or nodes < 2 else min(nodes - 1, round(edges * containment))
    per_level = [contained // (depth - 1) + (1 if k < contained % (depth - 1) else 0)
                 for k in range(depth - 1)] if contained else []
    names = _level_types(depth)
    types: List[str] = []
    parents: List[int] = []
    previous: List[int] = []
    at = 0
    for level, size in enumerate([nodes - contained] + per_level):
        current = list(range(at, at + size))
        for k, _node in enumerate(current):
            types.append(names[level])
            parents.append(previous[k % len(previous)] if level and previous else -1)
        previous, at = current or previous, at + size
    wanted = max(0, edges - contained)
    pool = previous if len(previous) * (len(previous) - 1) >= 2 * wanted else list(range(nodes))
    wanted = min(wanted, len(pool) * (len(pool) - 1))
    pairs: List[Tuple[int, int]] = []
    seen = set()
    while len(pairs) < wanted:
        pair = (rng.choice(pool), rng.choice(pool))
        if pair[0] != pair[1] and pair not in seen:
            seen.add(pair)
            pairs.append(pair)
    return types, parents, pairs


def _node_payload(n: int, ntype: str, *, urn: bool) -> Dict[str, Any]:
    payload = {
        "entityType": ntype, "displayName": f"{ntype}_{n}", "qualifiedName": f"bench.{ntype}.{n}",
        "description": f"The {ntype} number {n} of the benchmark graph, with some text to it.",
        "tags": ["bench"], "lastSyncedAt": "2026-06-01T00:00:00Z",
        "properties": {"owner": f"team{n % 17}", "rows": n * 13, "format": "parquet",
                       "location": f"s3://bench/{ntype}/{n}", "columns": [f"c{k}" for k in range(5)]},
    }
    if urn:
        payload["urn"] = f"urn:bench:{ntype}:{n}"
    return payload


def _case_variant(k: int) -> str:
    return (LINEAGE.lower(), LINEAGE.title())[k % 2]


async def gen_package(out: str, *, nodes: int, edges: int, fmt: int = 1, containment: float = 0.5,
                      depth: int = 3, urnless: float = 0.0, case_variants: float = 0.0,
                      bad_rows: int = 0, offset: int = 0, seed: int = 7) -> Dict[str, Any]:
    """A view package of ``nodes`` + ``edges`` at ``out``, written as the export job writes one:
    the data lines by the exporter's own code (format 1: ``rowmodel.denormalize_*`` through the
    NDJSON writer; format 2: ``stream._native_lines``), zipped by ``package.write_package`` with a
    manifest as ``PackageExport`` makes it (per-kind and per-type counts, each part's checksum).

    ``urnless``/``case_variants`` are fractions of the nodes without a urn and of the lineage edges
    whose type is spelled ``flows_to``/``Flows_To``; ``bad_rows`` lines a reader must turn away
    (an unknown kind, a node with an invalid ``_op``, an edge between ids that exist nowhere);
    ``offset`` numbers the entities from there (a second package that shares nothing with the
    first)."""
    from backend.app.services.versioning.import_export.formats import get_adapter
    from backend.app.services.versioning.import_export.rowmodel import denormalize_edge, denormalize_node
    from backend.app.services.versioning.import_export.stream import TypeStats, _native_lines
    from backend.app.services.versioning.merkle import content_hash
    from backend.app.services.view_transfer.package import BUNDLE_PART, DATA_PART, write_package

    t0 = time.monotonic()
    rng = random.Random(seed + 1)
    types, parents, pairs = plan_graph(nodes, edges, containment=containment, depth=depth, seed=seed)
    no_urn = set(rng.sample(range(nodes), round(nodes * urnless))) if urnless else set()
    variants = set(rng.sample(range(len(pairs)), round(len(pairs) * case_variants))) if case_variants else set()
    nid = [f"ent_{offset + i:08d}" for i in range(nodes)]
    payloads = [_node_payload(offset + i, types[i], urn=i not in no_urn) for i in range(nodes)]
    stats, tally = TypeStats(), {"node": 0, "edge": 0}
    edge_specs = [(parents[i], i, CONTAINS, None) for i in range(nodes) if parents[i] >= 0]
    edge_specs += [(s, t, _case_variant(j) if j in variants else LINEAGE, j) for j, (s, t) in enumerate(pairs)]

    def node_page(lo: int, hi: int) -> List[Any]:
        stats.add("node", types[lo:hi])
        tally["node"] += hi - lo
        if fmt == 1:
            return [{"kind": "node", **denormalize_node(nid[i], content_hash(payloads[i]), payloads[i])}
                    for i in range(lo, hi)]
        page = [SimpleNamespace(entity_id=nid[i], content_hash=content_hash(payloads[i]),
                                payload=json.dumps(payloads[i])) for i in range(lo, hi)]
        return [_native_lines("node", page, {})]

    def edge_page(lo: int, hi: int) -> List[Any]:
        records, page, ends = [], [], {}
        for k in range(lo, hi):
            s, t, etype, j = edge_specs[k]
            payload = {"edgeType": etype, "sourceEntityId": nid[s], "targetEntityId": nid[t],
                       "confidence": 0.9, "properties": {"job": f"etl_{j % 101}"} if j is not None else {}}
            eid = f"edge_{offset + k:08d}"
            stats.add("edge", [etype])
            if fmt == 1:
                records.append({"kind": "edge", **denormalize_edge(
                    eid, content_hash(payload), payload,
                    source_qname=payloads[s]["qualifiedName"], target_qname=payloads[t]["qualifiedName"],
                    source_urn=payloads[s].get("urn"), target_urn=payloads[t].get("urn"))})
            else:
                for i in (s, t):
                    ends[nid[i]] = SimpleNamespace(urn=payloads[i].get("urn"),
                                                   qualified_name=payloads[i]["qualifiedName"])
                page.append(SimpleNamespace(entity_id=eid, content_hash=content_hash(payload),
                                            payload=json.dumps(payload), source_id=nid[s], target_id=nid[t]))
        tally["edge"] += hi - lo
        return records if fmt == 1 else [_native_lines("edge", page, ends)]

    def bad(kind: str) -> List[Any]:
        """The lines a reader must turn away, after the good ones of ``kind``."""
        out = []
        for k in range(bad_rows):
            if kind == "node" and k % 3 == 0:
                out.append({"kind": "widget", "entity_id": f"bad_{offset + k}"})
            elif kind == "node" and k % 3 == 1:
                stats.add("node", ["attribute"])
                tally["node"] += 1
                out.append({"kind": "node", "entity_id": f"bad_{offset + k}", "_op": "frobnicate",
                            "urn": f"urn:bench:bad:{offset + k}", "entityType": "attribute"})
            elif kind == "edge" and k % 3 == 2:
                stats.add("edge", [LINEAGE])
                tally["edge"] += 1
                out.append({"kind": "edge", "entity_id": f"bad_edge_{offset + k}", "edgeType": LINEAGE,
                            "source_entity_id": f"missing_{k}", "target_entity_id": f"missing_{k + 1}"})
        if fmt == 1 or not out:
            return out
        return [("\n".join(json.dumps(r) for r in out) + "\n").encode()]

    async def pages() -> AsyncIterator[List[Any]]:
        for lo in range(0, nodes, 5000):
            yield node_page(lo, min(nodes, lo + 5000))
        yield bad("node")
        for lo in range(0, len(edge_specs), 5000):
            yield edge_page(lo, min(len(edge_specs), lo + 5000))
        yield bad("edge")

    async def data() -> AsyncIterator[bytes]:
        if fmt == 1:
            async for chunk in get_adapter("ndjson").write_pages(pages()):
                yield chunk
            return
        async for page in pages():
            for chunk in page:
                yield chunk

    bundle = _bench_bundle()
    raw = json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8")

    def manifest_of(found):            # as PackageExport.write's
        counts = {"nodes": tally["node"], "edges": tally["edge"]}
        return {"format": "view-package", "formatVersion": fmt,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "scope": "source",
                "data": {"version": "published", **counts, "typeStats": stats.as_dict()},
                "parts": {BUNDLE_PART: {"views": 1, "bundleHash": bundle["bundleHash"], **found[BUNDLE_PART]},
                          DATA_PART: {**found[DATA_PART], **counts}}}

    with open(out, "wb") as f:
        async for chunk in write_package(raw, data(), manifest_of):
            f.write(chunk)
    return {"out": out, "bytes": os.path.getsize(out), "nodes": tally["node"], "edges": tally["edge"],
            "format": fmt, "secs": round(time.monotonic() - t0, 1)}


def _bench_bundle() -> Dict[str, Any]:
    """A views' file with one view, made by the bundle code an export uses."""
    from backend.app.services.view_transfer.bundle import assemble_bundle
    from backend.app.services.view_transfer.canonical import content_hash, portable_definition

    definition = portable_definition({"layout": {"type": "reference", "referenceLayout": {"layers": []}}},
                                     "graph")
    view = {"source": "s1", "portableId": "pv_bench", "version": 1, "definitionHash": content_hash(definition),
            "metadata": {"name": "Benchmark"}, "definition": definition}
    return assemble_bundle(views=[view], sources={"s1": {}}, exported_by=ACTOR, product=None,
                           environment="bench")


def _falkor_props(n: int, ntype: str) -> Dict[str, Any]:
    return {"urn": f"urn:bench:{ntype}:{n}", "displayName": f"{ntype}_{n}",
            "qualifiedName": f"bench.{ntype}.{n}", "description": f"The {ntype} number {n}.",
            "lastSyncedAt": "2026-06-01T00:00:00Z", "owner": f"team{n % 17}", "rows": n * 13,
            "format": "parquet", "location": f"s3://bench/{ntype}/{n}"}


# What a duplicate's lastSyncedAt says, in turn: newer, older, epoch seconds and millis (as
# numbers, as some sources write them, or as their text), something no date parser reads, and nothing.
_SYNCED_VARIANTS = ("2026-09-01T00:00:00Z", "2025-01-01T00:00:00Z", 1767225600, 1790000000000,
                    "1767225600", "yesterday", None)


async def gen_falkor(client, *, nodes: int, edges: int, dupes: int = 0, cross_label: float = 0.0,
                     containment: float = 0.5, depth: int = 3, seed: int = 7, string_synced: bool = False,
                     batch: int = 5000) -> Dict[str, Any]:
    """A source graph for "enable version control", written into ``client`` with UNWIND CREATE
    batches: the :func:`plan_graph` shape (a per-label urn index first, as a customer graph has),
    and ``dupes`` extra nodes that copy an existing node's urn — under another label for
    ``cross_label`` of them — with varied (and unparseable) ``lastSyncedAt`` values, each with one
    relationship of its own (``string_synced``: no bare numbers among them). ``edges`` counts those
    relationships too."""
    t0 = time.monotonic()
    rng = random.Random(seed + 2)
    variants = [v for v in _SYNCED_VARIANTS if not (string_synced and isinstance(v, int))]
    types, parents, pairs = plan_graph(nodes, edges - dupes, containment=containment, depth=depth, seed=seed)
    labels = sorted(set(types))
    for label in labels:
        await client.query(f"CREATE INDEX FOR (n:`{label}`) ON (n.urn)")
    for label in labels:
        rows = [_falkor_props(i, label) for i in range(nodes) if types[i] == label]
        for lo in range(0, len(rows), batch):
            await client.query(f"UNWIND $rows AS p CREATE (n:`{label}`) SET n = p",
                               {"rows": rows[lo:lo + batch]})
    groups: Dict[Tuple[str, str, str], List[dict]] = {}
    for i in range(nodes):
        if parents[i] >= 0:
            p = parents[i]
            groups.setdefault((types[p], types[i], CONTAINS), []).append(
                {"s": f"urn:bench:{types[p]}:{p}", "t": f"urn:bench:{types[i]}:{i}", "p": {"id": f"has-{i}"}})
    for j, (s, t) in enumerate(pairs):
        groups.setdefault((types[s], types[t], LINEAGE), []).append(
            {"s": f"urn:bench:{types[s]}:{s}", "t": f"urn:bench:{types[t]}:{t}",
             "p": {"id": f"flow-{j}", "job": f"etl_{j % 101}"}})
    for (ls, lt, rel), rows in groups.items():
        for lo in range(0, len(rows), batch):
            await client.query(f"UNWIND $rows AS r MATCH (a:`{ls}` {{urn: r.s}}) MATCH (b:`{lt}` {{urn: r.t}}) "
                               f"CREATE (a)-[e:`{rel}`]->(b) SET e = r.p", {"rows": rows[lo:lo + batch]})
    copied = rng.sample(range(nodes), min(dupes, nodes)) if dupes else []
    unique = sorted(set(range(nodes)) - set(copied))
    dupe_groups: Dict[Tuple[str, str], List[dict]] = {}
    for k, i in enumerate(copied):
        label = types[i]
        if rng.random() < cross_label:
            label = rng.choice([x for x in labels if x != types[i]] or ["Thing"])
        props = {**_falkor_props(i, types[i]), "displayName": f"{types[i]}_{i} (copy)"}
        props.pop("lastSyncedAt")
        if variants[k % len(variants)] is not None:
            props["lastSyncedAt"] = variants[k % len(variants)]
        t = rng.choice(unique)
        dupe_groups.setdefault((label, types[t]), []).append(
            {"t": f"urn:bench:{types[t]}:{t}", "p": props, "e": {"id": f"dupe-{k}"}})
    for (label, lt), rows in dupe_groups.items():
        await client.query(f"UNWIND $rows AS r MATCH (t:`{lt}` {{urn: r.t}}) "
                           f"CREATE (d:`{label}`)-[e:`{LINEAGE}`]->(t) SET d = r.p, e = r.e", {"rows": rows})
    return {"graph": client.name, "nodes": nodes + len(copied),
            "edges": sum(len(v) for v in groups.values()) + len(copied), "dupes": len(copied),
            "labels": labels, "secs": round(time.monotonic() - t0, 1)}


# ── Running jobs ──────────────────────────────────────────────────────────────


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def counting_store(store=None) -> CountingStore:
    from backend.app.services.storage.object_store import get_object_store
    return CountingStore(store if store is not None else get_object_store())


async def _claim(job_id: str, types: Sequence[str], ready: str):
    """The lane's own claim (``job_lease.claim``: one transaction, SKIP LOCKED, a new epoch),
    narrowed to the job this run queued: a benchmark never takes someone else's job off a shared
    queue, nor a stale one it would then resume (hence no stale takeover)."""
    from backend.app.services.versioning import db, job_lease

    if not re.fullmatch(r"[A-Za-z0-9_]+", job_id):
        raise ValueError(f"not a job id: {job_id!r}")
    lease = await job_lease.claim(db.graphver_session, types, phase_pred=f"({ready}) AND j.id = '{job_id}'",
                                  stale_secs=10 ** 9)
    if lease is None:
        raise RuntimeError(f"job {job_id} is not claimable")
    return lease


async def run_claimed(runner, job_id: str, types: Sequence[str], ready: str):
    """Claim ``job_id`` and run it with ``runner.run_job`` — as the lane's slot loop does — its
    lease renewed by a LeaseKeeper thread for as long as it runs."""
    from backend.app.services.versioning import job_lease

    lease = await _claim(job_id, types, ready)
    keeper = job_lease.running_keeper()
    own = keeper is None
    if own:
        keeper = job_lease.LeaseKeeper().start()
    keeper.register(lease)
    try:
        return await runner.run_job(lease)
    finally:
        keeper.unregister(lease)
        if own:
            keeper.stop()


def _service(store, svc=None, publish_hook=None):
    from backend.app.services.versioning.import_export.service import ImportExportService
    from backend.app.services.versioning.service import GraphVersioningService

    return ImportExportService(versioning=svc or GraphVersioningService(), store=store,
                               publish_hook=publish_hook)


def _result(run: str, probed: Dict[str, Any], extra: Dict[str, Any], **info) -> Dict[str, Any]:
    metrics = {**_metrics(probed), **extra}
    return {"run": run, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **info,
            "metrics": metrics, "probes": probed, "checks": evaluate(run, metrics)}


async def _read_json(store, key: str) -> Dict[str, Any]:
    return json.loads(b"".join([chunk async for chunk in store.open_stream(key)]))


async def upload_package(store, path: str, owner: str = ACTOR) -> Dict[str, Any]:
    """``path`` uploaded in parts, as ``PUT …/packages/uploads/{id}/parts/{n}`` stores them."""
    from backend.app.services.versioning.import_export import uploads

    record = await uploads.create_package(store, owner=owner, file_name=os.path.basename(path),
                                          size=os.path.getsize(path))
    with open(path, "rb") as f:
        for n in range(record["parts"]):
            left = uploads.part_size(record, n)

            async def part(left=left):
                while left:
                    chunk = f.read(min(left, 2 ** 20))
                    if not chunk:
                        return
                    left -= len(chunk)
                    yield chunk
            await uploads.put_part(store, record, n, part())
    return record


async def run_inspect(*, package: str, store: CountingStore) -> Dict[str, Any]:
    """Upload ``package`` and run its ``package_inspect`` job (the transfer lane's own slot)."""
    from backend.app.services.versioning import job_lease, models
    from backend.app.services.versioning.import_export import uploads
    from backend.app.services.versioning.import_export.runner import INSPECT_TYPES, TransferRunner

    await models.create_schema_and_partitions()
    ie = _service(store)
    t = time.monotonic()
    record = await upload_package(store, package)
    upload_s = round(time.monotonic() - t, 2)
    # As ``POST …/uploads/{id}/complete`` does: the job, recorded on the upload, then queued.
    job_id, _ = await ie.create_inspect_job(upload_id=record["uploadId"], source_uri=uploads.record_key(record))
    await uploads.save(store, {**record, "jobId": job_id})
    await ie.start_inspect(job_id)
    async with probing(store) as probes:
        await run_claimed(TransferRunner(lambda: ie, types=INSPECT_TYPES), job_id, INSPECT_TYPES,
                          job_lease.TRANSFER_READY)
    job = await ie.get_job(job_id)
    record = await uploads.read_record(store, uploads.record_key(record))
    return _result("inspect", probes.summary(), {"upload_s": upload_s},
                   status=job["status"], error=job.get("errorMessage") or record.get("error"),
                   jobId=job_id, upload={"key": uploads.record_key(record), "uploadId": record["uploadId"],
                                         "package": os.path.abspath(package), "zipBytes": record["size"],
                                         "dataBytes": (record.get("archive") or {}).get("bytes")},
                   summary=job.get("summary"))


async def _live_count(graph_id: str, branch_id: str) -> int:
    from sqlalchemy import func, select

    from backend.app.services.versioning import db
    from backend.app.services.versioning.models import EntityHeadORM

    async with db.graphver_session() as s:
        return int((await s.execute(select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
            EntityHeadORM.is_tombstone.is_(False)))).scalar_one())


async def run_import(*, upload_key: str, store: CountingStore, graph_id: Optional[str] = None) -> Dict[str, Any]:
    """The upload's data into a new draft — of a new, empty graph, or of ``graph_id`` — by an
    import job, as ``POST /packages/{id}/data`` starts one."""
    from sqlalchemy import func, select

    from backend.app.services.versioning import db, job_lease, models
    from backend.app.services.versioning.import_export import uploads
    from backend.app.services.versioning.import_export.runner import TransferRunner
    from backend.app.services.versioning.models import MerkleNodeORM
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ie = _service(store, svc)
    record = await uploads.read_record(store, upload_key)
    if graph_id is None:
        ds = _new_id("ds_bench")
        graph_id = (await svc.create_graph(data_source_id=ds, workspace_id=WORKSPACE, actor=ACTOR))["graph_id"]
    else:
        ds = (await svc.get_graph(graph_id))["data_source_id"]
    existing = await _live_count(graph_id, await svc.main_branch_id(graph_id))
    draft = await svc.open_draft(graph_id=graph_id, owner=ACTOR, name="Import: bench")
    created = await ie.create_import_job(
        workspace_id=WORKSPACE, data_source_id=ds, graph_id=graph_id, actor=ACTOR, import_format="ndjson",
        source_uri=upload_key, branch_id=draft, reconcile_mode="upsert",
        idempotency_key=f"pkgdata:{record['uploadId']}:{draft}", name="Import: bench")
    job_id = created["job_id"]
    await ie.start_import(job_id)
    async with probing(store) as probes:
        await run_claimed(TransferRunner(lambda: ie), job_id, job_lease.TRANSFER_TYPES, job_lease.TRANSFER_READY)
    job = await ie.get_job(job_id)
    async with db.graphver_session() as s:
        merkle = int((await s.execute(select(func.count()).select_from(MerkleNodeORM).where(
            MerkleNodeORM.graph_id == graph_id, MerkleNodeORM.branch_id == draft))).scalar_one())
    tallies = {k: v for k, v in (job.get("summary") or {}).items() if isinstance(v, int)}
    return _result("import", probes.summary(), {"draft_merkle_rows": merkle, "existing_entities": existing},
                   status=job["status"], error=job.get("errorMessage"), jobId=job_id, tallies=tallies,
                   draft={"graphId": graph_id, "branchId": draft, "dataSourceId": ds})


async def run_publish(*, graph_id: str, branch_id: str, store: CountingStore,
                      containment: Sequence[str] = (CONTAINS,)) -> Dict[str, Any]:
    """Publish the draft by a publish job, as ``POST …/publish`` queues a large one. The hook is the
    API's ``_publish_from_job`` publish, with the containment types given here."""
    from backend.app.services.versioning import job_lease, models
    from backend.app.services.versioning.import_export.runner import TransferRunner
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    async def publish(job: Dict[str, Any]) -> Dict[str, Any]:
        if job.get("mergedCommitId"):
            return {"commitId": job["mergedCommitId"]}
        return {"commitId": await svc.publish(
            graph_id=job["graphId"], branch_id=job["branchId"], actor=job["actor"],
            message=job["message"], containment_edge_types=list(containment))}

    ie = _service(store, svc, publish_hook=publish)
    meta = await svc.get_graph(graph_id)
    main = await svc.main_branch_id(graph_id)
    before = await _live_count(graph_id, main)
    created = await ie.create_publish_job(workspace_id=meta["workspace_id"], data_source_id=meta["data_source_id"],
                                          graph_id=graph_id, branch_id=branch_id, actor=ACTOR,
                                          message="bench publish")
    job_id = created["job_id"]
    await ie.start_publish(job_id)
    async with probing(store) as probes:
        await run_claimed(TransferRunner(lambda: ie), job_id, job_lease.TRANSFER_TYPES, job_lease.TRANSFER_READY)
    job = await ie.get_job(job_id)
    after = await _live_count(graph_id, main)
    return _result("publish", probes.summary(), {"changes": after - before},
                   status=job["status"], error=job.get("errorMessage"), jobId=job_id,
                   published={"graphId": graph_id, "commitId": (job.get("summary") or {}).get("commitId"),
                              "entities": after})


async def run_export(*, graph_id: str, store: CountingStore, out: Optional[str] = None) -> Dict[str, Any]:
    """A view package of the graph's published data by an export job, as ``POST /packages`` asks
    for one (scope ``source``); ``out`` saves the package (after the measured part)."""
    from backend.app.services.versioning import job_lease, models
    from backend.app.services.versioning.import_export.runner import TransferRunner
    from backend.app.services.versioning.service import GraphVersioningService
    from backend.app.services.view_transfer import package

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ie = _service(store, svc)
    meta = await svc.get_graph(graph_id)

    async def bundle_of(_session, _options, _ws, _ds):
        return _bench_bundle(), None

    created = await ie.create_export_job(
        workspace_id=meta["workspace_id"], data_source_id=meta["data_source_id"], graph_id=graph_id,
        actor=ACTOR, export_format="ndjson", as_of_seq=meta["main_head_commit_seq"],
        package={"fileName": "bench.view-package.zip", "scope": "source", "dataVersion": "published",
                 "views": [{"viewId": "view_bench", "version": 1}], "actor": ACTOR})
    job_id = created["job_id"]
    await ie.start_export(job_id)
    built = package.build_bundle
    package.build_bundle = bundle_of          # the views' file: see the module docstring
    try:
        async with probing(store) as probes:
            await run_claimed(TransferRunner(lambda: ie), job_id, job_lease.TRANSFER_TYPES,
                              job_lease.TRANSFER_READY)
    finally:
        package.build_bundle = built
    job = await ie.get_job(job_id)
    summary = job.get("summary") or {}
    zip_bytes = summary.get("bytes") or 0
    put = (probes.summary()["store"] or {}).get("putBytes", 0)
    if out and job["status"] == "completed":
        with open(out, "wb") as f:
            async for chunk in store.open_stream(job["resultUri"]):
                f.write(chunk)
    return _result("export", probes.summary(),
                   {"write_amplification": round(put / zip_bytes, 3) if zip_bytes else None},
                   status=job["status"], error=job.get("errorMessage"), jobId=job_id,
                   exported={"graphId": graph_id, "resultUri": job.get("resultUri"), "bytes": zip_bytes,
                             "nodes": summary.get("nodes"), "edges": summary.get("edges"), "out": out})


def falkor_factory():
    """The projector's env-instance FalkorDB client factory (``FALKORDB_HOST``/``FALKORDB_PORT``)."""
    from backend.app.services.versioning.projection import make_falkor_graph_factory
    return make_falkor_graph_factory()


async def _client(factory, name: str):
    client = factory(name, None)
    return await client if inspect.isawaitable(client) else client


async def _noop(_graph_id: str) -> None:
    """The rollup-rebuild hook: a bench graph has no rollups to rebuild."""


def _failed_checks(status: Dict[str, Any]) -> Tuple[List[dict], List[str]]:
    """The job report's checks that failed: blocking ones whole, the others (warnings) by key."""
    checks = [c for c in ((status.get("report") or {}).get("checks") or []) if not c.get("ok")]
    return ([c for c in checks if c.get("blocking", True)],
            [c.get("key") for c in checks if not c.get("blocking", True)])


async def _counts(graph_id: str, client, *, owned: bool) -> Tuple[Tuple[int, int], Tuple[int, int]]:
    """(Postgres' projectable counts on main, FalkorDB's) — what the reconciler compares."""
    from backend.app.services.versioning import db
    from backend.app.services.versioning.reconcile import falkor_counts, pg_live_counts_projectable
    from backend.app.services.versioning.service import GraphVersioningService

    main = await GraphVersioningService().main_branch_id(graph_id)
    async with db.graphver_session() as s:
        pg = await pg_live_counts_projectable(s, graph_id, main)
    return tuple(pg), tuple(await falkor_counts(client, owned=owned))


async def run_seed(*, upload_key: str, store: CountingStore, keep: bool = False,
                   factory=None) -> Dict[str, Any]:
    """A new data source seeded from the upload, as ``POST /packages/{id}/new-source`` asks for one:
    the bootstrap job with ``origin='package'``, projected into a new ``gvt_bench_*`` key (deleted
    after unless ``keep``)."""
    from backend.app.services.versioning import job_lease, models
    from backend.app.services.versioning.bootstrap_worker import (
        BootstrapRunner, bootstrap_status, create_bootstrap_job)
    from backend.app.services.versioning.import_export import uploads
    from backend.app.services.versioning.projection import FalkorProjector
    from backend.app.services.view_transfer.package import INSPECTION

    await models.create_schema_and_partitions()
    factory = factory or falkor_factory()
    record = await uploads.read_record(store, upload_key)
    found = (await _read_json(store, uploads.upload_key(record, INSPECTION)))["package"]
    data = found.get("data") or {}
    name, ds = _new_id("gvt_bench"), _new_id("ds_bench")
    res = await create_bootstrap_job(
        data_source_id=ds, workspace_id=WORKSPACE, actor=ACTOR, falkor_graph_name=name, falkor_provider=None,
        ontology_enforcement="permissive", origin="package", payload_uri=upload_key,
        upload_id=record["uploadId"],
        package={"integrity": found.get("integrity"), "scope": found.get("scope"),
                 "manifest": {"nodes": data.get("nodes"), "edges": data.get("edges"), "version": data.get("version")},
                 "typeStats": data.get("typeStats"), "bytes": record["archive"].get("bytes")})
    runner = BootstrapRunner(factory, on_rollups_stale=_noop, store=store,
                             projector=FalkorProjector(factory, on_rollups_stale=_noop))
    client = await _client(factory, name)
    try:
        async with probing(store) as probes:
            out = await run_claimed(runner, res["job_id"], job_lease.BOOTSTRAP_TYPES, job_lease.BOOTSTRAP_READY)
        status = await bootstrap_status(data_source_id=ds)
        pg, fc = await _counts(res["graph_id"], client, owned=True)
    finally:
        if not keep:
            with contextlib.suppress(Exception):
                await client.delete()
    failed, warned = _failed_checks(status)
    return _result("seed", probes.summary(),
                   {"falkor_eq_pg": pg == fc, "pg": list(pg), "falkor": list(fc), "failed_checks": len(failed)},
                   status=out.get("status"), error=status.get("error"), jobId=res["job_id"],
                   failure=status.get("failure"), failedChecks=failed, warnings=warned,
                   seeded={"graphId": res["graph_id"], "falkorGraph": name if keep else None,
                           "collapsed": status.get("collapsed")})


async def run_bootstrap(*, graph: str, auto_decide: bool = True, factory=None) -> Dict[str, Any]:
    """"Enable version control" on the FalkorDB graph ``graph``: the pre-flight's pause on its
    duplicates (time to it, and the version rows written by then: none), the decision to collapse
    them, and the copy after it — then FalkorDB counted against Postgres, and the verify of the
    first publish after."""
    from sqlalchemy import func, select

    from backend.app.services.versioning import db, job_lease, models
    from backend.app.services.versioning.bootstrap_worker import (
        BootstrapRunner, bootstrap_status, create_bootstrap_job, decide_duplicates)
    from backend.app.services.versioning.models import NodeVersionORM
    from backend.app.services.versioning.projection import FalkorProjector

    await models.create_schema_and_partitions()
    factory = factory or falkor_factory()
    ds = _new_id("ds_bench")
    res = await create_bootstrap_job(data_source_id=ds, workspace_id=WORKSPACE, actor=ACTOR,
                                     falkor_graph_name=graph, falkor_provider=None)
    gid, job_id = res["graph_id"], res["job_id"]
    runner = BootstrapRunner(factory, on_rollups_stale=_noop)
    extra: Dict[str, Any] = {}
    async with probing() as probes:
        out = await run_claimed(runner, job_id, job_lease.BOOTSTRAP_TYPES, job_lease.BOOTSTRAP_READY)
        status = await bootstrap_status(data_source_id=ds)
        if out["status"] == "paused":
            extra["pause_s"] = round(time.monotonic() - probes.started, 2)
            async with db.graphver_session() as s:
                extra["version_rows_at_pause"] = int((await s.execute(select(func.count()).select_from(
                    NodeVersionORM).where(NodeVersionORM.graph_id == gid))).scalar_one())
            if auto_decide:
                probes.mark("decision")
                decided = time.monotonic()
                await decide_duplicates(data_source_id=ds, fingerprint=status["duplicates"]["fingerprint"],
                                        actor=ACTOR)
                out = await run_claimed(runner, job_id, job_lease.BOOTSTRAP_TYPES, job_lease.BOOTSTRAP_READY)
                extra["after_decision_s"] = round(time.monotonic() - decided, 2)
    final = await bootstrap_status(data_source_id=ds)
    client = await _client(factory, graph)
    if out["status"] == "completed":
        pg, fc = await _counts(gid, client, owned=False)
        extra.update(falkor_eq_pg=pg == fc, pg=list(pg), falkor=list(fc),
                     verify_clean=await _first_publish_verifies(gid, FalkorProjector(factory)))
    failed, warned = _failed_checks(final)
    dup = status.get("duplicates") or {}
    return _result("bootstrap", probes.summary(), extra, status=out["status"], error=final.get("error"),
                   jobId=job_id, failure=final.get("failure"), failedChecks=failed, warnings=warned,
                   duplicates={k: dup.get(k) for k in ("identifiers", "extraCopies", "sameType", "crossType")},
                   enabled={"graphId": gid, "falkorGraph": graph, "dataSourceId": ds})


async def _first_publish_verifies(graph_id: str, projector) -> bool:
    """One edit published on the enabled graph and projected in place: does its verify come back
    clean (FalkorDB counted as the reconciler counts a graph the projector does not own)?"""
    from backend.app.services.versioning.import_export.snapshot import open_snapshot
    from backend.app.services.versioning.service import GraphVersioningService

    svc = GraphVersioningService()
    snap = await open_snapshot(graph_id=graph_id, page_size=1)
    async for page in snap.iter_live("node", payload=True):
        node = page[0]
        break
    payload = {**json.loads(node.payload), "displayName": "renamed by the benchmark"}
    await svc.apply_ops(graph_id=graph_id, actor=ACTOR, message="bench edit", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": node.entity_id, "payload": payload}])
    return (await projector.project_graph(graph_id)).get("verify_error") is None


# ── State, output, CLI ────────────────────────────────────────────────────────


def _load_state(path: str) -> Dict[str, Any]:
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _save_state(path: str, state: Dict[str, Any]) -> None:
    with open(path, "w") as f:
        json.dump(state, f, indent=2, default=str)


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:,.2f}"
    if isinstance(value, int) and not isinstance(value, bool):
        return f"{value:,}"
    return str(value)


def markdown(results: List[Dict[str, Any]]) -> str:
    """The results as one table of targets, then each run's probes."""
    lines = ["| run | target | actual | ok |", "|---|---|---|---|"]
    for r in results:
        name = r.get("label") or r["run"]
        done = r.get("status") == "completed"
        lines.append(f"| **{name}** | completes | {r.get('status')} | {'✅' if done else '❌'} |")
        for c in r["checks"]:
            lines.append(f"| {name} | {c['label']} ({c['metric']} {c['target']}) | {_fmt(c['actual'])} "
                         f"| {'✅' if c['ok'] else '❌'} |")
    for r in results:
        p, m = r["probes"], r["metrics"]
        lines += ["", f"### {r.get('label') or r['run']} — {r.get('status')} in {_fmt(m['total_s'])} s"]
        if r.get("error"):
            lines.append(f"- error: {r['error']}")
        lines.append("- phases (s): " + ", ".join(f"{k} {_fmt(v)}" for k, v in p["phases"].items()))
        if p["windows"]:
            lines.append("- windows: " + "; ".join(
                f"{k} n={w['n']} p50 {w['p50']} s max {w['max']} s"
                + (f" decile growth {w['decileGrowth']:+.0%}" if w["decileGrowth"] is not None else "")
                + (" ⚠" if w["flagged"] else "") for k, w in p["windows"].items()))
        lines.append(f"- statements: {_fmt(p['statements']['total'])} "
                     f"({', '.join(f'{k} {_fmt(v)}' for k, v in p['statements'].items() if k != 'total')})")
        lines.append(f"- FalkorDB: {_fmt(p['falkor']['queries'])} queries, {_fmt(p['falkor']['secs'])} s")
        if p.get("slowestStatements") and p["slowestStatements"][0]["secs"] >= 1:
            lines.append("- slowest SQL: " + "; ".join(
                f"{q['secs']} s in {q['phase']}: `{q['sql'][:110]}`" for q in p["slowestStatements"][:3]))
        lag = p["loopLagMs"]
        lines.append(f"- loop lag (ms): p50 {lag['p50']}, p99 {lag['p99']}, max {lag['max']} "
                     f"(worst by phase: {', '.join(f'{k} {v}' for k, v in lag['maxByPhase'].items())})")
        lines.append(f"- RSS (MB): start {p['rssMb']['start']}, peak {p['rssMb']['peak']}, "
                     f"process high-water {p['rssMb']['maxrss']}")
        if p["store"]:
            s = p["store"]
            lines.append(f"- object store: wrote {s['putBytes'] / 2 ** 20:,.1f} MB in {s['puts']} puts, "
                         f"read {s['readBytes'] / 2 ** 20:,.1f} MB in {s['openStreams']} streams")
        if p["lock"]:
            lines.append(f"- publish lock: held {p['lock']['holdMaxSecs']} s, waited {p['lock']['waitMaxSecs']} s")
        shown = {k: v for k, v in m.items() if k not in ("total_s",)}
        lines.append("- metrics: " + ", ".join(f"{k} {_fmt(v)}" for k, v in shown.items()))
    return "\n".join(lines) + "\n"


def _emit(result: Dict[str, Any], args, state: Dict[str, Any]) -> int:
    if args.label:
        result["label"] = args.label
    state.setdefault("results", []).append(result)
    _save_state(args.state, state)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(result, f, indent=2, default=str)
    text = markdown([result])
    if args.md:
        with open(args.md, "a") as f:
            f.write(text)
    print(text)
    missed = [c for c in result["checks"] if not c["ok"]]
    if result.get("status") not in ("completed", "paused"):     # paused: a bootstrap not decided
        print(f"!! {result['run']} did not complete: {result.get('status')} {result.get('error') or ''}")
        return 1
    if args.check and missed:
        print("!! targets missed: " + "; ".join(f"{c['label']}: {_fmt(c['actual'])}" for c in missed))
        return 1
    return 0


async def _run(args) -> int:
    from backend.app.services.versioning import db

    state = _load_state(args.state)
    store = counting_store()
    try:
        if args.kind == "inspect":
            if not args.package:
                raise SystemExit("run inspect needs --package")
            result = await run_inspect(package=args.package, store=store)
            if result["status"] == "completed":
                state["upload"] = result["upload"]
        elif args.kind in ("import", "seed"):
            upload = args.upload or (state.get("upload") or {}).get("key")
            if args.package:
                inspected = await run_inspect(package=args.package, store=store)
                if inspected["status"] != "completed" or inspected.get("error"):
                    raise SystemExit(f"the package did not inspect: {inspected.get('error')}")
                upload = inspected["upload"]["key"]
            if not upload:
                raise SystemExit("no upload: run inspect first, or pass --package or --upload")
            if args.kind == "seed":
                result = await run_seed(upload_key=upload, store=store, keep=args.keep)
            else:
                target = None
                if args.target == "published":
                    target = (state.get("published") or {}).get("graphId")
                    if not target:
                        raise SystemExit("--target published: run publish first")
                elif args.target.startswith("graph:"):
                    target = args.target.split(":", 1)[1]
                result = await run_import(upload_key=upload, store=store, graph_id=target)
                if result["status"] == "completed":
                    state["draft"] = result["draft"]
        elif args.kind == "publish":
            draft = state.get("draft") or {}
            graph_id, branch_id = args.graph_id or draft.get("graphId"), args.branch_id or draft.get("branchId")
            if not (graph_id and branch_id):
                raise SystemExit("run publish needs a draft: run import first, or pass --graph-id and --branch-id")
            result = await run_publish(graph_id=graph_id, branch_id=branch_id, store=store,
                                       containment=args.containment_types.split(","))
            if result["status"] == "completed":
                state["published"] = result["published"]
        elif args.kind == "export":
            graph_id = args.graph_id or (state.get("published") or {}).get("graphId")
            if not graph_id:
                raise SystemExit("run export needs a published graph: run publish first, or pass --graph-id")
            result = await run_export(graph_id=graph_id, store=store, out=args.out)
        else:
            if not args.graph:
                raise SystemExit("run bootstrap needs --graph (a FalkorDB graph: see gen-falkor)")
            result = await run_bootstrap(graph=args.graph, auto_decide=args.auto_decide)
    finally:
        await db.dispose_engine()
        from backend.app.db.engine import close_db
        with contextlib.suppress(Exception):
            await close_db()
    return _emit(result, args, state)


async def _gen_falkor(args) -> int:
    from falkordb.asyncio import FalkorDB

    from backend.app.providers.falkordb_connection import assert_standalone_env

    # Plain standalone Redis only, as the other FalkorDB scripts: --drop against a Cluster or a
    # Sentinel replica would half-apply.
    assert_standalone_env("bench_versioning.py")
    db = FalkorDB(host=os.getenv("FALKORDB_HOST", "localhost"), port=int(os.getenv("FALKORDB_PORT", "6379")))
    client = db.select_graph(args.graph)
    if args.drop:
        with contextlib.suppress(Exception):
            await client.delete()
        client = db.select_graph(args.graph)
    elif args.graph in {k.decode() if isinstance(k, bytes) else k for k in await db.list_graphs()}:
        raise SystemExit(f"{args.graph} exists: pass --drop to write it again")
    made = await gen_falkor(client, nodes=args.nodes, edges=args.edges, dupes=args.dupes,
                            cross_label=args.cross_label, containment=args.containment,
                            depth=args.containment_depth, seed=args.seed, string_synced=args.string_synced)
    print(json.dumps(made))
    return 0


def _report(args) -> int:
    results = _load_state(args.state).get("results") or []
    text = markdown(results)
    if args.md:
        with open(args.md, "w") as f:
            f.write(text)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2, default=str)
    print(text)
    return 0


class _LocalhostCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Send ``Secure`` cookies over plain http too (a dev stack), as ``scripts/versioning_smoke.py``."""

    def return_ok_secure(self, cookie, request):  # noqa: D102
        return True


def _e2e(args) -> int:
    """The new-source flow over HTTP against a running stack (with its lane workers): upload the
    package in parts, complete it, wait for its check, ask for a new data source from it and follow
    the seed — each request's latency and each stage's time recorded. Login and workspace as
    ``scripts/versioning_smoke.py`` does them."""
    import httpx

    base = args.base.rstrip("/")
    timings: Dict[str, List[float]] = {}
    stages: Dict[str, float] = {}

    def call(client, method: str, name: str, url: str, **kw):
        t = time.monotonic()
        resp = client.request(method, url, **kw)
        timings.setdefault(name, []).append(time.monotonic() - t)
        if resp.status_code >= 400:
            raise SystemExit(f"{name}: HTTP {resp.status_code} {resp.text[:300]}")
        return resp

    def until(client, name: str, url: str, done: Callable[[dict], bool], timeout: float, **kw) -> dict:
        deadline, delay = time.monotonic() + timeout, 1.0
        while True:
            body = call(client, "GET", name, url, **kw).json()
            if done(body):
                return body
            if time.monotonic() > deadline:
                raise SystemExit(f"{name}: still {body.get('status')} after {timeout:.0f} s")
            time.sleep(delay)
            delay = min(delay * 2, 5.0)

    jar = http.cookiejar.CookieJar(policy=_LocalhostCookiePolicy())
    with httpx.Client(base_url=base, timeout=120.0, cookies=httpx.Cookies(jar)) as c:
        call(c, "POST", "login", "/api/v1/auth/login", json={"email": args.email, "password": args.password})
        c.headers["X-CSRF-Token"] = c.cookies.get("nx_csrf") or ""
        ws = args.workspace or call(c, "GET", "workspaces", "/api/v1/admin/workspaces").json()[0]["id"]
        t = time.monotonic()
        size = os.path.getsize(args.package)
        up = call(c, "POST", "upload:create", "/api/v1/views/transfer/packages/uploads",
                  json={"fileName": os.path.basename(args.package), "size": size}).json()
        with open(args.package, "rb") as f:
            for n in range(up["parts"]):
                data = f.read(up["partBytes"])
                if up.get("partUrls"):           # straight to the bucket: no cookies, no CSRF
                    t_part = time.monotonic()
                    resp = httpx.put(up["partUrls"][n], content=data, timeout=120.0)
                    timings.setdefault("upload:part", []).append(time.monotonic() - t_part)
                    resp.raise_for_status()
                else:
                    call(c, "PUT", "upload:part", f"/api/v1/views/transfer/packages/uploads/{up['uploadId']}/parts/{n}",
                         content=data)
        stages["upload"] = time.monotonic() - t
        t = time.monotonic()
        call(c, "POST", "upload:complete", f"/api/v1/views/transfer/packages/uploads/{up['uploadId']}/complete")
        checked = until(c, "upload:status", f"/api/v1/views/transfer/packages/uploads/{up['uploadId']}",
                        lambda b: b.get("status") in ("ready", "invalid"), args.timeout)
        stages["inspect"] = time.monotonic() - t
        if checked["status"] != "ready":
            raise SystemExit(f"the package did not check: {checked.get('error')}")
        result: Dict[str, Any] = {"run": "e2e", "workspaceId": ws, "uploadId": up["uploadId"]}
        if args.provider:
            t = time.monotonic()
            made = call(c, "POST", "new-source", f"/api/v1/views/transfer/packages/{up['uploadId']}/new-source",
                        json={"requestId": "nsr_" + uuid.uuid4().hex, "workspaceId": ws,
                              "providerId": args.provider, "label": "Benchmark copy",
                              "graphName": args.graph_name or _new_id("bench_copy"), "ontologyId": None}).json()
            status = until(c, "bootstrap:status", f"/api/v1/{ws}/graph/bootstrap/status",
                           lambda b: b.get("status") in ("completed", "failed", "cancelled"), args.timeout,
                           params={"dataSourceId": made["dataSourceId"]})
            stages["seed"] = time.monotonic() - t
            result.update(status=status["status"], dataSourceId=made["dataSourceId"], failure=status.get("failure"))
        else:
            result["status"] = "completed"
    result["stagesSecs"] = {k: round(v, 2) for k, v in stages.items()}
    result["requestsMs"] = {k: {"n": len(v), "p50": round(_pct(v, 0.5) * 1000), "p95": round(_pct(v, 0.95) * 1000),
                                "max": round(max(v) * 1000)} for k, v in timings.items()}
    print(json.dumps(result, indent=2))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(result, f, indent=2)
    return 0 if result["status"] == "completed" else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def shape(p):
        p.add_argument("--nodes", type=int, default=100_000)
        p.add_argument("--edges", type=int, default=100_000)
        p.add_argument("--containment", type=float, default=0.5,
                       help="fraction of the edges that are containment (HAS)")
        p.add_argument("--containment-depth", type=int, default=3)
        p.add_argument("--seed", type=int, default=7)

    gp = sub.add_parser("gen-package", help="write a view package of a generated graph")
    shape(gp)
    gp.add_argument("--out", required=True)
    gp.add_argument("--format", type=int, choices=(1, 2), default=1,
                    help="data format: 1 (what the exporter writes today) or 2 (native lines)")
    gp.add_argument("--urnless", type=float, default=0.0, help="fraction of the nodes with no urn")
    gp.add_argument("--case-variants", type=float, default=0.0,
                    help="fraction of the lineage edges whose type is spelled in another case")
    gp.add_argument("--bad-rows", type=int, default=0, help="lines a reader must turn away")
    gp.add_argument("--offset", type=int, default=0, help="number the entities from here")

    gf = sub.add_parser("gen-falkor", help="write a source graph into FalkorDB (UNWIND CREATE)")
    shape(gf)
    gf.add_argument("--graph", required=True, help="the FalkorDB graph to write (name it gvt_*)")
    gf.add_argument("--dupes", type=int, default=0, help="extra nodes sharing an existing node's urn")
    gf.add_argument("--cross-label", type=float, default=0.0,
                    help="fraction of the duplicates under another label")
    gf.add_argument("--string-synced", action="store_true",
                    help="write no duplicate's lastSyncedAt as a bare number")
    gf.add_argument("--drop", action="store_true", help="delete the graph first")

    run = sub.add_parser("run", help="run one job in this process, measured")
    report = sub.add_parser("report", help="all results in the state file, as one table")
    for parser in (run, report):
        parser.add_argument("--state", default=DEFAULT_STATE)
        parser.add_argument("--json", help="also write the result(s) as JSON here")
        parser.add_argument("--md", help="also write the Markdown here (run: appended)")
    run.add_argument("kind", choices=("export", "inspect", "import", "publish", "seed", "bootstrap"))
    run.add_argument("--package", help="a package to upload (and inspect) first")
    run.add_argument("--upload", help="an inspected upload's record key (default: the state's)")
    run.add_argument("--target", default="empty",
                     help="import into: empty (a new graph), published (the last published one), graph:<id>")
    run.add_argument("--graph-id", help="publish/export: the graph (default: the state's)")
    run.add_argument("--branch-id", help="publish: the draft (default: the last import's)")
    run.add_argument("--containment-types", default=CONTAINS, help="publish: comma-separated")
    run.add_argument("--graph", help="bootstrap: the FalkorDB source graph")
    run.add_argument("--auto-decide", action="store_true", help="bootstrap: collapse the duplicates it pauses on")
    run.add_argument("--keep", action="store_true", help="seed: keep the new FalkorDB key")
    run.add_argument("--out", help="export: save the package here")
    run.add_argument("--label", help="the result's name in reports")
    run.add_argument("--check", action="store_true", help="exit 1 when a target is missed")

    e2e = sub.add_parser("e2e", help="the new-source flow over HTTP against a running stack")
    e2e.add_argument("--base", required=True)
    e2e.add_argument("--package", required=True)
    e2e.add_argument("--email", default=os.getenv("SYNODIC_USER", "admin@synodic.local"))
    e2e.add_argument("--password", default=os.getenv("SYNODIC_PASSWORD", "admin123"))
    e2e.add_argument("--workspace")
    e2e.add_argument("--provider", help="FalkorDB provider for the new data source (else: upload and check only)")
    e2e.add_argument("--graph-name")
    e2e.add_argument("--timeout", type=float, default=900)
    e2e.add_argument("--json")

    args = ap.parse_args(argv)
    if args.cmd == "gen-package":
        made = asyncio.run(gen_package(
            args.out, nodes=args.nodes, edges=args.edges, fmt=args.format, containment=args.containment,
            depth=args.containment_depth, urnless=args.urnless, case_variants=args.case_variants,
            bad_rows=args.bad_rows, offset=args.offset, seed=args.seed))
        print(json.dumps(made))
        return 0
    if args.cmd == "gen-falkor":
        return asyncio.run(_gen_falkor(args))
    if args.cmd == "report":
        return _report(args)
    if args.cmd == "e2e":
        return _e2e(args)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
