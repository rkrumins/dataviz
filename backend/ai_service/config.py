"""Env-sourced settings for the AI service.

Every knob in one frozen object, so operators tune the service from one place
and tests build a config without touching ``os.environ``. What an
administrator changes at run time — which connection, what may be sent, the
limits per person — lives in ``ai_settings`` (``settings_store``), not here:
this file holds what only an operator should decide (where the service
listens, what it may reach on the network, how long anything may take).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from backend.common.netguard import normalise_allowlist


def _int(name: str, default: int, *, low: int, high: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(low, min(high, value))


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class AiServiceConfig:
    #: Where this service listens.
    port: int = 8093
    #: The platform's own API, which every data read goes back through with
    #: the person's delegation.
    platform_api_url: str = "http://viz-service:8000"
    platform_timeout_seconds: int = 60
    #: Private ``host:port`` destinations (an internal LLM gateway, a token
    #: endpoint, an MCP server) this service may reach. Public addresses need
    #: no entry; loopback and link-local are refused whatever this says.
    egress_allowed_hosts: frozenset[str] = field(default_factory=frozenset)
    #: Outbound calls to models and MCP servers.
    llm_timeout_seconds: int = 60
    #: The vector store (pgvector). Unset: retrieval is lexical only, over
    #: the docs corpus bundled with this release.
    vector_db_url: str = ""
    #: A whole turn — every model call and tool call in it.
    turn_timeout_seconds: int = 90
    #: The views collection's sync: how often it looks for changed views, and
    #: whether the indexer runs in this process at all.
    indexer_enabled: bool = True
    views_sync_interval_seconds: int = 300
    embed_batch_size: int = 64
    #: A read-only service account's API key (``nxsat_…``) the views sync
    #: lists views with. Unset: the views collection is not built, and view
    #: discovery searches by keyword, as the person asking.
    indexer_api_key: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> "AiServiceConfig":
        return cls(
            port=_int("AI_SERVICE_PORT", 8093, low=1, high=65535),
            platform_api_url=os.getenv(
                "AI_PLATFORM_API_URL", "http://viz-service:8000",
            ).rstrip("/"),
            platform_timeout_seconds=_int(
                "AI_PLATFORM_TIMEOUT_SECONDS", 60, low=5, high=150,
            ),
            egress_allowed_hosts=normalise_allowlist(
                os.getenv("AI_EGRESS_ALLOWED_HOSTS", "").split(","),
            ),
            llm_timeout_seconds=_int("AI_LLM_TIMEOUT_SECONDS", 60, low=5, high=300),
            vector_db_url=os.getenv("AI_VECTOR_DB_URL", "").strip(),
            turn_timeout_seconds=_int("AI_TURN_TIMEOUT_SECONDS", 90, low=10, high=170),
            indexer_enabled=_bool("AI_INDEXER_ENABLED", True),
            views_sync_interval_seconds=_int(
                "AI_VIEWS_SYNC_INTERVAL_SECONDS", 300, low=30, high=86400,
            ),
            embed_batch_size=_int("AI_EMBED_BATCH_SIZE", 64, low=1, high=512),
            indexer_api_key=os.getenv("AI_INDEXER_API_KEY", "").strip(),
        )


_config: AiServiceConfig | None = None


def get_config() -> AiServiceConfig:
    global _config
    if _config is None:
        _config = AiServiceConfig.from_env()
    return _config


def set_config_for_tests(config: AiServiceConfig | None) -> None:
    global _config
    _config = config
