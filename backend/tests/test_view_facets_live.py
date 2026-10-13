"""Live facet counts (``GET /views/facets`` with the list's filters) and ``GET /views/count``.

The rule every facet keeps: an option's count is the list's ``total`` were that
option chosen instead of the facet's current selection — each facet is counted
under every active filter except its own. ``test_facet_counts_are_list_totals``
checks exactly that, for every option of every facet, across filter mixes; the
rest pin the pieces around it. The versioned-source lookup (graphver, absent
here) is stubbed.
"""
import json
from contextlib import contextmanager

import pytest
from httpx import AsyncClient
from sqlalchemy import event

from backend.app.common.single_flight import SingleFlight
from backend.app.db.models import (
    ProviderORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import view_repo
from backend.app.services import view_source_kinds
from backend.app.services.versioned_sources import VersionedLookupUnavailable

_LOOKUP = "backend.app.services.versioned_sources.versioned_data_source_ids"
_FACETS = "/api/v1/views/facets"


@pytest.fixture(autouse=True)
def versioned(monkeypatch):
    """The versioned data-source ids the stubbed lookup answers with (mutable)."""
    view_source_kinds.reset()
    ids: set = {"ds_v"}

    async def _fake(**_kw):
        return frozenset(ids)

    monkeypatch.setattr(_LOOKUP, _fake)
    return ids


@pytest.fixture()
def lookup_down(monkeypatch):
    async def _fail(**_kw):
        raise VersionedLookupUnavailable("graphver unreachable")

    monkeypatch.setattr(_LOOKUP, _fail)


def _view(view_id, ws_id, **cols) -> ViewORM:
    return ViewORM(
        id=view_id, name=view_id, workspace_id=ws_id,
        created_at="2026-03-01T00:00:00+00:00", updated_at="2026-03-01T00:00:00+00:00",
        **cols,
    )


async def _world(session) -> None:
    """Three workspaces, three sources (ds_v versioned), three people, six live
    views and one deleted one that must never count.

        view  ws    source        type       visibility  tags            created  edited  published
        v1    ws_a  ds_v          graph      enterprise  finance, pii    ann      ann
        v2    ws_a  ds_x          table      workspace   finance         bob      ann
        v3    ws_a  (ds_v dflt)   graph      private     eng             cy               bob
        v4    ws_b  ds_b          hierarchy  enterprise  finance, eng    ann
        v5    ws_b  (ds_b dflt)   graph      workspace   -               bob      cy
        v6    ws_c  (no source)   table      enterprise  pii             anonymous
    """
    for uid, first, avatar in (
        ("usr_ann", "Ann", "fox"), ("usr_bob", "Bob", None), ("usr_cy", "Cy", None),
    ):
        session.add(UserORM(
            id=uid, email=f"{uid}@example.com", password_hash="x",
            first_name=first, last_name="Test", status="active", avatar_id=avatar,
        ))
    session.add(ProviderORM(id="prov_1", name="P", provider_type="falkordb"))
    for ws_id, name in (("ws_a", "Alpha"), ("ws_b", "Beta"), ("ws_c", "Gamma")):
        session.add(WorkspaceORM(id=ws_id, name=name))
    for ds_id, ws_id, label, primary in (
        ("ds_v", "ws_a", "Vee", True), ("ds_x", "ws_a", "Ex", False),
        ("ds_b", "ws_b", "Bee", True),
    ):
        session.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id=ws_id, provider_id="prov_1", graph_name=ds_id,
            label=label, is_primary=primary, is_active=True,
        ))
    for row in (
        _view("v1", "ws_a", data_source_id="ds_v", view_type="graph", visibility="enterprise",
              tags='["finance", "pii"]', created_by="usr_ann", updated_by="usr_ann"),
        _view("v2", "ws_a", data_source_id="ds_x", view_type="table", visibility="workspace",
              tags='["finance"]', created_by="usr_bob", updated_by="usr_ann"),
        _view("v3", "ws_a", view_type="graph", visibility="private", tags='["eng"]',
              created_by="usr_cy", data_updated_by="usr_bob"),
        _view("v4", "ws_b", data_source_id="ds_b", view_type="hierarchy",
              visibility="enterprise", tags='["finance", "eng"]', created_by="usr_ann"),
        _view("v5", "ws_b", view_type="graph", visibility="workspace",
              created_by="usr_bob", updated_by="usr_cy"),
        _view("v6", "ws_c", view_type="table", visibility="enterprise", tags='["pii"]',
              created_by="anonymous"),
        _view("v_deleted", "ws_a", data_source_id="ds_v", view_type="graph",
              visibility="enterprise", tags='["ghost"]', created_by="usr_cy",
              deleted_at="2026-04-01T00:00:00+00:00"),
    ):
        session.add(row)
    await session.commit()


async def _facets(client: AsyncClient, **params) -> dict:
    resp = await client.get(_FACETS, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _total(client: AsyncClient, params: dict) -> int:
    resp = await client.get("/api/v1/views/", params={**params, "limit": 1})
    assert resp.status_code == 200, resp.text
    return resp.json()["total"]


def _counts(rows, key="value"):
    return {r[key]: r["count"] for r in rows}


# Choosing one option of a facet: the param it sends, the option's field that
# goes in it, and the params that facet leaves out.
_PEOPLE_OWN = ("contributorIn", "contributorRole", "createdByIn")
_CHOICE = {
    "tags": ("tags", "value", ("tags",)),
    "viewTypes": ("viewTypes", "value", ("viewType", "viewTypes")),
    "visibilities": ("visibilityIn", "value", ("visibility", "visibilityIn")),
    "workspaces": ("workspaceIds", "id", ("workspaceId", "workspaceIds")),
    "dataSources": ("dataSourceId", "id", ("dataSourceId",)),
    "creators": ("createdByIn", "userId", _PEOPLE_OWN),
    "contributors": ("contributorIn", "userId", _PEOPLE_OWN),
}
_ROLE_COUNTS = (
    ("createdCount", "created"), ("editedCount", "edited"), ("publishedCount", "published"),
)


async def _assert_counts_are_list_totals(client: AsyncClient, params: dict) -> dict:
    """Every option's count is the list's total were it chosen instead; every
    option the facet leaves out (of the unfiltered universe) would leave none."""
    universe = await _facets(client)
    facets = await _facets(client, **params)
    for facet, (param, key, own) in _CHOICE.items():
        others = {k: v for k, v in params.items() if k not in own}
        for option in facets[facet]:
            choice = {**others, param: option[key]}
            assert option["count"] == await _total(client, choice), (params, facet, option)
            if facet == "contributors":
                for field, role in _ROLE_COUNTS:
                    assert option[field] == await _total(
                        client, {**choice, "contributorRole": role},
                    ), (params, option, field)
        # Under createdBy the list lets createdByIn win, so an absent creator
        # would still list views there; every other facet must not be over-filtered.
        if facet == "creators" and "createdBy" in params:
            continue
        listed = {o[key] for o in facets[facet]}
        for option in universe[facet]:
            if option[key] not in listed:
                assert await _total(client, {**others, param: option[key]}) == 0, (
                    params, facet, option,
                )
    others = {k: v for k, v in params.items() if k != "sourceKind"}
    for kind in ("versioned", "external"):
        assert facets["sourceKinds"][kind] == await _total(
            client, {**others, "sourceKind": kind},
        ), (params, kind)
    return facets


@pytest.mark.parametrize("params", [
    {},
    {"tags": "finance"},
    {"viewTypes": "graph", "workspaceIds": "ws_a"},
    {"contributorIn": "usr_ann", "visibilityIn": "enterprise"},
    {"sourceKind": "versioned", "search": "v"},
    {"dataSourceId": "ds_x", "contributorIn": "usr_ann", "contributorRole": "edited"},
    # My Views: createdBy is a scope the people facets keep.
    {"createdBy": "usr_bob", "createdAfter": "2026-01-01"},
])
async def test_facet_counts_are_list_totals(test_client: AsyncClient, db_session, params):
    await _world(db_session)
    await _assert_counts_are_list_totals(test_client, params)


async def test_a_members_counts_are_their_own_list_totals(test_client: AsyncClient, db_session):
    """For someone who reads only part of the catalog, the counts are still the
    totals of their own list, and the rest is nowhere in them."""
    from backend.app.services.permission_service import PermissionClaims
    from backend.tests.test_views_scoping_regressions import _auth, _user

    await _world(db_session)
    member = _user("usr_member")
    claims = PermissionClaims(sid="s_member", ws_perms={"ws_a": ("workspace:view:read",)})
    with _auth(user=member, claims=claims):
        for params in ({}, {"tags": "finance"}, {"workspaceIds": "ws_b"}):
            body = await _assert_counts_are_list_totals(test_client, params)
            # Not v3 (cy's private view) nor v5 (ws_b's workspace tier): Cy made or
            # edited nothing this member reads, and Bob published nothing they read.
            assert "usr_cy" not in {c["userId"] for c in body["contributors"]}
            assert all(c["publishedCount"] == 0 for c in body["contributors"])
            assert "private" not in {v["value"] for v in body["visibilities"]}
        body = await _facets(test_client)
    assert _counts(body["workspaces"], "id") == {"ws_a": 2, "ws_b": 1, "ws_c": 1}


async def test_choosing_a_tag_leaves_tag_counts_and_narrows_the_rest(
    test_client: AsyncClient, db_session,
):
    await _world(db_session)
    everything = await _facets(test_client)
    finance = await _facets(test_client, tags="finance")      # v1, v2, v4

    assert finance["tags"] == everything["tags"]
    assert _counts(everything["viewTypes"]) == {"graph": 3, "table": 2, "hierarchy": 1}
    assert _counts(finance["viewTypes"]) == {"graph": 1, "table": 1, "hierarchy": 1}
    assert _counts(finance["visibilities"]) == {"enterprise": 2, "workspace": 1}
    assert _counts(finance["workspaces"], "id") == {"ws_a": 2, "ws_b": 1}
    assert _counts(finance["dataSources"], "id") == {"ds_v": 1, "ds_x": 1, "ds_b": 1}
    assert _counts(finance["creators"], "userId") == {"usr_ann": 2, "usr_bob": 1}
    assert _counts(finance["contributors"], "userId") == {"usr_ann": 3, "usr_bob": 1}
    assert finance["sourceKinds"] == {"versioned": 1, "external": 2}
    assert everything["sourceKinds"] == {"versioned": 2, "external": 3}


async def test_no_params_keeps_the_original_facets(test_client: AsyncClient, db_session):
    """Called as before, tags / viewTypes / creators answer as before (ties in
    name order now, rather than the database's)."""
    await _world(db_session)
    body = await _facets(test_client)
    assert body["tags"] == [
        {"value": "finance", "count": 3}, {"value": "eng", "count": 2},
        {"value": "pii", "count": 2},
    ]
    assert body["viewTypes"] == [
        {"value": "graph", "count": 3}, {"value": "table", "count": 2},
        {"value": "hierarchy", "count": 1},
    ]
    assert body["creators"] == [
        {"userId": "usr_ann", "displayName": "Ann Test", "email": "usr_ann@example.com", "count": 2},
        {"userId": "usr_bob", "displayName": "Bob Test", "email": "usr_bob@example.com", "count": 2},
        # The legacy sentinel is still a creator here, shown by id, as it always was.
        {"userId": "anonymous", "displayName": "anonymous", "email": None, "count": 1},
        {"userId": "usr_cy", "displayName": "Cy Test", "email": "usr_cy@example.com", "count": 1},
    ]


async def test_creating_and_editing_one_view_counts_it_once(
    test_client: AsyncClient, db_session,
):
    await _world(db_session)
    ann = next(c for c in (await _facets(test_client))["contributors"] if c["userId"] == "usr_ann")
    # v1 created and last edited by Ann, v2 edited, v4 created: three views, not four.
    assert ann == {
        "userId": "usr_ann", "displayName": "Ann Test", "email": "usr_ann@example.com",
        "avatarId": "fox", "count": 3, "createdCount": 2, "editedCount": 2,
        "publishedCount": 0,
    }


async def test_names_kinds_and_shapes(test_client: AsyncClient, db_session):
    await _world(db_session)
    body = await _facets(test_client)
    assert body["workspaces"] == [
        {"id": "ws_a", "name": "Alpha", "count": 3},
        {"id": "ws_b", "name": "Beta", "count": 2},
        {"id": "ws_c", "name": "Gamma", "count": 1},
    ]
    # Only views that name their source; ties by name.
    assert body["dataSources"] == [
        {"id": "ds_b", "name": "Bee", "workspaceId": "ws_b", "workspaceName": "Beta",
         "kind": "external", "count": 1},
        {"id": "ds_x", "name": "Ex", "workspaceId": "ws_a", "workspaceName": "Alpha",
         "kind": "external", "count": 1},
        {"id": "ds_v", "name": "Vee", "workspaceId": "ws_a", "workspaceName": "Alpha",
         "kind": "versioned", "count": 1},
    ]
    assert body["visibilities"] == [
        {"value": "enterprise", "count": 3}, {"value": "workspace", "count": 2},
        {"value": "private", "count": 1},
    ]


async def test_fields_choose_the_facets(test_client: AsyncClient, db_session):
    await _world(db_session)
    body = await _facets(test_client, fields=["tags", "workspaces"])
    assert [t["value"] for t in body["tags"]] == ["finance", "eng", "pii"]
    assert [w["id"] for w in body["workspaces"]] == ["ws_a", "ws_b", "ws_c"]
    for empty in ("viewTypes", "creators", "contributors", "dataSources", "visibilities"):
        assert body[empty] == [], empty
    assert body["sourceKinds"] is None
    only_kinds = await _facets(test_client, fields="sourceKinds")
    assert only_kinds["sourceKinds"] == {"versioned": 2, "external": 3}
    assert only_kinds["tags"] == []

    resp = await test_client.get(_FACETS, params={"fields": ["tags", "colours"]})
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str) and "fields" in resp.json()["detail"]


async def test_source_kind_counts_follow_the_versioned_set(
    test_client: AsyncClient, db_session, versioned,
):
    await _world(db_session)
    # ds_v: v1, and v3 through ws_a's default. External: v2, v4, and v5 through
    # ws_b's default. v6 reads no data and is neither.
    assert (await _facets(test_client))["sourceKinds"] == {"versioned": 2, "external": 3}
    versioned.add("ds_b")
    body = await _facets(test_client)
    assert body["sourceKinds"] == {"versioned": 4, "external": 1}
    assert {d["id"]: d["kind"] for d in body["dataSources"]} == {
        "ds_v": "versioned", "ds_b": "versioned", "ds_x": "external",
    }


async def test_an_unknown_versioned_set_reads_as_unknown(
    test_client: AsyncClient, db_session, lookup_down,
):
    await _world(db_session)
    body = await _facets(test_client)
    assert body["sourceKinds"] is None
    assert {d["kind"] for d in body["dataSources"]} == {None}
    assert _counts(body["dataSources"], "id") == {"ds_v": 1, "ds_x": 1, "ds_b": 1}
    # Filtering by kind needs the set for every other facet: 503, as for the list...
    resp = await test_client.get(_FACETS, params={"sourceKind": "versioned"})
    assert resp.status_code == 503
    assert resp.json()["detail"].startswith("We can't tell which data sources are versioned")
    # ...but the sourceKinds facet leaves that filter out, so alone it is just unknown.
    alone = await _facets(test_client, sourceKind="versioned", fields="sourceKinds")
    assert alone["sourceKinds"] is None


async def test_capped_menus_keep_what_is_selected(test_client: AsyncClient, db_session):
    db_session.add(WorkspaceORM(id="ws_big", name="Big"))
    db_session.add(_view("v_tags", "ws_big", tags=json.dumps([f"tag_{i:03d}" for i in range(510)])))
    for i in range(505):
        db_session.add(_view(f"v_p{i:03d}", "ws_big", created_by=f"usr_p{i:03d}"))
    await db_session.commit()

    body = await _facets(test_client, fields=["tags", "contributors"])
    assert len(body["tags"]) == 500 and body["tags"][-1]["value"] == "tag_499"
    assert len(body["contributors"]) == 500
    assert body["contributors"][-1]["userId"] == "usr_p499"

    # Selected values past the cap — and one matching nothing — stay listed.
    tags = (await _facets(test_client, fields="tags", tags=["tag_509", "no_such_tag"]))["tags"]
    assert [(t["value"], t["count"]) for t in tags[500:]] == [("tag_509", 1), ("no_such_tag", 0)]
    people = (await _facets(
        test_client, fields="contributors", contributorIn=["usr_p504", "usr_nobody"],
    ))["contributors"]
    assert [(c["userId"], c["count"]) for c in people[500:]] == [("usr_p504", 1), ("usr_nobody", 0)]


@contextmanager
def _statements(session):
    """SQL statements the session's engine runs (transaction control excluded)."""
    seen = []
    engine = session.bind.sync_engine

    def _on_exec(conn, cursor, statement, params, context, executemany):
        if not statement.strip().upper().startswith(
            ("SAVEPOINT", "RELEASE SAVEPOINT", "ROLLBACK", "BEGIN", "COMMIT"),
        ):
            seen.append(statement)

    event.listen(engine, "before_cursor_execute", _on_exec)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", _on_exec)


async def test_a_full_facets_call_is_nine_statements_at_most(db_session):
    """One per facet, one user lookup, one name lookup — however many views,
    people, workspaces and sources there are."""
    await _world(db_session)
    for i in range(40):
        db_session.add(WorkspaceORM(id=f"ws_{i}", name=f"W{i}"))
        db_session.add(WorkspaceDataSourceORM(
            id=f"ds_{i}", workspace_id=f"ws_{i}", provider_id="prov_1",
            graph_name=f"g{i}", label=f"S{i}", is_active=True,
        ))
        db_session.add(_view(
            f"v_{i}", f"ws_{i}", data_source_id=f"ds_{i}", tags=f'["t{i}"]',
            created_by=f"usr_{i}", updated_by=f"usr_e{i}", data_updated_by=f"usr_d{i}",
        ))
    await db_session.commit()
    sets = await view_source_kinds.load_sets(db_session, required=True)

    with _statements(db_session) as seen:
        body = await view_repo.get_view_facets(db_session, source_kind_sets=sets)

    assert len(seen) <= 9, "\n\n".join(seen)
    assert len(body.workspaces) == 43 and len(body.data_sources) == 43
    assert len(body.contributors) == 3 + 120 and body.source_kinds is not None


async def test_different_filters_never_share_a_flight(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """Concurrent facets requests share one computation when their keys match,
    so the key has to carry everything the answer depends on."""
    class _Recording(SingleFlight):
        def __init__(self):
            super().__init__(ttl_seconds=15.0)
            self.keys = []

        async def run(self, key, fn):
            self.keys.append(key)
            return await super().run(key, fn)

    flight = _Recording()
    monkeypatch.setattr("backend.app.api.v1.endpoints.views.read_views_sf", flight)
    await _world(db_session)

    async def key(**params):
        await _facets(test_client, **params)
        return flight.keys[-1]

    assert await key(tags="finance") != await key(tags="eng")
    assert await key(sourceKind="versioned") != await key(sourceKind="external")
    assert await key(category="shared-with-me") != await key()
    assert await key(fields="tags") != await key(fields="viewTypes")
    # The same filters in another order or spelling are the same question.
    assert await key(tags=["finance", "eng"]) == await key(tags=["eng", "finance"])
    assert await key(createdAfter="2026-01-01") == await key(createdAfter="2026-01-01T00:00:00Z")
    assert await key() == await key(fields=list(view_repo.FACET_FIELDS))


# ── /views/count ──────────────────────────────────────────────────────

async def test_count_is_not_taken_for_a_view_id(test_client: AsyncClient, db_session):
    await _world(db_session)
    resp = await test_client.get("/api/v1/views/count")
    assert resp.status_code == 200
    assert resp.json() == {"total": 6}


@pytest.mark.parametrize("params", [
    {},
    {"category": "my-views", "createdBy": "usr_ann"},
    {"category": "shared-with-me"},
    {"tags": ["finance", "pii"], "visibilityIn": "enterprise"},
    {"contributorIn": "usr_ann", "contributorRole": "edited"},
    {"sourceKind": "external", "workspaceIds": ["ws_a", "ws_b"]},
    {"updatedAfter": "2026-02-01", "search": "v", "includeDeleted": "true"},
])
async def test_count_is_the_list_total(test_client: AsyncClient, db_session, params):
    await _world(db_session)
    resp = await test_client.get("/api/v1/views/count", params=params)
    assert resp.status_code == 200
    assert resp.json()["total"] == await _total(test_client, params)


async def test_count_shares_the_lists_rules(
    test_client: AsyncClient, db_session, lookup_down,
):
    await _world(db_session)
    assert (await test_client.get(
        "/api/v1/views/count", params={"sourceKind": "versioned"},
    )).status_code == 503
    assert (await test_client.get(
        "/api/v1/views/count", params={"createdAfter": "soon"},
    )).status_code == 422
