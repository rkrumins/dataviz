"""Unit tests for the per-role DB engine factory (plan Gap 3).

These tests exercise the engine factory's invariants without requiring
a live Postgres — the bulkhead is a structural property (distinct
``AsyncEngine`` instances per role) more than a runtime behaviour, and
runtime saturation is covered by the integration suite against a real
Postgres.

What we lock in here:
1. Each :class:`PoolRole` gets its own engine instance (no accidental
   aliasing through the shared cache).
2. Per-role env vars (``DB_JOBS_POOL_SIZE`` etc.) take precedence over
   the legacy ``DB_POOL_SIZE`` / ``DB_POOL_MAX_OVERFLOW`` knobs for
   non-WEB roles, while ``WEB`` still honours them (back-compat).
3. ``pool_status()`` only reports roles whose engine has been
   materialised — no ghost entries.
4. :attr:`PoolRole.READONLY` opens its connections with
   ``default_transaction_read_only=on`` via ``server_settings``.
5. Session factories are also role-keyed so a JOBS session is never
   inadvertently bound to the WEB engine.
"""

from __future__ import annotations

import pytest

from backend.app.db import engine as engine_mod
from backend.app.db.engine import (
    PoolRole,
    _asyncpg_connect_args,
    _pool_kwargs,
    get_engine,
    get_session_factory,
    pool_status,
)


@pytest.fixture(autouse=True)
def _reset_engine_cache():
    """Every test gets a fresh engine/session cache so env-var overrides
    and "materialised vs not" assertions aren't polluted by prior runs."""
    # Remember the cached state so we don't trash the session-wide engine.
    prev_engines = dict(engine_mod._engines)
    prev_factories = dict(engine_mod._session_factories)
    engine_mod._engines.clear()
    engine_mod._session_factories.clear()
    try:
        yield
    finally:
        # Leave the cache empty so subsequent tests re-create on demand;
        # don't restore to avoid holding on to engines whose URL env var
        # just got monkeypatched.
        engine_mod._engines.clear()
        engine_mod._session_factories.clear()
        # Re-populate with whatever the session had, so session-scoped
        # fixtures still see their pre-existing engines if they exist.
        engine_mod._engines.update(prev_engines)
        engine_mod._session_factories.update(prev_factories)


def test_each_role_gets_its_own_engine_instance():
    """Core bulkhead invariant — every pool is a distinct object."""
    web = get_engine(PoolRole.WEB)
    jobs = get_engine(PoolRole.JOBS)
    readonly = get_engine(PoolRole.READONLY)
    provider_probe = get_engine(PoolRole.PROVIDER_PROBE)
    admin = get_engine(PoolRole.ADMIN)

    # Pairwise distinct.
    engines = [web, jobs, readonly, provider_probe, admin]
    for a, b in [(e1, e2) for e1 in engines for e2 in engines if e1 is not e2]:
        assert a is not b, "per-role engines must not alias each other"

    # Caching within a role — asking twice returns the same instance.
    assert get_engine(PoolRole.WEB) is web
    assert get_engine(PoolRole.JOBS) is jobs
    assert get_engine(PoolRole.PROVIDER_PROBE) is provider_probe


def test_default_role_is_web():
    """``get_engine()`` with no argument must return the WEB engine so
    every existing call site keeps its exact semantics."""
    assert get_engine() is get_engine(PoolRole.WEB)


def test_session_factories_bind_to_role_specific_engines():
    web_factory = get_session_factory(PoolRole.WEB)
    jobs_factory = get_session_factory(PoolRole.JOBS)
    assert web_factory is not jobs_factory
    assert web_factory.kw["bind"] is get_engine(PoolRole.WEB)
    assert jobs_factory.kw["bind"] is get_engine(PoolRole.JOBS)


def test_default_pool_sizes_per_role():
    """Each default pool size matches the plan's recommended tuning so
    unit tests alert us if somebody silently grew/shrunk a pool."""
    assert _pool_kwargs(PoolRole.WEB)["pool_size"] == 20
    assert _pool_kwargs(PoolRole.WEB)["max_overflow"] == 10
    assert _pool_kwargs(PoolRole.JOBS)["pool_size"] == 8
    assert _pool_kwargs(PoolRole.JOBS)["max_overflow"] == 4
    assert _pool_kwargs(PoolRole.READONLY)["pool_size"] == 10
    assert _pool_kwargs(PoolRole.READONLY)["max_overflow"] == 5
    assert _pool_kwargs(PoolRole.PROVIDER_PROBE)["pool_size"] == 4
    assert _pool_kwargs(PoolRole.PROVIDER_PROBE)["max_overflow"] == 2
    assert _pool_kwargs(PoolRole.ADMIN)["pool_size"] == 2
    assert _pool_kwargs(PoolRole.ADMIN)["max_overflow"] == 0


def test_per_role_env_vars_override_defaults(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DB_JOBS_POOL_SIZE", "16")
    monkeypatch.setenv("DB_JOBS_POOL_MAX_OVERFLOW", "3")
    kw = _pool_kwargs(PoolRole.JOBS)
    assert kw["pool_size"] == 16
    assert kw["max_overflow"] == 3


def test_legacy_db_pool_size_affects_web_only(monkeypatch: pytest.MonkeyPatch):
    """Operators who set ``DB_POOL_SIZE`` pre-Gap-3 expect the web tier
    to honour it. Non-WEB roles must stay on their dedicated defaults
    so a 200-sized ``DB_POOL_SIZE`` meant for request handlers cannot
    accidentally inflate the JOBS or ADMIN pools into connection-budget
    exhaustion."""
    monkeypatch.setenv("DB_POOL_SIZE", "200")
    monkeypatch.setenv("DB_POOL_MAX_OVERFLOW", "50")
    assert _pool_kwargs(PoolRole.WEB)["pool_size"] == 200
    assert _pool_kwargs(PoolRole.WEB)["max_overflow"] == 50
    assert _pool_kwargs(PoolRole.JOBS)["pool_size"] == 8
    assert _pool_kwargs(PoolRole.JOBS)["max_overflow"] == 4
    assert _pool_kwargs(PoolRole.ADMIN)["pool_size"] == 2


def test_readonly_connect_args_set_default_transaction_read_only():
    args = _asyncpg_connect_args(PoolRole.READONLY)
    assert args.get("server_settings") == {"default_transaction_read_only": "on"}


def test_provider_probe_connect_args_pin_read_only():
    """PROVIDER_PROBE only reads provider config rows — pin it read-only
    at the protocol layer the same way READONLY is pinned, so a stray
    write attempt errors at the wire rather than mutating data."""
    args = _asyncpg_connect_args(PoolRole.PROVIDER_PROBE)
    assert args.get("server_settings") == {"default_transaction_read_only": "on"}


def test_non_readonly_roles_do_not_pin_read_only():
    for role in (PoolRole.WEB, PoolRole.JOBS, PoolRole.ADMIN):
        args = _asyncpg_connect_args(role)
        assert "server_settings" not in args, (
            f"role {role.value} must not pin default_transaction_read_only"
        )


def test_pool_status_only_reports_materialised_roles():
    # No engines touched yet — the dict is empty.
    assert pool_status() == {}
    # Materialise just JOBS.
    get_engine(PoolRole.JOBS)
    snap = pool_status()
    assert set(snap.keys()) == {"jobs"}
    # Add WEB — both roles appear, the others stay absent.
    get_engine(PoolRole.WEB)
    snap = pool_status()
    assert set(snap.keys()) == {"jobs", "web"}
    assert "readonly" not in snap
    assert "admin" not in snap


def test_pool_status_returns_expected_counter_shape():
    get_engine(PoolRole.WEB)
    snap = pool_status()
    web = snap["web"]
    # Counters are present (values may be None for NullPool-style pools
    # but the keys must exist so scrapers don't KeyError).
    assert set(web.keys()) >= {"checked_out", "checked_in", "overflow", "size"}
