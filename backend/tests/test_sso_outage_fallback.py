"""SSO-first with a secure password fallback when the IdP goes down.

Pins the rules the automatic fallback rests on:

* the prober confirms an outage only for a connection it has seen working,
  after three minutes of failure on fresh evidence, and ends it only after
  five minutes of health (``services/idp_reachability.py``);
* while passwords are off, a password works for break-glass accounts
  always, for Super Admins during a confirmed outage, and for everyone
  while an admin's emergency window is open — and every other account gets
  the answer a wrong password gets;
* sessions opened that way end at their first renewal once their door has
  closed, and SSO sessions ride through their daily re-authentication while
  their identity provider is confirmed down;
* the admin surfaces and the host recovery script that operate all this.
"""
from __future__ import annotations

import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from backend.app.db import models as m
from backend.app.db.repositories import (
    binding_repo, idp_provider_repo, user_identity_repo, user_repo,
)
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.app.services import idp_reachability as reach
from backend.auth_service.app_auth_config import (
    AuthConfigSnapshot,
    StaticAuthConfigProvider,
    password_access,
)
from backend.auth_service.core import tokens as token_module
from backend.auth_service.core.config import SSO_SESSION_MAX_AGE_SECONDS
from backend.auth_service.core.password import hash_password
from backend.auth_service.interface import InvalidCredentials, SsoReauthRequired
from backend.auth_service.service import LocalIdentityService
from tests.common.refresh_store import InMemoryRefreshStore

T0 = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)
PASSWORD = "s3cret-Pass!42"


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _row(**fields) -> SimpleNamespace:
    base = {
        "last_ok_at": None, "unreachable_since": None,
        "recovering_since": None, "checked_at": None, "detail": None,
    }
    base.update(fields)
    return SimpleNamespace(**base)


def _step(prev, ok, at: datetime) -> SimpleNamespace:
    return SimpleNamespace(**reach.next_state(prev, ok, at, "probe"))


# ── What counts as a confirmed outage ────────────────────────────────


def test_a_connection_never_seen_working_is_never_confirmed_down():
    """A probe that cannot succeed from where it runs — a CA bundle or a
    network path the control plane lacks — must not read as an outage."""
    row = None
    for minute in range(10):
        row = _step(row, False, T0 + timedelta(minutes=minute))
    assert row.last_ok_at is None
    assert not reach.outage_confirmed(row, T0 + timedelta(minutes=9))


def test_confirmed_after_three_minutes_of_failure():
    row = _step(None, True, T0)
    for minute in range(1, 4):
        row = _step(row, False, T0 + timedelta(minutes=minute))
        # The streak began at minute 1.
        confirmed = reach.outage_confirmed(row, T0 + timedelta(minutes=minute))
        assert confirmed is False
    row = _step(row, False, T0 + timedelta(minutes=4))
    assert reach.outage_confirmed(row, T0 + timedelta(minutes=4))


def test_stale_evidence_confirms_nothing():
    row = _row(
        last_ok_at=_iso(T0), unreachable_since=_iso(T0 + timedelta(minutes=1)),
        checked_at=_iso(T0 + timedelta(minutes=10)),
    )
    assert reach.outage_confirmed(row, T0 + timedelta(minutes=10))
    # The prober stopped: ten minutes without a probe means nothing.
    assert not reach.outage_confirmed(row, T0 + timedelta(minutes=20))


def test_a_gap_starts_the_streak_afresh():
    """A connection disabled for a week and re-enabled must not come back
    with a week-old outage already confirmed."""
    old = _row(
        last_ok_at=_iso(T0 - timedelta(days=7, minutes=5)),
        unreachable_since=_iso(T0 - timedelta(days=7)),
        checked_at=_iso(T0 - timedelta(days=7)),
    )
    row = _step(old, False, T0)
    assert row.unreachable_since == _iso(T0)
    assert not reach.outage_confirmed(row, T0)


def test_a_short_blip_clears_on_the_next_success():
    row = _step(None, True, T0)
    row = _step(row, False, T0 + timedelta(minutes=1))
    row = _step(row, True, T0 + timedelta(minutes=2))
    assert row.unreachable_since is None
    assert row.recovering_since is None


def test_recovery_needs_five_minutes_of_health():
    row = _step(None, True, T0)
    for minute in range(1, 6):
        row = _step(row, False, T0 + timedelta(minutes=minute))
    assert reach.outage_confirmed(row, T0 + timedelta(minutes=5))

    for minute in range(6, 11):
        row = _step(row, True, T0 + timedelta(minutes=minute))
        assert reach.outage_confirmed(row, T0 + timedelta(minutes=minute)), minute
    row = _step(row, True, T0 + timedelta(minutes=11))
    assert not reach.outage_confirmed(row, T0 + timedelta(minutes=11))
    assert row.unreachable_since is None


def test_a_failure_during_recovery_starts_recovery_again():
    row = _step(None, True, T0)
    for minute in range(1, 6):
        row = _step(row, False, T0 + timedelta(minutes=minute))
    for minute in range(6, 10):
        row = _step(row, True, T0 + timedelta(minutes=minute))
    row = _step(row, False, T0 + timedelta(minutes=10))
    assert row.recovering_since is None
    for minute in range(11, 16):
        row = _step(row, True, T0 + timedelta(minutes=minute))
    # Recovery restarted at minute 11, so minute 15 is still inside it.
    assert reach.outage_confirmed(row, T0 + timedelta(minutes=15))


def test_a_result_that_cannot_be_judged_never_counts():
    """A policy refusal or a missing endpoint is not an outage."""
    row = _step(None, True, T0)
    row = _step(row, False, T0 + timedelta(minutes=1))
    row = _step(row, None, T0 + timedelta(minutes=5))
    assert row.unreachable_since is None
    assert not reach.outage_confirmed(row, T0 + timedelta(minutes=5))


# ── The prober's pass ────────────────────────────────────────────────


def _factory(session):
    @asynccontextmanager
    async def factory():
        yield session
    return factory


async def _connection(session, slug, *, kind="oidc", live=True, enabled=True):
    settings = {
        "oidc": {"issuer": f"https://{slug}.example"},
        "backchannel": {"gateway_url": f"https://{slug}.internal/redeem"},
    }.get(kind, {"idp_sso_url": f"https://{slug}.example/sso"})
    row = m.IdpProviderORM(
        id=f"idp_{slug}", slug=slug, display_name=slug.title(), kind=kind,
        enabled=enabled, lifecycle="live" if live else "draft",
        settings=idp_provider_repo.encrypt_settings(settings),
    )
    session.add(row)
    await session.flush()
    return row


async def _outbox(session, event_type):
    rows = await session.execute(
        select(m.OutboxEventORM).where(m.OutboxEventORM.event_type == event_type)
    )
    return rows.scalars().all()


@pytest.mark.asyncio
async def test_the_prober_detects_and_resolves_an_outage_once(db_session, monkeypatch):
    await _connection(db_session, "entra")
    await _connection(db_session, "drafty", live=False)
    await _connection(db_session, "portal", kind="custom_profile")
    script = {"ok": True}
    probed: list[str] = []

    async def fake_probe(kind, settings, allow_hosts=frozenset()):
        probed.append(settings.get("issuer") or settings.get("idp_sso_url") or kind)
        return script["ok"], "scripted"

    clock = {"now": T0}
    monkeypatch.setattr(reach, "probe", fake_probe)
    monkeypatch.setattr(reach, "_now", lambda: clock["now"])

    async def pass_at(minute, ok):
        clock["now"] = T0 + timedelta(minutes=minute)
        script["ok"] = ok
        return await reach.probe_once(_factory(db_session))

    # Only the live, enabled OIDC/SAML connection is probed.
    assert await pass_at(0, True) == 1
    assert probed == ["https://entra.example"]

    for minute in range(1, 6):
        await pass_at(minute, False)
    assert len(await _outbox(db_session, "idp.outage.detected")) == 1
    assert await reach.confirmed_outage(db_session) == (
        ("entra",), _iso(T0 + timedelta(minutes=1)),
    )

    for minute in range(6, 12):
        await pass_at(minute, True)
    resolved = await _outbox(db_session, "idp.outage.resolved")
    assert len(resolved) == 1
    assert len(await _outbox(db_session, "idp.outage.detected")) == 1
    assert await reach.confirmed_outage(db_session) == ((), None)


@pytest.mark.asyncio
async def test_the_prober_does_nothing_while_sso_is_off(db_session, monkeypatch):
    from backend.app.db.repositories import app_auth_config_repo
    await _connection(db_session, "entra")
    await app_auth_config_repo.update_config(db_session, sso_enabled=False)

    async def fake_probe(kind, settings, allow_hosts=frozenset()):  # pragma: no cover — must not run
        raise AssertionError("probed while SSO is off")

    monkeypatch.setattr(reach, "probe", fake_probe)
    assert await reach.probe_once(_factory(db_session)) == 0


# ── Enterprise gateway (back-channel) connections ────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("answer, ok", [(401, True), (405, True), (503, False)])
async def test_a_server_mode_gateway_is_up_on_any_answer_below_500(
    monkeypatch, answer, ok,
):
    """Asked with no session handle, a healthy gateway says 401 or 405."""
    from backend.auth_service.providers import outbound
    seen = {}

    async def fake_fetch_status(url, *, timeout, allow_hosts=frozenset(), verify=None):
        seen.update(url=url, allow_hosts=allow_hosts, verify=verify)
        return answer

    monkeypatch.setattr(outbound, "fetch_status", fake_fetch_status)
    result, detail = await reach.probe(
        "backchannel",
        {"gateway_url": "https://gw.corp.internal:8443/redeem", "tls_verify": False},
        frozenset({"gw.corp.internal:8443"}),
    )
    assert (result, detail) == (ok, f"Gateway answered {answer}.")
    # Through the operator's allowlist and the row's TLS opt-out, as the
    # sign-in calls go.
    assert seen == {
        "url": "https://gw.corp.internal:8443/redeem",
        "allow_hosts": frozenset({"gw.corp.internal:8443"}),
        "verify": False,
    }


@pytest.mark.asyncio
async def test_a_browser_mode_gateway_is_never_probed(monkeypatch):
    """Browsers call it, not the server, which cannot speak for them."""
    from backend.auth_service.providers import outbound

    async def must_not_run(*a, **k):  # pragma: no cover — must not run
        raise AssertionError("probed a gateway only browsers call")

    monkeypatch.setattr(outbound, "fetch_status", must_not_run)
    result, _ = await reach.probe("backchannel", {
        "exchange_mode": "browser", "gateway_url": "https://gw.corp.example/redeem",
    })
    assert result is None


@pytest.mark.asyncio
async def test_a_gateway_outside_the_allowlist_is_no_evidence():
    """A private address nobody allowlisted is refused before any request —
    policy, not an outage, so it never counts."""
    result, detail = await reach.probe(
        "backchannel", {"gateway_url": "https://10.20.30.40:8443/redeem"},
    )
    assert result is None
    assert detail.startswith("Not probed:")


@pytest.mark.asyncio
async def test_the_prober_probes_gateways_through_the_allowlist(db_session, monkeypatch):
    from backend.app.db.repositories import backchannel_host_repo
    await _connection(db_session, "corp", kind="backchannel")
    await backchannel_host_repo.add_host(db_session, host="corp.internal", port=443)
    calls = []

    async def fake_probe(kind, settings, allow_hosts=frozenset()):
        calls.append((kind, settings["gateway_url"], allow_hosts))
        return True, "scripted"

    monkeypatch.setattr(reach, "probe", fake_probe)
    assert await reach.probe_once(_factory(db_session)) == 1
    assert calls == [(
        "backchannel", "https://corp.internal/redeem",
        frozenset({"corp.internal:443"}),
    )]


@pytest.mark.asyncio
async def test_a_failing_outage_read_means_no_outage():
    """The posture loader's failsafe opens passwords; a broken outage read
    must answer "no outage", never fail the posture read."""
    @asynccontextmanager
    async def broken():
        raise RuntimeError("database away")
        yield  # pragma: no cover

    assert await reach.read_confirmed_outage(broken) == ((), None)


@pytest.mark.asyncio
async def test_status_reports_stale_detection_when_nothing_has_run(db_session):
    await _connection(db_session, "entra")
    report = await reach.status(db_session)
    assert report == {"checked_at": None, "stale": True, "outage": None}


# ── Who may use a password ───────────────────────────────────────────


def _snapshot(**over) -> AuthConfigSnapshot:
    base = dict(
        sso_enabled=True, allow_local_login=False, allow_jit_provisioning=True,
        version=1, updated_at="2026-01-01T00:00:00Z",
    )
    base.update(over)
    return AuthConfigSnapshot(**base)


def _window(hours=4) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def test_password_access_by_posture():
    assert password_access(_snapshot(allow_local_login=True)) == "everyone"
    assert password_access(_snapshot()) == "break_glass"
    assert password_access(_snapshot(sso_outage_slugs=("entra",))) == "administrators"
    assert password_access(_snapshot(password_fallback_until=_window())) == "everyone"
    # A lapsed or unreadable window is closed.
    assert password_access(_snapshot(password_fallback_until=_window(-1))) == "break_glass"
    assert password_access(_snapshot(password_fallback_until="soon")) == "break_glass"


def _login_svc(db_session, snapshot):
    events: list[tuple[str, dict]] = []

    async def outbox(session, event_type, payload):
        events.append((event_type, payload))

    async def is_super_admin(session, user_id):
        return user_id in await binding_repo.super_admin_user_ids(session)

    svc = LocalIdentityService(
        session_factory=_factory(db_session),
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=make_refresh_store,
        outbox_emit=outbox,
        super_admin_checker=is_super_admin,
        auth_config_provider=StaticAuthConfigProvider(snapshot),
    )
    return svc, events


async def _account(db_session, email, *, super_admin=False, system=False):
    user = await user_repo.create_user(
        db_session, email=email, password_hash=hash_password(PASSWORD),
        first_name="A", last_name="B", status="active",
    )
    if system:
        await user_repo.set_system_account(db_session, user.id, True)
    if super_admin:
        db_session.add(m.RoleBindingORM(
            id=f"bnd_{user.id}", subject_type="user", subject_id=user.id,
            role_name="super_admin", scope_type="global", scope_id=None,
            granted_at="2024-01-01T00:00:00Z", source="local",
        ))
    await db_session.flush()
    return user


def _pwfb(tokens) -> int | None:
    return token_module.decode_refresh_token(tokens.refresh_token).pwfb


def _logged_in(events):
    return [p for t, p in events if t == "user.logged_in"]


@pytest.mark.asyncio
async def test_during_an_outage_a_super_admin_gets_in_and_others_do_not(db_session):
    svc, events = _login_svc(db_session, _snapshot(sso_outage_slugs=("entra",)))
    await _account(db_session, "admin@corp.com", super_admin=True)
    await _account(db_session, "member@corp.com")

    _user, tokens = await svc.login("admin@corp.com", PASSWORD)
    assert _logged_in(events)[-1]["via"] == "admin_fallback"
    # Marked: ends once the outage does, and within a day regardless.
    assert abs(_pwfb(tokens) - (time.time() + SSO_SESSION_MAX_AGE_SECONDS)) < 60

    with pytest.raises(InvalidCredentials):
        await svc.login("member@corp.com", PASSWORD)
    refused = [p for t, p in events if t == "user.login_failed"][-1]
    assert refused["reason"] == "local_login_disabled"


@pytest.mark.asyncio
async def test_without_an_outage_a_super_admin_is_refused_like_anyone(db_session):
    svc, _ = _login_svc(db_session, _snapshot())
    await _account(db_session, "admin@corp.com", super_admin=True)
    with pytest.raises(InvalidCredentials):
        await svc.login("admin@corp.com", PASSWORD)


@pytest.mark.asyncio
async def test_the_emergency_window_opens_passwords_to_everyone(db_session):
    svc, events = _login_svc(
        db_session, _snapshot(password_fallback_until=_window()),
    )
    await _account(db_session, "member@corp.com")
    await _account(db_session, "ops@corp.com", super_admin=True, system=True)

    _user, tokens = await svc.login("member@corp.com", PASSWORD)
    assert _logged_in(events)[-1]["via"] == "emergency_window"
    assert _pwfb(tokens) is not None

    # Break-glass is never treated as an emergency session.
    _user, tokens = await svc.login("ops@corp.com", PASSWORD)
    assert _logged_in(events)[-1]["via"] == "break_glass"
    assert _pwfb(tokens) is None


@pytest.mark.asyncio
async def test_a_lapsed_window_opens_nothing(db_session):
    svc, _ = _login_svc(db_session, _snapshot(password_fallback_until=_window(-1)))
    await _account(db_session, "member@corp.com")
    with pytest.raises(InvalidCredentials):
        await svc.login("member@corp.com", PASSWORD)


@pytest.mark.asyncio
async def test_with_passwords_on_nothing_is_marked(db_session):
    svc, events = _login_svc(db_session, _snapshot(allow_local_login=True))
    await _account(db_session, "member@corp.com")
    _user, tokens = await svc.login("member@corp.com", PASSWORD)
    assert "via" not in _logged_in(events)[-1]
    assert _pwfb(tokens) is None


# ── Renewing sessions while SSO is down ──────────────────────────────


class _Users:
    def __init__(self, *, is_super_admin=False):
        self.user = SimpleNamespace(
            id="usr_1", email="alice@example.com", first_name="Alice",
            last_name="Doe", status="active", deleted_at=None,
            created_at="", updated_at="", metadata_="{}",
            password_hash="argon2-hash", is_system_account=False,
            must_change_password=False,
        )
        self.is_super_admin = is_super_admin

    async def get_user_by_id(self, session, uid):
        return self.user if uid == "usr_1" else None

    async def get_user_roles(self, session, uid):
        return ["workspace_member"]


class _Identities:
    def __init__(self, linked=True):
        self.linked = linked

    async def list_for_user(self, session, user_id):
        if not self.linked:
            return []
        return [SimpleNamespace(
            id="uid_1", provider_id="idp_entra",
            provider=SimpleNamespace(slug="entra"),
            last_login_at="2026-05-20T00:00:00Z",
        )]

    async def touch_last_login(self, session, identity_id, *, metadata=None):
        pass


class _NoSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


async def _mint(store, **kwargs):
    token, claims = token_module.create_refresh_token(user_id="usr_1", **kwargs)
    await store.record_mint(
        jti=claims.jti, family_id=claims.family_id, user_id=claims.sub,
        auth_time=claims.auth_time, mint_ms=claims.mint_ms,
        expires_at_iso=datetime.fromtimestamp(
            claims.exp, tz=timezone.utc,
        ).isoformat(),
        idp_provider_id=kwargs.pop("idp_provider_id", None),
    )
    return token


def _refresh_svc(store, snapshot, *, linked=True, super_admin=False, events=None):
    users = _Users(is_super_admin=super_admin)

    async def is_super_admin(session, user_id):
        return users.is_super_admin

    async def outbox(session, event_type, payload):
        events.append((event_type, payload))

    return LocalIdentityService(
        session_factory=_NoSession,
        user_repo=users,
        user_identity_repo=_Identities(linked=linked),
        refresh_store_factory=lambda s: store,
        super_admin_checker=is_super_admin,
        auth_config_provider=StaticAuthConfigProvider(snapshot),
        outbox_emit=outbox if events is not None else None,
    )


def _deadline(seconds=SSO_SESSION_MAX_AGE_SECONDS) -> int:
    return int(time.time()) + seconds


@pytest.mark.asyncio
async def test_an_emergency_session_renews_while_its_window_is_open():
    store = InMemoryRefreshStore()
    deadline = _deadline()
    rt = await _mint(store, family_id="fam1", pwfb=deadline)
    svc = _refresh_svc(store, _snapshot(password_fallback_until=_window()))

    _user, tokens = await svc.refresh(rt)

    # The deadline rides every rotation unchanged.
    assert _pwfb(tokens) == deadline


@pytest.mark.asyncio
async def test_an_emergency_session_ends_through_sso_once_the_window_closes():
    store = InMemoryRefreshStore()
    rt = await _mint(store, family_id="fam1", pwfb=_deadline())
    svc = _refresh_svc(store, _snapshot())

    with pytest.raises(SsoReauthRequired) as exc:
        await svc.refresh(rt)

    # Back through the person's own connection, letting a warm IdP
    # session sign them straight back in.
    assert exc.value.login_url == "/api/v1/auth/entra/login?next=/"
    assert store.revoked_family == "fam1"


@pytest.mark.asyncio
async def test_with_the_idp_still_down_an_ended_session_goes_to_the_sign_in_page():
    store = InMemoryRefreshStore()
    rt = await _mint(store, family_id="fam1", pwfb=_deadline())
    svc = _refresh_svc(store, _snapshot(sso_outage_slugs=("entra",)))

    with pytest.raises(SsoReauthRequired) as exc:
        await svc.refresh(rt)
    assert exc.value.login_url == "/login?next=/"


@pytest.mark.asyncio
async def test_an_admin_fallback_session_lasts_while_the_outage_does():
    store = InMemoryRefreshStore()
    rt = await _mint(store, family_id="fam1", pwfb=_deadline())
    svc = _refresh_svc(
        store, _snapshot(sso_outage_slugs=("entra",)), super_admin=True,
    )
    _user, tokens = await svc.refresh(rt)
    assert _pwfb(tokens) is not None


@pytest.mark.asyncio
async def test_an_emergency_session_never_outlives_its_deadline():
    store = InMemoryRefreshStore()
    rt = await _mint(store, family_id="fam1", pwfb=_deadline(-1))
    svc = _refresh_svc(store, _snapshot(password_fallback_until=_window()))

    with pytest.raises(SsoReauthRequired):
        await svc.refresh(rt)


@pytest.mark.asyncio
async def test_without_a_linked_identity_an_ended_session_goes_to_the_sign_in_page():
    store = InMemoryRefreshStore()
    rt = await _mint(store, family_id="fam1", pwfb=_deadline())
    svc = _refresh_svc(store, _snapshot(), linked=False)

    with pytest.raises(SsoReauthRequired) as exc:
        await svc.refresh(rt)
    assert exc.value.login_url == "/login?next=/"


@pytest.mark.asyncio
async def test_a_racing_tab_keeps_the_deadline():
    """The replay re-mint is the second place a successor is minted; a tab
    that loses the rotation race must not come away without the cap."""
    store = InMemoryRefreshStore()
    deadline = _deadline()
    rt = await _mint(store, family_id="fam1", pwfb=deadline)
    svc = _refresh_svc(store, _snapshot(password_fallback_until=_window()))

    _user, first = await svc.refresh(rt)
    _user, second = await svc.refresh(rt)  # inside the grace window

    assert _pwfb(first) == _pwfb(second) == deadline


@pytest.mark.asyncio
async def test_an_sso_session_rides_through_its_ceiling_while_its_idp_is_down():
    store = InMemoryRefreshStore()
    stale = int(time.time()) - (SSO_SESSION_MAX_AGE_SECONDS + 60)
    rt = await _mint(store, family_id="fam1", auth_time=stale)
    svc = _refresh_svc(store, _snapshot(sso_outage_slugs=("entra",)))

    user, _tokens = await svc.refresh(rt)
    assert user.id == "usr_1"


@pytest.mark.asyncio
async def test_a_ride_through_is_recorded_once_per_session():
    """The activity log gets one line per session kept past its daily
    re-authentication — on the first renewal past the ceiling — not one
    per renewal it rides through."""
    store = InMemoryRefreshStore()
    stale = int(time.time()) - (SSO_SESSION_MAX_AGE_SECONDS + 60)
    # The token being renewed was minted just before the ceiling.
    rt = await _mint(
        store, family_id="fam1", auth_time=stale,
        mint_ms=(stale + SSO_SESSION_MAX_AGE_SECONDS - 30) * 1000,
    )
    events: list[tuple[str, dict]] = []
    svc = _refresh_svc(store, _snapshot(sso_outage_slugs=("entra",)), events=events)

    _, tokens = await svc.refresh(rt)
    await svc.refresh(tokens.refresh_token)

    assert [p for t, p in events if t == "user.sso_reauth_deferred"] == [
        {"user_id": "usr_1", "provider_slug": "entra", "auth_time": stale},
    ]


@pytest.mark.asyncio
async def test_the_ride_through_lasts_one_extra_ceiling_at_most():
    store = InMemoryRefreshStore()
    stale = int(time.time()) - (2 * SSO_SESSION_MAX_AGE_SECONDS + 60)
    rt = await _mint(store, family_id="fam1", auth_time=stale)
    svc = _refresh_svc(store, _snapshot(sso_outage_slugs=("entra",)))

    with pytest.raises(SsoReauthRequired) as exc:
        await svc.refresh(rt)
    # Still down: the sign-in page, not the IdP that cannot answer.
    assert exc.value.login_url == "/login?next=/"


@pytest.mark.asyncio
async def test_a_healthy_idp_keeps_the_ceiling_exactly_as_before():
    store = InMemoryRefreshStore()
    stale = int(time.time()) - (SSO_SESSION_MAX_AGE_SECONDS + 60)
    rt = await _mint(store, family_id="fam1", auth_time=stale)
    svc = _refresh_svc(store, _snapshot(sso_outage_slugs=("okta",)))

    with pytest.raises(SsoReauthRequired) as exc:
        await svc.refresh(rt)
    assert exc.value.login_url == "/api/v1/auth/entra/login?next=/&force=1"


@pytest.mark.asyncio
async def test_an_ordinary_password_session_is_untouched():
    store = InMemoryRefreshStore()
    rt = await _mint(store, family_id="fam1")
    svc = _refresh_svc(store, _snapshot(sso_outage_slugs=("entra",)))
    user, tokens = await svc.refresh(rt)
    assert user.id == "usr_1"
    assert _pwfb(tokens) is None


# ── The public surface ───────────────────────────────────────────────


@pytest.fixture()
def posture(db_session):
    """Install a service whose posture is whatever the test sets."""
    from backend.app.main import app

    holder: dict = {}

    def install(snapshot):
        async def is_super_admin(session, user_id):
            return user_id in await binding_repo.super_admin_user_ids(session)

        holder["previous"] = getattr(app.state, "identity_service", None)
        app.state.identity_service = LocalIdentityService(
            session_factory=_factory(db_session),
            user_repo=user_repo,
            user_identity_repo=user_identity_repo,
            refresh_store_factory=make_refresh_store,
            super_admin_checker=is_super_admin,
            auth_config_provider=StaticAuthConfigProvider(snapshot),
        )

    yield install
    if "previous" in holder:
        app.state.identity_service = holder["previous"]


@pytest.mark.asyncio
async def test_login_context_announces_an_outage(test_client, posture):
    posture(_snapshot(sso_outage_slugs=("entra",), sso_outage_since=_iso(T0)))
    body = (await test_client.get("/api/v1/auth/login-context")).json()
    assert body["passwordAccess"] == "administrators"
    assert body["allowLocalLogin"] is False
    assert body["ssoOutage"] == {"since": _iso(T0), "providers": ["entra"]}
    assert body["passwordFallbackUntil"] is None


@pytest.mark.asyncio
async def test_login_context_reports_the_emergency_window(test_client, posture):
    until = _window()
    posture(_snapshot(password_fallback_until=until))
    body = (await test_client.get("/api/v1/auth/login-context")).json()
    assert body["passwordAccess"] == "everyone"
    assert body["allowLocalLogin"] is True
    assert body["passwordFallbackUntil"] == until


@pytest.mark.asyncio
async def test_a_refused_password_sign_in_is_the_wrong_password_answer(
    test_client, posture, db_session,
):
    posture(_snapshot())
    await _account(db_session, "member@corp.com")
    await db_session.commit()

    resp = await test_client.post(
        "/api/v1/auth/login",
        json={"email": "member@corp.com", "password": PASSWORD},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid email or password"


@pytest.mark.asyncio
async def test_an_unreachable_idp_returns_to_the_sign_in_page(
    test_client, db_session, registry, monkeypatch,
):
    """Starting a sign-in against an IdP whose discovery fails lands on
    the sign-in page with a reference, not on a bare 503 JSON body."""
    from backend.auth_service.providers.oidc import OidcProvider

    row = await idp_provider_repo.create_provider(
        db_session, slug="entra-down", display_name="Entra", kind="oidc",
        settings={
            "issuer": "https://idp.example", "client_id": "app",
            "client_secret": "secret",
            "redirect_uri": "https://app.example/api/v1/auth/entra-down/callback",
        },
        claim_mapping={},
    )
    await idp_provider_repo.publish_provider(db_session, row.id)
    await db_session.commit()

    async def unreachable(self, *a, **kw):
        raise RuntimeError("discovery fetch failed")

    monkeypatch.setattr(OidcProvider, "build_authorization", unreachable)
    resp = await test_client.get(
        "/api/v1/auth/entra-down/login", follow_redirects=False,
    )
    assert resp.status_code == 302, resp.text
    location = resp.headers["location"]
    assert location.startswith("/login?ref=")
    assert location.endswith("&sso_error=1")


# ── The admin surface ────────────────────────────────────────────────

CONFIG = "/api/v1/admin/sso/config"
WINDOW = "/api/v1/admin/sso/config/password-fallback"


async def _enforce(test_client, db_session):
    await _account(db_session, "ops@corp.com", super_admin=True, system=True)
    await db_session.commit()
    resp = await test_client.patch(CONFIG, json={"allowLocalLogin": False})
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_the_window_is_refused_while_passwords_are_on(test_client):
    resp = await test_client.post(WINDOW, json={"hours": 4})
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "passwords_already_on"


@pytest.mark.asyncio
@pytest.mark.parametrize("hours", [0, 25])
async def test_the_window_is_one_to_twenty_four_hours(test_client, db_session, hours):
    await _enforce(test_client, db_session)
    resp = await test_client.post(WINDOW, json={"hours": hours})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_opening_and_closing_the_window(test_client, db_session):
    before = await _enforce(test_client, db_session)

    opened = await test_client.post(
        WINDOW, json={"hours": 4, "reason": "Okta outage"},
    )
    assert opened.status_code == 200, opened.text
    body = opened.json()
    until = datetime.fromisoformat(body["passwordFallbackUntil"])
    assert timedelta(hours=3, minutes=59) < until - datetime.now(timezone.utc) <= timedelta(hours=4)
    assert body["passwordFallbackReason"] == "Okta outage"
    assert body["passwordFallbackBy"]
    # Opened in an incident: never makes a loaded Settings page's next
    # save fail with a version conflict.
    assert body["version"] == before["version"]
    assert len(await _outbox(db_session, "auth.config.password_fallback_opened")) == 1

    closed = await test_client.delete(WINDOW)
    assert closed.status_code == 200
    assert closed.json()["passwordFallbackUntil"] is None
    assert len(await _outbox(db_session, "auth.config.password_fallback_closed")) == 1


@pytest.mark.asyncio
async def test_an_open_window_is_extended_not_replaced(test_client, db_session):
    """An outage longer than the window: extending it keeps everyone signed
    in through it, and the log says who extended it, from when to when."""
    await _enforce(test_client, db_session)
    first = (await test_client.post(
        WINDOW, json={"hours": 1, "reason": "Okta outage"},
    )).json()

    resp = await test_client.post(WINDOW, json={"hours": 8, "reason": "Still down"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    until = datetime.fromisoformat(body["passwordFallbackUntil"])
    assert timedelta(hours=7, minutes=59) < until - datetime.now(timezone.utc) <= timedelta(hours=8)
    # Who opened it stays on the card; the latest reason shows.
    assert body["passwordFallbackBy"] == first["passwordFallbackBy"]
    assert body["passwordFallbackReason"] == "Still down"

    [opened] = await _outbox(db_session, "auth.config.password_fallback_opened")
    [extended] = await _outbox(db_session, "auth.config.password_fallback_extended")
    # ``stated_reason`` is the key the activity log's "why" column reads.
    assert json.loads(opened.payload)["stated_reason"] == "Okta outage"
    p = json.loads(extended.payload)
    assert p["previous_until"] == first["passwordFallbackUntil"]
    assert p["until"] == body["passwordFallbackUntil"]
    assert (p["hours"], p["stated_reason"]) == (8, "Still down")


@pytest.mark.asyncio
async def test_extending_never_shortens_a_window(test_client, db_session):
    await _enforce(test_client, db_session)
    first = (await test_client.post(WINDOW, json={"hours": 8})).json()

    resp = await test_client.post(WINDOW, json={"hours": 4})
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "would_not_extend"
    assert (await test_client.get(CONFIG)).json()["passwordFallbackUntil"] == (
        first["passwordFallbackUntil"]
    )
    assert await _outbox(db_session, "auth.config.password_fallback_extended") == []


@pytest.mark.asyncio
async def test_closing_is_recorded_only_when_a_window_was_open(test_client, db_session):
    await _enforce(test_client, db_session)
    r = await test_client.delete(WINDOW)
    assert r.status_code == 200
    assert await _outbox(db_session, "auth.config.password_fallback_closed") == []

    opened = (await test_client.post(WINDOW, json={"hours": 2})).json()
    await test_client.delete(WINDOW)
    [closed] = await _outbox(db_session, "auth.config.password_fallback_closed")
    assert json.loads(closed.payload)["was_until"] == opened["passwordFallbackUntil"]


@pytest.mark.asyncio
async def test_a_window_that_lapses_is_recorded_once(db_session, monkeypatch):
    """It closes at its deadline whatever runs; the prober's pass, holding
    the lock, records that it did — once."""
    from backend.app.db.repositories import app_auth_config_repo

    async def fake_probe(kind, settings, allow_hosts=frozenset()):
        return True, "up"

    monkeypatch.setattr(reach, "probe", fake_probe)
    lapsed = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    await app_auth_config_repo.set_password_fallback(
        db_session, until=lapsed, by="ops@corp.com", reason="Okta outage",
    )

    await reach.probe_once(_factory(db_session))
    await reach.probe_once(_factory(db_session))

    [expired] = await _outbox(db_session, "auth.config.password_fallback_expired")
    assert json.loads(expired.payload) == {"until": lapsed, "actor": "scheduler"}
    snap = await app_auth_config_repo.get_snapshot(db_session)
    assert (snap.password_fallback_until, snap.password_fallback_reason) == (None, None)


@pytest.mark.asyncio
async def test_an_open_window_is_left_alone_by_the_prober(db_session, monkeypatch):
    from backend.app.db.repositories import app_auth_config_repo

    async def fake_probe(kind, settings, allow_hosts=frozenset()):
        return True, "up"

    monkeypatch.setattr(reach, "probe", fake_probe)
    until = _window(2)
    await app_auth_config_repo.set_password_fallback(db_session, until=until)

    await reach.probe_once(_factory(db_session))

    assert await _outbox(db_session, "auth.config.password_fallback_expired") == []
    snap = await app_auth_config_repo.get_snapshot(db_session)
    assert snap.password_fallback_until == until


@pytest.mark.asyncio
async def test_a_settings_save_records_what_it_changed(test_client, db_session):
    """The values after a save cannot say which switch moved; the change,
    before → after, can."""
    await _enforce(test_client, db_session)
    [event] = await _outbox(db_session, "auth.config.updated")
    payload = json.loads(event.payload)
    assert payload["changes"] == {"allow_local_login": [True, False]}
    assert payload["allow_local_login"] is False


@pytest.mark.asyncio
async def test_a_connection_edit_records_what_it_changed(test_client, db_session):
    """Which settings changed — by name, never by value — and, before →
    after, the ones an auditor asks about."""
    row = m.IdpProviderORM(
        id="idp_portal", slug="portal", display_name="Portal", kind="backchannel",
        enabled=True, lifecycle="live",
        settings=idp_provider_repo.encrypt_settings({
            "exchange_mode": "browser",
            "browser_exchange_url": "https://portal.corp.example/translate",
            "jwks_url": "https://portal.corp.example/jwks",
            "token_source_key": "", "gateway_url": "",
        }),
    )
    db_session.add(row)
    await db_session.commit()

    resp = await test_client.patch(
        f"/api/v1/admin/idp-providers/{row.id}",
        json={"settings": {
            "jwks_url": "", "trust_unsigned": True, "link_admin_accounts": True,
        }},
    )
    assert resp.status_code == 200, resp.text

    [event] = await _outbox(db_session, "idp.provider.updated")
    payload = json.loads(event.payload)
    assert payload["changed_settings"] == [
        "jwks_url", "link_admin_accounts", "trust_unsigned",
    ]
    assert payload["assurance"] == ["verified", "unverified"]
    assert payload["link_admin_accounts"] == [False, True]
    assert "enabled" not in payload and "linking_policy" not in payload


def test_a_door_sign_in_shows_its_door_in_the_sso_log():
    from backend.app.api.v1.endpoints.sso_activity import _reason

    assert _reason("user.logged_in", {"provider": "local", "via": "emergency_window"}) == (
        "emergency_window", None,
    )
    assert _reason("user.logged_in", {"provider": "local"}) == (None, None)


@pytest.mark.asyncio
async def test_the_config_reports_break_glass_and_detection(test_client, db_session):
    await _account(db_session, "ops@corp.com", super_admin=True, system=True)
    await _account(db_session, "kiosk@corp.com", system=True)
    await db_session.commit()

    body = (await test_client.get(CONFIG)).json()
    assert body["breakGlass"]["ready"] is True
    by_email = {a["email"]: a for a in body["breakGlass"]["accounts"]}
    assert by_email["ops@corp.com"]["ready"] is True
    # A system account that is not an admin can sign in but fix nothing.
    assert by_email["kiosk@corp.com"]["ready"] is False
    assert body["ssoStatus"] == {"checkedAt": None, "stale": True, "outage": None}


# ── The host recovery script ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_reset_script_can_make_a_break_glass_account(db_session, monkeypatch):
    from backend.app.db import engine
    from backend.scripts import reset_admin_password as script

    user = await _account(db_session, "admin@corp.com", super_admin=True)
    await db_session.commit()

    async def _noop():
        return None

    monkeypatch.setattr(engine, "init_db", _noop)
    monkeypatch.setattr(engine, "close_db", _noop)
    monkeypatch.setattr(engine, "get_async_session", _factory(db_session))

    assert await script._reset(
        "admin@corp.com", "a-new-Pass!99", break_glass=True,
    ) == 0

    refreshed = await user_repo.get_user_by_id(db_session, user.id)
    assert refreshed.is_system_account is True
    changed = await _outbox(db_session, "user.system_account_changed")
    assert len(changed) == 1
