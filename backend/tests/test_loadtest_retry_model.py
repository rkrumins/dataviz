"""THE HARNESS DECIDES WHAT NUMBER YOU BELIEVE.

`loadtest/lib/retry.py` is what makes the load test's offered load match a
real client's. Get it wrong and the run still finishes, still prints a
throughput figure, and the figure is wrong — which is worse than no figure,
because somebody will size a cluster on it.

The specific fault it fixes: every scenario fired each request once and
counted a non-200 as a failure. A browser does not do that — on a 429 (the
backend shedding a hydration burst) or a 503 with ``Retry-After`` the canvas
waits and comes back. So at saturation the real system's offered load goes
UP while the harness's went DOWN, and the harness reported a ceiling below
the real one while being structurally unable to reproduce retry
amplification: the mechanism by which a merely-slow system becomes a down
one.

Tested from here rather than from `loadtest/` because the harness installs in
its own venv and nothing there runs in CI, while this file is on the gated
list. The module is pure stdlib by construction — locust is imported inside
the one function that needs it — which is what makes that possible.
"""
from __future__ import annotations

import importlib.util
import os
import time

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "loadtest_retry",
    os.path.join(os.path.dirname(__file__), "..", "..", "loadtest", "lib", "retry.py"),
)
retry = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(retry)


# ── Retry-After parsing ──────────────────────────────────────────────────


def test_retry_after_seconds_and_dates_both_parse():
    assert retry.parse_retry_after_ms("5") == 5000
    assert retry.parse_retry_after_ms("0") == 0
    # An HTTP-date, which the spec allows and some proxies send.
    future = time.strftime(
        "%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() + 30),
    )
    got = retry.parse_retry_after_ms(future)
    assert got is not None and 25_000 <= got <= 31_000


@pytest.mark.parametrize("header", [None, "", "soon", "-1", "not a date"])
def test_an_unusable_retry_after_is_no_retry_after(header):
    """Falls back to the jittered cadence rather than to zero. A malformed
    header that parsed as 0 would turn backpressure into a hot loop — the
    harness DDoSing the thing it is measuring."""
    assert retry.parse_retry_after_ms(header) in (None, 0) or header == "0"
    if header not in ("0",):
        assert retry.parse_retry_after_ms(header) is None


# ── the backoff itself ───────────────────────────────────────────────────


def test_the_server_decides_when_it_said_so():
    """It knows when it will be ready; we do not."""
    assert retry.backoff_seconds(1, 3000) == pytest.approx(3.0)


def test_an_honest_but_long_retry_after_is_capped():
    """A server that says 600 is telling the truth, and a load test must not
    park a simulated user for ten minutes — the run would report a throughput
    collapse that is really just one user asleep."""
    assert retry.backoff_seconds(1, 600_000) == retry.RETRY_AFTER_CAP_S


def test_without_a_header_the_wait_is_jittered_not_lockstep():
    """Without jitter every simulated user that started together retries at
    the same instant forever — a thundering herd the harness invented rather
    than one the system has."""
    waits = {retry.backoff_seconds(1, None) for _ in range(200)}
    assert len(waits) > 50, "jitter is not being applied"
    base = retry.BASE_MS / 1000.0
    assert all(base <= w <= base * (1 + retry.JITTER_FRAC) for w in waits)


# ── what gets retried, and what does not ─────────────────────────────────


class _Resp:
    def __init__(self, status, headers=None, body=None):
        self.status_code = status
        self.headers = headers or {}
        self._body = body
        self.outcome = None

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body

    def success(self):
        self.outcome = "success"

    def failure(self, msg):
        self.outcome = f"failure: {msg}"

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Client:
    """Records every attempt and the name it was filed under."""

    def __init__(self, *responses):
        self._responses = list(responses)
        self.calls: list = []

    def request(self, method, url, *, name, catch_response=False, **kw):
        self.calls.append((method, url, name))
        return self._responses.pop(0) if self._responses else _Resp(200, body=[])


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    """No real sleeping, and a fixed budget, so these are deterministic."""
    monkeypatch.setattr(retry.time, "sleep", lambda s: None)
    monkeypatch.setattr(retry, "MAX_ATTEMPTS", 3)
    monkeypatch.setattr(retry, "BASE_MS", 1)


def test_a_shed_request_comes_back_like_a_real_client_would():
    client = _Client(
        _Resp(429, headers={"Retry-After": "1"}),
        _Resp(429, headers={"Retry-After": "1"}),
        _Resp(200, body=[{"urn": "u1"}]),
    )
    resp = retry.request_with_retries(client, "POST", "/x", name="canvas-open:nodes")

    assert resp.status_code == 200
    assert len(client.calls) == 3, "the shed requests must come back"
    # …and the amplification is VISIBLE, not averaged into the original row.
    assert [c[2] for c in client.calls] == [
        "canvas-open:nodes", "canvas-open:nodes:retry", "canvas-open:nodes:retry",
    ]


def test_being_shed_is_not_a_failure():
    """Counting it failed is precisely what made the harness report a ceiling
    below the real one: the user stopped offering load at the moment the real
    system gets more."""
    shed = _Resp(429, headers={"Retry-After": "1"})
    client = _Client(shed, _Resp(200, body=[]))
    retry.request_with_retries(client, "POST", "/x", name="n")
    assert shed.outcome == "success"


def test_the_budget_is_finite_and_the_last_one_is_a_real_failure():
    client = _Client(*[_Resp(503) for _ in range(10)])
    resp = retry.request_with_retries(client, "POST", "/x", name="n")
    assert resp.status_code == 503
    assert len(client.calls) == retry.MAX_ATTEMPTS + 1     # first + the budget
    assert resp.outcome.startswith("failure")


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 500])
def test_what_no_client_retries_is_not_retried(status):
    """These are bugs, not backpressure. Retrying them would inflate the load
    figure with traffic no real user generates."""
    client = _Client(_Resp(status))
    retry.request_with_retries(client, "POST", "/x", name="n")
    assert len(client.calls) == 1


def test_a_bad_body_fails_without_being_retried():
    """Fast and unusable is not success — and it is not backpressure either,
    so it gets one attempt and a failure."""
    resp = _Resp(200, body=None)
    client = _Client(resp)
    retry.request_with_retries(
        client, "POST", "/x", name="n", on_success=lambda r: bool(r.json()),
    )
    assert len(client.calls) == 1
    assert resp.outcome.startswith("failure")


def test_zero_attempts_restores_the_old_fire_once_behaviour(monkeypatch):
    """So a run can be compared against the historical numbers this change
    invalidates."""
    monkeypatch.setattr(retry, "MAX_ATTEMPTS", 0)
    client = _Client(_Resp(429), _Resp(200, body=[]))
    retry.request_with_retries(client, "POST", "/x", name="n")
    assert len(client.calls) == 1
