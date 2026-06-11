"""Tests for the "reachable but slow" health fix.

A large-graph stats scan that exceeds the discovery budget must NOT flip the
whole provider to "unreachable" — it's an asset-level staleness signal. And a
timeout must not count as a provider-health failure.
"""
import asyncio
from types import SimpleNamespace

import pytest

from backend.insights_service import admission, discovery


def _prov_row():
    return SimpleNamespace(
        provider_type="falkordb", host="falkordb", port=6379,
        tls_enabled=False, extra_config=None,
    )


def _wire(monkeypatch, *, preflight_ok, get_stats):
    async def fake_get_provider(session, pid):
        return _prov_row()

    async def fake_creds(session, pid):
        return {}

    class _Inst:
        async def preflight(self, deadline_s=2.0):
            return SimpleNamespace(ok=preflight_ok, reason="ok" if preflight_ok else "tcp_refused", elapsed_ms=1)

    inst = _Inst()
    inst.get_stats = get_stats

    monkeypatch.setattr(discovery, "get_provider_orm", fake_get_provider)
    monkeypatch.setattr(discovery, "get_credentials", fake_creds)
    monkeypatch.setattr(
        discovery.provider_manager, "_create_provider_instance",
        lambda **kw: inst,
    )

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _noop_gate(*a, **k):
        yield

    monkeypatch.setattr(discovery.admission, "gate", _noop_gate)

    rec = []
    ups = []

    async def fake_record_failure(session, provider_id, asset_name, error):
        rec.append((provider_id, asset_name, error))

    async def fake_upsert(session, **kw):
        ups.append(kw)

    monkeypatch.setattr(discovery, "record_failure", fake_record_failure)
    monkeypatch.setattr(discovery, "_upsert_cache", fake_upsert)
    return rec, ups


@pytest.mark.asyncio
async def test_stats_timeout_does_not_raise_and_records_asset(monkeypatch):
    async def slow_stats():
        raise asyncio.TimeoutError()

    rec, ups = _wire(monkeypatch, preflight_ok=True, get_stats=slow_stats)
    env = SimpleNamespace(provider_id="p1", asset_name="big_graph")

    # Must NOT raise — returning normally lets the admission gate record the
    # provider as reachable rather than failed.
    await discovery.collect(object(), env)

    assert len(rec) == 1
    assert rec[0][0] == "p1" and rec[0][1] == "big_graph"
    assert "last known counts" in rec[0][2]  # asset-level stale note
    assert ups == []  # early return: no fresh upsert


@pytest.mark.asyncio
async def test_preflight_failure_still_records_asset(monkeypatch):
    async def stats_ok():
        return {"nodeCount": 1}

    rec, ups = _wire(monkeypatch, preflight_ok=False, get_stats=stats_ok)
    env = SimpleNamespace(provider_id="p2", asset_name="g")
    await discovery.collect(object(), env)
    assert len(rec) == 1
    assert "tcp_refused" in rec[0][2]


# ── admission: timeout is not a hard provider failure ───────────────

@pytest.mark.asyncio
async def test_timeout_not_counted_as_provider_failure(monkeypatch):
    ctrl = admission._AdmissionController()
    monkeypatch.setattr(ctrl, "_ensure_flush_task", lambda: None)
    await ctrl.report_failure("p", is_timeout=True)
    assert ctrl._consecutive_failures.get("p", 0) == 0
    assert "p" not in ctrl._pending


@pytest.mark.asyncio
async def test_hard_failure_counted(monkeypatch):
    ctrl = admission._AdmissionController()
    monkeypatch.setattr(ctrl, "_ensure_flush_task", lambda: None)
    await ctrl.report_failure("p", is_timeout=False)
    assert ctrl._consecutive_failures["p"] == 1
    assert ctrl._pending["p"].failure_delta == 1
