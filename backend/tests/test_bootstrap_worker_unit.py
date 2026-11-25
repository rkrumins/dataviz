"""Pure logic of the "enable version control" bootstrap job (no infra).

The parts that must be right for a 10M-entity copy to be resumable and honest:
deterministic version ids (so replaying a window is a no-op), exactly-once tally
accumulation across windows, the reservoir sample, the phase machine, and the
integrity comparisons that decide whether the copy is allowed to become visible.
"""
import types

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.bootstrap_worker import (
    PHASES,
    BootstrapFailure,
    BootstrapRunner,
    _Reservoir,
    _advance_phase,
    _explain_failed_checks,
    _label_of,
    _merge_scan_summary,
    _next_phase,
    _percent,
    _physical_types,
    _spelled_two_ways,
    _tally_matches,
    _vid,
)
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules


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
    # The whole safety story: prove the copy, publish heads, stamp the projector's
    # delete anchors — and only THEN flip the head, which is the one irreversible step.
    assert PHASES.index("validate") < PHASES.index("heads") < PHASES.index("finalize")
    assert PHASES.index("backfill") < PHASES.index("finalize"), (
        "finalize makes the graph live and writable; if the delete anchors (n.entityId, "
        "r.id) aren't stamped yet, an edit duplicates nodes and a delete silently no-ops"
    )
    assert PHASES[-1] == "finalize"


def test_a_restart_clears_the_old_copy_before_anything_is_read_again():
    # `reset` deletes what an earlier run imported (on the worker, in windows); it must come
    # before the counts that the re-read is checked against.
    assert PHASES[0] == "reset" and _next_phase("reset") == "counting"


def test_advancing_a_phase_starts_it_from_scratch():
    job = types.SimpleNamespace(current_phase="nodes", last_cursor="nodes:400", batch_size=7)
    _advance_phase(job, "edges")
    assert (job.current_phase, job.last_cursor, job.batch_size) == (
        "edges", None, config.BOOTSTRAP_SCAN_WIDTH)


def test_next_phase_walks_to_the_end():
    assert _next_phase("counting") == "nodes"
    assert _next_phase("edges") == "connections"
    assert _next_phase("connections") == "resolve"
    assert _next_phase("resolve") == "validate"
    assert _next_phase("backfill") == "finalize"
    assert _next_phase("finalize") is None


def test_percent_tracks_the_scan_and_never_exceeds_its_span():
    assert _percent("nodes", 0, 100) == 2
    assert _percent("edges", 100, 100) == 72
    assert _percent("nodes", 250, 100) == 72          # clamped
    assert _percent("nodes", 0, 0) == 2               # unknown total → phase floor


# ── tallies accumulate exactly once across windows ───────────────────────────

def test_scan_summary_accumulates_across_windows():
    s = {}
    s = _merge_scan_summary(s, "nodes", scanned=3, written=2, tallies={"Table": 2},
                            rejects={"duplicateUrns": 1, "samples": [{"kind": "node"}]},
                            sample={"nodes": ["a"], "nodesSeen": 2}, dupes=0)
    s = _merge_scan_summary(s, "nodes", scanned=2, written=2, tallies={"Table": 1, "Column": 1},
                            rejects={}, sample={"nodes": ["a", "b"], "nodesSeen": 4}, dupes=0)
    assert s["scanned"]["nodes"] == 5
    assert s["written"]["nodes"] == 4
    assert s["scanned"]["byLabel"] == {"Table": 3, "Column": 1}
    assert s["rejected"]["duplicateUrns"] == 1
    assert s["sample"] == {"nodes": ["a", "b"], "nodesSeen": 4}


def test_scan_summary_keeps_node_and_edge_tallies_apart():
    s = _merge_scan_summary({}, "nodes", scanned=2, written=2, tallies={"Table": 2},
                            rejects={}, sample=None, dupes=0)
    s = _merge_scan_summary(s, "edges", scanned=3, written=2, tallies={"FLOWS_TO": 2},
                            rejects={"danglingEdges": 0}, sample=None, dupes=1)
    assert s["scanned"] == {"nodes": 2, "edges": 3,
                            "byLabel": {"Table": 2}, "byType": {"FLOWS_TO": 2}}
    assert (s["written"]["nodes"], s["written"]["edges"]) == (2, 2)
    assert s["collapsedParallelEdges"] == 1


def test_reject_samples_are_bounded():
    s = {}
    for i in range(50):
        s = _merge_scan_summary(s, "nodes", scanned=1, written=0, tallies={},
                                rejects={"duplicateUrns": 1, "samples": [{"kind": "node", "i": i}]},
                                sample=None, dupes=0)
    assert s["rejected"]["duplicateUrns"] == 50
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
    ("no_duplicate_items", "share an identifier"),
    ("no_dropped_connections", "point at items that don't exist"),
    ("one_spelling_per_type", "spelled more than one way"),
    ("properties_kept", "not kept by the copy"),
    ("review_decided", "not all decided"),
    ("edge_sample_matches", "changed while we were copying"),
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


# ── a graph server that cuts replies short (FalkorDB RESULTSET_SIZE) ─────────

class _Configured:
    """A graph client whose server answers ``GRAPH.CONFIG GET RESULTSET_SIZE`` with ``cap``."""

    def __init__(self, cap):
        self.cap, self.sent = cap, []

    async def execute_command(self, *args):
        self.sent.append(args)
        return [b"RESULTSET_SIZE", self.cap]


async def test_a_server_that_cuts_replies_short_is_refused():
    # The stock falkordb/falkordb image's RESULTSET_SIZE: a 20k-node pre-flight window came back
    # as 10,000 rows, its duplicates unseen, and the copy failed with "the source changed".
    with pytest.raises(BootstrapFailure) as exc:
        await BootstrapRunner._require_whole_replies(object(), _Configured(10000))
    assert exc.value.code == "infrastructure"
    assert "10,000 rows" in exc.value.reason and "RESULTSET_SIZE" in exc.value.reason


async def test_an_uncapped_server_or_one_that_will_not_say_is_read():
    await BootstrapRunner._require_whole_replies(object(), _Configured(-1))
    await BootstrapRunner._require_whole_replies(object(), object())   # no raw command: a fake


async def test_the_production_graph_handle_answers_the_config_read():
    # The registry's ResilientGraph hands an unwrapped call to the graph's own client: without
    # that, the read would fail, read as "no cap", and production would never be checked.
    from backend.app.providers.falkordb_connection import FalkorDBConnConfig, ResilientGraph

    inner = _Configured(10000)
    with pytest.raises(BootstrapFailure):
        await BootstrapRunner._require_whole_replies(
            object(), ResilientGraph(None, FalkorDBConnConfig(), "g", inner))
    assert inner.sent == [("GRAPH.CONFIG", "GET", "RESULTSET_SIZE")]


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


# ── job-worker edge serialization is the canonical shape (regression: rebuild blanked edges) ──

def _edges_to_rows(rows, live):
    # `_edges_to_rows` reads no instance state, so drive it with a bare object as `self`. A scan
    # row is (source id, target id, source urn, target urn, type, properties).
    ctx = types.SimpleNamespace(commit_id="cmt_1", commit_seq=1, main_id="main_1", actor="alice")
    win = BootstrapRunner._edges_to_rows(
        object(), [(i, i + 1, *row) for i, row in enumerate(rows)], ctx, "g1", None, live)
    return win.dicts, win.scanned, win.rejects, None, win.dupes


def test_edges_to_rows_emits_canonical_payload_with_confidence_and_nested_props():
    # A FalkorDB edge row carries confidence + a nested `properties` dict (here as the JSON string
    # form the reader tolerates). The stored payload must be canonical — NOT the old flattened shape
    # that spread props at the top level and dropped confidence, which blanked both on every rebuild.
    rows = [("urn:a", "urn:b", "DERIVES_FROM",
             {"id": "l1", "confidence": 0.9, "properties": '{"sql": "select email"}'})]
    dicts, tallies, rejects, _sample, dupes = _edges_to_rows(rows, {"urn:a", "urn:b"})
    assert len(dicts) == 1 and rejects["danglingEdges"] == 0 and dupes == 0
    payload = dicts[0]["payload"]
    assert payload == {"edgeType": "DERIVES_FROM", "sourceEntityId": "urn:a",
                       "targetEntityId": "urn:b", "confidence": 0.9,
                       "properties": {"sql": "select email"}}
    # the durable row columns mirror the canonical payload (confidence is not lost to the column either)
    assert dicts[0]["confidence"] == 0.9
    assert dicts[0]["source_entity_id"] == "urn:a" and dicts[0]["target_entity_id"] == "urn:b"
    assert tallies == {"DERIVES_FROM": 1}


def test_edges_to_rows_bare_containment_edge_has_no_confidence_key():
    rows = [("urn:layer:1", "urn:obj:1", "CONTAINS", {"id": "c1"})]
    dicts, _tallies, _rejects, _sample, _dupes = _edges_to_rows(rows, {"urn:layer:1", "urn:obj:1"})
    payload = dicts[0]["payload"]
    assert payload == {"edgeType": "CONTAINS", "sourceEntityId": "urn:layer:1",
                       "targetEntityId": "urn:obj:1"}   # no confidence/properties keys
    assert dicts[0]["confidence"] is None


def test_edges_to_rows_drops_dangling_and_dedups_same_triple():
    rows = [
        ("urn:a", "urn:missing", "CONTAINS", {"id": "c1"}),        # dangling: endpoint not live
        ("urn:a", "urn:b", "CONTAINS", {"id": "c2"}),
        ("urn:a", "urn:b", "CONTAINS", {"id": "c2"}),              # duplicate id → collapsed
    ]
    dicts, _tallies, rejects, _sample, dupes = _edges_to_rows(rows, {"urn:a", "urn:b"})
    assert rejects["danglingEdges"] == 1
    assert dupes == 1
    assert [d["entity_id"] for d in dicts] == ["c2"]


# ── a customer's graph is copied whole: every property, or a question (never a silent drop) ──

#: Ten properties of a customer's relationship, as ``properties(r)`` returns them.
_CUSTOMER_EDGE = {
    "my prop": "val1", "MyProp": "a", "MySpecialProp": "b", "MyLogicalProp": True,
    "weight": 3, "score": 0.7, "naïve ü": "x", "dotted.key": "y", "tags list": ["a", "b"],
    "since": "2024-01-01",
}


def test_edges_to_rows_keeps_every_native_property_of_a_customers_edge():
    dicts, _tallies, _rejects, _sample, dupes = _edges_to_rows(
        [("urn:a", "urn:b", "FLOWS_TO", dict(_CUSTOMER_EDGE))], {"urn:a", "urn:b"})
    assert dupes == 0
    assert dicts[0]["payload"] == {"edgeType": "FLOWS_TO", "sourceEntityId": "urn:a",
                                   "targetEntityId": "urn:b", "properties": _CUSTOMER_EDGE}


def test_edges_to_rows_folds_copies_of_a_connection_that_are_the_same():
    rows = [("urn:a", "urn:b", "CALLS", {"at": "mon"}), ("urn:a", "urn:b", "CALLS", {"at": "mon"})]
    win = BootstrapRunner._edges_to_rows(object(), [(0, 1, *r) for r in rows], _CTX, "g1", None,
                                         {"urn:a", "urn:b"})
    assert len(win.dicts) == 1 and win.dupes == 1 and win.reidentified == 0


def test_edges_to_rows_drops_no_copy_of_a_connection_that_differs():
    """Two copies of one connection (same ends, same type, no id of their own) that say different
    things: neither is dropped — the second gets an id of its own, and the ``connections`` phase
    holds both for a person to decide (``_settle``)."""
    rows = [("urn:a", "urn:b", "CALLS", {"at": "mon"}), ("urn:a", "urn:b", "CALLS", {"at": "tue"})]
    win = BootstrapRunner._edges_to_rows(object(), [(0, 1, *r) for r in rows], _CTX, "g1", None,
                                         {"urn:a", "urn:b"})
    assert win.dupes == 0 and win.reidentified == 1
    assert [(d["entity_id"], d["payload"]["properties"]) for d in win.dicts] == [
        ("urn:a|CALLS|urn:b", {"at": "mon"}), ("edge:urn:a|CALLS|urn:b", {"at": "tue"})]


def test_edges_to_rows_gives_a_connection_sharing_another_ones_id_an_id_of_its_own():
    rows = [(0, 1, "urn:a", "urn:b", "T", {"id": "e1", "w": 1}),
            (0, 2, "urn:a", "urn:c", "T", {"id": "e1", "w": 2})]
    win = BootstrapRunner._edges_to_rows(object(), rows, _CTX, "g1", None,
                                         {"urn:a", "urn:b", "urn:c"})
    assert [(d["entity_id"], d["target_entity_id"]) for d in win.dicts] == [
        ("e1", "urn:b"), ("edge:e1", "urn:c")]


def test_settle_folds_copies_that_agree_and_holds_copies_that_differ():
    from backend.app.services.versioning.bootstrap_worker import _settle

    same = ("urn:a", "T", "urn:b", [("e1", "v1", "h1", "T"), ("edge:e1", "v2", "h1", "T"),
                                    ("e2", "v6", "h1", "T")])
    differ = ("urn:a", "U", "urn:c", [("x", "v3", "h2", "U"), ("edge:x", "v4", "h3", "U"),
                                      ("y", "v5", "h2", "U")])
    payloads = {"v3": {"properties": {"at": "mon"}}, "v4": {"properties": {"at": "tue"}}}
    held, drop, tally = _settle("g1", [same, differ], payloads)
    assert drop == ["v2", "v3", "v4", "v5"], \
        "e1 read twice folds; e2, the same said under an id of its own, stays as it always has"
    assert tally == {"folded": 1, "heldCopies": 3, "held": 1, "byType": {"T": -1, "U": -3}}
    assert [(h["entity_id"], h["seq"], h["detail"]["count"], h["detail"]["ids"],
             h["detail"]["payload"]) for h in held] == [
        ("x", 1, 2, ["x", "y"], {"properties": {"at": "mon"}}),
        ("x", 2, 1, ["edge:x"], {"properties": {"at": "tue"}})]


def test_nodes_to_rows_keeps_what_the_reader_used_to_drop():
    """A customer's own property that shares a name with one the platform keeps for itself is kept
    under ``__src.<name>``; a node whose name is a number is copied, not left out."""
    win = BootstrapRunner._nodes_to_rows(object(), [
        (0, ["Table"], {"urn": "urn:n", "name": "Orders", "entityId": "ERP-17", "owner": "ana",
                        "properties": "free text", "my prop": "val1"}),
        (1, ["Table"], {"urn": "urn:m", "name": 12345, "owner": "raj"}),
    ], _CTX, "g1", None, set())
    by = {d["entity_id"]: d["payload"] for d in win.dicts}
    assert by["urn:n"]["properties"] == {"name": "Orders", "owner": "ana", "my prop": "val1",
                                         "__src.entityId": "ERP-17", "__src.properties": "free text"}
    assert by["urn:m"]["displayName"] == "12345"
    assert by["urn:m"]["properties"] == {"name": 12345, "owner": "raj"}


def test_values_history_cannot_hold_are_stored_as_text_and_held_for_a_decision():
    import json
    from datetime import datetime, timezone

    win = BootstrapRunner._nodes_to_rows(object(), [
        (0, ["Table"], {"urn": "urn:v", "name": "V", "score": float("nan"), "note": "a\x00b",
                        "when": datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)}),
    ], _CTX, "g1", None, set())
    from backend.app.services.versioning.bootstrap_worker import _value_rows

    d = win.dicts[0]
    props = d["payload"]["properties"]
    json.dumps(d["payload"], allow_nan=False)                     # Postgres JSONB takes it
    assert props["when"] == "2026-01-02T03:04:05Z", "a date is stored the one way dates are"
    assert props["score"] == "NaN" and props["note"] == "ab"
    held = _value_rows("g1", d["entity_id"], d["issues"], d["about"])
    assert sorted((h["kind"], h["entity_id"], h["detail"]["property"], h["detail"]["problem"])
                  for h in held) == [("values", "urn:v", "note", "nul"),
                                     ("values", "urn:v", "score", "nan")]
    assert all(h["detail"]["name"] == "V" for h in held)


# ── the graph's own spelling of its types (projection_state.physical_types) ───

_RULES = OntologyRules(entity_types={"Table": EntityRule(), "Column": EntityRule()},
                       edge_types={"FLOWS_TO": EdgeRule()}, edge_type_canonical={"FLOWS_TO": "FLOWS_TO"})
_CTX = types.SimpleNamespace(commit_id="cmt_1", commit_seq=1, main_id="main_1", actor="alice")


def test_a_window_records_how_the_graph_spells_each_type():
    """History stores the declared spelling; the window remembers the graph's own, every one."""
    nodes = BootstrapRunner._nodes_to_rows(
        object(), [(0, ["table"], {"urn": "urn:a"}), (1, ["Table"], {"urn": "urn:b"}),
                   (2, ["Column"], {"urn": "urn:c"})], _CTX, "g1", _RULES, set())
    assert [d["entity_type"] for d in nodes.dicts] == ["Table", "Table", "Column"]
    assert nodes.spellings == {"Table": {"table", "Table"}, "Column": {"Column"}}
    edges = BootstrapRunner._edges_to_rows(
        object(), [(0, 1, "urn:a", "urn:b", "flows_to", {"id": "f1"})], _CTX, "g1", _RULES,
        {"urn:a", "urn:b"})
    assert edges.dicts[0]["edge_type"] == "FLOWS_TO"
    assert edges.spellings == {"FLOWS_TO": {"flows_to"}}


def test_scan_summary_gathers_every_spelling_of_a_type_across_windows():
    s = _merge_scan_summary({}, "nodes", scanned=1, written=1, tallies={}, rejects={}, sample=None,
                            dupes=0, spellings={"Table": {"table"}})
    s = _merge_scan_summary(s, "nodes", scanned=2, written=2, tallies={}, rejects={}, sample=None,
                            dupes=0, spellings={"Table": {"TABLE", "table"}, "Column": {"Column"}})
    s = _merge_scan_summary(s, "edges", scanned=1, written=1, tallies={}, rejects={}, sample=None,
                            dupes=0, spellings={"FLOWS_TO": {"flows_to"}})
    assert s["physicalTypes"] == {"nodes": {"Table": ["TABLE", "table"], "Column": ["Column"]},
                                  "edges": {"FLOWS_TO": ["flows_to"]}}
    assert _spelled_two_ways(s) == [("Table", ["TABLE", "table"])]


def test_the_projector_gets_the_graphs_spelling_of_every_type():
    """Every type, also one spelled as declared: a spelling another writer adds later must not
    make the projector unsure which is the graph's own. Unrecorded (NULL) only when the scan
    tallied nothing, and the projector then reads it from the graph."""
    summary = {"physicalTypes": {"nodes": {"Table": ["table"], "Column": ["Column"]},
                                 "edges": {"FLOWS_TO": ["flows_to"]}}}
    assert _physical_types(summary) == {"nodes": {"Table": "table", "Column": "Column"},
                                        "edges": {"FLOWS_TO": "flows_to"}}
    assert _spelled_two_ways(summary) == []
    assert _physical_types({"physicalTypes": {"nodes": {"Column": ["Column"]}}}) == {
        "nodes": {"Column": "Column"}, "edges": {}}
    assert _physical_types({}) is None, "a job that started before the tally: read from the graph"


# ── stamping urns before the copy (node_identity.stamp_identity_for_enable) ──

async def _stamp_with(db_session, monkeypatch, *, identity=None, name=None):
    """Seed a data source whose provider names nodes by ``identity`` / ``name``, and stamp it
    through a recording stand-in for the cached provider."""
    from contextlib import asynccontextmanager

    from backend.app.db import engine
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
    from backend.app.providers import manager
    from backend.app.services.node_identity import invalidate_global_defaults_cache

    invalidate_global_defaults_cache()
    db_session.add(ProviderORM(id="prov_st", name="P", provider_type="falkordb",
                               identity_property=identity, name_property=name))
    db_session.add(WorkspaceORM(id="ws_st", name="W"))
    db_session.add(WorkspaceDataSourceORM(id="ds_st", workspace_id="ws_st", provider_id="prov_st",
                                          graph_name="g"))
    await db_session.flush()
    calls = []

    class _Provider:
        def set_node_identity(self, identity_property, name_property):
            calls.append(("identity", identity_property, name_property))

        async def stamp_identity_urns(self, **kw):
            calls.append(("stamp", kw))
            return 3

    async def get_provider(workspace_id, session, data_source_id):
        calls.append(("provider", workspace_id, data_source_id))
        return _Provider()

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr(engine, "get_async_session", session)
    monkeypatch.setattr(manager.provider_manager, "get_provider", get_provider)
    return calls


async def test_an_enable_stamps_urn_from_the_identity_property_first(db_session, monkeypatch):
    from backend.app.services.node_identity import stamp_identity_for_enable

    calls = await _stamp_with(db_session, monkeypatch, identity="id", name="title")
    assert await stamp_identity_for_enable("ds_st") == {"property": "id", "stamped": 3}
    # Version control writes into the graph, whatever mode a summaries job left the provider in.
    assert calls == [("provider", "ws_st", "ds_st"), ("identity", "id", "title"),
                     ("stamp", {"source_writable": True})]


async def test_an_enable_of_a_source_keyed_by_urn_stamps_nothing(db_session, monkeypatch):
    from backend.app.services.node_identity import stamp_identity_for_enable

    calls = await _stamp_with(db_session, monkeypatch)
    assert await stamp_identity_for_enable("ds_st") == {"property": "urn", "stamped": 0}
    assert await stamp_identity_for_enable("ds_gone") is None
    assert calls == [], "a conforming source is not even looked up"


@pytest.mark.parametrize("count,identity,expected", [
    (1, "urn", "1 item in the graph has no urn. "),
    (2, "id", "2 items in the graph have no urn and no id to take one from. "),
])
def test_items_with_no_identifier_are_counted_in_plain_language(count, identity, expected):
    from backend.app.services.versioning.bootstrap_worker import _no_identifier

    assert _no_identifier(count, identity).startswith(expected)


# ── a connection held for review, copied as decided ───────────────────────────────────────────

def _versions(*props_conf):
    return [{"seq": i, "detail": {"payload": {
        "edgeType": "CALLS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
        **({"confidence": c} if c is not None else {}), **({"properties": p} if p else {})}}}
        for i, (p, c) in enumerate(props_conf, start=1)]


def test_resolved_keeps_the_first_version_or_the_one_chosen():
    from backend.app.services.versioning.bootstrap_worker import _resolved

    v = _versions(({"at": "mon", "who": "ana"}, 0.5), ({"at": "tue"}, None))
    assert _resolved(v, None, {"rule": "keep_first"})["properties"] == {"at": "mon", "who": "ana"}
    kept = _resolved(v, {"rule": "keep", "keep": 2}, {"rule": "keep_first"})
    assert kept["properties"] == {"at": "tue"} and "confidence" not in kept
    assert v[0]["detail"]["payload"]["properties"] == {"at": "mon", "who": "ana"}, "inputs untouched"


def test_resolved_merges_every_property_and_takes_the_value_picked():
    from backend.app.services.versioning.bootstrap_worker import CONFIDENCE_PICK, _resolved

    v = _versions(({"at": "mon", "who": "ana"}, None), ({"at": "tue", "n": 2}, 0.9),
                  ({"x": 1}, 0.1))
    merged = _resolved(v, None, {"rule": "merge"})
    assert merged["properties"] == {"at": "mon", "who": "ana", "n": 2, "x": 1}, "first holder wins"
    assert merged["confidence"] == 0.9
    picked = _resolved(v, {"rule": "merge", "values": {"at": 2, CONFIDENCE_PICK: 3},
                           "excludeCopies": [], "excludeProperties": ["who"]},
                       {"rule": "keep_first", "excludeProperties": ["x"]})
    assert picked["properties"] == {"at": "tue", "n": 2}, "picks applied, both exclusions honoured"
    assert picked["confidence"] == 0.1
    without = _resolved(v, {"rule": "merge", "excludeCopies": [1]}, {})
    assert without["properties"] == {"at": "tue", "n": 2, "x": 1}
    empty = _resolved(_versions(({"a": 1}, None), ({"a": 2}, None)), None,
                      {"rule": "merge", "excludeProperties": ["a"]})
    assert "properties" not in empty


def test_a_choice_names_only_what_its_connection_holds():
    from backend.app.services.versioning.bootstrap_worker import _check_choice

    assert _check_choice({"rule": "merge", "excludeCopies": [2], "values": {"at": 1},
                          "excludeProperties": ["b", "a", "a"]}, {1, 2}) == {
        "rule": "merge", "excludeCopies": [2], "values": {"at": 1}, "excludeProperties": ["a", "b"]}
    assert _check_choice({"rule": "keep", "keep": 2}, {1, 2})["keep"] == 2
    for bad in ({"rule": "drop"}, {"rule": "keep", "keep": 3}, {"rule": "merge", "excludeCopies": [1, 2]},
                {"rule": "merge", "values": {"at": 9}}, {"rule": "keep_first", "excludeProperties": "a"},
                "merge"):
        with pytest.raises(ValueError):
            _check_choice(bad, {1, 2})


def test_unaccounted_is_empty_for_the_conversion_and_names_what_it_lost():
    from backend.app.services.versioning.bootstrap_worker import _edge_payload, _node_payload, _unaccounted

    raw_edge = {"id": "e1", "confidence": 0.5, "my prop": "v", "properties": '{"inner": 1}'}
    _eid, edge = _edge_payload("urn:a", "urn:b", "T", dict(raw_edge), None)
    assert _unaccounted(raw_edge, edge, rel="T") == []
    assert _unaccounted(raw_edge, {"properties": {"inner": 1}}, rel="T") == ["confidence", "my prop"]
    projected = {"id": "e1", "gvHash": 1, "stale": "x", "properties": '{"kept": 1}'}
    assert _unaccounted(projected, {"properties": {"kept": 1}}, rel="T") == [], "stale keys aren't the edge's"
    raw_node = {"urn": "urn:n", "name": 7, "entityId": "E", "level": 2, "owner": "a",
                "description": "d", "propertiesRaw": '{"deep": {"x": 1}}'}
    node = _node_payload(dict(raw_node), "Table", None)
    assert _unaccounted(raw_node, node, label="Table") == []
    assert _unaccounted(raw_node, {**node, "properties": {}}, label="Table") == [
        "name", "entityId", "owner", "deep"]


def test_tally_checks_count_what_the_review_held_and_put_back():
    from backend.app.services.versioning.bootstrap_worker import _tally_checks

    summary = {"source": {"nodes": 2, "edges": 5}, "scanned": {"nodes": 2, "edges": 5, "byType": {"T": 5}},
               "written": {"nodes": 2, "edges": 2, "byType": {"T": 2}},
               "rejected": {"duplicateUrns": 0, "danglingEdges": 0, "unaccountedProperties": 0},
               "collapsed": {"nodes": 0, "selfLoops": 0}, "collapsedParallelEdges": 0,
               "connections": {"folded": 1, "heldCopies": 3, "held": 1, "resolved": 1},
               "review": {"fingerprint": "f"}, "reviewPolicy": {"fingerprint": "f"}}
    checks = {c["key"]: c for c in _tally_checks(summary, {}, {"T": 2})}
    assert checks["edges_written"]["ok"] and checks["review_decided"]["ok"]
    assert checks["properties_kept"]["ok"] and checks["types_preserved"]["ok"]
    undecided = {**summary, "reviewPolicy": {"fingerprint": "other"}}
    assert not {c["key"]: c for c in _tally_checks(undecided, {}, {"T": 2})}["review_decided"]["ok"]
    lost = {**summary, "rejected": {**summary["rejected"], "unaccountedProperties": 2}}
    assert not {c["key"]: c for c in _tally_checks(lost, {}, {"T": 2})}["properties_kept"]["ok"]
