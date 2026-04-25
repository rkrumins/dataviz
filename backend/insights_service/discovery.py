"""Pre-registration asset discovery collector.

Two flavors keyed off ``DiscoveryJobEnvelope.asset_name``:

* ``""``  — list every asset on the provider; persists ``{"assets": [...]}``
  under the (provider_id, "") cache row.
* other   — fetch stats for that single asset; persists a node/edge-count
  payload under the (provider_id, asset_name) cache row.

The handler runs inside the worker's per-job DB session. It instantiates
a provider via the static ``ProviderManager._create_provider_instance``
helper — same path as the legacy ``providers.py`` short-session
endpoints so adapter behaviour stays identical. The web tier never hits
this code path; web reads go straight to ``asset_discovery_cache``.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import resilience
from backend.app.db.models import AssetDiscoveryCacheORM
from backend.app.db.repositories.provider_repo import get_credentials, get_provider_orm
from backend.app.providers.manager import provider_manager

from . import admission, dispatcher
from .schemas import DiscoveryJobEnvelope

logger = logging.getLogger(__name__)


# Live-call timeout matches the legacy short-session endpoint behaviour
# (10s in providers.py:406,422). Centralised here so it can be tuned.
_DISCOVERY_LIVE_TIMEOUT_SECS = float(
    __import__("os").getenv("DISCOVERY_LIVE_TIMEOUT_SECS", "10")
)


def _absolute_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(
        seconds=resilience.STATS_CACHE_ABSOLUTE_EXPIRY_SECS
    )


async def collect(session: AsyncSession, envelope: DiscoveryJobEnvelope) -> None:
    """Run one discovery cycle. Commits on success or partial-failure;
    raises on hard failure so the worker can route to retry / DLQ."""
    provider_id = envelope.provider_id
    asset_name = envelope.asset_name
    is_list_all = asset_name == ""

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

    # Build a transient provider instance. For per-asset stats we pass
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
            if is_list_all:
                graphs = await asyncio.wait_for(
                    instance.list_graphs(), timeout=_DISCOVERY_LIVE_TIMEOUT_SECS
                )
                payload = {"assets": list(graphs)}
            else:
                raw = await asyncio.wait_for(
                    instance.get_stats(), timeout=_DISCOVERY_LIVE_TIMEOUT_SECS
                )
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

    await _upsert_cache(
        session,
        provider_id=provider_id,
        asset_name=asset_name,
        payload=payload,
        status="fresh",
        last_error=None,
    )

    duration = asyncio.get_event_loop().time() - start_ts
    logger.info(
        "discovery.completion provider=%s asset=%s duration_secs=%.2f payload_size=%d",
        provider_id, asset_name or "<list-all>",
        duration, len(json.dumps(payload)),
    )


async def record_failure(
    session: AsyncSession,
    provider_id: str,
    asset_name: str,
    error: str,
) -> None:
    """Stamp ``last_error`` on the existing row (if any) without changing
    its payload. Worker calls this on a failed-but-retriable poll so the
    UI can surface a user-visible reason while the cache still serves
    last-known-good data."""
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
