"""Our session must not outlive the enterprise session that created it.

Every other SSO kind mints a session and then stops asking. The IdP can
revoke the user thirty seconds later and we will keep rotating their
refresh token for a week, because nothing on the refresh path ever
speaks to the IdP again. That is the same gap that makes single logout
hard, and it is the gap this check closes: a ``backchannel`` session
carries an ambient token on every request, so every rotation can
re-confirm it.

The whole design is in telling three answers apart, and the tests are
organised around that:

* **the ambient token is gone** — the user signed out upstream; costs no
  network call;
* **the IdP says no** — authoritative, end the session;
* **the IdP did not say** — a timeout or a 5xx is NOT a verdict.
  Treating it as one would turn a gateway blip into a platform-wide
  logout at the next rotation. So it is allowed through, but only while
  the last SUCCESSFUL confirmation is inside the grace window — an
  outage spends the allowance down rather than renewing it.

The last property is the subtle one, and the reason ``idp_checked_at``
is written on success only.
"""
from __future__ import annotations

import time

import pytest

from backend.auth_service.core import tokens as token_module
from backend.auth_service.interface import SsoReauthRequired
from backend.auth_service.providers import registry as registry_mod
from backend.auth_service.providers.backchannel import (
    BackchannelProvider,
    BackchannelSettings,
    BackchannelUnavailable,
    SessionRevokedUpstream,
)
from backend.auth_service.service import LocalIdentityService
from backend.tests.common.refresh_store import InMemoryRefreshStore
from backend.tests.test_sso_phase2 import (
    _StubUserRepo,
    _StubUserIdentityRepo,
    _session_factory,
)

PROVIDER_ID = "idp_backchannel"
GRACE = 900


# ── stand-ins ────────────────────────────────────────────────────────

class _Probe(BackchannelProvider):
    """A back-channel provider whose one outbound call is scripted."""

    def __init__(self, *, outcome="ok", **over):
        fields = dict(
            provider_id=PROVIDER_ID, provider_slug="corp",
            token_source="cookie", token_source_key="corp_session",
            gateway_url="https://gw.corp.example/redeem",
            liveness_grace_seconds=GRACE,
        )
        fields.update(over)
        settings = BackchannelSettings(**fields)
        super().__init__(settings)
        self._outcome = outcome
        self.calls = 0

    async def confirm_still_authenticated(self, ambient_token: str) -> None:
        self.calls += 1
        if self._outcome == "revoked":
            raise SessionRevokedUpstream("idp_rejected:401")
        if self._outcome == "unavailable":
            raise BackchannelUnavailable("idp_status:503")
        if self._outcome == "boom":
            raise RuntimeError("a provider bug")


class _OtherKindProvider:
    """Anything that is not a BackchannelProvider — an OIDC row, say."""


@pytest.fixture
def registry(monkeypatch):
    """Install a registry that hands back whatever a test puts in it."""
    class _Registry:
        def __init__(self):
            self.providers: dict = {}
            self.missing = False

        async def get(self, provider_id, **_kw):
            if self.missing or provider_id not in self.providers:
                raise registry_mod.ProviderNotFound(provider_id)
            return self.providers[provider_id]

    reg = _Registry()
    monkeypatch.setattr(registry_mod, "_REGISTRY", reg)
    return reg


def _session(store, *, provider_id=PROVIDER_ID, checked_at=None,
             auth_time=None):
    """Mint a refresh token AND the row that licenses it."""
    auth_time = auth_time if auth_time is not None else int(time.time())
    token, claims = token_module.create_refresh_token(
        user_id="usr_1", family_id="fam1", auth_time=auth_time,
    )
    return token, claims, store.record_mint(
        jti=claims.jti, family_id="fam1", user_id="usr_1",
        auth_time=auth_time, mint_ms=claims.mint_ms,
        expires_at_iso="2099-01-01T00:00:00+00:00",
        idp_provider_id=provider_id, idp_checked_at=checked_at,
    )


def _service(store, killed=None):
    async def _killer(uid):
        (killed if killed is not None else []).append(uid)

    return LocalIdentityService(
        session_factory=_session_factory,
        user_repo=_StubUserRepo(),
        user_identity_repo=_StubUserIdentityRepo(has_identity=True),
        refresh_store_factory=lambda s: store,
        session_killer=_killer,
    )


async def _mint(store, **kw):
    token, claims, coro = _session(store, **kw)
    await coro
    return token, claims


COOKIES = {"corp_session": "ambient-xyz"}


# ── the ambient token is gone ────────────────────────────────────────

@pytest.mark.asyncio
async def test_deleting_the_ambient_cookie_ends_the_session(registry):
    """The point of the whole feature, from the user's side: sign out of
    the corporate portal and this app follows on the next rotation."""
    registry.providers[PROVIDER_ID] = probe = _Probe()
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))
    killed: list[str] = []

    with pytest.raises(SsoReauthRequired):
        await _service(store, killed).refresh(token, ambient_cookies={})

    assert probe.calls == 0, "no network call needed to notice an absent cookie"
    assert store.revoked_family == "fam1"
    assert killed == ["usr_1"]


@pytest.mark.asyncio
async def test_the_bounce_target_is_the_users_provider(registry):
    registry.providers[PROVIDER_ID] = _Probe()
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    with pytest.raises(SsoReauthRequired) as err:
        await _service(store).refresh(token, ambient_cookies={})
    assert "/login" in err.value.login_url


# ── the IdP says no ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_upstream_rejection_ends_the_session(registry):
    registry.providers[PROVIDER_ID] = _Probe(outcome="revoked")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))
    killed: list[str] = []

    with pytest.raises(SsoReauthRequired):
        await _service(store, killed).refresh(token, ambient_cookies=COOKIES)
    assert store.revoked_family == "fam1"
    assert killed == ["usr_1"]


@pytest.mark.asyncio
async def test_a_rejection_ends_the_session_even_inside_the_grace_window(
    registry,
):
    """The grace window forgives silence, not a verdict."""
    registry.providers[PROVIDER_ID] = _Probe(outcome="revoked")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    with pytest.raises(SsoReauthRequired):
        await _service(store).refresh(token, ambient_cookies=COOKIES)


# ── the IdP did not say ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_outage_inside_the_grace_window_lets_the_refresh_through(
    registry,
):
    """A gateway blip must not sign out every enterprise user at once."""
    registry.providers[PROVIDER_ID] = _Probe(outcome="unavailable")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()) - 60)

    user, _tokens = await _service(store).refresh(
        token, ambient_cookies=COOKIES,
    )
    assert user.id == "usr_1"
    assert store.revoked_family is None


@pytest.mark.asyncio
async def test_an_outage_does_not_advance_the_anchor(registry):
    """The property the grace window depends on. If a failed probe moved
    ``idp_checked_at``, every rotation would renew the allowance and a
    permanently-dead gateway would keep sessions alive forever — the
    window would measure "time since we last tried" instead of "time
    since we last knew"."""
    registry.providers[PROVIDER_ID] = _Probe(outcome="unavailable")
    store = InMemoryRefreshStore()
    anchor = int(time.time()) - 60
    token, claims = await _mint(store, checked_at=anchor)

    await _service(store).refresh(token, ambient_cookies=COOKIES)

    successor_jti = store.records[claims.jti].successor_jti
    assert store.records[successor_jti].idp_checked_at == anchor


@pytest.mark.asyncio
async def test_an_outage_past_the_grace_window_ends_the_session(registry):
    """So an outage spends the allowance down rather than being an
    indefinite pass."""
    registry.providers[PROVIDER_ID] = _Probe(outcome="unavailable")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()) - GRACE - 60)

    with pytest.raises(SsoReauthRequired):
        await _service(store).refresh(token, ambient_cookies=COOKIES)
    assert store.revoked_family == "fam1"


@pytest.mark.asyncio
async def test_a_session_never_confirmed_gets_no_free_pass(registry):
    """A NULL anchor is not an infinite allowance. It would hand the
    longest grace to exactly the sessions we know least about."""
    registry.providers[PROVIDER_ID] = _Probe(outcome="unavailable")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=None)

    with pytest.raises(SsoReauthRequired):
        await _service(store).refresh(token, ambient_cookies=COOKIES)


@pytest.mark.asyncio
async def test_a_provider_that_raises_unexpectedly_is_treated_as_an_outage(
    registry,
):
    """A bug in the provider is not a statement about the user."""
    registry.providers[PROVIDER_ID] = _Probe(outcome="boom")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()) - 60)

    user, _tokens = await _service(store).refresh(
        token, ambient_cookies=COOKIES,
    )
    assert user.id == "usr_1"


# ── the IdP says yes ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_confirmed_session_rotates_and_advances_the_anchor(registry):
    registry.providers[PROVIDER_ID] = probe = _Probe()
    store = InMemoryRefreshStore()
    before = int(time.time()) - 600
    token, claims = await _mint(store, checked_at=before)

    user, _tokens = await _service(store).refresh(
        token, ambient_cookies=COOKIES,
    )
    assert user.id == "usr_1"
    assert probe.calls == 1

    successor_jti = store.records[claims.jti].successor_jti
    assert store.records[successor_jti].idp_checked_at > before


@pytest.mark.asyncio
async def test_the_anchor_is_stamped_on_the_successor_not_the_spent_token(
    registry,
):
    """The user is about to start using the successor. Stamping the row
    they just spent would leave the new token with a stale anchor and
    shorten its grace window for no reason."""
    registry.providers[PROVIDER_ID] = _Probe()
    store = InMemoryRefreshStore()
    before = int(time.time()) - 600
    token, claims = await _mint(store, checked_at=before)

    await _service(store).refresh(token, ambient_cookies=COOKIES)
    assert store.records[claims.jti].idp_checked_at == before


@pytest.mark.asyncio
async def test_the_provider_reads_the_token_from_a_header_when_configured(
    registry,
):
    registry.providers[PROVIDER_ID] = probe = _Probe(
        token_source="header", token_source_key="X-Corp-Session",
    )
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    await _service(store).refresh(
        token,
        ambient_cookies={},                      # not where it lives
        ambient_headers={"X-Corp-Session": "ambient-xyz"},
    )
    assert probe.calls == 1


@pytest.mark.asyncio
async def test_the_header_lookup_survives_starlette_lower_casing(registry):
    """The refresh route hands the service ``dict(request.headers)``,
    and Starlette lower-cases every key in it. The operator typed
    ``X-Corp-Session``. Header names are case-insensitive on the wire,
    so those must match — the regression was a case-sensitive ``.get``
    that read every refresh as "the corporate session is gone" and
    revoked a perfectly healthy family once per access lifetime.
    """
    registry.providers[PROVIDER_ID] = probe = _Probe(
        token_source="header", token_source_key="X-Corp-Session",
    )
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    user, _tokens = await _service(store).refresh(
        token,
        ambient_cookies={},
        ambient_headers={"x-corp-session": "ambient-xyz"},   # as Starlette
    )
    assert probe.calls == 1
    assert user.id == "usr_1"


# ── who is NOT probed ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_local_session_is_never_probed(registry):
    """No provider on the row, so there is nothing to ask and no cookie
    to miss."""
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, provider_id=None, auth_time=None)

    user, _tokens = await _service(store).refresh(token, ambient_cookies={})
    assert user.id == "usr_1"


@pytest.mark.asyncio
async def test_another_kind_of_sso_session_is_never_probed(registry):
    """The reason the provider lives on the refresh row rather than
    being looked up from ``user_identities``: a user can hold several
    identities, and an OIDC session has no ambient token to present.
    Probing it would sign them out for failing a test that does not
    apply to them."""
    registry.providers["idp_oidc"] = _OtherKindProvider()
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, provider_id="idp_oidc")

    user, _tokens = await _service(store).refresh(token, ambient_cookies={})
    assert user.id == "usr_1"


@pytest.mark.asyncio
async def test_a_row_with_no_ambient_source_is_not_probed(registry):
    """"I have no way to check" is not "I checked and the answer was no".

    A connection whose session is delivered to the page rather than
    carried on requests names no cookie. The check read that empty name,
    got nothing back, and concluded the upstream session had been
    revoked — revoking the refresh family and killing every live session
    for a user who had done nothing wrong, once per access-token
    lifetime, forever.

    Sign-in worked, so nothing looked broken until the first refresh.
    """
    registry.providers[PROVIDER_ID] = probe = _Probe(token_source_key="")
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))
    killed: list[str] = []

    user, _tokens = await _service(store, killed).refresh(
        token, ambient_cookies={}, ambient_headers={},
    )
    assert user.id == "usr_1"
    assert probe.calls == 0, "there was nothing to ask"
    assert store.revoked_family is None, "the family was killed"
    assert killed == [], "live sessions were killed"


@pytest.mark.asyncio
async def test_an_operator_can_turn_the_check_off(registry):
    registry.providers[PROVIDER_ID] = probe = _Probe(
        liveness_on_refresh=False,
    )
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    user, _tokens = await _service(store).refresh(token, ambient_cookies={})
    assert user.id == "usr_1"
    assert probe.calls == 0


@pytest.mark.asyncio
async def test_a_deleted_provider_row_does_not_end_live_sessions(registry):
    """Disabling a provider is an operator statement about future
    logins. Turning it into a mass logout would be a revocation trigger
    nobody asked for, and one that fires on an ordinary config edit."""
    registry.missing = True
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    user, _tokens = await _service(store).refresh(token, ambient_cookies={})
    assert user.id == "usr_1"


@pytest.mark.asyncio
async def test_a_caller_that_forwards_nothing_is_treated_as_signed_out(
    registry,
):
    """``refresh()`` defaults both carriers to None so existing callers
    are unchanged. For a back-channel session that has to read as "no
    ambient token" — the failure direction where a caller that forgets
    to forward gets a re-auth prompt rather than a free pass."""
    registry.providers[PROVIDER_ID] = _Probe()
    store = InMemoryRefreshStore()
    token, _ = await _mint(store, checked_at=int(time.time()))

    with pytest.raises(SsoReauthRequired):
        await _service(store).refresh(token)
