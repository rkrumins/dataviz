"""SAML assertion replay protection has to survive a provider rebuild.

``SamlProvider.fetch_identity`` always called a replay cache. Nothing
ever handed it one: ``build_saml_provider`` took no such argument, so
every provider constructed ``_MemoryReplayCache()`` — a plain dict on
one worker. ``docs/SSO_INTEGRATION.md`` meanwhile listed the control as
"Redis-backed cache keyed by assertion id, TTL = NotOnOrAfter".

Two things made the dict worse than "per-worker":

  * viz-service runs 4 gunicorn workers per container across N replicas,
    so a replay only has to reach a worker that has not seen it;
  * ``ProviderRegistry`` rebuilds the provider every 60 s, and each
    rebuild made a NEW dict — so even one worker forgot everything once
    a minute, well inside an assertion's validity window.

The rebuild is the case worth pinning, because it is the one a
"does a second POST get rejected?" test would pass while still being
completely broken in production.
"""
from __future__ import annotations

import time

import pytest

from backend.app.services.revocation_service import (
    InMemoryBackend,
    SharedSamlReplayCache,
    get_revocation_service,
    get_saml_replay_cache,
)

saml2 = pytest.importorskip(
    "backend.auth_service.providers.saml2",
    reason="python3-saml / libxmlsec1 not available",
)


def _cache_of(provider) -> object:
    return provider._replay_cache


def _snapshot(**over):
    """Minimal snapshot; only the fields the builder reads matter here."""
    from backend.auth_service.providers.registry import ProviderConfigSnapshot

    fields = dict(
        id="idp_saml_1", slug="corp-saml", kind="saml2",
        display_name="Corp SAML", enabled=True,
        settings={
            "idp_entity_id": "https://idp.corp.example/metadata",
            "idp_sso_url": "https://idp.corp.example/sso",
            "idp_x509_cert": "MIIBstubcert",
            "sp_entity_id": "https://app.example/sp",
            "sp_acs_url": "https://app.example/api/v1/auth/corp-saml/acs",
        },
        claim_mapping={}, linking_policy="strict",
        priority=100, button_label=None, button_icon=None,
    )
    fields.update(over)
    return ProviderConfigSnapshot(**fields)


# ── The wiring itself ────────────────────────────────────────────────

def test_build_saml_provider_accepts_and_uses_an_injected_cache():
    """The argument that did not exist, which is why nothing passed one."""
    sentinel = object()
    provider = saml2.build_saml_provider(_snapshot(), replay_cache=sentinel)
    assert _cache_of(provider) is sentinel


def test_two_provider_rebuilds_share_one_injected_cache():
    """The 60-second registry rebuild must not reset replay state.

    With the old factory each rebuild constructed its own
    ``_MemoryReplayCache``, so this is the assertion that actually
    distinguishes a wired deployment from an unwired one.
    """
    shared = SharedSamlReplayCache(InMemoryBackend())
    first = saml2.build_saml_provider(_snapshot(), replay_cache=shared)
    second = saml2.build_saml_provider(_snapshot(), replay_cache=shared)
    assert _cache_of(first) is _cache_of(second) is shared


def test_the_unwired_fallback_forgets_across_rebuilds():
    """Pins WHY the injection matters, rather than asserting it abstractly."""
    first = saml2.build_saml_provider(_snapshot())
    second = saml2.build_saml_provider(_snapshot())
    assert _cache_of(first) is not _cache_of(second)


# ── The cache's own behaviour ────────────────────────────────────────

async def test_an_assertion_id_is_accepted_once_and_then_refused():
    cache = SharedSamlReplayCache(InMemoryBackend())
    expiry = int(time.time()) + 300

    assert await cache.record("_assertion_abc", expiry) is True
    assert await cache.record("_assertion_abc", expiry) is False
    assert await cache.record("_assertion_abc", expiry) is False


async def test_distinct_assertions_do_not_collide():
    cache = SharedSamlReplayCache(InMemoryBackend())
    expiry = int(time.time()) + 300
    assert await cache.record("_one", expiry) is True
    assert await cache.record("_two", expiry) is True


async def test_a_shared_backend_rejects_a_replay_seen_by_another_worker():
    """Two providers, one store — the multi-worker case.

    Each ``SharedSamlReplayCache`` here stands in for a separate
    gunicorn worker. They must not be able to accept the same assertion
    independently, which is exactly what the per-process dict allowed.
    """
    backend = InMemoryBackend()
    worker_a = SharedSamlReplayCache(backend)
    worker_b = SharedSamlReplayCache(backend)
    expiry = int(time.time()) + 300

    assert await worker_a.record("_replayed", expiry) is True
    assert await worker_b.record("_replayed", expiry) is False


# ── The "is there a shared store at all?" probe ──────────────────────

def test_get_saml_replay_cache_reports_none_on_an_in_process_backend():
    """``None`` is what makes ``app/main.py`` refuse to serve SAML in prod.

    Returning a local dict here instead would reinstate the original
    bug — a control that looks present and enforces nothing.
    """
    backend = getattr(get_revocation_service(), "_backend", None)
    if not isinstance(backend, InMemoryBackend):
        pytest.skip("suite is running against a real revocation store")
    assert get_saml_replay_cache() is None


# ── The prod refusal is scoped to actual SAML providers ──────────────

def test_a_prod_deployment_without_a_shared_store_refuses_that_provider():
    """Refused at BUILD time, not at boot.

    Without a shared store every worker forgets every assertion
    independently, so a captured SAMLResponse is replayable for its
    whole validity window — an absent control, not a degraded one.
    """
    from backend.app.main import saml_builder_with_replay_cache

    def _base(snap, replay_cache=None):  # pragma: no cover - must not run
        raise AssertionError("the guard should have refused first")

    build = saml_builder_with_replay_cache(_base, None, is_prod=True)
    with pytest.raises(RuntimeError) as err:
        build(_snapshot())
    assert "corp-saml" in str(err.value)


def test_a_deployment_with_no_saml_provider_is_unaffected():
    """The guard raises per provider, so a prod stack that merely has
    python3-saml installed and configures no SAML provider still boots.

    Building the wrapper is the whole of what startup does; nothing is
    refused until a provider is actually built.
    """
    from backend.app.main import saml_builder_with_replay_cache

    build = saml_builder_with_replay_cache(lambda s, replay_cache=None: None, None, True)
    assert callable(build)  # no raise at wire time


def test_a_shared_store_is_handed_to_the_provider():
    """The happy path still passes the cache through, in prod and out."""
    from backend.app.main import saml_builder_with_replay_cache

    seen = {}

    def _base(snap, replay_cache=None):
        seen["cache"] = replay_cache
        return "provider"

    cache = object()
    for is_prod in (True, False):
        seen.clear()
        assert saml_builder_with_replay_cache(_base, cache, is_prod)(_snapshot()) == "provider"
        assert seen["cache"] is cache


def test_a_dev_deployment_without_a_shared_store_still_builds():
    """Dev warns loudly at startup but does not refuse — the in-process
    cache is useless across workers, and a single-process dev stack has
    exactly one."""
    from backend.app.main import saml_builder_with_replay_cache

    build = saml_builder_with_replay_cache(lambda s, replay_cache=None: "provider", None, False)
    assert build(_snapshot()) == "provider"
