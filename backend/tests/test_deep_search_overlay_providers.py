"""Advanced search on a draft or a stale-main view.

``ContextEngine`` swaps ``engine.provider`` for ``DraftOverlayProvider``
(a draft) or ``VersionedBranchProvider`` (main, while the FalkorDB
projection lags a commit). Neither implemented the deep-search contract
and neither passes attributes through, so ``/search/advanced`` on a
draft view raised ``AttributeError`` — an HTTP 500, since only
``NotImplementedError`` maps to 501.

The draft overlay has a base provider to search (main's), so it
delegates and says so in the scope diagnostics: the draft's own
unpublished edits are absent from the answer. The branch provider
composes its reads from Postgres graph-version rows and holds no graph
provider at all, so it refuses honestly instead.
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import (
    VersionedBranchProvider,
)
from backend.common.models.search import (
    SearchOptions, SearchQuery, SearchResultPage, SearchScope, TagPredicate,
)


OVERLAY_NOTE = (
    "draft-only changes are not searchable yet: results come from the "
    "published graph"
)


class _RecordingBase:
    """A base provider that records the deep-search calls it receives."""

    def __init__(self) -> None:
        self.searches: list = []
        self.explains: list = []
        self.discovers: list = []

    async def deep_search(self, query, *, deadline_ms=None):
        self.searches.append((query, deadline_ms))
        return SearchResultPage(
            aggregates=None, hits=None, cursor=None,
            truncated=False, candidate_count=0,
            deadline_exceeded=False, elapsed_ms=1, cache_hit=False,
        )

    async def deep_search_explain(self, query):
        self.explains.append(query)
        return {"cypher": "MATCH (n) RETURN n"}

    async def deep_search_discover(self, *, sample_per_label: int = 200):
        self.discovers.append(sample_per_label)
        return {"labels": []}


class _FakeEngine:
    """Just enough surface for AdvancedSearchService: a ``.provider``."""

    def __init__(self, provider) -> None:
        self.provider = provider


def _overlay(base) -> DraftOverlayProvider:
    # ``svc`` is only touched when a read composes the draft delta; the
    # deep-search path never does, so a bare sentinel is enough.
    return DraftOverlayProvider(
        base, svc=object(), graph_id="g1", branch_id="draft-1",
    )


def _query(view_id: str) -> SearchQuery:
    return SearchQuery(
        predicate=TagPredicate(values=["PII"]),
        scope=SearchScope(view_id=view_id),
        options=SearchOptions(results="both"),
    )


# ---------------------------------------------------------------------------
# DraftOverlayProvider — delegates to the base it already reads through
# ---------------------------------------------------------------------------

async def test_draft_overlay_delegates_deep_search():
    base = _RecordingBase()
    query = _query("view-1")

    page = await _overlay(base).deep_search(query, deadline_ms=250)

    assert page.candidate_count == 0
    assert base.searches == [(query, 250)]


async def test_draft_overlay_delegates_explain():
    base = _RecordingBase()
    query = _query("view-1")

    result = await _overlay(base).deep_search_explain(query)

    assert result == {"cypher": "MATCH (n) RETURN n"}
    assert base.explains == [query]


async def test_draft_overlay_delegates_discover():
    base = _RecordingBase()

    result = await _overlay(base).deep_search_discover(sample_per_label=50)

    assert result == {"labels": []}
    assert base.discovers == [50]


async def test_draft_overlay_is_marked_as_an_overlay():
    """The service reads this marker to decide whether the answer needs
    the "not the draft's own data" caveat — no provider-class import in
    the service layer."""
    assert _overlay(_RecordingBase()).is_overlay is True


# ---------------------------------------------------------------------------
# The caveat reaches the caller
# ---------------------------------------------------------------------------

async def test_search_on_a_draft_notes_the_published_graph(
    db_session: AsyncSession,
):
    """End-to-end through the service: a draft view searches without
    raising, the base provider does the work, and the response carries
    the note that the draft's own edits are not in it."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    ws = WorkspaceORM(name="WS")
    db_session.add(ws)
    await db_session.flush()
    view = ViewORM(
        name="Draft View", workspace_id=ws.id, view_type="graph",
        config=json.dumps({}),
    )
    db_session.add(view)
    await db_session.flush()

    base = _RecordingBase()
    svc = AdvancedSearchService(
        _FakeEngine(_overlay(base)), session=db_session, workspace_id=ws.id,
    )

    page, _eff = await svc.search(_query(view.id))

    assert len(base.searches) == 1, "the base provider ran the search"
    assert OVERLAY_NOTE in page.scope_diagnostics.notes


async def test_search_on_main_carries_no_overlay_note(
    db_session: AsyncSession,
):
    """The caveat is specific to an overlay — a plain provider's results
    must not be labelled as coming from somewhere else."""
    from backend.app.services.advanced_search_service import (
        AdvancedSearchService,
    )

    ws = WorkspaceORM(name="WS")
    db_session.add(ws)
    await db_session.flush()
    view = ViewORM(
        name="Main View", workspace_id=ws.id, view_type="graph",
        config=json.dumps({}),
    )
    db_session.add(view)
    await db_session.flush()

    svc = AdvancedSearchService(
        _FakeEngine(_RecordingBase()), session=db_session, workspace_id=ws.id,
    )

    page, _eff = await svc.search(_query(view.id))

    assert OVERLAY_NOTE not in page.scope_diagnostics.notes


# ---------------------------------------------------------------------------
# VersionedBranchProvider — refuses, and the refusal is the 501 kind
# ---------------------------------------------------------------------------

def _branch() -> VersionedBranchProvider:
    return VersionedBranchProvider(object(), graph_id="g1", branch_id="b1")


async def test_branch_provider_refuses_deep_search():
    """``NotImplementedError`` is what the route maps to 501. The bug
    being fixed is the *missing* attribute, which surfaced as a 500."""
    with pytest.raises(NotImplementedError):
        await _branch().deep_search(_query("view-1"))


async def test_branch_provider_refuses_explain():
    with pytest.raises(NotImplementedError):
        await _branch().deep_search_explain(_query("view-1"))


async def test_branch_provider_refuses_discover():
    with pytest.raises(NotImplementedError):
        await _branch().deep_search_discover(sample_per_label=10)


async def test_branch_refusal_reads_like_a_user_message():
    """The refusal reaches the caller as the 501 body, so it is product
    copy, not a stack-trace note: what happened, and that waiting fixes
    it — no provider names, no internals."""
    with pytest.raises(NotImplementedError) as exc:
        await _branch().deep_search(_query("view-1"))

    assert str(exc.value) == (
        "Search isn't available while the published graph is catching "
        "up — try again in a moment."
    )


async def test_draft_over_a_stale_main_propagates_the_refusal():
    """A draft opened while the projection lags is overlaid on a
    ``VersionedBranchProvider``, not on FalkorDB. Delegation then hands
    back that provider's refusal — a 501 — rather than the
    ``AttributeError`` (500) this whole change exists to remove."""
    overlay = _overlay(_branch())

    with pytest.raises(NotImplementedError):
        await overlay.deep_search(_query("view-1"))
