"""Every run leaves a record of what it ran with and what it adapted to.

The pipeline hands the worker, at every checkpoint, the effective tuning
(every knob's value and where it came from) and the ladder's ``adapted``
record; the worker folds them into ``run_stats`` inside the commit it was
already going to make, adds the stall window / wall clock it owns, and on
success merges the pipeline's final stats OVER that document rather than
replacing it. A run that fails or is cancelled keeps its record.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from backend.app.jobs import JobScope as PlatformJobScope
from backend.app.services.aggregation.worker import (
    AggregationWorker, _adapted_scalars, _merge_run_doc,
)


def _run(coro):
    return asyncio.run(coro)


# ── pure helpers ────────────────────────────────────────────────────────


def test_merge_run_doc_lets_later_values_win_and_keeps_the_rest():
    doc = _merge_run_doc({"effective_tuning": {"a": 1}, "adapted": {"scan_width": 5}}, {"writes": 3, "adapted": {"scan_width": 9}})
    assert doc == {"effective_tuning": {"a": 1}, "adapted": {"scan_width": 9}, "writes": 3}
    assert _merge_run_doc(None, {"x": 1}) == {"x": 1}
    assert _merge_run_doc("garbage", None) == {}


def test_adapted_scalars_are_the_live_subset():
    scalars = _adapted_scalars({
        "scan_width": 12_500, "scan_shrinks": 3, "reconcile_strategy": "keys_only",
        "pressure": [{"scan": "x"}], "by_scan": {"x": {}}, "write_batch": None,
    })
    assert scalars == {
        "adapted_scan_width": 12_500, "adapted_scan_shrinks": 3,
        "adapted_reconcile_strategy": "keys_only",
    }
    assert _adapted_scalars(None) == {}
    # Live changes in force ride along, flattened, so the running row can show them.
    assert _adapted_scalars({"live": {"write_pacing_ratio": 2.0, "scan_width": 5_000, "junk": [1]}}) == {
        "adapted_live_write_pacing_ratio": 2.0, "adapted_live_scan_width": 5_000,
    }


# ── the checkpoint records it, on the commit it was making anyway ──────


class _Job:
    def __init__(self, *, run_stats=None, timeout_secs=None, tuning_json=None):
        self.id = "agg_rec1"
        self.data_source_id = "ds_1"
        self.tuning_json = tuning_json
        self.run_stats = run_stats
        self.timeout_secs = timeout_secs
        self.max_retries = 3
        self.batch_size = 1000
        self.last_cursor = None
        self.processed_edges = 0
        self.total_edges = 0
        self.created_edges = 0
        self.progress = 0
        self.current_phase = None
        self.updated_at = None
        self.last_checkpoint_at = None
        self.last_sequence = 0


class _Session:
    def __init__(self):
        self.commits = 0

    async def commit(self):
        self.commits += 1

    async def rollback(self):
        pass

    async def get(self, *_a, **_k):
        return None


class _Emitter:
    def __init__(self):
        self.published: list[dict] = []

    async def publish(self, **kw):
        self.published.append(kw)


class _Provider:
    """Drives the progress callback the way the pipeline does: the first
    checkpoint carries the effective tuning, a later one the adaptation."""

    def __init__(self, stats_per_checkpoint):
        self._stats = stats_per_checkpoint

    async def materialize_aggregated_edges_batch(self, **kw):
        cb = kw["progress_callback"]
        for i, stats in enumerate(self._stats):
            await cb(10 * (i + 1), 100, f"v3:{i}", 0, "extracting", progress_pct=10 * (i + 1), stats=stats)
        return {"aggregated_edges_affected": 2, "run_stats": {"writes": 2, "adapted": {"scan_width_min": 500}}}


_EFFECTIVE = {"scan_range_width": 200_000, "scan_timeout_s": 30.0, "sources": {"scan_range_width": "env", "scan_timeout_s": "job"}}


def _materialize(job, provider, session=None, emitter=None, *, limits=None):
    worker = AggregationWorker(session_factory=None, registry=None, event_publisher=None)
    return _run(worker._materialize_with_checkpoints(
        session=session or _Session(), job=job, provider=provider,
        containment_types=["CONTAINS"], lineage_types=["FLOWS"],
        cancel_event=asyncio.Event(), emitter=emitter or _Emitter(),
        scope=PlatformJobScope(workspace_id="ws", data_source_id="ds_1"),
        limits=limits,
    ))


def test_the_first_checkpoint_writes_the_effective_tuning_with_the_workers_own_limits():
    job = _Job(timeout_secs=7_200, tuning_json=json.dumps({"scan_timeout_s": 30.0, "max_wall_secs": 172_800}))
    session = _Session()
    _materialize(job, _Provider([
        {"writes": 0, "deletes": 0, "effective_tuning": _EFFECTIVE},
    ]), session, limits={"stall_timeout": 7_200, "wall_limit": 172_800})

    doc = json.loads(job.run_stats)
    eff = doc["effective_tuning"]
    assert eff["scan_range_width"] == 200_000 and eff["sources"]["scan_range_width"] == "env"
    assert eff["stall_timeout_secs"] == 7_200 and eff["sources"]["stall_timeout_secs"] == "job"
    assert eff["max_wall_secs"] == 172_800 and eff["sources"]["max_wall_secs"] == "job"
    assert eff["max_retries"] == 3
    assert session.commits >= 1
    # run() merges the pipeline's final stats OVER this record (never in
    # place of it) — the same helper, so the snapshot survives success.
    merged = _merge_run_doc(json.loads(job.run_stats), {"writes": 2, "adapted": {"scan_width_min": 500}})
    assert merged["effective_tuning"] == eff and merged["writes"] == 2
    assert merged["adapted"] == {"scan_width_min": 500}


def test_env_limits_are_labelled_env_and_the_adapted_record_goes_live(monkeypatch):
    import backend.app.services.aggregation.worker as worker_mod
    monkeypatch.setattr(worker_mod, "_CHECKPOINT_MAX_BATCHES", 1)   # commit (and publish) every checkpoint
    job = _Job()
    emitter = _Emitter()
    _materialize(job, _Provider([
        {"writes": 0, "deletes": 0, "effective_tuning": _EFFECTIVE},
        {"writes": 5, "deletes": 0, "effective_tuning": _EFFECTIVE,
         "adapted": {"scan_width": 12_500, "scan_shrinks": 2, "extract_concurrency": 1, "pressure": [{"scan": "extract:FLOWS", "kind": "memory"}]}},
    ]), emitter=emitter)

    eff = json.loads(job.run_stats)["effective_tuning"]
    assert eff["sources"]["stall_timeout_secs"] == "env" and eff["sources"]["max_wall_secs"] == "env"
    assert eff["stall_timeout_secs"] == 10_800
    live = [p["live_state"] for p in emitter.published if p.get("live_state")]
    assert any(s.get("adapted_scan_width") == 12_500 and s.get("adapted_extract_concurrency") == 1 for s in live)
    assert all("adapted_pressure" not in s for s in live)   # lists never ride the HSET


def test_a_resumed_run_keeps_what_the_previous_attempt_recorded():
    job = _Job(run_stats=json.dumps({"effective_tuning": {"scan_range_width": 1, "sources": {}}, "adapted": {"scan_width": 3}}))
    _materialize(job, _Provider([{"writes": 0, "deletes": 0}]))   # a legacy provider: no snapshot
    doc = json.loads(job.run_stats)
    assert doc["effective_tuning"]["scan_range_width"] == 1
    assert doc["adapted"] == {"scan_width": 3}
