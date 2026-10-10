"""Promote ``auth_audit_log`` into the platform activity ledger.

Revision ID: 20261010_1000_activity_ledger
Revises: 20260930_1000_outbox_type_time
Create Date: 2026-10-10 10:00

Every activity read — Admin → Activity, a workspace's Activity tab, the
summaries above them — filters on who did it, where, to what and why. Kept
inside a JSON payload, each of those is a scan of every event in the window,
and the audit lens used to apply them in Python AFTER its SQL ``LIMIT``, so a
filtered page came back short or empty. This adds them as columns the relay
fills from the payload (``services.activity.catalogue.project``), each with an
index that leads with it and ends on the timeline — plus ``event_version`` on
the record itself, because how a payload is read depends on its version. The
old ``(event_type)`` index goes: it is a prefix of ``(event_type,
occurred_at)``, and every index is a write per recorded event.

DDL only, guarded by an inspector check (``docs/MIGRATIONS.md``):
``0001_baseline`` create_all()s the current ORM, so a fresh database already
has all of it. Existing rows are NOT backfilled here — ``projection_version``
defaults to 0 and the relay re-projects those rows in the background, which
keeps this migration instant on a table of any size.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261010_1000_activity_ledger"
down_revision: Union[str, None] = "20260930_1000_outbox_type_time"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "auth_audit_log"

_TEXT_COLUMNS = (
    "category", "audience", "severity", "outcome", "actor_id", "actor_kind",
    "subject_id", "target_type", "target_id", "target_label", "workspace_id",
    "data_source_id", "stated_reason", "correlation_id",
)

_INDEXES = (
    ("idx_aal_occurred", ["occurred_at", "id"]),
    ("idx_aal_category_occurred", ["category", "occurred_at"]),
    ("idx_aal_actor_occurred", ["actor_id", "occurred_at"]),
    ("idx_aal_subject_occurred", ["subject_id", "occurred_at"]),
    ("idx_aal_workspace_occurred", ["workspace_id", "occurred_at"]),
    ("idx_aal_ds_occurred", ["data_source_id", "occurred_at"]),
    ("idx_aal_target_occurred", ["target_type", "target_id", "occurred_at"]),
    ("idx_aal_type_occurred", ["event_type", "occurred_at"]),
    ("idx_aal_correlation", ["correlation_id"]),
    ("idx_aal_projection_version", ["projection_version"]),
)

#: The workspace lens: a workspace's workspace-audience rows only.
_LENS = "idx_aal_workspace_lens"
_LENS_WHERE = "audience = 'workspace'"

_SUPERSEDED = "idx_auth_audit_event_type"


def _columns(bind) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(_TABLE)}


def _indexes(bind) -> set[str]:
    return {i["name"] for i in sa.inspect(bind).get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    have = _columns(bind)
    # Part of the record, not the projection: the payload's schema version,
    # which the projection reads. NULL on existing rows, all of which are 1.
    if "event_version" not in have:
        op.add_column(_TABLE, sa.Column("event_version", sa.Integer(), nullable=True))
    for name in _TEXT_COLUMNS:
        if name not in have:
            op.add_column(_TABLE, sa.Column(name, sa.Text(), nullable=True))
    if "projection_version" not in have:
        op.add_column(
            _TABLE,
            sa.Column(
                "projection_version", sa.Integer(),
                nullable=False, server_default="0",
            ),
        )

    existing = _indexes(bind)
    for name, cols in _INDEXES:
        if name not in existing:
            op.create_index(name, _TABLE, cols)
    if _LENS not in existing:
        op.create_index(
            _LENS, _TABLE, ["workspace_id", "occurred_at"],
            postgresql_where=sa.text(_LENS_WHERE), sqlite_where=sa.text(_LENS_WHERE),
        )
    # ``(event_type)`` is a prefix of ``idx_aal_type_occurred``: everything it
    # answered, that answers, and every index is a write per recorded event.
    if _SUPERSEDED in existing:
        op.drop_index(_SUPERSEDED, table_name=_TABLE)


def downgrade() -> None:
    bind = op.get_bind()
    existing = _indexes(bind)
    if _SUPERSEDED not in existing:
        op.create_index(_SUPERSEDED, _TABLE, ["event_type"])
    for name in (*(n for n, _ in _INDEXES), _LENS):
        if name in existing:
            op.drop_index(name, table_name=_TABLE)
    have = _columns(bind)
    for name in ("event_version", *_TEXT_COLUMNS, "projection_version"):
        if name in have:
            op.drop_column(_TABLE, name)
