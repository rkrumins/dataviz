"""Counts anomalies — deciding what is worth telling someone about, and
remembering that decision.

**Why this is a sweep and not a hook on the write.** Significance is a property
of a WINDOW: it is measured against the median absolute movement of the source's
recent history. Classifying at capture time would put a range scan on the 60s
drift-probe path, and would run inside the web tier too — a request handler is
no place to decide whether to wake somebody up. So evaluation is retrospective,
runs in the insights service on its own tick, and reads what capture already
wrote.

**Why the verdict is frozen.** The baseline moves as the window moves. An alert
recomputed a week later against a different baseline could quietly downgrade
itself to "normal" — the row would then contradict the notification that was
already sent. So the classification, the baseline behind it, and the per-label
evidence are written once, at the moment the judgement was made, and never
derived again.

**Why a cooldown and not a per-snapshot alert.** A source thrashing under a
broken loader produces an unusual movement on every probe. Alerting on each one
turns a single incident into a pager storm and trains people to ignore it. One
alert per source per cooldown, with the WORST movement in that stretch winning,
says the same thing once.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Set

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.common.derived_artifacts import strip_derived_counts
from ..models import (
    DataSourceCountAlertORM,
    DataSourceCountSnapshotORM,
    PlatformSettingsORM,
    WorkspaceDataSourceORM,
)
from . import stats_history_repo

logger = logging.getLogger(__name__)

_SEVERITY_RANK = {"normal": 0, "notable": 1, "severe": 2, "critical": 3}

#: Floors on the operator overrides, mirroring the retention policy's. A
#: cooldown of 0 would turn one incident into an alert per probe.
_MIN_COOLDOWN_SECS = 60

#: How far back an evaluation pass looks for movements it has not judged yet.
#: Wide enough that a service restart or a paused tick does not silently skip
#: an incident; the cooldown is what stops the re-look becoming a re-alert.
_LOOKBACK_SECS = 24 * 3600

#: Sources examined per pass. Bounds one tick's work on a large fleet; the
#: rest are picked up next tick, and the lookback above means nothing is lost
#: by waiting.
_SOURCE_SCAN_CAP = 500


@dataclass(frozen=True)
class AlertPolicy:
    enabled: bool
    min_severity: str
    cooldown_secs: int

    env_enabled: bool
    env_min_severity: str
    env_cooldown_secs: int

    persisted_enabled: Optional[bool] = None
    persisted_min_severity: Optional[str] = None
    persisted_cooldown_secs: Optional[int] = None


def env_alert_policy() -> AlertPolicy:
    return AlertPolicy(
        enabled=resilience.PROFILING_ALERTS_ENABLED,
        min_severity=resilience.PROFILING_ALERT_MIN_SEVERITY,
        cooldown_secs=resilience.PROFILING_ALERT_COOLDOWN_SECS,
        env_enabled=resilience.PROFILING_ALERTS_ENABLED,
        env_min_severity=resilience.PROFILING_ALERT_MIN_SEVERITY,
        env_cooldown_secs=resilience.PROFILING_ALERT_COOLDOWN_SECS,
    )


async def resolve_alert_policy(session: AsyncSession) -> AlertPolicy:
    """``persisted ?? env``. NEVER raises — a settings read must not be able to
    fail an evaluation pass, and degrading to the env default is the safe
    direction (alerting keeps working as deployed)."""
    env = env_alert_policy()
    try:
        row = await session.get(PlatformSettingsORM, 1)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("alert policy read failed (using env defaults): %s", exc)
        return env
    if row is None:
        return env

    p_enabled = getattr(row, "history_alerts_enabled", None)
    p_severity = getattr(row, "history_alert_min_severity", None)
    p_cooldown = getattr(row, "history_alert_cooldown_secs", None)
    return AlertPolicy(
        # ``is None`` rather than truthiness: False is a real setting, and a
        # truthiness check would silently turn alerting back on.
        enabled=env.env_enabled if p_enabled is None else bool(p_enabled),
        min_severity=(
            p_severity if p_severity in _SEVERITY_RANK else env.env_min_severity
        ),
        cooldown_secs=(
            max(_MIN_COOLDOWN_SECS, int(p_cooldown))
            if isinstance(p_cooldown, int) else env.env_cooldown_secs
        ),
        env_enabled=env.env_enabled,
        env_min_severity=env.env_min_severity,
        env_cooldown_secs=env.env_cooldown_secs,
        persisted_enabled=p_enabled,
        persisted_min_severity=p_severity,
        persisted_cooldown_secs=p_cooldown,
    )


@dataclass(frozen=True)
class AlertIdentity:
    """Who this alert is ABOUT, in names a person recognises.

    Frozen onto the alert rather than resolved on read: an operator opening a
    week-old alert needs to know which source under which provider was hit,
    and by then the provider may have been renamed and the source relabelled
    or deleted. Ids alone send the reader hunting through a catalog to find
    out what the alert was even about.
    """
    catalog_item_id: Optional[str] = None
    provider_name: Optional[str] = None
    data_source_label: Optional[str] = None


async def _identity_for(
    session: AsyncSession,
    *,
    data_source_id: str,
    provider_id: Optional[str],
    graph_name: Optional[str],
) -> AlertIdentity:
    """Resolve the names and the deep-link target for one alert.

    Three small by-id reads across domain boundaries — never a JOIN, per the
    ownership map — and they run once per ALERT, which is a rare event, not
    once per snapshot. Every lookup degrades to ``None`` independently: a
    missing provider row must not cost the alert its source label, and neither
    must cost the alert itself.
    """
    from ..models import CatalogItemORM, ProviderORM, WorkspaceDataSourceORM

    catalog_item_id = provider_name = data_source_label = None

    if provider_id and graph_name:
        try:
            catalog_item_id = (await session.execute(
                select(CatalogItemORM.id).where(
                    CatalogItemORM.provider_id == provider_id,
                    CatalogItemORM.source_identifier == graph_name,
                ).limit(1)
            )).scalar_one_or_none()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("alert identity: catalog lookup failed for %s/%s: %s",
                           provider_id, graph_name, exc)

    if provider_id:
        try:
            provider_name = (await session.execute(
                select(ProviderORM.name).where(ProviderORM.id == provider_id)
            )).scalar_one_or_none()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("alert identity: provider lookup failed for %s: %s",
                           provider_id, exc)

    try:
        data_source_label = (await session.execute(
            select(WorkspaceDataSourceORM.label)
            .where(WorkspaceDataSourceORM.id == data_source_id)
        )).scalar_one_or_none()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("alert identity: source lookup failed for %s: %s",
                       data_source_id, exc)

    return AlertIdentity(
        catalog_item_id=catalog_item_id,
        provider_name=provider_name,
        data_source_label=data_source_label,
    )


@dataclass(frozen=True)
class PendingNotice:
    """An alert that was just recorded and still needs its bell rung. Carried
    out of the writing transaction so the fan-out happens after the commit —
    the same discipline the reconcile sweep uses, and for the same reason: a
    notification failure must never roll back the finding it describes."""
    data_source_id: str
    workspace_id: Optional[str]
    catalog_item_id: Optional[str]
    provider_name: Optional[str]
    source_name: str
    severity: str
    direction: str
    node_delta: int
    node_count: int
    #: Which measure moved. Part of the notice, not a detail inside it: "12,400
    #: entities vanished" and "12,400 relationships vanished" are different
    #: incidents with different causes.
    metric: str = "nodes"
    #: ``movement`` | ``type_gone`` | ``silent``.
    finding: str = "movement"
    #: The entity/relationship type a ``type_gone`` notice is about.
    subject_type: Optional[str] = None


def _meets(severity: str, floor: str) -> bool:
    """Does this movement clear the configured floor?

    ``critical`` clears any floor. It means the graph is nearly gone, and
    there is no operator setting for which that is not worth knowing — a floor
    is a noise control, and a wipe is not noise.
    """
    if severity == "critical":
        return True
    return _SEVERITY_RANK.get(severity, 0) >= _SEVERITY_RANK.get(floor, 1)


async def _last_alert_marks(
    session: AsyncSession, ds_id: str, *,
    metric: str = "nodes", finding: str = "movement",
) -> tuple[Optional[str], Optional[str]]:
    """(last detected_at, last observed_at) for this source and finding.

    Scoped to the METRIC as well as the source. Nodes and edges fail
    independently, so a shared cooldown lets an entity incident mute a
    concurrent relationship one — and the relationship failure is the one
    nobody was watching for in the first place.

    BOTH, because the two gates below ask different questions and answering
    either with the wrong timestamp is a bug:

    * The cooldown asks "how long since we last RANG" — that is detection.
    * Novelty asks "has anything happened since the movement we last
      REPORTED" — that is observation.

    Detection always trails observation, because evaluation runs on a tick. So
    comparing a snapshot against the previous DETECTION suppresses every
    movement that arrived between the last incident and the sweep that found
    it — which is exactly when a second, worse movement is most likely.
    """
    row = (await session.execute(
        select(
            func.max(DataSourceCountAlertORM.detected_at),
            func.max(DataSourceCountAlertORM.observed_at),
        ).where(
            DataSourceCountAlertORM.data_source_id == ds_id,
            DataSourceCountAlertORM.metric == metric,
            DataSourceCountAlertORM.finding == finding,
        )
    )).first()
    return (row[0], row[1]) if row else (None, None)


async def _record(
    session: AsyncSession, *, ds_id: str, row, identity, now: datetime,
    severity: str, metric: str, finding: str, delta: int, count: int,
    baseline: int, subject_type: Optional[str] = None,
) -> PendingNotice:
    """Freeze one finding onto the alert table and return its notice.

    The verdict is written once and never re-derived. The baseline moves as
    the window moves, so an alert recomputed later could quietly downgrade
    itself and contradict the notification already sent.
    """
    session.add(DataSourceCountAlertORM(
        id=f"alr_{uuid.uuid4().hex[:12]}",
        data_source_id=ds_id,
        snapshot_id=row.id,
        detected_at=now.isoformat(),
        observed_at=row.captured_at,
        workspace_id=row.workspace_id,
        provider_id=row.provider_id,
        graph_name=row.graph_name,
        catalog_item_id=identity.catalog_item_id,
        provider_name=identity.provider_name,
        data_source_label=identity.data_source_label,
        severity=severity,
        direction="drop" if delta < 0 else "rise",
        metric=metric,
        finding=finding,
        subject_type=subject_type,
        node_delta=delta,
        node_count=count,
        baseline=baseline,
        evidence=row.type_deltas,
    ))
    await session.flush()
    return PendingNotice(
        data_source_id=ds_id,
        workspace_id=row.workspace_id,
        catalog_item_id=identity.catalog_item_id,
        provider_name=identity.provider_name,
        # The source's own label when it has one, falling back to the physical
        # graph name and then to the id — always something a person can match
        # against what they see in the product.
        source_name=identity.data_source_label or row.graph_name or ds_id,
        severity=severity,
        direction="drop" if delta < 0 else "rise",
        node_delta=delta,
        node_count=count,
        metric=metric,
        finding=finding,
        subject_type=subject_type,
    )


def _worst_movement(rows: list, *, metric: str, baseline: int, floor: str):
    """The worst qualifying movement in the window for one metric.

    The WORST, not the most recent. A thrashing source produces several; the
    one worth a person's attention is the biggest, and reporting the latest
    instead would describe the aftershock rather than the event.
    """
    worst, worst_severity = None, "normal"
    for row in rows:
        delta = stats_history_repo.delta_of(row, metric)
        severity = stats_history_repo.classify_significance(
            delta, baseline,
            before=stats_history_repo.count_of(row, metric) - int(delta or 0),
        )
        if not _meets(severity, floor):
            continue
        # Rank first, magnitude second. A wipe on a small graph outranks a
        # merely-severe swing on a huge one, and ordering by magnitude alone
        # would report the second and bury the first.
        if worst is None or (
            _SEVERITY_RANK[severity], abs(delta or 0)
        ) > (
            _SEVERITY_RANK[worst_severity],
            abs(stats_history_repo.delta_of(worst, metric) or 0),
        ):
            worst, worst_severity = row, severity
    return worst, worst_severity


def _types_that_vanished(rows: list) -> Dict[str, tuple]:
    """Types that were present in the window and reached zero, by name.

    A type going to zero is the clearest evidence an external process deleted
    data, and as a fraction of the whole graph it is frequently too small to
    register as unusual movement at all — a 40-type graph losing one type
    moves the total by 2.5%. It is a categorical event, not a magnitude, so it
    cannot be expressed as a multiple of a baseline and was therefore
    invisible to the only detector that existed.

    Returns ``{type_name: (metric, count_before, row_where_it_vanished)}``.
    """
    gone: Dict[str, tuple] = {}
    for field, metric in (
        ("entity_type_counts", "nodes"), ("edge_type_counts", "edges"),
    ):
        previous: Dict[str, int] = {}
        for row in rows:
            # Launder platform-written bookkeeping out of already-stored
            # snapshots. The providers no longer record it, but rows captured
            # before that fix stay readable for the whole retention window —
            # and `_AggMeta` toggles 1 -> 0 -> 1 (MERGEd per aggregation run,
            # wiped by projection seeds and purges), so every dip in that
            # history would raise a SEVERE "type is gone" finding plus a
            # notification about the platform's own node.
            current = strip_derived_counts(
                stats_history_repo.loads_counts(getattr(row, field, None)),
                edges=(field == "edge_type_counts"),
            )
            for name, before in previous.items():
                if before and not current.get(name):
                    # Last writer wins: if a type vanished twice in the window
                    # the later disappearance is the live one.
                    gone[name] = (metric, before, row)
            # A type that came back clears its earlier disappearance.
            for name, value in current.items():
                if value and name in gone:
                    gone.pop(name, None)
            previous = current
    return gone


async def evaluate_source(
    session: AsyncSession,
    ds_id: str,
    policy: AlertPolicy,
    *,
    now: Optional[datetime] = None,
) -> List[PendingNotice]:
    """Judge one source's recent history, recording at most one alert per
    finding per cooldown.

    Returns the notices to ring — possibly several, because nodes, edges and
    a vanished type are independent findings with independent causes, and
    collapsing them into one would report whichever happened to rank highest
    and silently drop the rest.
    """
    now = now or datetime.now(timezone.utc)
    window_from = (now - timedelta(seconds=_LOOKBACK_SECS)).isoformat()
    window_to = now.isoformat()

    rows = await stats_history_repo.list_snapshots(
        session, ds_id, frm=window_from, to=window_to, grain="raw",
    )
    if len(rows) < 2:
        # One observation cannot be a movement. Alerting on a source's first
        # snapshot would fire on every newly onboarded graph.
        return []

    identity = None
    notices: List[PendingNotice] = []
    cooldown_cutoff = (now - timedelta(seconds=policy.cooldown_secs)).isoformat()

    async def _suppressed(metric: str, finding: str, observed_at: str) -> bool:
        last_detected, last_observed = await _last_alert_marks(
            session, ds_id, metric=metric, finding=finding,
        )
        if last_detected and last_detected >= cooldown_cutoff:
            return True
        # Nothing has moved since the incident we already reported. The
        # cooldown elapsing is not new news, and without this gate the same
        # movement re-alerts once per cooldown for as long as it stays inside
        # the lookback window.
        return bool(last_observed and (observed_at or "") <= last_observed)

    # ── movement, judged per metric ──
    for metric in stats_history_repo.METRICS:
        baseline = stats_history_repo.change_baseline(rows, metric)
        worst, severity = _worst_movement(
            rows, metric=metric, baseline=baseline, floor=policy.min_severity,
        )
        if worst is None:
            continue
        if await _suppressed(metric, "movement", worst.captured_at):
            continue
        if identity is None:
            identity = await _identity_for(
                session, data_source_id=ds_id,
                provider_id=worst.provider_id, graph_name=worst.graph_name,
            )
        notices.append(await _record(
            session, ds_id=ds_id, row=worst, identity=identity, now=now,
            severity=severity, metric=metric, finding="movement",
            delta=int(stats_history_repo.delta_of(worst, metric) or 0),
            count=stats_history_repo.count_of(worst, metric),
            baseline=baseline,
        ))

    # ── a type reached zero ──
    for type_name, (metric, before, row) in _types_that_vanished(rows).items():
        if await _suppressed(metric, "type_gone", row.captured_at):
            continue
        if identity is None:
            identity = await _identity_for(
                session, data_source_id=ds_id,
                provider_id=row.provider_id, graph_name=row.graph_name,
            )
        notices.append(await _record(
            session, ds_id=ds_id, row=row, identity=identity, now=now,
            # A type disappearing is severe by construction, not by
            # magnitude: the question "how unusual is this for this source"
            # has no bearing on whether one of its types no longer exists.
            severity="severe", metric=metric, finding="type_gone",
            delta=-int(before),
            count=stats_history_repo.count_of(row, metric),
            baseline=int(before), subject_type=type_name,
        ))

    return notices


async def evaluate_silent_sources(
    session: AsyncSession,
    policy: AlertPolicy,
    *,
    now: Optional[datetime] = None,
) -> List[PendingNotice]:
    """Sources that have stopped reporting at all.

    Not the same as dropping to zero, and invisible to every other detector
    here: those all judge MOVEMENT, and a source that has gone quiet produces
    no movement to judge. An expired credential, a graph dropped on the
    provider, a source rotated out of a cluster — each of these ends the
    series rather than moving it, and a chart of what a source did report
    cannot show the reports that never arrived.

    Deliberately joined against ``workspace_data_sources``: a source that was
    deleted is *supposed* to stop reporting, and alerting on it would make the
    finding worthless within a week of any tidy-up.

    Bounded by the same scan cap as the movement sweep, and it says so when it
    trims — a silent-source check that silently skipped sources would be its
    own joke.
    """
    now = now or datetime.now(timezone.utc)
    # Persisted override first: how patient to be before calling a source
    # silent is a product judgement, and an operator who tuned it expects the
    # sweep to use it.
    silent_after = resilience.PROFILING_SILENT_AFTER_SECS
    try:
        row = await session.get(PlatformSettingsORM, 1)
        if row is not None and getattr(row, "profiling_silent_after_secs", None):
            silent_after = row.profiling_silent_after_secs
    except Exception:  # noqa: BLE001 - policy must never break the sweep
        logger.warning("silent_sweep: settings unreadable; using env default")
    cutoff = (
        now - timedelta(seconds=max(60, int(silent_after)))
    ).isoformat()

    last_seen = (
        select(
            DataSourceCountSnapshotORM.data_source_id.label("ds_id"),
            func.max(DataSourceCountSnapshotORM.captured_at).label("last_at"),
        )
        .group_by(DataSourceCountSnapshotORM.data_source_id)
        .subquery()
    )
    rows = (await session.execute(
        select(
            last_seen.c.ds_id, last_seen.c.last_at,
            WorkspaceDataSourceORM.workspace_id,
            WorkspaceDataSourceORM.provider_id,
            WorkspaceDataSourceORM.graph_name,
        )
        .join(
            WorkspaceDataSourceORM,
            WorkspaceDataSourceORM.id == last_seen.c.ds_id,
        )
        .where(
            last_seen.c.last_at < cutoff,
            WorkspaceDataSourceORM.deleted_at.is_(None),
            WorkspaceDataSourceORM.is_active.is_(True),
        )
        .order_by(last_seen.c.last_at.asc())
        .limit(_SOURCE_SCAN_CAP + 1)
    )).all()

    if len(rows) > _SOURCE_SCAN_CAP:
        logger.warning(
            "silent_sweep: more than %d silent sources; judging the %d "
            "quietest this pass",
            _SOURCE_SCAN_CAP, _SOURCE_SCAN_CAP,
        )
        rows = rows[:_SOURCE_SCAN_CAP]

    notices: List[PendingNotice] = []
    cooldown_cutoff = (now - timedelta(seconds=policy.cooldown_secs)).isoformat()
    for ds_id, last_at, workspace_id, provider_id, graph_name in rows:
        last_detected, last_observed = await _last_alert_marks(
            session, ds_id, metric="nodes", finding="silent",
        )
        if last_detected and last_detected >= cooldown_cutoff:
            continue
        # Novelty against the observation, as everywhere else: re-alerting on
        # the same silence once per cooldown is how an outage becomes noise.
        if last_observed and (last_at or "") <= last_observed:
            continue

        identity = await _identity_for(
            session, data_source_id=ds_id,
            provider_id=provider_id, graph_name=graph_name,
        )
        session.add(DataSourceCountAlertORM(
            id=f"alr_{uuid.uuid4().hex[:12]}",
            data_source_id=ds_id,
            snapshot_id=None,
            detected_at=now.isoformat(),
            observed_at=last_at,
            workspace_id=workspace_id,
            provider_id=provider_id,
            graph_name=graph_name,
            catalog_item_id=identity.catalog_item_id,
            provider_name=identity.provider_name,
            data_source_label=identity.data_source_label,
            severity="severe",
            # A silence is a loss of information, not a rise in it.
            direction="drop",
            metric="nodes",
            finding="silent",
            node_delta=0,
            node_count=0,
            baseline=0,
            evidence=None,
        ))
        await session.flush()
        notices.append(PendingNotice(
            data_source_id=ds_id,
            workspace_id=workspace_id,
            catalog_item_id=identity.catalog_item_id,
            provider_name=identity.provider_name,
            source_name=identity.data_source_label or graph_name or ds_id,
            severity="severe",
            direction="drop",
            node_delta=0,
            node_count=0,
            metric="nodes",
            finding="silent",
        ))
    return notices


async def sources_to_evaluate(
    session: AsyncSession, *, now: Optional[datetime] = None,
) -> List[str]:
    """Sources with a snapshot inside the lookback window.

    Scoped by recency rather than listing the fleet: a source nobody has
    observed in a day has produced no movement to judge, and walking it would
    spend the pass's budget on sources that cannot possibly qualify.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(seconds=_LOOKBACK_SECS)).isoformat()
    # MOST RECENTLY ACTIVE FIRST, and the ordering is the point. An unordered
    # LIMIT hands back an arbitrary slice, so on a fleet larger than the cap
    # the same sources would be judged every pass and the rest never — silently,
    # since a source that is never evaluated looks exactly like one that never
    # moved. Ordering by last observation puts the sources that just changed at
    # the head, which is where an anomaly can only ever be.
    rows = (await session.execute(
        select(
            DataSourceCountSnapshotORM.data_source_id,
            func.max(DataSourceCountSnapshotORM.captured_at).label("last_seen"),
        )
        .where(DataSourceCountSnapshotORM.captured_at >= cutoff)
        .group_by(DataSourceCountSnapshotORM.data_source_id)
        .order_by(func.max(DataSourceCountSnapshotORM.captured_at).desc())
        .limit(_SOURCE_SCAN_CAP + 1)
    )).all()

    if len(rows) > _SOURCE_SCAN_CAP:
        # Never a silent cap: a bounded pass that says nothing reads as a quiet
        # fleet, which is the one thing an alerting system must not do.
        logger.warning(
            "alert_sweep: more than %d sources active in the lookback window; "
            "judging the %d most recently observed and deferring the rest to "
            "the next pass",
            _SOURCE_SCAN_CAP, _SOURCE_SCAN_CAP,
        )
    return [r[0] for r in rows[:_SOURCE_SCAN_CAP]]


# ── reads ────────────────────────────────────────────────────────────


async def list_alerts(
    session: AsyncSession,
    *,
    data_source_id: Optional[str] = None,
    data_source_ids: Optional[Set[str]] = None,
    unacknowledged_only: bool = False,
    limit: int = 100,
) -> List[DataSourceCountAlertORM]:
    """Newest first. Scoped to one source, or the whole fleet.

    ``data_source_ids`` is the caller's TENANT scope and is separate from
    ``data_source_id``, which is a filter the caller chose. ``None`` means
    unrestricted (a platform operator); an EMPTY set means a caller who may see
    nothing, and must therefore be given nothing.

    Applied in SQL, not after the read, because ``limit`` would otherwise be
    spent on rows the caller is not allowed to see — a workspace user would get
    a short page, or an empty one, while alerts they own sat just past the cut.
    """
    stmt = select(DataSourceCountAlertORM)
    if data_source_id:
        stmt = stmt.where(DataSourceCountAlertORM.data_source_id == data_source_id)
    if data_source_ids is not None:
        stmt = stmt.where(
            DataSourceCountAlertORM.data_source_id.in_(data_source_ids)
        )
    if unacknowledged_only:
        stmt = stmt.where(DataSourceCountAlertORM.acknowledged_at.is_(None))
    stmt = stmt.order_by(DataSourceCountAlertORM.detected_at.desc()).limit(limit)
    return list((await session.execute(stmt)).scalars().all())


async def acknowledge(
    session: AsyncSession, alert_id: str, *, actor_id: Optional[str],
) -> Optional[DataSourceCountAlertORM]:
    """Mark one alert as seen. Idempotent, and the FIRST acknowledgement wins —
    re-acknowledging must not rewrite who actually looked at it."""
    row = await session.get(DataSourceCountAlertORM, alert_id)
    if row is None:
        return None
    if row.acknowledged_at is None:
        row.acknowledged_at = datetime.now(timezone.utc).isoformat()
        row.acknowledged_by = actor_id
        await session.flush()
    return row


async def purge_alerts(
    session: AsyncSession, *, retention_days: int, batch: int = 1000,
) -> int:
    """Drop acknowledged alerts past the retention window.

    UNACKNOWLEDGED alerts are never purged by age. An alert nobody has looked
    at is the one piece of this whole feature that must not disappear quietly
    — that is the difference between a retention policy and losing the finding.
    """
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=max(1, retention_days))
    ).isoformat()
    doomed = (await session.execute(
        select(DataSourceCountAlertORM.id)
        .where(
            DataSourceCountAlertORM.detected_at < cutoff,
            DataSourceCountAlertORM.acknowledged_at.isnot(None),
        )
        .limit(batch)
    )).scalars().all()
    if not doomed:
        return 0
    await session.execute(
        delete(DataSourceCountAlertORM)
        .where(DataSourceCountAlertORM.id.in_(list(doomed)))
    )
    return len(doomed)


__all__: Sequence[str] = (
    "AlertPolicy",
    "AlertIdentity",
    "PendingNotice",
    "acknowledge",
    "env_alert_policy",
    "evaluate_silent_sources",
    "evaluate_source",
    "list_alerts",
    "purge_alerts",
    "resolve_alert_policy",
    "sources_to_evaluate",
)


async def get_alert(
    session: AsyncSession, alert_id: str,
) -> Optional[DataSourceCountAlertORM]:
    """One alert by id, or None.

    Exists so a caller can check WHO an alert belongs to before acting on it.
    ``acknowledge`` deliberately does not take a tenant scope: mixing "find it"
    with "may I have it" in one query makes the authorisation invisible at the
    call site, and this is a mutation of shared state — acknowledging silences
    the alert for everyone it was raised to.
    """
    return await session.get(DataSourceCountAlertORM, alert_id)
