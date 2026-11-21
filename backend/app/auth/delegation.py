"""Read-only delegation: the AI service reading the platform as the person it serves.

The AI service (``backend/ai_service``) answers a person's questions by calling
this API — searches, traces, schema, views — and must see exactly what that
person may see, no more. It holds no data access of its own. For each turn the
web tier, which has already authenticated the person, mints a short-lived
**delegation token** and hands it to the AI service with the proxied request;
the AI service presents it as ``Authorization: Bearer nxdlg_…`` on every call it
makes back.

A delegation token is accepted by ``api_key_auth`` on the same path as an API
key, so everything that holds a key holds it too: the deny-by-default endpoint
surface (``api_key_surface``), the resource fence, and claims built from the
person's *live* authority narrowed by a scope (``resolve_for_api_key``). Its
scope is always **read-only** — views ``read`` and data ``read`` at most — so a
prompt that talks the model into "delete this view" reaches a route that
refuses it, whatever the model asks. Native queries refuse it too, as they
refuse every key.

What a token carries:

* ``sub`` — the person; ``sid`` — the session it came from (a revoked session
  stops its tokens on their next use); ``key`` — the API key the request came
  with, when it came with one (the MCP surface), whose scope the token's is
  intersected with, never widened past;
* ``scope`` — ``views``/``data`` levels and a resource selection (``all`` or
  workspaces, views and data sources);
* ``conv`` — the conversation, for attribution; ``exp`` — one turn's length.

Signed with HS256 under ``AI_DELEGATION_SIGNING_KEY`` when it is set, otherwise
under a key derived from ``JWT_SECRET_KEY`` with a fixed label — a different key
from the session tokens', with a different audience and type, so neither kind of
token can ever pass for the other.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

import jwt as pyjwt

#: The bearer prefix. Recognised by ``bearer_api_key`` so a delegated request
#: takes the key path (cookies dropped, no CSRF) and no other.
PREFIX = "nxdlg_"

ISSUER = "synodic-web"
AUDIENCE = "synodic-ai-delegation"
TOKEN_TYPE = "ai-delegation"
ALGORITHM = "HS256"

#: Longest a token may live. A turn is bounded well under this
#: (``AI_TURN_TIMEOUT_SECONDS`` in the AI service); the ceiling stops a
#: misconfigured caller minting long-lived credentials.
MAX_TTL_SECONDS = 600
DEFAULT_TTL_SECONDS = 240

_LEVELS = ("none", "read")
_DERIVATION_LABEL = b"synodic-ai-delegation-v1"


class DelegationInvalid(ValueError):
    """The token is malformed, forged, expired or for something else."""


@dataclass(frozen=True)
class DelegationScope:
    """What a delegated request may reach — read-only by construction."""

    views: str = "read"
    data: str = "read"
    all_resources: bool = True
    workspaces: frozenset[str] = frozenset()
    view_ids: frozenset[str] = frozenset()
    data_source_ids: frozenset[str] = frozenset()

    def to_claim(self) -> dict[str, Any]:
        resources: Any = "all" if self.all_resources else {
            "workspaces": sorted(self.workspaces),
            "views": sorted(self.view_ids),
            "dataSources": sorted(self.data_source_ids),
        }
        return {"views": self.views, "data": self.data, "resources": resources}

    @classmethod
    def from_claim(cls, raw: Any) -> "DelegationScope":
        """Parse a scope claim; anything unrecognised reads as the narrowest
        value, so a malformed claim costs reach and never adds it."""
        body = raw if isinstance(raw, Mapping) else {}
        views = body.get("views") if body.get("views") in _LEVELS else "none"
        data = body.get("data") if body.get("data") in _LEVELS else "none"
        resources = body.get("resources")
        if resources == "all":
            return cls(views=views, data=data, all_resources=True)
        selection = resources if isinstance(resources, Mapping) else {}

        def _ids(key: str) -> frozenset[str]:
            value = selection.get(key)
            if not isinstance(value, (list, tuple)):
                return frozenset()
            return frozenset(x for x in value if isinstance(x, str) and x)

        return cls(
            views=views, data=data, all_resources=False,
            workspaces=_ids("workspaces"), view_ids=_ids("views"),
            data_source_ids=_ids("dataSources"),
        )


@dataclass(frozen=True)
class DelegationGrant:
    """A verified token."""

    token_id: str
    user_id: str
    session_id: str
    conversation_id: str
    parent_key_id: Optional[str]
    scope: DelegationScope
    expires_at: int
    extra: Mapping[str, Any] = field(default_factory=dict)


def _signing_key() -> bytes:
    explicit = os.getenv("AI_DELEGATION_SIGNING_KEY", "").strip()
    if explicit:
        if len(explicit) < 32:
            raise DelegationInvalid(
                "AI_DELEGATION_SIGNING_KEY is too weak; use at least 32 characters.",
            )
        return explicit.encode("utf-8")
    from backend.auth_service.core import config  # the session key ring

    return hmac.new(
        config.JWT_SECRET_KEY.encode("utf-8"), _DERIVATION_LABEL, hashlib.sha256,
    ).digest()


def _narrowest(*levels: str) -> str:
    return "read" if all(level in ("read", "write") for level in levels) else "none"


def narrow_to_key(scope: DelegationScope, key_scope) -> DelegationScope:
    """*scope* held to an API key's own scope: never more than the key covers,
    and never more than reading.

    ``key_scope`` is a ``permission_service.KeyScope``. A key limited to some
    workspaces, views or data sources passes that selection on; a key that
    covers everything passes *scope*'s own selection on.
    """
    views = _narrowest(scope.views, key_scope.views)
    data = _narrowest(scope.data, key_scope.data)
    if key_scope.all_resources:
        return DelegationScope(
            views=views, data=data, all_resources=scope.all_resources,
            workspaces=scope.workspaces, view_ids=scope.view_ids,
            data_source_ids=scope.data_source_ids,
        )
    if scope.all_resources:
        return DelegationScope(
            views=views, data=data, all_resources=False,
            workspaces=frozenset(key_scope.workspaces),
            view_ids=frozenset(key_scope.view_ids),
            data_source_ids=frozenset(key_scope.data_source_ids),
        )
    # Both select: what both reach. A workspace the key covers whole admits
    # everything *scope* selects inside it; otherwise only the ids both name.
    key_ws = frozenset(key_scope.workspaces)
    return DelegationScope(
        views=views, data=data, all_resources=False,
        workspaces=scope.workspaces & key_ws,
        view_ids=(scope.view_ids & frozenset(key_scope.view_ids)) | (
            scope.view_ids if key_ws else frozenset()
        ),
        data_source_ids=(
            scope.data_source_ids & frozenset(key_scope.data_source_ids)
        ) | (scope.data_source_ids if key_ws else frozenset()),
    )


def mint(
    *,
    user_id: str,
    session_id: str = "",
    conversation_id: str = "",
    scope: Optional[DelegationScope] = None,
    parent_key_id: Optional[str] = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    now: Optional[float] = None,
) -> str:
    """A delegation token for *user_id*, valid for *ttl_seconds*."""
    if not user_id:
        raise DelegationInvalid("A delegation needs a person to act for.")
    issued = int(now if now is not None else time.time())
    ttl = max(1, min(int(ttl_seconds), MAX_TTL_SECONDS))
    payload = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "typ": TOKEN_TYPE,
        "sub": user_id,
        "sid": session_id or "",
        "conv": (conversation_id or "")[:64],
        "key": parent_key_id or None,
        "jti": secrets.token_urlsafe(12),
        "iat": issued,
        "exp": issued + ttl,
        "scope": (scope or DelegationScope()).to_claim(),
    }
    return PREFIX + pyjwt.encode(payload, _signing_key(), algorithm=ALGORITHM)


def looks_like(token: Optional[str]) -> bool:
    return bool(token) and token.startswith(PREFIX)


def verify(token: str, *, now: Optional[float] = None) -> DelegationGrant:
    """The grant *token* carries. Raises :class:`DelegationInvalid` for
    anything that is not a live token this deployment minted."""
    if not looks_like(token):
        raise DelegationInvalid("Not a delegation token.")
    body = token[len(PREFIX):]
    options = {"require": ["exp", "iat", "sub", "aud", "iss"]}
    try:
        payload = pyjwt.decode(
            body, _signing_key(), algorithms=[ALGORITHM], audience=AUDIENCE,
            issuer=ISSUER, options=options, leeway=0,
        )
    except pyjwt.ExpiredSignatureError as exc:
        raise DelegationInvalid("The delegation has expired.") from exc
    except pyjwt.InvalidTokenError as exc:
        raise DelegationInvalid("The delegation token is not valid.") from exc
    if now is not None and int(payload.get("exp", 0)) <= int(now):
        raise DelegationInvalid("The delegation has expired.")
    if payload.get("typ") != TOKEN_TYPE:
        raise DelegationInvalid("The delegation token is not valid.")
    if int(payload["exp"]) - int(payload["iat"]) > MAX_TTL_SECONDS:
        raise DelegationInvalid("The delegation lives longer than any may.")
    return DelegationGrant(
        token_id=str(payload.get("jti") or ""),
        user_id=str(payload["sub"]),
        session_id=str(payload.get("sid") or ""),
        conversation_id=str(payload.get("conv") or ""),
        parent_key_id=payload.get("key") or None,
        scope=DelegationScope.from_claim(payload.get("scope")),
        expires_at=int(payload["exp"]),
    )


__all__ = [
    "PREFIX", "DelegationGrant", "DelegationInvalid", "DelegationScope",
    "looks_like", "mint", "narrow_to_key", "verify",
]
