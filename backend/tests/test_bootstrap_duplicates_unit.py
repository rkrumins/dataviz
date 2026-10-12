"""Duplicate identifiers in "enable version control", without infrastructure.

The pre-flight ranks every copy of a duplicated urn and the copy then skips the ones a manager
decided to collapse. What must hold, whatever the source looks like:

* `lastSyncedAt` is compared as TIME, in whatever form the source wrote it — never as text;
* a copy is skipped only while it is still that copy (internal id, urn AND label);
* an edge between two copies of one urn is dropped, a node's edge to itself is kept;
* an edge whose id is also a node's is re-keyed, not lost;
* every scanned row is counted exactly once — written, collapsed, rejected or merged — so the
  validate formulas subtract each once;
* the collapse in the source graph never seeks a node by id under UNWIND;
* a failure says what can be done about it.
"""
import types
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import bootstrap_worker as bw
from backend.app.services.versioning.bootstrap_worker import (
    BootstrapRunner,
    _api_status,
    _copy_groups,
    _decode_cursor,
    _encode_cursor,
    _explain_failed_checks,
    _fit_groups,
    _normalize_synced_at,
    _preflight_rows,
    _rekey,
    _tally_checks,
    _vid,
)

UTC = timezone.utc


# ── lastSyncedAt: one timeline, whatever the spelling ─────────────────────────

@pytest.mark.parametrize("raw, expected", [
    ("2026-03-01T10:00:00Z", datetime(2026, 3, 1, 10, tzinfo=UTC)),
    ("2026-03-01T12:00:00+02:00", datetime(2026, 3, 1, 10, tzinfo=UTC)),
    ("2026-03-01 10:00:00", datetime(2026, 3, 1, 10, tzinfo=UTC)),          # no zone → UTC
    ("2026-03-01", datetime(2026, 3, 1, tzinfo=UTC)),
    (1772359200, datetime(2026, 3, 1, 10, tzinfo=UTC)),                    # epoch seconds
    (1772359200000, datetime(2026, 3, 1, 10, tzinfo=UTC)),                 # epoch milliseconds
    ("1772359200000", datetime(2026, 3, 1, 10, tzinfo=UTC)),               # ...as text
    (datetime(2026, 3, 1, 10), datetime(2026, 3, 1, 10, tzinfo=UTC)),
])
def test_synced_at_reads_every_form_the_source_writes(raw, expected):
    assert _normalize_synced_at(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "yesterday", "not-a-date", True, {"at": 1}, [1], 1e300])
def test_an_unusable_synced_at_is_none_and_ranks_last(raw):
    assert _normalize_synced_at(raw) is None


def test_the_ranking_is_chronological_not_lexical():
    # As text, an epoch number and an ISO string don't sort against each other at all ("1790…"
    # < "2026…" whatever the dates): a lexical ranking would keep the wrong copy.
    forms = ["2026-09-30T23:00:00+00:00", 1790812800, "2026-10-02 00:00:00", "1790985600000"]
    times = [_normalize_synced_at(f) for f in forms]
    assert times == sorted(times)
    assert times[1] - times[0] == timedelta(hours=1)           # 2026-10-01T00:00Z, as seconds
    assert times[3] - times[2] == timedelta(days=1)            # 2026-10-03T00:00Z, as ms text


# ── the pre-flight's own rows ──────────────────────────────────────────────────

def test_the_preflight_drops_derived_nodes_and_counts_the_invisible():
    rows = [(0, ["Table"], "urn:a", "2026-01-01"), (1, ["_AggMeta"], None, None),
            (2, ["Table"], None, None), (3, ["_GVRollupMeta", "Column"], "urn:b", None)]
    records, visible, invisible = _preflight_rows(rows, "g1")
    assert (visible, invisible) == (1, 1), "the rollup marker is neither data nor invisible data"
    assert records == [{"graph_id": "g1", "falkor_id": 0, "urn": "urn:a", "label": "Table",
                        "last_synced_at": datetime(2026, 1, 1, tzinfo=UTC), "copy_rank": None}]


def test_an_empty_urn_is_no_urn_and_never_a_duplicated_identifier():
    """The reader drops a node whose urn is empty; ranked as an identifier, two of them would
    pause the job on a duplicate no copy can ever resolve."""
    records, visible, invisible = _preflight_rows(
        [(0, ["Table"], "", None), (1, ["Table"], "", None)], "g1")
    assert (records, visible, invisible) == ([], 0, 2)
    for cypher in (bw._COUNT_NODES, bw._SCAN_NODES, bw._SCAN_EDGES, bw._PREFLIGHT_EDGES):
        assert "urn <> ''" in cypher, cypher


# ── the copy: skip a collapsed copy only while it is still that copy ──────────

def _ctx():
    return types.SimpleNamespace(commit_id="cmt_1", commit_seq=2, main_id="main_1", actor="bot")


def _nodes(rows, losers):
    return BootstrapRunner._nodes_to_rows(object(), rows, _ctx(), "g1", None, losers)


def _node(fid, urn, label="Table", **props):
    return (fid, [label], {"urn": urn, "displayName": urn, **props})


def test_a_collapsed_copy_is_skipped_and_counted():
    win = _nodes([_node(0, "urn:a"), _node(1, "urn:a")], losers={(1, "urn:a", "Table")})
    assert [d["entity_id"] for d in win.dicts] == ["urn:a"]
    assert win.scanned == {"Table": 2} and win.collapsed == {"Table": 1}
    assert win.meta["urn:a"] == ("Table", 0), "the stored copy's own label and id ride along"
    assert win.rejects["duplicateUrns"] == 0


@pytest.mark.parametrize("loser", [
    (1, "urn:other", "Table"),      # the id now belongs to a different urn (FalkorDB re-used it)
    (1, "urn:a", "Column"),         # same id and urn, but not the label that was ranked
    (7, "urn:a", "Table"),          # a different node altogether
])
def test_a_node_that_is_no_longer_the_ranked_copy_is_copied(loser):
    win = _nodes([_node(1, "urn:a")], losers={loser})
    assert [d["entity_id"] for d in win.dicts] == ["urn:a"] and win.collapsed == {}


def test_a_duplicate_nobody_decided_about_is_rejected_not_written():
    win = _nodes([_node(0, "urn:a"), _node(1, "urn:a")], losers=set())
    assert len(win.dicts) == 1
    assert win.rejects["duplicateUrns"] == 1 and win.rejects["byLabel"] == {"Table": 1}


# ── edges: collapse self-loops go, genuine ones stay; id clashes are re-keyed ─

def _edges(rows, live):
    return BootstrapRunner._edges_to_rows(object(), rows, _ctx(), "g1", None, live)


def test_an_edge_between_two_copies_of_one_urn_is_dropped_and_counted():
    win = _edges([(0, 1, "urn:a", "urn:a", "FLOWS_TO", {"id": "e1"}),     # two copies
                  (0, 0, "urn:a", "urn:a", "FLOWS_TO", {"id": "e2"}),     # one node, to itself
                  (0, 2, "urn:a", "urn:b", "FLOWS_TO", {"id": "e3"})], {"urn:a", "urn:b"})
    assert [d["entity_id"] for d in win.dicts] == ["e2", "e3"]
    assert win.self_loops == 1 and win.rejects["danglingEdges"] == 0


def test_an_edge_whose_id_is_a_nodes_is_rekeyed_deterministically():
    dicts = [{"entity_id": "urn:a", "id": _vid("evb", "cmt_1", "urn:a")},
             {"entity_id": "e2", "id": _vid("evb", "cmt_1", "e2")}]
    assert _rekey(dicts, {"urn:a"}, "cmt_1") == 1
    assert dicts[0] == {"entity_id": "edge:urn:a", "id": _vid("evb", "cmt_1", "edge:urn:a")}
    assert dicts[1]["entity_id"] == "e2", "only the clashing edge moves"


# ── validate: every scanned row is subtracted exactly once ────────────────────

def _summary(**over):
    s = {
        "source": {"nodes": 10, "edges": 9, "maxNodeId": 12},
        "scanned": {"nodes": 10, "edges": 9, "byLabel": {"Table": 7, "Column": 3},
                    "byType": {"FLOWS_TO": 5}},
        # 10 nodes = 6 written + 3 collapsed + 1 rejected.
        # 9 edges = 5 written + 1 dangling + 1 merged parallel + 2 collapse self-loops.
        "written": {"nodes": 6, "edges": 5, "byLabel": {"Table": 4, "Column": 2},
                    "byType": {"FLOWS_TO": 5}},
        "collapsed": {"nodes": 3, "byLabel": {"Table": 2, "Column": 1}, "selfLoops": 2},
        "rejected": {"duplicateUrns": 1, "danglingEdges": 1, "byLabel": {"Table": 1}},
        "collapsedParallelEdges": 1,
        "duplicates": {"identifiers": 2, "extraCopies": 3, "fingerprint": "f1"},
        "duplicatePolicy": {"policy": "collapse", "fingerprint": "f1"},
    }
    s.update(over)
    return s


def _checks(summary, pg_labels=None, pg_types=None):
    out = _tally_checks(summary, pg_labels or {"Table": 4, "Column": 2},
                        pg_types or {"FLOWS_TO": 5})
    return {c["key"]: c for c in out}


def test_the_written_counts_reconcile_without_double_subtraction():
    checks = _checks(_summary())
    for key in ("nodes_seen", "edges_seen", "nodes_written", "edges_written",
                "labels_preserved", "types_preserved", "duplicates_collapsed"):
        assert checks[key]["ok"], (key, checks[key])
    # The rejected duplicate and the dangling edge still fail their own checks — once.
    assert not checks["no_duplicate_items"]["ok"] and not checks["no_dropped_connections"]["ok"]


def test_a_row_lost_between_the_scan_and_the_store_fails_the_count():
    s = _summary(written={"nodes": 5, "edges": 5, "byLabel": {"Table": 3, "Column": 2},
                          "byType": {"FLOWS_TO": 5}})
    checks = _checks(s, pg_labels={"Table": 3, "Column": 2})
    assert not checks["nodes_written"]["ok"] and not checks["labels_preserved"]["ok"]


def test_a_label_count_that_postgres_disagrees_with_fails():
    checks = _checks(_summary(), pg_labels={"Table": 5, "Column": 1})
    assert not checks["labels_preserved"]["ok"]


def test_collapsing_fewer_copies_than_listed_is_reported_not_blocking_once_decided():
    s = _summary(collapsed={"nodes": 2, "byLabel": {"Table": 1, "Column": 1}, "selfLoops": 2},
                 written={"nodes": 7, "edges": 5, "byLabel": {"Table": 5, "Column": 2},
                          "byType": {"FLOWS_TO": 5}})
    check = _checks(s, pg_labels={"Table": 5, "Column": 2})["duplicates_collapsed"]
    assert not check["ok"] and not check["blocking"]
    undecided = _summary(duplicatePolicy=None)
    assert _checks(undecided)["duplicates_collapsed"]["blocking"]


def test_a_job_from_before_the_preflight_is_checked_the_old_way():
    s = _summary(source={"nodes": 10, "edges": 9})              # no maxNodeId
    s["written"] = {"nodes": 6, "edges": 5}                     # no per-label tallies either
    checks = _checks(s, pg_labels={"Table": 7, "Column": 3})
    assert checks["labels_preserved"]["ok"]


# ── failures say what can be done ─────────────────────────────────────────────

def test_an_integrity_failure_offers_a_restart_and_an_outage_a_resume():
    assert bw._FAILURE_ACTIONS == {"integrity": "restart", "infrastructure": "resume"}
    assert bw._FAILURE_ACTIONS.get("internal") is None


@pytest.mark.parametrize("key, expected", [
    ("duplicates_resolved", "no copy left to keep"),
    ("source_stable", "changed while we were copying"),
    ("no_duplicate_items", "share an identifier"),
])
def test_the_new_checks_explain_themselves(key, expected):
    assert expected in _explain_failed_checks([{"key": key, "ok": False, "blocking": True}])


def test_a_paused_job_reads_as_needing_a_decision():
    job = types.SimpleNamespace(status="pending", current_phase="awaiting_decision")
    assert _api_status(job) == "needs_decision"
    assert _api_status(types.SimpleNamespace(status="pending", current_phase="nodes")) == "pending"


# ── the duplicate list's cursor ───────────────────────────────────────────────

@pytest.mark.parametrize("raw, cell", [
    ("urn:li:dataset:a", "urn:li:dataset:a"), ("=HYPERLINK(\"x\")", "'=HYPERLINK(\"x\")"),
    ("+1", "'+1"), ("-cmd", "'-cmd"), ("@SUM(A1)", "'@SUM(A1)"), ("", ""),
])
def test_a_source_string_in_the_csv_is_never_a_formula(raw, cell):
    assert bw._csv_text(raw) == cell


def test_the_list_cursor_round_trips_and_refuses_what_it_did_not_issue():
    assert _decode_cursor(_encode_cursor(("urn:a|b/c", 3))) == ("urn:a|b/c", 3)
    assert _decode_cursor(None) is None
    with pytest.raises(ValueError):
        _decode_cursor("not-a-cursor")


# ── the collapse in the source graph ──────────────────────────────────────────

def test_a_window_of_copies_is_whole_urns():
    rows = [("urn:a", 1, "T", 1), ("urn:a", 5, "T", 2), ("urn:b", 2, "T", 1), ("urn:b", 9, "C", 2)]
    groups = _copy_groups(rows, drop_last=True)
    assert [g["urn"] for g in groups] == ["urn:a"], "a page may have cut the last urn short"
    assert groups[0] == {"urn": "urn:a", "kept": (1, "T"), "discarded": [(5, "T")],
                         "skip": {1, 5}}
    assert [g["urn"] for g in _copy_groups(rows[:2], drop_last=True)] == ["urn:a"], \
        "but never the only one"


def test_a_window_holds_as_many_urns_as_its_writes_allow_and_at_least_one():
    groups = _copy_groups([("urn:a", 1, "T", 1), ("urn:a", 2, "T", 2),
                           ("urn:b", 3, "T", 1), ("urn:b", 4, "T", 2)], drop_last=False)
    rels = {2: {("out", 9, "R", True)} | {("in", i, "R", True) for i in range(10, 20)}, 4: set()}
    assert [g["urn"] for g in _fit_groups(groups, rels, cap=5)] == ["urn:a"]
    assert [g["urn"] for g in _fit_groups(groups, rels, cap=100)] == ["urn:a", "urn:b"]


@pytest.mark.parametrize("cypher", [
    bw._dupe_edges_cypher("Table", "out"),
    bw._dupe_edges_cypher("Table", "in"),
    bw._dupe_repoint_cypher("Table", "Column", "FLOWS_TO", "out", True),
    bw._dupe_repoint_cypher("Table", "Column", "FLOWS_TO", "in", False),
    bw._dupe_self_loop_cypher("Table", "Table", "FLOWS_TO"),
    bw._dupe_delete_cypher("Table"),
])
def test_every_collapse_statement_seeks_by_label_and_urn_before_the_id(cypher):
    assert "MATCH (l:`Table` {urn: row.urn}) WHERE ID(l) = row.lid" in cypher
    assert "MATCH (n) WHERE ID(n)" not in cypher and "MATCH (l) WHERE ID(l)" not in cypher


def test_a_keyed_move_merges_on_the_relationship_id_and_a_keyless_one_on_its_ends():
    keyed = bw._dupe_repoint_cypher("T", "T", "R", "out", True)
    assert "MERGE (w)-[n:`R` {id: r.id}]->(o)" in keyed and "r.id IS NOT NULL" in keyed
    keyless = bw._dupe_repoint_cypher("T", "T", "R", "in", False)
    assert "MERGE (o)-[n:`R`]->(w)" in keyless and "r.id IS NULL" in keyless
    assert "coalesce(o.urn, '') <> row.urn" in keyed, \
        "copies of one urn never get an edge between them"


# ── window fitting ─────────────────────────────────────────────────────────────

async def test_an_edge_window_halves_until_it_fits_and_says_how_full_it_is(monkeypatch):
    r = BootstrapRunner(graph_factory=lambda *a, **k: None, session_factory=lambda: None)
    asked = []

    async def count(_client, lo, width, cypher=bw._COUNT_EDGES_IN_WINDOW):
        asked.append(width)
        return width * 3                                   # three edges per node

    monkeypatch.setattr(r, "_count_window", count)
    width, held = await r._fit_window(object(), bw._COUNT_EDGES_IN_WINDOW, 0, 1000, 600)
    assert (width, held) == (125, 375) and asked == [1000, 500, 250, 125]


async def test_an_edge_window_that_cannot_be_counted_is_left_to_the_scan_ladder(monkeypatch):
    r = BootstrapRunner(graph_factory=lambda *a, **k: None, session_factory=lambda: None)

    async def broken(*_a, **_k):
        raise TimeoutError("Timeout reading from falkordb")

    monkeypatch.setattr(r, "_count_window", broken)
    assert await r._fit_edge_window(object(), 0, 4000) == (4000, None)


def test_property_scans_are_capped():
    assert bw._edge_target() <= bw._PROPS_ROWS_CAP == 20_000
