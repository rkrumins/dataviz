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
from backend.app.db.repositories import profiling_repo, stats_history_repo
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


@pytest.fixture(autouse=True)
def _clear_policy_cache():
    """`resolve_history_policy` memoises for 30s in a process-global.

    Harmless in production — the settings row changes roughly never, and
    cross-process staleness is bounded by the TTL. In a test run it makes one
    test's saved policy visible to the next, so a policy assertion passes alone
    and fails in the suite.
    """
    stats_history_repo.invalidate_history_policy_cache()
    yield
    stats_history_repo.invalidate_history_policy_cache()


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


async def test_the_board_totals_the_two_measures_rather_than_falling_through(
    db_session: AsyncSession,
):
    """``total`` is nodes PLUS edges.

    The first version selected the column with ``nodes if metric == "nodes"
    else edges``, so every metric that was not ``nodes`` — ``total`` included
    — silently read the edge column. The board then showed a "Total" that was
    exactly the relationship count, which is wrong in a way nobody would
    question until they added the two numbers up by hand.
    """
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=120, edges=45)
    for _ in range(5):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    def board(metric: str):
        return profiling.get_board(
            window="24h", frm=None, to=None, workspace_id=None, provider_id=None,
            metric=metric, unusual_only=False, limit=100, offset=0,
            session=db_session, claims=OPERATOR,
        )

    nodes = (await board("nodes"))["data"]["rows"][0]["last"]
    edges = (await board("edges"))["data"]["rows"][0]["last"]
    total = (await board("total"))["data"]["rows"][0]["last"]

    assert (nodes, edges) == (120, 45)
    assert total == 165
    assert total != edges


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


# ── "last seen" is when it was PROFILED ──────────────────────────────


async def _stats_row(session: AsyncSession, ds_id: str, last_snapshot_at: str):
    from backend.app.db.models import DataSourceStatsORM

    session.add(DataSourceStatsORM(
        data_source_id=ds_id,
        node_count=0, edge_count=0,
        entity_type_counts="{}", edge_type_counts="{}",
        last_snapshot_at=last_snapshot_at,
    ))
    await session.flush()


async def test_last_seen_is_the_capture_instant_not_the_bucket(
    db_session: AsyncSession,
):
    """The board reads from the rollup tier, where bucket_start is the start of
    a day or an hour. Reporting that as "last seen" made every source observed
    anywhere in the same bucket report the same age — at day grain the whole
    fleet read "13h ago" whether it was profiled at midnight or a minute ago.
    """
    await _source(db_session, "ds_early")
    await _source(db_session, "ds_late")
    await _snap(db_session, "ds_early", _iso(20), nodes=100)
    await _snap(db_session, "ds_late", _iso(1), nodes=200)
    await _stats_row(db_session, "ds_early", _iso(20))
    await _stats_row(db_session, "ds_late", _iso(1))
    for _ in range(20):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    out = await profiling.get_board(
        window="30d", frm=None, to=None, workspace_id=None, provider_id=None,
        metric="nodes", unusual_only=False, limit=50, offset=0,
        session=db_session, claims=OPERATOR,
    )
    seen = {r["data_source_id"]: r["last_observed_at"] for r in out["data"]["rows"]}
    assert seen["ds_early"] != seen["ds_late"], (
        "two sources profiled 19 hours apart must not report the same age"
    )
    assert seen["ds_late"] > seen["ds_early"]


async def test_last_seen_falls_back_to_the_bucket_without_a_stats_row(
    db_session: AsyncSession,
):
    """A coarse answer beats none, and the two agree to within a bucket."""
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(3), nodes=100)
    for _ in range(20):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    out = await profiling.get_board(
        window="30d", frm=None, to=None, workspace_id=None, provider_id=None,
        metric="nodes", unusual_only=False, limit=50, offset=0,
        session=db_session, claims=OPERATOR,
    )
    assert out["data"]["rows"][0]["last_observed_at"] is not None


# ── the investigation windows ────────────────────────────────────────


async def test_the_incident_window_keeps_full_resolution(
    db_session: AsyncSession,
):
    """"When did this happen" is asked about the last day far more than about
    the last quarter. A busy source can capture more than the standard budget
    in 24 hours once the heartbeat tracks the poll, and falling to hour grain
    there would bucket away movement that was captured — in exactly the window
    someone opened to find it.
    """
    await _source(db_session, "ds_busy")
    # 900 captures in a day — over the 720 general budget, under the short one.
    base = datetime.now(timezone.utc) - timedelta(hours=23)
    for i in range(900):
        await _snap(
            db_session, "ds_busy",
            (base + timedelta(seconds=i * 90)).isoformat(),
            nodes=1000 + i,
        )

    grain = await profiling_repo.choose_grain(
        db_session, scope="source", scope_id="ds_busy", visible=None,
        frm=_iso(24), to=_iso(0), requested=None,
    )
    assert grain == "raw", "the last 24 hours must not be bucketed away"


async def test_a_long_window_still_takes_the_tighter_budget(
    db_session: AsyncSession,
):
    """At 90 days nobody is reading individual minutes, and the rollups carry
    min/max so an intra-bucket dip still shows."""
    await _source(db_session, "ds_a")
    await _snap(db_session, "ds_a", _iso(2), nodes=100)
    for _ in range(30):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break
        await profiling_repo.compact(db_session, grain="day")

    grain = await profiling_repo.choose_grain(
        db_session, scope="source", scope_id="ds_a", visible=None,
        frm=_iso(24 * 90), to=_iso(0), requested=None,
    )
    assert grain == "day", "hourly retention (45d) cannot reach back 90 days"


async def test_seven_days_reads_at_hourly_or_finer(db_session: AsyncSession):
    """The other investigation window. Hourly covers 45 days, so a week is
    always inside a tier that keeps intra-day shape."""
    await _source(db_session, "ds_a")
    for hours in range(0, 168, 6):
        await _snap(db_session, "ds_a", _iso(hours + 1), nodes=100 + hours)
    for _ in range(60):
        if not await profiling_repo.compact(db_session, grain="hour"):
            break

    grain = await profiling_repo.choose_grain(
        db_session, scope="source", scope_id="ds_a", visible=None,
        frm=_iso(24 * 7), to=_iso(0), requested=None,
    )
    assert grain in ("raw", "hour")


# ── the policy is settable, and settable things stick ────────────────


async def test_every_retention_tier_persists(db_session: AsyncSession):
    """The bug this closes: the endpoint accepted rawRetentionDays and
    dailyRetentionDays, answered 200, and dropped them — there was no column
    and no mapping. An API that accepts a setting and ignores it is worse than
    one that refuses it, because the operator has no way to tell."""
    await profiling.put_policy(
        body=profiling.PolicyRequest(
            rawRetentionDays=14, hourlyRetentionDays=60, dailyRetentionDays=200,
            maxRowsPerSource=2000, silentAfterSecs=7200,
        ),
        session=db_session, claims=OPERATOR,
    )
    policy, overrides = await profiling_repo.resolve_retention_policy(db_session)
    assert policy.raw_days == 14
    assert policy.hourly_days == 60
    assert policy.daily_days == 200
    assert policy.max_rows_per_source == 2000
    assert set(overrides) >= {
        "rawRetentionDays", "hourlyRetentionDays", "dailyRetentionDays",
    }


async def test_clearing_an_override_returns_to_the_deployment_default(
    db_session: AsyncSession,
):
    """A blank field means inherit, not zero. Pinning today's default the
    first time anyone opens the dialog and saves is a trap."""
    env = profiling_repo.env_retention_policy()
    await profiling.put_policy(
        body=profiling.PolicyRequest(rawRetentionDays=14),
        session=db_session, claims=OPERATOR,
    )
    await profiling.put_policy(
        body=profiling.PolicyRequest(rawRetentionDays=profiling_repo.INHERIT),
        session=db_session, claims=OPERATOR,
    )
    policy, overrides = await profiling_repo.resolve_retention_policy(db_session)
    assert policy.raw_days == env.raw_days
    assert "rawRetentionDays" not in overrides


async def test_a_policy_whose_tiers_do_not_nest_is_refused(
    db_session: AsyncSession,
):
    """Coverage has to be monotonic, because a read picks the finest tier that
    COVERS the window. Inverting them leaves windows no tier can answer while
    every tier still holds rows — which looks like data loss and is really a
    settings mistake."""
    with pytest.raises(HTTPException) as raised:
        await profiling.put_policy(
            body=profiling.PolicyRequest(rawRetentionDays=90, hourlyRetentionDays=7),
            session=db_session, claims=OPERATOR,
        )
    assert raised.value.status_code == 400
    assert "at least as far back" in str(raised.value.detail)


async def test_daily_must_reach_past_hourly(db_session: AsyncSession):
    with pytest.raises(HTTPException) as raised:
        await profiling.put_policy(
            body=profiling.PolicyRequest(hourlyRetentionDays=200, dailyRetentionDays=30),
            session=db_session, claims=OPERATOR,
        )
    assert raised.value.status_code == 400


async def test_the_policy_read_is_open_to_any_profiling_reader(
    db_session: AsyncSession,
):
    """A policy someone cannot change is still one they need to see: it
    explains why the window they are looking at stops where it does. Gating
    the READ at system:admin is what gave non-admins a permanent spinner."""
    out = await profiling.get_policy(
        session=db_session, claims=workspace_claims("ws_1"),
    )
    assert out["data"]["editable"] is False
    assert out["data"]["hourlyRetentionDays"] > 0


async def test_writing_the_policy_stays_platform_admin(db_session: AsyncSession):
    with pytest.raises(HTTPException) as raised:
        await profiling.put_policy(
            body=profiling.PolicyRequest(rawRetentionDays=14),
            session=db_session, claims=workspace_claims("ws_1"),
        )
    assert raised.value.status_code == 403


async def test_cadences_are_reported_but_not_settable(db_session: AsyncSession):
    """Compaction interval decides how hard the service works, and the purge
    cannot delete raw beyond the compaction watermark — so a live-editable
    compaction interval is a way to stall retention from a settings page."""
    out = await profiling.get_policy(session=db_session, claims=OPERATOR)
    cadences = out["data"]["cadences"]
    assert cadences["readOnly"] is True
    assert cadences["compactIntervalSecs"] > 0
    assert not hasattr(profiling.PolicyRequest(), "compactIntervalSecs")


async def test_the_policy_reads_back_the_value_it_will_actually_use(
    db_session: AsyncSession,
):
    """Reporting the environment value for a field the operator can override
    means their saved change reads back as ignored — while the capture path
    honours it. The page would be contradicting the behaviour."""
    await profiling.put_policy(
        body=profiling.PolicyRequest(heartbeatSecs=300, silentAfterSecs=1800),
        session=db_session, claims=OPERATOR,
    )
    out = await profiling.get_policy(session=db_session, claims=OPERATOR)
    assert out["data"]["heartbeatSecs"] == 300
    assert out["data"]["silentAfterSecs"] == 1800
    # And the deployment defaults are still reported, so a blank field can mean
    # "inherit" rather than pinning today's value.
    assert out["data"]["defaults"]["heartbeatSecs"] > 0


# ── narrowing parameters can only narrow ─────────────────────────────
#
# Added during the security-branch merge, because this is the shape of a
# defect this codebase has already shipped once.
#
# `_scope_for` calls `ensure_data_source_visible` only when scope ==
# "source". Every other scope, and both of the board's narrowing
# parameters, rely entirely on `_scope_conditions` ANDing the caller's
# `visible` set into the query. That is the right design -- authorisation
# and the query use one predicate rather than two that can disagree --
# but nothing drove it.
#
# The rule: a caller-supplied id may only ever intersect with what the
# caller can already see. If a refactor ever makes one of these replace
# the visibility filter instead of narrowing it, that is a cross-tenant
# read, and these tests are what notice.

async def _two_tenants(session: AsyncSession):
    """ws_1/prov_1 is ours; ws_2/prov_2 is somebody else's."""
    await _source(session, "ds_ours", workspace="ws_1", provider="prov_1")
    await _snap(
        session, "ds_ours", _iso(2), nodes=100,
        workspace="ws_1", provider="prov_1",
    )
    await _source(session, "ds_theirs", workspace="ws_2", provider="prov_2")
    await _snap(
        session, "ds_theirs", _iso(2), nodes=999,
        workspace="ws_2", provider="prov_2",
    )
    # The board reads the rollup tier, never raw -- at platform scope a raw
    # scan is the shape of a request that appears to hang. Without this the
    # board is empty for everyone and the refusals below would pass while
    # testing nothing.
    for _ in range(5):
        if not await profiling_repo.compact(session, grain="hour"):
            break


async def _board(session, claims, **kwargs):
    params = dict(
        window="24h", frm=None, to=None, workspace_id=None, provider_id=None,
        metric="nodes", unusual_only=False, limit=100, offset=0,
    )
    params.update(kwargs)
    return await profiling.get_board(session=session, claims=claims, **params)


async def test_the_board_refuses_another_tenants_workspace_filter(
    db_session: AsyncSession,
):
    """Asking for ws_2 as a ws_1 caller returns nothing, not ws_2's rows."""
    await _two_tenants(db_session)

    result = await _board(
        db_session, workspace_claims("ws_1"), workspace_id="ws_2",
    )
    assert result["data"]["rows"] == []
    # The total is the count after scoping, so a leak shows up as a wrong
    # number even if the ids were somehow scrubbed from the rows.
    assert result["data"]["total"] == 0
    assert result["data"]["platform_wide"] is False


async def test_the_board_refuses_another_tenants_provider_filter(
    db_session: AsyncSession,
):
    await _two_tenants(db_session)

    result = await _board(
        db_session, workspace_claims("ws_1"), provider_id="prov_2",
    )
    assert result["data"]["rows"] == []
    assert result["data"]["total"] == 0


async def test_the_board_still_narrows_within_what_we_can_see(
    db_session: AsyncSession,
):
    """The guard must not be 'refuse every filter' -- narrowing to our own
    workspace has to keep working, or the parameter is useless."""
    await _two_tenants(db_session)

    result = await _board(
        db_session, workspace_claims("ws_1"), workspace_id="ws_1",
    )
    assert [r["data_source_id"] for r in result["data"]["rows"]] == ["ds_ours"]


async def test_an_operator_sees_both_tenants_on_the_board(
    db_session: AsyncSession,
):
    """Guards the guard: if the fixtures produced no board rows at all, the
    refusals above would pass without testing anything."""
    await _two_tenants(db_session)

    result = await _board(db_session, OPERATOR)
    assert {r["data_source_id"] for r in result["data"]["rows"]} == {
        "ds_ours", "ds_theirs",
    }
    assert result["data"]["platform_wide"] is True


async def test_a_workspace_scoped_series_cannot_read_another_tenant(
    db_session: AsyncSession,
):
    """scope='workspace' has no ensure_* check -- it rests entirely on
    _scope_conditions ANDing `visible` into the query."""
    await _two_tenants(db_session)

    payload = (await profiling.get_series(
        scope="workspace", id="ws_2", window="24h", frm=None, to=None,
        grain="raw", metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=workspace_claims("ws_1"),
    ))["data"]
    assert payload["sources_observed"] == 0


async def test_a_provider_scoped_series_cannot_read_another_tenant(
    db_session: AsyncSession,
):
    await _two_tenants(db_session)

    payload = (await profiling.get_series(
        scope="provider", id="prov_2", window="24h", frm=None, to=None,
        grain="raw", metric="nodes", breakdown="none", top=8, compare=False,
        session=db_session, claims=workspace_claims("ws_1"),
    ))["data"]
    assert payload["sources_observed"] == 0


async def test_a_caller_bound_to_no_workspace_gets_nothing_not_everything(
    db_session: AsyncSession,
):
    """An EMPTY visible set is not None. Conflating them is the fail-OPEN
    direction, and it is the one that matters here."""
    await _two_tenants(db_session)

    board = await _board(db_session, NOBODY)
    assert board["data"]["rows"] == []
    assert board["data"]["platform_wide"] is False
