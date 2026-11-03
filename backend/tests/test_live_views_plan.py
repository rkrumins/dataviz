"""A view made from a query: resolved sources → its entries, for each layout.

    db ⊃ sch ⊃ tbl_a ⊃ {col_a1, col_a2}
         sch ⊃ tbl_b ⊃ col_b1
    src_db ⊃ src_tbl ⊃ src_col          (a source of col_a1, outside the view it was made from)
"""
from backend.app.services.live_views import layouts
from backend.app.services.live_views.plan import (
    Candidate,
    auto_placer,
    candidates,
    plan,
    rules_placer,
    source_placer,
    stage_placer,
    top_type_counts,
)
from backend.app.services.view_placement import NodeFacts
from backend.common.models.view_membership import MACHINE, MembershipResult, MembershipSource

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


def result(members, whole=()):
    return MembershipResult(
        specHash="h",
        members=[{"urn": u, "via": via, **({"hops": hops} if hops else {})} for u, via, hops in members],
        wholeSubtree=list(whole),
        chains={u: CHAINS[u] for u, _, _ in members},
    )


SOURCE = MembershipSource.model_validate({"spec": {"seeds": {"urns": ["col_a1"]}}})


def planned(cands, *, assignments=None, overrides=None, placer=None, limit=5000, **kw):
    return plan(
        cands, assignments=assignments or {}, layer_ids=kw.pop("layer_ids", IDS),
        overrides=overrides or {}, placer=placer or rules_placer(LAYERS, FACTS),
        fallback_layer_id=kw.pop("fallback", None), limit=limit, now="t0", **kw,
    )


# ── Candidates ──────────────────────────────────────────────────────────────


def test_members_bring_the_containers_on_their_path():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("src_col", "upstream", 1)]))], nest=True)
    assert {u for u, c in cands.items() if c.member} == {"col_a1", "src_col"}
    assert {u for u, c in cands.items() if not c.member} == {"tbl_a", "sch", "db", "src_tbl", "src_db"}
    assert cands["tbl_a"].chain == ("sch", "db")


def test_without_nesting_only_members():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None)]))], nest=False)
    assert set(cands) == {"col_a1"}


def test_excluded_entities_stay_out_and_their_path_stops_there():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("col_b1", "inside", None)]))],
                       nest=True, exclude={"col_b1", "sch"})
    assert "col_b1" not in cands
    assert {u for u, c in cands.items() if not c.member} == {"tbl_a"}


def test_the_first_source_gives_the_reason_and_any_source_makes_it_whole():
    layer_source = MembershipSource.model_validate({"spec": {"seeds": {"urns": ["tbl_a"]}}, "layerId": "L_tbls"})
    cands = candidates([
        (SOURCE, result([("tbl_a", "upstream", 2)])),
        (layer_source, result([("tbl_a", "seed", None)], whole=["tbl_a"])),
    ], nest=False)
    assert (cands["tbl_a"].via, cands["tbl_a"].hops, cands["tbl_a"].whole) == ("upstream", 2, True)
    assert cands["tbl_a"].source_layer is None


# ── The plan ────────────────────────────────────────────────────────────────


def test_members_are_held_exactly_and_containers_cascade_nothing():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None)]))], nest=True)
    p = planned(cands)
    assert p.assignments["col_a1"] == {"layerId": "L_cols", "inheritsChildren": False, "assignedBy": MACHINE, "assignedAt": "t0"}
    assert p.assignments["tbl_a"]["layerId"] == "L_tbls" and p.assignments["tbl_a"]["inheritsChildren"] is False
    assert p.assignments["db"]["layerId"] == "L_dbs"
    assert (p.members, p.containers, p.keys) == (1, 3, 4)
    assert p.added == ["col_a1", "db", "sch", "tbl_a"]


def test_a_member_whose_inside_is_in_scope_cascades():
    cands = candidates([(SOURCE, result([("tbl_a", "seed", None)], whole=["tbl_a"]))], nest=False)
    assert planned(cands).assignments["tbl_a"]["inheritsChildren"] is True


def test_a_member_inside_a_whole_member_in_its_layer_comes_with_it():
    cands = candidates([(SOURCE, result([("tbl_a", "seed", None), ("col_a1", "inside", None)], whole=["tbl_a"]))],
                       nest=False)
    one_layer = [{"id": "L", "name": "All", "order": 0, "entityTypes": ["table", "column"]}]
    p = planned(cands, placer=rules_placer(one_layer, FACTS), layer_ids=["L"])
    assert set(p.assignments) == {"tbl_a"}


def test_entries_people_placed_are_never_touched():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None)]))], nest=False)
    mine = {"col_a1": {"layerId": "L_tbls", "inheritsChildren": True, "assignedBy": "user"},
            "elsewhere": {"layerId": "L_dbs", "assignedBy": "user"}}
    p = planned(cands, assignments=mine)
    assert p.assignments["col_a1"] == mine["col_a1"] and p.assignments["elsewhere"] == mine["elsewhere"]
    assert (p.members, p.included) == (0, 2)


def test_where_people_put_a_member_wins_then_the_source_layer_then_where_it_is():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("col_a2", "seed", None), ("col_b1", "seed", None)]))],
                       nest=False)
    cands["col_a2"] = Candidate("col_a2", True, source_layer="L_dbs")
    held = {"col_b1": {"layerId": "L_tbls", "inheritsChildren": False, "assignedBy": MACHINE, "orderKey": "k1"}}
    p = planned(cands, assignments=held, overrides={"col_a1": {"layerId": "L_tbls", "orderKey": "a0"}})
    assert (p.assignments["col_a1"]["layerId"], p.assignments["col_a1"]["orderKey"]) == ("L_tbls", "a0")
    assert p.assignments["col_a2"]["layerId"] == "L_dbs"
    assert p.assignments["col_b1"] == {**held["col_b1"], "assignedAt": "t0"}


def test_a_member_nothing_places_joins_its_container_or_the_fallback_and_a_container_is_left_out():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("src_col", "upstream", 1)]))], nest=True)
    tables_only = [{"id": "T", "name": "Tables", "order": 0, "entityTypes": ["table"]},
                   {"id": "O", "name": "Other", "order": 1, "entityTypes": []}]
    p = planned(cands, placer=rules_placer(tables_only, FACTS), layer_ids=["T", "O"], fallback="O")
    assert p.assignments["col_a1"]["layerId"] == "T"           # its table's layer
    assert "db" not in p.assignments and "sch" not in p.assignments
    assert p.fallback == 0


def test_the_fallback_layer_is_counted():
    cands = {"x": Candidate("x", True)}
    p = planned(cands, placer=lambda c: {"x": None}, fallback="L_dbs")
    assert (p.assignments["x"]["layerId"], p.fallback) == ("L_dbs", 1)


def test_over_the_limit_says_so():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None)]))], nest=True)
    assert planned(cands, limit=3).over_cap


def test_planning_again_over_its_own_answer_changes_nothing():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("col_b1", "seed", None)]))], nest=True)
    first = planned(cands)
    again = planned(cands, assignments=first.assignments)
    assert again.assignments == first.assignments
    assert not again.changed


def test_members_that_left_are_removed_and_moves_are_reported():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None)]))], nest=False)
    held = {
        "gone": {"layerId": "L_cols", "inheritsChildren": False, "assignedBy": MACHINE},
        "col_a1": {"layerId": "L_tbls", "inheritsChildren": False, "assignedBy": MACHINE},
    }
    p = planned(cands, assignments=held, layer_ids=["L_dbs", "L_cols"])     # L_tbls deleted
    assert p.removed == ["gone"]
    assert p.moved == ["col_a1"] and p.assignments["col_a1"]["layerId"] == "L_cols"


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

    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("src_col", "upstream", 1)]))], nest=False)
    placer = source_placer(source_config, layouts.link_map(mine), FACTS)
    p = planned(cands, placer=placer, layer_ids=layouts.layer_ids(mine))
    tables, cols = mine[0]["id"], mine[1]["id"]
    # In the view, a column sits with its table (inherited by hand); outside it, the rules decide.
    assert p.assignments["col_a1"]["layerId"] == tables
    assert p.assignments["src_col"]["layerId"] == cols


def test_lineage_stages():
    cands = candidates([(SOURCE, result([
        ("col_a1", "seed", None), ("src_col", "upstream", 1), ("src_tbl", "upstream", 3),
        ("col_b1", "partnerInside", None),
    ]))], nest=False)
    cands["col_b1"] = Candidate("col_b1", True, via="partnerInside", chain=("src_tbl",))
    stages = layouts.stage_layers(SOURCE.spec.expand.model_copy(update={"upstream": "all"}))
    assert [l["id"] for l in stages] == ["stage-up2", "stage-up1", "stage-seed"]
    p = planned(cands, placer=stage_placer(), layer_ids=[l["id"] for l in stages])
    got = {u: e["layerId"] for u, e in p.assignments.items()}
    assert got == {"col_a1": "stage-seed", "src_col": "stage-up1", "src_tbl": "stage-up2", "col_b1": "stage-up2"}


def test_a_container_across_stages_is_left_out_and_restaging_follows_the_data():
    cands = {
        "tbl_a": Candidate("tbl_a", False),
        "col_a1": Candidate("col_a1", True, via="seed", chain=("tbl_a",)),
        "col_a2": Candidate("col_a2", True, via="upstream", hops=1, chain=("tbl_a",)),
    }
    ids = ["stage-up1", "stage-seed"]
    p = planned(cands, placer=stage_placer(), layer_ids=ids)
    assert "tbl_a" not in p.assignments
    cands["col_a2"] = Candidate("col_a2", True, via="seed", chain=("tbl_a",))
    again = planned(cands, assignments=p.assignments, placer=stage_placer(), layer_ids=ids, restage=True)
    assert again.assignments["col_a2"]["layerId"] == "stage-seed" and again.assignments["tbl_a"]["layerId"] == "stage-seed"


def test_by_top_level_type():
    cands = candidates([(SOURCE, result([("col_a1", "seed", None), ("src_col", "upstream", 1)]))], nest=True)
    counts = top_type_counts(cands, FACTS)
    assert counts == {"database": 2}
    mine = layouts.auto_layers({"database": 2, "dashboard": 1})
    assert [l["name"] for l in mine] == ["Databases", "Dashboards"]
    p = planned(cands, placer=auto_placer(layouts.type_layer_map(mine), FACTS), layer_ids=layouts.layer_ids(mine))
    assert {e["layerId"] for e in p.assignments.values()} == {mine[0]["id"]}


def test_auto_layers_past_the_limit_share_other():
    mine = layouts.auto_layers({f"t{i}": 20 - i for i in range(14)})
    assert len(mine) == layouts.AUTO_LAYERS_MAX + 1 and mine[-1]["name"] == layouts.OTHER
