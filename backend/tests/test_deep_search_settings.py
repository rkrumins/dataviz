"""Tests for ``backend.app.services.deep_search.settings``.

Covers:
  * Defaults applied when env is empty.
  * Env-var override path takes effect after ``cache_clear()``.
  * The PEP 562 back-compat surface in the legacy modules resolves
    to live settings (so a test changing env still sees the new
    value through ``CANDIDATE_CAP`` etc.).
"""
from __future__ import annotations

import pytest

from backend.app.services.deep_search import (
    DeepSearchSettings,
    get_deep_search_settings,
)


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """Make sure each test starts with a fresh settings instance."""
    get_deep_search_settings.cache_clear()
    yield
    get_deep_search_settings.cache_clear()


def test_settings_defaults(monkeypatch):
    """With no env vars set, every field carries its documented default."""
    for key in [
        "DEEP_SEARCH_MAX_TREE_DEPTH",
        "DEEP_SEARCH_MAX_LEAF_COUNT",
        "DEEP_SEARCH_MAX_OR_BRANCH",
        "DEEP_SEARCH_CANDIDATE_CAP",
        "DEEP_SEARCH_CANDIDATE_CAP_MAX",
        "DEEP_SEARCH_SOFT_DEADLINE_MS",
        "DEEP_SEARCH_DISCOVER_SAMPLES",
        "DEEP_SEARCH_DISCOVER_VALUE_SAMPLES",
        "DEEP_SEARCH_DISCOVER_KEY_CAP",
        "DEEP_SEARCH_DISCOVER_TAG_CAP",
        "DEEP_SEARCH_DISCOVER_EDGE_CAP",
        "DEEP_SEARCH_SUBAGG_PARENT_CAP",
        "DEEP_SEARCH_SCOPE_PRE_FILTER_THRESHOLD",
        "DEEP_SEARCH_SEARCHABLE_TEXT_CAP",
        "DEEP_SEARCH_CACHE_TTL",
        "DEEP_SEARCH_RATE_LIMIT_PER_MIN",
    ]:
        monkeypatch.delenv(key, raising=False)
    get_deep_search_settings.cache_clear()

    s = get_deep_search_settings()

    assert isinstance(s, DeepSearchSettings)
    assert s.max_tree_depth == 6
    assert s.max_leaf_count == 64
    assert s.max_or_branch == 24
    assert s.candidate_cap == 5000
    assert s.candidate_cap_max == 50000
    assert s.default_soft_deadline_ms == 3000
    assert s.discover_samples_per_label == 200
    assert s.discover_value_samples_per_key == 20
    assert s.discover_value_keys_per_label == 64
    assert s.discover_tag_values_cap == 200
    assert s.discover_edge_sample_cap == 5000
    assert s.sub_aggregation_parent_cap == 24
    assert s.scope_pre_filter_threshold == 8
    assert s.searchable_text_cap_bytes == 8192
    assert s.cache_ttl_seconds == 60
    assert s.rate_limit_per_minute == 120


def test_settings_env_overrides(monkeypatch):
    """Each documented env var overrides its dataclass field."""
    monkeypatch.setenv("DEEP_SEARCH_CANDIDATE_CAP", "500")
    monkeypatch.setenv("DEEP_SEARCH_MAX_TREE_DEPTH", "3")
    monkeypatch.setenv("DEEP_SEARCH_DISCOVER_TAG_CAP", "50")
    monkeypatch.setenv("DEEP_SEARCH_SUBAGG_PARENT_CAP", "8")
    get_deep_search_settings.cache_clear()

    s = get_deep_search_settings()

    assert s.candidate_cap == 500
    assert s.max_tree_depth == 3
    assert s.discover_tag_values_cap == 50
    assert s.sub_aggregation_parent_cap == 8
    # Untouched fields keep their defaults.
    assert s.max_leaf_count == 64


def test_settings_invalid_int_falls_back_to_default(monkeypatch):
    """A non-integer env value is rejected; the documented default wins.

    Prevents an operator typo (e.g. ``CANDIDATE_CAP=5k``) from silently
    crashing the executor on first request.
    """
    monkeypatch.setenv("DEEP_SEARCH_CANDIDATE_CAP", "not-a-number")
    get_deep_search_settings.cache_clear()

    s = get_deep_search_settings()
    assert s.candidate_cap == 5000


def test_settings_empty_env_var_falls_back_to_default(monkeypatch):
    """Empty string is treated the same as unset."""
    monkeypatch.setenv("DEEP_SEARCH_MAX_OR_BRANCH", "")
    get_deep_search_settings.cache_clear()

    s = get_deep_search_settings()
    assert s.max_or_branch == 24


def test_pep_562_backcompat_advanced_search_service(monkeypatch):
    """Importing ``MAX_TREE_DEPTH`` from advanced_search_service should
    resolve to the current settings value, not a stale snapshot."""
    monkeypatch.setenv("DEEP_SEARCH_MAX_TREE_DEPTH", "9")
    monkeypatch.setenv("DEEP_SEARCH_MAX_LEAF_COUNT", "32")
    monkeypatch.setenv("DEEP_SEARCH_MAX_OR_BRANCH", "12")
    get_deep_search_settings.cache_clear()

    import backend.app.services.advanced_search_service as svc

    assert svc.MAX_TREE_DEPTH == 9
    assert svc.MAX_LEAF_COUNT == 32
    assert svc.MAX_OR_BRANCH == 12


def test_pep_562_backcompat_falkordb_deep_search(monkeypatch):
    """Importing the legacy constants from the falkordb provider module
    resolves to live settings via PEP 562 ``__getattr__``."""
    monkeypatch.setenv("DEEP_SEARCH_CANDIDATE_CAP", "1234")
    monkeypatch.setenv("DEEP_SEARCH_DISCOVER_TAG_CAP", "77")
    get_deep_search_settings.cache_clear()

    import backend.app.providers.falkordb_deep_search as fds

    assert fds.CANDIDATE_CAP == 1234
    assert fds._DISCOVER_TAG_VALUES_CAP == 77


def test_pep_562_backcompat_raises_for_unknown_attr():
    """Random attribute access still raises AttributeError."""
    import backend.app.providers.falkordb_deep_search as fds

    with pytest.raises(AttributeError):
        fds.NONEXISTENT_SETTING
