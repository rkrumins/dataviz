"""The versioning worker's lanes (``GRAPHVER_WORKER_LANES``).

Production runs each lane — projection, transfer, bootstrap — as pods of its own; compose and dev
run all three in one process. Proven here: which lanes a process runs comes from the environment,
and a misspelt lane fails start-up instead of running nothing; each lane gets the runners it needs
and no others (the transfer lane its inspect slot and job reaper); only the projection lane joins
the projection stream's consumer group; the connection pool is sized from the lanes; and the web
process runs lanes only in the dev role, through the same wiring.
"""
from __future__ import annotations

import ast
import asyncio
from pathlib import Path

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning import worker as worker_mod
from backend.app.services.versioning.import_export.runner import INSPECT_TYPES, JOB_TYPES
from backend.app.services.versioning.worker import ProjectionWorker, build_worker


@pytest.mark.parametrize("raw, lanes", [
    (None, {"projection", "transfer", "bootstrap"}),
    ("transfer", {"transfer"}),
    (" Projection , bootstrap,", {"projection", "bootstrap"}),
])
def test_the_lanes_come_from_the_environment(monkeypatch, raw, lanes):
    if raw is None:
        monkeypatch.delenv("GRAPHVER_WORKER_LANES", raising=False)
    else:
        monkeypatch.setenv("GRAPHVER_WORKER_LANES", raw)
    assert config.worker_lanes() == lanes


@pytest.mark.parametrize("raw", ["transfers", "projection,bogus", " , "])
def test_a_misspelt_lane_fails_start_up(monkeypatch, raw):
    monkeypatch.setenv("GRAPHVER_WORKER_LANES", raw)
    with pytest.raises(ValueError, match="GRAPHVER_WORKER_LANES"):
        config.worker_lanes()


def test_the_pool_is_sized_from_the_lanes(monkeypatch):
    monkeypatch.setattr(config, "PROJECTION_CONCURRENCY", 8)
    monkeypatch.setattr(config, "TRANSFER_SLOTS", 2)
    monkeypatch.setattr(config, "BOOTSTRAP_SLOTS", 2)
    assert config.lane_pool_size({"projection"}) == 2 + 11
    assert config.lane_pool_size({"transfer"}) == 2 + 6
    assert config.lane_pool_size({"bootstrap"}) == 2 + 8
    assert config.lane_pool_size(set(config.LANES)) == 2 + 11 + 6 + 8
    monkeypatch.setattr(config, "TRANSFER_SLOTS", 4)
    assert config.lane_pool_size({"transfer"}) == 2 + 10, "more slots, more connections"


def _build(lanes):
    return build_worker(object(), lambda *a: None, lanes=lanes, import_export=lambda: None,
                        evict_budget=lambda provider: 0)


def test_each_lane_gets_its_runners_and_no_others():
    transfer = _build({"transfer"})
    assert transfer._transfers._types == JOB_TYPES
    assert transfer._inspections._types == INSPECT_TYPES
    assert transfer._job_reaper is not None
    assert (transfer._bootstrap, transfer._purge, transfer._reaper) == (None, None, None)
    assert transfer._versioning is None and transfer._cache is None

    bootstrap = _build({"bootstrap"})
    assert None not in (bootstrap._bootstrap, bootstrap._purge, bootstrap._reaper)
    assert (bootstrap._transfers, bootstrap._inspections, bootstrap._job_reaper) == (None, None, None)

    projection = _build({"projection"})
    assert projection._versioning is not None and projection._cache is not None
    assert (projection._transfers, projection._bootstrap) == (None, None)

    every = _build(set(config.LANES))
    assert every._lanes == frozenset(config.LANES)
    assert None not in (every._transfers, every._inspections, every._job_reaper, every._bootstrap,
                        every._purge, every._reaper, every._versioning)


class _Idle:
    """A runner with nothing to claim."""

    def __init__(self):
        self.claims = 0

    async def claim_one(self):
        self.claims += 1
        return None


async def _run_briefly(worker, monkeypatch):
    joined = []

    async def group():
        joined.append(True)

    async def idle():
        await worker._stop.wait()

    monkeypatch.setattr(worker_mod, "ensure_consumer_group", group)
    monkeypatch.setattr(worker, "_reclaim_pending", lambda: asyncio.sleep(0))
    monkeypatch.setattr(worker, "_poll_loop", idle)
    monkeypatch.setattr(worker, "_stream_loop", idle)
    monkeypatch.setattr(config, "TRANSFER_POLL_SECS", 0.01)
    monkeypatch.setattr(config, "INGEST_POLL_SECS", 0.01)
    task = asyncio.create_task(worker.run())
    await asyncio.sleep(0.05)
    worker.stop()
    await asyncio.wait_for(task, 5)
    return joined


async def test_only_the_projection_lane_joins_the_consumer_group(monkeypatch):
    transfers, inspect = _Idle(), _Idle()
    worker = ProjectionWorker(object(), lanes={"transfer"}, transfers=transfers,
                              inspections=inspect)
    assert await _run_briefly(worker, monkeypatch) == []
    assert transfers.claims and inspect.claims, "the transfer lane's slots ran"

    worker = ProjectionWorker(object(), lanes={"projection"}, transfers=_Idle())
    assert await _run_briefly(worker, monkeypatch) == [True]


async def test_a_lane_not_enabled_runs_nothing_it_was_given(monkeypatch):
    boot, transfers = _Idle(), _Idle()
    worker = ProjectionWorker(object(), lanes={"bootstrap"}, bootstrap=boot, transfers=transfers)
    await _run_briefly(worker, monkeypatch)
    assert boot.claims and transfers.claims == 0


def test_the_web_process_runs_lanes_only_in_the_dev_role_through_the_shared_wiring():
    """``main.py``'s in-process path: gated on the dev role, and built by ``build_worker`` — the
    wiring the standalone worker uses, which gives it the transfer lane it once lacked."""
    source = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text()
    tree = ast.parse(source)
    branch = next(node for node in ast.walk(tree)
                  if isinstance(node, ast.If) and "PROJECTION_INPROCESS" in ast.unparse(node.test)
                  and "SynodicRole.DEV" in ast.unparse(node.test))
    refused = ast.unparse(branch.body[0])
    assert "logger.error" in refused, "a non-dev role with INPROCESS set only logs an error"
    started = ast.unparse(branch.orelse[0])
    assert "build_worker(" in started and "import_export=get_import_export_service" in started
    assert "LeaseKeeper(exit_on_wedge=False)" in started
