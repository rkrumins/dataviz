"""data_source_count_snapshots — the append-only history behind the counts
the insights service already computes.

``stats_repo`` keeps the CURRENT picture of a data source and destroys the
previous one on every write. This module keeps the previous ones: one row per
observation that actually differed, plus a heartbeat so a flat line is provably
flat rather than a gap.

**Why capture lives beside the counts write, not in a collector.**
``upsert_data_source_stats_counts`` has five callers — the 60s drift probe, the
counts poll, the deep profile, the reconcile sweep, and two app write paths.
Capturing in any one of them would give a history whose meaning depended on
which lane happened to observe a change. Capturing here gives one series with
one definition, and the row being overwritten is already in memory, so the
delta against the previous observation costs no extra read. It is the same
argument ``stats_repo._counts_digest`` already makes for deriving the digest
beside the write rather than accepting it from a caller.

**Why a failed collection writes nothing.** Every caller reaches this module
only after the provider has answered. A FalkorDB pod rotation makes the
collection raise upstream — inside ``_run_guarded``'s retry, or the circuit
breaker, or the admission gate's soft-retry — so no row is written and no
phantom zero enters the series. A genuinely empty graph is different: the
provider verifies absence via EXISTS before reporting zero, so that zero is
real and is exactly the wipe signal this table exists to record.

**Capture is gated, not unconditional.** The probe lane runs every 60s. Writing
a row per probe would be 43k rows per source per month describing a graph that
mostly did not change. ``maybe_capture_snapshot`` writes when the digest moves,
and otherwise at most once per heartbeat interval.
"""
from __future__ import annotations

import json
import logging
import time as _time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from ..models import (
    DataSourceCountSnapshotORM,
    DataSourceStatsORM,
    PlatformSettingsORM,
    WorkspaceDataSourceORM,
)

logger = logging.getLogger(__name__)

#: Bounds on the operator overrides. A retention of 0 days or a cap of 0 rows
#: would silently turn the feature into a purge loop, and there is no honest
#: reading of "keep history" that means that — so the floor is 1, not 0. The
#: master switch is ``INSIGHTS_HISTORY_ENABLED``, which is the supported way to
#: turn capture off.
_MIN_RETENTION_DAYS = 1
_MIN_MAX_ROWS = 1
_MIN_HEARTBEAT_SECS = 60

#: Same 30s in-process memo as ``aggregation.service.read_global_cadence``.
#: Capture consults the policy on every counts write, and the settings row
#: changes roughly never; cross-process staleness is bounded by this TTL.
_POLICY_CACHE_TTL_S = 30.0
_POLICY_CACHE: dict = {"policy": None, "at": 0.0}

_VALID_GRAINS = ("raw", "hour", "day")


def normalize_grain(grain: Optional[str]) -> str:
    """Coerce a caller-supplied grain to a supported one. Unknown → ``raw``:
    a bad query param should show you everything, not nothing."""
    return grain if grain in _VALID_GRAINS else "raw"


@dataclass(frozen=True)
class HistoryPolicy:
    """Resolved capture/retention policy — ``persisted ?? env`` for each field.

    ``env_*`` are carried alongside the effective values so the settings editor
    can seed from the real default and a no-op save round-trips it, rather than
    pinning whatever the UI happened to render. Same contract
    ``ReconcilePolicyResponse`` already honours.
    """
    enabled: bool
    heartbeat_secs: int
    retention_days: int
    max_rows_per_source: int

    env_heartbeat_secs: int
    env_retention_days: int
    env_max_rows_per_source: int

    # What the operator actually persisted (None = inheriting the env default).
    persisted_heartbeat_secs: Optional[int] = None
    persisted_retention_days: Optional[int] = None
    persisted_max_rows_per_source: Optional[int] = None


def env_history_policy() -> HistoryPolicy:
    """The policy with nothing persisted — the fallback used whenever the
    settings row is missing or unreadable."""
    return HistoryPolicy(
        enabled=resilience.INSIGHTS_HISTORY_ENABLED,
        heartbeat_secs=resilience.INSIGHTS_HISTORY_HEARTBEAT_SECS,
        retention_days=resilience.INSIGHTS_HISTORY_RETENTION_DAYS,
        max_rows_per_source=resilience.INSIGHTS_HISTORY_MAX_ROWS_PER_SOURCE,
        env_heartbeat_secs=resilience.INSIGHTS_HISTORY_HEARTBEAT_SECS,
        env_retention_days=resilience.INSIGHTS_HISTORY_RETENTION_DAYS,
        env_max_rows_per_source=resilience.INSIGHTS_HISTORY_MAX_ROWS_PER_SOURCE,
    )


def invalidate_history_policy_cache() -> None:
    """Drop the memo so the next read reflects a just-written value in THIS
    process (the settings PUT calls this). Cross-process staleness is bounded
    by the TTL, not this."""
    _POLICY_CACHE["policy"] = None
    _POLICY_CACHE["at"] = 0.0


def _clamped(value: Optional[int], floor: int, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        return max(floor, int(value))
    except (TypeError, ValueError):
        return fallback


async def resolve_history_policy(session: AsyncSession) -> HistoryPolicy:
    """``persisted ?? env``, memoized for ≤30s. NEVER raises — a missing table,
    a dead pool or a garbage value degrades to the env defaults, because a
    settings read must not be able to fail a counts write."""
    now = _time.monotonic()
    cached = _POLICY_CACHE
    if cached["policy"] is not None and (now - cached["at"]) < _POLICY_CACHE_TTL_S:
        return cached["policy"]

    env = env_history_policy()
    try:
        row = await session.get(PlatformSettingsORM, 1)
    except Exception as exc:  # pragma: no cover - defensive, never fail a write
        logger.warning("history policy read failed (using env defaults): %s", exc)
        return env

    if row is None:
        policy = env
    else:
        p_heartbeat = getattr(row, "history_heartbeat_secs", None)
        p_retention = getattr(row, "history_retention_days", None)
        p_max_rows = getattr(row, "history_max_rows_per_source", None)
        policy = HistoryPolicy(
            enabled=env.enabled,
            heartbeat_secs=_clamped(
                p_heartbeat, _MIN_HEARTBEAT_SECS, env.env_heartbeat_secs,
            ),
            retention_days=_clamped(
                p_retention, _MIN_RETENTION_DAYS, env.env_retention_days,
            ),
            max_rows_per_source=_clamped(
                p_max_rows, _MIN_MAX_ROWS, env.env_max_rows_per_source,
            ),
            env_heartbeat_secs=env.env_heartbeat_secs,
            env_retention_days=env.env_retention_days,
            env_max_rows_per_source=env.env_max_rows_per_source,
            persisted_heartbeat_secs=p_heartbeat,
            persisted_retention_days=p_retention,
            persisted_max_rows_per_source=p_max_rows,
        )

    cached["policy"] = policy
    cached["at"] = now
    return policy


# ── significance ─────────────────────────────────────────────────────
#
# Lives HERE, not in the API module, because two readers depend on it and
# they must never disagree. The chart draws a marker where the history read
# says a movement was unusual; the alert evaluator wakes someone up for the
# same reason. Two copies of these thresholds would eventually differ, and
# the failure mode is an alert about a change the chart draws as ordinary --
# which destroys trust in both.

# How far outside a source's own typical movement a change has to sit before
# it is worth a reader's attention. Multiples of the median absolute delta,
# which is the robust choice here: a mean would be dragged upward by the very
# outlier we are trying to detect, and one 900k drop would then make every
# subsequent 900k drop look ordinary.
_NOTABLE_MULTIPLE = 3.0
_SEVERE_MULTIPLE = 8.0

# ``critical`` is measured against the GRAPH, not against its churn, and that
# is the whole reason it exists as a separate tier. The multiples above answer
# "is this unusual for this source" — the right question almost always, and the
# wrong one for a wipe:
#
#   * A source with large routine churn can lose EVERYTHING without the loss
#     reaching 8x its own median movement. The tier that should shout loudest
#     would stay silent precisely on the worst failure.
#   * A graph going from four million entities to zero is not a statistical
#     outlier. It is an outage, a dropped database, or a loader that truncated
#     instead of upserting, and no amount of context makes it ordinary.
#
# So: a drop that removes this fraction of the graph is critical regardless of
# what the source's usual movement looks like. 0.9 rather than 1.0 because a
# loader that leaves a handful of rows behind has still destroyed the graph.
_CRITICAL_LOSS_FRACTION = 0.9

# Below this many entities the fraction is meaningless — a 12-node fixture
# graph losing 11 nodes is 92% and not an incident. Real graphs are orders of
# magnitude larger; this only excludes the ones where the proportion cannot
# carry any signal.
_CRITICAL_MIN_BEFORE = 1000

# Floor under the baseline, in entities. Without it a source that sits
# perfectly still has a baseline of 0, every multiple is 0, and the first time
# it moves by one node the change is reported as severe.
_SIGNIFICANCE_FLOOR = 25


def change_baseline(rows: list) -> int:
    """The median non-zero absolute node delta in the window.

    "Is this drop big" has no answer in the absolute — 900 lost rows is
    catastrophic for a source that never moves and a Tuesday for one that
    rebuilds nightly. The baseline makes the question answerable per source,
    from the data already in hand.

    Zero deltas are excluded: heartbeat rows would otherwise drag the median to
    0 on any source that is mostly idle, which is most of them.
    """
    magnitudes = sorted(
        abs(r.node_delta) for r in rows
        if r.node_delta is not None and r.node_delta != 0
    )
    if not magnitudes:
        return _SIGNIFICANCE_FLOOR
    middle = len(magnitudes) // 2
    median = (
        magnitudes[middle] if len(magnitudes) % 2
        else (magnitudes[middle - 1] + magnitudes[middle]) // 2
    )
    return max(_SIGNIFICANCE_FLOOR, int(median))


def classify_significance(
    delta: Optional[int], baseline: int, *, before: Optional[int] = None,
) -> str:
    """normal | notable | severe | critical.

    The first three are relative to this source's OWN baseline, and
    deliberately symmetric: a graph that tripled overnight is as much worth
    looking at as one that lost two thirds, and an "only drops matter" rule
    would miss a runaway loader duplicating every node.

    ``critical`` is the exception, and it is asymmetric on purpose. It is
    measured against the size of the graph rather than against its churn, and
    only for losses — a graph doubling is dramatic but recoverable, whereas one
    that is nearly gone may have nothing left to recover from. ``before`` is
    the count prior to the movement; without it the proportional test is
    skipped and the multiples decide alone.
    """
    if not delta:
        return "normal"
    magnitude = abs(delta)

    if (
        delta < 0
        and before is not None
        and before >= _CRITICAL_MIN_BEFORE
        and magnitude >= before * _CRITICAL_LOSS_FRACTION
    ):
        return "critical"

    if magnitude >= baseline * _SEVERE_MULTIPLE:
        return "severe"
    if magnitude >= baseline * _NOTABLE_MULTIPLE:
        return "notable"
    return "normal"



# ── capture ──────────────────────────────────────────────────────────


def loads_counts(raw: Any) -> Dict[str, int]:
    """Parse a stored JSON counts column. Unparseable → empty, mirroring
    ``stats_repo._counts_digest``'s own read-side fallback: a corrupt column
    must degrade to "we knew nothing", never blow up a counts write."""
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


def diff_counts(before: Dict[str, int], after: Dict[str, int]) -> Dict[str, Any]:
    """added / removed / changed between two label→count maps.

    "removed" means the label is gone from the counts entirely — which for the
    probe lane is how a wiped label reads, since zero-count buckets are dropped
    rather than reported as ``{"Label": 0}``. Both spellings therefore have to
    mean the same thing to a reader, so a label going to an explicit 0 is
    reported as removed too.
    """
    added = {k: v for k, v in after.items() if k not in before and v}
    removed = {
        k: v for k, v in before.items()
        if v and (k not in after or not after.get(k))
    }
    changed = {
        k: [before[k], after[k]]
        for k in before.keys() & after.keys()
        if before[k] != after[k] and before[k] and after[k]
    }
    return {"added": added, "removed": removed, "changed": changed}


async def _identity_for(
    session: AsyncSession, ds_id: str,
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """(workspace_id, provider_id, graph_name) for the rollup keys.

    An explicit SELECT rather than ``stats_row.data_source`` on purpose: that
    relationship is lazy, and a lazy load under async SQLAlchemy raises
    MissingGreenlet. It runs only on the turns that actually capture — a
    changed digest or an hourly heartbeat — so it costs nothing on the 60s
    probe path, where the common outcome is "nothing to record".
    """
    try:
        row = (await session.execute(
            select(
                WorkspaceDataSourceORM.workspace_id,
                WorkspaceDataSourceORM.provider_id,
                WorkspaceDataSourceORM.graph_name,
            ).where(WorkspaceDataSourceORM.id == ds_id)
        )).first()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("history: identity lookup failed for ds=%s: %s", ds_id, exc)
        return None, None, None
    if row is None:
        return None, None, None
    return row[0], row[1], row[2]


def _stale(last_at: Optional[str], now: datetime, heartbeat_secs: int) -> bool:
    """True when the last snapshot is older than the heartbeat (or absent)."""
    if not last_at:
        return True
    try:
        prev = datetime.fromisoformat(last_at)
    except (TypeError, ValueError):
        return True
    if prev.tzinfo is None:
        prev = prev.replace(tzinfo=timezone.utc)
    return (now - prev).total_seconds() >= heartbeat_secs


async def maybe_capture_snapshot(
    session: AsyncSession,
    *,
    ds_id: str,
    lane: str,
    node_count: int,
    edge_count: int,
    entity_type_counts: str,
    edge_type_counts: str,
    digest: str,
    previous: Optional[DataSourceStatsORM],
    policy: HistoryPolicy,
) -> Optional[DataSourceCountSnapshotORM]:
    """Record this observation if it is worth recording. Returns the row, or
    ``None`` when the observation was a no-change inside the heartbeat window.

    MUST be called BEFORE ``previous``'s count columns are overwritten — those
    values are the delta baseline. Runs in the caller's session, so history is
    atomic with the current-state row it describes and the two can never
    disagree about what was observed.
    """
    if not policy.enabled:
        return None

    prev_captured_at = (
        getattr(previous, "last_snapshot_at", None) if previous is not None else None
    )
    changed = previous is None or (previous.counts_digest or "") != digest

    # "first" means no prior row in THIS table — which covers both a brand-new
    # data source and an existing one on the first capture after this feature
    # ships. Keying it on the stats row instead would label that second case
    # "changed", and then hand it a delta against a predecessor no reader can
    # look up.
    if not prev_captured_at:
        capture_reason = "first"
    elif changed:
        capture_reason = "changed"
    else:
        capture_reason = "heartbeat"

    now = datetime.now(timezone.utc)
    if capture_reason == "heartbeat" and not _stale(
        prev_captured_at, now, policy.heartbeat_secs,
    ):
        return None

    after_entities = loads_counts(entity_type_counts)
    after_edges = loads_counts(edge_type_counts)

    # Deltas are always "against the previous snapshot", never "against the
    # current-state row". On a first capture there is no predecessor a reader
    # could open, so the deltas stay NULL rather than describing a comparison
    # the series cannot show.
    node_delta = edge_delta = None
    type_deltas = None
    if prev_captured_at and previous is not None:
        node_delta = int(node_count) - int(previous.node_count or 0)
        edge_delta = int(edge_count) - int(previous.edge_count or 0)
        type_deltas = json.dumps({
            "nodes": diff_counts(loads_counts(previous.entity_type_counts), after_entities),
            "edges": diff_counts(loads_counts(previous.edge_type_counts), after_edges),
        })

    workspace_id, provider_id, graph_name = await _identity_for(session, ds_id)

    row = DataSourceCountSnapshotORM(
        id=f"snp_{uuid.uuid4().hex[:12]}",
        data_source_id=ds_id,
        captured_at=now.isoformat(),
        workspace_id=workspace_id,
        provider_id=provider_id,
        graph_name=graph_name,
        node_count=int(node_count),
        edge_count=int(edge_count),
        entity_type_counts=json.dumps(after_entities),
        edge_type_counts=json.dumps(after_edges),
        counts_digest=digest or "",
        lane=lane if lane in ("probe", "poll", "deep", "sweep", "write") else "poll",
        capture_reason=capture_reason,
        prev_captured_at=prev_captured_at,
        node_delta=node_delta,
        edge_delta=edge_delta,
        type_deltas=type_deltas,
    )
    session.add(row)
    # ``last_snapshot_at`` is NOT stamped here. On a source's very first write
    # there is no stats row yet to stamp — ``previous`` is None — and stamping
    # only when one happens to exist left every first snapshot unrecorded, so
    # the NEXT write saw a null marker and called itself "first" all over
    # again. The caller owns the row in both branches, so the caller stamps it.
    return row


# ── reads ────────────────────────────────────────────────────────────


def _bucket_expr(grain: str):
    """ISO timestamps are lexically ordered, so a bucket is a prefix.

    ``2026-08-20T14:31:02+00:00`` → 13 chars is the hour, 10 is the day. No
    date parsing, no timezone maths, and it works identically on Postgres and
    the SQLite the tests run on.
    """
    if grain == "hour":
        return func.substr(DataSourceCountSnapshotORM.captured_at, 1, 13)
    return func.substr(DataSourceCountSnapshotORM.captured_at, 1, 10)


async def list_snapshots(
    session: AsyncSession,
    ds_id: str,
    *,
    frm: str,
    to: str,
    grain: str = "raw",
    limit: int = 5000,
) -> List[DataSourceCountSnapshotORM]:
    """Snapshots for one source in [frm, to], oldest first.

    At ``raw`` grain every row is returned (bounded by ``limit``). At hour/day
    grain the LAST row of each bucket is returned — the bucket's closing state,
    which is what a reader means by "what did it look like that day".
    """
    stmt = (
        select(DataSourceCountSnapshotORM)
        .where(
            DataSourceCountSnapshotORM.data_source_id == ds_id,
            DataSourceCountSnapshotORM.captured_at >= frm,
            DataSourceCountSnapshotORM.captured_at <= to,
        )
        .order_by(DataSourceCountSnapshotORM.captured_at.asc())
        .limit(limit)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    if grain == "raw" or not rows:
        return rows

    width = 13 if grain == "hour" else 10
    last_per_bucket: Dict[str, DataSourceCountSnapshotORM] = {}
    for row in rows:
        last_per_bucket[(row.captured_at or "")[:width]] = row
    return [last_per_bucket[k] for k in sorted(last_per_bucket)]


async def bucket_extremes(
    session: AsyncSession,
    ds_id: str,
    *,
    frm: str,
    to: str,
    grain: str,
) -> Dict[str, Tuple[int, int]]:
    """bucket → (min node_count, max node_count).

    Not decoration: downsampling to one point per bucket hides a drop that
    happened and recovered inside it, which is precisely the event this whole
    feature exists to surface. The band drawn from these keeps the dip visible
    at day grain.
    """
    if grain == "raw":
        return {}
    bucket = _bucket_expr(grain).label("bucket")
    stmt = (
        select(
            bucket,
            func.min(DataSourceCountSnapshotORM.node_count),
            func.max(DataSourceCountSnapshotORM.node_count),
        )
        .where(
            DataSourceCountSnapshotORM.data_source_id == ds_id,
            DataSourceCountSnapshotORM.captured_at >= frm,
            DataSourceCountSnapshotORM.captured_at <= to,
        )
        .group_by(bucket)
    )
    return {
        r[0]: (int(r[1] or 0), int(r[2] or 0))
        for r in (await session.execute(stmt)).all()
    }


async def oldest_captured_at(session: AsyncSession, ds_id: str) -> Optional[str]:
    """The oldest snapshot held for a source, at any age.

    Read so the UI can say "history covers 12 of the 30 days you asked for"
    instead of letting a short series read as data loss on a fresh deploy.
    """
    return (await session.execute(
        select(func.min(DataSourceCountSnapshotORM.captured_at))
        .where(DataSourceCountSnapshotORM.data_source_id == ds_id)
    )).scalar_one_or_none()


async def latest_data_source_for_graph(
    session: AsyncSession, provider_id: str, graph_name: str,
) -> Optional[str]:
    """The most recently observed data source for a (provider, graph) pair.

    Exists so a deep link to a CATALOG item's history resolves. A catalog item
    is ``(provider_id, source_identifier)`` — a physical graph — while history
    is keyed on the workspace data source that observes it, and the page has
    the former in its URL.

    "Most recently observed" rather than "the one" because several workspaces
    can bind the same graph. They are all watching the same physical asset and
    will report the same counts, so any of them answers the question; picking
    the freshest makes the choice deterministic and picks the one still being
    polled. Reads the denormalised columns, so this stays inside the stats
    domain.
    """
    return (await session.execute(
        select(DataSourceCountSnapshotORM.data_source_id)
        .where(
            DataSourceCountSnapshotORM.provider_id == provider_id,
            DataSourceCountSnapshotORM.graph_name == graph_name,
        )
        .order_by(DataSourceCountSnapshotORM.captured_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def provider_data_source_ids(
    session: AsyncSession, provider_id: str, *, frm: str, to: str,
) -> List[str]:
    """Data sources with history for a provider in the window.

    Reads the denormalised ``provider_id`` on the snapshot rather than joining
    to ``workspace_data_sources`` — that JOIN would leave the stats domain, and
    it would also drop the history of sources that have since been removed.
    """
    rows = (await session.execute(
        select(DataSourceCountSnapshotORM.data_source_id)
        .where(
            DataSourceCountSnapshotORM.provider_id == provider_id,
            DataSourceCountSnapshotORM.captured_at >= frm,
            DataSourceCountSnapshotORM.captured_at <= to,
        )
        .distinct()
    )).scalars().all()
    return list(rows)


@dataclass(frozen=True)
class RollupRow:
    """One source's closing state in one bucket — the unit a rollup is built
    from. Deliberately not an ORM row: the rollups need five fields and
    carrying whole snapshots (JSON counts included) would be most of a
    megabyte for a chart that plots two numbers."""
    bucket: str
    provider_id: Optional[str]
    data_source_id: str
    graph_name: Optional[str]
    node_count: int
    edge_count: int


async def rollup_rows(
    session: AsyncSession,
    *,
    frm: str,
    to: str,
    width: int,
    provider_id: Optional[str] = None,
    data_source_ids: Optional[Set[str]] = None,
) -> List[RollupRow]:
    """Each source's LAST observation per bucket, bucketed in SQL.

    Bucketing here rather than in Python is a correctness requirement, not an
    optimisation. Pulling raw rows and reducing them client-side needs a row
    cap, and a fleet of a few hundred sources over 90 days exceeds any cap
    worth setting — at which point the read silently returns a PREFIX of the
    window and the chart shows a total that is simply wrong, with nothing to
    say so. Reducing first makes the result size (buckets x sources), which is
    bounded by the window rather than by how busy the fleet has been.

    ``provider_id`` scopes it to one provider; omitted, it is the whole
    platform. The window function is the same one ``latest_refresh_event_map``
    already uses, so it is portable to the SQLite the tests run on.

    ``data_source_ids`` is the TENANT scope, and it is separate from
    ``provider_id`` on purpose: one says which slice of the platform is being
    asked about, the other says which slice the asker is allowed to be told
    about. ``None`` means unrestricted — the platform operator — and an EMPTY
    set means a caller who can see nothing, which must return nothing rather
    than everything. Passing an empty set through as "no filter" is the
    classic way this kind of scoping fails open.
    """
    bucket = func.substr(DataSourceCountSnapshotORM.captured_at, 1, width).label("bucket")
    ranked = (
        select(
            bucket,
            DataSourceCountSnapshotORM.provider_id.label("provider_id"),
            DataSourceCountSnapshotORM.data_source_id.label("data_source_id"),
            DataSourceCountSnapshotORM.graph_name.label("graph_name"),
            DataSourceCountSnapshotORM.node_count.label("node_count"),
            DataSourceCountSnapshotORM.edge_count.label("edge_count"),
            func.row_number().over(
                partition_by=(bucket, DataSourceCountSnapshotORM.data_source_id),
                order_by=DataSourceCountSnapshotORM.captured_at.desc(),
            ).label("rn"),
        )
        .where(
            DataSourceCountSnapshotORM.captured_at >= frm,
            DataSourceCountSnapshotORM.captured_at <= to,
        )
    )
    if provider_id is not None:
        ranked = ranked.where(DataSourceCountSnapshotORM.provider_id == provider_id)
    if data_source_ids is not None:
        # `.in_(())` is a guaranteed-false predicate in SQLAlchemy, which is
        # exactly right: a caller scoped to no sources gets no rows.
        ranked = ranked.where(
            DataSourceCountSnapshotORM.data_source_id.in_(data_source_ids)
        )

    sub = ranked.subquery()
    rows = (await session.execute(
        select(
            sub.c.bucket, sub.c.provider_id, sub.c.data_source_id,
            sub.c.graph_name, sub.c.node_count, sub.c.edge_count,
        )
        .where(sub.c.rn == 1)
        .order_by(sub.c.bucket.asc())
    )).all()
    return [
        RollupRow(
            bucket=r[0], provider_id=r[1], data_source_id=r[2],
            graph_name=r[3], node_count=int(r[4] or 0), edge_count=int(r[5] or 0),
        )
        for r in rows
    ]


# ── purge ────────────────────────────────────────────────────────────


async def purge_by_age(
    session: AsyncSession, *, retention_days: int, batch: int = 5000,
) -> int:
    """Delete snapshots older than the cutoff. Returns rows deleted.

    ISO lexical ordering makes the cutoff a plain string compare, the same way
    ``last_probed_at < cutoff`` already works in the probe due-check.
    """
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=max(1, retention_days))
    ).isoformat()
    doomed = (await session.execute(
        select(DataSourceCountSnapshotORM.id)
        .where(DataSourceCountSnapshotORM.captured_at < cutoff)
        .limit(batch)
    )).scalars().all()
    if not doomed:
        return 0
    await session.execute(
        delete(DataSourceCountSnapshotORM)
        .where(DataSourceCountSnapshotORM.id.in_(list(doomed)))
    )
    return len(doomed)


async def purge_over_cap(
    session: AsyncSession, *, max_rows_per_source: int, batch: int = 5000,
) -> int:
    """Trim each source back to its newest ``max_rows_per_source`` snapshots.

    The age cutoff alone is unbounded in the bad case: a source thrashing under
    a broken loader changes on every 60s probe, and 43k rows a month of one
    source is how this table would come to be dominated by its least healthy
    member. This is that backstop.

    Deliberately id-based rather than a window-function DELETE — the same
    statement then runs unchanged on the SQLite the tests use.
    """
    cap = max(1, max_rows_per_source)
    over = (await session.execute(
        select(DataSourceCountSnapshotORM.data_source_id)
        .group_by(DataSourceCountSnapshotORM.data_source_id)
        .having(func.count(DataSourceCountSnapshotORM.id) > cap)
    )).scalars().all()

    removed = 0
    for ds_id in over:
        if removed >= batch:
            break
        keep = (await session.execute(
            select(DataSourceCountSnapshotORM.id)
            .where(DataSourceCountSnapshotORM.data_source_id == ds_id)
            .order_by(DataSourceCountSnapshotORM.captured_at.desc())
            .limit(cap)
        )).scalars().all()
        doomed = (await session.execute(
            select(DataSourceCountSnapshotORM.id)
            .where(
                DataSourceCountSnapshotORM.data_source_id == ds_id,
                DataSourceCountSnapshotORM.id.notin_(list(keep)),
            )
            .limit(batch - removed)
        )).scalars().all()
        if not doomed:
            continue
        await session.execute(
            delete(DataSourceCountSnapshotORM)
            .where(DataSourceCountSnapshotORM.id.in_(list(doomed)))
        )
        removed += len(doomed)
    return removed


async def purge_snapshots(
    session: AsyncSession, policy: HistoryPolicy, *, batch: int = 5000,
) -> Dict[str, int]:
    """Both purge passes. Idempotent — a second run over a clean table deletes
    nothing and reports zeroes."""
    by_age = await purge_by_age(
        session, retention_days=policy.retention_days, batch=batch,
    )
    over_cap = await purge_over_cap(
        session, max_rows_per_source=policy.max_rows_per_source, batch=batch,
    )
    return {"by_age": by_age, "over_cap": over_cap}


__all__: Sequence[str] = (
    "HistoryPolicy",
    "bucket_extremes",
    "change_baseline",
    "classify_significance",
    "diff_counts",
    "env_history_policy",
    "invalidate_history_policy_cache",
    "latest_data_source_for_graph",
    "list_snapshots",
    "loads_counts",
    "maybe_capture_snapshot",
    "normalize_grain",
    "oldest_captured_at",
    "provider_data_source_ids",
    "RollupRow",
    "rollup_rows",
    "purge_by_age",
    "purge_over_cap",
    "purge_snapshots",
    "resolve_history_policy",
)
