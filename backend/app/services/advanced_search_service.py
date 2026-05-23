"""AdvancedSearchService — service layer for the new server-side search.

Pipeline:

    validate predicate tree (depth/leaves/OR-branch caps)
        → resolve view scope (ViewScopeResolver: server-side enforcement)
        → stamp resolved scope onto SearchQuery (compiler reads it)
        → provider.deep_search(query, deadline_ms)

Deferred to later workstreams (intentionally NOT here):
  * Result caching (Redis) + mutation-driven eviction          [W3]
  * Rate limiting (reuse the token bucket)                     [W4]
  * Audit log + Prometheus metrics                             [W4]
  * Federation fan-out across workspace                        [out of scope]
  * /search/saved and /search/history                          [W4]

The view-scope resolver is in W0 because it is the load-bearing
correctness invariant: searches MUST NOT cross the view's boundary,
and that's enforced here — before any Cypher is generated.
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.providers.falkordb_deep_search import CompileError
from backend.app.services.context_engine import ContextEngine
from backend.app.services.view_scope import (
    EffectiveViewScope,
    ViewNotFound,
    ViewScopeError,
    ViewScopeResolver,
)
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.common.models.search import (
    GroupPredicate,
    ScopeDiagnostics,
    SearchQuery,
    SearchResultPage,
    SearchScope,
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


def _empty_page(query: SearchQuery) -> SearchResultPage:
    """Construct a zero-results ``SearchResultPage`` for short-circuit cases.

    Used when every client-supplied root URN is out of view. We never
    want to silently widen to an unconstrained search, so we return an
    empty page that respects the shape the caller asked for.
    """
    results_shape = query.options.results
    return SearchResultPage(
        aggregates=[] if results_shape in ("aggregates", "both") else None,
        hits=[] if results_shape in ("hits", "both") else None,
        cursor=None,
        truncated=False,
        candidate_count=0,
        deadline_exceeded=False,
        elapsed_ms=0,
        cache_hit=False,
    )


def _stamp_resolved_scope(
    query: SearchQuery, eff_scope: EffectiveViewScope,
) -> SearchQuery:
    """Overwrite ``query.scope`` with the server-resolved values.

    The compiler reads ``query.scope.root_urns`` and ``query.scope.entity_types``
    as authoritative; this function makes sure those mirror the resolver's
    output, never the client's request, before the compiler runs.

    Pydantic models are immutable-by-convention (``Config.frozen`` is not
    set, but mutating fields can confuse caches). We construct a new
    ``SearchScope`` and use ``model_copy`` to swap it in.
    """
    new_scope = SearchScope(
        view_id=eff_scope.view_id,
        root_urns=list(eff_scope.root_urns) if eff_scope.root_urns else None,
        max_depth=eff_scope.max_depth,
        entity_types=(
            sorted(eff_scope.entity_type_allow_list)
            if eff_scope.entity_type_allow_list
            else None
        ),
        layer_assignment=query.scope.layer_assignment,
    )
    return query.model_copy(update={"scope": new_scope})


class AdvancedSearchService:
    """Stateless service. Construct per request via FastAPI DI.

    Holds a reference to the resolved ``ContextEngine`` (which carries
    the per-workspace/data-source provider), the SQLAlchemy session
    (used by the view-scope resolver), and the path workspace_id (used
    to reject cross-tenant view lookups).
    """

    def __init__(
        self,
        engine: ContextEngine,
        *,
        session: Optional[AsyncSession],
        workspace_id: Optional[str],
        data_source_id: Optional[str] = None,
    ) -> None:
        self._engine = engine
        self._session = session
        self._workspace_id = workspace_id
        self._data_source_id = data_source_id

    @classmethod
    def for_diagnostics(cls, engine: ContextEngine) -> "AdvancedSearchService":
        """Construct a diagnostics-only service (no view-scope resolver).

        Use only for read-only endpoints like ``/search/discover`` that
        don't take a ``SearchQuery``. Calling ``search()`` or ``explain()``
        on a diagnostics-only instance will fail at the resolver step
        because there's no session — that's the right behaviour: those
        methods MUST be scoped to a view.
        """
        return cls(engine, session=None, workspace_id=None)

    async def search(
        self,
        query: SearchQuery,
        *,
        deadline_ms: Optional[int] = None,
    ) -> Tuple[SearchResultPage, EffectiveViewScope]:
        """Run a search; return the page plus the resolved scope.

        The caller (HTTP endpoint) uses the returned ``EffectiveViewScope``
        to set the ``X-Search-Dropped-URNs`` header and to populate the
        audit-log row (so the audit trail records what was *actually*
        searched, not what the client asked for).
        """
        _count_and_validate(query)

        client_requested_urns = bool(query.scope.root_urns)
        eff_scope = await self._resolve_scope(query.scope)
        query = _stamp_resolved_scope(query, eff_scope)

        # Security guard: if the client passed root_urns but every one
        # was dropped by the resolver (none belonged to this view), we
        # must NOT silently widen the search to "no scope clamp" — that
        # would leak data from outside the view. Return an empty page
        # instead, so the FE can show "no matches in this view".
        if client_requested_urns and not eff_scope.root_urns:
            logger.info(
                "search.all_root_urns_dropped view=%s ws=%s n=%d",
                eff_scope.view_id, eff_scope.workspace_id,
                len(eff_scope.dropped_urns),
            )
            page = _empty_page(query)
            page.scope_diagnostics = self._build_scope_diagnostics(
                eff_scope, extra_notes=[
                    "All client-supplied root URNs were dropped — none "
                    "belonged to this view. Search short-circuited to "
                    "an empty page (security guard).",
                ],
            )
            return page, eff_scope

        try:
            page = await self._engine.provider.deep_search(
                query, deadline_ms=deadline_ms,
            )
            page.scope_diagnostics = self._build_scope_diagnostics(eff_scope)
            return page, eff_scope
        except CompileError as exc:
            # Cypher-compilation rejections (e.g. fulltext without index,
            # nested DescendantOf) are caller-input errors — surface the
            # message verbatim so the FE can guide the user.
            raise ValidationError(str(exc)) from exc
        except NotImplementedError:
            # Provider has no deep_search override (Neo4j/Spanner not done
            # yet in this workstream). Distinct from validation so the HTTP
            # layer maps to 501, not 400.
            raise
        except ProviderConfigurationError as exc:
            # Ontology hasn't been configured for this workspace. The
            # existing graph endpoints translate this to 400.
            raise ValidationError(str(exc)) from exc

    async def explain(self, query: SearchQuery):
        """Compile-only path. Returns the generated Cypher + bound params
        without executing.

        Resolves the view scope so the explained Cypher matches what
        ``search()`` would actually run — including the view-derived
        ``root_urns`` and ``entity_types``.
        """
        from backend.app.providers.falkordb_deep_search import (
            explain_deep_search,
        )
        _count_and_validate(query)
        eff_scope = await self._resolve_scope(query.scope)
        query = _stamp_resolved_scope(query, eff_scope)
        try:
            result = explain_deep_search(self._engine.provider, query)
        except CompileError as exc:
            raise ValidationError(str(exc)) from exc
        # Attach the resolved-scope summary so the dev panel can show
        # the user *what their search actually scopes to*. Critical
        # for debugging "why didn't this return anything" — answer is
        # often "your view doesn't contain these URNs".
        if isinstance(result, dict):
            result["resolvedScope"] = {
                "viewId": eff_scope.view_id,
                "canvasKind": eff_scope.canvas_kind,
                "rootUrns": list(eff_scope.root_urns),
                "entityTypes": sorted(eff_scope.entity_type_allow_list),
                "layerIds": sorted(eff_scope.layer_allow_list),
                "maxDepth": eff_scope.max_depth,
                "scopeHash": eff_scope.scope_hash,
                "droppedUrns": list(eff_scope.dropped_urns),
            }
        return result

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

    def _build_scope_diagnostics(
        self,
        eff_scope: EffectiveViewScope,
        *,
        extra_notes: Optional[list] = None,
    ) -> ScopeDiagnostics:
        """Assemble the diagnostic block attached to every response.

        Reads the resolved-scope output PLUS the provider's currently-
        injected ontology edge type sets. The latter can be empty
        (config) or unset (ontology never resolved) — both are caught
        and surfaced as notes rather than raising, so a failed
        diagnostic never breaks a search.
        """
        provider = self._engine.provider
        notes: list[str] = list(extra_notes or [])

        lineage: list[str] = []
        try:
            lineage = sorted(provider._get_lineage_edge_types())
        except ProviderConfigurationError:
            notes.append(
                "Ontology was not resolved for this provider; lineage "
                "edge classification is unknown. Lineage-aware predicates "
                "(IsOrphan, HasIncoming, withinHops with edgeClass='lineage') "
                "will compile-fail at runtime.",
            )
        except AttributeError:
            # Non-FalkorDB provider — diagnostic info just unavailable.
            pass

        if not lineage and "edge classification is unknown" not in (notes[-1] if notes else ""):
            notes.append(
                "No edge types are flagged is_lineage in the active "
                "ontology. Lineage-aware predicates (IsOrphan, "
                "HasIncoming, etc.) will match zero nodes by design. "
                "Open the data source's ontology and mark at least one "
                "edge type as is_lineage.",
            )

        containment: list[str] = []
        try:
            containment = sorted(provider._get_containment_edge_types())
        except ProviderConfigurationError:
            pass
        except AttributeError:
            pass

        if not eff_scope.root_urns:
            notes.append(
                f"View '{eff_scope.view_id}' has no rootUrns configured "
                "and the client supplied none — search ran across the "
                "entire data source (no scope clamp).",
            )

        return ScopeDiagnostics(
            effective_root_urns=list(eff_scope.root_urns),
            effective_max_depth=eff_scope.max_depth,
            effective_entity_types=(
                sorted(eff_scope.entity_type_allow_list)
                if eff_scope.entity_type_allow_list
                else None
            ),
            dropped_root_urns=list(eff_scope.dropped_urns),
            lineage_edge_types=lineage,
            containment_edge_types=containment,
            notes=notes,
        )

    async def _resolve_scope(self, requested: SearchScope) -> EffectiveViewScope:
        """Run the ViewScopeResolver and map known failure modes to HTTP."""
        if self._session is None or self._workspace_id is None:
            # Diagnostics-only constructor was used. search()/explain()
            # require a real session + workspace for view-scope
            # resolution — refuse loudly rather than silently widening.
            raise ValidationError(
                "view_scope_unavailable: AdvancedSearchService was "
                "constructed for diagnostics only and cannot run a "
                "scoped search"
            )
        resolver = ViewScopeResolver(self._session)
        try:
            return await resolver.resolve(
                workspace_id=self._workspace_id,
                requested=requested,
                data_source_id=self._data_source_id,
            )
        except ViewNotFound as exc:
            # The HTTP layer maps NotImplementedError → 501 and
            # ValidationError → 400. ViewNotFound is its own thing —
            # surface as ValidationError with a specific prefix the
            # endpoint can pattern-match into a 404.
            raise ValidationError(f"view_not_found: {exc}") from exc
        except ViewScopeError as exc:
            raise ValidationError(f"{exc.reason}: {exc}") from exc
