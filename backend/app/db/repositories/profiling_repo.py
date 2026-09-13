"""Profiling storage: the compacted tiers and the retention that feeds them.

`data_source_count_snapshots` is the raw record of what was observed.
`data_source_count_rollups` is the record of what a PERIOD looked like, built
from raw before raw is deleted.

**Why compaction exists at all.** Retention used to be an age cutoff plus a
per-source row cap. The cap is a real safety valve — a source thrashing under a
broken loader changes on every 60s probe, which is ~43k rows a month — but it
bounds ROWS, and rows are not days. A source moving that hard hits its cap in
under a week, so the cap silently evicts exactly the source whose 30-day
history someone would come looking for. Compacting inverts that: a day bucket
is one row however violently the source moved inside it, so coverage stops
being a function of volatility.

**Per source only.** Workspace, provider and platform series are sums of these
rows at read time. Materialising those scopes as their own rows would be four
things to keep in agreement plus a membership ledger, and a membership ledger
that drifts is how :AGGREGATED weights got silently double-counted once
already. A sum over an indexed range is fast; a wrong number is not.

**The watermark is the data.** There is no cursor table. A grain's watermark is
`MAX(bucket_start)` already in the rollup table, and each pass restarts one
bucket BEFORE it — so the bucket that was trailing (and therefore incomplete)
when the last pass ran is rebuilt with the raw that has arrived since. The
upsert on `uq_dscr_bucket` makes that refinement, not duplication, which is
what lets a pass killed halfway simply be re-run.

**Purge never outruns compaction.** `raw_purge_cutoff` is the EARLIER of the
raw retention cutoff and the hour watermark. If compaction stalls, raw stops
being deleted rather than being deleted uncompacted — the failure mode is a
table that grows, which is visible and recoverable, instead of observations
that silently never made it into a tier.
"""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import case, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.derived_artifacts import strip_derived_counts
from backend.app.db.models import (
    DataSourceCountRollupORM,
    DataSourceCountSnapshotORM,
)

logger = logging.getLogger(__name__)

_SNAP = DataSourceCountSnapshotORM
_ROLL = DataSourceCountRollupORM

#: Prefix lengths that turn an ISO instant into a bucket key. ISO timestamps
#: are lexically ordered, so a bucket is a prefix — no date parsing, no
#: timezone maths, and identical on Postgres and the SQLite the tests use.
_GRAIN_PREFIX = {"hour": 13, "day": 10}

#: How a bucket key is padded back into a parseable instant.
_GRAIN_SUFFIX = {"hour": ":00:00+00:00", "day": "T00:00:00+00:00"}

_GRAIN_DELTA = {"hour": timedelta(hours=1), "day": timedelta(days=1)}

#: Reasons that represent something happening rather than a continuity tick.
#: ``first`` counts: a source appearing is an event.
_EVENTFUL = ("first", "changed", "run")

#: Most buckets one compaction pass will build. Bounds a first-run backfill
#: over months of raw into many short passes instead of one long one, and
#: makes every pass interruptible.
DEFAULT_MAX_BUCKETS = 48

#: Rows per INSERT. Bounds the statement size during a backfill, where one
#: window spans many buckets across every source at once.
_UPSERT_CHUNK = 1000


def bucket_key(instant: str, grain: str) -> str:
    """The bucket an ISO instant falls in, as its prefix."""
    return (instant or "")[: _GRAIN_PREFIX.get(grain, 10)]


def bucket_instant(key: str, grain: str) -> str:
    """Pad a bucket key back into a full parseable instant."""
    return f"{key}{_GRAIN_SUFFIX.get(grain, 'T00:00:00+00:00')}"


def _bucket_expr(column, grain: str):
    return func.substr(column, 1, _GRAIN_PREFIX.get(grain, 10))


def loads_counts(raw: Any) -> Dict[str, int]:
    """Parse a stored JSON counts column. Unparseable → empty: a corrupt
    column must degrade to "we knew nothing", never blow up a pass."""
    if isinstance(raw, dict):
        return {str(k): int(v or 0) for k, v in raw.items()}
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: Dict[str, int] = {}
    for k, v in parsed.items():
        try:
            out[str(k)] = int(v or 0)
        except (TypeError, ValueError):
            continue
    return out


# ── retention policy ─────────────────────────────────────────────────

_MIN_DAYS = 1


@dataclass(frozen=True)
class RetentionPolicy:
    """How long each tier is kept.

    The tiers are nested in coverage, not exclusive: raw covers the most
    recent stretch at full fidelity, hourly a longer one, daily the longest.
    A read picks the coarsest tier that still answers the question, so a
    90-day window never touches raw.
    """

    raw_days: int
    hourly_days: int
    daily_days: int
    max_rows_per_source: int

    def cutoff(self, tier: str, *, now: Optional[datetime] = None) -> str:
        days = {
            "raw": self.raw_days,
            "hour": self.hourly_days,
            "day": self.daily_days,
        }[tier]
        base = now or datetime.now(timezone.utc)
        return (base - timedelta(days=max(_MIN_DAYS, days))).isoformat()


def env_retention_policy() -> RetentionPolicy:
    from backend.app.config import resilience as _cfg

    return RetentionPolicy(
        raw_days=max(_MIN_DAYS, int(_cfg.PROFILING_RAW_RETENTION_DAYS)),
        hourly_days=max(_MIN_DAYS, int(_cfg.PROFILING_HOURLY_RETENTION_DAYS)),
        daily_days=max(_MIN_DAYS, int(_cfg.PROFILING_DAILY_RETENTION_DAYS)),
        max_rows_per_source=max(1, int(_cfg.PROFILING_MAX_ROWS_PER_SOURCE)),
    )


#: The retention half of the policy. The alert half resolves separately in
#: ``count_alerts_repo``, because the two are read by different callers on
#: different cadences and neither should have to load the other.
_RETENTION_FIELDS = (
    "rawRetentionDays", "hourlyRetentionDays", "dailyRetentionDays",
    "maxRowsPerSource", "heartbeatSecs", "silentAfterSecs",
)


class PolicyConflict(ValueError):
    """A saved policy that would not mean what it says."""


def validate_policy(values: Dict[str, Any], current: "RetentionPolicy") -> None:
    """Reject a policy whose tiers do not nest.

    Coverage has to be monotonic — daily reaches at least as far back as
    hourly, hourly at least as far as raw — because a read picks the finest
    tier that COVERS the window. Inverting them leaves windows that no tier
    can answer while every tier still holds rows, which looks like data loss
    and is really a settings mistake.

    Rejected rather than clamped: silently rewriting a number someone typed
    is how a settings page becomes untrustworthy.
    """
    def _effective(field: str, fallback: int) -> int:
        value = values.get(field)
        if value is None or value == INHERIT:
            return fallback
        return int(value)

    raw = _effective("rawRetentionDays", current.raw_days)
    hourly = _effective("hourlyRetentionDays", current.hourly_days)
    daily = _effective("dailyRetentionDays", current.daily_days)

    if hourly < raw:
        raise PolicyConflict(
            f"Hourly retention ({hourly}d) must reach at least as far back as "
            f"raw ({raw}d) — hourly buckets are built from raw before it is purged."
        )
    if daily < hourly:
        raise PolicyConflict(
            f"Daily retention ({daily}d) must reach at least as far back as "
            f"hourly ({hourly}d) — daily buckets are built from hourly."
        )


async def resolve_retention_policy(
    session: AsyncSession,
) -> Tuple[RetentionPolicy, Dict[str, Any]]:
    """``persisted ?? env`` plus the overrides that were actually set.

    Returning both is what lets the UI say "45 days (inherited)" rather than
    pinning the environment default the first time anyone opens the dialog and
    saves without changing anything — a no-op save that silently freezes a
    deployment default is a trap this shape avoids.

    Never raises: a settings row that cannot be read must degrade to the
    environment defaults, not fail a read that has nothing to do with policy.
    """
    from backend.app.db.models import PlatformSettingsORM

    env = env_retention_policy()
    try:
        row = await session.get(PlatformSettingsORM, 1)
    except Exception:  # noqa: BLE001 - policy must never break a read
        logger.warning("profiling: platform settings unreadable; using env")
        return env, {}
    if row is None:
        return env, {}

    overrides = {
        field: getattr(row, column, None)
        for field, column in _POLICY_COLUMNS.items()
        if field in _RETENTION_FIELDS
    }
    overrides = {k: v for k, v in overrides.items() if v is not None}
    return RetentionPolicy(
        raw_days=max(_MIN_DAYS, overrides.get("rawRetentionDays", env.raw_days)),
        hourly_days=max(
            _MIN_DAYS, overrides.get("hourlyRetentionDays", env.hourly_days),
        ),
        daily_days=max(
            _MIN_DAYS, overrides.get("dailyRetentionDays", env.daily_days),
        ),
        max_rows_per_source=max(
            1, overrides.get("maxRowsPerSource", env.max_rows_per_source),
        ),
    ), overrides


# ── compaction ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Bucket:
    """One source's aggregate over one bucket, before it is written."""

    data_source_id: str
    bucket_start: str
    workspace_id: Optional[str]
    provider_id: Optional[str]
    graph_name: Optional[str]
    node_count: int
    edge_count: int
    entity_type_counts: str
    edge_type_counts: str
    node_min: int
    node_max: int
    edge_min: int
    edge_max: int
    observations: int
    changed_observations: int


async def _watermark(session: AsyncSession, grain: str) -> Optional[str]:
    """The newest bucket already built for this grain, or None."""
    return (await session.execute(
        select(func.max(_ROLL.bucket_start)).where(_ROLL.grain == grain)
    )).scalar()


async def _next_window(
    session: AsyncSession, *, grain: str, floor: Optional[str],
    now: datetime, max_buckets: int,
) -> Optional[Tuple[str, str]]:
    """The [since, until) bucket keys this pass will rebuild.

    Bounded by BUCKETS THAT HOLD DATA, not by calendar span, and that is the
    load-bearing detail. Advancing a fixed number of hours per pass stalls
    forever on a gap: a stretch with no observations longer than one window
    produces zero buckets, so the watermark never moves past it — and because
    raw may not be purged beyond the watermark, retention wedges with it. A
    source that was offline for a fortnight would permanently freeze the tier.
    Selecting the next N non-empty buckets steps over any gap in one pass.

    Keys, not padded instants. The source columns hold values of two widths:
    raw ``captured_at`` is a full ISO instant, an hour rollup's
    ``bucket_start`` is a 13-char prefix. Comparing a 13-char key against a
    padded ``2026-08-23T00:00:00+00:00`` sorts the key BEFORE the bound (equal
    prefix, shorter string first), which dropped every midnight bucket out of
    its own day.
    """
    if grain == "hour":
        column, extra = _SNAP.captured_at, None
    else:
        column, extra = _ROLL.bucket_start, (_ROLL.grain == "hour")

    bucket = _bucket_expr(column, grain).label("bucket")
    stmt = select(bucket).distinct().order_by(bucket).limit(max_buckets)
    if extra is not None:
        stmt = stmt.where(extra)
    if floor:
        stmt = stmt.where(column >= floor)

    keys = [k for k in (await session.execute(stmt)).scalars().all() if k]
    if not keys:
        return None

    last = _parse(bucket_instant(keys[-1], grain))
    if last is None:
        return None
    # Half-open: the bucket AFTER the last one selected.
    until = bucket_key((last + _GRAIN_DELTA[grain]).isoformat(), grain)
    return keys[0], until


def _parse(instant: Optional[str]) -> Optional[datetime]:
    if not instant:
        return None
    try:
        parsed = datetime.fromisoformat(instant)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


async def _buckets_from_raw(
    session: AsyncSession, *, grain: str, since: str, until: str,
) -> List[_Bucket]:
    """Aggregate raw snapshots into buckets.

    Two passes over the same range rather than one query mixing window and
    aggregate functions: the row counts here are (sources x buckets), which is
    small, and two readable statements beat one that behaves differently on
    two dialects.
    """
    bucket = _bucket_expr(_SNAP.captured_at, grain)

    extremes = (await session.execute(
        select(
            _SNAP.data_source_id, bucket.label("bucket"),
            func.min(_SNAP.node_count), func.max(_SNAP.node_count),
            func.min(_SNAP.edge_count), func.max(_SNAP.edge_count),
            func.count(_SNAP.id),
            func.sum(
                case((_SNAP.capture_reason.in_(_EVENTFUL), 1), else_=0)
            ),
        )
        .where(_SNAP.captured_at >= since, _SNAP.captured_at < until)
        .group_by(_SNAP.data_source_id, bucket)
    )).all()
    if not extremes:
        return []

    agg = {
        (r[0], r[1]): (
            int(r[2] or 0), int(r[3] or 0), int(r[4] or 0), int(r[5] or 0),
            int(r[6] or 0), int(r[7] or 0),
        )
        for r in extremes
    }

    # Closing row per (source, bucket): the value the bucket ended on.
    ranked = (
        select(
            _SNAP.data_source_id, bucket.label("bucket"),
            _SNAP.workspace_id, _SNAP.provider_id, _SNAP.graph_name,
            _SNAP.node_count, _SNAP.edge_count,
            _SNAP.entity_type_counts, _SNAP.edge_type_counts,
            func.row_number().over(
                partition_by=(_SNAP.data_source_id, bucket),
                order_by=_SNAP.captured_at.desc(),
            ).label("rn"),
        )
        .where(_SNAP.captured_at >= since, _SNAP.captured_at < until)
        .subquery()
    )
    closing = (await session.execute(
        select(ranked).where(ranked.c.rn == 1)
    )).all()

    out: List[_Bucket] = []
    for r in closing:
        key = (r.data_source_id, r.bucket)
        n_min, n_max, e_min, e_max, obs, changed = agg.get(
            key, (r.node_count, r.node_count, r.edge_count, r.edge_count, 1, 0),
        )
        out.append(_Bucket(
            data_source_id=r.data_source_id,
            bucket_start=r.bucket,
            workspace_id=r.workspace_id,
            provider_id=r.provider_id,
            graph_name=r.graph_name,
            node_count=int(r.node_count or 0),
            edge_count=int(r.edge_count or 0),
            entity_type_counts=r.entity_type_counts or "{}",
            edge_type_counts=r.edge_type_counts or "{}",
            node_min=n_min, node_max=n_max, edge_min=e_min, edge_max=e_max,
            observations=obs, changed_observations=changed,
        ))
    return out


async def _buckets_from_hourly(
    session: AsyncSession, *, since: str, until: str,
) -> List[_Bucket]:
    """Aggregate hour rollups into day rollups.

    Built from hourly rather than raw so a day bucket survives the raw purge —
    which is the whole point of the tier existing.
    """
    bucket = _bucket_expr(_ROLL.bucket_start, "day")

    extremes = (await session.execute(
        select(
            _ROLL.data_source_id, bucket.label("bucket"),
            func.min(_ROLL.node_min), func.max(_ROLL.node_max),
            func.min(_ROLL.edge_min), func.max(_ROLL.edge_max),
            func.sum(_ROLL.observations), func.sum(_ROLL.changed_observations),
        )
        .where(
            _ROLL.grain == "hour",
            _ROLL.bucket_start >= since, _ROLL.bucket_start < until,
        )
        .group_by(_ROLL.data_source_id, bucket)
    )).all()
    if not extremes:
        return []

    agg = {
        (r[0], r[1]): (
            int(r[2] or 0), int(r[3] or 0), int(r[4] or 0), int(r[5] or 0),
            int(r[6] or 0), int(r[7] or 0),
        )
        for r in extremes
    }

    ranked = (
        select(
            _ROLL.data_source_id, bucket.label("bucket"),
            _ROLL.workspace_id, _ROLL.provider_id, _ROLL.graph_name,
            _ROLL.node_count, _ROLL.edge_count,
            _ROLL.entity_type_counts, _ROLL.edge_type_counts,
            func.row_number().over(
                partition_by=(_ROLL.data_source_id, bucket),
                order_by=_ROLL.bucket_start.desc(),
            ).label("rn"),
        )
        .where(
            _ROLL.grain == "hour",
            _ROLL.bucket_start >= since, _ROLL.bucket_start < until,
        )
        .subquery()
    )
    closing = (await session.execute(
        select(ranked).where(ranked.c.rn == 1)
    )).all()

    out: List[_Bucket] = []
    for r in closing:
        key = (r.data_source_id, r.bucket)
        n_min, n_max, e_min, e_max, obs, changed = agg.get(
            key, (r.node_count, r.node_count, r.edge_count, r.edge_count, 1, 0),
        )
        out.append(_Bucket(
            data_source_id=r.data_source_id,
            bucket_start=r.bucket,
            workspace_id=r.workspace_id,
            provider_id=r.provider_id,
            graph_name=r.graph_name,
            node_count=int(r.node_count or 0),
            edge_count=int(r.edge_count or 0),
            entity_type_counts=r.entity_type_counts or "{}",
            edge_type_counts=r.edge_type_counts or "{}",
            node_min=n_min, node_max=n_max, edge_min=e_min, edge_max=e_max,
            observations=obs, changed_observations=changed,
        ))
    return out


async def _previous_closings(
    session: AsyncSession, *, grain: str,
    first_bucket_by_source: Dict[str, str],
) -> Dict[str, Tuple[int, int]]:
    """The closing counts of the bucket immediately before each given one.

    Read from the rollup table, so a delta is against the previous BUCKET
    rather than the previous observation — which is what makes a day's movement
    mean "how much did this change over the day".
    """
    if not first_bucket_by_source:
        return {}
    wanted = set(first_bucket_by_source)
    earliest = min(first_bucket_by_source.values())
    rows = (await session.execute(
        select(
            _ROLL.data_source_id, _ROLL.bucket_start,
            _ROLL.node_count, _ROLL.edge_count,
        )
        .where(
            _ROLL.grain == grain,
            _ROLL.data_source_id.in_(list(wanted)),
            _ROLL.bucket_start < earliest,
        )
        .order_by(_ROLL.data_source_id, _ROLL.bucket_start.desc())
    )).all()
    # Newest-first per source; the first row seen for a source is its latest
    # bucket before the range, which is the baseline the range starts from.
    latest: Dict[str, Tuple[int, int]] = {}
    for ds_id, _bucket, nodes, edges in rows:
        if ds_id not in latest:
            latest[ds_id] = (int(nodes or 0), int(edges or 0))
    return latest


async def _upsert(
    session: AsyncSession, *, grain: str, buckets: Sequence[_Bucket],
    now_iso: str,
) -> int:
    """Write buckets, refining any that already exist.

    Dialect-aware ON CONFLICT rather than read-then-write: the pass must be
    safe to re-run, and a check-then-insert race between two schedulers would
    violate the unique constraint instead of converging.
    """
    if not buckets:
        return 0

    dialect = session.get_bind().dialect.name
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as _insert
    else:
        from sqlalchemy.dialects.postgresql import insert as _insert

    # Deltas need the bucket before each one. Within this batch the previous
    # bucket may be in the batch itself, so resolve in bucket order and carry
    # the running value forward.
    ordered = sorted(buckets, key=lambda b: (b.data_source_id, b.bucket_start))
    firsts = {}
    for b in ordered:
        firsts.setdefault(b.data_source_id, b.bucket_start)
    carry: Dict[str, Tuple[int, int]] = dict(await _previous_closings(
        session, grain=grain, first_bucket_by_source=firsts,
    ))
    payload = []
    for b in ordered:
        prev = carry.get(b.data_source_id)
        payload.append({
            "id": f"rlp_{uuid.uuid4().hex[:12]}",
            "data_source_id": b.data_source_id,
            "grain": grain,
            "bucket_start": b.bucket_start,
            "workspace_id": b.workspace_id,
            "provider_id": b.provider_id,
            "graph_name": b.graph_name,
            "node_count": b.node_count,
            "edge_count": b.edge_count,
            "entity_type_counts": b.entity_type_counts,
            "edge_type_counts": b.edge_type_counts,
            "node_min": b.node_min, "node_max": b.node_max,
            "edge_min": b.edge_min, "edge_max": b.edge_max,
            "node_delta": None if prev is None else b.node_count - prev[0],
            "edge_delta": None if prev is None else b.edge_count - prev[1],
            "observations": b.observations,
            "changed_observations": b.changed_observations,
            "compacted_at": now_iso,
        })
        carry[b.data_source_id] = (b.node_count, b.edge_count)

    # Chunked: a backfill window is (buckets x sources) rows, which on a large
    # estate is one enormous INSERT holding a long lock on a table the read
    # path is serving from.
    for start in range(0, len(payload), _UPSERT_CHUNK):
        chunk = payload[start : start + _UPSERT_CHUNK]
        stmt = _insert(_ROLL).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["data_source_id", "grain", "bucket_start"],
            set_={
                c: getattr(stmt.excluded, c)
                for c in (
                    "workspace_id", "provider_id", "graph_name",
                    "node_count", "edge_count",
                    "entity_type_counts", "edge_type_counts",
                    "node_min", "node_max", "edge_min", "edge_max",
                    "node_delta", "edge_delta",
                    "observations", "changed_observations", "compacted_at",
                )
            },
        )
        await session.execute(stmt)
    return len(payload)


async def compact(
    session: AsyncSession, *, grain: str, now: Optional[datetime] = None,
    max_buckets: int = DEFAULT_MAX_BUCKETS,
) -> int:
    """Build one bounded batch of ``grain`` buckets. Returns rows written.

    Idempotent and resumable: the window is derived from the rollup table
    itself and the write is an upsert, so a pass killed halfway is simply
    re-run, and a pass over a range already built rewrites the same values.
    """
    if grain not in _GRAIN_PREFIX:
        raise ValueError(f"unsupported grain: {grain!r}")

    at = now or datetime.now(timezone.utc)
    # Resume from the watermark bucket itself, not after it: it was the
    # trailing bucket when it was written and may still be filling, so it is
    # rebuilt rather than trusted. Anything older is settled.
    window = await _next_window(
        session, grain=grain,
        floor=await _watermark(session, grain),
        now=at, max_buckets=max_buckets,
    )
    if window is None:
        return 0
    since, until = window

    buckets = (
        await _buckets_from_raw(session, grain=grain, since=since, until=until)
        if grain == "hour"
        else await _buckets_from_hourly(session, since=since, until=until)
    )
    return await _upsert(
        session, grain=grain, buckets=buckets, now_iso=at.isoformat(),
    )


# ── purge ────────────────────────────────────────────────────────────


async def raw_purge_cutoff(
    session: AsyncSession, policy: RetentionPolicy, *,
    now: Optional[datetime] = None,
) -> str:
    """How far back raw may be deleted, bounded by what has been compacted.

    The EARLIER of the retention cutoff and the hour watermark. If compaction
    stalls, raw stops being deleted rather than being deleted uncompacted: a
    table that grows is visible and recoverable, observations that silently
    never reached a tier are not.
    """
    cutoff = policy.cutoff("raw", now=now)
    watermark = await _watermark(session, "hour")
    if watermark is None:
        # Nothing compacted yet — deleting raw now would delete it forever.
        return ""
    # The watermark bucket itself is still being refined, so raw may only be
    # deleted up to its START: bare key, compared against full ISO instants.
    return min(cutoff, watermark)


async def purge_raw(
    session: AsyncSession, *, cutoff: str, batch: int = 5000,
) -> int:
    """Delete raw snapshots older than ``cutoff``. Returns rows deleted."""
    if not cutoff:
        return 0
    doomed = (await session.execute(
        select(_SNAP.id).where(_SNAP.captured_at < cutoff).limit(batch)
    )).scalars().all()
    if not doomed:
        return 0
    await session.execute(delete(_SNAP).where(_SNAP.id.in_(list(doomed))))
    return len(doomed)


async def purge_rollups(
    session: AsyncSession, *, grain: str, cutoff: str, batch: int = 5000,
) -> int:
    """Delete rollups of one grain older than ``cutoff``."""
    if not cutoff:
        return 0
    doomed = (await session.execute(
        select(_ROLL.id)
        .where(_ROLL.grain == grain, _ROLL.bucket_start < cutoff)
        .limit(batch)
    )).scalars().all()
    if not doomed:
        return 0
    await session.execute(delete(_ROLL).where(_ROLL.id.in_(list(doomed))))
    return len(doomed)


async def purge_over_cap(
    session: AsyncSession, *, max_rows_per_source: int, batch: int = 5000,
) -> int:
    """Trim each source back to its newest N RAW snapshots.

    A raw-tier safety valve, and only that. It bounds how much one source
    thrashing under a broken loader can contribute between retention passes —
    43k rows a month for a graph changing on every 60s probe. It no longer
    decides how far back history goes: that is the rollup tiers' job, which is
    the whole reason they exist. Trimming raw here cannot shorten coverage,
    because the buckets were built before raw became eligible for deletion.

    Deliberately id-based rather than a window-function DELETE — the same
    statement then runs unchanged on the SQLite the tests use.
    """
    cap = max(1, max_rows_per_source)
    over = (await session.execute(
        select(_SNAP.data_source_id)
        .group_by(_SNAP.data_source_id)
        .having(func.count(_SNAP.id) > cap)
    )).scalars().all()

    removed = 0
    for ds_id in over:
        if removed >= batch:
            break
        keep = (await session.execute(
            select(_SNAP.id)
            .where(_SNAP.data_source_id == ds_id)
            .order_by(_SNAP.captured_at.desc())
            .limit(cap)
        )).scalars().all()
        doomed = (await session.execute(
            select(_SNAP.id)
            .where(_SNAP.data_source_id == ds_id, _SNAP.id.notin_(list(keep)))
            .limit(batch - removed)
        )).scalars().all()
        if not doomed:
            continue
        await session.execute(delete(_SNAP).where(_SNAP.id.in_(list(doomed))))
        removed += len(doomed)
    return removed


async def run_retention(
    session: AsyncSession, policy: RetentionPolicy, *,
    now: Optional[datetime] = None, batch: int = 5000,
) -> Dict[str, int]:
    """One retention pass across all three tiers.

    Order matters: compaction has already run by the time this is called, and
    raw is bounded by the watermark, so nothing is deleted before it has been
    rolled up.
    """
    at = now or datetime.now(timezone.utc)
    return {
        "raw": await purge_raw(
            session,
            cutoff=await raw_purge_cutoff(session, policy, now=at),
            batch=batch,
        ),
        "over_cap": await purge_over_cap(
            session, max_rows_per_source=policy.max_rows_per_source, batch=batch,
        ),
        "hour": await purge_rollups(
            session, grain="hour", cutoff=policy.cutoff("hour", now=at),
            batch=batch,
        ),
        "day": await purge_rollups(
            session, grain="day", cutoff=policy.cutoff("day", now=at),
            batch=batch,
        ),
    }


# ── reads ────────────────────────────────────────────────────────────
#
# Every read picks the COARSEST tier that still answers the question, and
# aggregate scopes never touch raw. The previous implementation ranked every
# raw row in the window with a window function and no LIMIT: at platform scope
# over 90 days that is (sources x rows-per-source) rows ranked to produce a few
# hundred points, which is the shape of a request that appears to hang.

#: Windows at or under this many hours may be served raw. Above it the point
#: budget stops being about fidelity and starts being about transport.
_RAW_WINDOW_HOURS = 48

#: Above this many hours, day buckets. Between the two, hour buckets.
_HOUR_WINDOW_HOURS = 14 * 24

SCOPES = ("source", "workspace", "provider", "all")


#: Points a chart can carry before density stops adding information and starts
#: costing transport. Generous: the value of this view is seeing the exact
#: moment something changed.
_POINT_BUDGET = 720

#: The incident window gets a bigger allowance — one point a minute for a day.
#:
#: "When did this happen" is asked about the last day far more than about the
#: last quarter, and a busy source can capture more than 720 times in 24 hours
#: once the heartbeat tracks the poll. Falling to hour grain there would bucket
#: away movement that was captured, in exactly the window someone opened to
#: find it. Longer windows keep the tighter budget: at 90 days nobody is
#: reading individual minutes, and the rollups carry min/max so an intra-bucket
#: dip still shows.
_SHORT_WINDOW_HOURS = 26
_SHORT_WINDOW_BUDGET = 1500


def resolve_grain(frm: str, to: str, requested: Optional[str]) -> str:
    """Coarsest-first fallback when the caller asked for something specific,
    or when no session is available to measure density with."""
    if requested in ("raw", "hour", "day"):
        return requested
    start, end = _parse(frm), _parse(to)
    if start is None or end is None:
        return "hour"
    hours = max(0.0, (end - start).total_seconds() / 3600.0)
    if hours <= _RAW_WINDOW_HOURS:
        return "raw"
    if hours <= _HOUR_WINDOW_HOURS:
        return "hour"
    return "day"


async def choose_grain(
    session: AsyncSession, *, scope: str, scope_id: Optional[str],
    visible: Optional[Sequence[str]], frm: str, to: str,
    requested: Optional[str], policy: Optional[RetentionPolicy] = None,
) -> str:
    """Pick the finest tier that both COVERS the window and fits the budget.

    Window width alone is the wrong input, and getting this wrong destroys the
    data it is supposed to present: a source observed eight times in a month
    was being served at day grain, which collapsed those eight observations
    into two points. The chart then drew two flat lines, the trend column had
    fewer than three points to draw, and every delta read as unchanged — a
    surface reporting "nothing happened" from a series it had just flattened.

    Density is the real input. Bucketing exists to reduce volume; where there
    is no volume to reduce, it only removes detail.

    COVERAGE comes first, though. Raw is retained for days and the rollups for
    months, so serving raw for a 30-day window would answer with the last
    week and silently drop the other three — a subtler wrong answer than a
    coarse one. A tier is only a candidate if its retention reaches the start
    of the window.
    """
    if requested in ("raw", "hour", "day"):
        return requested

    policy = policy or env_retention_policy()
    start = _parse(frm)
    end = _parse(to)
    if start is None or end is None:
        return "hour"
    span_days = max(0.0, (end - start).total_seconds() / 86_400.0)
    budget = (
        _SHORT_WINDOW_BUDGET
        if span_days * 24 <= _SHORT_WINDOW_HOURS
        else _POINT_BUDGET
    )

    # Finest first, and only tiers whose retention reaches back far enough.
    candidates = [
        ("raw", policy.raw_days),
        ("hour", policy.hourly_days),
        ("day", policy.daily_days),
    ]
    for grain, retention_days in candidates:
        if span_days > retention_days:
            continue
        buckets = await count_buckets(
            session, scope=scope, scope_id=scope_id, visible=visible,
            frm=frm, to=to, grain=grain,
        )
        if 0 < buckets <= budget:
            return grain
    return "day"


async def count_buckets(
    session: AsyncSession, *, scope: str, scope_id: Optional[str],
    visible: Optional[Sequence[str]], frm: str, to: str, grain: str,
) -> int:
    """Distinct buckets a tier would yield for this scope and window."""
    if grain == "raw":
        expr = _SNAP.captured_at
        stmt = select(func.count(func.distinct(expr))).where(
            _SNAP.captured_at >= frm, _SNAP.captured_at <= to,
            *_scope_conditions(
                _SNAP, scope=scope, scope_id=scope_id, visible=visible,
            ),
        )
    else:
        stmt = select(func.count(func.distinct(_ROLL.bucket_start))).where(
            _ROLL.grain == grain,
            _ROLL.bucket_start >= bucket_key(frm, grain),
            _ROLL.bucket_start <= bucket_key(to, grain),
            *_scope_conditions(
                _ROLL, scope=scope, scope_id=scope_id, visible=visible,
            ),
        )
    return int((await session.execute(stmt)).scalar_one() or 0)


def _scope_conditions(
    column_owner, *, scope: str, scope_id: Optional[str],
    visible: Optional[Sequence[str]],
) -> list:
    """Filters for one scope, ANDed with the caller's visibility.

    ``visible is None`` means unrestricted — a platform operator. An EMPTY
    collection is not the same thing and must not be treated as one: it means
    a caller bound to no workspace, and the correct answer is nothing at all.
    ``in_(())`` is a guaranteed-false predicate, which is the fail-closed
    behaviour we want written down rather than implied.
    """
    conditions = []
    if visible is not None:
        conditions.append(column_owner.data_source_id.in_(list(visible)))
    if scope == "source" and scope_id:
        conditions.append(column_owner.data_source_id == scope_id)
    elif scope == "workspace" and scope_id:
        conditions.append(column_owner.workspace_id == scope_id)
    elif scope == "provider" and scope_id:
        conditions.append(column_owner.provider_id == scope_id)
    return conditions


@dataclass(frozen=True)
class Observation:
    """One (source, bucket) datum, whichever tier it came from."""

    data_source_id: str
    bucket: str
    node_count: int
    edge_count: int
    entity_type_counts: str
    edge_type_counts: str
    node_min: Optional[int]
    node_max: Optional[int]
    edge_min: Optional[int]
    edge_max: Optional[int]
    node_delta: Optional[int]
    edge_delta: Optional[int]


#: Ceiling on rows a single read will assemble. Reached only by a very wide
#: window over a very large estate; the response says so rather than quietly
#: returning a short series, because a truncated chart that does not admit it
#: is worse than no chart.
READ_ROW_CAP = 20_000


async def read_observations(
    session: AsyncSession, *, scope: str, scope_id: Optional[str],
    visible: Optional[Sequence[str]], frm: str, to: str, grain: str,
) -> Tuple[List[Observation], bool]:
    """Rows for a scope and window. Returns (observations, truncated)."""
    if grain == "raw":
        conditions = _scope_conditions(
            _SNAP, scope=scope, scope_id=scope_id, visible=visible,
        )
        rows = (await session.execute(
            select(
                _SNAP.data_source_id, _SNAP.captured_at,
                _SNAP.node_count, _SNAP.edge_count,
                _SNAP.entity_type_counts, _SNAP.edge_type_counts,
                _SNAP.node_delta, _SNAP.edge_delta,
            )
            .where(_SNAP.captured_at >= frm, _SNAP.captured_at <= to, *conditions)
            # Newest-first then reversed, so a window that hits the cap loses
            # the distant past rather than the present.
            .order_by(_SNAP.captured_at.desc())
            .limit(READ_ROW_CAP + 1)
        )).all()
        truncated = len(rows) > READ_ROW_CAP
        rows = list(reversed(rows[:READ_ROW_CAP]))
        return [
            Observation(
                data_source_id=r[0], bucket=r[1],
                node_count=int(r[2] or 0), edge_count=int(r[3] or 0),
                entity_type_counts=r[4] or "{}", edge_type_counts=r[5] or "{}",
                node_min=int(r[2] or 0), node_max=int(r[2] or 0),
                edge_min=int(r[3] or 0), edge_max=int(r[3] or 0),
                node_delta=r[6], edge_delta=r[7],
            )
            for r in rows
        ], truncated

    conditions = _scope_conditions(
        _ROLL, scope=scope, scope_id=scope_id, visible=visible,
    )
    rows = (await session.execute(
        select(
            _ROLL.data_source_id, _ROLL.bucket_start,
            _ROLL.node_count, _ROLL.edge_count,
            _ROLL.entity_type_counts, _ROLL.edge_type_counts,
            _ROLL.node_min, _ROLL.node_max, _ROLL.edge_min, _ROLL.edge_max,
            _ROLL.node_delta, _ROLL.edge_delta,
        )
        .where(
            _ROLL.grain == grain,
            _ROLL.bucket_start >= bucket_key(frm, grain),
            _ROLL.bucket_start <= bucket_key(to, grain),
            *conditions,
        )
        .order_by(_ROLL.bucket_start.desc())
        .limit(READ_ROW_CAP + 1)
    )).all()
    truncated = len(rows) > READ_ROW_CAP
    rows = list(reversed(rows[:READ_ROW_CAP]))
    return [
        Observation(
            data_source_id=r[0], bucket=r[1],
            node_count=int(r[2] or 0), edge_count=int(r[3] or 0),
            entity_type_counts=r[4] or "{}", edge_type_counts=r[5] or "{}",
            node_min=r[6], node_max=r[7], edge_min=r[8], edge_max=r[9],
            node_delta=r[10], edge_delta=r[11],
        )
        for r in rows
    ], truncated


async def coverage_from(
    session: AsyncSession, *, scope: str, scope_id: Optional[str],
    visible: Optional[Sequence[str]],
) -> Optional[str]:
    """The earliest observation this scope has, at any tier.

    Reported so the UI can say "history begins here" rather than letting a
    short series read as data loss — a distinction a chart cannot make on its
    own, and the difference between a new source and a broken one.
    """
    day = (await session.execute(
        select(func.min(_ROLL.bucket_start)).where(
            _ROLL.grain == "day",
            *_scope_conditions(
                _ROLL, scope=scope, scope_id=scope_id, visible=visible,
            ),
        )
    )).scalar()
    raw = (await session.execute(
        select(func.min(_SNAP.captured_at)).where(
            *_scope_conditions(
                _SNAP, scope=scope, scope_id=scope_id, visible=visible,
            )
        )
    )).scalar()
    candidates = [c for c in (day, raw) if c]
    return min(candidates) if candidates else None


async def resolve_source_id(session: AsyncSession, given: str) -> str:
    """Accept a catalog-item id where a data source id is expected.

    The routable data source page and the Ingestion drawer are keyed on the
    CATALOG item (`cat_…`); profiling is keyed on the workspace data source
    (`ds_…`), because that is what has counts. Without this the profile page
    could show a source's numbers but not what they did, which is the split
    this whole surface exists to close.

    Falls through unchanged when it cannot resolve, so an unknown id gets the
    ordinary not-found path rather than a special one — and the same answer a
    real-but-unobserved source gets.
    """
    from backend.app.db.models import CatalogItemORM

    if not given.startswith("cat_"):
        return given
    item = await session.get(CatalogItemORM, given)
    if item is None or not item.source_identifier:
        return given
    resolved = (await session.execute(
        select(_SNAP.data_source_id)
        .where(
            _SNAP.provider_id == item.provider_id,
            _SNAP.graph_name == item.source_identifier,
        )
        .order_by(_SNAP.captured_at.desc())
        .limit(1)
    )).scalar()
    if resolved:
        return resolved
    # No snapshot yet: fall back to the onboarding record, so a source that
    # exists but has never been observed still resolves to itself and gets an
    # honest empty series rather than a 404.
    from backend.app.db.models import WorkspaceDataSourceORM

    return (await session.execute(
        select(WorkspaceDataSourceORM.id)
        .where(
            WorkspaceDataSourceORM.catalog_item_id == given,
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
        .order_by(WorkspaceDataSourceORM.created_at.desc())
        .limit(1)
    )).scalar() or given


# ── the board ────────────────────────────────────────────────────────


async def movement_board(
    session: AsyncSession, *, visible: Optional[Sequence[str]],
    frm: str, to: str, workspace_id: Optional[str] = None,
    provider_id: Optional[str] = None, metric: str = "nodes",
) -> Tuple[List[Dict[str, Any]], int]:
    """One row per data source, ordered by how much it moved.

    Read from the DAY tier and summed per source, never from raw: at platform
    scope over 90 days a raw scan is (sources x rows-per-source) rows ranked
    to produce a few hundred numbers, which is the shape of a request that
    appears to hang.

    Returns ``(rows, unobserved)``. Sources with no observation in the window
    are COUNTED, never listed at zero — a source that was not observed did not
    drop to nothing, and a board that showed it at zero would invent an
    outage. That count was previously hardcoded to 0.
    """
    from backend.app.db.models import (
        DataSourceStatsORM, ProviderORM, WorkspaceDataSourceORM,
    )
    from backend.app.db.repositories import stats_history_repo

    # The same tier selection the series uses, rather than a width threshold
    # of its own. A hardcoded "30 days means day grain" empties the board
    # whenever the day tier has not been built yet — compaction runs hour
    # first, so there is always a window where hour rollups exist and day ones
    # do not, and a board that reports nothing during it is indistinguishable
    # from a fleet that reported nothing.
    grain = await choose_grain(
        session, scope="all", scope_id=None, visible=visible,
        frm=frm, to=to, requested=None,
    )
    if grain == "raw":
        # The board summarises; it never needs per-observation resolution, and
        # raw cannot cover a long window anyway.
        grain = "hour"
    conditions = _scope_conditions(
        _ROLL, scope="all", scope_id=None, visible=visible,
    )
    if workspace_id:
        conditions.append(_ROLL.workspace_id == workspace_id)
    if provider_id:
        conditions.append(_ROLL.provider_id == provider_id)

    rows = (await session.execute(
        select(
            _ROLL.data_source_id, _ROLL.bucket_start,
            _ROLL.node_count, _ROLL.edge_count,
            _ROLL.node_delta, _ROLL.edge_delta,
            _ROLL.workspace_id, _ROLL.provider_id, _ROLL.graph_name,
        )
        .where(
            _ROLL.grain == grain,
            _ROLL.bucket_start >= bucket_key(frm, grain),
            _ROLL.bucket_start <= bucket_key(to, grain),
            *conditions,
        )
        .order_by(_ROLL.data_source_id, _ROLL.bucket_start)
        .limit(READ_ROW_CAP)
    )).all()

    per_source: Dict[str, Dict[str, Any]] = {}
    deltas: Dict[str, List[int]] = {}
    for r in rows:
        ds_id = r[0]
        if metric == "nodes":
            value, delta = int(r[2] or 0), r[4]
        elif metric == "edges":
            value, delta = int(r[3] or 0), r[5]
        else:
            # total. Summed from the SAME bucket, so the pair is always read
            # at one instant — deriving it from two separate board passes
            # would let a source that was observed once in the window
            # contribute its nodes and not its edges.
            value = int(r[2] or 0) + int(r[3] or 0)
            delta = (r[4] or 0) + (r[5] or 0)
        entry = per_source.setdefault(ds_id, {
            "data_source_id": ds_id,
            "first": value, "last": value, "points": [],
            "observations": 0, "last_observed_at": r[1],
            "workspace_id": r[6], "provider_id": r[7], "graph_name": r[8],
        })
        entry["last"] = value
        entry["last_observed_at"] = r[1]
        entry["observations"] += 1
        entry["points"].append(value)
        if delta:
            deltas.setdefault(ds_id, []).append(int(delta))

    # When each source was last PROFILED — the capture instant, not the
    # bucket it landed in.
    #
    # The board reads from the rollup tier, where `bucket_start` is the start
    # of a day or an hour. Reporting that as "last seen" makes every source
    # observed anywhere in the same bucket report the same age: at day grain
    # the whole fleet reads "13h ago" whether it was profiled at midnight or
    # a minute ago. `last_snapshot_at` is stamped by the capture itself, so it
    # is the actual answer, and it outlives the raw rows it came from.
    last_seen: Dict[str, Optional[str]] = {}
    if per_source:
        last_seen = {
            ds_id: at for ds_id, at in (await session.execute(
                select(
                    DataSourceStatsORM.data_source_id,
                    DataSourceStatsORM.last_snapshot_at,
                ).where(DataSourceStatsORM.data_source_id.in_(list(per_source)))
            )).all()
        }

    # Names, resolved once for the page rather than per row.
    labels: Dict[str, str] = {}
    catalog_ids: Dict[str, Optional[str]] = {}
    if per_source:
        for ds_id, label, catalog_item_id in (await session.execute(
            select(
                WorkspaceDataSourceORM.id,
                WorkspaceDataSourceORM.label,
                WorkspaceDataSourceORM.catalog_item_id,
            ).where(WorkspaceDataSourceORM.id.in_(list(per_source)))
        )).all():
            labels[ds_id] = label
            catalog_ids[ds_id] = catalog_item_id
    # Provider identity, including the TYPE — the board renders a logo, and
    # a name alone cannot pick one.
    providers: Dict[str, tuple] = {
        pid: (name, ptype) for pid, name, ptype in (await session.execute(
            select(ProviderORM.id, ProviderORM.name, ProviderORM.provider_type)
        )).all()
    }

    # Workspace names, so a fleet board can say WHOSE source moved. An id is
    # not something an operator recognises under pressure.
    workspaces: Dict[str, str] = {}
    ws_ids = {e["workspace_id"] for e in per_source.values() if e["workspace_id"]}
    if ws_ids:
        from backend.app.db.models import WorkspaceORM

        workspaces = {
            wid: name for wid, name in (await session.execute(
                select(WorkspaceORM.id, WorkspaceORM.name)
                .where(WorkspaceORM.id.in_(list(ws_ids)))
            )).all()
        }

    out: List[Dict[str, Any]] = []
    for ds_id, entry in per_source.items():
        movement = entry["last"] - entry["first"]
        magnitudes = sorted(abs(d) for d in deltas.get(ds_id, []))
        baseline = (
            max(25, magnitudes[len(magnitudes) // 2]) if magnitudes else 25
        )
        out.append({
            "data_source_id": ds_id,
            "name": labels.get(ds_id) or entry["graph_name"] or ds_id,
            "catalog_item_id": catalog_ids.get(ds_id),
            "workspace_id": entry["workspace_id"],
            "workspace_name": workspaces.get(entry["workspace_id"] or ""),
            "provider_id": entry["provider_id"],
            "provider_name": providers.get(entry["provider_id"] or "", (None, None))[0],
            "provider_type": providers.get(entry["provider_id"] or "", (None, None))[1],
            "first": entry["first"],
            "last": entry["last"],
            "delta": movement,
            "pct_change": (
                round(movement / entry["first"] * 100, 1)
                if entry["first"] else None
            ),
            "points": entry["points"],
            "observations": entry["observations"],
            # Falls back to the bucket only when a source has no stats row —
            # a coarse answer beats none, and the two agree to within a bucket.
            "last_observed_at": last_seen.get(ds_id) or entry["last_observed_at"],
            "significance": stats_history_repo.classify_significance(
                movement, baseline, before=entry["first"],
            ),
            "baseline": baseline,
        })

    out.sort(key=lambda r: (-abs(r["delta"]), r["name"]))

    # Everything the caller can see, minus what reported: the count of the
    # silent, which is a different fact from a zero.
    active = select(func.count(WorkspaceDataSourceORM.id)).where(
        WorkspaceDataSourceORM.deleted_at.is_(None)
    )
    if visible is not None:
        active = active.where(WorkspaceDataSourceORM.id.in_(list(visible)))
    if workspace_id:
        active = active.where(WorkspaceDataSourceORM.workspace_id == workspace_id)
    if provider_id:
        active = active.where(WorkspaceDataSourceORM.provider_id == provider_id)
    total_active = int((await session.execute(active)).scalar_one() or 0)
    return out, max(0, total_active - len(out))


def _span_hours(frm: str, to: str) -> float:
    start, end = _parse(frm), _parse(to)
    if start is None or end is None:
        return 0.0
    return max(0.0, (end - start).total_seconds() / 3600.0)


# ── the ledger ───────────────────────────────────────────────────────


async def window_counts(
    session: AsyncSession, *, ds_id: str, frm: str, to: str,
) -> Dict[str, int]:
    """How many observations the window holds, and how many moved.

    Counted in SQL over the whole window rather than derived from the returned
    page, because the two answer different questions and a page-derived total
    silently shrinks as the page does. The ledger's header claims a fact about
    the PERIOD — "214 observations, 5 moved" — and a claim about the period
    cannot be computed from a slice of it.
    """
    rows = (await session.execute(
        select(_SNAP.capture_reason, func.count(_SNAP.id))
        .where(
            _SNAP.data_source_id == ds_id,
            _SNAP.captured_at >= frm, _SNAP.captured_at <= to,
        )
        .group_by(_SNAP.capture_reason)
    )).all()
    by_reason = {reason: int(count or 0) for reason, count in rows}
    observations = sum(by_reason.values())
    # A checkpoint is the system confirming stillness; everything else is
    # something happening. `first` counts as an event — a source appearing is
    # the most consequential thing in its record.
    checkpoints = by_reason.get("heartbeat", 0)
    return {
        "observations": observations,
        "moved": observations - checkpoints,
        "checkpoints": checkpoints,
        "runs": by_reason.get("run", 0),
    }


async def observations_for_source(
    session: AsyncSession, *, ds_id: str, frm: str, to: str,
    only_notable: bool = False, limit: int = 100, offset: int = 0,
) -> Tuple[List[Dict[str, Any]], int, Dict[str, int]]:
    """Raw observations for one source, newest first, with significance.

    Always raw: this is the record of what was OBSERVED, and a bucket-closing
    value cannot answer "which run did this".
    """
    from backend.app.db.repositories import stats_history_repo

    rows = (await session.execute(
        select(_SNAP)
        .where(
            _SNAP.data_source_id == ds_id,
            _SNAP.captured_at >= frm, _SNAP.captured_at <= to,
        )
        .order_by(_SNAP.captured_at.desc())
        .limit(READ_ROW_CAP)
    )).scalars().all()

    baselines = {
        m: stats_history_repo.change_baseline(rows, m)
        for m in stats_history_repo.METRICS
    }

    shaped: List[Dict[str, Any]] = []
    for r in rows:
        significance = {
            m: stats_history_repo.classify_significance(
                stats_history_repo.delta_of(r, m), baselines[m],
                before=stats_history_repo.count_of(r, m)
                - int(stats_history_repo.delta_of(r, m) or 0),
            )
            for m in stats_history_repo.METRICS
        }
        if only_notable and all(v == "normal" for v in significance.values()):
            continue
        shaped.append({
            "id": r.id,
            "at": r.captured_at,
            "lane": r.lane,
            "reason": r.capture_reason,
            "refresh_event_id": r.refresh_event_id,
            "node_count": int(r.node_count or 0),
            "edge_count": int(r.edge_count or 0),
            "node_delta": r.node_delta,
            "edge_delta": r.edge_delta,
            # Derived artifacts stripped on READ so snapshots captured before
            # the providers stopped recording them stop showing the platform's
            # own bookkeeping as a type that appears and disappears.
            "entity_type_counts": strip_derived_counts(
                loads_counts(r.entity_type_counts)),
            "edge_type_counts": strip_derived_counts(
                loads_counts(r.edge_type_counts), edges=True),
            "type_deltas": r.type_deltas,
            "significance": significance,
        })

    total = len(shaped)
    return shaped[offset : offset + limit], total, baselines


async def refresh_events_for_source(
    session: AsyncSession, *, ds_id: str, frm: str, to: str, limit: int = 200,
) -> List[Dict[str, Any]]:
    """Platform activity inside the window, for correlation.

    Two reads, never a JOIN: ``refresh_events`` belongs to the aggregation
    domain. Absence is informative — if nothing of ours ran, whatever changed
    the graph came from outside the platform.
    """
    from backend.app.db.models import RefreshEventORM

    rows = (await session.execute(
        select(RefreshEventORM)
        .where(
            RefreshEventORM.data_source_id == ds_id,
            RefreshEventORM.ts >= frm, RefreshEventORM.ts <= to,
        )
        .order_by(RefreshEventORM.ts.desc())
        .limit(limit)
    )).scalars().all()
    return [
        {
            "id": r.id, "ts": r.ts, "origin": r.origin, "actor": r.actor,
            "scope": r.scope, "outcome": r.outcome, "gate": r.gate,
            "reason": r.reason, "detail": r.detail,
            "job_id": r.job_id, "run_id": r.run_id,
        }
        for r in rows
    ]


# ── findings ─────────────────────────────────────────────────────────


def finding_model(row) -> Dict[str, Any]:
    """Wire shape for one recorded finding."""
    return {
        "id": row.id,
        "data_source_id": row.data_source_id,
        "detected_at": row.detected_at,
        "observed_at": row.observed_at,
        "workspace_id": row.workspace_id,
        "provider_id": row.provider_id,
        "provider_name": row.provider_name,
        "data_source_label": row.data_source_label,
        "graph_name": row.graph_name,
        "catalog_item_id": row.catalog_item_id,
        "severity": row.severity,
        "direction": row.direction,
        "metric": getattr(row, "metric", "nodes"),
        "finding": getattr(row, "finding", "movement"),
        "subject_type": getattr(row, "subject_type", None),
        "delta": row.node_delta,
        "count": row.node_count,
        "baseline": row.baseline,
        "evidence": row.evidence,
        "acknowledged_at": row.acknowledged_at,
        "acknowledged_by": row.acknowledged_by,
    }


async def list_findings(
    session: AsyncSession, *, data_source_id: Optional[str],
    visible: Optional[Sequence[str]], open_only: bool = False,
    limit: int = 100, offset: int = 0,
) -> Tuple[List[Dict[str, Any]], int, int]:
    """Findings the caller may see, newest first, with a real total.

    ``openCount`` was previously a second capped listing, which silently
    stopped counting at 500 — so a fleet with a real problem reported the same
    number as one with a slightly smaller problem. It is a COUNT here.
    """
    from backend.app.db.models import DataSourceCountAlertORM as _ALERT

    def _scoped(stmt):
        if visible is not None:
            stmt = stmt.where(_ALERT.data_source_id.in_(list(visible)))
        if data_source_id:
            stmt = stmt.where(_ALERT.data_source_id == data_source_id)
        return stmt

    listing = _scoped(select(_ALERT))
    if open_only:
        listing = listing.where(_ALERT.acknowledged_at.is_(None))
    rows = (await session.execute(
        listing.order_by(_ALERT.detected_at.desc()).limit(limit).offset(offset)
    )).scalars().all()

    total = int((await session.execute(
        _scoped(select(func.count(_ALERT.id)))
        .where(_ALERT.acknowledged_at.is_(None)) if open_only
        else _scoped(select(func.count(_ALERT.id)))
    )).scalar_one() or 0)
    open_count = int((await session.execute(
        _scoped(select(func.count(_ALERT.id))).where(
            _ALERT.acknowledged_at.is_(None)
        )
    )).scalar_one() or 0)

    return [finding_model(r) for r in rows], total, open_count


# ── policy persistence ───────────────────────────────────────────────

#: Request field -> ``platform_settings`` column. Only the knobs an operator
#: can sensibly change live: the tier CADENCES are deployment concerns, not
#: product ones, and a live-editable compaction interval is a way to wedge
#: retention from a settings page.
_POLICY_COLUMNS = {
    # `history_retention_days` predates the tiers and holds the HOURLY window.
    # Renaming it would be a migration for no behavioural gain; the mapping is
    # the one place the old name has to be understood.
    "hourlyRetentionDays": "history_retention_days",
    "rawRetentionDays": "profiling_raw_retention_days",
    "dailyRetentionDays": "profiling_daily_retention_days",
    "maxRowsPerSource": "history_max_rows_per_source",
    "heartbeatSecs": "history_heartbeat_secs",
    "silentAfterSecs": "profiling_silent_after_secs",
    "alertsEnabled": "history_alerts_enabled",
    "alertMinSeverity": "history_alert_min_severity",
    "alertCooldownSecs": "history_alert_cooldown_secs",
}

#: Sentinel meaning "clear this override and inherit the environment default".
#: A separate verb for un-setting would be a second endpoint for the same
#: decision, and a blank field is indistinguishable from "unchanged" on the
#: wire.
INHERIT = -1


async def persist_policy(session: AsyncSession, values: Dict[str, Any]) -> None:
    """Write operator overrides onto the single platform-settings row."""
    from backend.app.db.models import PlatformSettingsORM

    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        row = PlatformSettingsORM(id=1)
        session.add(row)
    for field, column in _POLICY_COLUMNS.items():
        if field not in values:
            continue
        value = values[field]
        setattr(row, column, None if value == INHERIT else value)
