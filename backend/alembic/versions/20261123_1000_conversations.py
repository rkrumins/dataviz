"""Questions and conversations about views and data sources, and data contacts.

The ``collaboration`` domain:

* ``discussions`` — one row per question: what it is about (``subject_type``
  ``view`` | ``data_source`` and ``subject_id``, optionally anchored to one
  entity), who may see it (``visibility``), where it stands (``status``), and
  counters kept up to date in the same transaction as each message, so a list
  never aggregates. ``version`` guards status and answer changes. The
  housekeeping columns record reminders, the watcher fan-out's progress and
  archiving.
* ``discussion_messages`` — the question and its replies. ``(author_id,
  client_key)`` is unique, so a retried post is answered with the original.
* ``discussion_participants`` — who is in a thread and how they joined, what
  they last read, whether they follow or muted it.
* ``watches`` — someone watching a view or a data source for new questions.

And, in the ``workspace`` domain, ``data_source_contacts``: a source's named
Owner (at most one) and Stewards, each a person or a group.

No foreign key leaves its domain: subjects, people and groups are named by id.
Fresh installs get the tables from ``0001_baseline``'s create_all and never run
this file, so the DDL is guarded. Create-only: nothing is rewritten or
backfilled. Revision id is kept <=32 chars (alembic_version.version_num is
VARCHAR(32)).

Revision ID: 20261123_1000_conversations
Revises: 20261122_1100_data_requests
Create Date: 2026-11-23 10:00
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261123_1000_conversations"
down_revision: Union[str, None] = "20261122_1100_data_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_FANOUT = "watchers_notified_at IS NULL AND visibility = 'open' AND deleted_at IS NULL"
_ANCHORED = "entity_id IS NOT NULL"
_QUESTION = "kind = 'question'"
_OWNER = "role = 'owner'"


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")
    inspector = sa.inspect(bind)

    if not inspector.has_table("discussions"):
        op.create_table(
            "discussions",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("subject_type", sa.Text(), nullable=False),
            sa.Column("subject_id", sa.Text(), nullable=False),
            sa.Column("entity_id", sa.Text(), nullable=True),
            sa.Column("entity_label", sa.Text(), nullable=True),
            sa.Column("visibility", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("asked_by", sa.Text(), nullable=False),
            sa.Column("excerpt", sa.Text(), nullable=False),
            sa.Column("answer_message_id", sa.Text(), nullable=True),
            sa.Column("resolved_at", sa.Text(), nullable=True),
            sa.Column("resolved_by", sa.Text(), nullable=True),
            sa.Column("message_count", sa.Integer(), nullable=False),
            sa.Column("participant_count", sa.Integer(), nullable=False),
            sa.Column("last_activity_at", sa.Text(), nullable=False),
            sa.Column("last_message_by", sa.Text(), nullable=False),
            sa.Column("first_response_at", sa.Text(), nullable=True),
            sa.Column("reminded_at", sa.Text(), nullable=True),
            sa.Column("escalated_at", sa.Text(), nullable=True),
            sa.Column("watchers_notified_at", sa.Text(), nullable=True),
            sa.Column("watchers_cursor", sa.Text(), nullable=True),
            sa.Column("archived_at", sa.Text(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.Column("deleted_at", sa.Text(), nullable=True),
            sa.Column("deleted_by", sa.Text(), nullable=True),
            sa.CheckConstraint("subject_type IN ('view', 'data_source')", name="ck_discussions_subject_type"),
            sa.CheckConstraint("visibility IN ('open', 'private')", name="ck_discussions_visibility"),
            sa.CheckConstraint("status IN ('open', 'answered', 'closed')", name="ck_discussions_status"),
        )
    op.create_index(
        "idx_discussions_subject_activity", "discussions",
        ["subject_type", "subject_id", "last_activity_at", "id"], if_not_exists=True,
    )
    op.create_index(
        "idx_discussions_subject_updated", "discussions",
        ["subject_type", "subject_id", "updated_at"], if_not_exists=True,
    )
    op.create_index(
        "idx_discussions_subject_entity", "discussions", ["subject_type", "subject_id", "entity_id"],
        postgresql_where=sa.text(_ANCHORED), sqlite_where=sa.text(_ANCHORED), if_not_exists=True,
    )
    op.create_index(
        "idx_discussions_status_response", "discussions", ["status", "first_response_at", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_discussions_asker_activity", "discussions", ["asked_by", "last_activity_at", "id"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_discussions_fanout", "discussions", ["created_at"],
        postgresql_where=sa.text(_FANOUT), sqlite_where=sa.text(_FANOUT), if_not_exists=True,
    )

    if not inspector.has_table("discussion_messages"):
        op.create_table(
            "discussion_messages",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("discussion_id", sa.Text(), sa.ForeignKey("discussions.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column("author_id", sa.Text(), nullable=False),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("mentions", sa.Text(), nullable=False),
            sa.Column("client_key", sa.Text(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("edited_at", sa.Text(), nullable=True),
            sa.Column("deleted_at", sa.Text(), nullable=True),
            sa.Column("deleted_by", sa.Text(), nullable=True),
            sa.CheckConstraint("kind IN ('question', 'reply')", name="ck_discussion_messages_kind"),
            sa.CheckConstraint("length(body) <= 10000", name="ck_discussion_messages_body"),
            sa.UniqueConstraint("author_id", "client_key", name="uq_discussion_messages_client_key"),
        )
    op.create_index(
        "idx_discussion_messages_thread", "discussion_messages", ["discussion_id", "created_at", "id"],
        if_not_exists=True,
    )
    op.create_index(
        "uq_discussion_messages_question", "discussion_messages", ["discussion_id"], unique=True,
        postgresql_where=sa.text(_QUESTION), sqlite_where=sa.text(_QUESTION), if_not_exists=True,
    )

    if not inspector.has_table("discussion_participants"):
        op.create_table(
            "discussion_participants",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("discussion_id", sa.Text(), sa.ForeignKey("discussions.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("joined_via", sa.Text(), nullable=False),
            sa.Column("asked_to", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("mentioned_at", sa.Text(), nullable=True),
            sa.Column("muted", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("following", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("last_read_at", sa.Text(), nullable=True),
            sa.Column("posted_at", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.CheckConstraint(
                "joined_via IN ('asked', 'asked_to', 'mentioned', 'replied', 'followed')",
                name="ck_discussion_participants_joined_via",
            ),
            sa.UniqueConstraint("discussion_id", "user_id", name="uq_discussion_participants"),
        )
    op.create_index(
        "idx_discussion_participants_user", "discussion_participants", ["user_id", "discussion_id"],
        if_not_exists=True,
    )
    op.create_index(
        "idx_discussion_participants_mentions", "discussion_participants", ["user_id", "mentioned_at"],
        if_not_exists=True,
    )

    if not inspector.has_table("watches"):
        op.create_table(
            "watches",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("subject_type", sa.Text(), nullable=False),
            sa.Column("subject_id", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.CheckConstraint("subject_type IN ('view', 'data_source')", name="ck_watches_subject_type"),
            sa.UniqueConstraint("subject_type", "subject_id", "user_id", name="uq_watches_subject_user"),
        )
    op.create_index("idx_watches_user", "watches", ["user_id", "created_at"], if_not_exists=True)

    if not inspector.has_table("data_source_contacts"):
        op.create_table(
            "data_source_contacts",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("data_source_id", sa.Text(),
                      sa.ForeignKey("workspace_data_sources.id", ondelete="CASCADE"), nullable=False),
            sa.Column("role", sa.Text(), nullable=False),
            sa.Column("subject_type", sa.Text(), nullable=False),
            sa.Column("subject_id", sa.Text(), nullable=False),
            sa.Column("added_by", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.CheckConstraint("role IN ('owner', 'steward')", name="ck_data_source_contacts_role"),
            sa.CheckConstraint("subject_type IN ('user', 'group')", name="ck_data_source_contacts_subject"),
            sa.UniqueConstraint("data_source_id", "subject_type", "subject_id", name="uq_data_source_contacts"),
        )
    op.create_index(
        "uq_data_source_contacts_owner", "data_source_contacts", ["data_source_id"], unique=True,
        postgresql_where=sa.text(_OWNER), sqlite_where=sa.text(_OWNER), if_not_exists=True,
    )
    op.create_index(
        "idx_data_source_contacts_subject", "data_source_contacts", ["subject_type", "subject_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("idx_data_source_contacts_subject", table_name="data_source_contacts", if_exists=True)
    op.drop_index("uq_data_source_contacts_owner", table_name="data_source_contacts", if_exists=True)
    op.drop_table("data_source_contacts")
    op.drop_index("idx_watches_user", table_name="watches", if_exists=True)
    op.drop_table("watches")
    op.drop_index("idx_discussion_participants_mentions", table_name="discussion_participants", if_exists=True)
    op.drop_index("idx_discussion_participants_user", table_name="discussion_participants", if_exists=True)
    op.drop_table("discussion_participants")
    op.drop_index("uq_discussion_messages_question", table_name="discussion_messages", if_exists=True)
    op.drop_index("idx_discussion_messages_thread", table_name="discussion_messages", if_exists=True)
    op.drop_table("discussion_messages")
    op.drop_index("idx_discussions_fanout", table_name="discussions", if_exists=True)
    op.drop_index("idx_discussions_asker_activity", table_name="discussions", if_exists=True)
    op.drop_index("idx_discussions_status_response", table_name="discussions", if_exists=True)
    op.drop_index("idx_discussions_subject_entity", table_name="discussions", if_exists=True)
    op.drop_index("idx_discussions_subject_updated", table_name="discussions", if_exists=True)
    op.drop_index("idx_discussions_subject_activity", table_name="discussions", if_exists=True)
    op.drop_table("discussions")
