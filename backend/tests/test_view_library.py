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
        ("or", {"kind": "group", "op": "or", "children": [
            {"kind": "descendantOf", "urns": ["urn:a"]},
            {"kind": "tag", "values": ["PII"]}]}, "top-level AND"),
    ]:
        resp = await test_client.put(f"{base}/{rule_id}", json=_rule(rule_id, rule_id, predicate=predicate))
        assert resp.status_code == 422, rule_id
        assert why in resp.json()["detail"], resp.json()["detail"]
    lineage = await test_client.put(f"{base}/root", json=_rule("root", "Roots", predicate={
        "kind": "isRoot", "edgeClass": "lineage"}))
    assert lineage.status_code == 200, lineage.text
    assert [r["id"] for r in (await _library(test_client, view_id))["displayRules"]] == ["root"]


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


async def test_a_drafts_rules_stay_on_the_draft(test_client: AsyncClient):
    view_id = await _view(test_client)
    base = f"/api/v1/views/{view_id}/library/rules"
    await test_client.put(f"{base}/r1", json=_rule("r1", "Published"))
    resp = await test_client.put(f"{base}/r2?branchId=br_draft", json=_rule("r2", "Draft"))
    assert resp.status_code == 200
    # The draft forked the published rules, then added its own.
    assert _names((await _library(test_client, view_id, "br_draft"))["displayRules"]) == [
        "Published", "Draft"]
    assert _names((await _library(test_client, view_id))["displayRules"]) == ["Published"]


async def test_promote_keeps_rules_added_on_both_sides(test_client: AsyncClient, db_session):
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


async def test_saved_queries_belong_to_the_view_on_every_branch(test_client: AsyncClient):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}/library/queries/q1", json=_query("Tables"))
    assert _names((await _library(test_client, view_id, "br_any"))["savedQueries"]) == ["Tables"]


async def test_a_query_id_another_view_holds_is_refused(test_client: AsyncClient):
    one, two = await _view(test_client, "One"), await _view(test_client, "Two")
    await test_client.put(f"/api/v1/views/{one}/library/queries/q1", json=_query("Tables"))
    resp = await test_client.put(f"/api/v1/views/{two}/library/queries/q1", json=_query("Tables"))
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
