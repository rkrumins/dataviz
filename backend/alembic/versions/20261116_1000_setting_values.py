"""The settings store: one place for every versioned-graph setting's values, with their history.

Code says what a setting is (``backend/app/config/versioned_graph_settings.py``); these tables
hold only what the platform, a workspace or a graph chose (``services.settings.store``):

* ``setting_values`` — one row per value chosen: ``(domain, key, scope, scope_id)``, ``scope_id``
  ``''`` for the platform. ``value`` NULL means nothing is chosen there (the scope above decides);
  ``limits`` (platform rows only) bound what workspace admins may choose below. ``version`` is the
  value's own, for optimistic concurrency; ``rev`` takes the next number of
  ``setting_values_rev_seq`` on every write, so each process reloads only what changed.
* ``setting_changes`` — each value's before and after, under the change set of its save, with who,
  why and how (``api``, ``legacy_api``, ``migration``, ``revert``).
* ``settings_imports`` — the one-time imports that have run (``20261116_1100_settings_import``).

New tables only, nothing read today depends on them. Guarded DDL (a ``create_all`` baseline
already has all of it), waiting at most five seconds for a lock like the revisions before it. The
downgrade drops them, and every setting is read from where it was stored before.

Revision ID: 20261116_1000_setting_values
Revises: 20261113_1400_gv_ps_candidate
Create Date: 2026-11-16 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261116_1000_setting_values"
down_revision: Union[str, None] = "20261113_1400_gv_ps_candidate"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SEQUENCES = ("setting_values_rev_seq", "setting_changes_id_seq")
_INDEXES = (
    ("ix_setting_values_rev", "setting_values", ["domain", "rev"]),
    ("ix_setting_values_scope", "setting_values", ["domain", "scope", "scope_id"]),
    ("ix_setting_changes_set", "setting_changes", ["change_set"]),
    ("ix_setting_changes_scope", "setting_changes", ["domain", "scope", "scope_id", "id"]),
    ("ix_setting_changes_key", "setting_changes", ["domain", "key", "id"]),
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: giving up (to be run again) beats queueing what the
    running release reads behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _json() -> postgresql.JSONB:
    return postgresql.JSONB(none_as_null=True)


def upgrade() -> None:
    _bound_lock_wait()
    for name in _SEQUENCES:
        op.execute(f"CREATE SEQUENCE IF NOT EXISTS {name}")
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("setting_values"):
        op.create_table(
            "setting_values",
            sa.Column("domain", sa.Text(), nullable=False),
            sa.Column("key", sa.Text(), nullable=False),
            sa.Column("scope", sa.Text(), nullable=False),
            sa.Column("scope_id", sa.Text(), nullable=False),
            sa.Column("value", _json(), nullable=True),
            sa.Column("limits", _json(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("rev", sa.BigInteger(), nullable=False,
                      server_default=sa.text("nextval('setting_values_rev_seq')")),
            sa.Column("updated_at", postgresql.TIMESTAMP(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_by", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("domain", "key", "scope", "scope_id",
                                    name="pk_setting_values"),
            sa.CheckConstraint("scope IN ('platform','workspace','graph')",
                               name="ck_setting_values_scope"),
            sa.CheckConstraint("(scope = 'platform') = (scope_id = '')",
                               name="ck_setting_values_scope_id"),
            sa.CheckConstraint("limits IS NULL OR scope = 'platform'",
                               name="ck_setting_values_limits"),
        )
    if not inspector.has_table("setting_changes"):
        op.create_table(
            "setting_changes",
            sa.Column("id", sa.BigInteger(), primary_key=True,
                      server_default=sa.text("nextval('setting_changes_id_seq')")),
            sa.Column("change_set", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("domain", sa.Text(), nullable=False),
            sa.Column("key", sa.Text(), nullable=False),
            sa.Column("scope", sa.Text(), nullable=False),
            sa.Column("scope_id", sa.Text(), nullable=False),
            sa.Column("before_value", _json(), nullable=True),
            sa.Column("after_value", _json(), nullable=True),
            sa.Column("before_limits", _json(), nullable=True),
            sa.Column("after_limits", _json(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("actor", sa.Text(), nullable=True),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("source", sa.Text(), nullable=False),
            sa.Column("at", postgresql.TIMESTAMP(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.CheckConstraint("source IN ('api','legacy_api','migration','revert')",
                               name="ck_setting_changes_source"),
        )
    if not inspector.has_table("settings_imports"):
        op.create_table(
            "settings_imports",
            sa.Column("name", sa.Text(), primary_key=True),
            sa.Column("at", postgresql.TIMESTAMP(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("detail", _json(), nullable=True),
        )
    for name, table, columns in _INDEXES:
        op.create_index(name, table, columns, if_not_exists=True)


def downgrade() -> None:
    _bound_lock_wait()
    for name, table, _columns in reversed(_INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)
    for table in ("settings_imports", "setting_changes", "setting_values"):
        op.drop_table(table, if_exists=True)
    for name in _SEQUENCES:
        op.execute(f"DROP SEQUENCE IF EXISTS {name}")
