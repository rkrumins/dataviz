"""Discovery must never persist a partial cluster GRAPH.LIST as fresh.

The pinned contract: when the coverage guard in the primaries fan-out raises
(a shard's slots missing from the map), ``collect()`` propagates the raise —
so the worker's failure path stamps ``last_error`` and the cache keeps the
last-known-good asset list — and NEVER upserts a shrunken list as ``fresh``.
``record_failure`` itself must preserve an existing row's payload verbatim.
"""
from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_connection import ClusterCoverageError
from backend.insights_service import discovery


def _prov_row():
    return SimpleNamespace(
        provider_type="falkordb", host="falkordb", port=6379,
        tls_enabled=False, extra_config=None,
    )


def _wire(monkeypatch, *, list_graphs):
    async def fake_get_provider(session, pid):
        return _prov_row()

    async def fake_creds(session, pid):
        return {}

    class _Inst:
        closed = 0

        async def preflight(self, deadline_s=2.0):
            return SimpleNamespace(ok=True, reason="ok", elapsed_ms=1)

        async def close(self):
            self.closed += 1

    inst = _Inst()
    inst.list_graphs = list_graphs

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

    @asynccontextmanager
    async def _fake_session():
        yield SimpleNamespace()

    monkeypatch.setattr(discovery, "get_jobs_session", _fake_session)

    rec = []
    ups = []

    async def fake_record_failure(provider_id, asset_name, error):
        rec.append((provider_id, asset_name, error))

    async def fake_upsert(session, **kw):
        ups.append(kw)

    monkeypatch.setattr(discovery, "record_failure", fake_record_failure)
    monkeypatch.setattr(discovery, "_upsert_cache", fake_upsert)
    return rec, ups, inst


@pytest.mark.asyncio
async def test_partial_coverage_raises_and_never_upserts_fresh(monkeypatch):
    async def partial_list():
        raise ClusterCoverageError(
            "cluster slot map covers 10923/16384 slots (missing: 10923-16383)"
        )

    rec, ups, inst = _wire(monkeypatch, list_graphs=partial_list)

    with pytest.raises(ClusterCoverageError):
        await discovery.collect(SimpleNamespace(provider_id="p1", asset_name=""))

    # The whole point: nothing was written as fresh — the worker's failure
    # path (record_failure) owns the row, so last-known-good data survives.
    assert ups == []
    assert inst.closed == 1


@pytest.mark.asyncio
async def test_record_failure_preserves_existing_payload():
    """``record_failure`` stamps last_error and leaves the payload verbatim."""
    existing = SimpleNamespace(
        payload='{"assets": ["g1", "g2", "g3"]}', status="fresh",
        last_error=None,
    )

    class _Session:
        def __init__(self):
            self.added = []

        async def get(self, orm, key):
            return existing

        def add(self, row):
            self.added.append(row)

    from contextlib import asynccontextmanager
    from unittest.mock import patch

    session = _Session()

    @asynccontextmanager
    async def _fake_session():
        yield session

    with patch.object(discovery, "get_jobs_session", _fake_session):
        await discovery.record_failure(
            "p1", "", "cluster slot map covers 10923/16384 slots",
        )

    assert existing.payload == '{"assets": ["g1", "g2", "g3"]}'
    assert existing.status == "fresh"
    assert "10923/16384" in existing.last_error
    assert session.added == []          # no stub row when one already exists
