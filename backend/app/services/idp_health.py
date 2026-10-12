"""IdP health: reachability and, above all, certificate expiry.

The classic SAML outage is an expired IdP signing certificate. Nothing warns
anyone, the certificate lapses over a weekend, and on Monday morning every
sign-in fails at once with a signature error. The information was available
the whole time — it is printed inside the certificate we already store.

**Why this lives on the backend.** The obvious implementation is a frontend
sweep, and this codebase already tried that shape for data sources and
reverted it: ``useProviderHealthSweep`` deliberately has no interval after a
mount-time fan-out "storm hit the backend on every cold boot". So health is
produced by one background loop and *read* from a cache, exactly like
``providers.py:/status``, whose contract is "NO outbound work, NO sockets
opened". Repeating the frontend fan-out would re-introduce a bug already
paid for.

The cache lives on ``app.state`` and does not survive a restart. That is a
deliberate trade: a column would need a migration and a write path on a
read-mostly table, to persist a value that is re-derivable in one sweep.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

#: How often to re-probe. Certificates expire on a scale of months, and
#: discovery endpoints do not flap minute to minute, so this is slow on
#: purpose — it is a warning system, not a liveness check.
SWEEP_INTERVAL_SECONDS = 900.0

#: Warn this far ahead of expiry. Long enough to raise a ticket with an IdP
#: team and have it actioned, which is the actual constraint.
CERT_EXPIRY_WARNING_DAYS = 30

_PROBE_TIMEOUT_SECONDS = 8.0


@dataclass
class IdpHealth:
    """One provider's last known state. ``status`` mirrors the vocabulary
    the data-source ``/status`` endpoint uses so the UI can share shapes."""
    provider_id: str
    slug: str
    status: str = "unknown"          # ok | warning | unavailable | unknown
    detail: Optional[str] = None
    cert_not_after: Optional[str] = None
    cert_days_remaining: Optional[int] = None
    checked_at: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def certificate_expiry(cert: str) -> Optional[datetime]:
    """Read ``notAfter`` from a SAML signing certificate.

    ``_normalise_cert`` stores the base64 body with the PEM headers and all
    newlines stripped, so ``load_pem_x509_certificate`` will not take it —
    decode to DER instead. Accepts a full PEM too, since an operator may
    have pasted one straight into the settings JSON.

    Returns None when the value cannot be parsed; a cert we cannot read is
    reported as a warning by the caller, never as an exception.
    """
    if not (cert or "").strip():
        return None
    from cryptography import x509

    text = cert.strip()
    try:
        if "-----BEGIN" in text:
            return _not_after(x509.load_pem_x509_certificate(text.encode()))
        body = "".join(text.split())
        # Tolerate the padding some IdPs strip.
        body += "=" * (-len(body) % 4)
        return _not_after(x509.load_der_x509_certificate(base64.b64decode(body)))
    except Exception as exc:  # noqa: BLE001 — any malformed cert is one case
        logger.debug("Could not parse IdP certificate: %s", exc)
        return None


def _not_after(cert) -> datetime:
    # cryptography >= 42 deprecates the naive ``not_valid_after``.
    value = getattr(cert, "not_valid_after_utc", None)
    if value is None:
        value = cert.not_valid_after.replace(tzinfo=timezone.utc)
    return value


async def probe_provider(provider_id: str, slug: str, kind: str,
                         settings: dict,
                         allow_hosts: frozenset[str] = frozenset()) -> IdpHealth:
    """Probe one provider. Never raises — an unreachable IdP is a *result*.

    ``allow_hosts`` is the back-channel allowlist, needed only by the
    ``backchannel`` kind and defaulted so every other caller is
    unaffected.
    """
    health = IdpHealth(provider_id=provider_id, slug=slug, checked_at=_now_iso())

    if kind == "saml2":
        expiry = certificate_expiry(str(settings.get("idp_x509_cert") or ""))
        if expiry is None:
            health.status = "warning"
            health.detail = "Signing certificate missing or unreadable."
            return health
        remaining = (expiry - datetime.now(timezone.utc)).days
        health.cert_not_after = expiry.isoformat()
        health.cert_days_remaining = remaining
        if remaining < 0:
            health.status = "unavailable"
            health.detail = (
                f"Signing certificate EXPIRED {abs(remaining)} days ago. "
                "Sign-in is failing for everyone using this provider."
            )
        elif remaining <= CERT_EXPIRY_WARNING_DAYS:
            health.status = "warning"
            health.detail = (
                f"Signing certificate expires in {remaining} days. Ask your "
                "IdP team for the replacement before it lapses."
            )
        else:
            health.status = "ok"
            health.detail = f"Signing certificate valid for {remaining} days."
        return health

    if kind == "oidc":
        # No certificate dates here — "health" is whether we can still fetch
        # the discovery document and the keys we verify ID tokens against.
        from backend.auth_service.providers.oidc import OidcError, discover_issuer
        try:
            found = await asyncio.wait_for(
                discover_issuer(str(settings.get("issuer") or "")),
                timeout=_PROBE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            health.status = "unavailable"
            health.detail = (
                f"Discovery timed out after {_PROBE_TIMEOUT_SECONDS:.0f}s."
            )
            return health
        except OidcError as exc:
            health.status = "unavailable"
            health.detail = str(exc)
            return health
        except Exception as exc:  # noqa: BLE001 — a probe never raises
            health.status = "unavailable"
            health.detail = str(exc)
            return health
        health.warnings = list(found.get("warnings") or [])
        health.status = "warning" if health.warnings else "ok"
        health.detail = (
            "; ".join(health.warnings) if health.warnings
            else "Discovery document and JWKS reachable."
        )
        return health

    if kind == "backchannel":
        return _probe_backchannel(health, settings, allow_hosts)

    # custom / custom_profile have no remote endpoint to probe — they are
    # handed a payload rather than fetching one. Reporting "unknown" is
    # honest; reporting "ok" would imply a check that never ran.
    health.status = "unknown"
    health.detail = "This provider kind has nothing to probe."
    return health


def _probe_backchannel(
    health: IdpHealth, settings: dict, allow_hosts: frozenset[str],
) -> IdpHealth:
    """Check that this row's endpoints are still permitted destinations.

    Deliberately NOT a live request. Calling the gateway without an
    ambient token would earn a 401 — a healthy answer that looks like a
    failure — while adding authentication noise to somebody else's
    identity service every fifteen minutes, for every provider, forever.

    What it checks instead is the failure that actually happens:
    allowlist drift. The endpoints are internal, so they are reachable
    only because an operator added their hosts to
    ``sso_backchannel_hosts``. Remove or retype an entry — or move the
    gateway to a new port — and every login through this provider stops,
    with nothing anywhere saying why. This says why.
    """
    from backend.auth_service.providers.outbound import (
        BlockedOutboundRequest, assert_fetchable,
    )

    targets = [
        ("gateway_url", str(settings.get("gateway_url") or "")),
        ("exchange_url", str(settings.get("exchange_url") or "")),
    ]
    problems: list[str] = []
    for label, url in targets:
        if not url:
            continue  # exchange_url is optional by design
        try:
            assert_fetchable(url, allow_hosts=allow_hosts)
        except BlockedOutboundRequest as exc:
            problems.append(f"{label}: {exc}")
        except Exception as exc:  # noqa: BLE001 — a probe never raises
            problems.append(f"{label}: {exc}")

    if not targets[0][1]:
        health.status = "unavailable"
        health.detail = "No gateway_url configured; this provider cannot sign anyone in."
        return health
    if problems:
        health.status = "unavailable"
        health.detail = "; ".join(problems)
        return health
    health.status = "ok"
    health.detail = "Endpoints are configured and permitted destinations."
    return health


async def sweep_once(session_factory, cache: dict) -> int:
    """Probe every enabled provider and refresh *cache* in place."""
    from backend.app.db.repositories import idp_provider_repo

    from backend.app.db.repositories import backchannel_host_repo

    async with session_factory() as session:
        rows = await idp_provider_repo.list_providers(session, only_enabled=True)
        targets = [
            (r.id, r.slug, r.kind,
             idp_provider_repo.decrypt_settings(r.settings))
            for r in rows
        ]
        # Read once per sweep rather than once per provider: it is the
        # same answer for all of them, and the sweep is deliberately
        # sequential.
        allow_hosts = await backchannel_host_repo.allowed_host_keys(session)

    # Sequential on purpose. The sweep is slow-cadence and this avoids the
    # concurrent-probe storm the frontend version was reverted for.
    for provider_id, slug, kind, settings in targets:
        try:
            cache[provider_id] = await probe_provider(
                provider_id, slug, kind, settings, allow_hosts,
            )
        except Exception as exc:  # noqa: BLE001 — one bad row must not stop the sweep
            logger.warning("IdP health probe failed (slug=%s): %s", slug, exc)
    return len(targets)


async def run_idp_health_loop(session_factory, shutdown: asyncio.Event,
                              cache: dict,
                              interval: float = SWEEP_INTERVAL_SECONDS) -> None:
    """Background sweep. Mirrors ``outbox_relay.run_relay``.

    Uses ``wait_for(shutdown.wait(), timeout=...)`` rather than
    ``asyncio.sleep`` so shutdown is immediate instead of waiting out a
    15-minute interval.
    """
    logger.info("IdP health loop started (interval=%.0fs)", interval)
    while not shutdown.is_set():
        try:
            count = await sweep_once(session_factory, cache)
            logger.debug("IdP health sweep probed %d providers", count)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the loop must survive blips
            logger.warning("IdP health sweep failed: %s", exc)
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
    logger.info("IdP health loop stopped")
