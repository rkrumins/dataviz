"""Configurable IdP claim mapping.

Each :class:`~.base.IdentityProvider` (OIDC, SAML, Custom) hands a
dict of "claims-as-the-IdP-asserted-them" to this module along with
the operator-configured mapping spec. We return a fully populated
:class:`ProviderIdentity` plus a free-form ``attributes`` dict
carrying any operator-defined extras (department, employee_id,
manager, etc.).

The mapping spec shape:

.. code-block:: python

    {
        "external_id":    ["sub"],                   # required
        "email":          ["email", "mail"],         # required
        "email_verified": ["email_verified"],        # boolean-ish
        "first_name":     ["given_name", "givenName"],
        "last_name":      ["family_name", "surname", "sn"],
        "display_name":   ["name", "displayName"],
        "groups":         ["groups", "wids", "roles"],
        "auth_time":      ["auth_time"],
        "extras": {
            "department":  ["department", "extension_Department"],
            "employee_id": ["employeeid", "employee_id"],
        },
    }

* Each top-level value is a **list of candidate claim paths** walked
  in order — first non-empty win. Empty list / unset key means
  "fall back to the kind's default" (see ``DEFAULT_OIDC`` /
  ``DEFAULT_SAML`` / ``DEFAULT_CUSTOM``).
* ``extras`` is an operator-defined map; every value lands in
  ``ProviderIdentity.attributes`` keyed by the dict key (NOT the
  source claim).
* Claim paths are dotted JSONPath-lite: ``"profile.given_name"``,
  ``"address.country[0]"``. No wildcards.

This module is **pure** — no DB, no network, no logging side
effects. Easy to unit-test, easy to call from the SAML / OIDC /
Custom providers identically.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from .base import ProviderIdentity


# ── Defaults per IdP kind ────────────────────────────────────────────


DEFAULT_OIDC: dict[str, Any] = {
    "external_id":    ["sub"],
    "email":          ["email"],
    "email_verified": ["email_verified"],
    "first_name":     ["given_name", "givenName"],
    "last_name":      ["family_name", "surname"],
    "display_name":   ["name", "displayName"],
    "groups":         ["groups", "wids", "roles"],
    "auth_time":      ["auth_time"],
    "extras":         {},
}


# SAML attribute statements typically come keyed by URI strings; the
# defaults here cover the common Entra ID / ADFS / Okta layouts.
DEFAULT_SAML: dict[str, Any] = {
    "external_id":    ["__name_id__"],
    "email":          [
        "email", "mail",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    ],
    "email_verified": ["email_verified"],
    "first_name":     [
        "given_name", "givenName", "firstName",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    ],
    "last_name":      [
        "family_name", "surname", "lastName", "sn",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
    ],
    "display_name":   [
        "name", "displayName",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    ],
    "groups":         [
        "groups", "memberOf", "Groups",
        "http://schemas.xmlsoap.org/claims/Group",
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    ],
    "auth_time":      ["__authn_instant__"],
    "extras":         {},
}


DEFAULT_CUSTOM: dict[str, Any] = {
    "external_id":    ["external_id"],
    "email":          ["email"],
    "email_verified": ["email_verified"],
    "first_name":     ["first_name"],
    "last_name":      ["last_name"],
    "display_name":   ["display_name"],
    "groups":         ["groups"],
    "auth_time":      ["auth_time"],
    "extras":         {},
}


# A corporate portal hands us whatever shape its own user object has.
# The candidate lists below cover the casings we see in practice
# (camelCase JS objects, snake_case APIs, LDAP-ish names) so most
# integrations need no override at all.
DEFAULT_CUSTOM_PROFILE: dict[str, Any] = {
    "external_id":    ["sub", "userId", "user_id", "employeeId", "uid", "email"],
    "email":          ["email", "emailAddress", "email_address", "mail", "upn"],
    "email_verified": ["email_verified", "emailVerified"],
    "first_name":     ["firstName", "first_name", "givenName", "given_name"],
    "last_name":      ["lastName", "last_name", "surname", "family_name", "sn"],
    "display_name":   ["fullName", "full_name", "displayName", "display_name", "name"],
    "groups":         ["groups", "roles", "memberOf"],
    "auth_time":      ["auth_time", "authTime", "iat"],
    "extras":         {},
}


KIND_DEFAULTS = {
    "oidc":           DEFAULT_OIDC,
    "saml2":          DEFAULT_SAML,
    "custom":         DEFAULT_CUSTOM,
    "custom_profile": DEFAULT_CUSTOM_PROFILE,
}


# ── JSONPath-lite resolver ───────────────────────────────────────────


_PATH_SEGMENT = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def _resolve(claims: Any, path: str) -> Any:
    """Walk a dotted/indexed path through *claims*. Returns ``None``
    if any segment is missing or has the wrong shape."""
    if not isinstance(path, str) or not path:
        return None
    cur: Any = claims
    pos = 0
    while pos < len(path):
        m = _PATH_SEGMENT.match(path, pos)
        if m is None:
            return None
        key, idx = m.group(1), m.group(2)
        if key is not None:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
        else:  # idx
            if not isinstance(cur, (list, tuple)):
                return None
            i = int(idx)
            if i < 0 or i >= len(cur):
                return None
            cur = cur[i]
        if cur is None:
            return None
        # Skip an optional separator dot between segments.
        pos = m.end()
        if pos < len(path) and path[pos] == ".":
            pos += 1
    return cur


def _first_non_empty(claims: dict, paths: Iterable[str]) -> Any:
    """Walk every path in order; return the first non-empty result."""
    for p in paths or ():
        v = _resolve(claims, p)
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        if isinstance(v, (list, tuple)) and len(v) == 0:
            continue
        return v
    return None


# ── Field normalisers ────────────────────────────────────────────────


def _to_str(v: Any, default: str = "") -> str:
    if v is None:
        return default
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (list, tuple)) and v:
        # Take the first element if a multi-valued claim slipped through.
        return _to_str(v[0], default)
    return str(v)


def _to_email(v: Any) -> str:
    return _to_str(v).lower()


def _to_groups(v: Any) -> tuple[str, ...]:
    """Normalise group claim shapes. Accepts list-of-strings, single
    string, comma-separated string. Filters out blanks; preserves
    input order."""
    if v is None:
        return ()
    if isinstance(v, str):
        if "," in v:
            return tuple(g.strip() for g in v.split(",") if g.strip())
        v = v.strip()
        return (v,) if v else ()
    if isinstance(v, (list, tuple)):
        out: list[str] = []
        for item in v:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
        return tuple(out)
    return ()


def _to_bool(v: Any) -> bool:
    if v is True:
        return True
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "t"}
    return False


def _to_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ── Public surface ───────────────────────────────────────────────────


def merge_mapping(kind: str, override: dict | None) -> dict:
    """Return the effective mapping for *kind*, layering *override*
    on top of the kind's defaults. Unknown keys in *override* are
    preserved (so ``extras`` round-trips). Empty/None *override*
    yields the defaults verbatim.

    Falls back to ``DEFAULT_CUSTOM`` for unknown kinds rather than
    raising — the registry never instantiates an unknown kind in
    practice, but defensive behaviour beats a 500.
    """
    base = KIND_DEFAULTS.get(kind, DEFAULT_CUSTOM)
    if not override:
        return dict(base)
    merged = {**base}
    for key, val in override.items():
        if key == "extras" and isinstance(val, dict):
            merged_extras = dict(base.get("extras", {}))
            merged_extras.update(val)
            merged["extras"] = merged_extras
        else:
            merged[key] = val
    return merged


def apply_claim_mapping(
    claims: dict,
    *,
    kind: str,
    provider_slug: str,
    override: dict | None = None,
) -> ProviderIdentity:
    """Materialise a :class:`ProviderIdentity` from a claims dict and
    operator-configured mapping spec.

    ``claims`` carries the IdP's assertion in its native shape — for
    OIDC it's the decoded id_token dict; for SAML it's the
    attribute-statement dict augmented with synthetic keys
    ``__name_id__`` and ``__authn_instant__`` (the SAML provider
    injects these); for Custom it's the signed cookie payload.

    Raises :class:`ClaimMappingError` when a required field (currently
    ``external_id`` and ``email``) cannot be resolved.
    """
    mapping = merge_mapping(kind, override)

    external_id = _to_str(
        _first_non_empty(claims, mapping.get("external_id") or [])
    )
    email = _to_email(_first_non_empty(claims, mapping.get("email") or []))
    if not external_id:
        raise ClaimMappingError(
            f"Claim mapping for provider '{provider_slug}' could not "
            "resolve external_id from the IdP claims."
        )
    if not email:
        raise ClaimMappingError(
            f"Claim mapping for provider '{provider_slug}' could not "
            "resolve email from the IdP claims."
        )

    first_name = _to_str(_first_non_empty(claims, mapping.get("first_name") or []))
    last_name = _to_str(_first_non_empty(claims, mapping.get("last_name") or []))
    display_name = _to_str(_first_non_empty(claims, mapping.get("display_name") or []))
    if not first_name and not last_name and display_name:
        # Best-effort split: "Alice Doe" -> ("Alice", "Doe").
        parts = display_name.split(None, 1)
        first_name = parts[0]
        if len(parts) > 1:
            last_name = parts[1]

    groups = _to_groups(_first_non_empty(claims, mapping.get("groups") or []))
    auth_time = _to_int(_first_non_empty(claims, mapping.get("auth_time") or []))

    email_verified_raw = _first_non_empty(
        claims, mapping.get("email_verified") or []
    )
    email_verified = _to_bool(email_verified_raw) if email_verified_raw is not None else False

    extras_spec: dict = mapping.get("extras") or {}
    extras: dict[str, Any] = {}
    for internal_key, paths in extras_spec.items():
        if not isinstance(internal_key, str) or not internal_key:
            continue
        if not isinstance(paths, (list, tuple)):
            continue
        v = _first_non_empty(claims, paths)
        if v is None:
            continue
        # Lists land verbatim (multi-valued attribute), other values stringified.
        extras[internal_key] = v if isinstance(v, (list, tuple)) else _to_str(v)

    raw_claims_for_audit: dict = {
        "kind": kind,
        "claims": claims,
        "email_verified": email_verified,
    }

    return ProviderIdentity(
        provider=kind,
        external_id=external_id,
        email=email,
        first_name=first_name,
        last_name=last_name,
        raw_claims=raw_claims_for_audit,
        groups=groups,
        auth_time=auth_time,
        attributes=extras,
    )


class ClaimMappingError(Exception):
    """A required mapped field (``external_id`` or ``email``) was
    missing from the IdP claims. Routes turn this into a generic
    ``unsafe_login_rejected`` failure; the precise message is
    audited, not surfaced to the user."""
