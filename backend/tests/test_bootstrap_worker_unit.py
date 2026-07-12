"""Pure logic of the "enable version control" bootstrap job (no infra).

The parts that must be right for a 10M-entity copy to be resumable and honest:
deterministic version ids (so replaying a window is a no-op), exactly-once tally
accumulation across windows, the reservoir sample, the phase machine, and the
integrity comparisons that decide whether the copy is allowed to become visible.
"""
import pytest

from backend.app.services.versioning.bootstrap_worker import (
    PHASES,
    BootstrapFailure,
    _Reservoir,
    _explain_failed_checks,
    _label_of,
    _merge_scan_summary,
    _next_phase,
    _percent,
    _tally_matches,
    _vid,
)


# ── deterministic version ids (crash-replay safety) ──────────────────────────

def test_version_id_is_stable_for_the_same_entity():
    a = _vid("nvb", "cmt_1", "urn:x:1")
    b = _vid("nvb", "cmt_1", "urn:x:1")
    assert a == b, "a replayed window must collide with the row it already wrote"


def test_version_id_differs_per_entity_and_per_commit():
    assert _vid("nvb", "cmt_1", "urn:a") != _vid("nvb", "cmt_1", "urn:b")
    assert _vid("nvb", "cmt_1", "urn:a") != _vid("nvb", "cmt_2", "urn:a")
    assert _vid("evb", "cmt_1", "urn:a") != _vid("nvb", "cmt_1", "urn:a")


# ── phase machine ────────────────────────────────────────────────────────────

def test_phase_order_validates_before_anything_becomes_visible():
    # The whole safety story: prove the copy, THEN publish heads, THEN flip the head.
    assert PHASES.index("validate") < PHASES.index("heads") < PHASES.index("finalize")
    assert PHASES.index("backfill") > PHASES.index("finalize")


def test_next_phase_walks_to_the_end():
    assert _next_phase("counting") == "nodes"
    assert _next_phase("edges") == "validate"
    assert _next_phase("backfill") is None


def test_percent_tracks_the_scan_and_never_exceeds_its_span():
    assert _percent("nodes", 0, 100) == 2
    assert _percent("edges", 100, 100) == 72
    assert _percent("nodes", 250, 100) == 72          # clamped
    assert _percent("nodes", 0, 0) == 2               # unknown total → phase floor


# ── tallies accumulate exactly once across windows ───────────────────────────

def test_scan_summary_accumulates_across_windows():
    s = {}
    s = _merge_scan_summary(s, "nodes", scanned=3, written=2, tallies={"Table": 2},
                            rejects={"urnlessNodes": 1, "samples": [{"kind": "node"}]},
                            sample={"nodes": ["a"], "nodesSeen": 2}, dupes=0)
    s = _merge_scan_summary(s, "nodes", scanned=2, written=2, tallies={"Table": 1, "Column": 1},
                            rejects={}, sample={"nodes": ["a", "b"], "nodesSeen": 4}, dupes=0)
    assert s["scanned"]["nodes"] == 5
    assert s["written"]["nodes"] == 4
    assert s["scanned"]["byLabel"] == {"Table": 3, "Column": 1}
    assert s["rejected"]["urnlessNodes"] == 1
    assert s["sample"] == {"nodes": ["a", "b"], "nodesSeen": 4}


def test_scan_summary_keeps_node_and_edge_tallies_apart():
    s = _merge_scan_summary({}, "nodes", scanned=2, written=2, tallies={"Table": 2},
                            rejects={}, sample=None, dupes=0)
    s = _merge_scan_summary(s, "edges", scanned=3, written=2, tallies={"FLOWS_TO": 2},
                            rejects={"danglingEdges": 0}, sample=None, dupes=1)
    assert s["scanned"] == {"nodes": 2, "edges": 3,
                            "byLabel": {"Table": 2}, "byType": {"FLOWS_TO": 2}}
    assert s["written"] == {"nodes": 2, "edges": 2}
    assert s["collapsedParallelEdges"] == 1


def test_reject_samples_are_bounded():
    s = {}
    for i in range(50):
        s = _merge_scan_summary(s, "nodes", scanned=1, written=0, tallies={},
                                rejects={"urnlessNodes": 1, "samples": [{"kind": "node", "i": i}]},
                                sample=None, dupes=0)
    assert s["rejected"]["urnlessNodes"] == 50
    assert len(s["rejected"]["samples"]) == 10, "samples must not grow with the graph"


# ── integrity comparisons ────────────────────────────────────────────────────

def test_tally_match_requires_every_type_to_survive():
    assert _tally_matches({"Table": 2, "Column": 1}, {"Table": 2, "Column": 1})
    assert not _tally_matches({"Table": 2}, {"Table": 2, "Column": 1}), "a lost type must fail"
    assert not _tally_matches({"Table": 1}, {"Table": 2}), "a lost item must fail"


def test_tally_match_tolerates_merged_duplicate_connections_only_when_allowed():
    # Parallel connections (same type, same pair) are indistinguishable and the read
    # layer merges them too — allowed for edges, never for items.
    assert _tally_matches({"FLOWS_TO": 3}, {"FLOWS_TO": 4}, allow_lower=True)
    assert not _tally_matches({"FLOWS_TO": 0}, {"FLOWS_TO": 4}, allow_lower=True)
    assert not _tally_matches({"Table": 3}, {"Table": 4})


@pytest.mark.parametrize("key,expected", [
    ("nodes_seen", "changed while we were copying"),
    ("no_untrackable_items", "no identifier"),
    ("no_duplicate_items", "share an identifier"),
    ("no_dropped_connections", "point at items that don't exist"),
])
def test_failed_checks_explain_themselves_in_plain_language(key, expected):
    msg = _explain_failed_checks([{"key": key, "ok": False, "blocking": True, "detail": ""}])
    assert expected in msg


def test_the_specific_data_problem_wins_over_the_generic_one():
    # A duplicate identifier also makes the re-read sample disagree; blaming "the graph
    # changed" would send the user chasing the wrong thing.
    msg = _explain_failed_checks([
        {"key": "sample_matches", "ok": False, "blocking": True, "detail": ""},
        {"key": "no_duplicate_items", "ok": False, "blocking": True, "detail": ""},
    ])
    assert "share an identifier" in msg


def test_bootstrap_failure_carries_a_code():
    exc = BootstrapFailure("nope", "integrity")
    assert exc.reason == "nope" and exc.code == "integrity"


# ── misc ─────────────────────────────────────────────────────────────────────

def test_label_of_skips_the_derived_rollup_marker():
    assert _label_of(["Table"]) == "Table"
    assert _label_of(["_GVRollupMeta", "Table"]) == "Table"
    assert _label_of([]) is None


def test_reservoir_keeps_k_items_and_counts_everything():
    r = _Reservoir(3)
    for i in range(100):
        r.offer(f"urn:{i}")
    assert len(r.items) == 3
    assert r.seen == 100


def test_reservoir_resumes_from_checkpointed_state():
    r = _Reservoir(3, ["urn:a", "urn:b"], seen=2)
    r.offer("urn:c")
    assert r.items == ["urn:a", "urn:b", "urn:c"]
    assert r.seen == 3
