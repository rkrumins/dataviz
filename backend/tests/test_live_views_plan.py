"""A view made from a query: a page of its members → where each one is placed, for each layout.

    db ⊃ sch ⊃ tbl_a ⊃ {col_a1, col_a2}
         sch ⊃ tbl_b ⊃ col_b1
    src_db ⊃ src_tbl ⊃ src_col          (a source of col_a1, outside the view it was made from)

Containers are never rows (the canvas draws them from each member's path); a member's row
depends on nothing but itself and its path, so any page size gives the same rows.
"""
from backend.app.services.live_views import layouts
from backend.app.services.live_views.plan import (
    Candidate,
    auto_placer,
    plan_page,
    rules_placer,
    source_placer,
    stage_placer,
    top_type_counts,
)
from backend.app.services.view_placement import NodeFacts
from backend.common.models.view_membership import MembershipSource

TYPES = {
    "db": "database", "sch": "schema", "tbl_a": "table", "tbl_b": "table",
    "col_a1": "column", "col_a2": "column", "col_b1": "column",
    "src_db": "database", "src_tbl": "table", "src_col": "column",
}
CHAINS = {
    "sch": ["db"], "tbl_a": ["sch", "db"], "tbl_b": ["sch", "db"],
    "col_a1": ["tbl_a", "sch", "db"], "col_a2": ["tbl_a", "sch", "db"], "col_b1": ["tbl_b", "sch", "db"],
    "src_tbl": ["src_db"], "src_col": ["src_tbl", "src_db"], "db": [], "src_db": [],
}
FACTS = {u: NodeFacts(urn=u, entity_type=t) for u, t in TYPES.items()}
LAYERS = [
    {"id": "L_dbs", "name": "Databases", "order": 0, "entityTypes": ["database", "schema"]},
    {"id": "L_tbls", "name": "Tables", "order": 1, "entityTypes": ["table"]},
    {"id": "L_cols", "name": "Columns", "order": 2, "entityTypes": ["column"]},
]
IDS = [l["id"] for l in LAYERS]
SOURCE = MembershipSource.model_validate({"spec": {"seeds": {"urns": ["col_a1"]}}})


def member(urn, via="seed", hops=None, *, whole=False, source_layer=None, chain=None):
    return Candidate(urn, True, whole, via, hops, source_layer, tuple(CHAINS[urn] if chain is None else chain))


def around(members, *also):
    """The containers on the members' paths, each with its own path; ``also``: members among them."""
    out = {}
    for c in members:
        for k, a in enumerate(c.chain):
            out.setdefault(a, Candidate(a, False, chain=c.chain[k + 1:]))
    out.update({c.urn: c for c in also})
    return out


def placed(members, *, context=None, previous=None, user=None, overrides=None, placer=None,
           layer_ids=IDS, fallback=None, **kw):
    rows, waiting = plan_page(
        members, context=around(members) if context is None else context, previous=previous or {},
        user=user or {}, layer_ids=layer_ids, overrides=overrides or {},
        placer=placer or rules_placer(LAYERS, FACTS), fallback_layer_id=fallback, now="t0", **kw)
    return {r.urn: r for r in rows}, waiting


def layer_of(rows):
    return {u: r.layer_id for u, r in rows.items()}


# ── A page ──────────────────────────────────────────────────────────────────


def test_members_are_rows_and_the_containers_around_them_are_not():
    rows, _ = placed([member("col_a1")])
    assert set(rows) == {"col_a1"}
    r = rows["col_a1"]
    assert (r.layer_id, r.whole, r.covered, r.assigned_at) == ("L_cols", False, False, "t0")


def test_a_member_whose_inside_is_in_scope_is_whole():
    rows, _ = placed([member("tbl_a", whole=True)])
    assert rows["tbl_a"].whole is True


def test_inside_a_whole_member_in_its_layer_it_comes_with_it_and_in_another_it_is_covered():
    one_layer = [{"id": "L", "name": "All", "order": 0, "entityTypes": ["table", "column"]}]
    whole = member("tbl_a", whole=True)
    inside = [member("col_a1", "inside")]
    rows, _ = placed(inside, context=around(inside, whole), placer=rules_placer(one_layer, FACTS), layer_ids=["L"])
    assert rows == {}, "drawn with the whole member it sits in"
    rows, _ = placed(inside, context=around(inside, whole))
    assert (rows["col_a1"].layer_id, rows["col_a1"].covered) == ("L_cols", True)


def test_entries_people_placed_are_never_members():
    mine = {"col_a1": {"layerId": "L_tbls", "inheritsChildren": True, "assignedBy": "user"}}
    rows, _ = placed([member("col_a1"), member("col_a2")], user=mine)
    assert set(rows) == {"col_a2"}


def test_where_people_put_a_member_wins_then_the_source_layer_then_where_it_is():
    held = {"col_b1": {"layerId": "L_tbls", "orderKey": "k1", "assignedAt": "t-1"}}
    rows, _ = placed(
        [member("col_a1"), member("col_a2", source_layer="L_dbs"), member("col_b1")],
        previous=held, overrides={"col_a1": {"layerId": "L_tbls", "orderKey": "a0"}})
    assert (rows["col_a1"].layer_id, rows["col_a1"].order_key) == ("L_tbls", "a0")
    assert rows["col_a2"].layer_id == "L_dbs"
    assert (rows["col_b1"].layer_id, rows["col_b1"].order_key, rows["col_b1"].assigned_at) == ("L_tbls", "k1", "t-1")


def test_a_member_nothing_places_joins_its_container_or_the_fallback():
    tables_only = [{"id": "T", "name": "Tables", "order": 0, "entityTypes": ["table"]},
                   {"id": "O", "name": "Other", "order": 1, "entityTypes": []}]
    kw = dict(placer=rules_placer(tables_only, FACTS), layer_ids=["T", "O"], fallback="O")
    rows, waiting = placed([member("col_a1"), member("src_col", "upstream", 1)], **kw)
    assert rows["col_a1"].layer_id == "T", "its table's layer"
    assert rows["src_col"].layer_id == "T", "its table is placed too"
    assert waiting == 0
    only_tables = lambda cands: {u: ("T" if u == "tbl_a" else None) for u in cands}  # noqa: E731
    kw["placer"] = only_tables
    rows, _ = placed([member("col_a1")], **kw)
    assert rows["col_a1"].layer_id == "T", "nothing places it: its nearest drawn container does"
    rows, waiting = placed([member("col_a1")], place_containers=False, **kw)
    assert (rows["col_a1"].layer_id, waiting) == ("O", 1), "without nesting, only a member or a person's entry does"


def test_the_fallback_layer_is_counted():
    rows, waiting = placed([Candidate("x", True)], placer=lambda c: {"x": None}, fallback="L_dbs")
    assert (rows["x"].layer_id, waiting) == ("L_dbs", 1)


def test_a_member_waiting_in_the_fallback_layer_is_placed_again():
    layers = [*LAYERS, {"id": "O", "name": "Other", "order": 3, "entityTypes": []}]
    waiting = {"col_a1": {"layerId": "O"}}
    kw = dict(placer=rules_placer(layers, FACTS), layer_ids=[*IDS, "O"], fallback="O")
    rows, _ = placed([member("col_a1")], previous=waiting, **kw)
    assert rows["col_a1"].layer_id == "L_cols"
    rows, _ = placed([member("col_a1")], previous=waiting, overrides={"col_a1": {"layerId": "O"}}, **kw)
    assert rows["col_a1"].layer_id == "O", "one a person put there stays"


def test_a_member_whose_layer_was_deleted_is_placed_again():
    rows, _ = placed([member("col_a1")], previous={"col_a1": {"layerId": "L_tbls", "orderKey": "k"}},
                     layer_ids=["L_dbs", "L_cols"])
    assert (rows["col_a1"].layer_id, rows["col_a1"].order_key) == ("L_cols", None)


def test_kept_out_entities_are_no_rows_and_draw_nothing_in():
    only_tables = lambda cands: {u: ("T" if u.startswith("tbl_") else None) for u in cands}  # noqa: E731
    rows, _ = placed([member("col_a1"), member("col_b1")], exclude={"col_b1", "tbl_a"},
                     placer=only_tables, layer_ids=["T", "O"], fallback="O")
    assert set(rows) == {"col_a1"}
    assert rows["col_a1"].layer_id == "O", "its kept-out table does not draw it"


def test_planning_again_over_its_own_answer_changes_nothing():
    members = [member("col_a1"), member("col_b1"), member("tbl_a", "inside")]
    first, _ = placed(members)
    previous = {u: {"layerId": r.layer_id, "assignedAt": r.assigned_at} for u, r in first.items()}
    again, _ = placed(members, previous=previous)
    assert again == first


def test_any_page_gives_the_same_rows():
    """A member's row is its own and its path's: placed a page of one at a time, or all at
    once, the rows are the same."""
    whole = member("tbl_a", whole=True)
    members = [whole, member("col_a1", "inside"), member("col_b1", "inside"), member("src_col", "upstream", 1),
               member("sch", "inside"), member("col_a2", "partnerInside")]
    context = around(members, whole, member("sch", "inside"))
    everything, waiting = placed(members, context=context, fallback="L_dbs")
    pieces, waited = {}, 0
    for c in members:
        rows, n = placed([c], context=context, fallback="L_dbs")
        pieces.update(rows)
        waited += n
    assert (pieces, waited) == (everything, waiting)


# ── Each layout ─────────────────────────────────────────────────────────────


def test_like_the_view_it_was_made_from():
    source_layers = [
        {"id": "a_tables", "name": "Tables", "order": 0, "entityTypes": ["table"], "anchorUrn": "x",
         "rules": [{"id": "r1", "urnPattern": "exact:urn"}, {"id": "r2", "urnPattern": "urn:*"}]},
        {"id": "a_cols", "name": "Columns", "order": 1, "entityTypes": ["column"]},
    ]
    source_config = {
        "layout": {"referenceLayout": {"layers": source_layers,
                                       "assignments": {"tbl_a": {"layerId": "a_tables", "inheritsChildren": True}}}},
        "content": {"entityScope": "curated"},
    }
    mine = layouts.layers_like(source_layers)
    assert [l["linkLayerId"] for l in mine] == ["a_tables", "a_cols"]
    assert "anchorUrn" not in mine[0] and [r["id"] for r in mine[0]["rules"]] == ["r2"]
    assert all(l["id"] not in ("a_tables", "a_cols") for l in mine)

    placer = source_placer(source_config, layouts.link_map(mine), FACTS)
    rows, _ = placed([member("col_a1"), member("src_col", "upstream", 1)], placer=placer,
                     layer_ids=layouts.layer_ids(mine))
    tables, cols = mine[0]["id"], mine[1]["id"]
    # In the view, a column sits with its table (inherited by hand); outside it, the rules decide.
    assert layer_of(rows) == {"col_a1": tables, "src_col": cols}


def test_lineage_stages():
    partner = member("src_tbl", "upstream", 3)
    members = [member("col_a1"), member("src_col", "upstream", 1), partner,
               member("col_b1", "partnerInside", chain=("src_tbl",))]
    stages = layouts.stage_layers(SOURCE.spec.expand.model_copy(update={"upstream": "all"}))
    assert [l["id"] for l in stages] == ["stage-up2", "stage-up1", "stage-seed"]
    rows, _ = placed(members, context=around(members, partner), placer=stage_placer(),
                     layer_ids=[l["id"] for l in stages], restage=True, place_containers=False)
    assert layer_of(rows) == {"col_a1": "stage-seed", "src_col": "stage-up1", "src_tbl": "stage-up2",
                              "col_b1": "stage-up2"}
    alone, _ = placed(members[-1:], context=around(members, partner), placer=stage_placer(),
                      layer_ids=[l["id"] for l in stages], restage=True, place_containers=False)
    assert alone["col_b1"].layer_id == "stage-up2", "in its partner's stage, on a page of its own"


def test_restaging_follows_the_data():
    ids = ["stage-up1", "stage-seed"]
    now_seed = [member("col_a2", "seed", chain=("tbl_a",))]
    rows, _ = placed(now_seed, previous={"col_a2": {"layerId": "stage-up1"}}, placer=stage_placer(),
                     layer_ids=ids, restage=True, place_containers=False)
    assert rows["col_a2"].layer_id == "stage-seed"


def test_by_top_level_type():
    members = [member("col_a1"), member("src_col", "upstream", 1)]
    counts = top_type_counts({c.urn: c for c in members}, FACTS)
    assert counts == {"database": 2}
    mine = layouts.auto_layers({"database": 2, "dashboard": 1})
    assert [l["name"] for l in mine] == ["Databases", "Dashboards"]
    rows, _ = placed(members, placer=auto_placer(layouts.type_layer_map(mine), FACTS),
                     layer_ids=layouts.layer_ids(mine))
    assert set(layer_of(rows).values()) == {mine[0]["id"]}


def test_auto_layers_past_the_limit_share_other():
    mine = layouts.auto_layers({f"t{i}": 20 - i for i in range(14)})
    assert len(mine) == layouts.AUTO_LAYERS_MAX + 1 and mine[-1]["name"] == layouts.OTHER
