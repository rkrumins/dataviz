"""Baseline — create the entire current schema from ORM metadata.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-04-16

Single baseline migration that creates ALL tables from the current ORM
state.  Public-schema tables (workspaces, providers, views, etc.) and
aggregation-schema tables (aggregation_jobs, data_source_state) are all
created in one pass.

The ``aggregation`` Postgres schema is created first so that
``Base.metadata.create_all`` can place tables there.

Dev workflow:
    docker compose down -v          # wipe volumes
    docker compose up --build       # fresh start, Alembic creates everything
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from backend.app.db.engine import Base
from backend.app.db import models as _management_models  # noqa: F401
from backend.app.services.aggregation import models as _aggregation_models  # noqa: F401


revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    # Create the aggregation schema before create_all so ORM tables
    # with schema="aggregation" can be placed there.
    bind.execute(sa.text("CREATE SCHEMA IF NOT EXISTS aggregation"))

    # Create ALL tables from current ORM state (both public + aggregation)
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
    bind.execute(sa.text("DROP SCHEMA IF EXISTS aggregation CASCADE"))
