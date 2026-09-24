"""Advanced-search core — provider-agnostic surface for ``/search/*``.

Exposes:
  * The ``DeepSearchProvider`` Protocol every graph adapter implements.
  * ``CompileError`` — the canonical exception for predicate-compilation
    failures (re-exported by each provider module for back-compat).
  * ``SearchRunContext`` — what the uncapped engine needs from the request.
  * ``DeepSearchSettings`` / ``get_deep_search_settings`` — env-tunable
    configuration (every magic number in the search core lives here).

The service layer (``advanced_search_service.py``) and the HTTP layer
import from this package only. Provider modules host the Cypher dialect
and call into this package for shared types.
"""
from backend.app.services.deep_search.contracts import (
    CompileError,
    DeepSearchProvider,
    SearchRunContext,
)
from backend.app.services.deep_search.settings import (
    DeepSearchSettings,
    get_deep_search_settings,
)

__all__ = [
    "CompileError",
    "DeepSearchProvider",
    "DeepSearchSettings",
    "SearchRunContext",
    "get_deep_search_settings",
]
