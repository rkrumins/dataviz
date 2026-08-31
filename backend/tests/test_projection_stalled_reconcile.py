"""``managed`` must be a VERIFIED claim, not an assumption.

For fourteen hours on 2026-08-30 a wedged projection left one graph's
``projected_commit_seq`` below its ``main_head_commit_seq``. ContextEngine then
routed EVERY main read through the Postgres branch provider, which holds no
``:AGGREGATED`` rows, so rolled-up connections vanished from the canvas —
while ``aggregation_status`` read ``ready`` and the reconciliation sweep
stamped ``managed``, i.e. "someone else owns this and is doing fine".

``reconcile._guard`` returned ``platform_mastered`` for every versioned source
SECOND, ahead of nearly every other guard, and the sweeper treated that as a
terminal skip. The justification in the guard's own comment — the projector
maintains the rollups incrementally — is a claim about a RUNNING subsystem, and
nothing checked it. These tests pin the check.

They cover both shapes of the wedge (a watermark that trails the published
head, and a recorded projector error even once the watermark has caught up),
the two readings that must NOT trip it (a current projector, an unpinned graph
that projects nothing by design), and the read path that presented the stored
``ready`` column as the whole truth.
"""
import pytest

from backend.app.services.aggregation.reconcile import (
    DRIFT_STATES,
    SKIP_REASONS,
    Observation,
    Policy,
    evaluate,
)
from backend.app.services.versioned_sources import ProjectorHealth

POLICY = Policy()


def _versioned(**over) -> Observation:
    """A versioned source that, on the OLD code, was waved through as
    ``managed`` no matter what. Zero observed rollups is the normal reading for
    one of these — the stats scan runs against Postgres — so it also proves the
    verdict does not come from a detector."""
    base = dict(
        data_source_id="ds_v",
        workspace_id="ws_1",
        ontology_id="bp_1",
        platform_mastered=True,
        has_stats=True,
        stats_age_secs=60,
        node_count=1_000,
        observed_aggregated=0,
        observed_raw_fingerprint="fp_same",
        stored_raw_fingerprint="fp_same",
        aggregation_status="ready",
        expected_aggregated=500,
        has_completed_job=True,
        projection_checked_at="2026-08-30T12:00:00+00:00",
    )
    base.update(over)
    return Observation(**base)


def _health(**over) -> ProjectorHealth:
    base = dict(
        data_source_id="ds_v",
        graph_id="g_1",
        projected_commit_seq=100,
        main_head_commit_seq=100,
        last_error=None,
        falkor_graph_pinned=True,
        status="idle",
        checked_at="2026-08-30T12:00:00+00:00",
    )
    base.update(over)
    return ProjectorHealth(**base)


# ── Vocabulary ──────────────────────────────────────────────────────────

def test_the_stalled_state_is_its_own_value_not_a_fold_onto_drifting():
    """Folding an unknown tier onto the nearest one UNDER-states it. ``drifting``
    means the raw graph moved and a rebuild is the fix; this means the rollups
    are not being served at all and a rebuild is NOT the fix."""
    assert "projectionStalled" in DRIFT_STATES
    assert "projection_stalled" in SKIP_REASONS


# ── The wedge, both shapes ──────────────────────────────────────────────

def test_a_versioned_source_whose_projector_is_behind_is_not_managed():
    v = evaluate(_versioned(projection_commits_behind=5), POLICY)

    assert v.drift_state == "projectionStalled", (
        "a source whose rolled-up connections are missing from the product "
        "reported as 'managed' — the exact silence that hid a wedged "
        "projection for fourteen hours"
    )
    assert v.skip == "projection_stalled"
    assert not v.should_act, "recovery is an operator action, never a rebuild"
    assert v.evidence["projectionCommitsBehind"] == 5
    assert v.evidence["projectionCheckedAt"] == "2026-08-30T12:00:00+00:00"


def test_a_projector_error_counts_even_once_the_watermark_caught_up():
    """The second shape. A projector erroring every pass is a projector whose
    NEXT publish will not land, and between attempts the watermark goes quiet —
    so the error alone has to be enough."""
    v = evaluate(
        _versioned(
            projection_commits_behind=0,
            projection_last_error="verify mismatch at seq 902",
        ),
        POLICY,
    )

    assert v.drift_state == "projectionStalled"
    assert v.evidence["projectionLastError"] == "verify mismatch at seq 902"


# ── What must NOT trip it ───────────────────────────────────────────────

def test_a_current_projector_is_still_managed():
    """The guard's original justification holds while the projector keeps up,
    and a verdict that is always red is a verdict nobody reads."""
    v = evaluate(_versioned(projection_commits_behind=0), POLICY)

    assert v.skip == "platform_mastered"
    assert v.drift_state == "managed"
    assert v.evidence == {}


def test_an_unversioned_source_is_untouched_by_projection_fields():
    """Nothing projects for a source that is not versioned; the ordinary
    detectors must still own it."""
    v = evaluate(
        _versioned(platform_mastered=False, projection_commits_behind=9),
        POLICY,
    )

    assert v.drift_state == "overlayMissing"
    assert v.reason == "overlay_missing"


# ── The health reading itself ───────────────────────────────────────────

def test_an_unpinned_graph_is_never_stalled():
    """No real graph target means nothing is projected BY DESIGN — reads come
    from Postgres because that is the plan, not because anything is wedged.
    Mirrors the PROJECTION_STALE finding, which must not disagree."""
    h = _health(projected_commit_seq=0, main_head_commit_seq=9,
                last_error="boom", falkor_graph_pinned=False)

    assert h.stalled is False and h.current is True


def test_a_graph_with_no_projection_row_is_not_reported_behind():
    """Never projected at all is a different fact from "behind", and collapsing
    the two reports every brand-new versioned graph as wedged."""
    h = _health(projected_commit_seq=None, main_head_commit_seq=None,
                falkor_graph_pinned=False)

    assert h.commits_behind == 0 and h.current is True


def test_commits_behind_is_the_gap_and_never_negative():
    assert _health(projected_commit_seq=94).commits_behind == 6
    # A projector ahead of the head (a head rolled back) is not "behind".
    assert _health(projected_commit_seq=140).commits_behind == 0


# ── The readiness read path ─────────────────────────────────────────────
# ``aggregation_status = 'ready'`` records one true thing: the batch job
# succeeded. The lie was in presenting it as readiness. The stored column keeps
# its meaning; the read path stops speaking for the projector.

import pytest_asyncio
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)

from backend.app.db.engine import Base
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
)
from backend.app.services.aggregation.service import AggregationService


@pytest_asyncio.fixture
async def agg_session():
    engine = create_async_engine(
        "sqlite+aiosqlite://", connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _attach(dbapi_conn, _rec):
        dbapi_conn.execute("ATTACH DATABASE ':memory:' AS aggregation")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(
        bind=engine, class_=AsyncSession, expire_on_commit=False,
    )
    async with factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_v", workspace_id="ws_1",
            aggregation_status="ready", aggregation_edge_count=500,
        ))
        await s.commit()
    async with factory() as s:
        yield s
    await engine.dispose()


class _NoProvider:
    async def get_provider_for_workspace(self, *a, **kw):
        raise RuntimeError("no graph here")


def _service(factory=None):
    return AggregationService(
        dispatcher=None, registry=_NoProvider(), session_factory=factory,
    )


@pytest.fixture
def stub_health(monkeypatch):
    """Point the read path's projector lookup at a controllable snapshot."""
    snapshot: dict = {}

    async def _fake(**_kw):
        return dict(snapshot)

    monkeypatch.setattr(
        "backend.app.services.versioned_sources.projector_health", _fake,
    )
    return snapshot


@pytest.mark.asyncio
async def test_readiness_under_a_wedge_does_not_report_plain_ready(
    agg_session, stub_health,
):
    stub_health["ds_v"] = _health(projected_commit_seq=95, last_error="boom")

    r = await _service().get_readiness("ds_v", agg_session)

    # The stored column is untouched — it correctly records that the batch job
    # succeeded — but nothing here presents that as the whole truth.
    assert r.aggregation_status == "ready"
    assert r.message != "Aggregation complete. Views can be created.", (
        "a wedged source told the user aggregation was complete while its "
        "rolled-up connections were not reaching a canvas at all"
    )
    assert r.projector_current is False
    assert r.projection_commits_behind == 5
    assert r.projection_last_error == "boom"
    assert r.projection_checked_at == "2026-08-30T12:00:00+00:00"
    # isReady deliberately still tracks the JOB: the progress banner and the
    # readiness poll both stop on it, and flipping it here would leave them
    # running forever.
    assert r.is_ready is True


@pytest.mark.asyncio
async def test_readiness_with_a_current_projector_is_unchanged(
    agg_session, stub_health,
):
    stub_health["ds_v"] = _health()

    r = await _service().get_readiness("ds_v", agg_session)

    assert r.message == "Aggregation complete. Views can be created."
    assert r.projector_current is True
    assert r.projection_commits_behind == 0


@pytest.mark.asyncio
async def test_an_unreadable_projection_store_reports_unknown_not_healthy(
    agg_session, monkeypatch,
):
    """A null projection field means UNKNOWN. Nothing downstream may render it
    as "up to date" — that inversion is the whole bug."""
    async def _boom(**_kw):
        raise RuntimeError("graphver down")

    monkeypatch.setattr(
        "backend.app.services.versioned_sources.projector_health", _boom,
    )

    r = await _service().get_readiness("ds_v", agg_session)

    assert r.projector_current is None
    assert r.projection_commits_behind is None


# ── The fleet tiles ─────────────────────────────────────────────────────
# A wedged source landed in NO attention bucket at all: not failed, not
# marked, not drifting, not suspended. A whole wedged fleet read as needing
# nothing.


def test_a_stalled_source_needs_attention_but_is_not_counted_as_drifting():
    from backend.app.services.aggregation.service import _summarize_freshness

    rows = [("ds_v", "ws_1", "ready", None, None)]
    s = _summarize_freshness(
        rows, {}, {}, set(), set(), {"ds_v"},
    )

    assert s.needs_attention == 1, (
        "a source whose rolled-up connections are not reaching the product "
        "was in no triage bucket at all"
    )
    assert s.projection_stalled == 1
    assert s.drifting == 0, (
        "counted as drifting sends the operator to a rebuild, which is not "
        "the remedy — that fold is what under-states the problem"
    )
