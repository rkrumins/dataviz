"""Preflight against a real in-process TLS server: a matching SSLContext
completes the handshake and PINGs OK; a plaintext probe against a TLS-only
server fails cleanly (classified, not a crash)."""
import asyncio
import datetime
import ipaddress
import ssl

import pytest

from backend.common.interfaces.preflight import redis_ping_preflight


@pytest.fixture
def self_signed_cert(tmp_path):
    pytest.importorskip("cryptography")
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    return str(cert_path), str(key_path)


async def _tls_server(cert_path, key_path, reply=b"+PONG\r\n"):
    sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    sctx.load_cert_chain(cert_path, key_path)

    async def handle(reader, writer):
        writer.write(reply)
        await writer.drain()
        await asyncio.sleep(0.1)
        writer.close()

    return await asyncio.start_server(handle, "127.0.0.1", 0, ssl=sctx)


@pytest.mark.asyncio
async def test_preflight_tls_handshake_ok(self_signed_cert):
    cert_path, key_path = self_signed_cert
    server = await _tls_server(cert_path, key_path)
    port = server.sockets[0].getsockname()[1]
    cctx = ssl.create_default_context()
    cctx.check_hostname = False
    cctx.verify_mode = ssl.CERT_NONE  # accept the self-signed cert
    async with server:
        res = await redis_ping_preflight(
            "127.0.0.1", port, deadline_s=3.0, ssl_context=cctx,
        )
    assert res.ok is True


@pytest.mark.asyncio
async def test_plaintext_probe_against_tls_only_fails_cleanly(self_signed_cert):
    cert_path, key_path = self_signed_cert
    server = await _tls_server(cert_path, key_path)
    port = server.sockets[0].getsockname()[1]
    async with server:
        res = await redis_ping_preflight(
            "127.0.0.1", port, deadline_s=3.0, ssl_context=None,
        )
    assert res.ok is False  # classified failure, no exception


@pytest.mark.asyncio
async def test_untrusted_cert_classifies_as_tls_handshake(self_signed_cert):
    """A client context that does NOT trust the self-signed cert fails the
    handshake itself (ssl.SSLCertVerificationError, an OSError subclass).
    Before ``tls_handshake`` existed this fell into the generic
    ``os_error: ...`` bucket, indistinguishable from a routing failure —
    TLS misconfiguration needs its own stable code, the same way Redis
    AUTH/cluster-mode mismatches already get one."""
    cert_path, key_path = self_signed_cert
    server = await _tls_server(cert_path, key_path)
    port = server.sockets[0].getsockname()[1]
    cctx = ssl.create_default_context()  # verifies against the system trust store — does NOT trust this cert
    async with server:
        res = await redis_ping_preflight(
            "127.0.0.1", port, deadline_s=3.0, ssl_context=cctx,
        )
    assert res.ok is False
    assert res.reason == "tls_handshake"
