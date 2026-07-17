"""Pre-registration asset discovery collector.

Two flavors keyed off ``DiscoveryJobEnvelope.asset_name``:

* ``""``  — list every asset on the provider; persists ``{"assets": [...]}``
  under the (provider_id, "") cache row.
* other   — fetch stats for that single asset; persists a node/edge-count
  payload under the (provider_id, asset_name) cache row.

The handler owns its DB sessions: one short JOBS session reads the
provider row + credentials, closes, then the live provider IO runs with
no session held, and a second short session upserts the cache row. It
instantiates a provider via the static
``ProviderManager._create_provider_instance`` helper — same path as the
legacy ``providers.py`` short-session endpoints so adapter behaviour
stays identical. The web tier never hits this code path; web reads go
straight to ``asset_discovery_cache``.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.app.db.engine import get_jobs_session
from backend.app.db.models import AssetDiscoveryCacheORM
from backend.app.db.repositories.provider_repo import get_credentials, get_provider_orm
from backend.app.providers.manager import provider_manager

from . import admission, dispatcher
from .schemas import DiscoveryJobEnvelope

logger = logging.getLogger(__name__)


# Inner budget for a live discovery call — owned by resilience.py (the
# worker's OUTER per-job timeout derives from the same constant, so the
# two can never diverge again). A scan that exceeds this is handled as
# asset-level staleness (the provider stays reachable), not an outage.
_DISCOVERY_LIVE_TIMEOUT_SECS = float(resilience.DISCOVERY_LIVE_TIMEOUT_SECS)


def _absolute_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(
        seconds=resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS
    )


async def collect(envelope: DiscoveryJobEnvelope) -> None:
    """Run one discovery cycle. Raises on hard failure so the worker
    can route to retry / DLQ."""
    provider_id = envelope.provider_id
    asset_name = envelope.asset_name
    is_list_all = asset_name == ""

    async with get_jobs_session() as session:
        prov_row = await get_provider_orm(session, provider_id)
        if prov_row is None:
            # Provider deleted between enqueue and dispatch — drop the cache
            # row if any, ack quietly. No retry will help.
            await _delete_cache(session, provider_id, asset_name)
            logger.info(
                "discovery.provider_missing provider=%s asset=%s — dropped",
                provider_id, asset_name or "<list-all>",
            )
            return

        creds = await get_credentials(session, provider_id)

    # Build a transient provider instance — AFTER the session closed, so
    # no JOBS-pool connection is held across the live provider IO below.
    # (``prov_row`` attribute reads are safe post-close: the session
    # factory sets expire_on_commit=False.) For per-asset stats we pass
    # ``asset_name`` as the graph_name; for list-all we pass None (the
    # FalkorDB driver uses the default DB to enumerate keyspaces).
    instance = provider_manager._create_provider_instance(
        provider_type=prov_row.provider_type,
        host=prov_row.host,
        port=prov_row.port,
        graph_name=None if is_list_all else asset_name,
        tls_enabled=prov_row.tls_enabled,
        credentials=creds,
        extra_config=(
            json.loads(prov_row.extra_config) if prov_row.extra_config else None
        ),
    )

    start_ts = asyncio.get_event_loop().time()
    try:
        async with admission.gate(provider_id, op_kind="discovery"):
            # Fast reachability probe (≤2s) before any expensive driver
            # init. Without this, a provider whose stored host:port is
            # unreachable from the worker's network context (e.g.
            # ``localhost:6379`` left over from in-container setup, now
            # being scanned by a host-run viz-service) would block
            # ``_ensure_connected`` for 30+s and ultimately surface as a
            # raw redis driver exception. Preflight gives us classified
            # reason codes (``tcp_refused``, ``dns_unresolvable``,
            # ``connect_timeout``, …) that the frontend's ``friendlyError``
            # mapper translates into actionable messages.
            pre = await instance.preflight(deadline_s=2.0)
            if not pre.ok:
                target = f"{prov_row.host}:{prov_row.port}"
                error_msg = f"{pre.reason}: {target}"
                duration = asyncio.get_event_loop().time() - start_ts
                logger.warning(
                    "discovery.preflight_failed provider=%s asset=%s "
                    "target=%s reason=%s elapsed_ms=%d total_duration_secs=%.2f",
                    provider_id, asset_name or "<list-all>",
                    target, pre.reason, pre.elapsed_ms, duration,
                )
                # Stamp ``last_error`` on the cache row and return without
                # raising. A misconfigured host won't recover from worker
                # XAUTOCLAIM retries — the user has to fix the provider
                # config. Returning normally lets the worker ACK so we
                # don't waste 5 retries on a clearly-broken config; the
                # UI surfaces ``last_error`` so the user knows what to fix.
                await record_failure(provider_id, asset_name, error_msg)
                return

            if is_list_all:
                graphs = await asyncio.wait_for(
                    instance.list_graphs(), timeout=_DISCOVERY_LIVE_TIMEOUT_SECS
                )
                payload = {"assets": list(graphs)}
            else:
                try:
                    raw = await asyncio.wait_for(
                        instance.get_stats(), timeout=_DISCOVERY_LIVE_TIMEOUT_SECS
                    )
                except Exception as stats_exc:
                    # Preflight already succeeded above → the provider IS
                    # reachable. A slow/erroring stats scan on a large graph
                    # (the two count scans are O(nodes)+O(edges) and blow the
                    # budget on million-edge graphs) is an ASSET-level
                    # staleness signal, NOT a provider outage. Stamp
                    # ``last_error`` (keeps the prior counts) and return so the
                    # admission gate records the provider as REACHABLE —
                    # otherwise the whole provider falsely flips to
                    # "unreachable" while every other view shows it healthy.
                    is_to = isinstance(stats_exc, asyncio.TimeoutError)
                    duration = asyncio.get_event_loop().time() - start_ts
                    logger.warning(
                        "discovery.stats_slow provider=%s asset=%s "
                        "duration_secs=%.2f timeout=%s err=%s",
                        provider_id, asset_name, duration, is_to, stats_exc,
                    )
                    note = (
                        f"Stats refresh exceeded {_DISCOVERY_LIVE_TIMEOUT_SECS:.0f}s "
                        "(large graph) — showing last known counts."
                        if is_to
                        else f"Stats refresh failed (provider reachable): {stats_exc}"
                    )
                    await record_failure(provider_id, asset_name, note)
                    return
                payload = {
                    "nodeCount": raw.get("node_count", raw.get("nodeCount", 0)),
                    "edgeCount": raw.get("edge_count", raw.get("edgeCount", 0)),
                    "entityTypeCounts": raw.get(
                        "entity_type_counts", raw.get("entityTypeCounts", {})
                    ),
                    "edgeTypeCounts": raw.get(
                        "edge_type_counts", raw.get("edgeTypeCounts", {})
                    ),
                }
    except asyncio.TimeoutError:
        duration = asyncio.get_event_loop().time() - start_ts
        logger.warning(
            "discovery.timeout provider=%s asset=%s duration_secs=%.2f timeout_secs=%.0f",
            provider_id, asset_name or "<list-all>",
            duration, _DISCOVERY_LIVE_TIMEOUT_SECS,
        )
        raise
    except Exception as exc:
        duration = asyncio.get_event_loop().time() - start_ts
        logger.error(
            "discovery.failure provider=%s asset=%s duration_secs=%.2f error=%s",
            provider_id, asset_name or "<list-all>",
            duration, exc, exc_info=True,
        )
        raise
    finally:
        # Close the transient instance — it owns a lazily-built connection
        # pool (up to FALKORDB_GRAPH_POOL_SIZE sockets) that would
        # otherwise leak until GC, one pool per discovery job. getattr
        # guard: non-FalkorDB provider types flow through this path too.
        close = getattr(instance, "close", None)
        if close is not None:
            with contextlib.suppress(Exception):
                await close()

    # Registry-vs-observed reconciliation, list-all only, FALKORDB only —
    # other provider types (DataHub, mock, …) return [] or partial sets from
    # list_graphs() by design, so a catalog item there would read as
    # permanently "missing". Runs AFTER the provider IO (outside the admission
    # gate — pure DB reads) and only on this fresh-upsert path, i.e. after a
    # successful, coverage-guarded list_graphs(): a partial cluster raises
    # above and never reaches here. Recomputed every sweep, so the annotation
    # self-clears when the graph returns, the catalog row is archived, or the
    # projection is evicted.
    drift = (
        await _detect_registry_drift(provider_id, set(payload["assets"]))
        if is_list_all and prov_row.provider_type == "falkordb" else None
    )

    async with get_jobs_session() as session:
        await _upsert_cache(
            session,
            provider_id=provider_id,
            asset_name=asset_name,
            payload=payload,
            status="fresh",
            last_error=drift,
        )

    duration = asyncio.get_event_loop().time() - start_ts
    logger.info(
        "discovery.completion provider=%s asset=%s duration_secs=%.2f payload_size=%d",
        provider_id, asset_name or "<list-all>",
        duration, len(json.dumps(payload)),
    )


def _settled_before(projected_at: str | None, horizon: datetime) -> bool:
    """True when a resident projection finished BEFORE ``horizon`` (i.e. has
    been resident long enough that the observed GRAPH.LIST snapshot must
    include it). ``None``/unparseable → settled: long-standing legacy rows
    must stay in the expected set."""
    if not projected_at:
        return True
    try:
        ts = datetime.fromisoformat(projected_at)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return True
    return ts <= horizon


async def _detect_registry_drift(provider_id: str, observed: set) -> str | None:
    """Compare the OBSERVED graph list against what the registry says should
    be resident on this provider; a non-empty gap returns a ``graph_drift:``
    message for the cache row's ``last_error`` (UI banner).

    GRAPH.LIST is a statement about what the cluster holds NOW — not about
    what should exist. Without this check, a provider that restored from a
    stale snapshot or lost a shard's data serves a smaller-but-"fresh" list
    and the platform never notices; registered items just quietly vanish.

    Expected-present: active catalog items (created from observed assets at
    registration, so their graphs existed) ∪ fully-projected AND currently-
    resident versioned graphs (projection_state rows with status='idle' and
    projected_commit_seq > 0) that have been resident for at least one sweep.
    Expected-absent — subtracted from the WHOLE union, because these names can
    also appear in the catalog:

    * every projection_state row NOT currently resident: 'evicted' rows (the
      versioning cache manager physically DROPS cold graphs by design — a
      routine budget eviction must never alarm), and mid-flight
      'projecting'/'rebuilding' rows (the rewarm path flips evicted →
      rebuilding BEFORE the physical graph exists again);
    * resident rows that finished projecting within the last sweep interval —
      the observed list is a snapshot taken BEFORE this comparison, so a
      projection completing between the two would read as "missing" for one
      sweep (TOCTOU). Such rows are alarmed from the NEXT sweep on.

    Best-effort by contract: any failure (unbootstrapped graphver store, DB
    blip) logs a warning and returns None — the drift check must never fail
    the sweep that carries the observed list. Only meaningful AFTER a
    successful, coverage-guarded ``list_graphs()``: the caller runs it on the
    fresh-upsert path only, so a partial cluster can never mass-alarm.
    """
    try:
        from sqlalchemy import func, select

        from backend.app.db.models import CatalogItemORM

        async with get_jobs_session() as session:
            rows = await session.execute(
                select(CatalogItemORM.source_identifier).where(
                    CatalogItemORM.provider_id == provider_id,
                    CatalogItemORM.status == "active",
                    CatalogItemORM.source_identifier.is_not(None),
                )
            )
            expected = {r[0] for r in rows.all() if r[0]}

        # The graphver store lives behind its own engine (GRAPHVER_DB_URL,
        # possibly a separate database) — never joined in a JOBS-pool query.
        from backend.app.services.versioning.config import DEFAULT_FALKOR_PROVIDER
        from backend.app.services.versioning.db import (
            get_session_factory as _graphver_session_factory,
        )
        from backend.app.services.versioning.models import ProjectionStateORM

        settle_horizon = datetime.now(timezone.utc) - timedelta(
            seconds=resilience.DISCOVERY_REFRESH_INTERVAL_SECS
        )
        not_expected: set = set()
        async with _graphver_session_factory()() as vsession:
            rows = await vsession.execute(
                select(
                    ProjectionStateORM.falkor_graph_name,
                    ProjectionStateORM.status,
                    ProjectionStateORM.projected_commit_seq,
                    ProjectionStateORM.last_projected_at,
                ).where(
                    func.coalesce(
                        ProjectionStateORM.falkor_provider, DEFAULT_FALKOR_PROVIDER
                    ) == provider_id,
                    ProjectionStateORM.falkor_graph_name.is_not(None),
                )
            )
            for name, status, seq, projected_at in rows.all():
                if status == "idle" and (seq or 0) > 0:
                    if _settled_before(projected_at, settle_horizon):
                        expected.add(name)
                    else:
                        not_expected.add(name)     # TOCTOU settling window
                else:
                    not_expected.add(name)         # evicted / mid-flight

        missing = sorted((expected - not_expected) - observed)
        if not missing:
            return None
        examples = ", ".join(missing[:3])
        logger.warning(
            "discovery.registry_drift provider=%s missing=%d expected=%d "
            "observed=%d examples=%s",
            provider_id, len(missing), len(expected - not_expected), len(observed),
            examples,
        )
        return (
            f"graph_drift: {len(missing)} registered graph(s) missing from this "
            f"provider (e.g. {examples}) — the provider may have restored from a "
            f"stale snapshot or lost a shard's data"
        )
    except Exception:
        logger.warning(
            "discovery.registry_drift_check_failed provider=%s — skipping "
            "drift check", provider_id, exc_info=True,
        )
        return None


async def record_failure(
    provider_id: str,
    asset_name: str,
    error: str,
) -> None:
    """Stamp ``last_error`` on the existing row (if any) without changing
    its payload. Called mid-IO by this handler and by
    ``worker._handle_failure`` on a failed-but-retriable poll so the
    UI can surface a user-visible reason while the cache still serves
    last-known-good data. Opens its own short JOBS session."""
    async with get_jobs_session() as session:
        existing = await session.get(
            AssetDiscoveryCacheORM, (provider_id, asset_name)
        )
        if existing is None:
            # No prior row — write a stub so the UI can show "unavailable"
            # instead of "computing forever". Empty payload, status=stale.
            now = datetime.now(timezone.utc)
            session.add(
                AssetDiscoveryCacheORM(
                    provider_id=provider_id,
                    asset_name=asset_name,
                    payload="{}",
                    status="stale",
                    computed_at=now.isoformat(),
                    expires_at=_absolute_expiry().isoformat(),
                    last_error=error[:2000],
                )
            )
            return
        existing.last_error = error[:2000]


# ── Internal: cache upsert helpers ───────────────────────────────────

async def _upsert_cache(
    session: AsyncSession,
    *,
    provider_id: str,
    asset_name: str,
    payload: dict,
    status: str,
    last_error: str | None,
) -> None:
    """Insert-or-update one cache row. Uses ON CONFLICT DO UPDATE for
    the Postgres path (production) and a REPLACE-style fallback for
    SQLite (tests).
    """
    now = datetime.now(timezone.utc)
    row_values = {
        "provider_id": provider_id,
        "asset_name": asset_name,
        "payload": json.dumps(payload),
        "status": status,
        "computed_at": now.isoformat(),
        "expires_at": _absolute_expiry().isoformat(),
        "last_error": last_error,
    }
    dialect = session.bind.dialect.name if session.bind is not None else "sqlite"
    if dialect == "postgresql":
        stmt = pg_insert(AssetDiscoveryCacheORM).values(**row_values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["provider_id", "asset_name"],
            set_={
                "payload": stmt.excluded.payload,
                "status": stmt.excluded.status,
                "computed_at": stmt.excluded.computed_at,
                "expires_at": stmt.excluded.expires_at,
                "last_error": stmt.excluded.last_error,
            },
        )
        await session.execute(stmt)
    else:
        # SQLite path: ORM merge — load if present and overwrite, else insert.
        stmt = sqlite_insert(AssetDiscoveryCacheORM).values(**row_values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["provider_id", "asset_name"],
            set_={
                "payload": stmt.excluded.payload,
                "status": stmt.excluded.status,
                "computed_at": stmt.excluded.computed_at,
                "expires_at": stmt.excluded.expires_at,
                "last_error": stmt.excluded.last_error,
            },
        )
        await session.execute(stmt)


async def _delete_cache(
    session: AsyncSession, provider_id: str, asset_name: str,
) -> None:
    existing = await session.get(
        AssetDiscoveryCacheORM, (provider_id, asset_name)
    )
    if existing is not None:
        await session.delete(existing)


# Self-register with the dispatcher.
dispatcher.register_handler("discovery", collect)
