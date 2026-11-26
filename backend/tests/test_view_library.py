"""A view's library over HTTP: its display rules, written one at a time on the
published view or on a draft, its saved queries, and the pack both travel in.

A rule write reads and writes back only the rule it names, so two people
editing different rules both keep theirs; it never moves the view's
``updated_at``, which keys the view's search sessions and property catalog.
Same fixtures as ``test_view_layout_rules_preserved.py``.
"""
import contextlib

from fastapi import HTTPException, status
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.db.repositories import view_repo
from backend.app.services import view_library
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


def _rule(rule_id: str, name: str, **over) -> dict:
    return {"id": rule_id, "name": name, "color": "#6366f1", "enabled": True,
            "predicate": {"kind": "hasProperty", "key": name.lower()}, **over}


def _query(name: str, **over) -> dict:
    return {"name": name, "predicate": {"kind": "hasProperty", "key": name.lower()}, **over}


async def _view(client: AsyncClient, name: str = "Library View", config: dict | None = None) -> str:
    ws = await client.post("/api/v1/admin/workspaces", json={"name": f"{name} WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": name, "workspaceId": ws.json()["id"], "viewType": "reference",
        "config": config or {"layout": {"type": "reference"}}, "visibility": "private",
    })
    assert resp.status_code == 201
    return resp.json()["id"]


async def _library(client: AsyncClient, view_id: str, branch: str | None = None) -> dict:
    resp = await client.get(f"/api/v1/views/{view_id}/library",
                            params={"branchId": branch} if branch else None)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _names(items: list) -> list:
    return [i["name"] for i in items]


# ── rules ────────────────────────────────────────────────────────────

async def test_rules_are_added_replaced_in_place_and_removed(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    for rule in (_rule("r1", "PII"), _rule("r2", "Owned")):
        assert (await test_client.put(f"{base}/{rule['id']}", json=rule)).status_code == 200

    edited = await test_client.put(f"{base}/r1", json=_rule("r1", "PII data", color="#ff0000"))
    assert edited.status_code == 200
    assert [(r["id"], r["name"]) for r in edited.json()] == [("r1", "PII data"), ("r2", "Owned")]

    removed = await test_client.delete(f"{base}/r2")
    assert removed.status_code == 200
    library = await _library(test_client, view_id)
    assert _names(library["displayRules"]) == ["PII data"]
    assert library["canEdit"] is True
    # Where every older reader looks for them.
    view = (await test_client.get(f"/api/v1/views/{view_id}")).json()
    assert _names(view["config"]["layout"]["referenceLayout"]["displayRules"]) == ["PII data"]


async def test_a_rule_keeps_how_it_paints_what_it_matches(test_client: AsyncClient):
    """A rule's style — its chip on or off, a tint, a frame — is stored with it, read back as it
    was written, and travels with it in a pack."""
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library"
    style = {"chip": False, "fill": True, "frame": "dashed"}
    resp = await test_client.put(f"{base}/rules/r1", json=_rule("r1", "Seed", style=style))
    assert resp.status_code == 200, resp.text
    assert resp.json()[0]["style"] == style
    assert (await _library(test_client, view_id))["displayRules"][0]["style"] == style

    pack = (await test_client.get(f"{base}/export")).json()
    assert pack["displayRules"][0]["style"] == style
    target = await _view(test_client, "Target")
    done = await test_client.post(f"/api/v1/views/{target}/library/import",
                                  params={"dryRun": "false"}, json=pack)
    assert done.json()["library"]["displayRules"][0]["style"] == style


async def test_a_rule_without_a_style_is_stored_without_one(test_client: AsyncClient):
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1", json=_rule("r1", "PII"))
    assert resp.status_code == 200
    assert "style" not in resp.json()[0]


async def test_a_style_the_canvas_cannot_draw_is_refused(test_client: AsyncClient):
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1",
                                 json=_rule("r1", "PII", style={"frame": "wavy"}))
    assert resp.status_code == 422


def _relationship_rule(rule_id: str, name: str, **over) -> dict:
    return _rule(rule_id, name, **{"target": "relationships", "predicate": {
        "kind": "group", "op": "and", "children": [{
            "kind": "edges", "edgeTypes": ["FEEDS"],
            "edgePredicate": {"kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}}]},
        **over})


async def test_a_rule_applies_to_entities_and_is_stored_as_it_always_was(test_client: AsyncClient):
    """A rule applies to entities unless it says otherwise, and one that does is stored, read
    and exported without saying so — every rule saved before relationship rules is unchanged."""
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    await test_client.put(f"{base}/r1", json=_rule("r1", "PII"))
    resp = await test_client.put(f"{base}/r2", json=_rule("r2", "Owned", target="entities"))
    assert resp.status_code == 200, resp.text
    assert all("target" not in r for r in resp.json())
    stored = (await test_client.get(f"/api/v1/views/{view_id}")).json()
    assert [set(r) for r in stored["config"]["layout"]["referenceLayout"]["displayRules"]] == \
        [{"id", "name", "color", "enabled", "predicate", "createdAt"}] * 2
    assert all("target" not in r for r in (await test_client.get(
        f"/api/v1/views/{view_id}/library/export")).json()["displayRules"])


async def test_a_rule_applied_to_relationships_keeps_how_it_draws_their_lines(test_client: AsyncClient):
    view_id = await _view(test_client)
    style = {"chip": False, "dash": "dotted", "width": 4}
    resp = await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1",
                                 json=_relationship_rule("r1", "Streams", style=style))
    assert resp.status_code == 200, resp.text
    [rule] = (await _library(test_client, view_id))["displayRules"]
    assert (rule["target"], rule["style"], rule.get("invalid")) == ("relationships", style, None)


async def test_a_rule_is_a_connections_search_exactly_when_it_applies_to_relationships(
        test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    connections = _relationship_rule("x", "x")["predicate"]
    for rule, why in [
        (_rule("a", "Entities", predicate=connections), "A display rule tags entities"),
        (_rule("b", "Lines", target="relationships"), "is a Connections search"),
        (_relationship_rule("c", "Far", predicate={"kind": "edges", "targetWhere": {
            "kind": "related", "axis": "downstream", "maxHops": 2}}), "one hop"),
        (_relationship_rule("d", "Regex", predicate={"kind": "edges", "sourceWhere": {
            "kind": "text", "value": "^ord", "match": "regex"}}), "regex"),
        (_relationship_rule("e", "Tinted", style={"fill": True}), "a dash and a width"),
        (_rule("f", "Dashed", style={"dash": "dashed"}), "a fill and a frame"),
        (_relationship_rule("g", "Wide", style={"width": 20}), "width"),
    ]:
        resp = await test_client.put(f"{base}/{rule['id']}", json=rule)
        assert resp.status_code == 422, rule["id"]
        assert why in str(resp.json()["detail"]), (rule["id"], resp.json()["detail"])
    assert (await _library(test_client, view_id))["displayRules"] == []


async def test_a_stored_connections_rule_that_doesnt_say_it_styles_relationships_is_flagged(
        test_client: AsyncClient):
    connections = _relationship_rule("x", "x")["predicate"]
    view_id = await _view(test_client, config={"layout": {"type": "reference", "referenceLayout": {
        "displayRules": [_relationship_rule("ok", "Lines"), _rule("old", "Old", predicate=connections)]}}})
    rules = (await _library(test_client, view_id))["displayRules"]
    assert [r["id"] for r in rules if r.get("invalid")] == ["old"]


async def test_relationship_rules_travel_in_a_pack_warning_of_types_the_ontology_lacks(
        test_client: AsyncClient, monkeypatch):
    source = await _view(test_client, "Source")
    style = {"chip": True, "dash": "dashed", "width": 2}
    await test_client.put(f"/api/v1/views/{source}/library/rules/r1",
                          json=_relationship_rule("r1", "Streams", style=style))
    await test_client.put(f"/api/v1/views/{source}/library/rules/r2", json=_rule("r2", "PII"))
    pack = (await test_client.get(f"/api/v1/views/{source}/library/export")).json()
    assert [r.get("target") for r in pack["displayRules"]] == ["relationships", None]

    target = await _view(test_client, "Target")
    url = f"/api/v1/views/{target}/library/import"
    # An ontology that defines no relationship types warns of none.
    assert [i["warnings"] for i in (await test_client.post(url, json=pack)).json()["items"]] == [[], []]

    async def ontology(session, view):
        return frozenset({"produces"})

    monkeypatch.setattr(view_library, "_view_relationship_types", ontology)
    items = (await test_client.post(url, json=pack)).json()["items"]
    assert items[0]["warnings"] == ["Refers to relationship types this view's ontology doesn't have: FEEDS"]
    assert items[1]["warnings"] == []
    done = (await test_client.post(url, params={"dryRun": "false"}, json=pack)).json()
    [lines, pii] = done["library"]["displayRules"]
    assert (lines["target"], lines["style"], lines["predicate"]) == (
        "relationships", style, pack["displayRules"][0]["predicate"])
    assert "target" not in pii


async def test_the_path_names_the_rule(test_client: AsyncClient):
    view_id = await _view(test_client)
    resp = await test_client.put(f"/api/v1/views/{view_id}/library/rules/r9", json=_rule("other", "PII"))
    assert [r["id"] for r in resp.json()] == ["r9"]


async def test_library_writes_leave_the_views_updated_at_alone(test_client: AsyncClient, db_session):
    view_id = await _view(test_client)

    async def updated_at() -> str:
        return (await db_session.execute(
            select(ViewORM.updated_at).where(ViewORM.id == view_id))).scalar_one()

    before = await updated_at()
    await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1", json=_rule("r1", "PII"))
    await test_client.put(f"/api/v1/views/{view_id}/library/rules", json={"ids": ["r1"]})
    await test_client.put(f"/api/v1/views/{view_id}/library/queries/q1", json=_query("Tables"))
    assert await updated_at() == before


async def test_rules_can_be_reordered(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    for rule in (_rule("a", "A"), _rule("b", "B"), _rule("c", "C")):
        await test_client.put(f"{base}/{rule['id']}", json=rule)
    # Ids the client didn't know about keep their place after the ones it named.
    resp = await test_client.put(base, json={"ids": ["c", "a"]})
    assert [r["id"] for r in resp.json()] == ["c", "a", "b"]


async def test_a_second_rule_with_the_same_name_is_refused(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    await test_client.put(f"{base}/r1", json=_rule("r1", "PII"))
    resp = await test_client.put(f"{base}/r2", json=_rule("r2", "pii"))
    assert resp.status_code == 409


async def test_a_rule_is_checked_as_a_search_is(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    route = await test_client.put(f"{base}/r1", json=_rule("r1", "Near", predicate={
        "kind": "withinHops", "urns": ["urn:a"], "hops": 2}))
    assert route.status_code == 422
    assert "within hops" in route.json()["detail"]
    empty = await test_client.put(f"{base}/r2", json=_rule("r2", "Empty", predicate={
        "kind": "group", "op": "AND", "children": []}))
    assert empty.status_code == 422
    assert (await _library(test_client, view_id))["displayRules"] == []


async def test_a_rule_the_engines_cannot_evaluate_is_refused_with_why(test_client: AsyncClient):
    """Saved, these used to fail every time the canvas counted or tagged
    them. A rule is refused for its own shape only — the graph's edge types
    are not needed to save one."""
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    for rule_id, predicate, why in [
        ("rx", {"kind": "text", "value": "^ord", "match": "regex"}, "regex"),
        ("ft", {"kind": "text", "value": "orders", "match": "fulltext"}, "fulltext"),
    ]:
        resp = await test_client.put(f"{base}/{rule_id}", json=_rule(rule_id, rule_id, predicate=predicate))
        assert resp.status_code == 422, rule_id
        assert why in resp.json()["detail"], resp.json()["detail"]
    # Inside a container under an OR is each entity's own test: a rule may be one.
    either = await test_client.put(f"{base}/or", json=_rule("or", "Inside or PII", predicate={
        "kind": "group", "op": "or", "children": [
            {"kind": "descendantOf", "urns": ["urn:a"]}, {"kind": "tag", "values": ["PII"]}]}))
    assert either.status_code == 200, either.text
    lineage = await test_client.put(f"{base}/root", json=_rule("root", "Roots", predicate={
        "kind": "isRoot", "edgeClass": "lineage"}))
    assert lineage.status_code == 200, lineage.text
    assert [r["id"] for r in (await _library(test_client, view_id))["displayRules"]] == ["or", "root"]


async def test_a_stored_rule_the_engines_cannot_evaluate_is_flagged(test_client: AsyncClient):
    view_id = await _view(test_client, config={"layout": {"type": "reference", "referenceLayout": {
        "displayRules": [
            _rule("ok", "Owned"),
            _rule("rx", "Regex", predicate={"kind": "text", "value": "^ord", "match": "regex"}),
        ]}}})
    rules = (await _library(test_client, view_id))["displayRules"]
    assert [r["id"] for r in rules if r.get("invalid")] == ["rx"]
    assert "regex" in rules[1]["invalid"]


async def test_a_stored_rule_a_rule_may_not_be_is_flagged_when_read(test_client: AsyncClient):
    """A bundle import or a version restore stores a view's rules as given,
    and rules saved before the library checked them never were. One a rule
    may not be comes flagged, with why, so the canvas shows it as one that
    can't be counted instead of sending it with the others. What is stored
    is left as it is."""
    view_id = await _view(test_client, config={"layout": {"type": "reference", "referenceLayout": {
        "displayRules": [
            _rule("ok", "Owned"),
            {"id": "bare", "name": "No predicate", "color": "#ff0000", "enabled": True},
            _rule("near", "Near", predicate={"kind": "withinHops", "urns": ["urn:a"], "hops": 2}),
        ]}}})
    rules = (await _library(test_client, view_id))["displayRules"]
    assert [r["id"] for r in rules if r.get("invalid")] == ["bare", "near"]
    assert "within hops" in rules[2]["invalid"]
    written = await test_client.put(f"/api/v1/views/{view_id}/library/rules/new",
                                    json=_rule("new", "New"))
    assert [r["id"] for r in written.json() if r.get("invalid")] == ["bare", "near"]
    stored = (await test_client.get(f"/api/v1/views/{view_id}")).json()
    assert not any("invalid" in r
                   for r in stored["config"]["layout"]["referenceLayout"]["displayRules"])


async def test_a_view_holds_a_bounded_number_of_rules(test_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(view_library, "LIBRARY_RULES_MAX", 2)
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    await test_client.put(f"{base}/a", json=_rule("a", "A"))
    await test_client.put(f"{base}/b", json=_rule("b", "B"))
    assert (await test_client.put(f"{base}/c", json=_rule("c", "C"))).status_code == 422
    # Replacing one is not adding one.
    assert (await test_client.put(f"{base}/a", json=_rule("a", "A2"))).status_code == 200


async def test_a_drafts_rules_stay_on_the_draft(test_client: AsyncClient, any_open_draft):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    await test_client.put(f"{base}/r1", json=_rule("r1", "Published"))
    resp = await test_client.put(f"{base}/r2?branchId=br_draft", json=_rule("r2", "Draft"))
    assert resp.status_code == 200
    # The draft forked the published rules, then added its own.
    assert _names((await _library(test_client, view_id, "br_draft"))["displayRules"]) == [
        "Published", "Draft"]
    assert _names((await _library(test_client, view_id))["displayRules"]) == ["Published"]


async def test_promote_keeps_rules_added_on_both_sides(test_client: AsyncClient, db_session, any_open_draft):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    await test_client.put(f"{base}/r1", json=_rule("r1", "Shared"))
    await test_client.put(f"{base}/r2?branchId=br_draft", json=_rule("r2", "From the draft"))
    await test_client.put(f"{base}/r3", json=_rule("r3", "Published since"))

    assert await view_repo.promote_overlay(db_session, view_id, "br_draft")
    assert _names((await _library(test_client, view_id))["displayRules"]) == [
        "Shared", "From the draft", "Published since"]


# ── saved queries ────────────────────────────────────────────────────

async def test_saved_queries_are_kept_named_ordered_and_removed(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/queries"
    first = await test_client.put(f"{base}/q1", json=_query("Tables", description="All tables"))
    assert first.status_code == 200
    assert first.json()["createdBy"] and first.json()["createdAt"]
    await test_client.put(f"{base}/q2", json=_query("Columns"))

    renamed = await test_client.put(f"{base}/q1", json=_query("Every table"))
    assert renamed.json()["createdAt"] == first.json()["createdAt"]
    assert (await test_client.put(f"{base}/q3", json=_query("columns"))).status_code == 409

    ordered = await test_client.put(base, json={"ids": ["q2", "q1"]})
    assert _names(ordered.json()) == ["Columns", "Every table"]
    removed = await test_client.delete(f"{base}/q2")
    assert removed.status_code == 204
    assert _names((await _library(test_client, view_id))["savedQueries"]) == ["Every table"]


async def test_saved_queries_belong_to_the_view_on_every_branch(test_client: AsyncClient, any_open_draft):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}/library/queries/q1", json=_query("Tables"))
    assert _names((await _library(test_client, view_id, "br_any"))["savedQueries"]) == ["Tables"]


async def test_a_query_id_another_view_holds_is_refused(test_client: AsyncClient):
    one, two = await _view(test_client, "One"), await _view(test_client, "Two")
    await test_client.put(f"/api/v1/views/{one}/library/queries/q1", json=_query("Tables"))
    resp = await test_client.put(f"/api/v1/views/{two}/library/queries/q1", json=_query("Tables"))
    assert resp.status_code == 409


# ── reusable changes ─────────────────────────────────────────────────

def _change(name: str, target: dict | None = None, **over) -> dict:
    return {"name": name, "op": {"kind": "set", "key": "owner", "value": "data-team"},
            "target": target or {"kind": "hasKey", "key": "owner"}, **over}


async def test_reusable_changes_are_kept_named_ordered_and_removed(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/reusable-changes"
    first = await test_client.put(f"{base}/b1", json=_change("Own them", description="Every owner"))
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["createdBy"] and body["createdAt"] and body["description"] == "Every owner"
    # The change as a job keeps it, the target as sent with its scope.
    assert body["op"] == {"kind": "set", "key": "owner", "value": "data-team", "onConflict": "skip"}
    assert body["target"] == {"kind": "hasKey", "key": "owner", "scopeMode": "view"}
    await test_client.put(f"{base}/b2", json=_change("Tidy", {"kind": "layer", "layerName": "Gold"},
                                                    op={"kind": "normalize", "key": "name"}))

    renamed = await test_client.put(f"{base}/b1", json=_change("Own every one"))
    assert renamed.json()["createdAt"] == first.json()["createdAt"]
    assert (await test_client.put(f"{base}/b3", json=_change("tidy"))).status_code == 409

    ordered = await test_client.put(base, json={"ids": ["b2", "b1"]})
    assert _names(ordered.json()) == ["Tidy", "Own every one"]
    assert (await test_client.delete(f"{base}/b2")).status_code == 204
    library = await _library(test_client, view_id)
    assert _names(library["reusableChanges"]) == ["Own every one"]


async def test_reusable_changes_keep_each_kind_of_target_but_ids(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/reusable-changes"
    connections = {"kind": "edges", "edgeTypes": ["FLOWS_TO"]}
    for i, target in enumerate([
        {"kind": "view", "scopeMode": "data_source"},
        {"kind": "search", "predicate": {"kind": "hasProperty", "key": "pii"}, "scopeMode": "view"},
        {"kind": "custom", "predicate": {"kind": "entityType", "values": ["Table"]}, "scopeMode": "data_source"},
        {"kind": "connections", "predicate": connections, "scopeMode": "view"},
    ]):
        resp = await test_client.put(f"{base}/t{i}", json=_change(f"R{i}", target))
        assert resp.status_code == 200, resp.text
        assert resp.json()["target"] == target


async def test_a_reusable_change_never_keeps_ids(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/reusable-changes"
    for target in ({"kind": "selection", "ids": ["urn:a"]},
                   {"kind": "relationships", "ids": ["e1"]},
                   {"kind": "children", "urns": ["urn:a"], "label": "Orders"},
                   {"kind": "view", "ids": ["urn:a"]},
                   {"kind": "view", "edgeIds": ["e1"]}):
        resp = await test_client.put(f"{base}/x", json=_change("Picked", target))
        assert resp.status_code == 422, target
        assert "picked by id" in resp.text
    assert (await _library(test_client, view_id))["reusableChanges"] == []


async def test_a_reusable_changes_target_and_operation_are_checked(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/reusable-changes"
    refused = [
        _change("No key", {"kind": "hasKey"}),
        _change("Stray predicate", {"kind": "view", "predicate": {"kind": "all"}}),
        _change("Layer everywhere", {"kind": "layer", "layerName": "Gold", "scopeMode": "data_source"}),
        _change("Visible", {"kind": "view", "scopeMode": "visible"}),
        _change("Nameless", {"kind": "search", "predicate": {"kind": "nonsense"}}),
        _change("No value", op={"kind": "set", "key": "owner"}),
    ]
    for body in refused:
        assert (await test_client.put(f"{base}/x", json=body)).status_code == 422, body["name"]
    # A predicate is checked as a saved query's is, and says what is wrong.
    bad = await test_client.put(f"{base}/x", json=_change("Bad", {
        "kind": "search", "predicate": {"kind": "property", "key": "n", "op": "gt", "value": "x",
                                        "valueType": "number"}}))
    assert bad.status_code == 422 and isinstance(bad.json()["detail"], str)
    # A Connections search is a connections target, and only it is.
    edges = {"kind": "edges", "edgeTypes": ["FLOWS_TO"]}
    wrong = await test_client.put(f"{base}/x", json=_change("Edges", {"kind": "search", "predicate": edges}))
    assert wrong.status_code == 422 and "connections target" in wrong.json()["detail"]
    nodes = await test_client.put(f"{base}/x", json=_change("Nodes", {
        "kind": "connections", "predicate": {"kind": "hasProperty", "key": "pii"}}))
    assert nodes.status_code == 422 and "Connections search" in nodes.json()["detail"]
    assert (await _library(test_client, view_id))["reusableChanges"] == []


async def test_a_view_holds_a_bounded_number_of_reusable_changes(test_client: AsyncClient, monkeypatch):
    monkeypatch.setattr(view_library, "LIBRARY_REUSABLE_CHANGES_MAX", 2)
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/reusable-changes"
    await test_client.put(f"{base}/a", json=_change("A"))
    await test_client.put(f"{base}/b", json=_change("B"))
    assert (await test_client.put(f"{base}/c", json=_change("C"))).status_code == 422
    # Replacing one is not adding one.
    assert (await test_client.put(f"{base}/a", json=_change("A2"))).status_code == 200


async def test_reusable_changes_belong_to_the_view_on_every_branch(test_client: AsyncClient, any_open_draft):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}/library/reusable-changes/b1", json=_change("Own them"))
    assert _names((await _library(test_client, view_id, "br_any"))["reusableChanges"]) == ["Own them"]


async def test_a_reusable_change_id_another_view_holds_is_refused(test_client: AsyncClient):
    one, two = await _view(test_client, "One"), await _view(test_client, "Two")
    await test_client.put(f"/api/v1/views/{one}/library/reusable-changes/b1", json=_change("Own them"))
    resp = await test_client.put(f"/api/v1/views/{two}/library/reusable-changes/b1", json=_change("Own them"))
    assert resp.status_code == 409


# ── export and import ────────────────────────────────────────────────

async def _stocked(client: AsyncClient, name: str = "Source") -> str:
    view_id = await _view(client, name)
    await client.put(f"/api/v1/views/{view_id}/library/rules/r1", json=_rule("r1", "PII"))
    await client.put(f"/api/v1/views/{view_id}/library/rules/r2", json=_rule("r2", "Owned"))
    await client.put(f"/api/v1/views/{view_id}/library/queries/q1", json=_query("Tables"))
    return view_id


async def test_export_is_a_pack_file(test_client: AsyncClient):
    view_id = await _stocked(test_client, "Data Lineage")
    resp = await test_client.get(f"/api/v1/views/{view_id}/library/export")
    assert resp.status_code == 200
    assert 'filename="Data-Lineage.library.json"' in resp.headers["content-disposition"]
    pack = resp.json()
    assert pack["format"] == "synodic.view-library" and pack["version"] == 1
    assert pack["source"]["viewName"] == "Data Lineage"
    assert _names(pack["displayRules"]) == ["PII", "Owned"]
    assert pack["savedQueries"] == [{"id": "q1", "name": "Tables",
                                     "predicate": {"kind": "hasProperty", "key": "tables"}}]


async def test_import_previews_then_adds_with_new_ids(test_client: AsyncClient):
    pack = (await test_client.get(
        f"/api/v1/views/{await _stocked(test_client)}/library/export")).json()
    target = await _view(test_client, "Target")
    url = f"/api/v1/views/{target}/library/import"

    preview = await test_client.post(url, json=pack)   # dryRun is the default
    assert preview.status_code == 200
    body = preview.json()
    assert body["dryRun"] is True and body["added"] == 3 and body["library"] is None
    assert [(i["kind"], i["name"], i["action"]) for i in body["items"]] == [
        ("rule", "PII", "add"), ("rule", "Owned", "add"), ("query", "Tables", "add")]
    assert (await _library(test_client, target))["displayRules"] == []

    done = await test_client.post(url, params={"dryRun": "false"}, json=pack)
    library = done.json()["library"]
    assert _names(library["displayRules"]) == ["PII", "Owned"]
    assert _names(library["savedQueries"]) == ["Tables"]
    assert not {r["id"] for r in library["displayRules"]} & {"r1", "r2"}
    assert library["savedQueries"][0]["id"] != "q1"


async def test_import_merge_skips_what_the_view_has_and_copy_renames(test_client: AsyncClient):
    source = await _stocked(test_client)
    pack = (await test_client.get(f"/api/v1/views/{source}/library/export")).json()
    url = f"/api/v1/views/{source}/library/import"

    merged = (await test_client.post(url, params={"dryRun": "false"}, json=pack)).json()
    assert merged["added"] == 0 and merged["skipped"] == 3

    copied = (await test_client.post(url, params={"dryRun": "false", "strategy": "copy"},
                                     json=pack)).json()
    assert [i["newName"] for i in copied["items"]] == ["PII (2)", "Owned (2)", "Tables (2)"]
    assert _names(copied["library"]["displayRules"]) == ["PII", "Owned", "PII (2)", "Owned (2)"]


async def test_import_replace_removes_the_views_library_first(test_client: AsyncClient):
    target = await _stocked(test_client, "Target")
    pack = {"format": "synodic.view-library", "version": 1,
            "displayRules": [_rule("x", "Only rule")], "savedQueries": []}
    url = f"/api/v1/views/{target}/library/import"
    preview = (await test_client.post(url, params={"strategy": "replace"}, json=pack)).json()
    assert preview["removed"] == 3 and preview["added"] == 1

    done = (await test_client.post(url, params={"strategy": "replace", "dryRun": "false"},
                                   json=pack)).json()
    assert _names(done["library"]["displayRules"]) == ["Only rule"]
    assert done["library"]["savedQueries"] == []


async def test_import_refuses_a_bad_item_and_keeps_the_rest(test_client: AsyncClient):
    target = await _view(test_client, "Target")
    pack = {"format": "synodic.view-library", "version": 1, "displayRules": [
        _rule("a", "Fine"),
        _rule("b", "No color", color="red"),
        _rule("c", "Near", predicate={"kind": "withinHops", "urns": ["urn:a"], "hops": 1}),
    ], "savedQueries": [_query("Bad", predicate={"kind": "nope"})]}
    body = (await test_client.post(f"/api/v1/views/{target}/library/import",
                                   params={"dryRun": "false"}, json=pack)).json()
    assert [(i["name"], i["action"]) for i in body["items"]] == [
        ("Fine", "add"), ("No color", "refuse"), ("Near", "refuse"), ("Bad", "refuse")]
    assert all(i["reason"] for i in body["items"] if i["action"] == "refuse")
    assert _names(body["library"]["displayRules"]) == ["Fine"]


async def test_import_warns_about_types_the_view_doesnt_show(test_client: AsyncClient):
    target = await _view(test_client, "Datasets only", config={
        "layout": {"type": "reference"}, "content": {"visibleEntityTypes": ["dataset"]}})
    pack = {"format": "synodic.view-library", "version": 1, "displayRules": [
        _rule("a", "Columns", predicate={"kind": "entityType", "values": ["column"]}),
        _rule("b", "Datasets", predicate={"kind": "entityType", "values": ["Dataset"]}),
    ]}
    items = (await test_client.post(f"/api/v1/views/{target}/library/import", json=pack)).json()["items"]
    assert items[0]["warnings"] == ["Refers to entity types this view doesn't show: column"]
    assert items[1]["warnings"] == []


async def test_a_pack_of_another_format_is_refused(test_client: AsyncClient):
    target = await _view(test_client)
    resp = await test_client.post(f"/api/v1/views/{target}/library/import",
                                  json={"format": "something-else", "version": 1})
    assert resp.status_code == 422


# ── who may read and write ───────────────────────────────────────────

WS = "ws_library"


def _user(user_id: str) -> User:
    return User(id=user_id, email=f"{user_id}@example.com", first_name="T", last_name="U",
                role="user", status="active",
                created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    """Every auth dependency answers as ``user`` (views routes read the optional one)."""
    from backend.app.main import app

    async def _current():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return user

    async def _optional():
        return user

    deps = (get_current_user, get_optional_user, get_permission_claims)
    prev = {dep: app.dependency_overrides.get(dep) for dep in deps}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _optional
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            if fn is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = fn


async def _team_view(db_session) -> str:
    db_session.add(WorkspaceORM(id=WS, name="Library"))
    db_session.add(ViewORM(id="view_team", name="team", workspace_id=WS,
                           visibility="workspace", created_by="usr_owner"))
    await db_session.commit()
    return "view_team"


async def test_a_reader_sees_the_library_but_cannot_change_it(test_client: AsyncClient, db_session):
    view_id = await _team_view(db_session)
    reader = PermissionClaims(sid="s_reader", ws_perms={WS: ("workspace:view:read",)})
    with _as(_user("usr_reader"), reader):
        library = await _library(test_client, view_id)
        assert library["canEdit"] is False
        put = await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1",
                                    json=_rule("r1", "PII"))
        assert put.status_code == 403
        query = await test_client.put(f"/api/v1/views/{view_id}/library/queries/q1",
                                      json=_query("Tables"))
        assert query.status_code == 403
        changes = f"/api/v1/views/{view_id}/library/reusable-changes"
        assert (await test_client.put(f"{changes}/b1", json=_change("Own them"))).status_code == 403
        assert (await test_client.delete(f"{changes}/b1")).status_code == 403
        assert (await test_client.put(changes, json={"ids": ["b1"]})).status_code == 403
        assert (await test_client.get(f"{changes}/from-other-views")).status_code == 200
        assert (await test_client.get(f"/api/v1/views/{view_id}/library/export")).status_code == 200
        imported = await test_client.post(f"/api/v1/views/{view_id}/library/import",
                                          json={"format": "synodic.view-library", "version": 1})
        assert imported.status_code == 403


async def test_a_stranger_cannot_tell_the_view_exists(test_client: AsyncClient, db_session):
    view_id = await _team_view(db_session)
    with _as(_user("usr_stranger"), PermissionClaims(sid="s_stranger")):
        assert (await test_client.get(f"/api/v1/views/{view_id}/library")).status_code == 404
        put = await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1",
                                    json=_rule("r1", "PII"))
        assert put.status_code == 404


# ── queries saved on the workspace's other views ─────────────────────

async def _views_around(db_session) -> None:
    """The team view, three more in its workspace — over its data source,
    over another, and one private to someone else — a deleted one, and a
    view in another workspace; each with a saved query."""
    from backend.app.db.models import ProviderORM, ViewSavedQueryORM, WorkspaceDataSourceORM

    db_session.add_all([
        WorkspaceORM(id=WS, name="Library"),
        WorkspaceORM(id="ws_far", name="Far away"),
        ProviderORM(id="prov_lib", name="Graph", provider_type="falkordb"),
        WorkspaceDataSourceORM(id="ds_lib", workspace_id=WS, provider_id="prov_lib", graph_name="g1"),
        WorkspaceDataSourceORM(id="ds_other", workspace_id=WS, provider_id="prov_lib", graph_name="g2"),
    ])
    views = [
        ("view_team", "team", WS, "ds_lib", "workspace", "usr_owner", None),
        ("view_zeta", "Zeta", WS, "ds_lib", "workspace", "usr_owner", None),
        ("view_alpha", "Alpha", WS, "ds_other", "workspace", "usr_owner", None),
        ("view_secret", "Secret", WS, "ds_lib", "private", "usr_owner", None),
        ("view_gone", "Gone", WS, "ds_lib", "workspace", "usr_owner", "2026-10-01T00:00:00+00:00"),
        ("view_far", "Far", "ws_far", None, "workspace", "usr_owner", None),
    ]
    for vid, name, ws, ds, visibility, owner, deleted in views:
        db_session.add(ViewORM(id=vid, name=name, workspace_id=ws, data_source_id=ds,
                               visibility=visibility, created_by=owner, deleted_at=deleted))
    await db_session.flush()
    for vid, *_ in views:
        for position, name in enumerate((f"{vid} first", f"{vid} second")):
            db_session.add(ViewSavedQueryORM(
                id=f"q_{vid}_{position}", view_id=vid, position=position, name=name,
                description="kept" if position == 0 else None,
                predicate='{"kind": "hasProperty", "key": "owner"}'))
    await db_session.commit()


async def test_queries_from_other_views_are_the_ones_the_caller_may_open(test_client: AsyncClient, db_session):
    await _views_around(db_session)
    reader = PermissionClaims(sid="s_reader", ws_perms={WS: ("workspace:view:read",)})
    with _as(_user("usr_reader"), reader):
        resp = await test_client.get("/api/v1/views/view_team/library/from-other-views")
    assert resp.status_code == 200, resp.text
    found = resp.json()
    # Over this view's data source first, then by name; each view's in its
    # own order. Not this view's own, a private view of someone else's, a
    # deleted view, or another workspace's.
    assert [(q["viewName"], q["query"]["name"]) for q in found] == [
        ("Zeta", "view_zeta first"), ("Zeta", "view_zeta second"),
        ("Alpha", "view_alpha first"), ("Alpha", "view_alpha second"),
    ]
    assert [q["sameSource"] for q in found] == [True, True, False, False]
    assert found[0]["viewId"] == "view_zeta"
    assert found[0]["query"]["description"] == "kept"
    assert found[0]["query"]["predicate"] == {"kind": "hasProperty", "key": "owner"}


async def test_the_owner_of_a_private_view_finds_its_queries_too(test_client: AsyncClient, db_session):
    await _views_around(db_session)
    owner = PermissionClaims(sid="s_owner", ws_perms={WS: ("workspace:view:read",)})
    with _as(_user("usr_owner"), owner):
        found = (await test_client.get("/api/v1/views/view_team/library/from-other-views")).json()
    assert {q["viewName"] for q in found} == {"Zeta", "Alpha", "Secret"}


async def test_a_stranger_finds_no_view_to_list_from(test_client: AsyncClient, db_session):
    await _views_around(db_session)
    with _as(_user("usr_stranger"), PermissionClaims(sid="s_stranger")):
        resp = await test_client.get("/api/v1/views/view_team/library/from-other-views")
    assert resp.status_code == 404


async def test_reusable_changes_from_other_views_are_the_ones_the_caller_may_open(test_client: AsyncClient, db_session):
    from backend.app.db.models import ViewReusableChangeORM

    await _views_around(db_session)
    change = '{"op": {"kind": "remove", "key": "tmp"}, "target": {"kind": "view", "scopeMode": "view"}}'
    for vid in ("view_team", "view_zeta", "view_alpha", "view_secret", "view_gone", "view_far"):
        db_session.add(ViewReusableChangeORM(id=f"b_{vid}", view_id=vid, position=0,
                                             name=f"{vid} change", change=change))
    await db_session.commit()
    reader = PermissionClaims(sid="s_reader", ws_perms={WS: ("workspace:view:read",)})
    with _as(_user("usr_reader"), reader):
        resp = await test_client.get("/api/v1/views/view_team/library/reusable-changes/from-other-views")
        # A reader sees the view's own, and can run them.
        assert _names((await _library(test_client, "view_team"))["reusableChanges"]) == ["view_team change"]
    assert resp.status_code == 200, resp.text
    found = resp.json()
    # Over this view's data source first, then by name. Not this view's own, a private view of
    # someone else's, a deleted view, or another workspace's.
    assert [(r["viewName"], r["change"]["name"], r["sameSource"]) for r in found] == [
        ("Zeta", "view_zeta change", True), ("Alpha", "view_alpha change", False),
    ]
    assert found[0]["viewId"] == "view_zeta"
    assert found[0]["change"]["op"] == {"kind": "remove", "key": "tmp"}
    assert found[0]["change"]["target"] == {"kind": "view", "scopeMode": "view"}
    with _as(_user("usr_stranger"), PermissionClaims(sid="s_stranger")):
        assert (await test_client.get(
            "/api/v1/views/view_team/library/reusable-changes/from-other-views")).status_code == 404
