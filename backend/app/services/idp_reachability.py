"""Is each connection's identity provider answering?

The evidence the automatic password fallback acts on. While a connection is
**confirmed down**, Super Admins with a password may sign in with it
(``auth_service.app_auth_config.password_access``) and SSO sessions from that
connection ride through their daily re-authentication instead of being sent
to an identity provider that cannot answer. Because a confirmed outage opens
a door, the rules for confirming one are strict:

* **Only the server's own probes count.** Nothing a browser reports, and no
  count of failed SSO callbacks — both can be produced by anyone.
* **Seen working first.** An outage is confirmed only for a connection this
  prober has seen healthy. A probe that cannot succeed from where it runs —
  a CA bundle or network path the sign-in servers have and the control plane
  lacks — is then never mistaken for an identity provider that is down.
* **Sustained.** Unreachable continuously for ``CONFIRM_AFTER_SECONDS``;
  over only after ``RECOVER_AFTER_SECONDS`` of continuous health, so a
  flapping IdP does not end the sessions people opened during it.
* **Fresh.** Evidence older than ``STALE_AFTER_SECONDS`` means nothing, and a
  gap that long starts any run of failures afresh. A prober that has
  stopped never opens anything.

What is probed is what a sign-in needs. OIDC: the discovery document AND the
signing keys, through the provider's own code path. SAML: whether the IdP's
single sign-on URL answers at all (any status below 500 — asked for nothing
it answers with a redirect or a 400). Enterprise gateway (back-channel) in
server mode: whether the gateway URL answers at all, by the same rule —
asked with no session handle, a healthy gateway says 401 or 405 — through
the operator's allowlist and the row's TLS setting, as every sign-in and
renewal call to it goes. Unlike the admin health card (``idp_health``),
this is a live request, because a confirmed outage opens a door and only a
live request can confirm one. A browser-mode gateway is called by browsers,
not by this server, which cannot speak for their network path; portal and
dev connections are handed a payload rather than fetching one. Those are
never confirmed down; an admin covers their outages with the emergency
window.

Runs in the scheduler role only, one process at a time (an advisory lock per
pass), so its read-modify-write of each row is safe and each transition is
audited once. Sign-in reads the result through the posture snapshot
(``main._load_auth_config``), so no request pays for it.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

PROBE_INTERVAL_SECONDS = 60.0
CONFIRM_AFTER_SECONDS = 180
RECOVER_AFTER_SECONDS = 300
STALE_AFTER_SECONDS = 3 * int(PROBE_INTERVAL_SECONDS)

_PROBE_TIMEOUT_SECONDS = 8.0
_LOCK = "idp:reachability"
#: The kinds with something to probe. Everything else is never confirmed down.
PROBED_KINDS = ("oidc", "saml2", "backchannel")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_fresh(row: Any, now: datetime) -> bool:
    checked = _parse(getattr(row, "checked_at", None))
    return checked is not None and now - checked <= timedelta(
        seconds=STALE_AFTER_SECONDS,
    )


def outage_confirmed(row: Any, now: datetime) -> bool:
    """The one definition of "confirmed down" — see the module docstring."""
    if row is None or getattr(row, "last_ok_at", None) is None:
        return False
    since = _parse(getattr(row, "unreachable_since", None))
    return (
        since is not None
        and is_fresh(row, now)
        and now - since >= timedelta(seconds=CONFIRM_AFTER_SECONDS)
    )


def next_state(
    prev: Any, ok: Optional[bool], now: datetime, detail: Optional[str],
) -> dict:
    """The row after one probe. ``ok`` is True (answered), False (did not)
    or None (nothing could be judged — no endpoint configured, or the
    address is refused by policy), which never counts toward an outage."""
    iso = now.isoformat()
    continuing = prev is not None and is_fresh(prev, now)
    last_ok = getattr(prev, "last_ok_at", None) if prev is not None else None
    streak = getattr(prev, "unreachable_since", None) if continuing else None
    state = {
        "last_ok_at": last_ok, "unreachable_since": None,
        "recovering_since": None, "checked_at": iso, "detail": detail,
    }
    if ok is None:
        return state
    if not ok:
        state["unreachable_since"] = streak or iso
        return state
    state["last_ok_at"] = iso
    if streak and outage_confirmed(prev, now):
        # A confirmed outage ends after sustained health, not one success.
        recovering = (
            getattr(prev, "recovering_since", None) if continuing else None
        ) or iso
        if now - _parse(recovering) < timedelta(seconds=RECOVER_AFTER_SECONDS):
            state["unreachable_since"] = streak
            state["recovering_since"] = recovering
    return state


async def probe(
    kind: str, settings: dict, allow_hosts: frozenset[str] = frozenset(),
) -> tuple[Optional[bool], str]:
    """Probe one connection. Never raises — an unreachable IdP is a result.

    ``allow_hosts`` is the back-channel allowlist, needed only by the
    ``backchannel`` kind."""
    from backend.auth_service.providers.outbound import (
        BlockedOutboundRequest, fetch_status,
    )

    try:
        if kind == "oidc":
            from backend.auth_service.providers.oidc import probe_issuer
            issuer = str(settings.get("issuer") or "").strip()
            if not issuer:
                return None, "No issuer configured."
            await asyncio.wait_for(
                probe_issuer(issuer), timeout=_PROBE_TIMEOUT_SECONDS,
            )
            return True, "Discovery document and signing keys reachable."
        if kind == "saml2":
            url = str(settings.get("idp_sso_url") or "").strip()
            if not url:
                return None, "No single sign-on URL configured."
            status = await asyncio.wait_for(
                fetch_status(url, timeout=_PROBE_TIMEOUT_SECONDS),
                timeout=_PROBE_TIMEOUT_SECONDS,
            )
            if status >= 500:
                return False, f"Single sign-on URL answered {status}."
            return True, f"Single sign-on URL answered {status}."
        if kind == "backchannel":
            mode = str(settings.get("exchange_mode") or "server").strip().lower()
            if mode != "server":
                return None, "Browsers call this gateway, not the server."
            url = str(settings.get("gateway_url") or "").strip()
            if not url:
                return None, "No gateway URL configured."
            # The row's own TLS opt-out, read as its sign-in calls read it.
            verify = str(settings.get("tls_verify", True)).strip().lower() in {
                "true", "1", "yes", "t",
            }
            status = await asyncio.wait_for(
                fetch_status(
                    url, timeout=_PROBE_TIMEOUT_SECONDS,
                    allow_hosts=allow_hosts, verify=None if verify else False,
                ),
                timeout=_PROBE_TIMEOUT_SECONDS,
            )
            if status >= 500:
                return False, f"Gateway answered {status}."
            return True, f"Gateway answered {status}."
    except BlockedOutboundRequest as exc:
        # Policy, not an outage: the prober may not reach this address.
        return None, f"Not probed: {exc}"
    except asyncio.TimeoutError:
        return False, f"No answer within {_PROBE_TIMEOUT_SECONDS:.0f}s."
    except Exception as exc:  # noqa: BLE001 — every failure is a result
        return False, str(exc) or exc.__class__.__name__
    return None, "This kind of connection has nothing to probe."


async def _probed_connections(session: AsyncSession) -> list:
    from backend.app.db.repositories import idp_provider_repo
    rows = await idp_provider_repo.list_public_providers(session)
    return [r for r in rows if r.kind in PROBED_KINDS]


async def probe_once(session_factory) -> int:
    """One pass over every probed connection. Returns how many were probed."""
    from backend.app.db.advisory import claim_this_pass
    from backend.app.db.models import IdpProviderReachabilityORM
    from backend.app.db.repositories import (
        app_auth_config_repo, backchannel_host_repo, idp_provider_repo,
        user_repo,
    )

    async with session_factory() as session:
        # Held for the whole pass, so one process probes and each
        # transition below is decided, and audited, exactly once.
        if not await claim_this_pass(session, _LOCK):
            return 0
        # The emergency window closes itself at its deadline; this pass,
        # holding the lock, is what records that it did — once.
        lapsed = await app_auth_config_repo.close_lapsed_password_fallback(session)
        if lapsed:
            await user_repo.create_outbox_event(
                session, event_type="auth.config.password_fallback_expired",
                payload={"until": lapsed, "actor": "scheduler"},
            )
        if not (await app_auth_config_repo.get_snapshot(session)).sso_enabled:
            return 0  # rows go stale, so nothing reads as down
        connections = await _probed_connections(session)
        rows = {
            r.provider_id: r for r in (await session.execute(
                select(IdpProviderReachabilityORM)
            )).scalars().all()
        }
        allow_hosts = await backchannel_host_repo.allowed_host_keys(session)
        for conn in connections:
            ok, detail = await probe(
                conn.kind, idp_provider_repo.decrypt_settings(conn.settings),
                allow_hosts,
            )
            now = _now()
            prev = rows.get(conn.id)
            # As the previous probe left it, so the moment an outage
            # crosses its threshold is the transition that gets recorded.
            then = _parse(getattr(prev, "checked_at", None))
            was_down = then is not None and outage_confirmed(prev, then)
            state = next_state(prev, ok, now, detail)
            if prev is None:
                prev = IdpProviderReachabilityORM(provider_id=conn.id)
                session.add(prev)
            for key, value in state.items():
                setattr(prev, key, value)
            is_down = outage_confirmed(prev, now)
            if is_down != was_down:
                event = "idp.outage.detected" if is_down else "idp.outage.resolved"
                (logger.warning if is_down else logger.info)(
                    "%s (slug=%s): %s", event, conn.slug, detail,
                )
                await user_repo.create_outbox_event(
                    session, event_type=event,
                    payload={
                        "provider_id": conn.id, "slug": conn.slug,
                        "since": prev.unreachable_since, "detail": detail,
                        "actor": "scheduler",
                    },
                    aggregate_type="idp_provider", aggregate_id=conn.id,
                )
        return len(connections)


async def confirmed_outage(
    session: AsyncSession,
) -> tuple[tuple[str, ...], Optional[str]]:
    """Slugs of the connections confirmed down right now, and when the
    earliest of those outages began. Read with the posture snapshot."""
    from backend.app.db.models import IdpProviderReachabilityORM

    connections = {c.id: c for c in await _probed_connections(session)}
    if not connections:
        return (), None
    rows = (await session.execute(
        select(IdpProviderReachabilityORM).where(
            IdpProviderReachabilityORM.provider_id.in_(list(connections)),
        )
    )).scalars().all()
    now = _now()
    down = [r for r in rows if outage_confirmed(r, now)]
    if not down:
        return (), None
    since = min(r.unreachable_since for r in down)
    return tuple(connections[r.provider_id].slug for r in down), since


async def read_confirmed_outage(
    session_factory,
) -> tuple[tuple[str, ...], Optional[str]]:
    """``confirmed_outage`` for the posture loader, in a session of its
    own and with any failure meaning "no outage". Never raises: the
    posture read it rides on falls back to a snapshot that opens
    passwords when it fails, and a broken outage read must not be the
    thing that does that."""
    try:
        async with session_factory() as session:
            return await confirmed_outage(session)
    except Exception as exc:  # noqa: BLE001 — see docstring
        logger.warning("SSO outage read failed; assuming none: %s", exc)
        return (), None


async def status(session: AsyncSession) -> dict:
    """What the admin console shows: when detection last ran, whether that
    is recent enough to act on, and any confirmed outage."""
    from backend.app.db.models import IdpProviderReachabilityORM

    connections = {c.id: c for c in await _probed_connections(session)}
    rows = []
    if connections:
        rows = (await session.execute(
            select(IdpProviderReachabilityORM).where(
                IdpProviderReachabilityORM.provider_id.in_(list(connections)),
            )
        )).scalars().all()
    now = _now()
    checked = max((r.checked_at for r in rows if r.checked_at), default=None)
    down = [r for r in rows if outage_confirmed(r, now)]
    outage = None
    if down:
        outage = {
            "since": min(r.unreachable_since for r in down),
            "providers": [
                {
                    "slug": connections[r.provider_id].slug,
                    "display_name": connections[r.provider_id].display_name,
                    "since": r.unreachable_since,
                    "detail": r.detail,
                }
                for r in down
            ],
        }
    return {
        "checked_at": checked,
        "stale": not any(is_fresh(r, now) for r in rows),
        "outage": outage,
    }


async def run_idp_reachability_loop(
    session_factory, shutdown: asyncio.Event,
    interval: float = PROBE_INTERVAL_SECONDS,
) -> None:
    """Background loop. Mirrors ``idp_health.run_idp_health_loop``."""
    logger.info("IdP reachability loop started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            await probe_once(session_factory)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must survive blips
            logger.warning("IdP reachability pass failed: %s", exc)
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass  # no shutdown asked for: time for the next pass
    logger.info("IdP reachability loop stopped")
