"""The AI assistant: who may use it, and the AI domain's tables.

* ``workspace:ai:use`` — ask the AI assistant about a workspace's data and have
  it draft searches. Granted to every system role that reads data sources —
  viewer, member, publisher, steward, data engineer, org admin, super admin;
  ``workspace:admin`` implies it in code. Every CUSTOM role that reads data
  sources gets it too, as with ``workspace:native-query:read``, so whoever can
  read the data can ask about it once an administrator turns the assistant on
  (``aiAssistantEnabled``, off by default) — and an administrator can take it
  from any role.
* The ``ai_*`` tables (``backend/ai_service/models.py``): connections,
  settings, conversations and messages, concept mappings, daily usage and
  external knowledge sources. They reference users, workspaces, data sources
  and views by id only.

Guarded DDL (a ``create_all`` baseline already has the tables), idempotent
data, bounded lock waits on ``role_permissions`` (read on every sign-in).

Revision ID: 20261121_1000_ai_assistant
Revises: 20261119_1500_merge_view_members
Create Date: 2026-11-21 10:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261121_1000_ai_assistant"
down_revision: Union[str, None] = "20261119_1500_merge_view_members"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PERMISSION = "workspace:ai:use"
_DESCRIPTION = "Ask the AI assistant about a workspace's data, and have it write searches."
_LONG_DESCRIPTION = (
    "Ask questions in plain language about the views, lineage and data a workspace holds, "
    "and have the assistant draft searches and Cypher for you to review. The assistant reads "
    "only what you can read yourself, and never changes anything. Your questions, and the "
    "names, descriptions and values the answers need, are sent to the AI connection your "
    "administrator chose. Readers of a workspace's data sources have it by default; an "
    "administrator can remove it from any role."
)
_EXAMPLES = [
    "Ask what breaks downstream if a column is dropped",
    "Ask the assistant to write the search for tables tagged PII",
]
_ROLES = (
    "org_admin",
    "super_admin",
    "workspace_data_engineer",
    "workspace_member",
    "workspace_publisher",
    "workspace_steward",
    "workspace_viewer",
)


def _bound_lock_wait() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _text(name: str, **kw) -> sa.Column:
    return sa.Column(name, sa.Text(), **kw)


def _json(name: str, default: str) -> sa.Column:
    return sa.Column(name, sa.Text(), nullable=False, server_default=default)


def _create_tables() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table("ai_llm_connections"):
        op.create_table(
            "ai_llm_connections",
            _text("id", primary_key=True),
            _text("name", nullable=False, unique=True),
            _text("kind", nullable=False, server_default="openai_compatible"),
            _text("base_url", nullable=False),
            _text("auth_type", nullable=False, server_default="none"),
            _json("auth_config", "{}"),
            _text("secrets_encrypted", nullable=True),
            _json("extra_headers", "{}"),
            _json("options", "{}"),
            _json("models", "{}"),
            _json("capabilities", "{}"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            _text("last_test_at", nullable=True),
            _text("last_test_status", nullable=True),
            _text("last_test_detail", nullable=True),
            _text("created_by", nullable=True),
            _text("created_at", nullable=False),
            _text("updated_by", nullable=True),
            _text("updated_at", nullable=False),
        )

    if not inspector.has_table("ai_settings"):
        op.create_table(
            "ai_settings",
            sa.Column("id", sa.Integer(), primary_key=True),
            _text("chat_connection_id", nullable=True),
            _text("fast_connection_id", nullable=True),
            _text("embedding_connection_id", nullable=True),
            _text("personas", nullable=True),
            _text("data_policy", nullable=True),
            _text("limits", nullable=True),
            sa.Column("retention_days", sa.Integer(), nullable=True),
            _text("updated_by", nullable=True),
            _text("updated_at", nullable=True),
        )

    if not inspector.has_table("ai_conversations"):
        op.create_table(
            "ai_conversations",
            _text("id", primary_key=True),
            _text("user_id", nullable=False),
            _text("persona", nullable=False, server_default="data"),
            _text("title", nullable=True),
            _text("workspace_id", nullable=True),
            _text("data_source_id", nullable=True),
            _text("view_id", nullable=True),
            _json("state", "{}"),
            sa.Column("message_count", sa.Integer(), nullable=False, server_default="0"),
            _text("created_at", nullable=False),
            _text("updated_at", nullable=False),
            _text("deleted_at", nullable=True),
        )
    op.create_index(
        "idx_ai_conversations_user_updated", "ai_conversations",
        ["user_id", "updated_at"], if_not_exists=True,
    )

    if not inspector.has_table("ai_messages"):
        op.create_table(
            "ai_messages",
            _text("id", primary_key=True),
            _text("conversation_id", nullable=False),
            _text("user_id", nullable=False),
            _text("role", nullable=False),
            _text("content", nullable=False, server_default=""),
            _json("blocks", "[]"),
            _json("steps", "[]"),
            _json("followups", "[]"),
            _text("status", nullable=False, server_default="ok"),
            _text("model", nullable=True),
            sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("latency_ms", sa.Integer(), nullable=True),
            sa.Column("feedback", sa.Integer(), nullable=True),
            _text("feedback_comment", nullable=True),
            _text("created_at", nullable=False),
        )
    op.create_index(
        "idx_ai_messages_conversation", "ai_messages",
        ["conversation_id", "created_at"], if_not_exists=True,
    )
    op.create_index(
        "idx_ai_messages_feedback", "ai_messages", ["feedback", "created_at"],
        if_not_exists=True,
    )

    if not inspector.has_table("ai_concept_mappings"):
        op.create_table(
            "ai_concept_mappings",
            _text("id", primary_key=True),
            _text("workspace_id", nullable=False),
            _text("data_source_id", nullable=False),
            _text("scope", nullable=False, server_default="personal"),
            _text("user_id", nullable=False, server_default=""),
            _text("concept", nullable=False),
            _text("label", nullable=False),
            _text("description", nullable=True),
            _text("predicate", nullable=False),
            sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
            _text("created_by", nullable=True),
            _text("created_at", nullable=False),
            _text("updated_at", nullable=False),
            sa.UniqueConstraint(
                "data_source_id", "scope", "user_id", "concept",
                name="uq_ai_concept_mappings_concept",
            ),
        )
    op.create_index(
        "idx_ai_concept_mappings_source", "ai_concept_mappings",
        ["data_source_id", "concept"], if_not_exists=True,
    )

    if not inspector.has_table("ai_usage_daily"):
        op.create_table(
            "ai_usage_daily",
            _text("user_id", primary_key=True),
            _text("day", primary_key=True),
            sa.Column("requests", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        )

    if not inspector.has_table("ai_knowledge_sources"):
        op.create_table(
            "ai_knowledge_sources",
            _text("id", primary_key=True),
            _text("name", nullable=False, unique=True),
            _text("kind", nullable=False, server_default="mcp"),
            _text("url", nullable=False),
            _text("auth_type", nullable=False, server_default="none"),
            _json("auth_config", "{}"),
            _text("secrets_encrypted", nullable=True),
            _text("tool_name", nullable=False),
            _json("argument_map", "{}"),
            _json("result_map", "{}"),
            _json("personas", '["help"]'),
            sa.Column("timeout_ms", sa.Integer(), nullable=False, server_default="4000"),
            _text("trust_label", nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            _text("created_by", nullable=True),
            _text("created_at", nullable=False),
            _text("updated_by", nullable=True),
            _text("updated_at", nullable=False),
        )


def _grant_permission() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            INSERT INTO permissions (id, description, category, long_description, examples)
            VALUES (:id, :description, :category, :long_description, :examples)
            ON CONFLICT (id) DO NOTHING
            """
        ),
        {
            "id": _PERMISSION,
            "description": _DESCRIPTION,
            "category": "workspace",
            "long_description": _LONG_DESCRIPTION,
            "examples": json.dumps(_EXAMPLES),
        },
    )
    for role_name in _ROLES:
        conn.execute(
            sa.text(
                """
                INSERT INTO role_permissions (role_name, permission_id)
                VALUES (:role_name, :permission_id)
                ON CONFLICT (role_name, permission_id) DO NOTHING
                """
            ),
            {"role_name": role_name, "permission_id": _PERMISSION},
        )
    conn.execute(
        sa.text(
            """
            INSERT INTO role_permissions (role_name, permission_id)
            SELECT rp.role_name, :perm
            FROM role_permissions rp
            JOIN roles r ON r.name = rp.role_name
            WHERE rp.permission_id = 'workspace:datasource:read' AND r.is_system = FALSE
            ON CONFLICT (role_name, permission_id) DO NOTHING
            """
        ),
        {"perm": _PERMISSION},
    )


def upgrade() -> None:
    _bound_lock_wait()
    _create_tables()
    _grant_permission()


def downgrade() -> None:
    _bound_lock_wait()
    conn = op.get_bind()
    conn.execute(
        sa.text("DELETE FROM role_permissions WHERE permission_id = :perm"), {"perm": _PERMISSION},
    )
    conn.execute(sa.text("DELETE FROM permissions WHERE id = :id"), {"id": _PERMISSION})
    for table in (
        "ai_knowledge_sources", "ai_usage_daily", "ai_concept_mappings",
        "ai_messages", "ai_conversations", "ai_settings", "ai_llm_connections",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")
