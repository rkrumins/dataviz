"""The edge-integrity gate (``_validate_edge_integrity``) is linear, and judges exactly as before.

The gate used to scan every live edge into a batch's targets once PER created edge, and to climb
a created containment edge's ancestors with database round trips per edge per level — an import
edge window held the CPU for minutes and a large publish for hours. It now indexes the live edges
once and finds loops with one strongly-connected-components pass. These tests pin:

* the loop finder on its own (chains, loops, a loop built inside one batch, a re-pointed edge);
* the gate against the PREVIOUS algorithm, kept here verbatim, on randomised small graphs —
  the same violations, in the same order;
* the size it was slow at: 50k created edges into 50k live ones, well under a second.

No database: the gate's two reads are served from an in-memory branch.
"""
import asyncio
import random
import time

from backend.app.services.versioning.service import (
    GraphVersioningService,
    _containment_cycle_edges,
    _edge_src_tgt,
    _strongly_connected,
)

CSET = ["CONTAINS"]


def _payload(src, tgt, etype):
    return {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}


class _Branch(GraphVersioningService):
    """Just the two reads the gate makes, over ``live``: edge id → (source, target, type)."""

    def __init__(self, live):                     # noqa: D401 — no service state needed
        self.live = live

    async def _incident_live_edge_skeletons(self, s, graph_id, branch_id, node_ids, *,
                                            sides=("source", "target"), edge_types=None):
        ids = set(node_ids)
        return {eid: _payload(a, b, t) for eid, (a, b, t) in self.live.items()
                if ("target" in sides and b in ids) or ("source" in sides and a in ids)}

    async def _incident_live_edges(self, s, graph_id, branch_id, node_ids, as_of_seq=None):
        return await self._incident_live_edge_skeletons(s, graph_id, branch_id, node_ids)

    async def _containment_parents_climb(self, s, graph_id, branch_id, node_ids, cset, as_of_seq,
                                         max_climb=64, *, skeleton=False):
        seen, frontier, edges = set(node_ids), set(node_ids), {}
        for _ in range(max_climb):
            if not frontier:
                break
            nxt = set()
            for eid, (a, b, t) in self.live.items():
                if t.upper() in cset and b in frontier and a:
                    edges[eid] = _payload(a, b, t)
                    if a not in seen:
                        seen.add(a)
                        nxt.add(a)
            frontier = nxt
        return seen, edges


async def _old_gate(svc, edge_creates, deleted_edge_ids, containment_edge_types):
    """The gate as it was before it was made linear — the reference the new one must match."""
    cset = {t.upper() for t in (containment_edge_types or [])}

    def _etype(p):
        return str(p.get("edgeType") or p.get("edge_type") or "").upper()

    create_targets = {t for _e, v in edge_creates for _s2, t in [_edge_src_tgt(v)] if t}
    existing_incident = (await svc._incident_live_edges(None, "g", "b", create_targets)
                         if create_targets else {})
    viol = []
    batch_parent, batch_seen = {}, set()
    for eid, v in edge_creates:
        src, tgt = _edge_src_tgt(v)
        if not src or not tgt:
            continue
        etype = _etype(v)
        dup = (src, tgt, etype) in batch_seen or any(
            oeid != eid and oeid not in deleted_edge_ids
            and _edge_src_tgt(op_) == (src, tgt) and _etype(op_) == etype
            for oeid, op_ in existing_incident.items())
        if dup:
            viol.append({"entity_id": eid, "kind": "edge",
                         "reason": "These entities are already connected by this relationship."})
        batch_seen.add((src, tgt, etype))
        if etype in cset:
            parents = {osrc for oeid, op_ in existing_incident.items()
                       if oeid != eid and oeid not in deleted_edge_ids
                       and _etype(op_) in cset
                       for osrc, otgt in [_edge_src_tgt(op_)] if otgt == tgt and osrc}
            parents |= batch_parent.get(tgt, set())
            if parents - {src}:
                viol.append({"entity_id": eid, "kind": "edge",
                             "reason": "This entity already has a parent — use “Move to” to change it, "
                                       "rather than adding a second parent."})
            batch_parent.setdefault(tgt, set()).add(src)
    if cset:
        batch_cont = {eid: v for eid, v in edge_creates if _etype(v) in cset}

        async def _ancestors_effective(start, skip):
            seen_a, frontier = {start}, {start}
            for _ in range(64):
                if not frontier:
                    break
                inc = await svc._incident_live_edges(None, "g", "b", frontier, None)
                cand = [(oeid, p) for oeid, p in inc.items()
                        if oeid != skip and oeid not in deleted_edge_ids]
                cand += [(beid, bp) for beid, bp in batch_cont.items() if beid != skip]
                nxt = set()
                for _oeid, p in cand:
                    if _etype(p) not in cset:
                        continue
                    a, b = _edge_src_tgt(p)
                    if b in frontier and a and a not in seen_a:
                        seen_a.add(a)
                        nxt.add(a)
                frontier = nxt
            return seen_a

        for eid, v in batch_cont.items():
            src, tgt = _edge_src_tgt(v)
            if not src or not tgt:
                continue
            if src == tgt:
                viol.append({"entity_id": eid, "kind": "edge", "reason": "An entity can’t contain itself."})
                continue
            if tgt in await _ancestors_effective(src, eid):
                viol.append({"entity_id": eid, "kind": "edge",
                             "reason": "This move would create a containment loop."})
    return viol


def _gate(svc, creates, deleted=frozenset()):
    return asyncio.run(svc._validate_edge_integrity(None, "g", "b", creates, set(deleted), CSET))


# ── the loop finder ──────────────────────────────────────────────────────────

def test_scc_groups_a_loop_and_leaves_a_chain_apart():
    adj = {"a": [("1", "b")], "b": [("2", "c")], "c": [("3", "a")], "d": [("4", "a")]}
    comp = _strongly_connected({**adj, "e": []})
    assert comp["a"] == comp["b"] == comp["c"]
    assert comp["d"] != comp["a"] and comp["e"] not in (comp["a"], comp["d"])


def test_scc_is_iterative_on_a_hierarchy_deeper_than_the_recursion_limit():
    n = 20_000
    adj = {f"n{i}": [(f"e{i}", f"n{i + 1}")] for i in range(n)}
    adj[f"n{n}"] = [("back", "n0")]                     # close one long loop
    comp = _strongly_connected(adj)
    assert len(set(comp.values())) == 1


def test_cycle_edges_flags_only_edges_that_close_a_loop():
    edges = [("p1", "root", "a"), ("p2", "a", "b"), ("new", "b", "root"), ("ok", "root", "c")]
    assert _containment_cycle_edges(edges, [("new", "b", "root"), ("ok", "root", "c")]) == {"new"}


def test_cycle_edges_sets_a_re_pointed_edges_old_version_aside():
    # x was a→b and is re-pointed b→a in the same batch: with its old version set aside there is
    # no way back from a to b, so the move is legal — the case the old version alone would flag.
    edges = [("x", "a", "b"), ("x", "b", "a")]
    assert _containment_cycle_edges(edges, [("x", "b", "a")]) == set()
    # ...but a loop through ANOTHER edge is still found.
    edges = [("x", "a", "b"), ("y", "a", "b"), ("x", "b", "a")]
    assert _containment_cycle_edges(edges, [("x", "b", "a")]) == {"x"}


# ── the gate: same verdicts as before ────────────────────────────────────────

def test_gate_flags_duplicate_second_parent_and_loops():
    svc = _Branch({"l1": ("root", "a", "CONTAINS"), "l2": ("a", "b", "CONTAINS"), "f": ("a", "b", "FLOWS")})
    creates = [
        ("dup", _payload("a", "b", "flows")),          # same triple as a live edge, any case
        ("second", _payload("root", "b", "CONTAINS")),  # b already sits in a
        ("loop", _payload("b", "root", "CONTAINS")),    # root is b's ancestor
        ("self", _payload("s", "s", "CONTAINS")),
        ("fine", _payload("b", "c", "CONTAINS")),
    ]
    got = _gate(svc, creates)
    # Duplicates and second parents first, in batch order; then loops. root→b also closes a loop,
    # through this batch's own b→root.
    assert [(v["entity_id"], v["reason"][:12]) for v in got] == [
        ("dup", "These entiti"), ("second", "This entity "), ("second", "This move wo"),
        ("loop", "This move wo"), ("self", "An entity ca")]
    assert got == asyncio.run(_old_gate(svc, creates, set(), CSET))


def test_gate_admits_a_one_commit_restructure_and_catches_an_in_batch_loop():
    svc = _Branch({"pc": ("p", "c", "CONTAINS")})
    # delete P→C and create C→P: legal.
    assert _gate(svc, [("cp", _payload("c", "p", "CONTAINS"))], deleted={"pc"}) == []
    # A→B and B→A created together: both close the loop.
    got = _gate(_Branch({}), [("ab", _payload("a", "b", "CONTAINS")), ("ba", _payload("b", "a", "CONTAINS"))])
    assert {v["entity_id"] for v in got if "loop" in v["reason"]} == {"ab", "ba"}


def test_gate_matches_the_previous_algorithm_on_random_graphs():
    rng = random.Random(20261008)
    types = ["CONTAINS", "contains", "FLOWS", "DERIVES"]
    for trial in range(400):
        nodes = [f"n{i}" for i in range(rng.randint(2, 9))]
        live = {f"l{i}": (rng.choice(nodes), rng.choice(nodes), rng.choice(types))
                for i in range(rng.randint(0, 12))}
        creates = []
        for i in range(rng.randint(1, 8)):
            eid = rng.choice(list(live)) if live and rng.random() < 0.3 else f"c{i}"   # re-point some
            if eid in {e for e, _v in creates}:
                continue
            creates.append((eid, _payload(rng.choice(nodes), rng.choice(nodes), rng.choice(types))))
        deleted = {e for e in live if rng.random() < 0.2}
        svc = _Branch(live)
        new = asyncio.run(svc._validate_edge_integrity(None, "g", "b", creates, set(deleted), CSET))
        old = asyncio.run(_old_gate(svc, creates, set(deleted), CSET))
        assert new == old, (trial, live, creates, deleted)


def test_gate_is_linear_at_import_window_size():
    n = 50_000
    # 50k live edges already into the targets (a tree under one root, plus lineage), and a window
    # of 50k new edges into the same targets: the shape that took minutes.
    live = {f"l{i}": ("root", f"t{i}", "CONTAINS") for i in range(n)}
    creates = [(f"c{i}", _payload(f"s{i}", f"t{i}", "FLOWS")) for i in range(n)]
    svc = _Branch(live)
    t0 = time.perf_counter()
    assert _gate(svc, creates) == []
    assert time.perf_counter() - t0 < 1.0


def test_cycle_pass_is_linear_on_a_large_hierarchy():
    n = 200_000
    edges = [(f"e{i}", f"n{i // 4}", f"n{i + 1}") for i in range(n)]          # a 4-ary tree
    checks = edges[-50_000:]
    t0 = time.perf_counter()
    assert _containment_cycle_edges(edges, checks) == set()
    assert time.perf_counter() - t0 < 2.0
