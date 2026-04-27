"""
F4 — Hostile-environment verification (the "did the resilience uplift
actually work" smoke).

Runs against a live backend (default: http://localhost:8000) for 60 seconds,
hammering /health/live + /announcements + /admin/providers/{id}/test in
parallel. Records the wall-clock distributions and asserts the SLOs the
plan committed to.

Usage:

    1. Start the backend with at least one healthy provider + several
       broken providers registered. The "broken" set:
         - DNS-unresolvable host:    asdfas:6379
         - DNS-unresolvable host:    dsfasdfasd:6379
         - DNS-unresolvable host:    nope:6379
         - DNS-unresolvable host:    sinkhole.invalid:6379
         - Connection-refused host:  127.0.0.1:1
       Plus 1 good provider (real local FalkorDB).

    2. Authenticate (the script reads a session cookie from
       ``RESILIENCE_VERIFY_COOKIE`` env var if the BE is behind auth).

    3. Run:

         python -m backend.scripts.verify_resilience_slos \\
             --base-url http://localhost:8000 \\
             --duration 60

The script prints the percentile table, the assertion outcomes, and exits
non-zero on any SLO miss.

The script is INTENTIONALLY thin: it does not try to register / clean up
providers itself. The user owns the fixture; the script only measures.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx


# ── SLO targets ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class SLOs:
    health_live_p99_ms: float = 50.0
    announcements_p99_ms: float = 500.0
    test_broken_max_ms: float = 2500.0
    test_good_max_ms: float = 500.0


# ── Sample collection ──────────────────────────────────────────────


@dataclass
class Samples:
    label: str
    durations_ms: list = field(default_factory=list)
    statuses: list = field(default_factory=list)

    def record(self, duration_ms: float, status: int) -> None:
        self.durations_ms.append(duration_ms)
        self.statuses.append(status)

    def p(self, percentile: float) -> float:
        if not self.durations_ms:
            return float("nan")
        sorted_d = sorted(self.durations_ms)
        idx = max(0, min(len(sorted_d) - 1, int(len(sorted_d) * percentile / 100)))
        return sorted_d[idx]

    @property
    def count(self) -> int:
        return len(self.durations_ms)

    @property
    def non_2xx(self) -> int:
        return sum(1 for s in self.statuses if not (200 <= s < 300))


# ── Endpoint pollers ────────────────────────────────────────────────


async def poll_endpoint(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    samples: Samples,
    interval_s: float,
    deadline_at: float,
) -> None:
    """Hammer one endpoint until the deadline. Records every sample."""
    while time.monotonic() < deadline_at:
        t0 = time.monotonic()
        try:
            resp = await client.request(method, url, timeout=10.0)
            samples.record((time.monotonic() - t0) * 1000, resp.status_code)
        except httpx.HTTPError as exc:
            # Treat client-side errors as 0 status so they show up in non_2xx.
            samples.record((time.monotonic() - t0) * 1000, 0)
            print(f"  [{samples.label}] error: {exc!r}", file=sys.stderr)
        await asyncio.sleep(interval_s)


# ── Reporting ──────────────────────────────────────────────────────


def report(samples: Samples) -> str:
    if samples.count == 0:
        return f"  {samples.label}: NO SAMPLES"
    return (
        f"  {samples.label:30s}  "
        f"n={samples.count:5d}  "
        f"non2xx={samples.non_2xx:3d}  "
        f"p50={samples.p(50):7.1f}ms  "
        f"p95={samples.p(95):7.1f}ms  "
        f"p99={samples.p(99):7.1f}ms  "
        f"max={max(samples.durations_ms):7.1f}ms"
    )


# ── Main ────────────────────────────────────────────────────────────


async def run(
    base_url: str,
    broken_provider_ids: list[str],
    good_provider_id: Optional[str],
    duration_s: float,
    cookie: Optional[str],
) -> int:
    """Run the smoke. Returns 0 on all SLOs met, 1 on any miss."""
    slos = SLOs()
    deadline_at = time.monotonic() + duration_s

    headers = {}
    cookies = {}
    if cookie:
        # The dev backend uses HttpOnly session cookies; format
        # RESILIENCE_VERIFY_COOKIE="cookie_name=value".
        if "=" in cookie:
            name, _, value = cookie.partition("=")
            cookies[name.strip()] = value.strip()
        else:
            headers["Authorization"] = f"Bearer {cookie}"

    print(f"\n=== F4 hostile-environment verification ===")
    print(f"  base_url: {base_url}")
    print(f"  duration: {duration_s:.0f}s")
    print(f"  broken providers: {broken_provider_ids}")
    print(f"  good provider:    {good_provider_id or '(none specified)'}")
    print()

    samples_live = Samples("/health/live")
    samples_announcements = Samples("/announcements")
    samples_test_broken = Samples("/test (broken)")
    samples_test_good = Samples("/test (good)")

    async with httpx.AsyncClient(
        base_url=base_url, headers=headers, cookies=cookies,
    ) as client:
        tasks = []
        # /health/live every 100ms
        tasks.append(asyncio.create_task(poll_endpoint(
            client, "GET", "/api/v1/health/live", samples_live,
            interval_s=0.1, deadline_at=deadline_at,
        )))
        # /announcements every 1s
        tasks.append(asyncio.create_task(poll_endpoint(
            client, "GET", "/api/v1/announcements", samples_announcements,
            interval_s=1.0, deadline_at=deadline_at,
        )))
        # /test for each broken provider every 5s
        for prov_id in broken_provider_ids:
            tasks.append(asyncio.create_task(poll_endpoint(
                client, "POST", f"/api/v1/admin/providers/{prov_id}/test",
                samples_test_broken,
                interval_s=5.0, deadline_at=deadline_at,
            )))
        # /test for the good provider every 5s
        if good_provider_id:
            tasks.append(asyncio.create_task(poll_endpoint(
                client, "POST", f"/api/v1/admin/providers/{good_provider_id}/test",
                samples_test_good,
                interval_s=5.0, deadline_at=deadline_at,
            )))

        await asyncio.gather(*tasks)

    # ── Report ──────────────────────────────────────────────────
    print("\n--- Latency distribution ---")
    print(report(samples_live))
    print(report(samples_announcements))
    print(report(samples_test_broken))
    print(report(samples_test_good))

    # ── SLO checks ──────────────────────────────────────────────
    print("\n--- SLO assertions ---")
    failures = []

    def check(label: str, observed: float, ceiling: float) -> None:
        ok = observed <= ceiling
        sym = "PASS" if ok else "FAIL"
        print(f"  [{sym}] {label}: {observed:.1f}ms <= {ceiling:.1f}ms")
        if not ok:
            failures.append(label)

    if samples_live.count:
        check(
            "/health/live p99",
            samples_live.p(99),
            slos.health_live_p99_ms,
        )
    if samples_announcements.count:
        check(
            "/announcements p99",
            samples_announcements.p(99),
            slos.announcements_p99_ms,
        )
    if samples_test_broken.count:
        check(
            "/test (broken) max",
            max(samples_test_broken.durations_ms),
            slos.test_broken_max_ms,
        )
    if samples_test_good.count:
        check(
            "/test (good) max",
            max(samples_test_good.durations_ms),
            slos.test_good_max_ms,
        )

    # /announcements must always 2xx — Postgres flap aside, this should
    # be unaffected by provider state.
    if samples_announcements.non_2xx > 0:
        print(f"  [FAIL] /announcements non-2xx count: {samples_announcements.non_2xx}")
        failures.append("/announcements_non_2xx")

    # /health/live must always 2xx.
    if samples_live.non_2xx > 0:
        print(f"  [FAIL] /health/live non-2xx count: {samples_live.non_2xx}")
        failures.append("/health/live_non_2xx")

    print()
    if failures:
        print(f"!!! {len(failures)} SLO miss(es): {failures}")
        return 1
    print("All SLOs met.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.getenv(
        "RESILIENCE_VERIFY_BASE_URL", "http://localhost:8000",
    ))
    parser.add_argument("--duration", type=float, default=60.0,
                        help="Total wall-clock duration in seconds (default 60).")
    parser.add_argument("--broken-provider-ids", nargs="*", default=[],
                        help="Provider IDs that point at unreachable hosts. "
                             "/test calls fired against each.")
    parser.add_argument("--good-provider-id", default=None,
                        help="One healthy provider ID for the baseline /test latency.")
    parser.add_argument("--cookie", default=os.getenv("RESILIENCE_VERIFY_COOKIE"),
                        help="Auth cookie (name=value) or bearer token. "
                             "Not needed for unauthenticated dev backends.")
    args = parser.parse_args()

    return asyncio.run(run(
        base_url=args.base_url,
        broken_provider_ids=args.broken_provider_ids,
        good_provider_id=args.good_provider_id,
        duration_s=args.duration,
        cookie=args.cookie,
    ))


if __name__ == "__main__":
    sys.exit(main())
