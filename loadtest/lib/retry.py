"""Retry the way the real client retries, so the harness stops under-measuring.

THE PROBLEM THIS FIXES. Every scenario fired each request once and counted a
non-200 as a failure. A real browser does not do that: on a 429 (the backend
shedding a hydration burst) or a 503 with ``Retry-After`` (a warming store, a
node rotating) the canvas waits and tries again — see
``classifyGraphFailure`` and ``PROVIDER_RETRY_MAX_ATTEMPTS`` in the frontend.

So the two diverge exactly where it matters. At saturation the real system's
offered load goes **up**, because every shed request comes back; the harness's
went **down**, because a shed request was recorded as a failure and the user
moved on to think-time. The harness therefore reported a ceiling slightly
*below* the real one and could not reproduce retry amplification at all — the
mechanism by which a system that is merely slow becomes a system that is down.

WHAT THIS MIRRORS, and what it deliberately does not:

* **429 / 503 with ``Retry-After``** — honour the header, retry. The backend
  said when; arguing with it would measure a client nobody ships.
* **503 / 502 / 504 without a header** — the fast provider-retry cadence,
  jittered, bounded by ``PROVIDER_RETRY_MAX_ATTEMPTS``. Jitter matters here
  for the same reason it matters in the browser: without it every simulated
  user that started together retries in lockstep forever, which is a
  thundering herd the harness invented rather than one the system has.
* **Everything else** (4xx that is not 429, a malformed body) — one attempt,
  recorded as a failure. Those are bugs, not backpressure.

Retries are recorded as their own request rows (``<name>:retry``) rather than
folded into the original, so a run that passed its latency SLO *by retrying*
is visibly different from one that passed first time. Amplification is the
number you came for; hiding it inside an average would defeat the purpose.

The cadence is compressed relative to the browser's (10s between fast
retries) — ``LOADTEST_RETRY_BASE_MS`` defaults to 1000 — because a load test
wants the amplification, not a faithful wall clock. Set it to 10000 to model
the browser exactly.
"""
from __future__ import annotations

import os
import random
import time
from typing import Callable, Optional

#: Statuses the real client comes back from. 429 is load shedding; the 5xx
#: trio is a provider that is warming, rotating or briefly gone.
RETRYABLE = frozenset({429, 502, 503, 504})


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = (os.getenv(name) or "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


MAX_ATTEMPTS = _env_int("LOADTEST_RETRY_MAX_ATTEMPTS", 5)
"""Mirrors ``PROVIDER_RETRY_MAX_ATTEMPTS``. 0 restores the old
fire-once behaviour exactly, for comparing against historical runs."""

BASE_MS = _env_int("LOADTEST_RETRY_BASE_MS", 1000)
"""Base gap between fast retries. The browser uses 10s; the default here is
compressed so a run of a few minutes still shows the amplification."""

JITTER_FRAC = _env_float("LOADTEST_RETRY_JITTER", 0.3)
"""Matches the frontend's ``withJitter`` default."""

RETRY_AFTER_CAP_S = _env_float("LOADTEST_RETRY_AFTER_CAP_S", 30.0)
"""A server that says ``Retry-After: 600`` is telling the truth and a load
test still must not park a user for ten minutes. Capped, and the fact that it
was capped is why ``retry_after_capped`` is counted."""


def parse_retry_after_ms(value: Optional[str]) -> Optional[int]:
    """``Retry-After``, in ms. Seconds or an HTTP date, like the frontend's
    ``parseRetryAfterMs``. ``None`` when absent or unparseable."""
    if not value:
        return None
    try:
        seconds = float(value)
        if seconds >= 0:
            return int(seconds * 1000)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        at = parsedate_to_datetime(value)
    except Exception:  # noqa: BLE001 — a malformed header is simply no header
        return None
    if at is None:
        return None
    delta = at.timestamp() - time.time()
    return max(0, int(delta * 1000))


def backoff_seconds(attempt: int, retry_after_ms: Optional[int]) -> float:
    """How long before attempt ``attempt`` (1-based). The server's own
    ``Retry-After`` wins when it sent one — it knows when it will be ready and
    we do not — capped so one honest-but-long header cannot idle a user for
    the rest of the run. Otherwise the jittered fast cadence."""
    if retry_after_ms is not None:
        return min(retry_after_ms / 1000.0, RETRY_AFTER_CAP_S)
    base = BASE_MS / 1000.0
    return base * (1.0 + random.uniform(0.0, JITTER_FRAC))


def request_with_retries(
    client,
    method: str,
    url: str,
    *,
    name: str,
    on_success: Optional[Callable[[object], bool]] = None,
    **kwargs,
):
    """One logical client action, retried the way the canvas retries it.

    Returns the final response. ``on_success`` may inspect a 200 body and
    return False to mark it a failure (a malformed payload is not a success
    however fast it arrived) — it is NOT retried, because a bad body is a bug
    rather than backpressure.

    Every attempt after the first is recorded under ``<name>:retry``, so the
    stats show amplification instead of averaging it away.
    """
    attempt = 0
    while True:
        attempt += 1
        label = name if attempt == 1 else f"{name}:retry"
        with client.request(
            method, url, name=label, catch_response=True, **kwargs,
        ) as resp:
            status = resp.status_code
            if status == 200:
                # A callback that RAISES must not kill the scenario: a load
                # test that dies on one malformed response reports a
                # throughput collapse it caused itself.
                try:
                    usable = on_success is None or bool(on_success(resp))
                except Exception as exc:  # noqa: BLE001 — the body is the suspect
                    resp.failure(f"unusable body: {exc}")
                    return resp
                if usable:
                    resp.success()
                else:
                    resp.failure("unusable body")
                return resp

            if status in RETRYABLE and attempt <= MAX_ATTEMPTS:
                retry_after = parse_retry_after_ms(resp.headers.get("Retry-After"))
                # Not a failure: the server said "later" and a real client
                # obliges. Counting it failed is what made the harness report
                # a ceiling below the real one.
                resp.success()
                wait = backoff_seconds(attempt, retry_after)
                _record_shed(client, name, status, retry_after)
                time.sleep(wait)
                continue

            # Out of budget, or a status no client retries.
            resp.failure(f"HTTP {status}")
            return resp


def _record_shed(client, name: str, status: int, retry_after_ms: Optional[int]) -> None:
    """A zero-length stat row per shed response, so a run says HOW MUCH it was
    shed and with what status — the number that separates "slow" from "about
    to fall over", and the one a failure count alone destroys."""
    try:
        from locust import events

        events.request.fire(
            request_type="SHED",
            name=f"{name}:{status}",
            response_time=0,
            response_length=0,
            exception=None,
            context={},
        )
        if retry_after_ms is not None and retry_after_ms / 1000.0 > RETRY_AFTER_CAP_S:
            events.request.fire(
                request_type="SHED",
                name=f"{name}:retry_after_capped",
                response_time=0,
                response_length=0,
                exception=None,
                context={},
            )
    except Exception:  # noqa: BLE001 — bookkeeping never fails a scenario
        pass
