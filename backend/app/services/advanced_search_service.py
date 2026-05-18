"""
AdvancedSearchService — service layer for the new server-side search.

Workstream 2 scope (this module): validate the predicate tree, then
delegate to the active provider's ``deep_search``.

Deferred to workstream 3 (intentionally NOT here):
  * Scope intersection against the active view's allowed-scope config
  * Result caching (Redis) + mutation-driven eviction
  * Rate limiting (reuse the token bucket from commit e3f723d)
  * Audit log + Prometheus metrics
  * Federation fan-out (scope=workspace, multiple views in parallel)
  * /search/suggest and /search/explain endpoints

Keeping these out of v1 means the contract is exercised end-to-end with
the smallest viable code path; everything above gets bolted on around
this skeleton without re-shaping it.
"""
from __future__ import annotations

import logging
from typing import Optional

from backend.app.providers.falkordb_deep_search import CompileError
from backend.app.services.context_engine import ContextEngine
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.common.models.search import (
    GroupPredicate,
    SearchQuery,
    SearchResultPage,
)

logger = logging.getLogger(__name__)


# Tree-shape caps from the plan. Enforced here (not in the model) so we
# can surface a meaningful path-into-tree error message instead of a
# Pydantic ValidationError that just says ``len(children) > 24``.
MAX_TREE_DEPTH = 6
MAX_LEAF_COUNT = 64
MAX_OR_BRANCH = 24


class ValidationError(ValueError):
    """Caller-side input error. HTTP layer translates to 400."""


def _validate_predicate(predicate, *, depth: int = 1, path: str = "$") -> int:
    """Walk the tree, enforce caps, return leaf count for the subtree.

    Each leaf and each group counts as one node toward depth; OR groups
    additionally cap their child count separately. The traversal is
    iterative-friendly (recursive here for simplicity; predicate trees
    are small).
    """
    if depth > MAX_TREE_DEPTH:
        raise ValidationError(
            f"predicate tree at {path} exceeds max depth {MAX_TREE_DEPTH}"
        )
    if isinstance(predicate, GroupPredicate):
        if predicate.op == "or" and len(predicate.children) > MAX_OR_BRANCH:
            raise ValidationError(
                f"OR group at {path} has {len(predicate.children)} children "
                f"(max {MAX_OR_BRANCH})"
            )
        if predicate.op == "not" and len(predicate.children) != 1:
            raise ValidationError(
                f"NOT group at {path} must have exactly one child"
            )
        total = 0
        for i, child in enumerate(predicate.children):
            total += _validate_predicate(
                child, depth=depth + 1, path=f"{path}.children[{i}]",
            )
        return total
    return 1  # leaf


def _count_and_validate(query: SearchQuery) -> int:
    leaves = _validate_predicate(query.predicate)
    if leaves > MAX_LEAF_COUNT:
        raise ValidationError(
            f"predicate has {leaves} leaves (max {MAX_LEAF_COUNT})"
        )
    return leaves


class AdvancedSearchService:
    """Stateless service. Construct per request via FastAPI DI.

    Holds a reference to the resolved ``ContextEngine`` (which carries
    the per-workspace/data-source provider) — same lifetime the existing
    graph endpoints use.
    """

    def __init__(self, engine: ContextEngine):
        self._engine = engine

    async def search(
        self,
        query: SearchQuery,
        *,
        deadline_ms: Optional[int] = None,
    ) -> SearchResultPage:
        _count_and_validate(query)
        try:
            return await self._engine.provider.deep_search(
                query, deadline_ms=deadline_ms,
            )
        except CompileError as exc:
            # Cypher-compilation rejections (e.g. fulltext without index,
            # nested DescendantOf) are caller-input errors — surface the
            # message verbatim so the FE can guide the user.
            raise ValidationError(str(exc)) from exc
        except NotImplementedError as exc:
            # Provider has no deep_search override (Neo4j/Spanner not done
            # yet in this workstream). Distinct from validation so the HTTP
            # layer maps to 501, not 400.
            raise
        except ProviderConfigurationError as exc:
            # Ontology hasn't been configured for this workspace. The
            # existing graph endpoints translate this to 400.
            raise ValidationError(str(exc)) from exc

    def explain(self, query: SearchQuery):
        """Compile-only path. Returns the generated Cypher + bound params
        without executing — powers the dev panel's "Show Cypher" button
        and the `/search/explain` endpoint.

        Same validation as `search` (so the FE sees identical errors for
        identical inputs), but never hits the provider's query channel.
        """
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        _count_and_validate(query)
        try:
            return explain_deep_search(self._engine.provider, query)
        except CompileError as exc:
            raise ValidationError(str(exc)) from exc

    async def discover(self, *, sample_per_label: int = 200):
        """Returns the distinct native property keys present on the
        graph, per entity-type label. Diagnostic counterpart to the
        predicate compiler — answers "what can I actually query?".
        """
        from backend.app.providers.falkordb_deep_search import (
            discover_native_property_keys,
        )
        return await discover_native_property_keys(
            self._engine.provider,
            sample_per_label=sample_per_label,
        )
