"""A membership's query starting points, found by the search panel's own search.

A spec whose seeds are a search predicate is resolved by running that search —
the same compiler, the same view boundary, the same capability fence — in a
view (``within: view``: inside its boundary; ``within: dataSource``: the whole
source, held to that view's data source). The route that previews a narrowing,
saving a view from it and the worker that keeps such a view up to date all
build the search here, so they find the same entities.
"""
from __future__ import annotations

from typing import Any, List, Tuple

from backend.app.services.deep_search import SearchRunContext
from backend.common.models.search import Predicate, SearchOptions, SearchQuery, SearchScope
from backend.common.models.view_membership import SEEDS_MAX, MembershipSpec

#: How many times one search may be continued while it is still running.
SEARCH_CONTINUATIONS = 10


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
