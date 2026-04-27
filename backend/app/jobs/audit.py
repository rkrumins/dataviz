"""Audit-log writer for terminal job events.

Workers call :func:`record_terminal` from inside their existing PG
session at terminal-state commit time. Co-locating the audit write
with the durable status commit means a worker that successfully
writes ``status='completed'`` to ``aggregation_jobs`` ALSO writes
the audit row in the same transaction — atomic, no drift between
the durable record and the audit trail.

Why this lives in the platform (not in each worker):

* One write helper per kind is the same write helper. Don't
  duplicate the JSONB payload construction across workers.
* When ``platform_jobs`` migration lands in Phase 2, this is the
  one place that needs to learn the new shape.
* Audit pipelines (Slack notifications, billing meters, downstream
  warehouses) consume from ``job_event_log`` — putting the schema
  knowledge here means changes to the audit shape are visible in
  one file.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from .models import JobEventLogORM
from .schemas import JobKind, JobScope, JobStatus

logger = logging.getLogger(__name__)


async def record_terminal(
    session: AsyncSession,
    *,
    job_id: str,
    kind: JobKind,
    scope: JobScope,
    sequence: int,
    status: JobStatus,
    payload: Optional[Mapping[str, Any]] = None,
) -> None:
    """Append one terminal-event row to ``job_event_log``.

    Caller is expected to commit the session afterward — the audit
    write is part of the worker's terminal-commit transaction so
    the durable status flip + the audit trail land or roll back
    together.

    Failures are logged but do not raise: the audit subset is
    secondary to the durable status. If the audit write fails (e.g.
    transient DB blip during a worker restart), we'd rather the
    job's terminal status survive than have the whole transaction
    abort over a missing audit row. Phase 2 may revisit this if
    audit becomes business-critical.
    """
    try:
        row = JobEventLogORM(
            job_id=job_id,
            kind=kind,
            event_type="terminal",
            sequence=sequence,
            workspace_id=scope.workspace_id,
            data_source_id=scope.data_source_id,
            provider_id=scope.provider_id,
            asset_name=scope.asset_name,
            payload={"status": status, **(dict(payload) if payload else {})},
        )
        session.add(row)
        await session.flush()
    except Exception as exc:
        logger.warning(
            "record_terminal failed (continuing — durable status is the "
            "source of truth, audit row missing): %s", exc, exc_info=True,
        )
