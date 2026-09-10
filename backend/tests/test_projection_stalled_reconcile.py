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

They cover the wedge itself (a watermark that trails the published head with
nothing closing the gap), the FOUR readings that must NOT trip it — a current
projector, an unpinned graph that projects nothing by design, a pass that is
in flight, and a stale error on a graph that has caught up — and the read path
that presented the stored ``ready`` column as the whole truth.

The last two were originally counted as wedges and both were false alarms on
ordinary operation; see the tests for what each one actually costs.
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


def test_the_error_is_carried_as_evidence_when_the_graph_is_behind():
    """The projector error is the one field that tells an operator what to do
    next, so narrowing the VERDICT to the watermark must not drop it from the
    REPORT."""
    v = evaluate(
        _versioned(
            projection_commits_behind=4,
            projection_last_error="verify mismatch at seq 902",
        ),
        POLICY,
    )

    assert v.drift_state == "projectionStalled"
    assert v.evidence["projectionCommitsBehind"] == 4
    assert v.evidence["projectionLastError"] == "verify mismatch at seq 902"


# ── What must NOT trip it ───────────────────────────────────────────────

def test_a_stale_error_on_a_caught_up_graph_is_not_a_wedge():
    """A permanent false alarm, and it was live.

    ``last_error`` is only ever rewritten by the NEXT projection pass, so on a
    graph nothing publishes to any more it never clears. Ten pinned graphs on
    the dev fleet sat exactly at their published head carrying errors between
    six weeks and two and a half months old — four of them data sources, so
    18% of the versioned fleet was permanently red.

    Every string the verdict renders asserts the OTHER shape: "reads fall back
    to the change history", "aggregated lineage is missing from views of this
    source right now", "this clears on its own within a minute". All false
    while the graph is at its head — read routing is ``projected >= committed``
    and consults ``last_error`` nowhere. And a failed verify deliberately holds
    the watermark BACK, so a projector that is really failing to publish is
    already ``behind`` and caught by the clause above.
    """
    v = evaluate(
        _versioned(
            projection_commits_behind=0,
            projection_last_error=(
                "FalkorDB has extra entities vs committed main "
                "(PG n=2,e=0; Falkor n=3,e=0)"
            ),
        ),
        POLICY,
    )

    assert v.drift_state == "managed", (
        "a graph serving its rollups was reported as not serving them, "
        "permanently — the badge that is always red is the badge nobody reads"
    )
    assert v.skip == "platform_mastered"


@pytest.mark.parametrize("status", ["projecting", "rebuilding"])
def test_a_pass_in_flight_is_working_not_wedged(status):
    """The watermark trails the head for the length of every ordinary pass.

    Reporting that as a wedge fires the red badge, the 8th stat tile, the
    "Rebuild won't fix this" chip and the "Needs attention" workspace dot on
    normal operation, and prescribes an action ("someone has to look at version
    control for it") that is wrong. ``versioning/reconcile.py`` already skips
    its scan for this exact reason and the infrastructure panel already leaves
    these graphs out of its not-publishing list; this is the third reader of
    the one rule and it has to agree with both.
    """
    from backend.app.services.aggregation.reconcile_sweeper import (
        _projection_ctx,
    )

    h = _health(projected_commit_seq=0, main_head_commit_seq=400,
                status=status)

    v = evaluate(_versioned(**_projection_ctx(h)), POLICY)
    assert v.drift_state == "managed", (
        "an ordinary in-flight projection pass reported itself as an outage"
    )
    assert v.skip == "platform_mastered"
    assert h.commits_behind == 400, "the gap is still reported as evidence"
    assert h.behind is False and h.stalled is False and h.current is True


def test_the_same_gap_with_no_pass_running_is_still_a_wedge():
    """The contrast that keeps the test above from being a way to switch the
    whole verdict off: identical numbers, ``idle``, still red."""
    from backend.app.services.aggregation.reconcile_sweeper import (
        _projection_ctx,
    )

    h = _health(projected_commit_seq=0, main_head_commit_seq=400,
                status="idle")
    assert h.behind is True and h.current is False

    v = evaluate(_versioned(**_projection_ctx(h)), POLICY)
    assert v.drift_state == "projectionStalled"
    assert v.evidence["projectionCommitsBehind"] == 400


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
async def test_readiness_is_current_on_a_caught_up_graph_carrying_a_STALE_error(
    agg_session, stub_health,
):
    """The false alarm, pinned at the surface a user actually saw it on.

    `test_a_stale_error_on_a_caught_up_graph_is_not_a_wedge` pins the verdict
    inside `evaluate`. This pins the CONSEQUENCE on the wire, because that is
    where it was reported from: a Context View's Data Loads panel marked every
    row "Connections still catching up", with a "Catching up" pill on its
    header, for a graph sitting exactly at its published head. `Nexus Lineage`
    was projected=8, head=8, status idle — and carrying "FalkorDB has extra
    entities vs committed main" from a pass that had long since stopped
    running.

    `last_error` is only ever rewritten by the next projection pass, so on a
    graph nothing publishes to any more it never clears. Reading it as "not
    current" tells a user their data has not arrived when it has, on a panel
    whose entire job is saying whether it has.
    """
    stub_health["ds_v"] = _health(
        last_error=(
            "FalkorDB has extra entities vs committed main "
            "(PG n=1907,e=5212; Falkor n=1912,e=2270) — run versioning "
            "enablement/bootstrap to import them"
        ),
    )

    r = await _service().get_readiness("ds_v", agg_session)

    assert r.projector_current is True, (
        "a graph at its published head is serving its connections; an error "
        "from a pass that is no longer running does not change that"
    )
    assert r.projection_commits_behind == 0
    # The error still travels — it is evidence an operator may want, and the
    # infrastructure panel lists it. It simply is not a verdict.
    assert r.projection_last_error is not None
    assert r.message == "Aggregation complete. Views can be created.", (
        "a caught-up source must not be told its connections are catching up"
    )


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


# ── The two clocks on one row ───────────────────────────────────────────
# ``drift_state`` is stamped by the reconciliation SWEEP, at most once per
# check interval (shipped default 3600s). The ``projection*`` fields on the
# SAME row are read live on every request. The fleet tile counted only the
# stamp, so for up to a whole interval after a wedge started the identical
# payload said ``projectorCurrent: false`` and ``driftState: managed`` — and
# the surfaces split along that seam: Insights rendered red and said "open
# Freshness for what to do" while Freshness rendered the source green.


def test_the_tile_counts_a_wedge_the_stamp_has_not_caught_up_with_yet():
    from backend.app.services.aggregation.service import _stalled_ids

    states = {"ds_v": {"drift_state": "managed"}}
    health = {"ds_v": _health(projected_commit_seq=0, main_head_commit_seq=902)}

    assert _stalled_ids(["ds_v"], states, health) == {"ds_v"}, (
        "the fleet page read the live watermark for the row's own "
        "projection fields and then counted the hour-old stamp instead"
    )


def test_the_stored_stamp_still_counts_when_the_live_read_is_unavailable():
    """graphver down ⇒ an empty health map (the fleet page must not 500). The
    stamp is the DURABLE verdict and must not evaporate with the live read."""
    from backend.app.services.aggregation.service import _stalled_ids

    states = {"ds_v": {"drift_state": "projectionStalled"}}

    assert _stalled_ids(["ds_v"], states, {}) == {"ds_v"}


def test_an_unknown_projector_reading_is_never_counted_as_stalled():
    """An unpinned graph projects nothing by design: its wire fields are all
    null, and null is UNKNOWN — never a wedge, and equally never "up to
    date"."""
    from backend.app.services.aggregation.service import _stalled_ids

    states = {"ds_v": {"drift_state": "managed"}}
    health = {"ds_v": _health(
        projected_commit_seq=0, main_head_commit_seq=902,
        falkor_graph_pinned=False,
    )}

    assert _stalled_ids(["ds_v"], states, health) == set()
