"""Repository modules, imported on demand.

This package used to eagerly ``from . import (...)`` all twenty-one
modules below, which made importing *any* repository import *all* of
them — and everything they in turn depend on.

That is how the aggregation control plane came to require a JWT signing
secret. ``ontology/runtime.py`` does a function-local
``from backend.app.db.repositories.stats_repo import get_data_source_stats``
to dodge a circular import; Python still initialises this package to get
there, which pulled in ``idp_group_mapping_repo``, which imports
``auth_service.providers.assurance``, whose package ``__init__`` imports
``oidc``, which imports the auth config, which resolved
``JWT_SECRET_KEY`` at module scope and raised. A batch worker that
neither mints nor verifies a token died on its first ontology
resolution, five links from anything to do with signing.

Loading lazily keeps every existing spelling working —
``from backend.app.db.repositories import user_repo``,
``repositories.user_repo``, ``import ...repositories.stats_repo`` — while
making each one cost only what it actually needs. It also means a
dependency added to one repository can no longer become a dependency of
every caller of every other.
"""
from importlib import import_module
from typing import TYPE_CHECKING

__all__ = [
    "workspace_repo",
    "data_source_repo",
    "provider_repo",
    "catalog_repo",
    "ontology_definition_repo",
    "feature_flags_repo",
    "feature_registry_repo",
    "user_repo",
    "permission_repo",
    "group_repo",
    "binding_repo",
    "grant_repo",
    "role_repo",
    "invite_repo",
    "access_request_repo",
    "idp_group_mapping_repo",
    "idp_provider_repo",
    "user_identity_repo",
    "user_attribute_repo",
    "app_auth_config_repo",
    "branding_repo",
]

_EXPORTED = frozenset(__all__)


def __getattr__(name: str):
    """PEP 562: import a repository module the first time it is named.

    Anything not in ``__all__`` still raises ``AttributeError``, so a
    typo fails as loudly as it did when the list was explicit — it just
    fails on use rather than on package import.
    """
    if name in _EXPORTED:
        module = import_module(f"{__name__}.{name}")
        globals()[name] = module  # cache: __getattr__ runs once per name
        return module
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(__all__)


if TYPE_CHECKING:  # pragma: no cover - for type checkers and IDEs only
    from . import (  # noqa: F401
        access_request_repo,
        app_auth_config_repo,
        binding_repo,
        branding_repo,
        catalog_repo,
        data_source_repo,
        feature_flags_repo,
        feature_registry_repo,
        grant_repo,
        group_repo,
        idp_group_mapping_repo,
        idp_provider_repo,
        invite_repo,
        ontology_definition_repo,
        permission_repo,
        provider_repo,
        role_repo,
        user_attribute_repo,
        user_identity_repo,
        user_repo,
        workspace_repo,
    )
