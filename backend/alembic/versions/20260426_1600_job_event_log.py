"""Add ``aggregation.job_event_log`` — append-only audit subset.

Revision ID: 20260426_1600_job_event_log
Revises: 20260426_1500_jobs_last_sequence
Create Date: 2026-04-26 16:00

The job platform's primary event log lives in Redis Streams (live,
high-cardinality, MAXLEN-truncated). This PG mirror captures only
**terminal** events (``completed`` / ``failed`` / ``cancelled``) so we
have a durable, queryable audit trail without paying the cost of
event-sourcing every progress sample.

Why terminal-only:

* Compliance / regulatory: "what jobs ran for workspace X in the
  last 30 days?" is a SQL query.
* Forensics: "this job claims 65k edges materialized but only 30k
  in FalkorDB — when did it actually finish?" is a SQL query.
* Idempotent retries: "did we already publish a Slack notification
  for this terminal?" — `(job_id, type='terminal')` is the dedup
  key.

Why NOT every progress event:

* Volume. A multi-million-edge aggregation produces hundreds of
  progress events; PG isn't the right store for that cardinality.
* Cost. ``platform_jobs`` already carries the durable cursor +
  terminal payload; intermediate state lives in Redis.
* Phase 2/3 if a real audit need emerges, this table can be
  expanded to all event types — schema is intentionally generic.

Idempotent: the baseline migration uses ``Base.metadata.create_all``
so on fresh deploys the table already exists. Inspector check
before create.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260426_1600_job_event_log"
down_revision: Union[str, None] = "20260426_1500_jobs_last_sequence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "job_event_log"
_SCHEMA = "aggregation"


def _has_table(inspector: sa.engine.reflection.Inspector) -> bool:
    return _TABLE in inspector.get_table_names(schema=_SCHEMA)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_table(inspector):
        return
    op.create_table(
        _TABLE,
        # Surrogate PK so the same ``(job_id, sequence)`` can land
        # twice (idempotent re-emit on retry — the platform
        # tolerates at-least-once). Audit consumers dedup
        # downstream.
        sa.Column(
            "id",
            sa.BigInteger(),
            sa.Identity(always=False),
            primary_key=True,
        ),
        sa.Column("job_id", sa.Text(), nullable=False, index=True),
        sa.Column("kind", sa.Text(), nullable=False, index=True),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=True, index=True),
        sa.Column("data_source_id", sa.Text(), nullable=True),
        sa.Column("provider_id", sa.Text(), nullable=True),
        sa.Column("asset_name", sa.Text(), nullable=True),
        sa.Column(
            "ts",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
            index=True,
        ),
        sa.Column("payload", sa.dialects.postgresql.JSONB(), nullable=False),
        sa.CheckConstraint(
            "event_type IN ('terminal')",
            name="ck_job_event_log_event_type",
        ),
        sa.CheckConstraint(
            "kind IN ('aggregation', 'purge', 'stats', 'discovery')",
            name="ck_job_event_log_kind",
        ),
        schema=_SCHEMA,
    )
    op.create_index(
        "ix_job_event_log_job_id_seq",
        _TABLE,
        ["job_id", "sequence"],
        schema=_SCHEMA,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector):
        return
    op.drop_index("ix_job_event_log_job_id_seq", _TABLE, schema=_SCHEMA)
    op.drop_table(_TABLE, schema=_SCHEMA)
