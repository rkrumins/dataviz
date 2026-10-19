"""Layout templates: versions, favourites, organization requests and workspace defaults.

* ``layout_template_versions`` keeps every version of a template's layers, and
  ``context_models.version`` names the current one. A template's layers change
  → a new version; nothing else does. Every existing template gets its v1 here,
  so ``context_models.version`` always equals its newest version row.
* ``views.context_model_version`` is the version a view's layers last matched,
  so a view built from an older one can be offered the difference. Views that
  name a template already are set to v1 — the only version there is.
* ``view_versions.source`` accepts ``'template'``: applying a template's update
  to a view records a version of the view like any other change.
* ``layout_template_favourites``: a person's favourite templates.
* ``context_models.promotion_requested_by / _at / _request_note``: a pending
  request to offer a team's template to the whole organization (columns, as a
  view's publication request is). A template manager answers it and may read
  the template meanwhile — the ``system:templates:manage`` description says so.
* ``workspaces.default_layout_template_id``: the template a new view in the
  workspace starts from. A plain id: templates belong to another domain.

``views`` and ``view_versions`` are busy tables, so the revision bounds its
wait for locks rather than queue reads behind a long transaction. Guarded DDL
(a ``create_all`` baseline already has all of it), unguarded idempotent data.
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261018_1300_tpl_lifecycle
Revises: 20261018_1200_layout_templates
Create Date: 2026-10-18 13:00
"""
from __future__ import annotations

import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261018_1300_tpl_lifecycle"
down_revision: Union[str, None] = "20261018_1200_layout_templates"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "system:templates:manage"
_LONG_DESCRIPTION = (
    "Lets you publish, edit and delete layout templates offered to everyone in "
    "the organization, feature them, hide or show the built-in starter templates "
    "for everyone, and answer requests to offer a team's template to everyone. "
    "Deliberately SEPARATE from system:admin so curating the template library "
    "can be delegated to the people who own the house style, without handing "
    "them the platform. Workspace and personal templates follow their own rules: "
    "this reaches someone's personal or workspace template only while its owner "
    "has asked for it to be offered to everyone, so it can be reviewed."
)
#: The 1200 revision's wording, put back on downgrade.
_PREVIOUS_LONG_DESCRIPTION = (
    "Lets you publish, edit and delete layout templates offered to everyone in "
    "the organization, and hide or show the built-in starter templates for "
    "everyone. Deliberately SEPARATE from system:admin so curating the template "
    "library can be delegated to the people who own the house style, without "
    "handing them the platform. Workspace and personal templates follow their "
    "own rules: this grants no access to anyone's personal templates or to a "
    "workspace you are not otherwise in."
)

_SOURCES = (
    "'baseline', 'create', 'wizard', 'import', 'restore', 'promote', 'export', "
    "'manual', 'snapshot'"
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``views`` is read on every page,
    and giving up (to be run again) beats queueing every read behind a long
    transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _backfill_first_versions(conn) -> None:
    """v1 for every template that has no version yet — its layers as they are."""
    rows = conn.execute(sa.text(
        """
        SELECT cm.id, cm.name, cm.layers_config, cm.created_by, cm.updated_at
        FROM context_models cm
        WHERE cm.is_template = true
          AND NOT EXISTS (SELECT 1 FROM layout_template_versions v WHERE v.template_id = cm.id)
        """
    )).all()
    for template_id, name, layers, created_by, updated_at in rows:
        conn.execute(
            sa.text(
                """
                INSERT INTO layout_template_versions
                    (id, template_id, version, name, layers, created_by, created_at)
                VALUES (:id, :template_id, 1, :name, :layers, :created_by, :created_at)
                """
            ),
            {
                "id": f"ltv_{uuid.uuid4().hex[:12]}", "template_id": template_id,
                "name": name, "layers": layers or "[]", "created_by": created_by,
                "created_at": updated_at,
            },
        )


def upgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    op.add_column(
        "context_models",
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        if_not_exists=True,
    )
    for column in ("promotion_requested_by", "promotion_requested_at", "promotion_request_note"):
        op.add_column(
            "context_models", sa.Column(column, sa.Text(), nullable=True), if_not_exists=True,
        )
    op.add_column(
        "views", sa.Column("context_model_version", sa.Integer(), nullable=True),
        if_not_exists=True,
    )
    op.add_column(
        "workspaces", sa.Column("default_layout_template_id", sa.Text(), nullable=True),
        if_not_exists=True,
    )

    op.create_table(
        "layout_template_versions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "template_id", sa.Text(),
            sa.ForeignKey("context_models.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("layers", sa.Text(), nullable=False),
        sa.Column("change_note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("template_id", "version", name="uq_ltv_template_version"),
        if_not_exists=True,
    )
    op.create_table(
        "layout_template_favourites",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "template_id", sa.Text(),
            sa.ForeignKey("context_models.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("template_id", "user_id", name="uq_ltf_template_user"),
        if_not_exists=True,
    )
    op.create_index(
        "idx_ltf_user", "layout_template_favourites", ["user_id"], if_not_exists=True,
    )

    op.execute("ALTER TABLE view_versions DROP CONSTRAINT IF EXISTS ck_view_versions_source")
    op.create_check_constraint(
        "ck_view_versions_source", "view_versions", f"source IN ({_SOURCES}, 'template')",
    )

    _backfill_first_versions(conn)
    conn.execute(sa.text(
        "UPDATE views SET context_model_version = 1 "
        "WHERE context_model_id IS NOT NULL AND context_model_version IS NULL"
    ))
    conn.execute(
        sa.text("UPDATE permissions SET long_description = :text WHERE id = :id"),
        {"text": _LONG_DESCRIPTION, "id": _PERMISSION},
    )


def downgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()

    # Keep the history: a template-applied version reads as a wizard save.
    conn.execute(sa.text("UPDATE view_versions SET source = 'wizard' WHERE source = 'template'"))
    op.execute("ALTER TABLE view_versions DROP CONSTRAINT IF EXISTS ck_view_versions_source")
    op.create_check_constraint("ck_view_versions_source", "view_versions", f"source IN ({_SOURCES})")
    conn.execute(
        sa.text("UPDATE permissions SET long_description = :text WHERE id = :id"),
        {"text": _PREVIOUS_LONG_DESCRIPTION, "id": _PERMISSION},
    )

    op.drop_index("idx_ltf_user", table_name="layout_template_favourites", if_exists=True)
    op.drop_table("layout_template_favourites", if_exists=True)
    op.drop_table("layout_template_versions", if_exists=True)
    op.drop_column("workspaces", "default_layout_template_id")
    op.drop_column("views", "context_model_version")
    for column in ("promotion_request_note", "promotion_requested_at", "promotion_requested_by"):
        op.drop_column("context_models", column)
    op.drop_column("context_models", "version")
