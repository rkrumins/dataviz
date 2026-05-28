"""FalkorDB projector for authored graphs (V1-5).

The hot read projection for ``main`` of every authored graph. Postgres
remains the cold system-of-record holding every commit, every per-
attribute audit row, every content blob. FalkorDB holds ONLY the
current state of each graph's default branch in a per-graph namespace
``authored_<graph_id>`` — bounded blast radius, no cross-graph key
collisions, never the shared ``nexus_lineage`` namespace used by
external lineage.

Pipeline (per ``visualization.graph.committed`` event on default branch):

1. Read the graph's ``default_branch`` from Postgres; skip if the
   commit's branch is something else.
2. Idempotency check against ``graph_projector_cursor`` keyed by
   ``(graph_id, 'falkordb')`` — skip when
   ``last_applied_commit_seq >= this commit's commit_seq``. Replay-safe
   because the cursor advances atomically with the FalkorDB MERGE/DELETE
   batches (best-effort: FalkorDB is downstream, so dual-write is
   unavoidable; the cursor + content-addressed MERGE makes re-apply
   idempotent).
3. Read every ``graph_change_event`` row for this commit, plus the
   resulting content blobs from ``graph_node_versions`` /
   ``graph_edge_versions`` (keyed by ``new_content_hash``).
4. Apply as batched ``UNWIND $rows ... MERGE``/``DELETE`` queries
   chunked at :data:`_BATCH_SIZE` so large bulk-imports don't blow up
   FalkorDB. Scaling target: a 1M-node commit projects in O(N/BATCH)
   round-trips with bounded per-query memory.
5. Update the cursor (commit_seq, commit_id, stream_id, lag_seconds)
   in Postgres + ACK the stream entry.

Best-effort policy: FalkorDB unavailability never breaks writes. The
projector retries with exponential backoff; the cursor stays at the
last-applied commit; the stream entry stays in the consumer group's
pending list until the projector catches up. Reads against an
un-projected commit fall back to the Postgres snapshot reader (the
existing ``/refs/{ref}/snapshot`` path).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.graph_store_engine import get_graph_store_jobs_session
from backend.app.db.models_graph import (
    GraphChangeEventORM,
    GraphCommitORM,
    GraphEdgeVersionORM,
    GraphNodeVersionORM,
    GraphProjectorCursorORM,
    UserGraphORM,
)

logger = logging.getLogger(__name__)

# Stream + consumer group names mirror the existing outbox shape.
STREAM_NAME = "graph.outbox"
CONSUMER_GROUP = "falkor_projector_v1"
TARGET = "falkordb"

# Per-query Cypher batch size. Picked so a single UNWIND payload stays
# well below FalkorDB's per-query memory budget at any reasonable
# property size. Operators can tune via env.
_BATCH_SIZE = int(os.getenv("GRAPH_FALKOR_PROJECTOR_BATCH", "1000"))

# Backoff bounds for transient FalkorDB / Redis failures.
_BACKOFF_MIN_S = 0.5
_BACKOFF_MAX_S = 30.0


@dataclass
class _ProjectorState:
    """Cached per-graph state — graph_id → default_branch. Filled on
    first event for that graph and only refreshed on cache miss.
    Cheap because the default branch is immutable for the graph's
    lifetime."""

    default_branches: dict[str, str]


# ── public entry point ─────────────────────────────────────────────


async def run_falkor_projector(
    *,
    stop_event: Optional[asyncio.Event] = None,
    poll_block_ms: int = 5000,
    consumer_name: str | None = None,
    redis_client=None,
    falkor_client=None,
) -> None:
    """Long-running loop. Reads :data:`STREAM_NAME` via ``XREADGROUP``,
    projects every default-branch commit into the per-graph FalkorDB
    namespace, advances :class:`GraphProjectorCursorORM`. Cancellation
    via ``stop_event`` is best-effort: a poll in progress finishes,
    the loop returns.

    Designed to be supervised by the FastAPI lifespan task. Survives
    transient errors via exponential backoff so a FalkorDB outage
    self-recovers without manual intervention.
    """
    if consumer_name is None:
        consumer_name = f"projector-{os.getpid()}"

    redis = redis_client
    if redis is None:
        from backend.app.services.aggregation.redis_client import get_redis
        redis = get_redis()

    # Best-effort consumer-group creation. MKSTREAM lets us subscribe
    # before any event has been published yet (cold start).
    try:
        await redis.xgroup_create(
            STREAM_NAME, CONSUMER_GROUP, id="0", mkstream=True,
        )
    except Exception as exc:  # noqa: BLE001 — almost always BUSYGROUP
        if "BUSYGROUP" not in str(exc):
            logger.warning(
                "Could not create consumer group %r on %r: %s — "
                "assuming it already exists",
                CONSUMER_GROUP, STREAM_NAME, exc,
            )

    state = _ProjectorState(default_branches={})
    backoff = _BACKOFF_MIN_S

    while stop_event is None or not stop_event.is_set():
        try:
            entries = await redis.xreadgroup(
                CONSUMER_GROUP, consumer_name,
                {STREAM_NAME: ">"},
                count=32,
                block=poll_block_ms,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop recovers
            logger.warning(
                "FalkorDB projector XREADGROUP failed (backoff %.1fs): %s",
                backoff, exc,
            )
            await asyncio.sleep(backoff)
            backoff = min(_BACKOFF_MAX_S, backoff * 2)
            continue

        backoff = _BACKOFF_MIN_S  # successful read → reset

        if not entries:
            continue

        for _stream, msgs in entries:
            for stream_id, fields in msgs:
                try:
                    handled = await _process_event(
                        stream_id, fields, state=state,
                        falkor_client=falkor_client,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — best-effort
                    logger.exception(
                        "FalkorDB projection failed for stream entry "
                        "%r: %s", stream_id, exc,
                    )
                    # Do NOT ack — leave on the consumer group's PEL
                    # so it retries on the next poll once the cursor
                    # has been investigated / FalkorDB recovers.
                    continue
                if handled:
                    # Ack the stream entry so it doesn't sit in PEL.
                    try:
                        await redis.xack(
                            STREAM_NAME, CONSUMER_GROUP, stream_id,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "XACK failed for %r: %s (will retry)",
                            stream_id, exc,
                        )


# ── per-event ──────────────────────────────────────────────────────


async def _process_event(
    stream_id: str,
    fields: Mapping[str, Any],
    *,
    state: _ProjectorState,
    falkor_client=None,
) -> bool:
    """Project one event. Returns True if the event was handled (ack
    it), False to skip silently without ack."""
    event_type = fields.get("event_type") or fields.get(b"event_type")
    if isinstance(event_type, bytes):
        event_type = event_type.decode()
    if event_type != "visualization.graph.committed":
        return True  # not for us; ack so it doesn't loop

    raw_payload = fields.get("payload") or fields.get(b"payload")
    if isinstance(raw_payload, bytes):
        raw_payload = raw_payload.decode()
    try:
        payload = json.loads(raw_payload) if raw_payload else {}
    except Exception:
        logger.warning("FalkorDB projector: malformed payload on %r", stream_id)
        return True  # malformed → drop, don't loop

    graph_id = payload.get("graph_id")
    branch = payload.get("branch")
    commit_id = payload.get("commit_id")
    if not (graph_id and branch and commit_id):
        return True

    async with get_graph_store_jobs_session() as session:
        default_branch = await _get_default_branch(
            session, graph_id=graph_id, state=state,
        )
        if default_branch is None:
            # Graph deleted between commit and projection — drop.
            return True
        if branch != default_branch:
            return True  # non-trunk commits aren't projected

        commit_seq = await _get_commit_seq(
            session, graph_id=graph_id, commit_id=commit_id,
        )
        if commit_seq is None:
            return True  # commit vanished (shouldn't happen, but be safe)

        cursor = await _load_cursor(session, graph_id=graph_id)
        if (
            cursor is not None
            and cursor.last_applied_commit_seq is not None
            and cursor.last_applied_commit_seq >= commit_seq
        ):
            return True  # idempotent replay — already projected

        events = await _read_change_events(
            session, graph_id=graph_id, commit_id=commit_id,
        )
        if not events:
            await _advance_cursor(
                session, graph_id=graph_id, commit_seq=commit_seq,
                commit_id=commit_id, stream_id=stream_id,
                lag_seconds=None,
            )
            await session.commit()
            return True

        node_blobs, edge_blobs = await _load_content_blobs(
            session, graph_id=graph_id, events=events,
        )

    # FalkorDB writes happen OUTSIDE the Postgres txn because they are
    # downstream (cold store remains authoritative). Cypher MERGE +
    # DELETE on `(graph_id, urn)` is idempotent so a retry after a
    # partial failure converges.
    started = time.monotonic()
    try:
        await _apply_to_falkor(
            graph_id=graph_id,
            events=events,
            node_blobs=node_blobs,
            edge_blobs=edge_blobs,
            falkor_client=falkor_client,
        )
    except Exception:
        # Falkor failed — leave cursor unchanged so we retry the same
        # commit on the next poll. Re-raise so the outer loop logs
        # and skips the ACK.
        raise
    lag_seconds = time.monotonic() - started

    # Advance the cursor + emit the freshness signal in one txn after
    # FalkorDB succeeded. The materialized event drives the authored-
    # data-source relay to flip ``aggregation_status`` to ``ready``.
    from datetime import datetime, timezone
    materialized_at = datetime.now(timezone.utc).isoformat()
    async with get_graph_store_jobs_session() as session:
        workspace_id = await _get_workspace_id(
            session, graph_id=graph_id,
        )
        await _advance_cursor(
            session, graph_id=graph_id, commit_seq=commit_seq,
            commit_id=commit_id, stream_id=stream_id,
            lag_seconds=lag_seconds,
        )
        if workspace_id is not None:
            from backend.app.db.repositories import (
                graph_store_outbox_repo,
            )
            await graph_store_outbox_repo.emit(
                session,
                event_type="visualization.graph.materialized",
                aggregate_id=graph_id,
                aggregate_type="graph",
                payload={
                    "graph_id": graph_id,
                    "workspace_id": workspace_id,
                    "commit_id": commit_id,
                    "materialized_at": materialized_at,
                },
            )
        await session.commit()

    return True


# ── cursor + lookups ───────────────────────────────────────────────


async def _get_default_branch(
    session: AsyncSession, *, graph_id: str, state: _ProjectorState,
) -> str | None:
    cached = state.default_branches.get(graph_id)
    if cached is not None:
        return cached
    row = (
        await session.execute(
            select(UserGraphORM.default_branch).where(
                UserGraphORM.id == graph_id,
                UserGraphORM.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is not None:
        state.default_branches[graph_id] = row
    return row


async def _get_workspace_id(
    session: AsyncSession, *, graph_id: str,
) -> str | None:
    """Return the owning workspace_id for the graph, or None if the
    graph was deleted between commit and projection."""
    return (
        await session.execute(
            select(UserGraphORM.workspace_id).where(
                UserGraphORM.id == graph_id,
            )
        )
    ).scalar_one_or_none()


async def _get_commit_seq(
    session: AsyncSession, *, graph_id: str, commit_id: str,
) -> int | None:
    return (
        await session.execute(
            select(GraphCommitORM.commit_seq).where(
                GraphCommitORM.id == commit_id,
                GraphCommitORM.graph_id == graph_id,
            )
        )
    ).scalar_one_or_none()


async def _load_cursor(
    session: AsyncSession, *, graph_id: str,
) -> GraphProjectorCursorORM | None:
    return (
        await session.execute(
            select(GraphProjectorCursorORM).where(
                GraphProjectorCursorORM.graph_id == graph_id,
                GraphProjectorCursorORM.target == TARGET,
            )
        )
    ).scalar_one_or_none()


async def _advance_cursor(
    session: AsyncSession,
    *,
    graph_id: str,
    commit_seq: int,
    commit_id: str,
    stream_id: str,
    lag_seconds: float | None,
) -> None:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    await session.execute(
        pg_insert(GraphProjectorCursorORM)
        .values(
            graph_id=graph_id,
            target=TARGET,
            last_applied_commit_seq=commit_seq,
            last_applied_commit_id=commit_id,
            last_stream_id=stream_id,
            lag_seconds_observed=(
                str(lag_seconds) if lag_seconds is not None else None
            ),
            last_error=None,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["graph_id", "target"],
            set_={
                "last_applied_commit_seq": commit_seq,
                "last_applied_commit_id": commit_id,
                "last_stream_id": stream_id,
                "lag_seconds_observed": (
                    str(lag_seconds) if lag_seconds is not None else None
                ),
                "last_error": None,
                "updated_at": now,
            },
        )
    )


async def _read_change_events(
    session: AsyncSession, *, graph_id: str, commit_id: str,
) -> list[GraphChangeEventORM]:
    return list(
        (
            await session.execute(
                select(GraphChangeEventORM)
                .where(
                    GraphChangeEventORM.graph_id == graph_id,
                    GraphChangeEventORM.commit_id == commit_id,
                    GraphChangeEventORM.object_kind.in_(("node", "edge")),
                )
                .order_by(GraphChangeEventORM.created_at)
            )
        ).scalars().all()
    )


async def _load_content_blobs(
    session: AsyncSession,
    *,
    graph_id: str,
    events: list[GraphChangeEventORM],
) -> tuple[
    dict[str, GraphNodeVersionORM],
    dict[str, GraphEdgeVersionORM],
]:
    node_hashes = {
        ev.new_content_hash for ev in events
        if ev.object_kind == "node" and ev.new_content_hash
    }
    edge_hashes = {
        ev.new_content_hash for ev in events
        if ev.object_kind == "edge" and ev.new_content_hash
    }
    node_blobs: dict[str, GraphNodeVersionORM] = {}
    edge_blobs: dict[str, GraphEdgeVersionORM] = {}
    if node_hashes:
        rows = (
            await session.execute(
                select(GraphNodeVersionORM).where(
                    GraphNodeVersionORM.graph_id == graph_id,
                    GraphNodeVersionORM.content_hash.in_(node_hashes),
                )
            )
        ).scalars().all()
        for row in rows:
            node_blobs[row.content_hash] = row
    if edge_hashes:
        rows = (
            await session.execute(
                select(GraphEdgeVersionORM).where(
                    GraphEdgeVersionORM.graph_id == graph_id,
                    GraphEdgeVersionORM.content_hash.in_(edge_hashes),
                )
            )
        ).scalars().all()
        for row in rows:
            edge_blobs[row.content_hash] = row
    return node_blobs, edge_blobs


# ── FalkorDB writes ────────────────────────────────────────────────


async def _apply_to_falkor(
    *,
    graph_id: str,
    events: list[GraphChangeEventORM],
    node_blobs: Mapping[str, GraphNodeVersionORM],
    edge_blobs: Mapping[str, GraphEdgeVersionORM],
    falkor_client=None,
) -> None:
    """Apply a commit's deltas to ``authored_<graph_id>``.

    Batched by action + kind so large bulk-import commits stay within
    FalkorDB's per-query memory budget. Cypher uses generic ``:Node``
    label keyed by ``urn`` and a generic ``:CONNECTS`` relationship
    with ``edge_type`` stored as a property — V1 keeps projection
    schema uniform so the projector doesn't have to generate dynamic
    Cypher per entity-type. Higher-fidelity projections (per-label,
    per-relationship-type) are a v2 enhancement gated on actual query
    patterns; the cold store retains the full fidelity either way.
    """
    g = await _get_falkor_graph(graph_id, falkor_client=falkor_client)
    if g is None:
        # FalkorDB not configured — projector becomes a no-op.
        # Reads fall back to Postgres snapshots. Operators see the
        # cursor stay stuck which is the correct alarm.
        raise RuntimeError("FalkorDB client unavailable")

    node_upserts: list[dict[str, Any]] = []
    node_deletes: list[dict[str, Any]] = []
    edge_upserts: list[dict[str, Any]] = []
    edge_deletes: list[dict[str, Any]] = []

    for ev in events:
        if ev.object_kind == "node":
            if ev.action == "deleted":
                node_deletes.append({"urn": ev.object_id})
            else:
                blob = (
                    node_blobs.get(ev.new_content_hash)
                    if ev.new_content_hash else None
                )
                if blob is None:
                    continue
                node_upserts.append({
                    "urn": ev.object_id,
                    "entity_type": blob.entity_type or "",
                    "display_name": blob.display_name or "",
                    "props_json": json.dumps(blob.properties or {}),
                    "tags_json": json.dumps(blob.tags or []),
                    "position_json": json.dumps(blob.position or {}),
                    "content_hash": blob.content_hash,
                })
        elif ev.object_kind == "edge":
            if ev.action == "deleted":
                edge_deletes.append({"urn": ev.object_id})
            else:
                blob = (
                    edge_blobs.get(ev.new_content_hash)
                    if ev.new_content_hash else None
                )
                if blob is None:
                    continue
                edge_upserts.append({
                    "urn": ev.object_id,
                    "source_urn": blob.source_node_key,
                    "target_urn": blob.target_node_key,
                    "edge_type": blob.edge_type or "",
                    "props_json": json.dumps(blob.properties or {}),
                    "confidence": (
                        float(blob.confidence)
                        if blob.confidence is not None else None
                    ),
                    "content_hash": blob.content_hash,
                })

    # Order: node upserts → edge upserts → edge deletes → node deletes.
    # MERGE before SET ensures missing endpoints get created
    # (consistent with Falkor's autocreate). Deletes last so we don't
    # accidentally drop a node that is about to be re-targeted by an
    # edge update in the same commit.
    for chunk in _chunks(node_upserts, _BATCH_SIZE):
        await g.query(
            """
            UNWIND $rows AS r
            MERGE (n:Node {urn: r.urn})
            SET n.entity_type = r.entity_type,
                n.display_name = r.display_name,
                n.properties = r.props_json,
                n.tags = r.tags_json,
                n.position = r.position_json,
                n.content_hash = r.content_hash
            """,
            params={"rows": chunk},
        )
    for chunk in _chunks(edge_upserts, _BATCH_SIZE):
        await g.query(
            """
            UNWIND $rows AS r
            MERGE (s:Node {urn: r.source_urn})
            MERGE (t:Node {urn: r.target_urn})
            MERGE (s)-[e:CONNECTS {urn: r.urn}]->(t)
            SET e.edge_type = r.edge_type,
                e.properties = r.props_json,
                e.confidence = r.confidence,
                e.content_hash = r.content_hash
            """,
            params={"rows": chunk},
        )
    for chunk in _chunks(edge_deletes, _BATCH_SIZE):
        await g.query(
            """
            UNWIND $rows AS r
            MATCH ()-[e:CONNECTS {urn: r.urn}]->()
            DELETE e
            """,
            params={"rows": chunk},
        )
    for chunk in _chunks(node_deletes, _BATCH_SIZE):
        await g.query(
            """
            UNWIND $rows AS r
            MATCH (n:Node {urn: r.urn})
            DETACH DELETE n
            """,
            params={"rows": chunk},
        )


def _chunks(seq: list[Any], n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ── FalkorDB client cache ──────────────────────────────────────────


_falkor_singleton: Any = None


async def _get_falkor_graph(graph_id: str, *, falkor_client=None):
    """Return a Falkor graph handle for ``authored_<graph_id>``.

    Reuses one FalkorDB connection pool across graphs (cheap — each
    ``select_graph`` is a thin handle). The connection itself is
    constructed lazily on first use; if FALKORDB_HOST is unset the
    projector skips work and the cursor stays put."""
    global _falkor_singleton

    if falkor_client is not None:
        return falkor_client.select_graph(f"authored_{graph_id}")

    if _falkor_singleton is None:
        host = os.getenv("FALKORDB_HOST")
        if not host:
            return None
        port = int(os.getenv("FALKORDB_PORT", "6379"))
        username = os.getenv("FALKORDB_USERNAME") or None
        password = os.getenv("FALKORDB_PASSWORD") or None

        try:
            from redis.asyncio import ConnectionPool
            from falkordb.asyncio import FalkorDB
        except ImportError:
            logger.warning(
                "falkordb client library not installed — projector idle",
            )
            return None

        pool_kwargs: dict[str, Any] = {
            "host": host,
            "port": port,
            "max_connections": int(
                os.getenv("GRAPH_FALKOR_PROJECTOR_POOL_SIZE", "8")
            ),
            "socket_connect_timeout": 2.0,
            "socket_timeout": float(
                os.getenv("GRAPH_FALKOR_PROJECTOR_TIMEOUT_S", "30")
            ),
            "decode_responses": True,
        }
        if username:
            pool_kwargs["username"] = username
        if password:
            pool_kwargs["password"] = password
        pool = ConnectionPool(**pool_kwargs)
        _falkor_singleton = FalkorDB(connection_pool=pool)

    return _falkor_singleton.select_graph(f"authored_{graph_id}")


__all__ = [
    "run_falkor_projector",
    "STREAM_NAME",
    "CONSUMER_GROUP",
    "TARGET",
]
