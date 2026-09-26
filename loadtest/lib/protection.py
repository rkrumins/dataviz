"""Did the backend's own protection hold, or did it get out of the way?

A load test that passes its latency SLOs has shown that the system was fast.
It has not shown that the system was *protected* — and the difference is the
whole point of a capacity run, because the cheapest way to be fast is to stop
enforcing the limits.

The specific one that matters is ``aggregation_slot_fail_open_total``. The
write-admission cap is fail-open by design: when the bus is unreachable, or
no slot frees inside the wait deadline, the caller proceeds anyway rather than
stalling a job forever. That is the right bias — and it means the state
immediately before a node is over-admitted looks, from the outside, exactly
like a healthy run. Latency is fine. Failure rate is fine. The cap is simply
not capping. Gate on the CSV alone and that run passes.

So: snapshot the counters before, compare after.

WHAT FAILS THE RUN, and what only gets reported:

* **Fail-open, and dropped series — zero tolerance.** One fail-open is one
  admission that was not admitted; there is no acceptable rate. A dropped
  series means the registry hit its per-metric series cap, so every number
  here is an undercount and the gate cannot do its job.
* **A counter going backwards — fails.** Counters only rise, so a fall means
  the process restarted mid-run. The delta is meaningless, and a pod
  restarting under load is itself the finding.
* **Holds, waits, yields, budget refusals — reported, never failed.** These
  are the protection *working*: the governor held, a waiter waited, the
  pipeline yielded to reads, a write budget refused an oversized batch. A
  gate that goes red when the system defends itself is a gate somebody
  switches off. They are printed so the run has them on the record.

ONE SCRAPE IS ONE POD. The registry is per-process and the endpoint is served
by whichever pod the Service picked. A fleet-wide claim needs every pod, so
pass them all — the gate reports how many it read, and a pass that covers one
of nine says so rather than reading like a fleet result::

    kubectl -n synodic get pods -l app.kubernetes.io/name=viz-service \
        -o jsonpath='{range .items[*]}http://{.status.podIP}:8000/api/v1/metrics {end}'

Usage — around a run, not during it::

    python -m lib.protection --before results/sweep/protection.json
    # …the run…
    python -m lib.protection --check results/sweep/protection.json

``METRICS_ENABLED`` must be on in the deployment under test (and
``METRICS_TOKEN`` set here as ``SYNODIC_METRICS_TOKEN`` if it uses one). If
the endpoint is not there, this exits non-zero: an ungated capacity run is
the thing being prevented, so it cannot be the silent default.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

#: Default scrape target. Override with ``SYNODIC_METRICS_URLS`` (space- or
#: comma-separated) or repeated ``--url``.
DEFAULT_URL = "http://localhost:8000/api/v1/metrics"

SCRAPE_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class Counter:
    name: str
    #: Largest increase that still passes. ``None`` means report only.
    max_increase: Optional[float]
    why: str


GATED: Tuple[Counter, ...] = (
    Counter(
        "aggregation_slot_fail_open_total", 0.0,
        "the write-admission cap stopped capping — proceeding without a slot "
        "is the state immediately before a node is over-admitted",
    ),
    Counter(
        "metrics_series_dropped_total", 0.0,
        "the registry hit its per-metric series cap, so every counter below "
        "is an undercount and this gate cannot be trusted",
    ),
    Counter("aggregation_slot_waits_total", None,
            "waiters waited for a write slot — backpressure working"),
    Counter("aggregation_governor_holds_total", None,
            "the governor paused the pipeline inside the memory envelope"),
    Counter("aggregation_governor_hold_seconds_sum", None,
            "wall-clock spent held, in seconds"),
    Counter("aggregation_read_pressure_yields_total", None,
            "the pipeline yielded to reader latency"),
    Counter("aggregation_write_budget_refusals_total", None,
            "a write budget refused a batch rather than risk the shard"),
)

_SAMPLE = re.compile(r"^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+(?P<value>\S+)$")


def parse_exposition(text: str) -> Dict[str, float]:
    """Prometheus text exposition → ``{metric name: total across label sets}``.

    Summed rather than kept per-series on purpose: the gate's question is
    "did this happen at all", and a fail-open on one node with one reason is
    as much a violation as on another.
    """
    totals: Dict[str, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        found = _SAMPLE.match(line)
        if not found:
            continue
        try:
            value = float(found.group("value"))
        except ValueError:
            continue
        totals[found.group("name")] = totals.get(found.group("name"), 0.0) + value
    return totals


def scrape(url: str, token: Optional[str] = None) -> Dict[str, float]:
    """One endpoint's counters. Raises on anything that is not a served body —
    a 404 means ``METRICS_ENABLED`` is off, which is not a thing to shrug at
    when the point of the call is to prove a limit held."""
    request = urllib.request.Request(url, headers={"Accept": "text/plain"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=SCRAPE_TIMEOUT_S) as response:
        body = response.read().decode("utf-8", "replace")
    if "metrics backend not installed" in body:
        raise RuntimeError(
            f"{url} served the endpoint but no registry is installed in that "
            "process — it skipped its startup wiring"
        )
    return parse_exposition(body)


def snapshot(urls: List[str], token: Optional[str] = None) -> dict:
    """Scrape every URL. Records per-URL errors rather than raising, so a
    partial snapshot still says exactly which pods it covers."""
    reads: Dict[str, Dict[str, float]] = {}
    errors: Dict[str, str] = {}
    for url in urls:
        try:
            reads[url] = scrape(url, token)
        except Exception as exc:  # noqa: BLE001 — the message is the report
            errors[url] = f"{type(exc).__name__}: {exc}"
    return {"reads": reads, "errors": errors}


def compare(before: dict, after: dict) -> List[str]:
    """Violations, most load-bearing first. Empty list means the run is
    gated AND the gated counters held."""
    violations: List[str] = []
    before_reads = before.get("reads") or {}
    after_reads = after.get("reads") or {}

    if not before_reads:
        errs = "; ".join(f"{u}: {e}" for u, e in (before.get("errors") or {}).items())
        return [
            "no metrics endpoint was readable before the run, so the run was "
            f"NOT gated on the protection counters ({errs or 'no URLs tried'}). "
            "Set METRICS_ENABLED in the deployment under test."
        ]

    for url in sorted(before_reads):
        if url not in after_reads:
            why = (after.get("errors") or {}).get(url, "not scraped")
            violations.append(
                f"[{url}] readable before the run and not after ({why}) — "
                "the pod went away, which is itself the finding"
            )

    for url in sorted(set(before_reads) & set(after_reads)):
        start, end = before_reads[url], after_reads[url]
        for counter in GATED:
            if counter.name not in start and counter.name not in end:
                continue
            delta = end.get(counter.name, 0.0) - start.get(counter.name, 0.0)
            if delta < 0:
                violations.append(
                    f"[{url}] {counter.name} fell by {-delta:g} — counters only "
                    "rise, so the process restarted mid-run and every delta "
                    "here is meaningless"
                )
                continue
            if counter.max_increase is not None and delta > counter.max_increase:
                violations.append(
                    f"[{url}] {counter.name} +{delta:g} — {counter.why}"
                )
    return violations


def report(before: dict, after: dict) -> List[str]:
    """The report-only counters, as lines. Context for a passing run: what
    the system did to stay inside its limits while it was passing."""
    lines: List[str] = []
    before_reads = before.get("reads") or {}
    after_reads = after.get("reads") or {}
    for url in sorted(set(before_reads) & set(after_reads)):
        for counter in GATED:
            if counter.max_increase is not None:
                continue
            delta = after_reads[url].get(counter.name, 0.0) - before_reads[url].get(
                counter.name, 0.0,
            )
            if delta > 0:
                lines.append(f"  {url}  {counter.name} +{delta:g}  ({counter.why})")
    return lines


def _urls(explicit: List[str]) -> List[str]:
    if explicit:
        return explicit
    raw = (os.getenv("SYNODIC_METRICS_URLS") or "").replace(",", " ").split()
    return raw or [DEFAULT_URL]


def main(argv: List[str]) -> int:
    args = argv[1:]
    mode: Optional[str] = None
    path: Optional[str] = None
    explicit: List[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--before", "--check"):
            if mode is not None:
                print("--before and --check are mutually exclusive", file=sys.stderr)
                return 2
            mode = a[2:]
            i += 1
            if i >= len(args):
                print(f"{a} expects a snapshot path", file=sys.stderr)
                return 2
            path = args[i]
        elif a == "--url":
            i += 1
            if i >= len(args):
                print("--url expects a URL", file=sys.stderr)
                return 2
            explicit.append(args[i])
        elif a.startswith("--url="):
            explicit.append(a.split("=", 1)[1])
        else:
            print(f"Unknown argument: {a}", file=sys.stderr)
            return 2
        i += 1

    if mode is None or path is None:
        print(
            "Usage: python -m lib.protection (--before | --check) <snapshot.json> "
            "[--url URL ...]",
            file=sys.stderr,
        )
        return 2

    token = (os.getenv("SYNODIC_METRICS_TOKEN") or "").strip() or None
    urls = _urls(explicit)

    if mode == "before":
        before = snapshot(urls, token)
        with open(path, "w") as f:
            json.dump(before, f, indent=2, sort_keys=True)
        covered, failed = len(before["reads"]), len(before["errors"])
        for url, err in sorted(before["errors"].items()):
            print(f"  could not scrape {url}: {err}", file=sys.stderr)
        if not before["reads"]:
            print(
                "No metrics endpoint readable — the run would not be gated on "
                "the protection counters. Turn on METRICS_ENABLED (and set "
                "SYNODIC_METRICS_TOKEN if the deployment uses one).",
                file=sys.stderr,
            )
            return 1
        print(f"Protection baseline written to {path} ({covered} pod(s), {failed} unreachable)")
        return 0

    with open(path) as f:
        before = json.load(f)
    after = snapshot(urls, token)

    violations = compare(before, after)
    context = report(before, after)
    covered = len(set(before.get("reads") or {}) & set(after.get("reads") or {}))

    if context:
        print("Protection engaged during the run:")
        for line in context:
            print(line)
    if not violations:
        print(f"Protection check passed across {covered} pod(s).")
        if covered == 1:
            print(
                "  NOTE: one pod. The registry is per-process, so this says "
                "nothing about the rest of the fleet — pass every pod's URL "
                "for a fleet-wide claim.",
            )
        return 0
    print("Protection violations:", file=sys.stderr)
    for v in violations:
        print(f"  - {v}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
