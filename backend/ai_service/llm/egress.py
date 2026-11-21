"""The one HTTP client every outbound call of this service goes through.

Completion endpoints, token endpoints and MCP servers are URLs an
administrator typed, so each request is held to the shared network guard
(``backend.common.netguard``) before its connection opens:

* loopback, link-local (cloud metadata) and other non-routable addresses are
  refused, whatever the allowlist says;
* a private address is refused unless its ``host:port`` is in
  ``AI_EGRESS_ALLOWED_HOSTS`` — set by an operator, not from the UI, because
  "may this service reach that internal host" is a network decision;
* plain ``http`` is refused in production;
* redirects are never followed — a 30x to an internal address is the
  standard way around a pre-flight check.

Corporate CAs: ``AI_OUTBOUND_TLS_CA_CERTS`` names a PEM bundle trusted in
addition to the public roots.
"""
from __future__ import annotations

import asyncio
import logging
import os
import ssl
from typing import Optional
from urllib.parse import urlsplit

import certifi
import httpx

from backend.common import netguard

from .types import LlmError

logger = logging.getLogger(__name__)

CA_BUNDLE_ENV = "AI_OUTBOUND_TLS_CA_CERTS"
_PROD = {"prod", "production"}
_ssl_cache: dict[str, ssl.SSLContext] = {}


def _verify() -> ssl.SSLContext | bool:
    path = os.getenv(CA_BUNDLE_ENV, "").strip()
    if path.startswith("file://"):
        path = path[len("file://"):]
    if not path:
        return True
    ctx = _ssl_cache.get(path)
    if ctx is None:
        try:
            ctx = ssl.create_default_context(cafile=certifi.where())
            ctx.load_verify_locations(cafile=path)
        except (OSError, ssl.SSLError) as exc:
            logger.error("%s names %r, which cannot be loaded (%s); using the system roots.",
                         CA_BUNDLE_ENV, path, exc)
            return True
        _ssl_cache[path] = ctx
    return ctx


def check_destination(url: str, allow_hosts: frozenset[str]) -> None:
    """Raise ``LlmError('refused_destination')`` unless *url* may be reached."""
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise LlmError("refused_destination", f"{scheme or 'relative'!r} URLs cannot be called.")
    if scheme == "http" and os.getenv("ENV", "dev").strip().lower() in _PROD:
        raise LlmError(
            "refused_destination",
            "Plain http is refused in production: a model endpoint sees your questions and data.",
        )
    try:
        netguard.assert_url_connectable(url, allow_hosts=allow_hosts)
    except netguard.AddressRefused as exc:
        hint = (
            " Ask an operator to add it to AI_EGRESS_ALLOWED_HOSTS."
            if exc.reason == "private_address_not_allowlisted" else ""
        )
        raise LlmError("refused_destination", f"{exc}{hint}") from exc


class GuardedClient:
    """An ``httpx.AsyncClient`` whose every request is checked first.

    ``transport`` is for tests (an ``httpx.MockTransport``); with one set the
    address check is skipped, since nothing leaves the process.
    """

    def __init__(
        self, *, allow_hosts: frozenset[str] = frozenset(), timeout: float = 60.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._allow = allow_hosts
        self._checked = transport is None
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=min(10.0, timeout)),
            follow_redirects=False,
            verify=_verify() if transport is None else True,
            transport=transport,
        )

    async def _check(self, url: str) -> None:
        if self._checked:
            await asyncio.to_thread(check_destination, url, self._allow)

    async def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        await self._check(url)
        try:
            return await self._client.request(method, url, **kwargs)
        except httpx.TimeoutException as exc:
            raise LlmError("timeout", "The endpoint did not answer in time.") from exc
        except httpx.HTTPError as exc:
            raise LlmError("unavailable", f"The endpoint could not be reached ({type(exc).__name__}).") from exc

    def stream(self, method: str, url: str, **kwargs):
        """An async context manager over a streamed response; checked first."""
        return _StreamContext(self, method, url, kwargs)

    async def aclose(self) -> None:
        await self._client.aclose()


class _StreamContext:
    def __init__(self, owner: GuardedClient, method: str, url: str, kwargs: dict) -> None:
        self._owner, self._method, self._url, self._kwargs = owner, method, url, kwargs
        self._cm = None

    async def __aenter__(self) -> httpx.Response:
        await self._owner._check(self._url)
        self._cm = self._owner._client.stream(self._method, self._url, **self._kwargs)
        try:
            return await self._cm.__aenter__()
        except httpx.TimeoutException as exc:
            raise LlmError("timeout", "The endpoint did not answer in time.") from exc
        except httpx.HTTPError as exc:
            raise LlmError("unavailable", f"The endpoint could not be reached ({type(exc).__name__}).") from exc

    async def __aexit__(self, *exc_info):
        if self._cm is not None:
            return await self._cm.__aexit__(*exc_info)
        return False
