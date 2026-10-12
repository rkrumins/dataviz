"""A FAST RUN IS NOT A PROTECTED RUN.

The cheapest way for a system to be fast is to stop enforcing its limits.
`aggregation_slot_fail_open_total` is where that shows: the write-admission
cap is fail-open by design, so when the bus is unreachable or no slot frees
in time the caller proceeds anyway. From outside, the state immediately
before a node is over-admitted looks exactly like a healthy run — latency
fine, failure rate fine, cap not capping. A capacity run gated on the CSV
alone passes it.

`loadtest/lib/protection.py` is the gate that catches that. What it must get
right is the *distinction*: a fail-open fails the run, while a governor hold
or a write-budget refusal is the protection working and must not. A gate that
goes red when the system defends itself is a gate somebody switches off.

Tested from here rather than from `loadtest/` for the same reason as the
retry model: the harness installs in its own venv, nothing there runs in CI,
and this file is on the gated list. The module is pure stdlib by
construction, which is what makes that possible.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys

_SPEC = importlib.util.spec_from_file_location(
    "loadtest_protection",
    os.path.join(os.path.dirname(__file__), "..", "..", "loadtest", "lib", "protection.py"),
)
protection = importlib.util.module_from_spec(_SPEC)
# Registered before exec: @dataclass resolves annotations through sys.modules.
sys.modules["loadtest_protection"] = protection
_SPEC.loader.exec_module(protection)


def _snap(**counters) -> dict:
    return {"reads": {"pod-a": dict(counters)}, "errors": {}}


# ── reading the exposition ───────────────────────────────────────────────


def test_every_label_set_counts_toward_the_same_verdict():
    """A fail-open on one node for one reason is as much a violation as on
    another, so the series are summed rather than tracked apart."""
    totals = protection.parse_exposition(
        "# TYPE aggregation_slot_fail_open_total counter\n"
        'aggregation_slot_fail_open_total{kind="write",node="a",reason="deadline"} 2\n'
        'aggregation_slot_fail_open_total{kind="write",node="b",reason="bus_error"} 1\n'
        "some_unlabelled_metric 7\n"
    )
    assert totals["aggregation_slot_fail_open_total"] == 3.0
    assert totals["some_unlabelled_metric"] == 7.0


def test_comments_and_junk_do_not_become_numbers():
    assert protection.parse_exposition("# HELP x thing\n# TYPE x counter\n\n") == {}
    assert protection.parse_exposition("x NaN-ish\n") == {}


# ── what fails the run ───────────────────────────────────────────────────


def test_a_fail_open_fails_the_run():
    """One fail-open is one admission that was not admitted. There is no
    acceptable rate, so the ceiling is zero."""
    violations = protection.compare(
        _snap(aggregation_slot_fail_open_total=4.0),
        _snap(aggregation_slot_fail_open_total=5.0),
    )
    assert len(violations) == 1
    assert "aggregation_slot_fail_open_total +1" in violations[0]


def test_dropped_series_fail_because_the_gate_stops_being_able_to_tell():
    """The registry caps series per metric. Past that cap every counter here
    is an undercount, so a clean result would be a result about nothing."""
    violations = protection.compare(
        _snap(metrics_series_dropped_total=0.0),
        _snap(metrics_series_dropped_total=12.0),
    )
    assert violations and "undercount" in violations[0]


def test_a_counter_that_went_backwards_means_a_restart():
    """Counters only rise. A fall means the process went away mid-run, which
    both voids every delta and is itself the finding."""
    violations = protection.compare(
        _snap(aggregation_slot_fail_open_total=9.0),
        _snap(aggregation_slot_fail_open_total=1.0),
    )
    assert violations and "restarted mid-run" in violations[0]


def test_an_unreadable_endpoint_is_not_a_pass():
    """The failure this whole module exists to prevent is an ungated capacity
    run, so it cannot be what happens when the endpoint is off."""
    before = {"reads": {}, "errors": {"pod-a": "HTTPError: 404"}}
    violations = protection.compare(before, {"reads": {}, "errors": {}})
    assert violations and "NOT gated" in violations[0]
    assert "METRICS_ENABLED" in violations[0]


def test_a_pod_that_vanished_mid_run_is_reported():
    violations = protection.compare(
        _snap(aggregation_slot_waits_total=1.0),
        {"reads": {}, "errors": {"pod-a": "URLError: connection refused"}},
    )
    assert violations and "not after" in violations[0]


# ── what must NOT fail the run ───────────────────────────────────────────


def test_the_protection_doing_its_job_is_not_a_violation():
    """Holds, waits, yields and budget refusals are the system defending
    itself. Failing the run on them produces a gate that gets switched off,
    and then nothing watches the one counter that matters."""
    violations = protection.compare(
        _snap(
            aggregation_governor_holds_total=0.0,
            aggregation_slot_waits_total=0.0,
            aggregation_read_pressure_yields_total=0.0,
            aggregation_write_budget_refusals_total=0.0,
        ),
        _snap(
            aggregation_governor_holds_total=31.0,
            aggregation_slot_waits_total=88.0,
            aggregation_read_pressure_yields_total=14.0,
            aggregation_write_budget_refusals_total=2.0,
        ),
    )
    assert violations == []


def test_but_it_goes_on_the_record():
    """Not failing is not the same as not reporting — a run that only passed
    because the governor held for four minutes should say so."""
    lines = protection.report(
        _snap(aggregation_governor_holds_total=0.0),
        _snap(aggregation_governor_holds_total=31.0),
    )
    assert any("aggregation_governor_holds_total +31" in line for line in lines)


def test_a_quiet_run_passes_clean():
    steady = dict(
        aggregation_slot_fail_open_total=2.0,
        aggregation_governor_holds_total=5.0,
    )
    assert protection.compare(_snap(**steady), _snap(**steady)) == []
    assert protection.report(_snap(**steady), _snap(**steady)) == []


# ── the CLI the Makefile calls ───────────────────────────────────────────


def test_the_baseline_step_fails_loudly_when_nothing_is_scrapeable(tmp_path, monkeypatch):
    """Better to stop before the run than to discover afterwards that the
    expensive thing you just did was not measured."""
    monkeypatch.setattr(protection, "snapshot", lambda urls, token: {"reads": {}, "errors": {"u": "404"}})
    out = tmp_path / "protection.json"
    assert protection.main(["prog", "--before", str(out)]) == 1


def test_check_reads_the_baseline_back(tmp_path, monkeypatch):
    out = tmp_path / "protection.json"
    out.write_text(json.dumps(_snap(aggregation_slot_fail_open_total=1.0)))
    monkeypatch.setattr(
        protection, "snapshot",
        lambda urls, token: _snap(aggregation_slot_fail_open_total=1.0),
    )
    assert protection.main(["prog", "--check", str(out)]) == 0

    monkeypatch.setattr(
        protection, "snapshot",
        lambda urls, token: _snap(aggregation_slot_fail_open_total=2.0),
    )
    assert protection.main(["prog", "--check", str(out)]) == 1
