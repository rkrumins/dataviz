"""Unit tests for the authored-graph data-source relay dispatch.

Covers the per-event handlers (`dispatch`) in isolation against the
management-DB SQLite test fixture. The Redis-driven outer loop is not
exercised here — those handlers are the load-bearing logic and they
must be idempotent on redelivery.

Scenarios:

* ``user_graph.created`` inserts a ``workspace_data_sources`` row with
  the expected provider id, graph_name, status, label, extra_config.
* Re-delivering the same ``created`` event is a no-op (idempotent).
* ``user_graph.deleted`` flips the matching row to soft-deleted +
  inactive and preserves ``deleted_by``.
* ``graph.materialized`` ticks the row to ``ready`` with a fresh
  ``last_aggregated_at`` and a commit-derived ``graph_fingerprint``.
* ``materialized`` arriving before ``created`` is a safe no-op (the
  next commit's tick catches up).
* Unknown event types are silently ignored.
"""
from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.authored_data_source_relay import (
    SYSTEM_AUTHORED_FALKOR_PROVIDER_ID,
    authored_graph_name,
    dispatch,
)


WS = "ws_test_relay"
GRAPH = "g_relay123abc"
GRAPH_NAME = authored_graph_name(GRAPH)


def _created_payload(**overrides):
    base = {
        "graph_id": GRAPH,
        "workspace_id": WS,
        "name": "demo graph",
        "description": "for tests",
        "ontology_id": None,
        "schema_mode": "schemaless",
        "origin": "authored",
        "created_by": "usr_test000000",
        "falkor_namespace": GRAPH_NAME,
    }
    base.update(overrides)
    return base


async def _fetch_row(session):
    return (
        await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.workspace_id == WS,
                WorkspaceDataSourceORM.graph_name == GRAPH_NAME,
            )
        )
    ).scalar_one_or_none()


@pytest.mark.asyncio
async def test_created_inserts_row(db_session):
    await dispatch(
        db_session,
        event_type="visualization.user_graph.created",
        payload=_created_payload(),
    )
    await db_session.commit()

    row = await _fetch_row(db_session)
    assert row is not None
    assert row.id == f"ds_authored_{GRAPH}"
    assert row.provider_id == SYSTEM_AUTHORED_FALKOR_PROVIDER_ID
    assert row.graph_name == GRAPH_NAME
    assert row.label == "demo graph"
    assert row.aggregation_status == "pending"
    assert row.aggregation_edge_count == 0
    assert row.is_active is True
    assert row.access_level == "read"
    assert row.created_by == "usr_test000000"
    assert '"origin":"authored"' in row.extra_config
    assert f'"graph_id":"{GRAPH}"' in row.extra_config


@pytest.mark.asyncio
async def test_created_is_idempotent(db_session):
    await dispatch(
        db_session,
        event_type="visualization.user_graph.created",
        payload=_created_payload(),
    )
    await db_session.commit()
    # Redeliver the same event; should be a no-op.
    await dispatch(
        db_session,
        event_type="visualization.user_graph.created",
        payload=_created_payload(),
    )
    await db_session.commit()

    rows = (
        await db_session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.workspace_id == WS,
                WorkspaceDataSourceORM.graph_name == GRAPH_NAME,
            )
        )
    ).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_deleted_soft_deletes_row(db_session):
    await dispatch(
        db_session,
        event_type="visualization.user_graph.created",
        payload=_created_payload(),
    )
    await db_session.commit()

    await dispatch(
        db_session,
        event_type="visualization.user_graph.deleted",
        payload={
            "graph_id": GRAPH,
            "workspace_id": WS,
            "deleted_by": "usr_killer",
            "falkor_namespace": GRAPH_NAME,
        },
    )
    await db_session.commit()

    row = await _fetch_row(db_session)
    assert row is not None
    assert row.deleted_at is not None
    assert row.deleted_by == "usr_killer"
    assert row.is_active is False


@pytest.mark.asyncio
async def test_materialized_ticks_ready(db_session):
    await dispatch(
        db_session,
        event_type="visualization.user_graph.created",
        payload=_created_payload(),
    )
    await db_session.commit()

    commit_id = "gcmt_abcdef123456"
    materialized_at = "2026-05-28T12:00:00+00:00"
    await dispatch(
        db_session,
        event_type="visualization.graph.materialized",
        payload={
            "graph_id": GRAPH,
            "workspace_id": WS,
            "commit_id": commit_id,
            "materialized_at": materialized_at,
        },
    )
    await db_session.commit()

    row = await _fetch_row(db_session)
    assert row is not None
    assert row.aggregation_status == "ready"
    assert row.last_aggregated_at == materialized_at
    expected_fp = hashlib.sha256(commit_id.encode("utf-8")).hexdigest()
    assert row.graph_fingerprint == expected_fp


@pytest.mark.asyncio
async def test_materialized_before_created_is_noop(db_session):
    # Race: materialized arrives first. Handler must not blow up and
    # must not create a stray row; status stays unset until created
    # event drains.
    await dispatch(
        db_session,
        event_type="visualization.graph.materialized",
        payload={
            "graph_id": GRAPH,
            "workspace_id": WS,
            "commit_id": "gcmt_orphan",
            "materialized_at": "2026-05-28T12:00:00+00:00",
        },
    )
    await db_session.commit()

    row = await _fetch_row(db_session)
    assert row is None


@pytest.mark.asyncio
async def test_unknown_event_type_is_ignored(db_session):
    await dispatch(
        db_session,
        event_type="visualization.graph.committed",  # belongs to projector
        payload={"graph_id": GRAPH, "workspace_id": WS},
    )
    await db_session.commit()

    row = await _fetch_row(db_session)
    assert row is None


@pytest.mark.asyncio
async def test_missing_required_fields_logs_and_returns(db_session):
    # No graph_id — handler should warn-log and return without insert.
    await dispatch(
        db_session,
        event_type="visualization.user_graph.created",
        payload={"workspace_id": WS},
    )
    await db_session.commit()

    rows = (
        await db_session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.workspace_id == WS,
            )
        )
    ).scalars().all()
    assert rows == []
