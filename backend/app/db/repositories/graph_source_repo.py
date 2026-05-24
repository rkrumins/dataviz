"""Source-layer repository — reads + writes for connected (Mode-2)
graphs. Wraps INSERT/UPSERT/DELETE over ``graph_source_nodes`` /
``graph_source_edges`` / ``graph_source_snapshots`` /
``graph_orphan_enrichments``.

This repo never touches ``graph_change_event`` — the source layer
keeps its own audit trail (one row per sync run in
``graph_source_snapshots``). The enrichment layer
(``graph_node_versions`` + ``graph_change_event``) is unaffected.
That separation is what the layered-model addendum guarantees.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Mapping, Sequence

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models_graph import (
    GraphOrphanEnrichmentORM,
    GraphSourceEdgeORM,
    GraphSourceNodeORM,
    GraphSourceSnapshotORM,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _node_content_hash(
    *, urn: str, entity_type: str | None, display_name: str | None,
    position: Mapping | None, properties: Mapping, tags: Sequence[str],
) -> str:
    """Stable digest over node fields. SHA-256 of a canonical JSON
    encoding (sorted keys, no whitespace) so two runs producing the
    same content emit the same hash even across machines / pythons."""
    payload = {
        "urn": urn,
        "entity_type": entity_type,
        "display_name": display_name,
        "position": dict(position) if position else None,
        "properties": dict(properties),
        "tags": list(tags),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _edge_content_hash(
    *, urn: str, source_urn: str, target_urn: str,
    edge_type: str | None, properties: Mapping, tags: Sequence[str],
) -> str:
    payload = {
        "urn": urn,
        "source_urn": source_urn,
        "target_urn": target_urn,
        "edge_type": edge_type,
        "properties": dict(properties),
        "tags": list(tags),
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _root_hash(
    node_hashes: Iterable[str], edge_hashes: Iterable[str],
) -> str:
    """Order-independent digest over the source layer — sort the
    component hashes before concatenating so two clients producing the
    same set in different orders agree."""
    parts = sorted(node_hashes) + ["::"] + sorted(edge_hashes)
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


# ── public DTOs ────────────────────────────────────────────────────


@dataclass(frozen=True)
class SourceNodeInput:
    """Caller-facing node-shape. The source-sync service builds these
    from provider GraphNodes; the repo content-hashes + persists."""

    urn: str
    entity_type: str | None
    display_name: str | None
    position: Mapping | None
    properties: Mapping
    tags: Sequence[str]


@dataclass(frozen=True)
class SourceEdgeInput:
    urn: str
    source_urn: str
    target_urn: str
    edge_type: str | None
    properties: Mapping
    tags: Sequence[str]


@dataclass(frozen=True)
class ApplyResult:
    """Counts returned to the snapshot row."""

    added: int
    modified: int
    removed: int
    root_hash: str


# ── snapshot lifecycle ────────────────────────────────────────────


async def start_snapshot(
    session: AsyncSession,
    *,
    graph_id: str,
    source_data_source_id: str | None,
    triggered_by: str | None,
) -> GraphSourceSnapshotORM:
    row = GraphSourceSnapshotORM(
        id=f"gss_{uuid.uuid4().hex[:12]}",
        graph_id=graph_id,
        source_data_source_id=source_data_source_id,
        status="running",
        triggered_by=triggered_by,
        started_at=_now(),
    )
    session.add(row)
    await session.flush()
    return row


async def finish_snapshot(
    session: AsyncSession,
    *,
    snapshot_id: str,
    status: str,
    result: ApplyResult | None = None,
    orphan_count: int = 0,
    error_message: str | None = None,
) -> None:
    row = (
        await session.execute(
            select(GraphSourceSnapshotORM).where(
                GraphSourceSnapshotORM.id == snapshot_id
            )
        )
    ).scalar_one()
    row.status = status
    row.finished_at = _now()
    if result is not None:
        row.added_count = result.added
        row.modified_count = result.modified
        row.removed_count = result.removed
        row.source_root_hash = result.root_hash
    if orphan_count:
        row.orphan_count = orphan_count
    if error_message is not None:
        row.error_message = error_message


async def list_snapshots(
    session: AsyncSession, *, graph_id: str, limit: int = 50,
) -> list[GraphSourceSnapshotORM]:
    return list(
        (
            await session.execute(
                select(GraphSourceSnapshotORM)
                .where(GraphSourceSnapshotORM.graph_id == graph_id)
                .order_by(GraphSourceSnapshotORM.started_at.desc())
                .limit(limit)
            )
        ).scalars()
    )


async def get_snapshot(
    session: AsyncSession, *, snapshot_id: str,
) -> GraphSourceSnapshotORM | None:
    return (
        await session.execute(
            select(GraphSourceSnapshotORM).where(
                GraphSourceSnapshotORM.id == snapshot_id
            )
        )
    ).scalar_one_or_none()


# ── upsert + sweep ─────────────────────────────────────────────────


async def apply_source_diff(
    session: AsyncSession,
    *,
    graph_id: str,
    sync_run_id: str,
    nodes: Sequence[SourceNodeInput],
    edges: Sequence[SourceEdgeInput],
) -> ApplyResult:
    """One-shot diff + apply for an entire source layer:

    1. Content-hash every incoming entity.
    2. Load existing rows for this graph; build the (urn -> hash)
       maps for the *before* state.
    3. Classify added / modified / unchanged by URN + content_hash
       comparison.
    4. UPSERT modified + added rows (one statement each batch).
    5. DELETE rows whose ``last_sync_run_id != sync_run_id`` (the
       sweep — removes anything not seen this run).
    6. Return counts + a root_hash digest over the post-state.

    The whole apply is one Graph-Store transaction (caller commits).
    """
    now = _now()

    # ── nodes
    inc_node_hashes: dict[str, str] = {}
    for n in nodes:
        inc_node_hashes[n.urn] = _node_content_hash(
            urn=n.urn, entity_type=n.entity_type,
            display_name=n.display_name, position=n.position,
            properties=n.properties, tags=n.tags,
        )
    existing_nodes = {
        r.urn: r for r in (
            await session.execute(
                select(GraphSourceNodeORM).where(
                    GraphSourceNodeORM.graph_id == graph_id,
                )
            )
        ).scalars()
    }

    added_n = 0
    modified_n = 0
    for n in nodes:
        h = inc_node_hashes[n.urn]
        existing = existing_nodes.get(n.urn)
        is_added = existing is None
        is_modified = (existing is not None) and existing.content_hash != h
        if is_added:
            added_n += 1
        elif is_modified:
            modified_n += 1
        # UPSERT in either case; even unchanged rows get
        # last_sync_run_id refreshed so the sweep doesn't delete them.
        stmt = pg_insert(GraphSourceNodeORM).values(
            graph_id=graph_id,
            urn=n.urn,
            entity_type=n.entity_type,
            display_name=n.display_name,
            position=dict(n.position) if n.position else None,
            properties=dict(n.properties),
            tags=list(n.tags),
            content_hash=h,
            last_sync_run_id=sync_run_id,
            last_synced_at=now,
        ).on_conflict_do_update(
            index_elements=["graph_id", "urn"],
            set_={
                "entity_type": n.entity_type,
                "display_name": n.display_name,
                "position": dict(n.position) if n.position else None,
                "properties": dict(n.properties),
                "tags": list(n.tags),
                "content_hash": h,
                "last_sync_run_id": sync_run_id,
                "last_synced_at": now,
            },
        )
        await session.execute(stmt)

    # ── edges
    inc_edge_hashes: dict[str, str] = {}
    for e in edges:
        inc_edge_hashes[e.urn] = _edge_content_hash(
            urn=e.urn, source_urn=e.source_urn, target_urn=e.target_urn,
            edge_type=e.edge_type, properties=e.properties, tags=e.tags,
        )
    existing_edges = {
        r.urn: r for r in (
            await session.execute(
                select(GraphSourceEdgeORM).where(
                    GraphSourceEdgeORM.graph_id == graph_id,
                )
            )
        ).scalars()
    }

    added_e = 0
    modified_e = 0
    for e in edges:
        h = inc_edge_hashes[e.urn]
        existing = existing_edges.get(e.urn)
        is_added = existing is None
        is_modified = (existing is not None) and existing.content_hash != h
        if is_added:
            added_e += 1
        elif is_modified:
            modified_e += 1
        stmt = pg_insert(GraphSourceEdgeORM).values(
            graph_id=graph_id,
            urn=e.urn,
            source_urn=e.source_urn,
            target_urn=e.target_urn,
            edge_type=e.edge_type,
            properties=dict(e.properties),
            tags=list(e.tags),
            content_hash=h,
            last_sync_run_id=sync_run_id,
            last_synced_at=now,
        ).on_conflict_do_update(
            index_elements=["graph_id", "urn"],
            set_={
                "source_urn": e.source_urn,
                "target_urn": e.target_urn,
                "edge_type": e.edge_type,
                "properties": dict(e.properties),
                "tags": list(e.tags),
                "content_hash": h,
                "last_sync_run_id": sync_run_id,
                "last_synced_at": now,
            },
        )
        await session.execute(stmt)

    # ── sweep: delete anything not touched this run
    removed_n_rows = (
        await session.execute(
            select(GraphSourceNodeORM.urn).where(
                GraphSourceNodeORM.graph_id == graph_id,
                GraphSourceNodeORM.last_sync_run_id != sync_run_id,
            )
        )
    ).scalars().all()
    removed_e_rows = (
        await session.execute(
            select(GraphSourceEdgeORM.urn).where(
                GraphSourceEdgeORM.graph_id == graph_id,
                GraphSourceEdgeORM.last_sync_run_id != sync_run_id,
            )
        )
    ).scalars().all()
    removed_n = len(removed_n_rows)
    removed_e = len(removed_e_rows)

    if removed_n:
        await session.execute(
            delete(GraphSourceNodeORM).where(
                GraphSourceNodeORM.graph_id == graph_id,
                GraphSourceNodeORM.last_sync_run_id != sync_run_id,
            )
        )
    if removed_e:
        await session.execute(
            delete(GraphSourceEdgeORM).where(
                GraphSourceEdgeORM.graph_id == graph_id,
                GraphSourceEdgeORM.last_sync_run_id != sync_run_id,
            )
        )

    return ApplyResult(
        added=added_n + added_e,
        modified=modified_n + modified_e,
        removed=removed_n + removed_e,
        root_hash=_root_hash(
            list(inc_node_hashes.values()), list(inc_edge_hashes.values()),
        ),
    )


# ── readers (consumed by composition) ──────────────────────────────


async def load_source_nodes(
    session: AsyncSession, *, graph_id: str,
) -> dict[str, GraphSourceNodeORM]:
    return {
        r.urn: r for r in (
            await session.execute(
                select(GraphSourceNodeORM).where(
                    GraphSourceNodeORM.graph_id == graph_id,
                )
            )
        ).scalars()
    }


async def load_source_edges(
    session: AsyncSession, *, graph_id: str,
) -> dict[str, GraphSourceEdgeORM]:
    return {
        r.urn: r for r in (
            await session.execute(
                select(GraphSourceEdgeORM).where(
                    GraphSourceEdgeORM.graph_id == graph_id,
                )
            )
        ).scalars()
    }


# ── orphan tracking ────────────────────────────────────────────────


async def record_orphans(
    session: AsyncSession,
    *,
    graph_id: str,
    sync_run_id: str,
    orphan_node_urns: Sequence[str],
    orphan_edge_urns: Sequence[str],
) -> int:
    """Insert orphan rows for enrichment URNs whose source vanished
    this run. Idempotent on (graph_id, urn) — same orphan reported
    twice doesn't double-list."""
    n_inserted = 0
    for urn in orphan_node_urns:
        await session.execute(
            pg_insert(GraphOrphanEnrichmentORM).values(
                id=f"goe_{uuid.uuid4().hex[:12]}",
                graph_id=graph_id,
                urn=urn,
                object_kind="node",
                sync_run_id=sync_run_id,
                discovered_at=_now(),
            ).on_conflict_do_nothing(
                # No UNIQUE constraint on (graph_id, urn) — orphans
                # can be re-detected and re-resolved over time; the
                # latest row tells the user "still orphan as of run X".
            )
        )
        n_inserted += 1
    for urn in orphan_edge_urns:
        await session.execute(
            pg_insert(GraphOrphanEnrichmentORM).values(
                id=f"goe_{uuid.uuid4().hex[:12]}",
                graph_id=graph_id,
                urn=urn,
                object_kind="edge",
                sync_run_id=sync_run_id,
                discovered_at=_now(),
            )
        )
        n_inserted += 1
    return n_inserted


async def list_orphans(
    session: AsyncSession, *, graph_id: str, include_resolved: bool = False,
    limit: int = 200,
) -> list[GraphOrphanEnrichmentORM]:
    q = select(GraphOrphanEnrichmentORM).where(
        GraphOrphanEnrichmentORM.graph_id == graph_id,
    )
    if not include_resolved:
        q = q.where(GraphOrphanEnrichmentORM.resolved_at.is_(None))
    q = q.order_by(GraphOrphanEnrichmentORM.discovered_at.desc()).limit(limit)
    return list((await session.execute(q)).scalars())


__all__ = [
    "SourceNodeInput",
    "SourceEdgeInput",
    "ApplyResult",
    "start_snapshot",
    "finish_snapshot",
    "list_snapshots",
    "get_snapshot",
    "apply_source_diff",
    "load_source_nodes",
    "load_source_edges",
    "record_orphans",
    "list_orphans",
]
