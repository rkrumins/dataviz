"""The profiling API — one shape, four scopes, two journeys.

Handlers are called directly with a real ``db_session``: the router gate is
FastAPI's job and is asserted separately, while everything interesting here is
in what the payload says and, more importantly, what it refuses to say.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import profiling
from backend.app.db.models import (
    DataSourceCountSnapshotORM,
    ProviderORM,
    WorkspaceDataSourceORM,
)
from backend.app.db.repositories import profiling_repo
from backend.app.services.permission_service import PermissionClaims


#: The platform operator: every onboarded source in the deployment.
OPERATOR = PermissionClaims(
    sid="sess_op", global_perms=("system:admin",), ws_perms={},
)


def workspace_claims(*workspace_ids: str) -> PermissionClaims:
    """A workspace-bound caller: only the sources in these workspaces."""
    return PermissionClaims(
        sid="sess_ws", global_perms=(),
        ws_perms={ws: ("workspace:datasource:manage",) for ws in workspace_ids},
    )


NOBODY = PermissionClaims(sid="sess_none", global_perms=(), ws_perms={})


def _iso(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


async def _source(
    session: AsyncSession, ds_id: str, *, workspace: str = "ws_1",
    provider: str = "prov_1", label: str | None = None,
):
    session.add(WorkspaceDataSourceORM(
        id=ds_id, workspace_id=workspace, provider_id=provider,
        graph_name=f"g-{ds_id}", label=label or ds_id,
        is_primary=False, is_active=True, aggregation_status="none",
        aggregation_edge_count=0, is_restricted=False,
        created_at=_iso(1000), updated_at=_iso(1000),
    ))
    await session.flush()


async def _snap(
    session: AsyncSession, ds_id: str, at: str, *, nodes: int, edges: int = 0,
    types: dict | None = None, edge_types: dict | None = None,
    workspace: str = "ws_1", provider: str = "prov_1",
    node_delta: int | None = None, reason: str = "changed",
):
    session.add(DataSourceCountSnapshotORM(
        id=f"snp_{ds_id}_{at}", data_source_id=ds_id, captured_at=at,
        workspace_id=workspace, provider_id=provider, graph_name=f"g-{ds_id}",
        node_count=nodes, edge_count=edges,
        entity_type_counts=json.dumps(types or {"Table": nodes}),
        edge_type_counts=json.dumps(edge_types or {}),
        counts_digest=f"d{nodes}", lane="probe", capture_reason=reason,
        node_delta=node_delta,
    ))
    await session.flush()


# ── the window contract ──────────────────────────────────────────────


def test_a_window_token_resolves_server_side():
    """A client computing to=now() on every render produces a new value every
    time — a cache key that never hits, and on the previous implementation a
    query key that re-fetched forever."""
    at = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
    frm, to, label = profiling._resolve_window("7d", None, None, now=at)
    assert label == "7d"
    assert to == at.isoformat()
    assert frm == (at - timedelta(days=7)).isoformat()


def test_an_unknown_window_widens_to_the_default_rather_than_erroring():
    at = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
    _frm, _to, label = profiling._resolve_window("nonsense", None, None, now=at)
    assert label == "30d"


def test_a_reversed_explicit_range_is_swapped_not_rejected():
    frm, to, label = profiling._resolve_window(
        None, "2026-08-20", "2026-08-01",
    )
    assert (frm, to, label) == ("2026-08-01", "2026-08-20", "custom")


# ── grain selection ──────────────────────────────────────────────────


def test_auto_grain_errs_toward_the_finer_tier():
    """The value of this view is seeing the exact moment something changed. A
    downsample that lands one bucket away is the difference between 'at 21:32'
    and 'sometime on Tuesday'."""
    now = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
    day_ago = (now - timedelta(hours=24)).isoformat()
    week_ago = (now - timedelta(days=7)).isoformat()
    quarter = (now - timedelta(days=90)).isoformat()

    assert profiling_repo.resolve_grain(day_ago, now.isoformat(), None) == "raw"
    assert profiling_repo.resolve_grain(week_ago, now.isoformat(), None) == "hour"
    assert profiling_repo.resolve_grain(quarter, now.isoformat(), None) == "day"


def test_an_explicit_grain_wins():
    now = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
    quarter = (now - timedelta(days=90)).isoformat()
    assert profiling_repo.resolve_grain(quarter, now.isoformat(), "raw") == "raw"


# ── scope and authorisation ──────────────────────────────────────────


async def test_a_workspace_caller_sees_only_their_own_sources(
    db_session: AsyncSession,
):
    await _source(db_session, "ds_mine", workspace="ws_1")
    await _source(db_session, "ds_theirs", workspace="ws_2")
    await _snap(db_session, "ds_mine", _iso(2), nodes=100, workspace="ws_1")
    await _snap(db_session, "ds_theirs", _iso(2), nodes=999, workspace="ws_2")

    out = await profiling.get_series(
        scope="all", id=None, window="24h", frm=None, to=None, grain="raw",
        metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=workspace_claims("ws_1"),
    )
    assert out["data"]["totals"]["nodes"] == [100]
    assert out["data"]["platform_wide"] is False


async def test_an_operator_sees_the_whole_deployment(db_session: AsyncSession):
    await _source(db_session, "ds_mine", workspace="ws_1")
    await _source(db_session, "ds_theirs", workspace="ws_2")
    await _snap(db_session, "ds_mine", _iso(2), nodes=100, workspace="ws_1")
    await _snap(db_session, "ds_theirs", _iso(2), nodes=900, workspace="ws_2")

    out = await profiling.get_series(
        scope="all", id=None, window="24h", frm=None, to=None, grain="raw",
        metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=OPERATOR,
    )
    # Raw grain gives each instant its own bucket, and the two sources were
    # not observed at the same one — so the first bucket holds only the source
    # seen first, and the second holds both by carry-forward. The END of the
    # window is the whole estate, which is the number that matters.
    assert out["data"]["totals"]["nodes"][-1] == 1000
    assert out["data"]["platform_wide"] is True


async def test_a_caller_bound_to_nothing_sees_nothing(db_session: AsyncSession):
    """An empty visible set is not the same as unrestricted, and conflating
    the two hands one tenant the whole deployment."""
    await _source(db_session, "ds_a", workspace="ws_1")
    await _snap(db_session, "ds_a", _iso(2), nodes=100)

    out = await profiling.get_series(
        scope="all", id=None, window="24h", frm=None, to=None, grain="raw",
        metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=NOBODY,
    )
    assert out["data"]["series"] == []


async def test_another_tenants_source_is_a_404_not_a_403(
    db_session: AsyncSession,
):
    """Refusing by existence lets a caller enumerate other tenants' sources by
    watching which ids answer differently."""
    await _source(db_session, "ds_theirs", workspace="ws_2")
    await _snap(db_session, "ds_theirs", _iso(2), nodes=100, workspace="ws_2")

    with pytest.raises(HTTPException) as raised:
        await profiling.get_series(
            scope="source", id="ds_theirs", window="24h", frm=None, to=None,
            grain="raw", metric="nodes", breakdown="none", top=8,
            compare=False, session=db_session, claims=workspace_claims("ws_1"),
        )
    assert raised.value.status_code == 404


async def test_an_unknown_scope_is_rejected(db_session: AsyncSession):
    with pytest.raises(HTTPException) as raised:
        await profiling.get_series(
            scope="galaxy", id=None, window="24h", frm=None, to=None,
            grain=None, metric="nodes", breakdown="none", top=8,
            compare=False, session=db_session, claims=OPERATOR,
        )
    assert raised.value.status_code == 400


async def test_a_scope_that_needs_an_id_says_so(db_session: AsyncSession):
    with pytest.raises(HTTPException) as raised:
        await profiling.get_series(
            scope="provider", id=None, window="24h", frm=None, to=None,
            grain=None, metric="nodes", breakdown="none", top=8,
            compare=False, session=db_session, claims=OPERATOR,
        )
    assert raised.value.status_code == 400


# ── what the series carries ──────────────────────────────────────────


async def test_the_series_reports_where_coverage_begins(
    db_session: AsyncSession,
):
    """So the UI can say "history begins here" rather than letting a short
    series read as data loss — a distinction a chart cannot make on its own."""
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(3), nodes=100)

    out = await profiling.get_series(
        scope="source", id="ds_a", window="24h", frm=None, to=None,
        grain="raw", metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=OPERATOR,
    )
    assert out["data"]["coverage_from"] is not None
    assert out["data"]["sources_observed"] == 1


async def test_a_breakdown_by_relationship_type_is_available(
    db_session: AsyncSession,
):
    """Edge types were captured and returned but never drawable — the chart
    had a field for them that nothing ever passed."""
    await _source(db_session, "ds_a")
    await _snap(
        db_session, "ds_a", _iso(2), nodes=10, edges=90,
        edge_types={"LINKS": 60, "DEPENDS_ON": 30},
    )

    out = await profiling.get_series(
        scope="source", id="ds_a", window="24h", frm=None, to=None,
        grain="raw", metric="edges", breakdown="edge_type", top=8,
        compare=False, session=db_session, claims=OPERATOR,
    )
    assert {s["key"] for s in out["data"]["series"]} == {"LINKS", "DEPENDS_ON"}


async def test_compare_returns_the_preceding_window(db_session: AsyncSession):
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=200)
    await _snap(db_session, "ds_a", _iso(30), nodes=100)

    out = await profiling.get_series(
        scope="source", id="ds_a", window="24h", frm=None, to=None,
        grain="raw", metric="nodes", breakdown="none", top=8, compare=True,
        session=db_session, claims=OPERATOR,
    )
    assert "previous" in out["data"]
    assert out["data"]["previous"]["totals"]["nodes"] == [100]


# ── the board ────────────────────────────────────────────────────────


async def test_the_board_counts_unobserved_sources_rather_than_zeroing_them(
    db_session: AsyncSession,
):
    """A source that was not observed did not drop to nothing, and a board
    that showed it at zero would invent an outage. This was hardcoded to 0."""
    await _source(db_session, "ds_seen")
    await _source(db_session, "ds_quiet")
    await _snap(db_session, "ds_seen", _iso(2), nodes=100)
    for _ in range(5):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    out = await profiling.get_board(
        window="24h", frm=None, to=None, workspace_id=None, provider_id=None,
        metric="nodes", unusual_only=False, limit=100, offset=0,
        session=db_session, claims=OPERATOR,
    )
    assert [r["data_source_id"] for r in out["data"]["rows"]] == ["ds_seen"]
    assert out["data"]["unobserved"] == 1


async def test_the_board_is_paginated(db_session: AsyncSession):
    for i in range(5):
        await _source(db_session, f"ds_{i}")
        await _snap(db_session, f"ds_{i}", _iso(2), nodes=100 + i)
    for _ in range(5):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    out = await profiling.get_board(
        window="24h", frm=None, to=None, workspace_id=None, provider_id=None,
        metric="nodes", unusual_only=False, limit=2, offset=0,
        session=db_session, claims=OPERATOR,
    )
    assert len(out["data"]["rows"]) == 2
    assert out["data"]["total"] == 5


# ── the ledger ───────────────────────────────────────────────────────


async def test_the_ledger_reports_the_run_that_caused_an_observation(
    db_session: AsyncSession,
):
    """Correlating by timestamp answers "what else was running"; this answers
    "what did that load do", which is the question after an ingestion run."""
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=100, reason="run")
    row = (await db_session.execute(
        __import__("sqlalchemy").select(DataSourceCountSnapshotORM)
    )).scalars().first()
    row.refresh_event_id = "re_9c"
    await db_session.flush()

    out = await profiling.get_observations(
        id="ds_a", window="24h", frm=None, to=None, only_notable=False,
        limit=100, offset=0, session=db_session, claims=OPERATOR,
    )
    entry = out["data"]["observations"][0]
    assert entry["reason"] == "run"
    assert entry["refresh_event_id"] == "re_9c"


async def test_the_ledger_reports_significance_per_metric(
    db_session: AsyncSession,
):
    await _source(db_session, "ds_a")
    for hours in range(20, 10, -1):
        await _snap(db_session, "ds_a", _iso(hours), nodes=1000, node_delta=10)
    await _snap(db_session, "ds_a", _iso(2), nodes=10, node_delta=-990)

    out = await profiling.get_observations(
        id="ds_a", window="30d", frm=None, to=None, only_notable=True,
        limit=100, offset=0, session=db_session, claims=OPERATOR,
    )
    assert out["data"]["observations"]
    assert out["data"]["observations"][0]["significance"]["nodes"] != "normal"
    assert set(out["data"]["baselines"]) == {"nodes", "edges"}


# ── catalog ids resolve to data sources ──────────────────────────────


async def test_a_catalog_id_resolves_to_its_data_source(
    db_session: AsyncSession,
):
    """The routable page and the Ingestion drawer are keyed on the CATALOG
    item; profiling is keyed on the data source. Without this the profile
    could show a source's numbers but not what they did — which is exactly the
    split this surface exists to close."""
    from backend.app.db.models import CatalogItemORM

    db_session.add(ProviderORM(
        id="prov_1", name="Falkor", provider_type="falkordb",
        host="h", port=6379, created_at=_iso(1000), updated_at=_iso(1000),
    ))
    db_session.add(CatalogItemORM(
        id="cat_1", provider_id="prov_1", source_identifier="g-ds_a",
        name="Customers", status="active",
        created_at=_iso(1000), updated_at=_iso(1000),
    ))
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=250)

    out = await profiling.get_series(
        scope="source", id="cat_1", window="24h", frm=None, to=None,
        grain="raw", metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=OPERATOR,
    )
    assert out["data"]["id"] == "ds_a"
    assert out["data"]["totals"]["nodes"] == [250]


async def test_an_unresolvable_catalog_id_falls_through_to_not_found(
    db_session: AsyncSession,
):
    """The ordinary not-found path, not a special one — and the same answer a
    real-but-unobserved source gets."""
    with pytest.raises(HTTPException) as raised:
        await profiling.get_series(
            scope="source", id="cat_nope", window="24h", frm=None, to=None,
            grain="raw", metric="nodes", breakdown="none", top=8,
            compare=False, session=db_session, claims=workspace_claims("ws_1"),
        )
    assert raised.value.status_code == 404


# ── the ledger states facts about the PERIOD ─────────────────────────


async def test_the_ledger_counts_the_window_not_the_page(
    db_session: AsyncSession,
):
    """A claim about the period cannot be computed from a slice of it.

    The header says "N observations, M moved"; deriving that from whichever
    page was returned makes the total shrink as the page does.
    """
    await _source(db_session, "ds_a")
    for hours in range(30):
        await _snap(
            db_session, "ds_a", _iso(hours + 1), nodes=100 + hours,
            reason="heartbeat" if hours % 3 else "changed",
        )

    out = await profiling.get_observations(
        id="ds_a", window="30d", frm=None, to=None, only_notable=False,
        limit=5, offset=0, session=db_session, claims=OPERATOR,
    )
    counts = out["data"]["counts"]
    assert counts["observations"] == 30, "the window, not the page"
    assert counts["checkpoints"] == 20
    assert counts["moved"] == 10
    assert len(out["data"]["observations"]) == 5, "the page is still a page"


async def test_a_run_capture_counts_as_movement_not_a_checkpoint(
    db_session: AsyncSession,
):
    """A refresh that changed nothing is still something that happened, and
    the ledger must not file it under stillness."""
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(3), nodes=100, reason="heartbeat")
    await _snap(db_session, "ds_a", _iso(2), nodes=100, reason="run")

    out = await profiling.get_observations(
        id="ds_a", window="24h", frm=None, to=None, only_notable=False,
        limit=50, offset=0, session=db_session, claims=OPERATOR,
    )
    counts = out["data"]["counts"]
    assert counts["runs"] == 1
    assert counts["moved"] == 1
    assert counts["checkpoints"] == 1


# ── grain follows density, not just window width ─────────────────────


async def test_a_sparse_window_is_not_flattened_into_two_points(
    db_session: AsyncSession,
):
    """The bug this exists to prevent.

    A source observed eight times in a month was served at day grain, which
    collapsed those eight observations into two points. The chart drew two
    flat lines, the trend column had too few points to draw, and every delta
    read as unchanged — a surface reporting "nothing happened" from a series
    it had just flattened.
    """
    await _source(db_session, "ds_a")
    for hours in range(8):
        await _snap(db_session, "ds_a", _iso(hours * 3 + 1), nodes=100 + hours)
    for _ in range(20):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    out = await profiling.get_series(
        scope="source", id="ds_a", window="30d", frm=None, to=None, grain=None,
        metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=OPERATOR,
    )
    assert out["data"]["grain"] == "hour"
    assert len(out["data"]["buckets"]) == 8, "every observation survives"


async def test_a_tier_that_cannot_cover_the_window_is_not_chosen(
    db_session: AsyncSession,
):
    """A subtler wrong answer than a coarse one.

    Raw is retained for days and the rollups for months, so serving raw for a
    30-day window would answer with the last week and silently drop the other
    three.
    """
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=100)
    for _ in range(20):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    grain = await profiling_repo.choose_grain(
        db_session, scope="source", scope_id="ds_a", visible=None,
        frm=_iso(24 * 30), to=_iso(0), requested=None,
    )
    assert grain != "raw", "raw retention (7d) cannot reach back 30 days"


async def test_a_short_window_still_gets_full_fidelity(
    db_session: AsyncSession,
):
    await _source(db_session, "ds_a")
    for minutes in range(5):
        await _snap(db_session, "ds_a", _iso(minutes * 0.1), nodes=100 + minutes)

    grain = await profiling_repo.choose_grain(
        db_session, scope="source", scope_id="ds_a", visible=None,
        frm=_iso(24), to=_iso(0), requested=None,
    )
    assert grain == "raw", "a day of history is inside raw retention"


async def test_an_explicit_grain_is_always_honoured(db_session: AsyncSession):
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=100)

    grain = await profiling_repo.choose_grain(
        db_session, scope="source", scope_id="ds_a", visible=None,
        frm=_iso(24 * 90), to=_iso(0), requested="raw",
    )
    assert grain == "raw"
