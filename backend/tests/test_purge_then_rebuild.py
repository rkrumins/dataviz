"""The purge that promises a rebuild has to run the rebuild you configured.

A purge chains a fresh aggregation when it completes — container-level
lineage is blind until the canonical cells are back. The chain posted a bare
``projectionMode`` + ``batchSize``, which was fine while the only way to
purge was a bare button. It stopped being fine the moment the re-trigger
dialog could ask for one: every override the operator had just set — the
narrowed scan width, the serial reads, the longer stall window, the rollup
storage mode — was dropped on the floor, so the purge landed and the rebuild
it promised ran at defaults the source had already failed at.
"""
from __future__ import annotations

import asyncio
import json
import types

import pytest


def _run(coro):
    return asyncio.run(coro)


class _Resp:
    status_code = 200
    text = ""


class _Client:
    """Captures the body the chain posts."""

    sent: dict = {}

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, params=None, json=None):
        type(self).sent = {"url": url, "params": params, "json": json}
        return _Resp()


def _job(tuning_json):
    return types.SimpleNamespace(
        id="agg_1", data_source_id="ds1", projection_mode="in_source",
        tuning_json=tuning_json,
    )


def _chain(monkeypatch, job):
    import httpx

    from backend.insights_service import purge

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    monkeypatch.setattr(
        "backend.app.services.aggregation.internal_auth.internal_auth_headers",
        lambda: {},
    )
    _Client.sent = {}
    _run(purge._maybe_trigger_reaggregation(job))
    return _Client.sent


def test_the_rebuild_runs_with_the_settings_the_operator_chose(monkeypatch):
    sent = _chain(monkeypatch, _job(json.dumps({
        "reaggregate": {
            "batchSize": 1000,
            "timeoutSecs": 10_800,
            "maxRetries": 5,
            "tuning": {"scanRangeWidth": 25_000, "extractConcurrency": 1},
        },
    })))
    body = sent["json"]
    assert body["timeoutSecs"] == 10_800
    assert body["maxRetries"] == 5
    assert body["tuning"] == {"scanRangeWidth": 25_000, "extractConcurrency": 1}
    assert body["batchSize"] == 1000
    assert sent["params"] == {"triggerSource": "post_purge"}


def test_the_projection_mode_stays_the_rows_own(monkeypatch):
    """Where this source's graph lives is not an override — the purge row is
    the authority, and a stale value in a dialog must not move the graph."""
    sent = _chain(monkeypatch, _job(json.dumps({
        "reaggregate": {"projectionMode": "dedicated", "batchSize": 2000},
    })))
    assert sent["json"]["projectionMode"] == "in_source"
    assert sent["json"]["batchSize"] == 2000


@pytest.mark.parametrize("tuning_json", [None, "", "{}", "not json", '{"reaggregate": null}'])
def test_a_purge_with_no_settings_keeps_the_old_bare_body(monkeypatch, tuning_json):
    sent = _chain(monkeypatch, _job(tuning_json))
    assert sent["json"] == {"projectionMode": "in_source", "batchSize": 1000}


def test_an_opted_out_purge_still_chains_nothing(monkeypatch):
    sent = _chain(monkeypatch, _job(json.dumps({"skip_reaggregate": True})))
    assert sent == {}          # the promise was explicitly declined


def test_the_row_can_carry_both_the_opt_out_and_nothing_else():
    """``claim_purge_job`` writes one JSON document; the opt-out and the
    rebuild settings are independent fields of it, and a purge with neither
    still writes NULL rather than an empty object."""
    import inspect

    from backend.app.services.aggregation.service import AggregationService

    src = " ".join(inspect.getsource(AggregationService.claim_purge_job).split())
    assert '"skip_reaggregate": True} if skip_reaggregate else {}' in src
    assert '"reaggregate": reaggregate} if reaggregate else {}' in src
    assert "if (skip_reaggregate or reaggregate) else None" in src
