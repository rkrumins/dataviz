"""A membership's query starting points, found by the search panel's own search.

A spec whose seeds are a search predicate is resolved by running that search —
the same compiler, the same view boundary, the same capability fence — in a
view (``within: view``: inside its boundary; ``within: dataSource``: the whole
source, held to that view's data source). The route that previews a narrowing,
saving a view from it, the worker that keeps such a view up to date and a member
set (which reads every match, a page at a time: ``make_seed_pages``) all build
the search here, so they find the same entities.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional, Tuple

from backend.app.services.deep_search import SearchRunContext
from backend.common.models.graph import GraphNode
from backend.common.models.search import Predicate, SearchOptions, SearchQuery, SearchScope
from backend.common.models.view_membership import SEEDS_MAX, MembershipSpec

#: How many times one search may be continued while it is still running.
SEARCH_CONTINUATIONS = 10
#: How long one page of a member set's seeds may search before it answers with how far it got.
SEED_PAGE_WAIT_MS = 5_000


def seed_query_for(spec: MembershipSpec, read_in: str) -> SearchQuery:
    """The search that finds ``spec``'s starting points, read in view ``read_in``."""
    return SearchQuery(
        predicate=spec.seeds.query,
        scope=SearchScope(view_id=read_in, scope_mode="view" if spec.within == "view" else "data_source"),
        options=SearchOptions(results="hits", page_size=SEEDS_MAX),
    )


def make_seed_search(svc: Any, query: SearchQuery, *, data_version: str, admit: Any,
                     continuations: int = SEARCH_CONTINUATIONS):
    """The resolver's ``search`` callable: the query's hits, up to the seed limit,
    and whether more existed. A search still running is continued (its session
    finishes on the data it started on); ``ValidationError`` is the caller's to
    map."""
    async def search(_predicate: Predicate) -> Tuple[List[str], bool]:
        context = SearchRunContext(data_version=data_version, admit=admit)
        page, _scope = await svc.search(query, run_context=context)
        for _ in range(continuations):
            if page.status != "running" or not page.session_id:
                break
            again = query.model_copy(update={
                "options": query.options.model_copy(update={"session_id": page.session_id})})
            page, _scope = await svc.search(again, run_context=context)
        urns = [hit.node.urn for hit in (page.hits or [])]
        more = (bool(page.cursor) or page.truncated or page.status == "running"
                or (page.total_count or 0) > len(urns))
        return urns, more

    return search


@dataclass
class SeedPage:
    """One page of a query seed's matches. ``nodes`` None: the search is still
    running (send ``session_id`` back to move it on). ``cursor``: where the next page
    starts, None on the last. ``truncated``: the search stopped at its own cap, so
    more matched than it lists. ``restart``: the cursor no longer reads — the
    matches are read again from the first page."""
    nodes: Optional[List[GraphNode]]
    cursor: Optional[str] = None
    session_id: Optional[str] = None
    truncated: bool = False
    restart: bool = False


def make_seed_pages(svc: Any, query: SearchQuery, *, data_version: str, admit: Any,
                    wait_ms: int = SEED_PAGE_WAIT_MS):
    """A member set's ``seed_pages`` callable: EVERY match of the query, a page a
    call — ``(cursor, session_id) → SeedPage`` — with no seed limit (``SEEDS_MAX``
    holds a Narrow, not a set). Each call is one search request that answers within
    ``wait_ms`` (a search still running is moved on by the next call), so one step of
    a set never waits on a whole scan. ``ValidationError`` on a first page is the
    caller's to map."""
    async def page(cursor: Optional[str], session_id: Optional[str]) -> SeedPage:
        options = query.options.model_copy(update={
            "cursor": cursor, "session_id": session_id, "wait_ms": wait_ms})
        context = SearchRunContext(data_version=data_version, admit=admit)
        try:
            result, _scope = await svc.search(query.model_copy(update={"options": options}),
                                              run_context=context)
        except ValueError:
            # A cursor issued for another query (the view's boundary moved, the session
            # behind it is gone): read the matches again. Anything else is refused.
            if cursor:
                return SeedPage(nodes=None, restart=True)
            raise
        if result.status == "running" and result.session_id:
            return SeedPage(nodes=None, cursor=cursor, session_id=result.session_id)
        return SeedPage(nodes=[hit.node for hit in (result.hits or [])], cursor=result.cursor,
                        truncated=bool(result.truncated) and not result.cursor)

    return page
