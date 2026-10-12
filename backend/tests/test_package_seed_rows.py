"""A package seed's lines become version rows — what each line becomes, and what it is counted as.

Pinned without a database (``package_seed``'s pure conversions; the job end to end is
``integration/test_package_seed_job.py``):

* a format-2 line keeps its stored payload WHOLE (``lastSyncedAt`` included) and its entity id; a
  format-1 record is read as an import reads it. Either way the payload is sanitized, its types put
  in the ontology's casing, and hashed — the hash is of exactly what is stored;
* a line with no entity id gets one minted from its place in the package: the same every time the
  line is read (a replayed window collides with itself), different for every line;
* every line is accounted for: written, a duplicate id, invalid, the platform's own rollup
  (skipped), a connection to an item the package doesn't hold (dangling), or no item at all;
* the nodes pass notes where the first edge line starts — where the edges pass begins;
* of two items sharing a type and urn, the one kept is the one synced last, then the lowest id;
* a package seed runs its own phases and the bootstrap's shared ones, in its own order.
"""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

from backend.app.services.versioning import bootstrap_worker as bw
from backend.app.services.versioning import package_seed as ps
from backend.app.services.versioning.ids import stable_prefixed_id
from backend.app.services.versioning.merkle import content_hash

CTX = SimpleNamespace(commit_id="cmt_1", commit_seq=2, main_id="br_main", actor="bob")


class _Rules:
    """The ontology's casing: ``table`` → ``Table``, ``flows_to`` → ``FLOWS_TO``."""

    def canonical_entity_type(self, t):
        return {"table": "Table"}.get(str(t).lower())

    def canonical_edge_type(self, t):
        return {"flows_to": "FLOWS_TO"}.get(str(t).lower())


def _lines(*records):
    out, at = [], 0
    for rec in records:
        raw = rec if isinstance(rec, bytes) else json.dumps(rec).encode()
        out.append((at, raw))
        at += len(raw) + 1
    return out


def _v2_node(eid, **payload):
    return {"kind": "node", "entity_id": eid, "baseVersion": "h",
            "payload": {"urn": f"urn:{eid}", "entityType": "table", **payload}}


def _v2_edge(eid, src, tgt, etype="flows_to", **extra):
    return {"kind": "edge", "entity_id": eid, "baseVersion": "h", **extra,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def test_a_format_2_node_keeps_its_stored_payload_whole():
    win = ps.node_rows(_lines(_v2_node(
        "ent_a", displayName="a", lastSyncedAt="2026-02-01T00:00:00Z",
        properties={"owner": "x", "childCount": 3})), ctx=CTX, graph_id="g", rules=_Rules(),
        upload_id="up_1")
    [row] = win.dicts
    assert row["entity_id"] == "ent_a" and row["id"] == bw._vid("nvb", "cmt_1", "ent_a")
    assert row["payload"] == {"urn": "urn:ent_a", "entityType": "Table", "displayName": "a",
                              "lastSyncedAt": "2026-02-01T00:00:00Z",
                              "properties": {"owner": "x"}}, \
        "whole, in the ontology's casing, reserved keys out of its properties"
    assert row["content_hash"] == content_hash(row["payload"])
    assert (row["urn"], row["entity_type"], row["display_name"], row["commit_seq"], row["op"]) == \
        ("urn:ent_a", "Table", "a", 2, "create")


def test_a_format_1_record_is_read_as_an_import_reads_it():
    record = {"kind": "node", "entity_id": "ent_b", "baseVersion": "h", "_op": "",
              "urn": "urn:b", "entityType": "table", "displayName": "b", "tags": "pii, gold",
              "prop.owner": "team", "properties_json": json.dumps({"nested": {"k": 1}})}
    deleting = {**record, "entity_id": "ent_c", "_op": "delete"}
    win = ps.node_rows(_lines(record, deleting), ctx=CTX, graph_id="g", rules=None,
                       upload_id="up_1")
    [row] = win.dicts
    assert row["payload"] == {"urn": "urn:b", "entityType": "table", "displayName": "b",
                              "tags": ["pii", "gold"],
                              "properties": {"owner": "team", "nested": {"k": 1}}}
    assert (win.lines, win.invalid) == (2, 1), "a package only adds: a delete row can't be stored"
    assert win.samples[0]["reason"] == "a package only adds items"


def test_a_line_with_no_id_gets_the_same_minted_id_every_time():
    lines = _lines({"kind": "node", "payload": {"urn": "urn:x", "entityType": "T"}},
                   {"kind": "node", "payload": {"urn": "urn:y", "entityType": "T"}})
    once = ps.node_rows(lines, ctx=CTX, graph_id="g", rules=None, upload_id="up_1")
    again = ps.node_rows(lines, ctx=CTX, graph_id="g", rules=None, upload_id="up_1")
    ids = [r["entity_id"] for r in once.dicts]
    assert ids == [r["entity_id"] for r in again.dicts] and len(set(ids)) == 2
    assert ids[0] == stable_prefixed_id("ent", f"up_1:{lines[0][0]}") and once.minted == 2
    assert ids[0].startswith("ent_") and len(ids[0]) == 4 + 26
    other_upload = ps.node_rows(lines, ctx=CTX, graph_id="g", rules=None, upload_id="up_2")
    assert other_upload.dicts[0]["entity_id"] != ids[0]


def test_the_nodes_pass_accounts_for_every_line_and_notes_the_first_edge():
    lines = _lines(_v2_node("ent_a"), b"", b"not json", {"kind": "view"},
                   _v2_edge("e1", "ent_a", "ent_a"), _v2_node("ent_a"), _v2_node("ent_late"))
    win = ps.node_rows(lines, ctx=CTX, graph_id="g", rules=None, upload_id="up_1")
    assert [r["entity_id"] for r in win.dicts] == ["ent_a", "ent_late"], \
        "a node after an edge is still the nodes pass's"
    assert (win.lines, win.dupes, win.other, win.invalid) == (3, 1, 2, 0)
    assert win.first_edge_at == lines[4][0]


def test_the_edges_pass_skips_rollups_and_counts_what_it_cannot_store():
    lines = _lines(
        _v2_node("ent_a"),
        _v2_edge("e1", "ent_a", "ent_b"),
        _v2_edge("e2", "ent_a", "ent_gone"),
        _v2_edge("e3", "ent_a", "ent_b", etype="AGGREGATED"),
        {"kind": "edge", "entity_id": "e4", "payload": {"sourceEntityId": "ent_a",
                                                        "targetEntityId": "ent_b"}},
        {"kind": "edge", "entity_id": "e5", "sourceUrn": "urn:a", "targetUrn": "urn:b",
         "payload": {"edgeType": "x", "sourceEntityId": None, "targetEntityId": None}},
        {"kind": "edge", "entity_id": "e6", "payload": {"edgeType": "x"}},
        _v2_edge("e1", "ent_a", "ent_b"),
        {"kind": "edge", "entity_id": "e7", "_op": "", "edgeType": "flows_to",
         "source_entity_id": "ent_b", "target_entity_id": "ent_a", "confidence": "0.5",
         "prop.job": "etl"})
    read, win = ps.edge_lines(lines, upload_id="up_1")
    assert [e.entity_id for e in read] == ["e1", "e2", "e5", "e1", "e7"]
    assert (win.lines, win.derived, win.invalid) == (8, 1, 2)
    by_urn = read[2]
    assert (by_urn.source, by_urn.target, by_urn.source_urn) == (None, None, "urn:a"), \
        "an end named only by urn is resolved against the package's nodes"
    by_urn.source, by_urn.target = "ent_a", "ent_b"

    win = ps.edge_rows(read, win, ctx=CTX, graph_id="g", rules=_Rules(), live={"ent_a", "ent_b"})
    assert [r["entity_id"] for r in win.dicts] == ["e1", "e5", "e7"]
    assert (win.dangling, win.dupes) == (1, 1)
    assert win.samples[-1]["reason"] == "endpoint item not in the package"
    e1, e5, e7 = win.dicts
    assert e1["payload"] == {"edgeType": "FLOWS_TO", "sourceEntityId": "ent_a",
                             "targetEntityId": "ent_b"} and e1["edge_type"] == "FLOWS_TO"
    assert e1["content_hash"] == content_hash(e1["payload"]) and e1["id"] == bw._vid("evb", "cmt_1", "e1")
    assert (e5["source_entity_id"], e5["target_entity_id"]) == ("ent_a", "ent_b")
    assert e5["payload"]["sourceEntityId"] == "ent_a", "the ends are in the hashed payload"
    assert e7["payload"] == {"edgeType": "FLOWS_TO", "sourceEntityId": "ent_b",
                             "targetEntityId": "ent_a", "confidence": 0.5,
                             "properties": {"job": "etl"}} and e7["confidence"] == 0.5


def test_a_windows_tallies_add_up():
    seed = ps.fresh_tallies()
    win = ps.Window(dicts=[{"entity_id": "a", "entity_type": "Table"},
                           {"entity_id": "b", "entity_type": None},
                           {"entity_id": "c", "entity_type": "Table"}],
                    lines=6, invalid=1, other=2, dupes=1, minted=1, first_edge_at=99,
                    samples=[{"kind": "node", "reason": "x"}])
    seed = ps._merge(seed, "nodes", win, landed={"a", "b"}, rekeyed=0)
    assert seed["lines"]["nodes"] == 6 and seed["otherLines"] == 2
    assert seed["parsed"]["nodes"] == 4, "offered: written, plus the duplicates"
    assert seed["written"]["nodes"] == 2
    assert seed["written"]["byLabel"] == {"Table": 1, "Entity": 1}
    assert seed["duplicateIds"]["nodes"] == 2, "one inside the window, one an earlier window held"
    assert (seed["invalid"]["nodes"], seed["mintedIds"], seed["firstEdgeAt"]) == (1, 1, 99)
    assert len(seed["samples"]) == 1
    again = ps._merge(seed, "nodes", ps.Window(first_edge_at=5), landed=set(), rekeyed=0)
    assert again["firstEdgeAt"] == 99, "the first edge is the first one seen"


def test_the_copy_kept_is_the_one_synced_last_then_the_lowest_id():
    t = lambda m: datetime(2026, m, 1, tzinfo=timezone.utc)  # noqa: E731
    assert [c[0] for c in ps.rank_copies([("ent_b", "T", t(1)), ("ent_c", "T", t(2)),
                                          ("ent_a", "T", None)])] == ["ent_c", "ent_b", "ent_a"]
    assert [c[0] for c in ps.rank_copies([("ent_b", "T", None), ("ent_a", "T", None)])] == \
        ["ent_a", "ent_b"]
    assert [c[0] for c in ps.rank_copies([("ent_b", "T", t(3)), ("ent_a", "T", t(3))])] == \
        ["ent_a", "ent_b"]
    assert ps.COLLAPSE_RULE == "lastSyncedAt desc, entityId asc"


def test_a_window_is_one_statement_of_typed_columns():
    # The bootstrap's own writer, which a graph's copy uses too.
    sql = str(bw._versions_insert_sql("edges"))
    assert sql.count("unnest(") == 1 and "CAST(v.payload AS jsonb)" in sql
    assert "ON CONFLICT (graph_id, id) DO NOTHING RETURNING entity_id" in sql
    assert "CAST(:confidence AS float8[])" in sql
    cols = bw._version_columns("nodes", [{"id": "nv1", "entity_id": "a", "content_hash": "h",
                                          "payload": {"urn": "u"}, "urn": "u", "entity_type": "T",
                                          "display_name": None, "qualified_name": None}])
    assert cols["payload"] == ['{"urn": "u"}'] and cols["display_name"] == [None]


def test_a_package_seed_runs_its_own_phases_and_the_shared_ones_in_its_order():
    runner = bw.BootstrapRunner(graph_factory=lambda *a, **k: None, session_factory=lambda: None)
    for phase in ("counting", "nodes", "edges", "validate", "index", "project"):
        assert runner._phase_runner(phase, "package").func is getattr(ps, f"phase_{phase}")
    for phase in ("reset", "heads", "merkle", "finalize"):
        assert runner._phase_runner(phase, "package") == getattr(runner, f"_phase_{phase}")
    assert runner._phase_runner("counting", "graph") == runner._phase_counting
    order, phase = [], "reset"
    while phase:
        order.append(phase)
        phase = bw._next_phase(phase, "package")
    assert tuple(order) == bw.PACKAGE_PHASES == (
        "reset", "counting", "nodes", "edges", "validate", "heads", "merkle", "index", "project",
        "finalize")
    assert bw._next_phase("merkle") == "backfill", "a graph's bootstrap is as it was"
