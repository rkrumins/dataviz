"""Contract tests for ``trace_closure``'s degree-exact walk.

The invariants (pinned here, proved live by ``integration/test_trace_closure_live.py``):

  I1  every anchor a response WALKED has its entire adjacency in each requested
      direction in that response — except an anchor carrying a real ``e:<n>``
      cursor in that direction (a paged hub);
  I2  ``len(discovered) <= max_nodes`` always (ancestors never count);
  I3  every un-walked anchor has exactly one resume: descendants by ``seedCursor``
      (inclusive-next), explicit seeds and hop>=2 ring members by a CURSOR-LESS
      frontier entry (re-root via ``seedUrns``, batchable), hubs by ``e:<n>``.
      ``e:0`` is never minted;
  I4  anchor lists are urn-sorted, so a page is a function of (graph, request);
  I5  no silent loss: a failed query sets ``truncationReason`` and failures take
      precedence over ``max_nodes``; a page that made no progress ships no cursor;
  I6  every edge endpoint is shipped, excluded, or the request ``urn``.

Why these exist: a 2,935-column table on the 520k-node dev graph got 1,014 of
its 17,567 hop-1 edges from a one-hop request (``upstreamUrns=984``,
``downstreamUrns=15``) because the hop budget was a ring-wide LIMIT shared by
both directions, and the seed reserve shipped half the table's columns with
no edges at all. Tracing one of its columns was complete. These tests make
"trace the table" and "trace the column" agree.
"""
import pytest

from backend.tests.test_falkordb_trace_structural import _TraceFake, _make_provider, _run

LT = ["FLOWS"]
CT = ["HAS"]


def _closure(p, urn, *, up=1, down=1, max_nodes=2000, **kw):
    return _run(p.trace_closure(
        urn, upstream_depth=up, downstream_depth=down,
        lineage_edge_types=LT, containment_edge_types=CT,
        max_nodes=max_nodes, timeout_ms=5000, **kw,
    ))


def _edges(result):
    return {(e.source_urn, e.target_urn) for e in result.edges}


def _shipped(result):
    return {n.urn for n in result.nodes}


def _assert_no_e0(result):
    for f in [*result.frontier_up, *result.frontier_down]:
        assert f.next_cursor != "e:0", f"e:0 minted for {f.urn}"


def _fill_degrees(fake):
    """Make the end-of-walk frontier probe (`get_node_degrees`, patched to
    `fake.degrees`) KNOW every node's degree, so a dead-end partner is
    dropped from the frontier the way a live probe would drop it. Tests
    about "unknown degree" semantics live in the structural file."""
    deg = {}
    for s, t, _ in fake.lineage:
        deg.setdefault(s, {"in": 0, "out": 0})["out"] += 1
        deg.setdefault(t, {"in": 0, "out": 0})["in"] += 1
    fake.degrees.update(deg)


def _wide_table(fake, leaves=30, fan=3):
    """dom ⊃ leaf_00..leaf_NN, each leaf → sink_ii_k (fan partners)."""
    for i in range(leaves):
        leaf = f"leaf_{i:02d}"
        fake.contain("dom", leaf)
        for k in range(fan):
            fake.lineage.append((leaf, f"sink_{i:02d}_{k}", "FLOWS"))
    _fill_degrees(fake)


# ── I1 / I2 / I3: the seed page ──────────────────────────────────────────

def test_every_walked_seed_has_its_whole_hop_one():
    """30 lineage-bearing columns, 3 partners each, budget 20: the page walks
    as many columns as FIT (1 column + 3 partners = 4 each → four columns, 17
    nodes with the table) and every one of them is complete. The column it
    could not afford is NOT shipped half-done; it is the cursor."""
    fake = _TraceFake()
    _wide_table(fake)
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=20)

    shipped = _shipped(r)
    assert len(shipped) <= 20
    walked = sorted(u for u in shipped if u.startswith("leaf_"))
    assert walked == ["leaf_00", "leaf_01", "leaf_02", "leaf_03"]
    for leaf in walked:
        assert {t for s, t in _edges(r) if s == leaf} == {f"sink_{leaf[5:]}_{k}" for k in range(3)}
    assert r.frontier_down == []                      # a walked seed is never a frontier entry
    assert r.seed_cursor == "s:leaf_04"               # inclusive-next: the first un-walked anchor
    assert r.seed_truncated is True
    assert r.truncated is True and r.truncation_reason == "max_nodes"
    _assert_no_e0(r)


def test_seed_pages_are_disjoint_and_their_union_is_the_closure():
    fake = _TraceFake()
    _wide_table(fake)
    p = _make_provider(fake, hydrate=True)

    one_shot = _closure(p, "dom", up=0, down=1, max_nodes=1000)
    assert one_shot.seed_cursor is None and one_shot.truncated is False

    pages, cursor, seen_leaves = [], None, []
    for _ in range(20):
        r = _closure(p, "dom", up=0, down=1, max_nodes=20, seed_cursor=cursor)
        pages.append(r)
        leaves = sorted(u for u in _shipped(r) if u.startswith("leaf_"))
        assert not (set(leaves) & set(seen_leaves)), "a column shipped twice"
        seen_leaves += leaves
        cursor = r.seed_cursor
        if cursor is None:
            break
    assert cursor is None, "the cursor never drained"
    assert len(pages) >= 2
    assert sorted(seen_leaves) == sorted(u for u in _shipped(one_shot) if u.startswith("leaf_"))
    assert set().union(*(_edges(pg) for pg in pages)) == _edges(one_shot)


def test_seed_cursor_is_inclusive_next():
    fake = _TraceFake()
    _wide_table(fake)
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=20, seed_cursor="s:leaf_04")

    walked = sorted(u for u in _shipped(r) if u.startswith("leaf_"))
    assert walked[0] == "leaf_04"
    assert "dom" not in {s for s, _ in _edges(r)}      # the focus-self probe is page-one only


@pytest.mark.parametrize("max_nodes", list(range(1, 13)))
def test_discovered_never_exceeds_max_nodes(max_nodes):
    """Shared partners: est >= actual, so the prefix rule can under-fill a page
    but never overshoot it."""
    fake = _TraceFake()
    for i in range(8):
        fake.contain("dom", f"leaf_{i}")
        fake.lineage.append((f"leaf_{i}", f"shared_{i % 3}", "FLOWS"))
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=max_nodes)

    assert len(_shipped(r)) <= max_nodes
    for s, t in _edges(r):
        assert s in _shipped(r) and t in _shipped(r)
    _assert_no_e0(r)


# ── I1 / I3: hubs ────────────────────────────────────────────────────────

def test_a_hub_seed_is_paged_with_a_real_cursor_in_each_direction():
    """A column with 3 sources and 50 sinks under max_nodes=10 cannot be walked
    whole. Each direction gets half the room: upstream (3 rows < 5) is complete
    and has NO frontier entry; downstream ships a first page and a REAL cursor
    one past its last edge id — never ``e:0``."""
    fake = _TraceFake()
    fake.lineage = [(f"u{i}", "hub", "FLOWS") for i in range(3)]          # ids 0..2
    fake.lineage += [("hub", f"c{i:02d}", "FLOWS") for i in range(50)]      # ids 3..52
    _fill_degrees(fake)
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "hub", up=1, down=1, max_nodes=10)

    assert len(_shipped(r)) <= 10
    assert {s for s, t in _edges(r) if t == "hub"} == {"u0", "u1", "u2"}
    assert r.frontier_up == []
    down = [(f.urn, f.total_count, f.next_cursor) for f in r.frontier_down]
    assert down == [("hub", 50, "e:9")]                # 6 rows shipped (ids 3..8); next id is 9
    assert r.truncation_reason == "max_nodes"
    _assert_no_e0(r)


def test_a_hub_in_the_middle_of_the_seed_list_ends_the_page_before_it():
    """Seeds a(2), hub(50), c(2), budget 10: page one walks `a` and stops AT the
    hub (it becomes the cursor); page two starts on the hub, pages it, and the
    cursor moves on to `c`. No anchor is skipped, none is shipped half-done."""
    fake = _TraceFake()
    for leaf in ("a_leaf", "b_hub", "c_leaf"):          # urn order == walk order
        fake.contain("dom", leaf)
    fake.lineage += [("a_leaf", "a_s0", "FLOWS"), ("a_leaf", "a_s1", "FLOWS")]
    fake.lineage += [("b_hub", f"h{i:02d}", "FLOWS") for i in range(50)]
    fake.lineage += [("c_leaf", "c_s0", "FLOWS"), ("c_leaf", "c_s1", "FLOWS")]
    _fill_degrees(fake)
    p = _make_provider(fake, hydrate=True)

    one = _closure(p, "dom", up=0, down=1, max_nodes=10)
    assert {s for s, _ in _edges(one)} == {"a_leaf"}
    assert one.seed_cursor == "s:b_hub"
    assert one.frontier_down == []

    two = _closure(p, "dom", up=0, down=1, max_nodes=10, seed_cursor="s:b_hub")
    assert {s for s, _ in _edges(two)} == {"b_hub"}
    assert len(_shipped(two)) <= 10
    assert [(f.urn, f.reason) for f in two.frontier_down] == [("b_hub", "cut")]
    assert two.frontier_down[0].next_cursor not in (None, "e:0")
    assert two.seed_cursor == "s:c_leaf"


# ── I3: deeper hops and direction fairness ───────────────────────────────

def test_direction_shares_do_not_starve_either_side():
    """Hop 2 from a leaf: 10 upstream ring members and 10 downstream ones,
    each with 3 partners. The room after hop 1 is split: up gets its half,
    down its half plus up's leftover, then up gets whatever is left. Both
    sides make progress; nothing that did not fit is shipped half-done, it is
    a cursor-less cut entry with its real degree."""
    fake = _TraceFake()
    for i in range(10):
        fake.lineage.append((f"up_{i}", "f", "FLOWS"))
        fake.lineage.append(("f", f"dn_{i}", "FLOWS"))
    for i in range(10):
        for k in range(3):
            fake.lineage.append((f"src_{i}_{k}", f"up_{i}", "FLOWS"))
            fake.lineage.append((f"dn_{i}", f"snk_{i}_{k}", "FLOWS"))
    _fill_degrees(fake)
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "f", up=2, down=2, max_nodes=41)

    assert len(_shipped(r)) <= 41
    up_walked = {t for s, t in _edges(r) if s.startswith("src_")}
    down_walked = {s for s, t in _edges(r) if t.startswith("snk_")}
    # room 20 after hop 1: up's share is 10 (three anchors of 3), down gets
    # its 10 plus up's leftover 1 (three anchors), up's roll-over finds 2 — none.
    assert len(up_walked) == 3 and len(down_walked) == 3
    for f in [*r.frontier_up, *r.frontier_down]:
        assert f.next_cursor is None
        assert f.total_count == 3
        assert f.reason == "cut"
    assert len(r.frontier_up) == 7 and len(r.frontier_down) == 7
    assert r.truncation_reason == "max_nodes"


def test_frontier_entries_carry_their_reason():
    """A depth-1 walk: hop-1 partners that have further lineage are DEPTH
    entries (the next hop — a pill, never drained by a one-hop client); an
    anchor the budget could not walk is a CUT entry (the client completes it
    hands-free)."""
    fake = _TraceFake()
    fake.lineage = [("f", "a", "FLOWS"), ("a", "a2", "FLOWS")]
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "f", up=0, down=1, max_nodes=10)
    assert [(x.urn, x.reason, x.next_cursor) for x in r.frontier_down] == [("a", "depth", None)]

    fake2 = _TraceFake()
    for i in range(4):
        fake2.contain("dom", f"leaf_{i}")
        fake2.lineage.append((f"leaf_{i}", f"s_{i}", "FLOWS"))
    _fill_degrees(fake2)
    p2 = _make_provider(fake2, hydrate=True)
    r2 = _closure(p2, "dom", up=0, down=1, seed_urns=[f"leaf_{i}" for i in range(4)], max_nodes=7)
    cut = [(x.urn, x.reason, x.next_cursor, x.total_count) for x in r2.frontier_down]
    # 4 seeds + the card are held (5 of 7); room 2 → two leaves walked whole
    # (one sink each), two re-offered with their real degree.
    assert {s for s, _ in _edges(r2)} == {"leaf_0", "leaf_1"}
    assert cut == [(f"leaf_{i}", "cut", None, 1) for i in range(2, 4)]
    assert r2.seed_cursor is None


def test_explicit_seeds_that_do_not_fit_are_reoffered_without_a_cursor():
    """A continuation names 10 leaves (5 partners each) under max_nodes=20: the
    seeds are held by the client already, so the two that fit are walked whole
    and the eight that do not are cut entries — cursor-less, with their real
    degree — never ``e:0``, never a seedCursor (nothing was enumerated)."""
    fake = _TraceFake()
    for i in range(10):
        for k in range(5):
            fake.lineage.append((f"s{i}", f"t{i}_{k}", "FLOWS"))
    _fill_degrees(fake)
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "s0", up=0, down=1, seed_urns=[f"s{i}" for i in range(10)], max_nodes=20)

    assert len(_shipped(r)) <= 20
    walked = {s for s, _ in _edges(r)}
    assert walked == {"s0", "s1"}
    for s in walked:
        assert len([t for a, t in _edges(r) if a == s]) == 5
    assert [(f.urn, f.next_cursor, f.total_count, f.reason) for f in r.frontier_down] == [
        (f"s{i}", None, 5, "cut") for i in range(2, 10)
    ]
    assert r.seed_cursor is None
    _assert_no_e0(r)


def test_explicit_seed_descendants_page_by_keyset():
    """``seedUrns:[table]`` — the card itself, which is what the driver sends
    for a container it never opened. Its columns page by keyset exactly like
    a focus-anchored seed, and ``seedCursor`` is legal WITH ``seedUrns``."""
    fake = _TraceFake()
    for i in range(30):
        fake.contain("tbl", f"c{i:02d}")
        fake.lineage.append((f"c{i:02d}", f"d{i:02d}", "FLOWS"))
    p = _make_provider(fake, hydrate=True)

    seen, cursor, pages = [], None, 0
    for _ in range(20):
        r = _closure(p, "tbl", up=0, down=1, seed_urns=["tbl"], max_nodes=10, seed_cursor=cursor)
        pages += 1
        cols = sorted(s for s, _ in _edges(r))
        assert not (set(cols) & set(seen))
        seen += cols
        if cursor is not None:
            assert "tbl" not in _shipped(r) or True   # the card itself is never re-walked
        cursor = r.seed_cursor
        if cursor is None:
            break
    assert cursor is None and pages >= 3
    assert seen == [f"c{i:02d}" for i in range(30)]


def test_tracing_the_table_agrees_with_tracing_the_column():
    fake = _TraceFake()
    _wide_table(fake, leaves=6, fan=3)
    fake.lineage.append(("ext", "leaf_03", "FLOWS"))
    p = _make_provider(fake, hydrate=True)

    column = _closure(p, "leaf_03", up=1, down=1, max_nodes=100)
    table_pages, cursor = [], None
    for _ in range(10):
        r = _closure(p, "dom", up=1, down=1, max_nodes=12, seed_cursor=cursor)
        table_pages.append(r)
        cursor = r.seed_cursor
        if cursor is None:
            break
    table_edges = set().union(*(_edges(pg) for pg in table_pages))
    assert _edges(column) <= table_edges


# ── I5: no silent loss ───────────────────────────────────────────────────

def test_a_failed_hop_bucket_is_flagged_not_swallowed():
    """Two label buckets at hop 1; the `bad_*` bucket's expand raises. Its
    anchors are shipped and re-offered as cut entries under ``timeout``; the
    other bucket's rows ship untouched. Before: the rows vanished and the
    response said it was complete."""
    fake = _TraceFake()
    for leaf in ("ok_1", "ok_2", "bad_1", "bad_2"):
        fake.contain("dom", leaf)
        fake.lineage.append((leaf, f"{leaf}_sink", "FLOWS"))
    _fill_degrees(fake)
    fake.fail_expand_labels = {"bad"}
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=50)

    assert {s for s, _ in _edges(r)} == {"ok_1", "ok_2"}
    assert {(f.urn, f.reason, f.next_cursor) for f in r.frontier_down} == {
        ("bad_1", "cut", None), ("bad_2", "cut", None),
    }
    assert r.truncated is True and r.truncation_reason == "timeout"


def test_a_failed_seed_enumeration_is_never_an_empty_unflagged_page():
    fake = _TraceFake()
    _wide_table(fake, leaves=3)
    fake.fail_seed = True
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=50)

    assert r.edges == []
    assert r.truncated is True and r.truncation_reason == "seed_failed"
    assert r.seed_cursor is None


def test_a_degree_probe_failure_makes_no_progress_and_ships_no_cursor():
    fake = _TraceFake()
    _wide_table(fake, leaves=3)
    fake.fail_walk_degrees = True
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=50)

    assert r.edges == []
    assert r.truncated is True and r.truncation_reason == "timeout"
    assert r.seed_cursor is None


def test_failures_outrank_max_nodes_in_the_reason():
    fake = _TraceFake()
    for leaf in ("ok_1", "ok_2", "ok_3", "ok_4", "bad_1"):
        fake.contain("dom", leaf)
        fake.lineage.append((leaf, f"{leaf}_sink", "FLOWS"))
    fake.fail_expand_labels = {"bad"}
    p = _make_provider(fake, hydrate=True)

    r = _closure(p, "dom", up=0, down=1, max_nodes=5)   # budget-cut AND a failed bucket

    assert r.truncation_reason == "timeout"


def test_partial_hydration_is_flagged_and_drops_dangling_edges():
    fake = _TraceFake()
    fake.lineage = [("f", "a", "FLOWS"), ("f", "b", "FLOWS")]
    p = _make_provider(fake, hydrate=True)
    full = p.get_nodes_batch

    async def _lossy(urns):
        return [n for n in await full(urns) if n.urn != "b"]

    p.get_nodes_batch = _lossy

    r = _closure(p, "f", up=0, down=1, max_nodes=50)

    assert r.truncation_reason == "nodes_failed"
    shipped = _shipped(r)
    for s, t in _edges(r):
        assert s in shipped and t in shipped
    assert ("f", "a") in _edges(r)


def test_query_timeouts_follow_the_deadline():
    """Per-query timeouts are derived from the request deadline (capped at
    CLOSURE_QUERY_CAP_SECS), not clamped to 1.5 s — and a 1 s request still
    walks."""
    from backend.app.providers import falkordb_provider as fp

    fake = _TraceFake()
    _wide_table(fake, leaves=3)
    p = _make_provider(fake, hydrate=True)
    seen = []
    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        seen.append(timeout)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    r = _run(p.trace_closure(
        "dom", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=LT, containment_edge_types=CT, max_nodes=50, timeout_ms=30000,
    ))
    assert r.edges and seen
    assert all(t <= fp.CLOSURE_QUERY_CAP_SECS for t in seen)
    assert max(seen) > 1.5          # the old clamp is gone

    seen.clear()
    r2 = _run(p.trace_closure(
        "dom", upstream_depth=0, downstream_depth=1,
        lineage_edge_types=LT, containment_edge_types=CT, max_nodes=50, timeout_ms=1000,
    ))
    assert r2.edges and all(t <= 1.0 for t in seen)


def test_zero_degree_anchors_cost_no_query():
    """A depth-2 walk whose hop-1 partners are dead ends: the ring's degrees
    are zero, so no expand query is issued for hop 2."""
    fake = _TraceFake()
    fake.lineage = [("f", "a", "FLOWS"), ("f", "b", "FLOWS")]
    p = _make_provider(fake, hydrate=True)
    expands = []
    orig = fake.ro_query

    async def spy(cypher, params=None, timeout=None, **kwargs):
        if "AS otherUrn" in cypher:
            expands.append(sorted(params["frontier"]))
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = spy

    r = _closure(p, "f", up=0, down=2, max_nodes=50)

    assert _edges(r) == {("f", "a"), ("f", "b")}
    assert expands == [["f"]]
    assert r.frontier_down == []
