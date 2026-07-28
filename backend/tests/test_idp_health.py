"""IdP health: certificate expiry, and the no-sockets contract.

The failure this exists to prevent: a SAML signing certificate lapses over a
weekend and on Monday every sign-in fails at once with a signature error.
The expiry date was inside the certificate we already store the whole time.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.idp_health import (
    CERT_EXPIRY_WARNING_DAYS,
    certificate_expiry,
    probe_provider,
    sweep_once,
)


def _cert(days_until_expiry: int, *, pem: bool = False) -> str:
    """A real self-signed certificate expiring when we say."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "idp.example.com")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        # not_valid_before must precede not_valid_after even for an
        # already-expired cert, and the +1h keeps `.days` from flooring
        # an exactly-N-day cert down to N-1.
        .not_valid_before(now - timedelta(days=abs(days_until_expiry) + 2))
        .not_valid_after(now + timedelta(days=days_until_expiry, hours=1))
        .sign(key, hashes.SHA256())
    )
    pem_text = cert.public_bytes(serialization.Encoding.PEM).decode()
    if pem:
        return pem_text
    # How _normalise_cert stores it: base64 body, no headers, no newlines.
    return "".join(
        ln for ln in pem_text.splitlines() if ln and not ln.startswith("-----")
    )


# ── Certificate parsing ──────────────────────────────────────────────


def test_reads_expiry_from_the_stored_headerless_body():
    """_normalise_cert strips the PEM headers and all newlines, so
    load_pem_x509_certificate will not take it — the DER path must."""
    expiry = certificate_expiry(_cert(90))
    assert expiry is not None
    assert 88 <= (expiry - datetime.now(timezone.utc)).days <= 91


def test_reads_expiry_from_a_full_pem_too():
    """An operator may paste a whole PEM into the settings JSON."""
    assert certificate_expiry(_cert(90, pem=True)) is not None


@pytest.mark.parametrize("value", ["", "   ", "not-a-certificate", "eHl6"])
def test_an_unreadable_certificate_returns_none_rather_than_raising(value):
    assert certificate_expiry(value) is None


# ── Probing ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_healthy_certificate_reports_ok():
    health = await probe_provider(
        "idp_1", "okta", "saml2", {"idp_x509_cert": _cert(365)},
    )
    assert health.status == "ok"
    assert health.cert_days_remaining is not None
    assert health.cert_days_remaining > CERT_EXPIRY_WARNING_DAYS


@pytest.mark.asyncio
async def test_an_expiring_certificate_warns_in_time_to_act():
    """The warning window has to be long enough to raise a ticket with an
    IdP team and have it actioned — that is the real constraint."""
    health = await probe_provider(
        "idp_1", "okta", "saml2", {"idp_x509_cert": _cert(10)},
    )
    assert health.status == "warning"
    assert "10 days" in health.detail
    assert health.cert_days_remaining == 10


@pytest.mark.asyncio
async def test_an_expired_certificate_reports_unavailable():
    health = await probe_provider(
        "idp_1", "okta", "saml2", {"idp_x509_cert": _cert(-3)},
    )
    assert health.status == "unavailable"
    assert "EXPIRED" in health.detail


@pytest.mark.asyncio
async def test_a_missing_certificate_is_a_warning_not_a_crash():
    health = await probe_provider("idp_1", "okta", "saml2", {})
    assert health.status == "warning"
    assert "missing" in health.detail.lower()


@pytest.mark.asyncio
async def test_an_unreachable_oidc_issuer_is_a_result_not_an_exception():
    import httpx

    health = await probe_provider(
        "idp_2", "entra", "oidc", {"issuer": "https://nope.example.com"},
    )
    assert isinstance(health.status, str)
    assert health.status in {"unavailable", "warning", "ok"}
    # Whatever happened, we got a health record rather than a raised error.
    assert health.checked_at
    del httpx


@pytest.mark.asyncio
async def test_kinds_with_nothing_to_probe_report_unknown_not_ok():
    """custom_profile is handed a payload rather than fetching one. Saying
    'ok' would imply a check that never ran."""
    for kind in ("custom_profile", "custom"):
        health = await probe_provider("idp_3", "portal", kind, {})
        assert health.status == "unknown", kind


# ── The sweep and the endpoint ───────────────────────────────────────


@pytest.mark.asyncio
async def test_sweep_populates_the_cache(db_session):
    from contextlib import asynccontextmanager

    from backend.app.db.repositories import idp_provider_repo

    await idp_provider_repo.create_provider(
        db_session, slug="okta-sweep", display_name="Okta", kind="saml2",
        settings={"idp_x509_cert": _cert(5)},
    )
    await db_session.commit()

    @asynccontextmanager
    async def _factory():
        yield db_session

    cache: dict = {}
    count = await sweep_once(_factory, cache)
    assert count >= 1
    entry = next(h for h in cache.values() if h.slug == "okta-sweep")
    assert entry.status == "warning"
    assert entry.cert_days_remaining == 5


@pytest.mark.asyncio
async def test_status_endpoint_opens_no_sockets(test_client, monkeypatch):
    """The contract providers.py:/status states for data sources, for the
    same reason: this is polled, and a polled endpoint that opens sockets
    turns a dashboard into a load generator."""
    import backend.app.services.idp_health as health_mod

    async def _forbidden(*a, **k):  # noqa: ANN001
        raise AssertionError("/status must not probe providers")

    # Patch the probe rather than httpx itself — the test client reaches the
    # app THROUGH httpx, so patching that would fail the request, not the
    # assertion.
    monkeypatch.setattr(health_mod, "probe_provider", _forbidden)
    monkeypatch.setattr(health_mod, "sweep_once", _forbidden)

    resp = await test_client.get("/api/v1/admin/idp-providers/status")
    assert resp.status_code == 200
    assert "providers" in resp.json()


@pytest.mark.asyncio
async def test_status_is_empty_before_the_first_sweep(test_client):
    """Empty means "not probed yet", not "everything is broken" — a replica
    that runs no schedulers serves this forever and must not look alarming."""
    resp = await test_client.get("/api/v1/admin/idp-providers/status")
    assert resp.status_code == 200
    assert resp.json()["providers"] == []


@pytest.mark.asyncio
async def test_status_route_is_not_shadowed_by_the_provider_id_route(
    test_client,
):
    """`/status` and `/{provider_id}` are both GETs on the same prefix.
    Declaration order decides, so this pins it."""
    resp = await test_client.get("/api/v1/admin/idp-providers/status")
    assert resp.status_code == 200
    assert "providers" in resp.json()


@pytest.mark.asyncio
async def test_the_loop_stops_promptly_on_shutdown(db_session):
    """Uses wait_for(shutdown.wait()) rather than sleep, so a deploy is not
    held up for a 15-minute interval."""
    from contextlib import asynccontextmanager

    from backend.app.services.idp_health import run_idp_health_loop

    @asynccontextmanager
    async def _factory():
        yield db_session

    shutdown = asyncio.Event()
    cache: dict = {}
    task = asyncio.create_task(
        run_idp_health_loop(_factory, shutdown, cache, interval=3600),
    )
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.wait_for(task, timeout=2.0)
