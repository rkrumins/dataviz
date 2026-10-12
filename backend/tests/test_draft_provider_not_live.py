"""A draft IdP provider must not authenticate anybody.

``lifecycle`` was honoured in exactly one place — ``list_public_providers``,
which feeds the login-page catalog. Authentication resolved providers
through ``get_by_slug`` / ``get_by_id``, which do not filter it, and the
registry checked only ``enabled``. Since ``POST /admin/idp-providers``
creates rows as ``lifecycle='draft'`` with ``enabled`` defaulting to
True, a provider that had been configured but never rehearsed and never
published was fully live at ``/auth/{slug}/login`` and its callback for
anyone who knew the slug — JIT provisioning included.

So "draft" meant "not advertised" when the model docstring says it means
"reaches no public surface until published". Slugs are short and
enumerable by 404-vs-302, so not-advertised is thin cover.

The dry-run flow is the legitimate way to exercise a draft, and it must
keep working — that exemption is tested here too, because a fix that
quietly broke rehearsal would push operators to publish untested
providers, which is worse than what it replaced.
"""
from __future__ import annotations

import pytest

from backend.auth_service.providers.registry import (
    ProviderConfigSnapshot,
    ProviderDisabled,
    ProviderNotFound,
    ProviderNotPublished,
    ProviderRegistry,
)


def _snap(**over) -> ProviderConfigSnapshot:
    fields = dict(
        id="idp_1", slug="corp-oidc", display_name="Corp",
        kind="oidc", enabled=True, priority=100,
        settings={}, claim_mapping={}, linking_policy="strict",
        button_label=None, button_icon=None, lifecycle="live",
    )
    fields.update(over)
    return ProviderConfigSnapshot(**fields)


class _Loader:
    def __init__(self, snap):
        self._snap = snap

    async def get_by_id(self, provider_id):
        return self._snap if self._snap.id == provider_id else None

    async def get_by_slug(self, slug):
        return self._snap if self._snap.slug == slug else None

    async def list_enabled(self):
        return [self._snap]


def _registry(snap) -> ProviderRegistry:
    return ProviderRegistry(
        loader=_Loader(snap),
        builders={"oidc": lambda s: object()},
    )


async def test_a_draft_provider_cannot_be_resolved_by_slug():
    reg = _registry(_snap(lifecycle="draft"))
    with pytest.raises(ProviderNotPublished):
        await reg.resolve_slug("corp-oidc")


async def test_a_draft_provider_cannot_be_built():
    reg = _registry(_snap(lifecycle="draft"))
    with pytest.raises(ProviderNotPublished):
        await reg.get("idp_1")


async def test_the_refusal_reads_as_not_found_to_a_route():
    """404, not 403 — a draft's existence stays private."""
    reg = _registry(_snap(lifecycle="draft"))
    with pytest.raises(ProviderNotFound):
        await reg.get("idp_1")


async def test_a_published_provider_still_resolves():
    reg = _registry(_snap(lifecycle="live"))
    assert await reg.resolve_slug("corp-oidc") == "idp_1"
    assert await reg.get("idp_1") is not None


async def test_the_dry_run_may_still_exercise_a_draft():
    """Rehearsal is why drafts exist; it opts in explicitly."""
    reg = _registry(_snap(lifecycle="draft"))
    assert await reg.resolve_slug("corp-oidc", allow_draft=True) == "idp_1"
    assert await reg.get("idp_1", allow_draft=True) is not None
    snap = await reg.get_snapshot("idp_1", allow_draft=True)
    assert snap.lifecycle == "draft"


async def test_disabled_still_wins_over_the_dry_run_exemption():
    """``allow_draft`` relaxes publication, not the kill switch."""
    reg = _registry(_snap(lifecycle="draft", enabled=False))
    with pytest.raises(ProviderDisabled):
        await reg.get("idp_1", allow_draft=True)


async def test_a_cached_provider_stops_working_when_unpublished():
    """The 60s cache must not keep a withdrawn provider alive.

    An operator un-publishing a provider is reacting to something. A
    cached instance that keeps authenticating for the rest of the TTL
    turns an immediate action into a delayed one.
    """
    snap = _snap(lifecycle="live")
    reg = _registry(snap)
    assert await reg.get("idp_1") is not None       # warm the cache

    reg._cache["idp_1"].snapshot = _snap(lifecycle="draft")
    with pytest.raises(ProviderNotPublished):
        await reg.get("idp_1")


async def test_lifecycle_defaults_to_live_for_callers_that_predate_it():
    """The env boot-seeder and older tests construct snapshots without it."""
    snap = ProviderConfigSnapshot(
        id="idp_2", slug="seeded", display_name="Seeded", kind="oidc",
        enabled=True, priority=100, settings={}, claim_mapping={},
        linking_policy="strict", button_label=None, button_icon=None,
    )
    assert snap.lifecycle == "live"
    assert await _registry(snap).resolve_slug("seeded") == "idp_2"
