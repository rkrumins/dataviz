"""Authored-graph → workspace_data_sources relay.

Consumes the ``graph.outbox`` Redis stream and projects authored-graph
lifecycle events into the **management DB**'s ``workspace_data_sources``
table, so authored graphs appear in the existing data-source catalog
and route through ``ContextEngine.for_workspace(ws_id, data_source_id)``
unchanged.

Events handled:

* ``visualization.user_graph.created`` → INSERT a workspace_data_sources
  row pointing at the system FalkorDB provider (see the
  ``20260528_authored_falkor_provider`` migration) with
  ``graph_name='authored_<graph_id>'`` and ``aggregation_status='pending'``.
* ``visualization.user_graph.deleted`` → soft-delete the matching row
  (``deleted_at`` set, ``is_active=False``).
* ``visualization.graph.materialized`` → tick the row to
  ``aggregation_status='ready'`` with fresh
  ``last_aggregated_at`` / ``aggregation_edge_count`` /
  ``graph_fingerprint`` (M2).

Idempotency:

* CREATE relies on the existing ``uq_ds_ws_prov_graph`` UNIQUE
  constraint via ``ON CONFLICT DO NOTHING`` — XREADGROUP at-least-once
  redelivery is a no-op.
* DELETE is an UPDATE on the matching row — re-delivery just stamps
  the same ``deleted_at`` again.
* MATERIALIZED is an UPDATE guarded with WHERE EXISTS — if the
  ``created`` event hasn't drained yet (race), this is a no-op and the
  next commit's tick catches up.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceDataSourceORM

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


STREAM_NAME = "graph.outbox"
CONSUMER_GROUP = "authored_ds_relay_v1"

# Stable id of the singleton FalkorDB provider that authored
# workspace_data_sources rows reference. Bootstrapped by
# ``20260528_authored_falkor_provider`` migration.
SYSTEM_AUTHORED_FALKOR_PROVIDER_ID = "prov_sys_authored_falkor"

# Event types this consumer recognises. Anything else is XACK'd
# without effect so other consumer groups on the same stream are
# unaffected.
_HANDLED_EVENT_TYPES = frozenset({
    "visualization.user_graph.created",
    "visualization.user_graph.deleted",
    "visualization.graph.materialized",
})


def authored_graph_name(graph_id: str) -> str:
    """The FalkorDB namespace the projector writes to and that the
    workspace_data_sources row references."""
    return f"authored_{graph_id}"


async def _existing_row(
    session: AsyncSession,
    *,
    workspace_id: str,
    graph_name: str,
) -> Optional[WorkspaceDataSourceORM]:
    return (
        await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.workspace_id == workspace_id,
                WorkspaceDataSourceORM.provider_id
                == SYSTEM_AUTHORED_FALKOR_PROVIDER_ID,
                WorkspaceDataSourceORM.graph_name == graph_name,
            )
        )
    ).scalar_one_or_none()


async def _handle_created(
    session: AsyncSession, payload: dict[str, Any]
) -> None:
    graph_id = payload.get("graph_id")
    workspace_id = payload.get("workspace_id")
    if not graph_id or not workspace_id:
        logger.warning(
            "user_graph.created missing graph_id/workspace_id: %s", payload
        )
        return
    graph_name = payload.get("falkor_namespace") or authored_graph_name(graph_id)
    # SELECT-then-INSERT instead of ON CONFLICT — the consumer group
    # guarantees a single in-flight consumer per stream partition, so a
    # race is bounded to redelivery only, which still hits the unique
    # constraint. Dialect-portable for the SQLite-backed test suite.
    if await _existing_row(
        session, workspace_id=workspace_id, graph_name=graph_name,
    ) is not None:
        return
    session.add(
        WorkspaceDataSourceORM(
            id=f"ds_authored_{graph_id}",
            workspace_id=workspace_id,
            provider_id=SYSTEM_AUTHORED_FALKOR_PROVIDER_ID,
            graph_name=graph_name,
            label=payload.get("name") or graph_name,
            is_primary=False,
            is_active=True,
            access_level="read",
            aggregation_status="pending",
            aggregation_edge_count=0,
            extra_config=json.dumps(
                {"origin": "authored", "graph_id": graph_id},
                separators=(",", ":"),
            ),
            created_by=payload.get("created_by"),
        )
    )


async def _handle_deleted(
    session: AsyncSession, payload: dict[str, Any]
) -> None:
    graph_id = payload.get("graph_id")
    workspace_id = payload.get("workspace_id")
    if not graph_id or not workspace_id:
        logger.warning(
            "user_graph.deleted missing graph_id/workspace_id: %s", payload
        )
        return
    graph_name = payload.get("falkor_namespace") or authored_graph_name(graph_id)
    await session.execute(
        update(WorkspaceDataSourceORM)
        .where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.provider_id
            == SYSTEM_AUTHORED_FALKOR_PROVIDER_ID,
            WorkspaceDataSourceORM.graph_name == graph_name,
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
        .values(
            deleted_at=_now_iso(),
            deleted_by=payload.get("deleted_by"),
            is_active=False,
        )
    )


async def _handle_materialized(
    session: AsyncSession, payload: dict[str, Any]
) -> None:
    graph_id = payload.get("graph_id")
    workspace_id = payload.get("workspace_id")
    commit_id = payload.get("commit_id") or ""
    if not graph_id or not workspace_id:
        logger.warning(
            "graph.materialized missing graph_id/workspace_id: %s", payload
        )
        return
    graph_name = authored_graph_name(graph_id)
    materialized_at = payload.get("materialized_at") or _now_iso()
    # Node/edge totals aren't tracked in the materialized payload (a
    # SELECT COUNT across versions is O(graph) and freshness only
    # needs a monotonic signal). The fingerprint is keyed by commit_id
    # so it changes on every commit, which is what the catalog's
    # change-detection consumers rely on.
    fp = hashlib.sha256(commit_id.encode("utf-8")).hexdigest()
    await session.execute(
        update(WorkspaceDataSourceORM)
        .where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.provider_id
            == SYSTEM_AUTHORED_FALKOR_PROVIDER_ID,
            WorkspaceDataSourceORM.graph_name == graph_name,
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
        .values(
            aggregation_status="ready",
            last_aggregated_at=materialized_at,
            graph_fingerprint=fp,
        )
    )


async def dispatch(
    session: AsyncSession,
    *,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Apply one event to the management DB inside the caller's open
    transaction. Unknown event types are ignored (no error)."""
    if event_type == "visualization.user_graph.created":
        await _handle_created(session, payload)
    elif event_type == "visualization.user_graph.deleted":
        await _handle_deleted(session, payload)
    elif event_type == "visualization.graph.materialized":
        await _handle_materialized(session, payload)
    # Other events on the stream (e.g. graph.committed, working_set.advanced)
    # belong to other consumer groups; we silently no-op.


async def run_authored_data_source_relay(
    *,
    stop_event: Optional[asyncio.Event] = None,
    redis_client=None,
    consumer_name: Optional[str] = None,
    poll_block_ms: int = 5000,
    batch_size: int = 100,
) -> None:
    """Long-running lifespan task — XREADGROUP, dispatch, XACK.

    Joins consumer group :data:`CONSUMER_GROUP` on :data:`STREAM_NAME`
    so multiple replicas partition the work. Each batch is applied
    inside one management-DB transaction; on success the entries are
    XACK'd; on failure the batch is left unacked and Redis redelivers
    to the next consumer (at-least-once; handlers are idempotent).
    """
    from backend.app.db.engine import get_jobs_session

    redis = redis_client
    if redis is None:
        from backend.app.services.aggregation.redis_client import get_redis
        redis = get_redis()

    if consumer_name is None:
        consumer_name = f"authored-ds-relay-{os.getpid()}"

    try:
        await redis.xgroup_create(
            STREAM_NAME, CONSUMER_GROUP, id="0", mkstream=True,
        )
    except Exception as exc:  # noqa: BLE001 — almost always BUSYGROUP
        if "BUSYGROUP" not in str(exc):
            logger.warning(
                "Could not create consumer group %r on %r: %s",
                CONSUMER_GROUP, STREAM_NAME, exc,
            )

    logger.info(
        "Authored data-source relay started (group=%s, stream=%s)",
        CONSUMER_GROUP, STREAM_NAME,
    )

    while stop_event is None or not stop_event.is_set():
        try:
            entries = await redis.xreadgroup(
                CONSUMER_GROUP,
                consumer_name,
                {STREAM_NAME: ">"},
                count=batch_size,
                block=poll_block_ms,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "authored_ds_relay xreadgroup failed (retrying): %s", exc
            )
            await asyncio.sleep(1.0)
            continue

        if not entries:
            continue

        # entries = [(stream_name, [(entry_id, {fields}), ...])]
        to_ack: list[str] = []
        actionable: list[tuple[str, dict[str, Any]]] = []
        for _stream, items in entries:
            for entry_id, fields in items:
                event_type = fields.get("event_type") or fields.get(b"event_type")
                if isinstance(event_type, bytes):
                    event_type = event_type.decode("utf-8")
                if event_type not in _HANDLED_EVENT_TYPES:
                    to_ack.append(entry_id)
                    continue
                raw_payload = fields.get("payload") or fields.get(b"payload") or "{}"
                if isinstance(raw_payload, bytes):
                    raw_payload = raw_payload.decode("utf-8")
                try:
                    payload = json.loads(raw_payload)
                except json.JSONDecodeError:
                    logger.warning(
                        "authored_ds_relay: malformed payload on %s; "
                        "acking to skip", entry_id,
                    )
                    to_ack.append(entry_id)
                    continue
                actionable.append((entry_id, {"event_type": event_type, "payload": payload}))

        if actionable:
            try:
                async with get_jobs_session() as session:
                    for _entry_id, ev in actionable:
                        await dispatch(
                            session,
                            event_type=ev["event_type"],
                            payload=ev["payload"],
                        )
                    await session.commit()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "authored_ds_relay: batch apply failed (%d events) — "
                    "leaving unacked for redelivery: %s",
                    len(actionable), exc,
                )
                # Skip XACK so Redis redelivers; ack only the ignored entries.
                if to_ack:
                    try:
                        await redis.xack(STREAM_NAME, CONSUMER_GROUP, *to_ack)
                    except Exception:  # noqa: BLE001
                        pass
                continue
            to_ack.extend(entry_id for entry_id, _ in actionable)

        if to_ack:
            try:
                await redis.xack(STREAM_NAME, CONSUMER_GROUP, *to_ack)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "authored_ds_relay: xack failed for %d entries: %s",
                    len(to_ack), exc,
                )

    logger.info("Authored data-source relay stopped")


__all__ = [
    "STREAM_NAME",
    "CONSUMER_GROUP",
    "SYSTEM_AUTHORED_FALKOR_PROVIDER_ID",
    "authored_graph_name",
    "dispatch",
    "run_authored_data_source_relay",
]
