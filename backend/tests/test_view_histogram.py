"""``GET /views/histogram``: how many views were created or changed per UTC bucket.

The client (frontend/src/features/view-filters/foldHistogram.ts) folds these
buckets into its reader's local days, so the labels must be exactly what its
parser reads, and the population exactly what ``/views/count`` counts for the
same filters with the window as that field's date bounds.
"""
import re

import pytest
from httpx import AsyncClient
from sqlalchemy.dialects import postgresql

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.db.repositories import view_repo
from backend.app.services import view_source_kinds
from backend.app.services.versioned_sources import VersionedLookupUnavailable

_URL = "/api/v1/views/histogram"
_LOOKUP = "backend.app.services.versioned_sources.versioned_data_source_ids"
# foldHistogram.ts's bucketStart: anything else is silently dropped there.
_CLIENT_LABEL = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2})(?::(\d))?$")


def _view(view_id: str, created: str, *, updated=None, data=None, **cols) -> ViewORM:
    cols.setdefault("visibility", "enterprise")
    return ViewORM(
        id=view_id, name=view_id, workspace_id="ws_h", created_at=created,
        updated_at=updated or created, data_updated_at=data, **cols,
    )


async def _seed(session, *rows) -> None:
    session.add(WorkspaceORM(id="ws_h", name="H"))
    for row in rows:
        session.add(row)
    await session.commit()


async def _histogram(client: AsyncClient, **params) -> dict:
    resp = await client.get(_URL, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _buckets(body: dict) -> list:
    return [(b["t"], b["n"]) for b in body["buckets"]]


def _created() -> tuple:
    return (
        _view("v1", "2026-03-01T09:05:00.123456+00:00"),
        _view("v2", "2026-03-01T09:55:00+00:00"),
        _view("v3", "2026-03-01T10:00:00+00:00"),
        _view("v4", "2026-03-02T23:59:59.999999+00:00"),
        _view("v_before_window", "2026-02-28T23:59:59+00:00"),
    )


async def test_views_created_per_hour(test_client: AsyncClient, db_session):
    # (A 200 here is also the route-order check: ``/{view_id}`` would 404 it.)
    await _seed(db_session, *_created())
    body = await _histogram(test_client, field="created", after="2026-03-01", before="2026-03-03")
    assert body == {
        "field": "created",
        "grain": "hour",
        "after": "2026-03-01T00:00:00+00:00",
        "before": "2026-03-03T00:00:00+00:00",
        "total": 4,
        "buckets": [
            {"t": "2026-03-01T09", "n": 2},
            {"t": "2026-03-01T10", "n": 1},
            {"t": "2026-03-02T23", "n": 1},
        ],
    }
    assert all(_CLIENT_LABEL.match(b["t"]) for b in body["buckets"])


async def test_ten_minute_labels(test_client: AsyncClient, db_session):
    await _seed(db_session, *_created())
    body = await _histogram(
        test_client, field="created", after="2026-03-01", before="2026-03-03", grain="10min",
    )
    assert body["grain"] == "10min"
    assert _buckets(body) == [
        ("2026-03-01T09:0", 1), ("2026-03-01T09:5", 1),
        ("2026-03-01T10:0", 1), ("2026-03-02T23:5", 1),
    ]
    assert all(_CLIENT_LABEL.match(t) for t, _ in _buckets(body))


async def test_updated_is_the_later_of_edit_and_publish(test_client: AsyncClient, db_session):
    april = "2026-04-01T00:00:00+00:00"
    await _seed(
        db_session,
        _view("v_data_newer", april, updated="2026-05-01T08:00:00+00:00",
              data="2026-05-01T12:30:00+00:00"),
        # Edited after its last publish: the edit is its last change.
        _view("v_settings_newer", april, updated="2026-05-01T15:10:00+00:00",
              data="2026-05-01T09:00:00+00:00"),
        # Never published: its last edit.
        _view("v_never_published", april, updated="2026-05-01T07:45:00+00:00"),
    )
    window = {"after": "2026-05-01", "before": "2026-05-02"}
    body = await _histogram(test_client, field="updated", **window)
    assert _buckets(body) == [("2026-05-01T07", 1), ("2026-05-01T12", 1), ("2026-05-01T15", 1)]
    assert (await _histogram(test_client, field="created", **window))["total"] == 0


async def test_the_window_is_half_open(test_client: AsyncClient, db_session):
    await _seed(
        db_session,
        _view("v_at_after", "2026-03-01T00:00:00+00:00"),
        _view("v_at_before", "2026-03-02T00:00:00+00:00"),
    )
    body = await _histogram(test_client, field="created", after="2026-03-01", before="2026-03-02")
    assert _buckets(body) == [("2026-03-01T00", 1)]
    # The same instants written with an offset are the same window.
    body = await _histogram(
        test_client, field="created",
        after="2026-03-01T01:00:00+01:00", before="2026-03-02T01:00:00+01:00",
    )
    assert body["after"] == "2026-03-01T00:00:00+00:00"
    assert _buckets(body) == [("2026-03-01T00", 1)]
    body = await _histogram(test_client, field="created", after="2026-03-02", before="2026-03-03")
    assert _buckets(body) == [("2026-03-02T00", 1)]


async def test_a_filter_narrows_it(test_client: AsyncClient, db_session):
    await _seed(
        db_session,
        _view("v_fin_1", "2026-03-01T09:00:00+00:00", tags='["finance"]'),
        _view("v_fin_2", "2026-03-01T15:00:00+00:00", tags='["finance", "pii"]'),
        _view("v_eng", "2026-03-01T09:30:00+00:00", tags='["eng"]'),
    )
    window = {"field": "created", "after": "2026-03-01", "before": "2026-03-02"}
    assert _buckets(await _histogram(test_client, **window)) == [
        ("2026-03-01T09", 2), ("2026-03-01T15", 1),
    ]
    assert _buckets(await _histogram(test_client, **window, tags="finance")) == [
        ("2026-03-01T09", 1), ("2026-03-01T15", 1),
    ]


def _mixed() -> tuple:
    return (
        _view("m_a", "2026-03-01T08:00:00+00:00", updated="2026-03-02T10:00:00+00:00",
              tags='["finance"]', created_by="usr_ann", visibility="workspace"),
        _view("m_b", "2026-03-01T05:00:00+00:00", updated="2026-03-03T12:00:00+00:00",
              data="2026-03-03T13:00:00+00:00", tags='["finance"]', created_by="usr_bob"),
        _view("m_c", "2026-03-02T12:00:00+00:00", updated="2026-03-05T00:00:00+00:00",
              tags='["eng"]', created_by="usr_ann", data_source_id="ds_v"),
        _view("m_d", "2026-03-03T23:00:00+00:00", created_by="usr_cy",
              updated_by="usr_ann", visibility="workspace"),
        _view("m_e", "2026-03-04T00:00:00+00:00", tags='["finance"]', created_by="usr_ann",
              data_source_id="ds_v"),
        _view("m_f", "2026-02-20T00:00:00+00:00", updated="2026-03-02T01:00:00+00:00",
              created_by="usr_bob", data_source_id="ds_x"),
    )


_WINDOW = {"after": "2026-03-01T06:00:00Z", "before": "2026-03-04"}


@pytest.mark.parametrize("field, params", [
    ("created", {}),
    ("created", {"tags": "finance"}),
    ("created", {"contributorIn": "usr_ann"}),
    ("created", {"visibilityIn": "workspace", "search": "m_"}),
    ("created", {"sourceKind": "versioned"}),
    # The client strips the field's own date rule but may send the other field's.
    ("created", {"updatedBefore": "2026-03-03"}),
    ("updated", {}),
    ("updated", {"tags": "finance", "createdAfter": "2026-03-01T06:00:00Z"}),
    ("updated", {"contributorIn": "usr_bob", "contributorRole": "created"}),
    ("updated", {"sourceKind": "external"}),
])
async def test_total_is_the_count_for_the_same_filters(
    test_client: AsyncClient, db_session, monkeypatch, field, params,
):
    view_source_kinds.reset()

    async def _versioned(**_kw):
        return frozenset({"ds_v"})

    monkeypatch.setattr(_LOOKUP, _versioned)
    await _seed(db_session, *_mixed())

    body = await _histogram(test_client, field=field, **_WINDOW, **params)
    as_bounds = (
        {"createdAfter": _WINDOW["after"], "createdBefore": _WINDOW["before"]}
        if field == "created" else
        {"updatedAfter": _WINDOW["after"], "updatedBefore": _WINDOW["before"]}
    )
    counted = await test_client.get("/api/v1/views/count", params={**params, **as_bounds})
    assert body["total"] == counted.json()["total"] == sum(n for _, n in _buckets(body))
    assert body["total"] > 0, "the mix should leave something to count"


async def test_never_counts_unreadable_or_deleted_views(test_client: AsyncClient, db_session):
    from backend.app.services.permission_service import PermissionClaims
    from backend.tests.test_views_scoping_regressions import _auth, _user

    await _seed(
        db_session,
        _view("v_public", "2026-03-01T09:00:00+00:00", created_by="usr_x"),
        _view("v_private", "2026-03-01T09:10:00+00:00", created_by="usr_x", visibility="private"),
        _view("v_deleted", "2026-03-01T09:20:00+00:00", deleted_at="2026-03-05T00:00:00+00:00"),
        _view("v_staged", "2026-03-01T09:30:00+00:00", draft_branch_id="br_import"),
    )
    window = {"field": "created", "after": "2026-03-01", "before": "2026-03-02"}
    # A platform admin reads the private view; deleted and staged views count for nobody.
    assert _buckets(await _histogram(test_client, **window)) == [("2026-03-01T09", 2)]
    member = _user("usr_member")
    claims = PermissionClaims(sid="s_member", ws_perms={"ws_h": ("workspace:view:read",)})
    with _auth(user=member, claims=claims):
        assert _buckets(await _histogram(test_client, **window)) == [("2026-03-01T09", 1)]


@pytest.mark.parametrize("params, says", [
    ({"field": "deleted"}, "field must be one of"),
    ({"grain": "day"}, "grain must be one of"),
    ({"after": "yesterday"}, "after must be an ISO date"),
    ({"before": "2026-02-30"}, "before must be an ISO date"),
    ({"after": ""}, "after must be an ISO date"),
    ({"after": "2026-03-02", "before": "2026-03-02"}, "earlier than before"),
    ({"after": "2026-03-03", "before": "2026-03-02"}, "earlier than before"),
    ({"after": "2025-01-01", "before": "2026-02-06"}, "400 days"),      # 401 days
])
async def test_bad_windows_are_422(test_client: AsyncClient, params, says):
    resp = await test_client.get(
        _URL, params={"field": "created", "after": "2026-03-01", "before": "2026-03-02", **params},
    )
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str) and says in resp.json()["detail"]


async def test_window_edges_that_are_fine(test_client: AsyncClient):
    for params in (
        {"after": "2025-01-01", "before": "2026-02-05"},                   # exactly 400 days
        {"after": "2026-03-01T00:00:00Z", "before": "2026-03-01T00:00:01Z"},
    ):
        resp = await test_client.get(_URL, params={"field": "updated", **params})
        assert resp.status_code == 200, (params, resp.text)
    # field/after/before are required; grain is not.
    assert (await test_client.get(_URL, params={"field": "created"})).status_code == 422


async def test_filtering_by_kind_while_the_lookup_is_down_is_503(
    test_client: AsyncClient, db_session, monkeypatch,
):
    view_source_kinds.reset()

    async def _down(**_kw):
        raise VersionedLookupUnavailable("graphver unreachable")

    monkeypatch.setattr(_LOOKUP, _down)
    resp = await test_client.get(_URL, params={
        "field": "created", "after": "2026-03-01", "before": "2026-03-02", "sourceKind": "versioned",
    })
    assert resp.status_code == 503
    assert resp.json()["detail"].startswith("We can't tell which data sources are versioned")


@pytest.mark.parametrize("field, grain, cut", [("created", "hour", 13), ("updated", "10min", 15)])
def test_the_statement_compiles_for_postgres(field, grain, cut):
    statement = view_repo._histogram_statement(
        field=field, grain=grain,
        after="2026-03-01T00:00:00+00:00", before="2026-03-02T00:00:00+00:00",
        tags=["finance"], readable=None,
    )
    sql = str(statement.compile(dialect=postgresql.dialect()))
    ts = (
        "CASE WHEN (views.data_updated_at > views.updated_at) "
        "THEN views.data_updated_at ELSE views.updated_at END"
        if field == "updated" else "views.created_at"
    )
    # The same cut in the SELECT, the GROUP BY and the ORDER BY — the grouping
    # Postgres accepts only when the texts match.
    assert sql.count(f"substr({ts}, 1, {cut})") == 3, sql
    assert ("CASE WHEN" in sql) == (field == "updated")
