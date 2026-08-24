"""Identity provider registry — Phase 3 (DB-backed, multi-IdP).

The Phase-2 dict ``_REGISTRY`` lived here; Phase 3 promotes it into a
process singleton :class:`ProviderRegistry` that materialises a fresh
provider object per ``idp_providers`` row with TTL caching. The
``register_provider`` / ``get_provider`` helpers from Phase 2 are kept
as thin compatibility shims so the local-only login path
(``LocalIdentityProvider``) and any third-party callers don't have to
move in lockstep.
"""
from .base import IdentityProvider, ProviderCredentials, ProviderIdentity
from .local import LocalIdentityProvider
from .registry import (
    ProviderConfigLoader,
    ProviderConfigSnapshot,
    ProviderDisabled,
    ProviderNotFound,
    ProviderRegistry,
    configure_registry,
    get_registry,
)
from .oidc import (
    OidcError,
    OidcProvider,
    OidcSettings,
    build_oidc_provider,
    load_env_oidc_settings,
    load_oidc_settings,
)
from .claim_mapper import (
    ClaimMappingError,
    DEFAULT_BACKCHANNEL,
    DEFAULT_CUSTOM,
    DEFAULT_CUSTOM_PROFILE,
    DEFAULT_OIDC,
    DEFAULT_SAML,
    KIND_DEFAULTS,
    apply_claim_mapping,
    merge_mapping,
    resolved_sources,
)

# SAML import is best-effort: a non-viz Dockerfile may not install the
# ``python3-saml`` / ``libxmlsec1`` system deps, in which case the
# import fails and we never expose the provider class. The viz-service
# is the only image that mounts the SAML routes, so missing-install
# elsewhere is a silent no-op.
try:
    from .saml2 import (  # noqa: F401
        SamlError,
        SamlProvider,
        SamlSettings,
        build_saml_provider,
        load_env_saml_settings,
        load_saml_settings,
    )
    SAML_AVAILABLE: bool = True
except ImportError:  # pragma: no cover - missing system dep / library
    SamlProvider = None  # type: ignore[assignment]
    SamlSettings = None  # type: ignore[assignment]
    SamlError = None  # type: ignore[assignment]
    build_saml_provider = None  # type: ignore[assignment]
    load_saml_settings = None  # type: ignore[assignment]
    load_env_saml_settings = None  # type: ignore[assignment]
    SAML_AVAILABLE = False

from .custom import (
    CustomIdentityError,
    CustomIdentityProvider,
    CustomSettings,
    build_custom_provider,
)
from .assurance import (
    ASSURANCE_DESCRIPTIONS,
    ASSURANCE_ORDER,
    assurance_for,
    at_least as assurance_at_least,
)
from .backchannel import (
    BackchannelConfigError,
    BackchannelError,
    BackchannelProvider,
    BackchannelSettings,
    BackchannelUnavailable,
    SessionRevokedUpstream,
    build_backchannel_provider,
)
from .custom_profile import (
    BROWSER_STORAGE_SOURCES,
    SERVER_READ_SOURCES,
    CustomProfileConfigError,
    CustomProfileError,
    CustomProfileProvider,
    CustomProfileSettings,
    build_custom_profile_provider,
)


# ── Phase 2 compatibility shims ───────────────────────────────────────
# The local provider has no DB row (there's no "local IdP" in
# ``idp_providers``); it lives in this dict the same way Phase 2 had
# it. SSO providers go through the registry above.
_LOCAL_PROVIDERS: dict[str, IdentityProvider] = {}


def register_provider(name: str, provider: IdentityProvider) -> None:
    """Register a non-SSO provider (currently only ``local``).

    SSO providers are no longer registered through this function;
    they are materialised per row by the
    :class:`~.registry.ProviderRegistry`. This shim stays so the
    ``main.py`` startup keeps working unchanged for the local case.
    """
    _LOCAL_PROVIDERS[name] = provider


def get_provider(name: str) -> IdentityProvider:
    """Phase 2-compatible lookup for the LOCAL provider only.

    SSO callers must go through :func:`get_registry` to look up a
    provider by row id or slug; calling this with an SSO kind name
    (``oidc``, ``saml2``, ``custom``) raises ``KeyError`` so misuse is
    caught at the boundary.
    """
    return _LOCAL_PROVIDERS[name]


def known_providers() -> list[str]:
    return sorted(_LOCAL_PROVIDERS.keys())


# Per-kind builder map consumed by :class:`ProviderRegistry`.
PROVIDER_BUILDERS = {
    "oidc":           build_oidc_provider,
    "custom":         build_custom_provider,
    "custom_profile": build_custom_profile_provider,
    "backchannel":    build_backchannel_provider,
}
if SAML_AVAILABLE and build_saml_provider is not None:
    PROVIDER_BUILDERS["saml2"] = build_saml_provider


__all__ = [
    "IdentityProvider",
    "ProviderCredentials",
    "ProviderIdentity",
    "LocalIdentityProvider",
    "OidcProvider",
    "OidcSettings",
    "OidcError",
    "load_oidc_settings",
    "load_env_oidc_settings",
    "build_oidc_provider",
    "SamlProvider",
    "SamlSettings",
    "SamlError",
    "load_saml_settings",
    "load_env_saml_settings",
    "build_saml_provider",
    "SAML_AVAILABLE",
    "CustomIdentityProvider",
    "CustomIdentityError",
    "CustomSettings",
    "build_custom_provider",
    "CustomProfileProvider",
    "CustomProfileError",
    "CustomProfileConfigError",
    "CustomProfileSettings",
    "build_custom_profile_provider",
    "BROWSER_STORAGE_SOURCES",
    "SERVER_READ_SOURCES",
    "assurance_for",
    "assurance_at_least",
    "ASSURANCE_ORDER",
    "ASSURANCE_DESCRIPTIONS",
    "ProviderRegistry",
    "ProviderConfigSnapshot",
    "ProviderConfigLoader",
    "ProviderNotFound",
    "ProviderDisabled",
    "configure_registry",
    "get_registry",
    "PROVIDER_BUILDERS",
    "register_provider",
    "get_provider",
    "known_providers",
    "apply_claim_mapping",
    "merge_mapping",
    "resolved_sources",
    "ClaimMappingError",
    "DEFAULT_OIDC",
    "DEFAULT_SAML",
    "DEFAULT_CUSTOM",
    "DEFAULT_CUSTOM_PROFILE",
    "DEFAULT_BACKCHANNEL",
    "KIND_DEFAULTS",
    "BackchannelProvider",
    "BackchannelSettings",
    "BackchannelError",
    "BackchannelConfigError",
    "BackchannelUnavailable",
    "SessionRevokedUpstream",
    "build_backchannel_provider",
]
