"""How much a provider's word is worth.

Every SSO kind ends up calling ``complete_sso_login`` with a
``ProviderIdentity``, and from that point on the platform treats them
identically. But they did not all *earn* the same trust: an OIDC id_token
was signature-verified against the IdP's JWKS, whereas a ``custom_profile``
row with ``trust_unsigned`` accepted a JSON blob that anyone with a browser
console could have written.

That difference used to be two booleans buried in an encrypted settings
blob, invisible in the admin UI and unenforced anywhere. This module turns
it into one word that can be shown in a list, stamped into an audit event,
and — most importantly — used to refuse an escalation.

**Derived, never stored.** A column would be a second source of truth that
drifts the moment an operator edits settings. The settings *are* the truth;
this reads them.

Levels, worst to best:

``unverified``
    We cannot distinguish a genuine claim from a forged one. An unsigned
    ``custom_profile`` payload, or the dev-only ``custom`` mock. Anyone who
    can write the cookie or storage key can be anyone.

``asserted``
    A trusted network position vouched for the identity, and we are taking
    its word. A proxy-injected header: sound when the proxy strips inbound
    copies, a full bypass when it does not — and we cannot tell which from
    here.

``verified``
    A signature over a third-party assertion was checked against a key we
    hold. OIDC, SAML2, and a signed ``custom_profile`` JWT.

The ordering is meaningful: ``at_least()`` compares by rank, so a future
level slots in without every call site changing.
"""
from __future__ import annotations

from typing import Any

# Ordered worst -> best. Index is the rank.
ASSURANCE_ORDER: tuple[str, ...] = ("unverified", "asserted", "verified")

UNVERIFIED = "unverified"
ASSERTED = "asserted"
VERIFIED = "verified"


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "t"}
    return bool(v)


def assurance_for(kind: str, settings: dict | None = None) -> str:
    """Return the assurance level for a provider row.

    ``settings`` is the DECRYPTED settings dict (what
    ``idp_provider_repo.decrypt_settings`` returns). Only ``custom_profile``
    inspects it; the other kinds are decided by their protocol.
    """
    s = settings or {}

    if kind in {"oidc", "saml2"}:
        # Both verify a signature over the assertion before it reaches the
        # claim mapper — JWKS for OIDC, the IdP x509 cert for SAML.
        return VERIFIED

    if kind == "backchannel":
        # No signature is checked here, and it is still the strongest
        # kind we have. The claims did not arrive from the browser at
        # all: they came back over TLS from the provider's own endpoint,
        # in answer to a question we asked during this login. A
        # signature attests to a statement made at some past instant; a
        # back-channel answer is current, so a session revoked thirty
        # seconds ago fails now rather than at the assertion's ``exp``.
        # Nothing about the row can weaken that — there is no
        # ``trust_unsigned`` equivalent, because there is nothing to
        # trust unsigned.
        return VERIFIED

    if kind == "custom_profile":
        # An unsigned payload is unverifiable regardless of how it arrived,
        # so this check comes first: a JSON payload delivered by header is
        # still unverified, not asserted.
        if str(s.get("payload_format") or "jwt") == "json" or _as_bool(
            s.get("trust_unsigned")
        ):
            return UNVERIFIED
        if str(s.get("source") or "cookie") == "header":
            return ASSERTED
        return VERIFIED

    # ``custom`` is the dev/demo mock. Its envelope IS signed with the
    # platform secret, but it asserts whatever the developer typed into a
    # form — that is authorship, not identity proof.
    return UNVERIFIED


def at_least(level: str, minimum: str) -> bool:
    """True when *level* is at or above *minimum* in the ordering.

    An unknown level sorts as the worst, so a typo fails closed.
    """
    try:
        have = ASSURANCE_ORDER.index(level)
    except ValueError:
        return False
    try:
        want = ASSURANCE_ORDER.index(minimum)
    except ValueError:
        return False
    return have >= want


#: Human-facing one-liners for the admin UI. Kept next to the levels so a
#: new level cannot be added without someone writing its explanation.
ASSURANCE_DESCRIPTIONS: dict[str, str] = {
    VERIFIED: (
        "Identities are proven by a signature we verify against the "
        "provider's key."
    ),
    ASSERTED: (
        "Identities are vouched for by your proxy. Sound only while that "
        "proxy strips this header from inbound requests."
    ),
    UNVERIFIED: (
        "Identities cannot be verified. Anyone able to set the payload can "
        "sign in as anyone."
    ),
}
