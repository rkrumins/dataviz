"""The AI domain's tables in the management database.

Owned by the AI service (``backend/ai_service``) and nothing else: the web
tier only proxies to it. Every reference to another domain — a user, a
workspace, a data source, a view — is an id, never a foreign key or a JOIN
(``backend/app/db/DOMAIN_OWNERSHIP.md``), so deleting a workspace never waits
on a conversation and a conversation never reads a view's row.

JSON columns are ``Text`` holding JSON, as everywhere else in this schema, so
the unit-test SQLite database and PostgreSQL agree.

Tables:
    ai_llm_connections    One completion or embedding endpoint and how to sign in to it.
    ai_settings           Single row: which connection serves which role, what may be sent.
    ai_conversations      A person's conversation with the assistant.
    ai_messages           One turn: the question, or the answer with its blocks and steps.
    ai_concept_mappings   "PII means tag pii" — a business word read as a search, remembered.
    ai_usage_daily        Requests and tokens per person per day, for budgets.
    ai_knowledge_sources  An external MCP server the Help persona also asks.

The vector store is a separate database (``AI_VECTOR_DB_URL``); its tables are
in ``backend/ai_service/knowledge/schema.py``.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, Index, Integer, Text, UniqueConstraint

from backend.app.db.engine import Base


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id(prefix: str):
    return lambda: f"{prefix}_{uuid.uuid4().hex[:16]}"


class AiLlmConnectionORM(Base):
    """A completion (and optionally embedding) endpoint.

    ``secrets_encrypted`` is a Fernet blob of the credentials the auth type
    needs (an API key, a client secret, a password) — written, merged and
    cleared, never returned. ``auth_config`` holds the non-secret half: a
    header name, a token URL, JSON paths.
    """

    __tablename__ = "ai_llm_connections"

    id = Column(Text, primary_key=True, default=_id("llm"))
    name = Column(Text, nullable=False, unique=True)
    kind = Column(Text, nullable=False, default="openai_compatible",
                  server_default="openai_compatible")
    base_url = Column(Text, nullable=False)
    auth_type = Column(Text, nullable=False, default="none", server_default="none")
    auth_config = Column(Text, nullable=False, default="{}", server_default="{}")
    secrets_encrypted = Column(Text, nullable=True)
    extra_headers = Column(Text, nullable=False, default="{}", server_default="{}")
    options = Column(Text, nullable=False, default="{}", server_default="{}")
    models = Column(Text, nullable=False, default="{}", server_default="{}")
    capabilities = Column(Text, nullable=False, default="{}", server_default="{}")
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    last_test_at = Column(Text, nullable=True)
    last_test_status = Column(Text, nullable=True)
    last_test_detail = Column(Text, nullable=True)
    created_by = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)


class AiSettingsORM(Base):
    """The assistant's settings (single row, id=1). NULL means "unset": the
    code default applies (``ai_service.settings_store``)."""

    __tablename__ = "ai_settings"

    id = Column(Integer, primary_key=True, default=1)
    chat_connection_id = Column(Text, nullable=True)
    fast_connection_id = Column(Text, nullable=True)
    embedding_connection_id = Column(Text, nullable=True)
    personas = Column(Text, nullable=True)
    data_policy = Column(Text, nullable=True)
    limits = Column(Text, nullable=True)
    retention_days = Column(Integer, nullable=True)
    updated_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=True)


class AiConversationORM(Base):
    __tablename__ = "ai_conversations"

    id = Column(Text, primary_key=True, default=_id("conv"))
    user_id = Column(Text, nullable=False)
    persona = Column(Text, nullable=False, default="data", server_default="data")
    title = Column(Text, nullable=True)
    workspace_id = Column(Text, nullable=True)
    data_source_id = Column(Text, nullable=True)
    view_id = Column(Text, nullable=True)
    #: What follow-ups refer to: result sets (as predicates), the concepts
    #: confirmed in this conversation. JSON.
    state = Column(Text, nullable=False, default="{}", server_default="{}")
    message_count = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now)
    deleted_at = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_ai_conversations_user_updated", "user_id", "updated_at"),
    )


class AiMessageORM(Base):
    __tablename__ = "ai_messages"

    id = Column(Text, primary_key=True, default=_id("msg"))
    conversation_id = Column(Text, nullable=False)
    user_id = Column(Text, nullable=False)
    role = Column(Text, nullable=False)  # user | assistant
    content = Column(Text, nullable=False, default="", server_default="")
    #: The answer's typed blocks (results, impact report, clarification…),
    #: the steps that made it, follow-ups and citations. JSON.
    blocks = Column(Text, nullable=False, default="[]", server_default="[]")
    steps = Column(Text, nullable=False, default="[]", server_default="[]")
    followups = Column(Text, nullable=False, default="[]", server_default="[]")
    status = Column(Text, nullable=False, default="ok", server_default="ok")
    model = Column(Text, nullable=True)
    input_tokens = Column(Integer, nullable=False, default=0, server_default="0")
    output_tokens = Column(Integer, nullable=False, default=0, server_default="0")
    latency_ms = Column(Integer, nullable=True)
    feedback = Column(Integer, nullable=True)  # -1, 1
    feedback_comment = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        Index("idx_ai_messages_conversation", "conversation_id", "created_at"),
        Index("idx_ai_messages_feedback", "feedback", "created_at"),
    )


class AiConceptMappingORM(Base):
    """A business word read as a search predicate, for one data source.

    ``scope`` is ``personal`` (``user_id`` names whose) or ``workspace``
    (``user_id`` is empty, and everyone asking about the source gets it).
    ``predicate`` is a ``SearchQuery`` predicate as JSON — validated by the
    same model the search endpoint uses before it is saved.
    """

    __tablename__ = "ai_concept_mappings"

    id = Column(Text, primary_key=True, default=_id("cm"))
    workspace_id = Column(Text, nullable=False)
    data_source_id = Column(Text, nullable=False)
    scope = Column(Text, nullable=False, default="personal", server_default="personal")
    user_id = Column(Text, nullable=False, default="", server_default="")
    concept = Column(Text, nullable=False)
    label = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    predicate = Column(Text, nullable=False)
    uses = Column(Integer, nullable=False, default=0, server_default="0")
    created_by = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_at = Column(Text, nullable=False, default=_now)

    __table_args__ = (
        UniqueConstraint(
            "data_source_id", "scope", "user_id", "concept",
            name="uq_ai_concept_mappings_concept",
        ),
        Index("idx_ai_concept_mappings_source", "data_source_id", "concept"),
    )


class AiUsageDailyORM(Base):
    __tablename__ = "ai_usage_daily"

    user_id = Column(Text, primary_key=True)
    day = Column(Text, primary_key=True)  # YYYY-MM-DD, UTC
    requests = Column(Integer, nullable=False, default=0, server_default="0")
    input_tokens = Column(Integer, nullable=False, default=0, server_default="0")
    output_tokens = Column(Integer, nullable=False, default=0, server_default="0")


class AiKnowledgeSourceORM(Base):
    """An MCP server the Help persona also asks, beside the product's own docs.

    Its answers are labelled with ``name`` and ``trust_label`` wherever they
    are shown, and treated as untrusted data in the prompt.
    """

    __tablename__ = "ai_knowledge_sources"

    id = Column(Text, primary_key=True, default=_id("ks"))
    name = Column(Text, nullable=False, unique=True)
    kind = Column(Text, nullable=False, default="mcp", server_default="mcp")
    url = Column(Text, nullable=False)
    auth_type = Column(Text, nullable=False, default="none", server_default="none")
    auth_config = Column(Text, nullable=False, default="{}", server_default="{}")
    secrets_encrypted = Column(Text, nullable=True)
    tool_name = Column(Text, nullable=False)
    argument_map = Column(Text, nullable=False, default="{}", server_default="{}")
    result_map = Column(Text, nullable=False, default="{}", server_default="{}")
    personas = Column(Text, nullable=False, default='["help"]', server_default='["help"]')
    timeout_ms = Column(Integer, nullable=False, default=4000, server_default="4000")
    trust_label = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True, server_default="true")
    created_by = Column(Text, nullable=True)
    created_at = Column(Text, nullable=False, default=_now)
    updated_by = Column(Text, nullable=True)
    updated_at = Column(Text, nullable=False, default=_now, onupdate=_now)


__all__ = [
    "AiConceptMappingORM", "AiConversationORM", "AiKnowledgeSourceORM",
    "AiLlmConnectionORM", "AiMessageORM", "AiSettingsORM", "AiUsageDailyORM",
]
