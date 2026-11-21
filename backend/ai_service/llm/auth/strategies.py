"""The sign-in strategies. See the package docstring for what each is for."""
from __future__ import annotations

import asyncio
import base64
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Protocol

import httpx

from ..types import LlmError

logger = logging.getLogger(__name__)

#: The auth types a connection may have.
AUTH_TYPES = (
    "none", "api_key", "bearer", "basic", "oauth2_client_credentials", "token_mint",
)

#: The names that are secrets wherever they appear: written encrypted, never
#: returned, never logged.
SECRET_FIELDS = frozenset({"apiKey", "token", "password", "clientSecret"})


class AuthStrategy(Protocol):
    async def apply(self, headers: dict[str, str], params: dict[str, str]) -> None:
        """Add credentials to an outgoing request's headers or query."""

    async def invalidate(self) -> None:
        """The endpoint refused the credentials; forget any minted token."""


# ── Helpers ─────────────────────────────────────────────────────────────

_PATH_PART = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def json_path(document: Any, path: str) -> Any:
    """A value in *document* by a dotted path with list indexes:
    ``access_token``, ``data.token``, ``result[0].value``. ``None`` when any
    step is missing."""
    current = document
    for name, index in _PATH_PART.findall(path or ""):
        if index:
            if not isinstance(current, list) or int(index) >= len(current):
                return None
            current = current[int(index)]
        else:
            if not isinstance(current, Mapping) or name not in current:
                return None
            current = current[name]
    return current


_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def render_template(template: Any, values: Mapping[str, Any]) -> Any:
    """*template* with every ``{{name}}`` replaced from *values*, recursively
    through dicts and lists. A placeholder that is the whole string keeps the
    value's type; an unknown name becomes the empty string."""
    if isinstance(template, str):
        whole = _PLACEHOLDER.fullmatch(template.strip())
        if whole:
            return values.get(whole.group(1), "")
        return _PLACEHOLDER.sub(lambda m: str(values.get(m.group(1), "")), template)
    if isinstance(template, Mapping):
        return {k: render_template(v, values) for k, v in template.items()}
    if isinstance(template, list):
        return [render_template(v, values) for v in template]
    return template


def _require(values: Mapping[str, Any], *names: str, kind: str) -> None:
    missing = [n for n in names if not values.get(n)]
    if missing:
        raise LlmError(
            "not_configured", f"The {kind} sign-in needs {', '.join(missing)}.",
        )


# ── Static strategies ───────────────────────────────────────────────────


class NoAuth:
    async def apply(self, headers, params) -> None:
        return None

    async def invalidate(self) -> None:
        return None


@dataclass
class HeaderAuth:
    """A fixed value in a header or a query parameter."""

    value: str
    header: str = "Authorization"
    prefix: str = "Bearer"
    in_query: bool = False
    param: str = "api-key"

    async def apply(self, headers, params) -> None:
        if self.in_query:
            params[self.param] = self.value
            return
        headers[self.header] = f"{self.prefix} {self.value}".strip() if self.prefix else self.value

    async def invalidate(self) -> None:
        return None


# ── Minted tokens ───────────────────────────────────────────────────────


class TokenCache:
    """One minted token, refreshed by one caller at a time.

    A token is used until 80% of its life has passed, so a request never
    starts with one about to expire; with no expiry in the answer,
    ``default_ttl`` applies.
    """

    def __init__(self, mint, *, default_ttl: float = 3000.0, now=time.monotonic) -> None:
        self._mint = mint
        self._default_ttl = default_ttl
        self._now = now
        self._token: Optional[str] = None
        self._refresh_at = 0.0
        self._lock = asyncio.Lock()

    async def get(self) -> str:
        if self._token and self._now() < self._refresh_at:
            return self._token
        async with self._lock:
            if self._token and self._now() < self._refresh_at:
                return self._token
            token, ttl = await self._mint()
            life = ttl if ttl and ttl > 0 else self._default_ttl
            self._token = token
            self._refresh_at = self._now() + max(1.0, life * 0.8)
            return token

    def invalidate(self) -> None:
        self._token = None
        self._refresh_at = 0.0


@dataclass
class _MintSpec:
    token_url: str
    method: str = "POST"
    body_format: str = "form"  # form | json | none
    body: Optional[dict] = None
    headers: Optional[dict] = None
    basic_auth: bool = False
    token_path: str = "access_token"
    expires_path: str = "expires_in"
    token_header: str = "Authorization"
    token_prefix: str = "Bearer"
    default_ttl: float = 3000.0


class MintedTokenAuth:
    """A token obtained from a token URL, cached, used in a header."""

    def __init__(self, spec: _MintSpec, values: Mapping[str, Any], http) -> None:
        self._spec = spec
        self._values = dict(values)
        self._http = http
        self._cache = TokenCache(self._mint, default_ttl=spec.default_ttl)

    async def _mint(self) -> tuple[str, Optional[float]]:
        spec = self._spec
        headers = {"Accept": "application/json"}
        headers.update({k: str(v) for k, v in render_template(spec.headers or {}, self._values).items()})
        kwargs: dict[str, Any] = {"headers": headers}
        body = render_template(spec.body or {}, self._values)
        if spec.body_format == "json":
            kwargs["json"] = body
        elif spec.body_format == "form":
            kwargs["data"] = {k: str(v) for k, v in body.items()}
        if spec.basic_auth:
            user = str(self._values.get("clientId") or self._values.get("username") or "")
            secret = str(self._values.get("clientSecret") or self._values.get("password") or "")
            raw = base64.b64encode(f"{user}:{secret}".encode()).decode()
            headers["Authorization"] = f"Basic {raw}"
        response: httpx.Response = await self._http.request(spec.method, spec.token_url, **kwargs)
        if response.status_code in (401, 403):
            raise LlmError("auth", "The token endpoint refused the credentials.",
                           status=response.status_code)
        if response.status_code >= 400:
            raise LlmError(
                "unavailable" if response.status_code >= 500 else "bad_request",
                f"The token endpoint answered HTTP {response.status_code}.",
                status=response.status_code,
            )
        try:
            document = response.json()
        except ValueError as exc:
            raise LlmError("protocol", "The token endpoint did not answer with JSON.") from exc
        token = json_path(document, spec.token_path)
        if not isinstance(token, str) or not token:
            raise LlmError(
                "protocol", f"The token endpoint's answer has no token at {spec.token_path!r}.",
            )
        ttl = json_path(document, spec.expires_path) if spec.expires_path else None
        try:
            ttl_value = float(ttl) if ttl is not None else None
        except (TypeError, ValueError):
            ttl_value = None
        return token, ttl_value

    async def apply(self, headers, params) -> None:
        token = await self._cache.get()
        prefix = self._spec.token_prefix
        headers[self._spec.token_header] = f"{prefix} {token}".strip() if prefix else token

    async def invalidate(self) -> None:
        self._cache.invalidate()


# ── Factory ─────────────────────────────────────────────────────────────


def build_auth(
    auth_type: str, config: Mapping[str, Any], secrets: Mapping[str, Any], http,
) -> AuthStrategy:
    """The strategy for a connection. ``http`` is the guarded client token
    requests go through."""
    cfg = dict(config or {})
    sec = dict(secrets or {})
    if auth_type in (None, "", "none"):
        return NoAuth()
    if auth_type == "api_key":
        _require(sec, "apiKey", kind="API key")
        return HeaderAuth(
            value=str(sec["apiKey"]),
            header=str(cfg.get("header") or "Authorization"),
            prefix=str(cfg.get("prefix") if cfg.get("prefix") is not None else "Bearer"),
            in_query=(cfg.get("in") == "query"),
            param=str(cfg.get("param") or "api-key"),
        )
    if auth_type == "bearer":
        _require(sec, "token", kind="bearer token")
        return HeaderAuth(value=str(sec["token"]))
    if auth_type == "basic":
        _require(cfg, "username", kind="basic")
        _require(sec, "password", kind="basic")
        raw = base64.b64encode(f"{cfg['username']}:{sec['password']}".encode()).decode()
        return HeaderAuth(value=raw, prefix="Basic")
    values = {**cfg, **sec}
    if auth_type == "oauth2_client_credentials":
        _require(cfg, "tokenUrl", "clientId", kind="OAuth client-credentials")
        _require(sec, "clientSecret", kind="OAuth client-credentials")
        body: dict[str, Any] = {"grant_type": "client_credentials"}
        if cfg.get("scope"):
            body["scope"] = cfg["scope"]
        if cfg.get("audience"):
            body["audience"] = cfg["audience"]
        basic = cfg.get("clientAuth", "basic") == "basic"
        if not basic:
            body["client_id"] = "{{clientId}}"
            body["client_secret"] = "{{clientSecret}}"
        return MintedTokenAuth(
            _MintSpec(token_url=str(cfg["tokenUrl"]), body=body, basic_auth=basic), values, http,
        )
    if auth_type == "token_mint":
        _require(cfg, "tokenUrl", kind="token")
        body_format = cfg.get("bodyFormat") or "json"
        if body_format not in ("json", "form", "none"):
            raise LlmError("not_configured", "bodyFormat must be json, form or none.")
        default_body = {"username": "{{username}}", "password": "{{password}}"}
        return MintedTokenAuth(
            _MintSpec(
                token_url=str(cfg["tokenUrl"]),
                method=str(cfg.get("method") or "POST").upper(),
                body_format=body_format,
                body=cfg.get("body") if isinstance(cfg.get("body"), dict) else default_body,
                headers=cfg.get("headers") if isinstance(cfg.get("headers"), dict) else None,
                basic_auth=bool(cfg.get("basicAuth")),
                token_path=str(cfg.get("tokenPath") or "access_token"),
                expires_path=str(cfg.get("expiresPath") if cfg.get("expiresPath") is not None else "expires_in"),
                token_header=str(cfg.get("tokenHeader") or "Authorization"),
                token_prefix=str(cfg.get("tokenPrefix") if cfg.get("tokenPrefix") is not None else "Bearer"),
                default_ttl=float(cfg.get("defaultTtlSeconds") or 3000),
            ),
            values, http,
        )
    raise LlmError("not_configured", f"Unknown sign-in method {auth_type!r}.")


def describe_auth_fields() -> dict[str, dict[str, list[str]]]:
    """Which fields each auth type reads — for the admin form and validation."""
    return {
        "none": {"config": [], "secrets": []},
        "api_key": {"config": ["header", "prefix", "in", "param"], "secrets": ["apiKey"]},
        "bearer": {"config": [], "secrets": ["token"]},
        "basic": {"config": ["username"], "secrets": ["password"]},
        "oauth2_client_credentials": {
            "config": ["tokenUrl", "clientId", "scope", "audience", "clientAuth"],
            "secrets": ["clientSecret"],
        },
        "token_mint": {
            "config": [
                "tokenUrl", "method", "bodyFormat", "body", "headers", "basicAuth",
                "username", "clientId", "tokenPath", "expiresPath", "tokenHeader",
                "tokenPrefix", "defaultTtlSeconds",
            ],
            "secrets": ["password", "clientSecret"],
        },
    }
