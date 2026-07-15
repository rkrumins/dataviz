"""Tunables for advanced search.

Reads ``DEEP_SEARCH_*`` environment variables with documented defaults.
Mirrors the ``ProviderEnvBudget`` pattern in
``backend/common/providers/config.py``: a frozen dataclass with a
``from_env()`` classmethod and a process-level ``lru_cache`` accessor.

Every magic number in the search core lives here. Operators tune via
env at deploy time; tests override via ``monkeypatch.setenv(...)`` plus
``get_deep_search_settings.cache_clear()``.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class DeepSearchSettings:
    """All advanced-search tunables in one frozen value object."""

    # --- Predicate-tree caps (service-layer validator) ---
    max_tree_depth: int
    max_leaf_count: int
    max_or_branch: int

    # --- Per-query execution caps ---
    candidate_cap: int
    candidate_cap_max: int
    default_soft_deadline_ms: int

    # --- Discovery sampling caps ---
    discover_samples_per_label: int
    discover_value_samples_per_key: int
    discover_value_keys_per_label: int
    discover_tag_values_cap: int
    discover_edge_sample_cap: int

    # --- Aggregation / pagination ---
    sub_aggregation_parent_cap: int
    scope_pre_filter_threshold: int
    # Maximum number of root URNs allowed on ``SearchScope.root_urns``.
    # The FE passes the layer's / view's top-level entity URNs as the
    # authoritative scope (layer membership is a per-view frontend concept
    # — see the layer-scoped-search design). A large layer or a deeply
    # multi-domain pipeline view routinely has 1000+ top-level entities,
    # so the old 256 default silently truncated the scope and dropped
    # matches. 5000 covers realistic large layers while still bounding the
    # Cypher IN-list size; the root-anchored candidate scan keeps the
    # containment-expansion fanout proportional to the scope subtree, not
    # the graph.
    scope_root_urns_cap: int

    # --- Storage ---
    searchable_text_cap_bytes: int

    # --- Production hardening (Phase 3) ---
    cache_ttl_seconds: int
    rate_limit_per_minute: int

    @classmethod
    def from_env(cls) -> "DeepSearchSettings":
        """Read ``DEEP_SEARCH_*`` env vars with documented fallbacks."""
        return cls(
            max_tree_depth=_read_int("DEEP_SEARCH_MAX_TREE_DEPTH", 6),
            max_leaf_count=_read_int("DEEP_SEARCH_MAX_LEAF_COUNT", 64),
            max_or_branch=_read_int("DEEP_SEARCH_MAX_OR_BRANCH", 24),
            candidate_cap=_read_int("DEEP_SEARCH_CANDIDATE_CAP", 10000),
            candidate_cap_max=_read_int("DEEP_SEARCH_CANDIDATE_CAP_MAX", 100000),
            default_soft_deadline_ms=_read_int(
                "DEEP_SEARCH_SOFT_DEADLINE_MS", 30000,
            ),
            discover_samples_per_label=_read_int(
                "DEEP_SEARCH_DISCOVER_SAMPLES", 200,
            ),
            discover_value_samples_per_key=_read_int(
                "DEEP_SEARCH_DISCOVER_VALUE_SAMPLES", 20,
            ),
            discover_value_keys_per_label=_read_int(
                "DEEP_SEARCH_DISCOVER_KEY_CAP", 64,
            ),
            discover_tag_values_cap=_read_int(
                "DEEP_SEARCH_DISCOVER_TAG_CAP", 200,
            ),
            discover_edge_sample_cap=_read_int(
                "DEEP_SEARCH_DISCOVER_EDGE_CAP", 5000,
            ),
            sub_aggregation_parent_cap=_read_int(
                "DEEP_SEARCH_SUBAGG_PARENT_CAP", 24,
            ),
            scope_pre_filter_threshold=_read_int(
                "DEEP_SEARCH_SCOPE_PRE_FILTER_THRESHOLD", 8,
            ),
            scope_root_urns_cap=_read_int(
                "DEEP_SEARCH_SCOPE_ROOT_URNS_CAP", 5000,
            ),
            searchable_text_cap_bytes=_read_int(
                "DEEP_SEARCH_SEARCHABLE_TEXT_CAP", 8192,
            ),
            cache_ttl_seconds=_read_int("DEEP_SEARCH_CACHE_TTL", 60),
            rate_limit_per_minute=_read_int(
                "DEEP_SEARCH_RATE_LIMIT_PER_MIN", 120,
            ),
        )


@lru_cache(maxsize=1)
def get_deep_search_settings() -> DeepSearchSettings:
    """Process-cached settings. Tests should call ``cache_clear()``
    after mutating env to pick up new values.
    """
    return DeepSearchSettings.from_env()


def _read_int(env_var: str, default: int) -> int:
    raw = os.getenv(env_var)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default
