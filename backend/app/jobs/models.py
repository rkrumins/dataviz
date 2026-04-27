"""Durable PG models owned by the job platform.

Phase 1 ships only the audit subset — ``job_event_log``. The
``platform_jobs`` table that unifies the per-kind job records is
Phase 2 work.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    Identity,
    Index,
    Integer,
    Text,
    TIMESTAMP,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB

# Pull ``Base`` directly from the engine — NOT through
# ``backend.app.services.aggregation.models``. Going through that
# module triggers ``aggregation/__init__.py`` which imports
# ``AggregationWorker``, which imports
# ``backend.app.jobs.audit.record_terminal``, which imports THIS
# module. Result: circular import, ``record_terminal`` not yet
# defined when the worker tries to bind it. Going to the engine
# directly skips the loop — same ``Base``, no detour.
from backend.app.db.engine import Base


class JobEventLogORM(Base):
    """Append-only audit log for terminal events.

    The platform's primary event log lives in Redis Streams; this
    table captures only ``terminal`` events so we have a durable,
    queryable record of "what jobs ran, when, and how they ended".

    Surrogate PK so the same ``(job_id, sequence)`` can land twice —
    the platform tolerates at-least-once delivery. Audit consumers
    dedup downstream on ``(job_id, sequence)``.
    """

    __tablename__ = "job_event_log"

    id = Column(BigInteger, Identity(always=False), primary_key=True)
    job_id = Column(Text, nullable=False, index=True)
    kind = Column(Text, nullable=False, index=True)
    event_type = Column(Text, nullable=False)
    sequence = Column(Integer, nullable=False)
    workspace_id = Column(Text, nullable=True, index=True)
    data_source_id = Column(Text, nullable=True)
    provider_id = Column(Text, nullable=True)
    asset_name = Column(Text, nullable=True)
    ts = Column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
    )
    payload = Column(JSONB, nullable=False)

    __table_args__ = (
        Index("ix_job_event_log_job_id_seq", "job_id", "sequence"),
        CheckConstraint(
            "event_type IN ('terminal')",
            name="ck_job_event_log_event_type",
        ),
        CheckConstraint(
            "kind IN ('aggregation', 'purge', 'stats', 'discovery')",
            name="ck_job_event_log_kind",
        ),
        {"schema": "aggregation"},
    )
