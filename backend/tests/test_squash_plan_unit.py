"""The narrow squash's plan (no infra): what ``net_delta`` makes of a draft, told from hashes.

An up-to-date draft of a non-fork graph, published with no resolutions, merges to its own value
entity by entity (``three_way_merge(base, ours, base) == ours``), so what the squash writes is
``net_delta(main, draft)`` over the entities the draft changed. ``_plan_squash`` decides that from
the draft's heads and main's content hashes alone. Proven here against the real ``net_delta`` and
``three_way_merge`` on randomized drafts — creates, updates, deletes, reverts, empty and null
payloads, edges cascading off deleted nodes — plus when the narrow path applies at all.
"""
import random
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.changeset import net_delta
from backend.app.services.versioning.merge import three_way_merge
from backend.app.services.versioning.merkle import content_hash
from backend.app.services.versioning.service import (
    GraphVersioningService, _HASH_EMPTY, _HASH_NONE, _Head, _Stored, _collapse_empty_payloads,
    _head_skeleton, _plan_squash,
)


def _payload(rng, kind, eid):
    roll = rng.random()
    if roll < 0.15:
        return None                                       # absent / deleted
    if roll < 0.2:
        return {}                                         # an empty payload: not a live entity
    if kind == "node":
        return {"urn": f"urn:{eid}", "entityType": rng.choice(["Table", "Column"]),
                "displayName": rng.choice(["a", "b", "c"]), "properties": {"n": rng.randint(0, 2)}}
    return {"edgeType": rng.choice(["LINEAGE", "CONTAINS"]), "sourceEntityId": "n1",
            "targetEntityId": rng.choice(["n2", "n3"]), "properties": {"w": rng.randint(0, 1)}}


def _head(kind, payload, vid):
    """What ``_head_index`` gives for a draft head holding ``payload`` (None = a tombstone)."""
    chash = content_hash(payload)
    return _Head(kind, vid, chash, payload is not None and chash not in (_HASH_EMPTY, _HASH_NONE),
                 (payload or {}).get("urn"), (payload or {}).get("entityType") or (payload or {}).get("edgeType"),
                 table=kind)


def _stored(kind, payload):
    """What ``_hashes_at`` gives for main's value: live payloads only."""
    return _Stored(kind, content_hash(payload), None, None) if payload else None


@pytest.mark.parametrize("seed", range(40))
def test_the_plan_is_net_delta_over_the_merged_draft(seed):
    rng = random.Random(seed)
    ids = [(f"e{i:03d}", rng.choice(["node", "edge"])) for i in range(60)]
    base = {eid: _payload(rng, kind, eid) for eid, kind in ids}
    draft = {}
    for eid, kind in ids:
        if rng.random() < 0.6:                            # the entities the draft changed
            draft[eid] = base[eid] if rng.random() < 0.1 else _payload(rng, kind, eid)
    kinds = dict(ids)
    heads = {eid: _head(kinds[eid], p, f"v_{eid}") for eid, p in draft.items()}
    main = {eid: s for eid in draft if (s := _stored(kinds[eid], base[eid])) is not None}
    # Edges the squash deletes though the draft holds them live (they hang off a deleted node).
    gone = {eid for eid in draft if kinds[eid] == "edge" and heads[eid].live and rng.random() < 0.2}

    # The full path: merge each changed entity (main up to date: theirs IS base), collapse
    # empties, cascade, net_delta against main.
    merged = _collapse_empty_payloads({
        eid: three_way_merge(base[eid], p, base[eid], frozenset(config.SET_FIELDS)).merged
        for eid, p in draft.items()})
    for eid in gone:
        merged[eid] = None
    want = {(d.entity_id, d.op, d.prev_content_hash, d.content_hash)
            for d in net_delta({eid: base[eid] for eid in draft}, merged)}

    rows, lane = _plan_squash(heads, main, gone, lambda h: False)
    assert lane == []
    assert {(r.entity_id, r.op, r.prev_content_hash, r.content_hash) for r in rows} == want
    assert [r.entity_id for r in rows] == sorted(r.entity_id for r in rows), "in entity order"
    for r in rows:
        assert r.kind == kinds[r.entity_id]
        assert (r.version_id is None) == (r.op == "delete")
        if r.op != "delete":
            assert r.version_id == f"v_{r.entity_id}" and r.content_hash == heads[r.entity_id].content_hash


def test_a_row_the_ontology_spells_differently_is_read_in_python():
    """``reread`` sends a live row to the Python lane (canonicalized and re-hashed there) — even
    one whose hash equals main's, since canonicalizing may change it; deletes never go there."""
    heads = {"a": _head("node", {"urn": "u", "entityType": "table"}, "va"),
             "b": _head("node", {"urn": "v", "entityType": "Table"}, "vb"),
             "c": _head("node", None, "vc")}
    same = {"urn": "u", "entityType": "table"}
    main = {"a": _stored("node", same), "c": _stored("node", {"urn": "w", "entityType": "table"})}
    rows, lane = _plan_squash(heads, main, set(), lambda h: h.type == "table")
    assert lane == ["a"]
    assert [(r.entity_id, r.op) for r in rows] == [("b", "create"), ("c", "delete")]


def test_a_head_skeleton_is_what_the_version_row_says():
    node = _Head("node", "v1", "h", True, "urn:1", "Table", name="One", qname="q.one", table="node")
    edge = _Head("edge", "v2", "h", True, None, "LINEAGE", src="n1", tgt="", table="edge")
    assert _head_skeleton(node) == {"urn": "urn:1", "entityType": "Table", "displayName": "One"}
    assert _head_skeleton(edge) == {"edgeType": "LINEAGE", "sourceEntityId": "n1"}


def test_only_an_up_to_date_draft_of_a_plain_graph_without_resolutions_squashes_narrowly(monkeypatch):
    graph = SimpleNamespace(fork_parent_graph_id=None, main_head_commit_seq=7)
    draft = SimpleNamespace(base_commit_seq=7)
    narrow = GraphVersioningService._narrow_squash
    assert narrow(graph, draft, None) and narrow(graph, draft, {})
    assert not narrow(graph, draft, {"e": None}), "resolutions merge field by field: the full path"
    assert not narrow(SimpleNamespace(fork_parent_graph_id="g0", main_head_commit_seq=7), draft, None)
    assert not narrow(graph, SimpleNamespace(base_commit_seq=6), None)
    monkeypatch.setattr(config, "NARROW_SQUASH", False)
    assert not narrow(graph, draft, None), "the kill switch"
