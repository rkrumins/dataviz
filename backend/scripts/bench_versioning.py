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
                20% slower than the first (work that grows with what is already there) — and, for
                a bulk property job's windows, the SQL statements each one sent
  field checks  how long a publish spent judging its values by their fields' rules, page by page

Usage, from the repository root, with the backend's environment (MANAGEMENT_DB_URL, FALKORDB_HOST,
FALKORDB_PORT; OBJECT_STORE_BACKEND picks the store, ``database`` by default)::

  python -m backend.scripts.bench_versioning gen-package --nodes 100000 --edges 100000 --out /tmp/p100k.zip
  python -m backend.scripts.bench_versioning run inspect --package /tmp/p100k.zip --check
  python -m backend.scripts.bench_versioning run import --target empty --check
  python -m backend.scripts.bench_versioning run publish --check
  python -m backend.scripts.bench_versioning run project --check
  python -m backend.scripts.bench_versioning run export --check
  python -m backend.scripts.bench_versioning run project --full --keep --label rebuild
  python -m backend.scripts.bench_versioning run property --check
  python -m backend.scripts.bench_versioning run draft-search --check
  python -m backend.scripts.bench_versioning run undo --check
  python -m backend.scripts.bench_versioning run property --check
  python -m backend.scripts.bench_versioning run publish --field-rules fail --check
  python -m backend.scripts.bench_versioning run publish --field-rules hold --check
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

After the published graph: ``run property`` opens a new draft of it and gives every node a
property there by a bulk property job (``--op set`` writes ``bench_owner``; ``--op rename`` moves
``owner`` to it), and that draft is the state's draft from then on. ``run draft-search`` reads the
draft's rule counts and property catalog as the draft-aware search answers them, over the FalkorDB
key ``run project --keep`` left of the published graph. ``run undo`` undoes that job, a window
per commit it wrote, and checks a sample of the draft's nodes holds what it held before; an undone
draft reads as the published graph, so a draft to search or publish is another ``run property``'s.
``run publish --field-rules hold`` publishes the draft with a required ``bench_owner`` field on
every type, so every page's field check runs and passes; ``--field-rules fail`` makes the
attributes' ``bench_owner`` a number field, which the job's text breaks, so the publish is refused
(409) and must count every attribute.

What is NOT the production path, and why:
* ``run export`` builds the views' file from a bench view (there are no views in the management DB
  to seal); the bundle is a few KB of the job's work, the data is everything else.
* ``run publish``'s hook publishes with ``--containment-types`` given here, where the API's hook
  reads them from the data source's ontology in the management DB; the cache bump and view
  touches that follow a publish there are left out (they are per-publish, not per-entity).
* ``run seed``/``run bootstrap`` use the env FalkorDB instance (no provider registry) and no
  rollup rebuild (a bench graph has no rollups).
* ``run property``'s targets hook streams every live node's urn of ``main`` from the versioned
  store (``Snapshot.iter_live``), where the API's exports the job's search (``POST
  /search/exports``) and reads its file back; and its windows, and ``run undo``'s, are written
  with the ``--containment-types`` given here and no ontology rules, where the API reads the data
  source's.
* ``run draft-search`` calls the draft provider's search methods as ``AdvancedSearchService``'s
  ``counts`` and ``catalog`` call them, over a ``FalkorDBProvider`` of the key (env instance, no
  provider registry), in the whole data source's scope (no view to resolve). ``main``'s counts and
  catalog are read to the end first, as ``main``'s own readers leave them (their requests are
  reported apart), so the draft's requests are the draft's correction.
* ``run publish --field-rules`` gives the publish its field rules here, where the API's hook reads
  them from the data source's ontology; a refusal is the job's answer, as the API's hook gives it.
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
    "project": [("rss_peak_mb", "<", 300, "RSS <300 MB"),
                ("falkor_eq_pg", "==", True, "FalkorDB == Postgres")],
    "seed": [("total_s", "<=", 240, "seed ≤4 min"),
             ("rss_peak_mb", "<", 300, "RSS <300 MB"),
             ("falkor_eq_pg", "==", True, "FalkorDB == Postgres"),
             ("loop_max_ms", "<=", 500, "job-loop max lag ≤500 ms")],
    # Held at any size: a window is PROPERTY_JOB_WINDOW entities, a request a page of the draft's.
    # A window sent 45 statements at 10k and at 100k: 100 leaves room for the lease's heartbeats.
    "property": [("rss_peak_mb", "<=", 512, "RSS ≤512 MB"),
                 ("window_max_s", "<=", 15, "no window >15 s"),
                 ("window_statements_max", "<=", 100, "≤100 SQL statements a window"),
                 ("changed_all", "==", True, "every node changed")],
    # A window per commit the job wrote: as the commit wrote it, as it was before, as it is now.
    "undo": [("rss_peak_mb", "<=", 512, "RSS ≤512 MB"),
             ("window_max_s", "<=", 15, "no window >15 s"),
             ("window_statements_max", "<=", 100, "≤100 SQL statements a window"),
             ("changed_all", "==", True, "every node the job changed put back"),
             ("restored_ok", "==", True, "a sample holds what it held before the job")],
    "draft-search": [("requests", "<=", 60, "answered within 60 requests"),
                     ("answered_ok", "==", True, "exact, or main's with the cutoff note past it"),
                     ("rss_peak_mb", "<=", 512, "RSS ≤512 MB")],
    "publish-fields": [("rss_peak_mb", "<=", 1024, "RSS ≤1 GB"),
                       ("refusal_ok", "==", True, "refused only as the rules ask, counting all")],
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
        self.window_statements: Dict[str, List[int]] = {}
        self.field_checks: List[float] = []
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
        from backend.app.services.versioning.import_export.property_job import PropertyJobWorker
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

        def property_window(original):
            # One window: a chunk of the job's targets read from the draft — or, an undo's, one
            # commit of the job it undoes — planned and written as one commit with the checkpoint.
            async def _next_window(worker, job_id, job, context):
                t, sent = time.monotonic(), sum(probes.statements.values())
                more = await original(worker, job_id, job, context)
                if more:
                    label = "undo" if job["op"]["kind"] == "undo" else "property"
                    probes.record_window(label, time.monotonic() - t)
                    probes.window_statements.setdefault(label, []).append(sum(probes.statements.values()) - sent)
                return more
            return _next_window

        def field_check(original):
            # A publish's field check: once for a batch publish, once a page for a paged one.
            async def _field_violations(svc, *args, **kwargs):
                t = time.monotonic()
                try:
                    return await original(svc, *args, **kwargs)
                finally:
                    probes.field_checks.append(time.monotonic() - t)
            return _field_violations

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
        self._patch(PropertyJobWorker, "_next_window", property_window)
        self._patch(GraphVersioningService, "_field_violations", field_check)
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
            "windowStatements": {label: {"n": len(ns), "p50": _pct(ns, 0.5), "max": max(ns)}
                                 for label, ns in self.window_statements.items()},
            "fieldChecks": {"n": len(self.field_checks), "secs": round(sum(self.field_checks), 2),
                            "maxSecs": round(max(self.field_checks), 2)} if self.field_checks else None,
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
        **({"window_statements_max": max(w["max"] for w in summary["windowStatements"].values())}
           if summary["windowStatements"] else {}),
        **({"field_check_s": summary["fieldChecks"]["secs"]} if summary["fieldChecks"] else {}),
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


def _service(store, svc=None, publish_hook=None, **hooks):
    from backend.app.services.versioning.import_export.service import ImportExportService
    from backend.app.services.versioning.service import GraphVersioningService

    return ImportExportService(versioning=svc or GraphVersioningService(), store=store,
                               publish_hook=publish_hook, **hooks)


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


async def _live_count(graph_id: str, branch_id: str, kind: Optional[str] = None) -> int:
    from sqlalchemy import func, select

    from backend.app.services.versioning import db
    from backend.app.services.versioning.models import EntityHeadORM

    async with db.graphver_session() as s:
        return int((await s.execute(select(func.count()).select_from(EntityHeadORM).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
            EntityHeadORM.is_tombstone.is_(False),
            *([EntityHeadORM.entity_kind == kind] if kind else [])))).scalar_one())


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


def bench_field_rules(mode: str):
    """The field rules a ``--field-rules`` publish holds the draft to: ``hold`` — ``bench_owner``
    required on every type (every node a field check judges, and passes); ``fail`` — the
    attributes' ``bench_owner`` a number, which the job's text is not (every attribute refused)."""
    from backend.app.services.versioning.ontology import EntityRule, FieldRule, OntologyRules

    if mode == "hold":
        owner = FieldRule(type="text", required=True, name="Bench owner")
        return OntologyRules(entity_types={t: EntityRule(fields={"bench_owner": owner})
                                           for t in ("layer", "object", "group", "attribute")})
    number = FieldRule(type="number", name="Bench owner")
    return OntologyRules(entity_types={"attribute": EntityRule(fields={"bench_owner": number})})


async def _type_count(graph_id: str, branch_id: str, entity_type: str) -> int:
    """The live nodes of ``entity_type`` the branch reads (a draft: main where it began, then its
    own changes)."""
    from backend.app.services.versioning.import_export.snapshot import open_snapshot

    snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id)
    n = 0
    async for page in snap.iter_live("node"):
        n += sum(w.entity_type == entity_type for w in page)
    return n


async def run_publish(*, graph_id: str, branch_id: str, store: CountingStore,
                      containment: Sequence[str] = (CONTAINS,),
                      field_rules: Optional[str] = None) -> Dict[str, Any]:
    """Publish the draft by a publish job, as ``POST …/publish`` queues a large one. The hook is the
    API's ``_publish_from_job`` publish, with the containment types given here — and, with
    ``field_rules`` (``hold``/``fail``), the rules of :func:`bench_field_rules`, whose refusal is the
    job's answer as the API's hook gives it (409 ``field_violation``: ``fail`` must be refused,
    naming 100 and counting every attribute the draft holds)."""
    from backend.app.services.versioning import job_lease, models
    from backend.app.services.versioning.errors import FieldViolation
    from backend.app.services.versioning.import_export.runner import TransferRunner
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    rules = bench_field_rules(field_rules) if field_rules else None

    async def publish(job: Dict[str, Any]) -> Dict[str, Any]:
        if job.get("mergedCommitId"):
            return {"commitId": job["mergedCommitId"]}
        try:
            return {"commitId": await svc.publish(
                graph_id=job["graphId"], branch_id=job["branchId"], actor=job["actor"],
                message=job["message"], containment_edge_types=list(containment), queued=True,
                ontology_rules=rules)}
        except FieldViolation as exc:              # as the API's _domain_errors answers it
            return {"error": {"status": exc.status_code, "detail": exc.detail}}

    ie = _service(store, svc, publish_hook=publish)
    meta = await svc.get_graph(graph_id)
    main = await svc.main_branch_id(graph_id)
    before = await _live_count(graph_id, main)
    expected = await _type_count(graph_id, branch_id, "attribute") if field_rules == "fail" else None
    created = await ie.create_publish_job(workspace_id=meta["workspace_id"], data_source_id=meta["data_source_id"],
                                          graph_id=graph_id, branch_id=branch_id, actor=ACTOR,
                                          message="bench publish")
    job_id = created["job_id"]
    await ie.start_publish(job_id)
    async with probing(store) as probes:
        await run_claimed(TransferRunner(lambda: ie), job_id, job_lease.TRANSFER_TYPES, job_lease.TRANSFER_READY)
    job = await ie.get_job(job_id)
    after = await _live_count(graph_id, main)
    published = {"graphId": graph_id, "commitId": (job.get("summary") or {}).get("commitId"),
                 "entities": after}
    if not field_rules:
        return _result("publish", probes.summary(), {"changes": after - before},
                       status=job["status"], error=job.get("errorMessage"), jobId=job_id, published=published)
    error = (job.get("summary") or {}).get("error") or {}
    detail = error.get("detail") if isinstance(error.get("detail"), dict) else {}
    refused = error.get("status") == 409 and detail.get("type") == "field_violation"
    named = len(detail.get("violations") or [])
    extra = {"changes": after - before, "refusal_total": detail.get("total"), "refusal_named": named,
             "refusal_expected": expected,
             # hold: published. fail: refused, naming the first 100 and counting every attribute.
             "refusal_ok": (job["status"] == "completed") if field_rules == "hold" else (
                 refused and detail.get("total") == expected and named == min(100, expected))}
    return _result("publish-fields", probes.summary(), extra,
                   status="refused" if refused else job["status"],
                   expected="refused" if field_rules == "fail" else "completed",
                   error=None if refused else job.get("errorMessage"), jobId=job_id, fieldRules=field_rules,
                   byField=detail.get("byField"),
                   **({"published": published} if job["status"] == "completed" else {}))


#: The ops ``run property --op`` runs over every node: ``bench_owner`` written, or ``owner`` moved there.
PROPERTY_OPS = {"set": {"kind": "set", "key": "bench_owner", "value": "bench"},
                "rename": {"kind": "rename", "key": "owner", "to": "bench_owner"}}


def _main_urns(containment: Sequence[str]):
    """The bench's bulk property jobs' hooks: their targets — every live node of ``main``, by urn,
    a page at a time from the versioned store (where the API's exports the job's search) — and
    what their windows are written with (the containment types given here, no ontology rules)."""
    from backend.app.services.versioning.import_export.snapshot import open_snapshot

    async def targets(job: Dict[str, Any]) -> AsyncIterator[str]:
        snap = await open_snapshot(graph_id=job["graphId"])
        async for page in snap.iter_live("node"):
            for w in page:
                yield w.urn or f"gv:{w.entity_id}"

    async def write_context(_job: Dict[str, Any]) -> Dict[str, Any]:
        return {"ontology_rules": None, "containment": list(containment), "node_identity": None}

    return {"property_targets": targets, "property_write_context": write_context}


async def run_bulk_job(run: str, ie, job_id: str, store: CountingStore, *, expect_changed: int,
                       **info) -> Dict[str, Any]:
    """A queued bulk property job claimed and run on its lease by the transfer lane's runner,
    measured, with what it did — ``changed`` (all of ``expect_changed``?), refused, commits — and
    each window's time and statements in its probes. Any job the property worker runs, whatever
    made it."""
    from backend.app.services.versioning import job_lease
    from backend.app.services.versioning.import_export.runner import TransferRunner

    async with probing(store) as probes:
        await run_claimed(TransferRunner(lambda: ie), job_id, job_lease.TRANSFER_TYPES, job_lease.TRANSFER_READY)
    job = await ie.get_property_job(job_id)
    summary = job.get("summary") or {}
    probed = probes.summary()
    # Held to its own windows' growth: its target files' writes are a few milliseconds each.
    windows = probed["windows"].get("undo" if (job.get("op") or {}).get("kind") == "undo" else "property") or {}
    extra = {"decile_growth": windows.get("decileGrowth"),
             "changed": summary.get("changed"), "expected_changed": expect_changed,
             "changed_all": summary.get("changed") == expect_changed,
             "refused": (summary.get("refused") or {}).get("count"), "commits": summary.get("commits")}
    return _result(run, probed, extra, status=job["status"],
                   error=(job.get("error") or {}).get("message"), jobId=job_id, summary=summary, **info)


async def run_property(*, graph_id: str, store: CountingStore, op: str = "set",
                       containment: Sequence[str] = (CONTAINS,)) -> Dict[str, Any]:
    """A new draft of the published graph, and a bulk property job on it as ``POST
    …/property-jobs`` makes one: ``PROPERTY_OPS[op]`` over every entity a search of the whole data
    source matches — every node of ``main`` (the targets hook: :func:`_main_urns`) — written a
    window of ``PROPERTY_JOB_WINDOW`` at a time, each window one commit on the draft."""
    from pydantic import TypeAdapter

    from backend.app.services.versioning import models
    from backend.app.services.versioning.service import GraphVersioningService
    from backend.common.models.property_job import PropertyJobOp
    from backend.common.models.search import Predicate

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ie = _service(store, svc, **_main_urns(containment))
    meta = await svc.get_graph(graph_id)
    nodes = await _live_count(graph_id, await svc.main_branch_id(graph_id), kind="node")
    draft = await svc.open_draft(graph_id=graph_id, owner=ACTOR, name="Bulk property: bench")
    predicate = TypeAdapter(Predicate).validate_python({"kind": "hasProperty", "key": "owner"})
    created = await ie.create_property_job(
        workspace_id=meta["workspace_id"], data_source_id=meta["data_source_id"], graph_id=graph_id,
        branch_id=draft, actor=ACTOR, op=PropertyJobOp.model_validate(PROPERTY_OPS[op]).wire(),
        target={"viewId": "view_bench", "scopeMode": "data_source",
                "predicate": predicate.model_dump(mode="json", by_alias=True)},
        message=None, key=f"bench-property:{draft}")
    return await run_bulk_job("property", ie, created["job_id"], store, expect_changed=nodes, op=op,
                              draft={"graphId": graph_id, "branchId": draft,
                                     "dataSourceId": meta["data_source_id"]})


#: Entities ``run undo`` reads back after it, to check they hold what they held before the job.
UNDO_SAMPLE = 500


async def run_undo(*, graph_id: str, branch_id: str, job_id: str, changed: int, store: CountingStore,
                   containment: Sequence[str] = (CONTAINS,)) -> Dict[str, Any]:
    """An undo of bulk property job ``job_id`` (``run property``'s), as ``POST
    …/property-jobs/{jobId}/undo`` makes one (``ImportExportService.create_undo_job``): a window
    per commit the job wrote, newest first, each read as the commit wrote it, as it was just before
    it and as the draft holds it now. After it, a sample of the draft's nodes (``UNDO_SAMPLE``) must
    hold the properties ``main`` does, as they did before the job: its draft began at main's head."""
    from sqlalchemy import func, select

    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.models import EntityHeadORM
    from backend.app.services.versioning.service import GraphVersioningService

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ie = _service(store, svc, **_main_urns(containment))      # its windows written as the job's
    meta = await svc.get_graph(graph_id)
    created = await ie.create_undo_job(
        workspace_id=meta["workspace_id"], data_source_id=meta["data_source_id"], graph_id=graph_id,
        job_id=job_id, actor=ACTOR, key=f"bench-undo:{job_id}")
    result = await run_bulk_job("undo", ie, created["job_id"], store, expect_changed=changed,
                                sourceJobId=job_id)
    async with db.graphver_session() as s:
        sample = list((await s.execute(select(EntityHeadORM.entity_id).where(
            EntityHeadORM.graph_id == graph_id, EntityHeadORM.branch_id == branch_id,
            EntityHeadORM.entity_kind == "node").order_by(func.random()).limit(UNDO_SAMPLE))).scalars())
    differ = 0
    for eid in sample:
        now = await svc.entity_value(graph_id=graph_id, entity_id=eid, branch_id=branch_id)
        was = await svc.entity_value(graph_id=graph_id, entity_id=eid)
        differ += (now or {}).get("properties") != (was or {}).get("properties")
    result["metrics"].update(restored_sample=len(sample), restored_differ=differ,
                             restored_ok=bool(sample) and not differ)
    result["checks"] = evaluate("undo", result["metrics"])
    return result


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


async def run_project(*, graph_id: str, keep: bool = False, full: bool = False,
                      factory=None) -> Dict[str, Any]:
    """The projector's pass over the graph's last commit — the window a publish leaves it — into a
    new ``gvt_bench_*`` key (deleted after unless ``keep``): the graph is pinned there, owned and
    projected up to the commit before, so the pass writes that one window and verifies it. With
    ``full``, projected from nothing instead: the full reconcile a first seed or a rebuild runs. A
    pass that stops at ``PROJECTION_PASS_MAX_SECS`` is followed by the next, as the lane runs it."""
    from backend.app.services.versioning import db, models
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
    from backend.app.services.versioning.projection import FalkorProjector, _write_marker

    await models.create_schema_and_partitions()
    factory = factory or falkor_factory()
    name = _new_id("gvt_bench")
    async with db.graphver_session() as s, s.begin():
        head = (await s.get(GraphORM, graph_id)).main_head_commit_seq
        ps = await s.get(ProjectionStateORM, graph_id)
        if ps is None:
            ps = ProjectionStateORM(graph_id=graph_id)
            s.add(ps)
        ps.falkor_graph_name, ps.falkor_provider, ps.owns_falkor_graph = name, None, True
        ps.projected_commit_seq, ps.target_commit_seq = (0 if full else head - 1), head
        ps.status, ps.last_error, ps.failed_attempts, ps.next_retry_at = "idle", None, 0, None
    client = await _client(factory, name)
    if not full:
        await _write_marker(client, head - 1, 0)   # the key as the pass before left it
    try:
        async with probing() as probes:
            projector = FalkorProjector(factory, on_rollups_stale=_noop)
            out, passes = await projector.project_graph(graph_id), 1
            while out.get("partial"):       # past PROJECTION_PASS_MAX_SECS: the lane's next pass resumes
                out, passes = await projector.project_graph(graph_id), passes + 1
        pg, fc = await _counts(graph_id, client, owned=True)
    finally:
        if not keep:
            with contextlib.suppress(Exception):
                await client.delete()
    done = out.get("projected") == head and not out.get("verify_error")
    return _result("project", probes.summary(),
                   {"falkor_eq_pg": pg == fc, "pg": list(pg), "falkor": list(fc), "passes": passes},
                   status="completed" if done else "failed", error=out.get("verify_error"),
                   projected={"graphId": graph_id, "seq": out.get("projected"),
                              "falkorGraph": name if keep else None})


#: The rules ``run draft-search`` counts: one every node the job changed now matches (the key it
#: wrote), one a level type and one a value the job leaves alone — or, renamed away, takes from
#: every node that held it.
SEARCH_RULES = {"benchOwner": {"kind": "hasProperty", "key": "bench_owner"},
                "attributes": {"kind": "entityType", "op": "in", "values": ["attribute"]},
                "team3": {"kind": "property", "key": "owner", "op": "eq", "value": "team3"}}
#: The waits the client asks for: a counts request's first and later ones (``ruleCounts.ts``; the
#: API moves counts on for 5 s at most), and a catalog request's (``propertyCatalog.ts``).
COUNT_WAITS_MS = (1000, 5000)
CATALOG_WAIT_MS = 800
#: Requests after which a read is given up on (its target is 60).
REQUESTS_MAX = 400


async def _counts_request(overlay, scope, rules: Dict[str, Any], sessions: Dict[str, str], context,
                          wait_ms: int) -> Dict[str, Dict[str, Any]]:
    """One counts request, the draft provider's calls as ``AdvancedSearchService.counts`` makes
    them: each rule's count on main read where it has got to, the draft's correction for every
    rule at once (half the wait while main's counts move too), then main's unfinished counts moved
    on. Each rule's main count, the draft's delta, the count shown, whether it is complete and its
    note (approximate)."""
    from backend.common.models.search import SearchOptions, SearchQuery

    deadline = time.monotonic() + min(wait_ms / 1000.0, 5.0)

    def query(rid: str, wait: int):
        return SearchQuery(predicate=rules[rid], scope=scope,
                           options=SearchOptions(results="hits", wait_ms=wait, session_id=sessions.get(rid)))

    answers = {rid: await overlay.deep_search_count(query(rid, 0), context=context, advance=False)
               for rid in rules}
    pending = [rid for rid in rules if answers[rid]["status"] != "complete"]
    drafted = await overlay.deep_search_count_deltas(
        scope, list(rules.items()), context=context,
        wait_ms=max(0, int((deadline - time.monotonic()) * 1000 * (0.5 if pending else 1.0))))
    for n, rid in enumerate(pending):
        left = max(0, int((deadline - time.monotonic()) * 1000))
        if n and not left:
            break
        sessions[rid] = answers[rid]["sessionId"] or sessions.get(rid)
        answers[rid] = await overlay.deep_search_count(query(rid, left), context=context)
    drafted = drafted or {"deltas": {}, "approximate": {}, "status": "complete"}   # None: main's
    out = {}
    for rid, answer in answers.items():
        sessions[rid] = answer["sessionId"] or sessions.get(rid)
        delta = drafted["deltas"].get(rid, 0)
        out[rid] = {"main": answer["count"], "delta": delta, "count": max(0, answer["count"] + delta),
                    "complete": answer["status"] == drafted["status"] == "complete",
                    "note": drafted["approximate"].get(rid)}
    return out


async def run_draft_search(*, graph_id: str, branch_id: str, falkor_graph: str, changed: int,
                           op: str = "set") -> Dict[str, Any]:
    """The draft's rule counts (:data:`SEARCH_RULES`) and property catalog, as the draft-aware
    search answers them (``providers.draft_search``): the draft's provider over a FalkorDB provider
    of ``falkor_graph`` (main, projected), each request as the client follows it (:data:`COUNT_WAITS_MS`,
    :data:`CATALOG_WAIT_MS`) until it is complete. Main's counts and catalog are read to the end
    first, unmeasured, as main's own readers leave them.

    The draft changed ``changed`` nodes (``run property``'s ``op``). Within ``DRAFT_SEARCH_MAX_DELTA``
    its answers must be exact: each count moved by what the job did, and the catalog holding
    ``bench_owner`` on every node it changed. Past it, main's, every rule and the catalog with the
    cutoff note (``draft_search.TOO_LARGE``). Also measured: the cache Redis' memory (where the
    sessions are kept) before and after the draft's requests."""
    from falkordb.asyncio import FalkorDB
    from pydantic import TypeAdapter

    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    from backend.app.providers.draft_search import TOO_LARGE
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.deep_search import SearchRunContext
    from backend.app.services.versioning import config as vconfig
    from backend.app.services.versioning import models
    from backend.app.services.versioning.service import GraphVersioningService
    from backend.common.models.search import Predicate, SearchOptions, SearchQuery, SearchScope

    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    host, port = os.getenv("FALKORDB_HOST", "localhost"), int(os.getenv("FALKORDB_PORT", "6379"))
    # Its provider would make an empty key of a name that is gone (the integration suite's session
    # end drops every gvt_* key of the FalkorDB it is pointed at).
    if falkor_graph not in {k.decode() if isinstance(k, bytes) else k
                            for k in await FalkorDB(host=host, port=port).list_graphs()}:
        raise SystemExit(f"{falkor_graph} is not in FalkorDB any more: run project --full --keep again")
    base = FalkorDBProvider(host=host, port=port, graph_name=falkor_graph)
    await base._ensure_connected()
    rules = {rid: TypeAdapter(Predicate).validate_python(p) for rid, p in SEARCH_RULES.items()}
    scope = SearchScope(viewId="view_bench", scopeMode="data_source")
    tag = uuid.uuid4().hex[:12]                  # its own sessions: nothing an earlier run left answers
    context = SearchRunContext(data_version=f"{tag}.bench", scope_hash=f"bench-{tag}")

    def overlay():
        # One a request, as the API's engine makes one; the draft's patch set is shared by all.
        p = DraftOverlayProvider(base, svc=svc, graph_id=graph_id, branch_id=branch_id)
        p.set_containment_edge_types([CONTAINS])
        return p

    main_ctx = overlay()._main_context(context)
    main_requests, main_counts = 0, {}
    for rid in rules:
        session = None
        while True:
            main_requests += 1
            answer = await base.deep_search_count(SearchQuery(
                predicate=rules[rid], scope=scope,
                options=SearchOptions(results="hits", wait_ms=COUNT_WAITS_MS[1], session_id=session)),
                context=main_ctx)
            session = answer["sessionId"]
            if answer["status"] == "complete":
                main_counts[rid] = answer["count"]
                break
    session = None
    while True:
        main_requests += 1
        main_catalog = await base.deep_search_catalog(scope, context=main_ctx, wait_ms=CATALOG_WAIT_MS,
                                                      session_id=session)
        session = main_catalog.get("sessionId")
        if main_catalog.get("status") == "complete":
            break

    async def redis_mb() -> Optional[float]:
        if base._redis is None:
            return None
        return round((await base._redis.info("memory"))["used_memory"] / 2 ** 20, 1)

    redis_before = await redis_mb()
    requests = {"counts": 0, "catalog": 0}
    async with probing() as probes:
        probes.mark("counts")
        sessions: Dict[str, str] = {}
        while requests["counts"] < REQUESTS_MAX:
            t = time.monotonic()
            counts = await _counts_request(overlay(), scope, rules, sessions, context,
                                           COUNT_WAITS_MS[min(requests["counts"], 1)])
            probes.record_window("counts", time.monotonic() - t)
            requests["counts"] += 1
            if all(c["complete"] for c in counts.values()):
                break
        probes.mark("catalog")
        session = None
        while requests["catalog"] < REQUESTS_MAX:
            t = time.monotonic()
            catalog = await overlay().deep_search_catalog(scope, context=context, wait_ms=CATALOG_WAIT_MS,
                                                          session_id=session)
            probes.record_window("catalog", time.monotonic() - t)
            requests["catalog"] += 1
            session = catalog.get("sessionId")
            if catalog.get("status") == "complete":
                break
    redis_after = await redis_mb()

    note = TOO_LARGE.format(n=vconfig.DRAFT_SEARCH_MAX_DELTA)
    past = changed > vconfig.DRAFT_SEARCH_MAX_DELTA
    want = {"benchOwner": changed, "attributes": 0, "team3": -main_counts["team3"] if op == "rename" else 0}
    done = all(c["complete"] for c in counts.values())
    if done and all(c["note"] == note for c in counts.values()):
        counts_answer = "cutoff"
    elif done and all(c["note"] is None and c["delta"] == want[rid] for rid, c in counts.items()):
        counts_answer = "exact"
    else:
        counts_answer = "wrong"
    held = {p["key"]: p["count"] for p in catalog.get("properties") or []}
    if catalog.get("status") != "complete":
        catalog_answer = "wrong"
    elif note in (catalog.get("notes") or []):
        catalog_answer = "cutoff"
    else:
        catalog_answer = "exact" if held.get("bench_owner") == changed else "wrong"
    expected = "cutoff" if past else "exact"
    extra = {"requests": max(requests.values()), "counts_requests": requests["counts"],
             "catalog_requests": requests["catalog"], "main_requests": main_requests,
             "counts_answer": counts_answer, "catalog_answer": catalog_answer, "draft_changed": changed,
             "answered_ok": counts_answer == catalog_answer == expected,
             "redis_delta_mb": None if redis_before is None else round(redis_after - redis_before, 1)}
    return _result("draft-search", probes.summary(), extra, status="completed" if done else "running",
                   counts=counts, expectedDeltas=want, mainCounts=main_counts,
                   catalog={"status": catalog.get("status"), "entities": catalog.get("entities"),
                            "benchOwner": held.get("bench_owner"), "notes": catalog.get("notes"),
                            "progress": catalog.get("progress")},
                   redisMb={"before": redis_before, "after": redis_after})


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
        expected = r.get("expected") or "completed"            # a refusal asked for: refused
        done = r.get("status") == expected
        lines.append(f"| **{name}** | {'completes' if expected == 'completed' else 'is ' + expected} "
                     f"| {r.get('status')} | {'✅' if done else '❌'} |")
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
        if p.get("windowStatements"):
            lines.append("- statements a window: " + "; ".join(
                f"{k} p50 {w['p50']} max {w['max']}" for k, w in p["windowStatements"].items()))
        if p.get("fieldChecks"):
            f = p["fieldChecks"]
            lines.append(f"- field checks: {f['n']} in {f['secs']} s (longest {f['maxSecs']} s)")
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
    # paused: a bootstrap not decided; refused: a publish asked to be (``--field-rules fail``)
    if result.get("status") not in (result.get("expected") or "completed", "paused"):
        print(f"!! {result['run']} ended {result.get('status')}, not {result.get('expected') or 'completed'}: "
              f"{result.get('error') or ''}")
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
                                       containment=args.containment_types.split(","),
                                       field_rules=args.field_rules)
            if result["status"] == "completed":
                state["published"] = result["published"]
        elif args.kind == "project":
            graph_id = args.graph_id or (state.get("published") or {}).get("graphId")
            if not graph_id:
                raise SystemExit("run project needs a published graph: run publish first, or pass --graph-id")
            result = await run_project(graph_id=graph_id, keep=args.keep, full=args.full)
            if result["status"] == "completed" and args.keep:
                state["projected"] = result["projected"]       # for run draft-search
        elif args.kind == "property":
            graph_id = args.graph_id or (state.get("published") or {}).get("graphId")
            if not graph_id:
                raise SystemExit("run property needs a published graph: run publish first, or pass --graph-id")
            result = await run_property(graph_id=graph_id, store=store, op=args.op,
                                        containment=args.containment_types.split(","))
            if result["status"] == "completed":
                # The draft every later run reads and publishes, and the job (an undo's source).
                state["draft"] = result["draft"]
                state["property"] = {"jobId": result["jobId"], "op": args.op, **result["draft"],
                                     "changed": result["metrics"]["changed"]}
        elif args.kind == "undo":
            made = state.get("property") or {}
            if not made:
                raise SystemExit("run undo needs run property's job: run property first")
            result = await run_undo(graph_id=made["graphId"], branch_id=made["branchId"], job_id=made["jobId"],
                                    changed=made["changed"], store=store,
                                    containment=args.containment_types.split(","))
            if result["status"] == "completed":
                made["undoneBy"] = result["jobId"]
        elif args.kind == "draft-search":
            made = state.get("property") or {}
            projected = state.get("projected") or {}
            if not made or made.get("undoneBy"):
                raise SystemExit("run draft-search needs run property's draft, not undone: run property first")
            if projected.get("graphId") != made["graphId"] or not projected.get("falkorGraph"):
                raise SystemExit("run draft-search needs the published graph in FalkorDB: "
                                 "run project --full --keep first")
            result = await run_draft_search(graph_id=made["graphId"], branch_id=made["branchId"],
                                            falkor_graph=projected["falkorGraph"], changed=made["changed"],
                                            op=made["op"])
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
    run.add_argument("kind", choices=("export", "inspect", "import", "project", "publish", "seed", "bootstrap",
                                      "property", "undo", "draft-search"))
    run.add_argument("--package", help="a package to upload (and inspect) first")
    run.add_argument("--upload", help="an inspected upload's record key (default: the state's)")
    run.add_argument("--target", default="empty",
                     help="import into: empty (a new graph), published (the last published one), graph:<id>")
    run.add_argument("--graph-id", help="publish/project/export/property: the graph (default: the state's)")
    run.add_argument("--branch-id", help="publish: the draft (default: the last import's or property run's)")
    run.add_argument("--containment-types", default=CONTAINS, help="publish, property, undo: comma-separated")
    run.add_argument("--field-rules", choices=("hold", "fail"),
                     help="publish: with field rules every node holds, or every attribute breaks")
    run.add_argument("--op", choices=tuple(PROPERTY_OPS), default="set",
                     help="property: set bench_owner, or rename owner to it")
    run.add_argument("--graph", help="bootstrap: the FalkorDB source graph")
    run.add_argument("--auto-decide", action="store_true", help="bootstrap: collapse the duplicates it pauses on")
    run.add_argument("--keep", action="store_true",
                     help="seed, project: keep the new FalkorDB key (a kept projection: draft-search's)")
    run.add_argument("--full", action="store_true",
                     help="project: from nothing (a first seed's or a rebuild's full reconcile)")
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
