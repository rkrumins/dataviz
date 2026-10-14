"""The Explorer's view filters: time bounds, people, and versioned / external.

Through the HTTP surface. ``test_client`` is a platform admin, so read reach
never narrows a result here (test_views_scoping_regressions.py covers that).
Rows are seeded directly so every timestamp and attribution column is exactly
what the test says. Which sources are versioned comes from the graphver store,
which this harness does not have, so the lookup is stubbed.
"""
import pytest
from httpx import AsyncClient

from backend.app.api.v1.view_filter_query import ViewFilterQuery
from backend.app.db.models import (
    ProviderORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services import view_source_kinds
from backend.app.services.versioned_sources import VersionedLookupUnavailable

_LOOKUP = "backend.app.services.versioned_sources.versioned_data_source_ids"


@pytest.fixture(autouse=True)
def versioned(monkeypatch):
    """The versioned data-source ids the stubbed lookup answers with (mutable)."""
    view_source_kinds.reset()
    ids: set = set()

    async def _fake(**_kw):
        return frozenset(ids)

    monkeypatch.setattr(_LOOKUP, _fake)
    return ids


@pytest.fixture()
def lookup_down(monkeypatch):
    async def _fail(**_kw):
        raise VersionedLookupUnavailable("graphver unreachable")

    monkeypatch.setattr(_LOOKUP, _fail)


def _view(view_id: str, ws_id: str = "ws_main", **cols) -> ViewORM:
    cols.setdefault("created_at", "2026-01-01T00:00:00+00:00")
    cols.setdefault("updated_at", cols["created_at"])
    return ViewORM(
        id=view_id, name=view_id, workspace_id=ws_id, visibility="enterprise", **cols,
    )


async def _seed(session, *rows) -> None:
    for row in rows:
        session.add(row)
    await session.commit()


async def _people(session) -> None:
    for uid, first, avatar in (
        ("usr_ann", "Ann", "fox"), ("usr_bob", "Bob", None), ("usr_cy", "Cy", None),
    ):
        session.add(UserORM(
            id=uid, email=f"{uid}@example.com", password_hash="x",
            first_name=first, last_name="Test", status="active", avatar_id=avatar,
        ))


async def _ids(client: AsyncClient, **params) -> set:
    resp = await client.get("/api/v1/views/", params={"limit": 200, **params})
    assert resp.status_code == 200, resp.text
    return {v["id"] for v in resp.json()["items"]}


# ── time bounds ───────────────────────────────────────────────────────

async def test_created_bounds(test_client: AsyncClient, db_session):
    await _seed(
        db_session, WorkspaceORM(id="ws_main", name="Main"),
        _view("v_mar1", created_at="2026-03-01T10:00:00+00:00"),
        _view("v_mar2", created_at="2026-03-02T10:00:00+00:00"),
        _view("v_mar3", created_at="2026-03-03T10:00:00+00:00"),
    )
    # A bare date is midnight UTC; after is inclusive, before exclusive.
    assert await _ids(test_client, createdAfter="2026-03-02") == {"v_mar2", "v_mar3"}
    assert await _ids(test_client, createdBefore="2026-03-02") == {"v_mar1"}
    # Each of these is 10:00 UTC on 2 March. Compared as raw strings, the
    # +02:00 one would put v_mar2 on the wrong side of the bound.
    for instant in (
        "2026-03-02T10:00:00Z",
        "2026-03-02T10:00:00.000Z",          # what the browser's toISOString() sends
        "2026-03-02T12:00:00+02:00",
        "2026-03-02T10:00:00",               # no offset: UTC
    ):
        assert await _ids(test_client, createdAfter=instant) == {"v_mar2", "v_mar3"}, instant
        assert await _ids(test_client, createdBefore=instant) == {"v_mar1"}, instant
    assert await _ids(
        test_client, createdAfter="2026-03-02", createdBefore="2026-03-03",
    ) == {"v_mar2"}


async def test_updated_bounds_use_the_later_of_edit_and_publish(
    test_client: AsyncClient, db_session,
):
    await _seed(
        db_session, WorkspaceORM(id="ws_main", name="Main"),
        _view("v_data_newer", updated_at="2026-05-01T00:00:00+00:00",
              data_updated_at="2026-06-01T00:00:00+00:00"),
        # Edited after its last publish: the edit is its last change, not the publish.
        _view("v_settings_newer", updated_at="2026-06-15T00:00:00+00:00",
              data_updated_at="2026-05-01T00:00:00+00:00"),
        _view("v_never_published", updated_at="2026-05-10T00:00:00+00:00"),
    )
    assert await _ids(test_client, updatedAfter="2026-05-20") == {
        "v_data_newer", "v_settings_newer",
    }
    assert await _ids(test_client, updatedBefore="2026-05-20") == {"v_never_published"}
    assert await _ids(test_client, updatedAfter="2026-06-10") == {"v_settings_newer"}
    assert await _ids(test_client, updatedBefore="2026-06-10") == {
        "v_data_newer", "v_never_published",
    }


@pytest.mark.parametrize("path", ["/api/v1/views/", "/api/v1/views/stats"])
@pytest.mark.parametrize("params, name", [
    ({"createdAfter": "last tuesday"}, "createdAfter"),
    ({"createdBefore": "2026-13-01"}, "createdBefore"),
    ({"updatedAfter": "2026-02-30"}, "updatedAfter"),
    # A real date-time, but past the year 9999 once moved to UTC.
    ({"updatedBefore": "9999-12-31T23:00:00-05:00"}, "updatedBefore"),
    ({"sourceKind": "hybrid"}, "sourceKind"),
    ({"contributorIn": "usr_ann", "contributorRole": "viewed"}, "contributorRole"),
    ({"contributorIn": [f"usr_{i}" for i in range(51)]}, "contributorIn"),
])
async def test_bad_filter_values_are_422(test_client: AsyncClient, path, params, name):
    resp = await test_client.get(path, params=params)
    assert resp.status_code == 422, resp.text
    assert name in resp.json()["detail"]


async def test_fifty_contributors_is_fine(test_client: AsyncClient):
    resp = await test_client.get(
        "/api/v1/views/", params={"contributorIn": [f"usr_{i}" for i in range(50)]},
    )
    assert resp.status_code == 200


# ── people ────────────────────────────────────────────────────────────

async def test_contributor_roles(test_client: AsyncClient, db_session):
    await _seed(
        db_session, WorkspaceORM(id="ws_main", name="Main"),
        _view("v_created", created_by="usr_ann"),
        _view("v_edited", created_by="usr_cy", updated_by="usr_ann"),
        _view("v_published", created_by="usr_cy", data_updated_by="usr_ann"),
        _view("v_created_and_edited", created_by="usr_ann", updated_by="usr_ann"),
        _view("v_bobs", created_by="usr_bob"),
    )
    # Default: created OR last edited. Published is opt-in — a publish stamps
    # every view of its source, opened or not.
    assert await _ids(test_client, contributorIn="usr_ann") == {
        "v_created", "v_edited", "v_created_and_edited",
    }
    assert await _ids(test_client, contributorIn="usr_ann", contributorRole="created") == {
        "v_created", "v_created_and_edited",
    }
    assert await _ids(test_client, contributorIn="usr_ann", contributorRole="edited") == {
        "v_edited", "v_created_and_edited",
    }
    assert await _ids(test_client, contributorIn="usr_ann", contributorRole="published") == {
        "v_published",
    }
    assert await _ids(test_client, contributorIn=["usr_ann", "usr_bob"]) == {
        "v_created", "v_edited", "v_created_and_edited", "v_bobs",
    }
    # ANDed with createdBy (My Views): what Cy made that Ann worked on.
    assert await _ids(test_client, contributorIn="usr_ann", createdBy="usr_cy") == {
        "v_edited",
    }
    # The creator multi-filter is untouched.
    assert await _ids(test_client, createdByIn=["usr_bob", "usr_cy"]) == {
        "v_edited", "v_published", "v_bobs",
    }


async def test_contributors_facet(test_client: AsyncClient, db_session):
    await _people(db_session)
    await _seed(
        db_session, WorkspaceORM(id="ws_main", name="Main"),
        # Ann created AND last edited it — one view, counted once; Bob published its data.
        _view("v1", created_by="usr_ann", updated_by="usr_ann", data_updated_by="usr_bob"),
        _view("v2", created_by="usr_ann", updated_by="usr_cy"),
        # The legacy sentinel is nobody.
        _view("v3", created_by="anonymous", data_updated_by="usr_bob"),
        # A user record that no longer exists is shown by id.
        _view("v4", created_by="usr_gone"),
        # A deleted view counts for nobody.
        _view("v5", created_by="usr_cy", deleted_at="2026-02-01T00:00:00+00:00"),
    )
    resp = await test_client.get("/api/v1/views/facets")
    assert resp.status_code == 200
    contributors = resp.json()["contributors"]
    # count desc, then publishedCount desc, then name.
    assert [c["userId"] for c in contributors] == [
        "usr_ann", "usr_cy", "usr_gone", "usr_bob",
    ]
    by_id = {c["userId"]: c for c in contributors}
    assert by_id["usr_ann"] == {
        "userId": "usr_ann", "displayName": "Ann Test", "email": "usr_ann@example.com",
        "avatarId": "fox", "count": 2, "createdCount": 2, "editedCount": 1,
        "publishedCount": 0,
    }
    assert by_id["usr_cy"] == {
        "userId": "usr_cy", "displayName": "Cy Test", "email": "usr_cy@example.com",
        "avatarId": None, "count": 1, "createdCount": 0, "editedCount": 1,
        "publishedCount": 0,
    }
    assert by_id["usr_gone"] == {
        "userId": "usr_gone", "displayName": "usr_gone", "email": None,
        "avatarId": None, "count": 1, "createdCount": 1, "editedCount": 0,
        "publishedCount": 0,
    }
    # Only ever published: listed, with nothing counted against the default filter.
    assert by_id["usr_bob"]["count"] == 0
    assert by_id["usr_bob"]["publishedCount"] == 2
    # ``count`` is exactly what the default contributor filter returns.
    for person in contributors:
        listed = await test_client.get(
            "/api/v1/views/", params={"contributorIn": person["userId"]},
        )
        assert listed.json()["total"] == person["count"], person["userId"]


# ── versioned / external ──────────────────────────────────────────────

# ws_explicit: default ds_v (versioned), but its views name their own source.
# ws_primary:  primary ds_prim (versioned); an OLDER non-primary ds_old.
# ws_fallback: no primary — the earliest, ds_first (external), not ds_second.
# ws_empty:    no data sources at all.
_SOURCES = (
    ("ds_v", "ws_explicit", "2026-01-01", True),
    ("ds_x", "ws_explicit", "2026-01-02", False),
    ("ds_old", "ws_primary", "2026-01-01", False),
    ("ds_prim", "ws_primary", "2026-01-05", True),
    ("ds_first", "ws_fallback", "2026-01-01", False),
    ("ds_second", "ws_fallback", "2026-01-05", False),
)
_VERSIONED = {"ds_v", "ds_prim", "ds_second"}
EXPECTED_KINDS = {
    "v_versioned_ds": "versioned",
    "v_external_ds": "external",
    "v_primary_default": "versioned",
    "v_fallback_default": "external",
    "v_no_source": None,
}


async def _sources_world(session) -> None:
    await _people(session)
    session.add(ProviderORM(id="prov_1", name="P", provider_type="falkordb"))
    for ws_id in ("ws_explicit", "ws_primary", "ws_fallback", "ws_empty"):
        session.add(WorkspaceORM(id=ws_id, name=ws_id))
    for ds_id, ws_id, created, primary in _SOURCES:
        session.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id=ws_id, provider_id="prov_1", graph_name=ds_id,
            label=ds_id, is_primary=primary, is_active=True,
            created_at=f"{created}T00:00:00+00:00",
        ))
    # Times and people vary too, so the stats test below has something to narrow.
    await _seed(
        session,
        _view("v_versioned_ds", "ws_explicit", data_source_id="ds_v",
              created_at="2026-03-01T00:00:00+00:00", updated_at="2026-05-01T00:00:00+00:00",
              data_updated_at="2026-06-01T00:00:00+00:00", created_by="usr_ann"),
        _view("v_external_ds", "ws_explicit", data_source_id="ds_x",
              created_at="2026-03-02T00:00:00+00:00", updated_at="2026-06-15T00:00:00+00:00",
              data_updated_at="2026-05-01T00:00:00+00:00", created_by="usr_cy",
              updated_by="usr_ann"),
        _view("v_primary_default", "ws_primary",
              created_at="2026-03-03T00:00:00+00:00", updated_at="2026-05-10T00:00:00+00:00",
              created_by="usr_cy", data_updated_by="usr_ann"),
        _view("v_fallback_default", "ws_fallback",
              created_at="2026-03-04T00:00:00+00:00", created_by="usr_bob"),
        _view("v_no_source", "ws_empty",
              created_at="2026-03-05T00:00:00+00:00", created_by="usr_ann"),
    )


async def test_source_kind_filter_and_annotation(test_client: AsyncClient, db_session, versioned):
    await _sources_world(db_session)
    versioned.update(_VERSIONED)
    resp = await test_client.get("/api/v1/views/", params={"limit": 200})
    assert {v["id"]: v["sourceKind"] for v in resp.json()["items"]} == EXPECTED_KINDS
    assert await _ids(test_client, sourceKind="versioned") == {
        "v_versioned_ds", "v_primary_default",
    }
    # A view that reads no data (no source, no workspace default) is in neither.
    assert await _ids(test_client, sourceKind="external") == {
        "v_external_ds", "v_fallback_default",
    }


async def test_nothing_versioned(test_client: AsyncClient, db_session):
    """An empty versioned set: IN () matches nothing, NOT IN () everything."""
    await _sources_world(db_session)
    assert await _ids(test_client, sourceKind="versioned") == set()
    assert await _ids(test_client, sourceKind="external") == {
        "v_versioned_ds", "v_external_ds", "v_primary_default", "v_fallback_default",
    }


async def test_single_view_and_popular_carry_source_kind(
    test_client: AsyncClient, db_session, versioned,
):
    await _sources_world(db_session)
    versioned.update(_VERSIONED)
    for view_id, kind in EXPECTED_KINDS.items():
        resp = await test_client.get(f"/api/v1/views/{view_id}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["sourceKind"] == kind, view_id
        fav = await test_client.post(f"/api/v1/views/{view_id}/favourite")
        assert fav.status_code == 201
    # The single read names the workspace default it resolved — the source it classified.
    single = await test_client.get("/api/v1/views/v_primary_default")
    assert single.json()["dataSourceId"] == "ds_prim"

    popular = await test_client.get("/api/v1/views/popular")
    assert {v["id"]: v["sourceKind"] for v in popular.json()} == EXPECTED_KINDS
    embedded = await test_client.get("/api/v1/views/", params={"include": "popular"})
    assert {v["id"]: v["sourceKind"] for v in embedded.json()["popular"]} == EXPECTED_KINDS


async def test_a_failed_lookup_never_fails_a_read(
    test_client: AsyncClient, db_session, lookup_down,
):
    await _sources_world(db_session)
    await test_client.post("/api/v1/views/v_versioned_ds/favourite")

    listed = await test_client.get("/api/v1/views/", params={"include": "popular"})
    assert listed.status_code == 200
    body = listed.json()
    assert body["total"] == len(EXPECTED_KINDS)
    assert {v["sourceKind"] for v in body["items"] + body["popular"]} == {None}
    single = await test_client.get("/api/v1/views/v_versioned_ds")
    assert single.status_code == 200 and single.json()["sourceKind"] is None
    popular = await test_client.get("/api/v1/views/popular")
    assert popular.status_code == 200
    assert [v["sourceKind"] for v in popular.json()] == [None]
    assert (await test_client.get("/api/v1/views/stats")).status_code == 200


@pytest.mark.parametrize("path", ["/api/v1/views/", "/api/v1/views/stats"])
async def test_filtering_by_kind_while_the_lookup_is_down_is_503(
    test_client: AsyncClient, db_session, lookup_down, path,
):
    await _sources_world(db_session)
    resp = await test_client.get(path, params={"sourceKind": "versioned"})
    assert resp.status_code == 503
    assert resp.json()["detail"] == (
        "We can't tell which data sources are versioned right now, so the "
        "Versioned/External filter can't be applied. Try again in a minute, "
        "or remove that filter."
    )


# ── stats describe the list ───────────────────────────────────────────

@pytest.mark.parametrize("params", [
    {"createdAfter": "2026-03-02"},
    {"createdBefore": "2026-03-02T12:00:00+02:00"},
    {"updatedAfter": "2026-05-20"},
    {"updatedBefore": "2026-05-20"},
    {"contributorIn": "usr_ann"},
    {"contributorIn": "usr_ann", "contributorRole": "published"},
    {"sourceKind": "versioned"},
    {"sourceKind": "external"},
])
async def test_stats_total_matches_list_total(
    test_client: AsyncClient, db_session, versioned, params,
):
    await _sources_world(db_session)
    versioned.update(_VERSIONED)
    listed = await test_client.get("/api/v1/views/", params=params)
    stats = await test_client.get("/api/v1/views/stats", params=params)
    assert listed.status_code == 200 and stats.status_code == 200
    total = listed.json()["total"]
    assert 0 < total < len(EXPECTED_KINDS), "the filter should narrow, not empty, the set"
    assert stats.json()["total"] == total


# ── the shared filter object ──────────────────────────────────────────

def test_cache_key_ignores_the_order_values_were_sent_in():
    a = ViewFilterQuery(tags=["b", "a"], contributor_in=["u2", "u1"], source_kind="external")
    b = ViewFilterQuery(tags=["a", "b"], contributor_in=["u1", "u2"], source_kind="external")
    assert hash(a.cache_key()) == hash(b.cache_key())
    assert a.cache_key() == b.cache_key()
    assert a.cache_key() != ViewFilterQuery(tags=["a", "b"]).cache_key()


def test_repo_kwargs_leave_category_to_the_endpoint():
    kwargs = ViewFilterQuery(category="shared-with-me", created_before="x").repo_kwargs()
    assert "category" not in kwargs
    assert kwargs["created_before"] == "x"
