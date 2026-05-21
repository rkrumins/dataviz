"""Identity provider registry — pluggable per-protocol implementations."""
from .base import IdentityProvider, ProviderCredentials, ProviderIdentity
from .local import LocalIdentityProvider
from .oidc import OidcProvider, load_oidc_settings

# SAML import is best-effort: a non-viz Dockerfile may not install the
# ``python3-saml`` / ``libxmlsec1`` system deps, in which case the
# import fails and we never expose the provider class. The viz-service
# is the only image that mounts the SAML routes, so missing-install
# elsewhere is a silent no-op.
try:
    from .saml2 import SamlProvider, load_saml_settings, SamlError  # noqa: F401
    SAML_AVAILABLE: bool = True
except ImportError:  # pragma: no cover - missing system dep / library
    SamlProvider = None  # type: ignore[assignment]
    load_saml_settings = None  # type: ignore[assignment]
    SamlError = None  # type: ignore[assignment]
    SAML_AVAILABLE = False

from .custom import CustomIdentityProvider, CustomIdentityError  # noqa: E402

_REGISTRY: dict[str, IdentityProvider] = {}


def register_provider(name: str, provider: IdentityProvider) -> None:
    """Register a provider under its ``auth_provider`` value (e.g. 'local', 'oidc')."""
    _REGISTRY[name] = provider


def get_provider(name: str) -> IdentityProvider:
    """Look up a provider by name. Raises ``KeyError`` if not registered."""
    return _REGISTRY[name]


def known_providers() -> list[str]:
    return sorted(_REGISTRY.keys())


__all__ = [
    "IdentityProvider",
    "ProviderCredentials",
    "ProviderIdentity",
    "LocalIdentityProvider",
    "OidcProvider",
    "load_oidc_settings",
    "SamlProvider",
    "load_saml_settings",
    "SamlError",
    "SAML_AVAILABLE",
    "CustomIdentityProvider",
    "CustomIdentityError",
    "register_provider",
    "get_provider",
    "known_providers",
]
