"""Provision the ``graphver`` versioned-graph store (schema + hash partitions).

Revision ID: 20260601_1200_graphver_schema
Revises: 20260512_1100_jobs_current_phase
Create Date: 2026-06-01 12:00

The versioned-graph store (plan §2) lives in its own Postgres schema
(``graphver``) on its own declarative base (``VersioningBase``), separate from
the management ``Base``.  Until now it was created only by the dev bootstrap
helper ``create_schema_and_partitions``; this migration makes a normal
``alembic upgrade head`` — which ``init_db`` runs on viz-service boot — provision
it, so the versioning API works end-to-end on a fresh database.

Single-instance / dev: ``GRAPHVER_DB_URL`` defaults to ``MANAGEMENT_DB_URL``, so
the store is created on the same Postgres this migration runs against.  When the
store is decoupled onto its own instance in production, provision it there with
the same DDL out-of-band (the bootstrap helper shares this exact logic).

Idempotent: ``CREATE SCHEMA IF NOT EXISTS`` + ``create_all(checkfirst=True)`` +
``CREATE TABLE IF NOT EXISTS ... PARTITION OF`` — safe to re-run, and safe on a
DB the dev bootstrap already touched.  The partition count comes from
``config.PARTITIONS`` so it always matches the modulo the runtime hashes into.
"""
from __future__ import annotations

from typing import Union

import sqlalchemy as sa
from alembic import op

# Importing the models registers every ORM table on VersioningBase.metadata.
from backend.app.services.versioning import config as gv_config
from backend.app.services.versioning.db import VersioningBase
from backend.app.services.versioning.models import PARTITIONED_TABLES

revision: str = "20260601_1200_graphver_schema"
down_revision: Union[str, None] = "20260512_1100_jobs_current_phase"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    schema = gv_config.graphver_schema()
    bind.execute(sa.text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))
    # Parent tables (partitioned parents declare ``postgresql_partition_by``, so
    # this emits the PARTITION BY clause); checkfirst skips anything present.
    VersioningBase.metadata.create_all(bind=bind, checkfirst=True)
    # merkle_nodes grew branch_id/commit_seq/bucket + an as-of index after its
    # first cut (persisted CoW Merkle). create_all(checkfirst) won't alter an
    # existing table, so add idempotently for DBs the dev bootstrap created
    # earlier (the table was unused, so no backfill needed).
    mn = f'"{schema}"."merkle_nodes"'
    bind.execute(sa.text(f'ALTER TABLE {mn} ADD COLUMN IF NOT EXISTS branch_id text'))
    bind.execute(sa.text(f'ALTER TABLE {mn} ADD COLUMN IF NOT EXISTS commit_seq bigint'))
    bind.execute(sa.text(f'ALTER TABLE {mn} ADD COLUMN IF NOT EXISTS bucket jsonb'))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_merkle_asof ON {mn} '
        f'(graph_id, branch_id, path, commit_seq)'
    ))
    # commits.idempotency_key (bulk-ingest / retry dedup) — added after first cut.
    cm = f'"{schema}"."commits"'
    bind.execute(sa.text(f'ALTER TABLE {cm} ADD COLUMN IF NOT EXISTS idempotency_key text'))
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_commits_idem ON {cm} (graph_id, idempotency_key)'
    ))
    # graphs.ontology_spec (inline vocabulary) — added after first cut.
    bind.execute(sa.text(
        f'ALTER TABLE "{schema}"."graphs" ADD COLUMN IF NOT EXISTS ontology_spec jsonb'
    ))
    # Child hash partitions for the high-cardinality append-only tables.
    n = gv_config.PARTITIONS
    for tname in PARTITIONED_TABLES:
        for rem in range(n):
            bind.execute(sa.text(
                f'CREATE TABLE IF NOT EXISTS "{schema}"."{tname}_p{rem}" '
                f'PARTITION OF "{schema}"."{tname}" '
                f"FOR VALUES WITH (MODULUS {n}, REMAINDER {rem})"
            ))


def downgrade() -> None:
    schema = gv_config.graphver_schema()
    op.get_bind().execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
