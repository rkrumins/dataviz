"""The provider catalog -- one registration point per provider type.

Before this package, adding a graph provider meant editing two duplicated
``if provider_type == ...`` dispatch chains (``ProviderManager`` and
``ProviderRegistry``), a string-keyed capability dict, a DB CHECK
constraint, and 15+ frontend enumerations. ``PROVIDER_CATALOG`` is the
single source of truth those sites read instead.

``backend/common/providers/`` (this package's parent) is a dependency-free
kernel: ``tests/test_falkordb_kernel_purity.py`` fails on any
``backend.app`` import here, module-level or inside a function body, lazy
or not. Importing this package therefore pulls in nothing heavier than
stdlib + the two dataclass/enum modules it is built from -- no graph
driver, no app code -- which is what lets a worker with no graph driver
installed, or a future second engine's adapter package, import it safely.

**FalkorDB is deliberately absent from the self-registration import below.**
Its concrete class (``FalkorDBProvider``) lives under ``backend.app``
(``backend.app.providers.falkordb``), and there is no import of it --
direct, lazy, or via a re-export shim -- that this kernel package can make
without tripping the purity guard above. So FalkorDB's descriptor is built
and registered from *there* instead:
``backend.app.providers.falkordb.catalog_descriptor`` calls
:func:`register` on import, and ``backend.app.providers.falkordb``'s own
``__init__`` imports that module for the side effect -- the dependency
arrow points the same direction as every other app-on-kernel dependency,
just declared from the other end. One consequence: something must import
``backend.app.providers.falkordb`` (directly, or via the compatibility
shim ``backend.app.providers.falkordb_provider``) before
``descriptor_for("falkordb")`` / ``create_provider_instance`` for
``"falkordb"`` will resolve -- importing this package alone is not enough
for that one type. PR 3's ``arcadedb`` does not inherit this exception:
its concrete class is planned to live under ``backend.graph.adapters``
(like neo4j/datahub/spanner below), which this kernel may reference
freely, so its descriptor can self-register from ``catalog/arcadedb.py``
the ordinary way.
"""
from __future__ import annotations

from typing import Dict, FrozenSet, Optional, Tuple

from backend.common.interfaces.provider import GraphDataProvider

from .descriptor import (
    ConnectionShape,
    FieldSpec,
    ProviderDescriptor,
    ProviderRequestError,
    ProviderSpec,
)

__all__ = [
    "ConnectionShape",
    "FieldSpec",
    "ProviderDescriptor",
    "ProviderRequestError",
    "ProviderSpec",
    "PROVIDER_CATALOG",
    "LEGACY_DB_ONLY_TYPES",
    "register",
    "descriptor_for",
    "require_descriptor",
    "create_provider_instance",
    "registered_type_ids",
]

PROVIDER_CATALOG: Dict[str, ProviderDescriptor] = {}
LEGACY_DB_ONLY_TYPES: FrozenSet[str] = frozenset({"mock"})   # accepted by ck_providers_provider_type, never registrable (D7)


def register(d: ProviderDescriptor) -> ProviderDescriptor:
    if d.id in PROVIDER_CATALOG:
        raise RuntimeError(f"provider type {d.id!r} registered twice")
    PROVIDER_CATALOG[d.id] = d
    return d


def descriptor_for(provider_type: Optional[str]) -> Optional[ProviderDescriptor]:
    return PROVIDER_CATALOG.get((provider_type or "").lower())


def require_descriptor(provider_type: str) -> ProviderDescriptor:
    d = descriptor_for(provider_type)
    if d is None:
        raise ValueError(f"Unknown provider_type: {(provider_type or '').lower()!r}")   # message pinned by test_provider_registry.py
    return d


def create_provider_instance(spec: ProviderSpec) -> GraphDataProvider:
    return require_descriptor(spec.provider_type).build(spec)


def registered_type_ids() -> Tuple[str, ...]:
    return tuple(PROVIDER_CATALOG)


# Self-registration: each import below registers its type as a side effect.
# falkordb is NOT here -- see the module docstring.
from . import neo4j, datahub, spanner   # noqa: E402,F401  (PR 3 adds `arcadedb`)
