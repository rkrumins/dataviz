"""Shared TLS helpers for redis-py async clients (graph, cache, bus).

One source of truth for turning a set of TLS settings (enable flag + optional
custom CA bundle + client cert/key for mutual TLS + verify mode) into the kwargs
each redis-py constructor expects. There are two shapes because redis-py exposes
TLS two different ways:

* **Raw ``ConnectionPool(host=, port=, ...)``** (used by the FalkorDB graph and
  the cluster owning-node pool, since ``FalkorDB`` only accepts
  ``connection_pool=``) needs ``connection_class=SSLConnection`` plus the
  ``ssl_*`` connection kwargs — it does NOT accept ``ssl=True``.
* **High-level constructors** (``Redis``, ``Redis.from_url``, ``RedisCluster``,
  ``Sentinel``) take ``ssl=True`` plus the same ``ssl_*`` kwargs.

Cert inputs are file PATHS (the standard redis-py ``ssl_ca_certs`` /
``ssl_certfile`` / ``ssl_keyfile`` inputs) — non-secret, so they ride
``extra_config`` / env, not the encrypted credentials blob.
"""
from __future__ import annotations

import logging
import ssl
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Map our verify-mode strings to ssl.VerifyMode for the raw-socket preflight,
# and to the strings redis-py's ssl_cert_reqs accepts for the client kwargs.
_VERIFY_MODES = {"required", "optional", "none"}
_SSL_VERIFY = {
    "required": ssl.CERT_REQUIRED,
    "optional": ssl.CERT_OPTIONAL,
    "none": ssl.CERT_NONE,
}


def _normalize_cert_path(path: Optional[str]) -> Optional[str]:
    """Return a plain filesystem path for a cert/CA input.

    Operators (and GCP tooling) commonly supply a ``file:`` URI —
    e.g. ``file:/etc/certs/redis-ca-bundle.pem`` or ``file:///etc/certs/ca.pem``.
    redis-py / ``ssl.load_verify_locations`` want a bare path and would try to
    open a file literally named ``file:/...`` (→ silent verify failure). Strip a
    leading ``file:`` scheme (and any authority slashes) and surrounding
    whitespace so both the URI and bare-path forms work. Anything without the
    scheme is returned unchanged.
    """
    if not path:
        return None
    p = path.strip()
    if p.lower().startswith("file:"):
        p = p[5:]
        while p.startswith("//"):        # file:///abs, file://abs
            p = p[2:]
    return p or None


@dataclass(frozen=True)
class TLSSettings:
    """Normalized TLS settings, shared by graph / cache / bus."""

    enabled: bool = False
    ca_certs: Optional[str] = None      # path to CA bundle (PEM)
    certfile: Optional[str] = None      # path to client cert (mTLS)
    keyfile: Optional[str] = None       # path to client key (mTLS)
    cert_reqs: str = "required"         # required | optional | none
    check_hostname: bool = True

    @classmethod
    def from_fields(
        cls,
        *,
        enabled: bool,
        ca_certs: Optional[str] = None,
        certfile: Optional[str] = None,
        keyfile: Optional[str] = None,
        cert_reqs: Optional[str] = None,
        check_hostname: Optional[bool] = None,
    ) -> "TLSSettings":
        reqs = (cert_reqs or "required").strip().lower()
        if reqs not in _VERIFY_MODES:
            logger.warning(
                "redis_tls: unknown cert_reqs %r — defaulting to 'required'.", reqs,
            )
            reqs = "required"
        # CERT_NONE is incompatible with hostname checking in ssl; force it off.
        check = bool(check_hostname) if check_hostname is not None else True
        if reqs == "none":
            check = False
        return cls(
            enabled=bool(enabled),
            ca_certs=_normalize_cert_path(ca_certs),
            certfile=_normalize_cert_path(certfile),
            keyfile=_normalize_cert_path(keyfile),
            cert_reqs=reqs,
            check_hostname=check,
        )


def _ssl_fields(tls: TLSSettings) -> dict:
    """The ``ssl_*`` kwargs common to both pool- and client-style construction."""
    kw: dict = {
        "ssl_cert_reqs": tls.cert_reqs,
        "ssl_check_hostname": tls.check_hostname,
    }
    if tls.ca_certs:
        kw["ssl_ca_certs"] = tls.ca_certs
    if tls.certfile:
        kw["ssl_certfile"] = tls.certfile
    if tls.keyfile:
        kw["ssl_keyfile"] = tls.keyfile
    return kw


def tls_pool_kwargs(tls: Optional[TLSSettings]) -> dict:
    """Kwargs for a raw ``redis.asyncio.ConnectionPool`` (graph/cluster node).

    Empty dict when TLS is disabled — caller's plaintext path is unchanged.
    """
    if not tls or not tls.enabled:
        return {}
    from redis.asyncio.connection import SSLConnection

    return {"connection_class": SSLConnection, **_ssl_fields(tls)}


def tls_client_kwargs(tls: Optional[TLSSettings]) -> dict:
    """Kwargs for high-level ``Redis`` / ``from_url`` / ``RedisCluster`` /
    ``Sentinel`` constructors. Empty dict when TLS is disabled."""
    if not tls or not tls.enabled:
        return {}
    return {"ssl": True, **_ssl_fields(tls)}


def build_ssl_context(tls: Optional[TLSSettings]) -> Optional["ssl.SSLContext"]:
    """Build an ``ssl.SSLContext`` for the raw-socket preflight probe, or
    ``None`` when TLS is disabled. Honors custom CA, client cert/key (mTLS),
    and verify mode."""
    if not tls or not tls.enabled:
        return None
    ctx = ssl.create_default_context(
        purpose=ssl.Purpose.SERVER_AUTH, cafile=tls.ca_certs,
    )
    ctx.check_hostname = tls.check_hostname
    ctx.verify_mode = _SSL_VERIFY.get(tls.cert_reqs, ssl.CERT_REQUIRED)
    if tls.certfile:
        # Client cert for mutual TLS (keyfile optional if the cert bundles it).
        ctx.load_cert_chain(certfile=tls.certfile, keyfile=tls.keyfile)
    return ctx
