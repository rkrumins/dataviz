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
from datetime import datetime, timezone
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
    # ``entitlements.groups`` is a dotted path, not a key: directories
    # that nest their membership under an entitlements object (a common
    # AD-federation shape) work without an override. Last, so a
    # top-level claim always wins — and any other nesting is one dotted
    # override away in the mapping studio.
    "groups":         ["groups", "wids", "roles", "entitlements.groups"],
    "auth_time":      ["auth_time"],
    # Empty by default outside the backchannel kind: mapping a picture
    # makes the server fetch it at login, and that participation is a
    # per-connection choice, not a surprise. An explicit override is
    # the opt-in for the other kinds.
    "avatar_url":     [],
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
        # The SAML-native full-name attributes: Shibboleth/eduPerson
        # release cn as urn:oid:2.5.4.3, ADFS offers the MS claim URI.
        "cn", "commonName", "urn:oid:2.5.4.3",
        "http://schemas.microsoft.com/identity/claims/displayname",
    ],
    "groups":         [
        "groups", "memberOf", "Groups",
        "http://schemas.xmlsoap.org/claims/Group",
        "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    ],
    "auth_time":      ["__authn_instant__"],
    "avatar_url":     [],
    "extras":         {},
}


DEFAULT_CUSTOM: dict[str, Any] = {
    "external_id":    ["external_id"],
    "email":          ["email"],
    "email_verified": ["email_verified"],
    "first_name":     ["first_name"],
    "last_name":      ["last_name"],
    # The grab-bag the other custom-ish kinds carry: a custom IdP that
    # releases only "name" or "fullName" deserves the split too.
    "display_name":   ["display_name", "displayName", "fullName",
                       "full_name", "name"],
    "groups":         ["groups", "entitlements.groups"],
    "auth_time":      ["auth_time"],
    "avatar_url":     [],
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
    "groups":         ["groups", "roles", "memberOf", "entitlements.groups"],
    "auth_time":      ["auth_time", "authTime", "iat"],
    "avatar_url":     [],
    "extras":         {},
}


# A back-channel gateway returns its own user object over an API, so the
# casings are the same grab-bag a portal payload uses. The one real
# difference is ``auth_time``: ``iat`` is NOT a candidate here, because
# there is no token being read — an ``iat`` in the claims would be the
# exchange response's own age, not the moment the user authenticated,
# and silently satisfying the 24h re-auth ceiling with it would defeat
# the ceiling.
DEFAULT_BACKCHANNEL: dict[str, Any] = {
    "external_id":    ["sub", "userId", "user_id", "employeeId", "uid", "email"],
    "email":          ["email", "emailAddress", "email_address", "mail", "upn"],
    "email_verified": ["email_verified", "emailVerified"],
    "first_name":     ["firstName", "first_name", "givenName", "given_name"],
    "last_name":      ["lastName", "last_name", "surname", "family_name", "sn"],
    "display_name":   ["fullName", "full_name", "displayName", "display_name", "name"],
    "groups":         ["groups", "roles", "memberOf", "groupMembership",
                       "entitlements.groups"],
    "auth_time":      ["auth_time", "authTime", "authenticationTime",
                       "lastLogin", "last_login"],
    #: Candidates only; nothing is fetched unless the connection's
    #: ``map_avatar`` toggle is on. The grab-bag matches the casings the
    #: other fields already cover.
    "avatar_url":     ["picture", "avatarUrl", "avatar_url", "photoUrl",
                       "photo"],
    "extras":         {},
}


KIND_DEFAULTS = {
    "oidc":           DEFAULT_OIDC,
    "saml2":          DEFAULT_SAML,
    "custom":         DEFAULT_CUSTOM,
    "custom_profile": DEFAULT_CUSTOM_PROFILE,
    "backchannel":    DEFAULT_BACKCHANNEL,
}


# ── JSONPath-lite resolver ───────────────────────────────────────────


_PATH_SEGMENT = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def _resolve(claims: Any, path: str) -> Any:
    """Walk a dotted/indexed path through *claims*. Returns ``None``
    if any segment is missing or has the wrong shape.

    An exact-match top-level key wins before any walking: SAML
    attribute names and OID URNs — ``urn:oid:2.5.4.3``,
    ``http://schemas.xmlsoap.org/...`` — contain dots that are part of
    the NAME, not a path, and without this rule they could never
    resolve at all (which quietly deadened every URI candidate in the
    SAML defaults)."""
    if not isinstance(path, str) or not path:
        return None
    if isinstance(claims, dict) and path in claims:
        v = claims[path]
        if v is not None:
            return v
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


#: Public name for the walker above. ``backchannel`` resolves operator-
#: configured paths into arbitrary API responses with it, and reaching
#: for the underscored name across modules would misreport it as
#: private to this one.
resolve_path = _resolve


#: Top-level values a populated nested one may overwrite during a
#: hoist. Membership is by equality on purpose: ``0`` and ``False`` are
#: real answers a directory can give and must never read as absent.
_EMPTYISH = (None, "", [], {})


def hoist_nested(claims: dict, *, priority: tuple[str, ...] = ()) -> dict:
    """One level of object nesting flattened — whatever the container
    is called — so a mapping can say ``groups`` even when the payload
    says ``{"entitlements": {"groups": [...]}}``, or nests under a name
    nobody predicted.

    Merge rules, in order:

    * A top-level key wins over a hoisted one — except when its value
      is emptyish (``None``, ``""``, ``[]``, ``{}``) and the nested one
      is not. Real gateways emit exactly that shape: a vestigial
      top-level ``groups: []`` beside the real list one level down, and
      "present but empty shadows populated" silently turned group
      mapping off.
    * Containers named in *priority* hoist first, in that order, so
      precedence between the well-known container names stays exactly
      what it always was.
    * Every other object-valued key follows, in payload order —
      deterministic per payload, and when two containers disagree the
      mapping studio's preview names which key actually supplied each
      field.

    One level only, by design: dotted candidate paths already reach any
    depth, and a recursive flatten would make "which value won" an
    accident — a hoisted inner object is itself reachable by its dotted
    path afterwards. Pure, so the login and the admin preview run the
    very same hoist.
    """
    flat = {**claims}
    ordered = [c for c in priority if c in claims]
    ordered += [k for k in claims if k not in priority]
    for container in ordered:
        nested = claims.get(container)
        if not isinstance(nested, dict):
            continue
        for k, v in nested.items():
            if k not in flat:
                flat[k] = v
            elif flat[k] in _EMPTYISH and v not in _EMPTYISH:
                flat[k] = v
    return flat


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


def _winning_path(claims: dict, paths: Any) -> str | None:
    """Which candidate in *paths* actually supplied a value.

    The companion to ``_first_non_empty``: same walk, same emptiness rules,
    reporting the path instead of the value. Both the preview's provenance
    and the display-name fallback need to name a claim rather than read
    one, and a second walk that disagreed about "empty" would report a
    source the login does not use.
    """
    if not isinstance(paths, (list, tuple)):
        return None
    for p in paths:
        if isinstance(p, str) and _first_non_empty(claims, [p]) is not None:
            return p
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
    """Normalise group claim shapes. Filters out blanks; preserves
    input order.

    Accepted shapes, matching what enterprise directories actually
    release:

    * list/tuple — strings kept (stripped); numeric ids stringified
      (many directories key groups by number). Booleans and everything
      else are dropped, not stringified: ``"True"`` is not a group.
      Items are never split further — a list is already delimited, so a
      DN item keeps its commas.
    * a string containing ``=`` — ONE group. LDAP DNs
      (``CN=Data Analysts,OU=Groups,DC=corp``) are the commonest group
      shape here, and splitting one on its commas shreds a single name
      into unmappable fragments.
    * any other string — split on commas or semicolons.
    * a bare numeric id — a one-group tuple.
    """
    if v is None:
        return ()
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return ()
        if "=" in s:
            return (s,)
        if "," in s or ";" in s:
            return tuple(g.strip() for g in re.split(r"[;,]", s) if g.strip())
        return (s,)
    if isinstance(v, bool):
        # Checked before int — bool is an int subclass.
        return ()
    if isinstance(v, int):
        return (str(v),)
    if isinstance(v, (list, tuple)):
        out: list[str] = []
        for item in v:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
            elif isinstance(item, bool):
                continue
            elif isinstance(item, int):
                out.append(str(item))
        return tuple(out)
    return ()


def _to_bool(v: Any) -> bool:
    if v is True:
        return True
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "t"}
    return False


def split_display_name(display_name: str) -> tuple[str, str]:
    """Best-effort ``(first_name, last_name)`` from one full-name string.

    Plenty of directories release a single name claim and nothing else —
    ``name`` on OIDC, ``fullName`` on a corporate portal — so without this
    those people arrive with no name at all.

    Two orders, because Active Directory's ``cn`` convention is
    *Last, First* and it is common enough that a naive whitespace split
    puts the surname in the first-name box with a comma still attached:

    * A comma separates the two halves, family name first, so
      ``"Doe, Alice"`` is Alice Doe. Only when both halves survive
      stripping — a trailing comma is punctuation, not a structure.
    * Otherwise the first whitespace-delimited token is the given name and
      the remainder is the family name, so ``"Maria del Carmen García"``
      keeps the particle with the surname where it belongs.

    Nothing here is more than a guess, which is precisely why a name that
    came out of this function is not treated as IdP-owned — see
    ``identity_provenance``. A single token (``"Prince"``) and a script
    that does not delimit at all (``"山田太郎"``) both land whole in the
    first name, because inventing a division would be worse than leaving
    one field empty.
    """
    text = (display_name or "").strip()
    if not text:
        return "", ""
    if "," in text:
        family, _, given = text.partition(",")
        if family.strip() and given.strip():
            return given.strip(), family.strip()
    # A comma that did NOT split the name is punctuation — "Alice Doe,"
    # must not store a surname of "Doe,".
    text = text.strip(",").strip()
    if not text:
        return "", ""
    parts = text.split(None, 1)
    return parts[0], parts[1].strip() if len(parts) > 1 else ""


def _to_epoch(v: Any) -> int | None:
    """Coerce an authentication-instant claim to epoch seconds.

    IdPs disagree about the shape: OIDC sends epoch seconds, but the
    gateway kinds routinely answer with epoch *milliseconds* or an
    ISO-8601 timestamp (``lastLogin``). A value that parses under none
    of these readings is None — the caller decides whether that is
    fatal. Milliseconds are recognised by magnitude: 10^12 seconds is
    the year 33658, so any number that large is a millisecond count.
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        seconds = float(v)
    elif isinstance(v, str):
        text = v.strip()
        if not text:
            return None
        try:
            seconds = float(text)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp())
    else:
        return None
    if seconds >= 1e12:
        seconds /= 1000.0
    return int(seconds)


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


def resolved_sources(
    claims: dict,
    *,
    kind: str,
    override: dict | None = None,
) -> dict[str, str | None]:
    """Which candidate key actually supplied each field.

    ``apply_claim_mapping`` returns the resolved *values*; an operator
    editing a fallback list needs the *provenance* — with
    ``email: [emailAddress, email, mail]`` and two of them present, only
    the winner is doing any work and the rest are dead weight they may be
    maintaining for nothing.

    Lives here rather than in the admin endpoint, and re-walks the same
    ``_first_non_empty`` over the same ``merge_mapping`` result, because a
    second implementation of first-non-empty would be free to disagree
    with the one that runs at login. Dotted paths are exactly where it
    would: ``_resolve`` understands ``user.email`` and ``groups[0]``, and
    a naive ``claims.get(path)`` does not.

    Keys mirror ``ProviderIdentity``'s fields, plus one entry per
    configured extra under ``extras.<name>``. A field nothing resolved is
    present with ``None`` — absent would be indistinguishable from a field
    we forgot to report.

    ``first_name``/``last_name`` report ``None`` when the IdP released only
    a full name, because no candidate of theirs supplied anything — the
    names were split out of the display name afterwards. That derivation is
    reported separately, by ``ProviderIdentity.names_derived_from``; folding
    it in here would claim a candidate fired when none did.
    """
    mapping = merge_mapping(kind, override)

    out: dict[str, str | None] = {
        field: _winning_path(claims, mapping.get(field))
        for field in (
            "external_id", "email", "email_verified",
            "first_name", "last_name", "display_name",
            "groups", "auth_time", "avatar_url",
        )
    }
    for name, paths in (mapping.get("extras") or {}).items():
        if isinstance(name, str) and name:
            out[f"extras.{name}"] = _winning_path(claims, paths)
    return out


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
    # Which claim the names came out of, when they came out of the full
    # name rather than from the IdP naming the halves itself. Carried
    # through to the login so a guess is never locked onto the profile,
    # and to the preview so the mapping screen can say where it came from.
    names_derived_from: str | None = None
    if not first_name and not last_name and display_name:
        first_name, last_name = split_display_name(display_name)
        names_derived_from = _winning_path(
            claims, mapping.get("display_name") or [],
        )

    groups = _to_groups(_first_non_empty(claims, mapping.get("groups") or []))
    auth_time = _to_epoch(
        _first_non_empty(claims, mapping.get("auth_time") or [])
    )
    raw_avatar = _first_non_empty(claims, mapping.get("avatar_url") or [])
    avatar_url = _to_str(raw_avatar).strip() if raw_avatar is not None else ""

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
        names_derived_from=names_derived_from,
        display_name=display_name or None,
        avatar_url=avatar_url or None,
    )


class ClaimMappingError(Exception):
    """A required mapped field (``external_id`` or ``email``) was
    missing from the IdP claims. Routes turn this into a generic
    ``unsafe_login_rejected`` failure; the precise message is
    audited, not surfaced to the user."""
