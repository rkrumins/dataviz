"""Provider-agnostic contract for advanced search.

The service layer (``advanced_search_service.py``) and the HTTP layer
(``api/v1/endpoints/graph.py``) bind against this Protocol — never
against the FalkorDB implementation module directly. New providers
(Neo4j, Spanner, in-memory stub) implement the same three async
methods and slot in via the existing ``GraphDataProvider`` DI.

The Cypher dialect itself stays in each provider module; abstracting
it would be over-engineering (per the project CLAUDE.md). What the
service needs is a stable surface for the three operations search
performs:

  * ``deep_search``           — execute a SearchQuery, return a page
  * ``deep_search_explain``   — compile-only, return Cypher + params
  * ``deep_search_discover``  — sample the graph, return queryable
                                property/tag/edge metadata
  * ``deep_search_values``    — one property's most common values, for
                                the value picker

and, optionally (outside the Protocol, so a provider without it still
satisfies it):

  * ``deep_search_session``   — the uncapped engine: run a request's share
                                of a search session (``SearchRunContext``)
                                and return its page. A provider without it
                                is searched by ``deep_search``.
  * ``deep_search_resolve_refs`` — which entities each name reference
                                (``NodeRef``) names in a scope. A provider
                                without it can't search by name (501).

``CompileError`` lives here so the service layer can ``except`` it
without importing from any provider module. Each provider re-exports
the same symbol.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import (
    Any, AsyncContextManager, Callable, Dict, FrozenSet, List, Optional, Protocol, Sequence, Set,
    Tuple, runtime_checkable,
)

from backend.common.adapters.circuit import register_logical_exception
from backend.common.models.search import SearchQuery, SearchResultPage


class CompileError(ValueError):
    """Raised when a predicate cannot be compiled in v1.

    Provider-agnostic: any deep-search backend may raise this when it
    encounters an unsupported predicate shape. Service layer translates
    to HTTP 400 with the message intact — the message is user-facing
    and tells the caller which feature to use instead.
    """


class SearchFailed(RuntimeError):
    """A search or count stopped on a read the engine could not recover
    from (a part that ran out of time or memory is split first). Rule
    counts report it as that rule's error; the other rules in the
    request count on."""


# A slow search is not an unreachable store: registered so a
# CircuitBreakerProxy re-raises it untouched instead of counting it —
# three slow searches in a row would otherwise open the breaker for every
# graph read on the source. Module top level, after the class, is the
# supported pattern (see aggregation/cancel.py): the web tier imports this
# package with its routes (endpoints/graph.py), before any provider — and
# so any proxy — is constructed, and circuit.py imports nothing from here.
register_logical_exception(SearchFailed)


class SessionStoreUnavailable(RuntimeError):
    """The cache Redis that keeps search sessions did not answer. Nothing
    about the graph: a raw Redis error from it read as a graph-store outage
    to the provider's breaker, and one cache blip refused every graph read on
    the source. Registered like ``SearchFailed``, so a proxy re-raises it
    untouched; the API answers it 503 with a Retry-After."""


register_logical_exception(SessionStoreUnavailable)


class NothingReusable(LookupError):
    """A search asked to answer without scanning (``SearchRunContext.scan``
    False) has no session to answer from: nothing complete for this data,
    nothing recent enough, nothing running. The caller decides whether to
    scan. Registered like ``SearchFailed``: a miss, never the graph's fault."""


register_logical_exception(NothingReusable)


class ViewMembers(Protocol):
    """The members of a view made from a query, when they are too many to list as a
    search's roots (``EffectiveViewScope.member_scope``): read from where the view keeps
    them, a band at a time, so a search session holds bands — never the members.

    * ``count`` — how many members the view has;
    * ``counts()`` — per graph label, how many members a search reads itself (not the
      whole ones, which are its roots, nor those inside one) and where their
      ``label_ord`` ends;
    * ``read(label, lo, hi)`` — those members' URNs, ``lo <= label_ord < hi``;
    * ``holds(urns)`` — which of ``urns`` are members at all.
    """
    count: int

    async def counts(self) -> Dict[str, Tuple[int, int]]: ...

    async def read(self, label: str, lo: int, hi: int) -> List[str]: ...

    async def holds(self, urns: Sequence[str]) -> Set[str]: ...


@dataclass(frozen=True)
class SearchRunContext:
    """What the uncapped engine needs from the request around it.

    * ``data_version`` — the graph data the request reads (content
      generation + FalkorDB generation); a session started on one version
      is never served as another's answer;
    * ``scope_hash`` — the resolved view scope, so a session can only ever
      answer the scope it was planned for;
    * ``admit`` — takes one fleet slot for the length of one statement.
      The engine runs many statements per request, so it is admitted per
      statement rather than once around the whole search;
    * ``reuse_s`` — how long after the data changes a complete first page
      may still answer, marked stale and as of when it was read, instead of a
      scan (0: never) — so a feed read by many while its graph is written to
      is scanned at most once a window, not on every write;
    * ``scan`` — False answers only from what is already there (a complete
      or recent first page, a held later page, a scan another request is
      running) and raises ``NothingReusable`` otherwise;
    * ``slot`` — taken by the request that moves a scan on, once it holds the
      scan's lease and for as long as it runs it; entering it says whether one
      was free. A request waiting on another's scan takes none, and one that
      finds none free gives the lease straight back and answers with the scan
      as it stands — so readers of a scan in flight never hold the slots that
      scans need;
    * ``members`` — a view whose members are too many to list as roots: they
      bound the search beside its roots (``ViewMembers``), read per request
      from the request's database session;
    * ``session_rows`` — rows one scan keeps for later pages, in place of the
      engine's setting (a subset layer's feed keeps more, so paging past a
      session starts the next scan from the keyset less often);
    * ``scope_hashes`` — scopes other than ``scope_hash`` a session read here
      may have been planned for: in a view made from a query, a search filtered
      to one of its layers runs in that layer's scope (``layer_fold``), so what
      reads its session afterwards (``ancestor-counts``) accepts each of them.
    """
    data_version: str = ""
    scope_hash: str = ""
    admit: Optional[Callable[[], AsyncContextManager]] = None
    reuse_s: float = 0.0
    scan: bool = True
    slot: Optional[Callable[[], AsyncContextManager[bool]]] = None
    members: Optional[ViewMembers] = None
    session_rows: Optional[int] = None
    scope_hashes: FrozenSet[str] = frozenset()


@runtime_checkable
class DeepSearchProvider(Protocol):
    """Minimal contract for hosting ``/search/advanced``.

    Implementations live alongside their graph adapter (FalkorDB:
    ``backend/app/providers/falkordb_provider.py``; stub:
    ``backend/graph/adapters/stub_provider.py``). The service layer
    treats every provider through this Protocol — no FalkorDB-specific
    imports leak past ``advanced_search_service``.
    """

    async def deep_search(
        self,
        query: SearchQuery,
        *,
        deadline_ms: Optional[int] = None,
    ) -> SearchResultPage:
        """Execute a SearchQuery and return the page."""
        ...

    async def deep_search_explain(self, query: SearchQuery) -> Dict[str, Any]:
        """Compile-only path. Returns ``{cypher, hits_cypher, params,
        candidate_cap, hoisted_root_urns, effective_root_urns, notes}``.
        Used by ``POST /search/explain`` and the FE dev panel.
        """
        ...

    async def deep_search_discover(
        self,
        *,
        sample_per_label: int = 200,
    ) -> Dict[str, Any]:
        """Schema discovery. Returns ``{labels, blobOnlyLabels,
        missingContainment, tagValues, missingSearchableText, edges,
        elapsedMs}``. Powers the FE's property / value / tag / edge
        pickers.
        """
        ...

    async def deep_search_values(
        self,
        *,
        key: str,
        entity_types: Optional[List[str]] = None,
        q: str = "",
        limit: int = 25,
    ) -> Dict[str, Any]:
        """A property's most common values across the given entity types
        (all when None), optionally only those whose text contains ``q``.
        Returns ``{key, values: [{value, count}], complete, truncated,
        elapsedMs}``. Powers the value picker's suggestions.
        """
        ...
