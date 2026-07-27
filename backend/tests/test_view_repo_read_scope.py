"""Contract test: every multi-view read in ``view_repo`` takes a scope.

Authorization for views lives in SQL, as a predicate that
``ViewReadScope`` produces. That only holds while every query that can
return more than one view actually applies it. The original design put
the filter in a Python loop at *one* endpoint instead, and the result was
predictable: ``list_views_for_context_model`` shipped with no visibility
filter at all, ``list_popular_views`` grew its own weaker one, and
``get_view_facets`` aggregated the whole table including other people's
private views — each of them a function someone added later, correctly
following the surrounding pattern, which happened to be insecure.

So the pattern has to be the thing that's enforced. A new multi-view
function is unauthorized until it takes ``scope``, and this test is what
says so. It fails on the *signature*, before anyone has to notice the
missing ``WHERE``.

Single-view reads are exempt and enumerated below with the reason: their
callers apply ``view_access.can_read_view`` to the loaded row, which is a
stronger check than the predicate (it also consults ``resource_grants``
for that specific view).
"""
from __future__ import annotations

import inspect
import typing

import pytest

from backend.app.db.repositories import view_repo


#: Functions that return view data for a SINGLE view identified by the
#: caller. Their endpoints gate on ``can_read_view`` against the row, so a
#: scope would be redundant. Each entry is a deliberate exemption.
_SINGLE_VIEW_READS = {
    "get_view":            "endpoint gates on can_read_view for the loaded row",
    "get_view_enriched":   "endpoint gates on can_read_view for the loaded row",
    "effective_view_config": "resolved for one view the caller already passed",
    "get_overlay":         "one (view, branch) overlay row",
    "ensure_overlay":      "one (view, branch) overlay row",
}

#: Functions that WRITE and return the row they just wrote. The write
#: itself is gated by an action predicate (can_edit_view, can_delete_view,
#: can_change_visibility, …), which is the stronger check.
_WRITES = {
    "create_view", "update_view", "update_view_layout", "update_overlay_layout",
    "promote_overlay", "promote_overlays_for_branch", "drop_overlays_for_branch",
    "delete_view", "restore_view", "permanently_delete_view",
    "update_visibility", "favourite_view", "unfavourite_view",
    "record_view_visit",
}

#: Return annotations that mean "more than one view, or an aggregate over
#: the views table". Anything matching these must take a scope.
_MULTI_VIEW_RETURNS = {
    "ViewListResponse", "ViewFacetsResponse", "ViewCatalogStats",
}
_MULTI_VIEW_ELEMENTS = {"ViewResponse", "RecentViewEntry", "ViewORM"}


def _public_functions():
    for name, fn in vars(view_repo).items():
        if name.startswith("_") or not inspect.isfunction(fn):
            continue
        if fn.__module__ != view_repo.__name__:
            continue  # imported helper, not part of this module's surface
        yield name, fn


def _returns_multiple_views(fn) -> bool:
    """True when the annotation is a collection of views or an aggregate."""
    annotation = fn.__annotations__.get("return")
    if annotation is None:
        return False
    text = annotation if isinstance(annotation, str) else str(annotation)
    if any(name in text for name in _MULTI_VIEW_RETURNS):
        return True
    is_collection = (
        "List[" in text or "list[" in text
        or "Sequence[" in text or "Iterable[" in text
    )
    return is_collection and any(el in text for el in _MULTI_VIEW_ELEMENTS)


#: The multi-view reads that exist today. Pinned so the test cannot pass
#: vacuously — if the detector stops recognising these, it has stopped
#: recognising anything, and the contract is unguarded.
_KNOWN_MULTI_VIEW_READS = {
    "list_views_filtered",
    "list_recent_views",
    "list_popular_views",
    "list_views_for_context_model",
    "get_view_facets",
    "get_view_stats",
}


def test_the_detector_actually_sees_the_known_multi_view_reads():
    """Guard against a vacuous pass.

    If ``_returns_multiple_views`` stops matching — a renamed annotation, a
    switch to ``from __future__ import annotations`` changing the string
    form — every check below would sail through green while enforcing
    nothing. Pin the set it must find.
    """
    detected = {
        name for name, fn in _public_functions() if _returns_multiple_views(fn)
    }
    missing = _KNOWN_MULTI_VIEW_READS - detected
    assert not missing, (
        f"the detector no longer recognises {sorted(missing)} as multi-view "
        "reads — the contract test is not enforcing anything for them"
    )


def test_every_multi_view_read_requires_a_scope():
    """A view-returning query is unauthorized until it takes a scope."""
    offenders = []
    for name, fn in _public_functions():
        if name in _WRITES or name in _SINGLE_VIEW_READS:
            continue
        if not _returns_multiple_views(fn):
            continue
        if "scope" not in inspect.signature(fn).parameters:
            offenders.append(f"{name}{inspect.signature(fn)}")

    assert not offenders, (
        "These view_repo functions return multiple views but take no "
        "`scope`, so they query the table with no access predicate:\n  "
        + "\n  ".join(offenders)
        + "\n\nAdd `scope: ViewReadScope` and apply "
          "`readable_views_predicate(scope)` to the query. If the function "
          "genuinely reads a single view whose access its caller already "
          "checked, add it to _SINGLE_VIEW_READS with the reason."
    )


def test_scope_parameter_is_keyword_only_and_required():
    """A defaulted scope is a scope someone will forget to pass.

    ``_apply_view_filters`` cannot tell "caller wanted everything" from
    "caller forgot", so there is no safe default — the only correct value
    is one the caller had to think about.
    """
    bad = []
    for name, fn in _public_functions():
        params = inspect.signature(fn).parameters
        scope = params.get("scope")
        if scope is None:
            continue
        if scope.default is not inspect.Parameter.empty:
            bad.append(f"{name}: scope has default {scope.default!r}")
        elif scope.kind is not inspect.Parameter.KEYWORD_ONLY:
            bad.append(f"{name}: scope is {scope.kind}, expected KEYWORD_ONLY")
    assert not bad, "\n".join(bad)


def test_the_exemption_lists_have_no_stale_entries():
    """An exemption for a function that no longer exists hides a real gap."""
    names = {name for name, _ in _public_functions()}
    stale_single = set(_SINGLE_VIEW_READS) - names
    stale_writes = _WRITES - names
    assert not stale_single, f"_SINGLE_VIEW_READS names no longer in view_repo: {sorted(stale_single)}"
    assert not stale_writes, f"_WRITES names no longer in view_repo: {sorted(stale_writes)}"


def test_detects_a_scopeless_multi_view_function():
    """The contract test itself must actually catch the thing it guards.

    Without this, a refactor to the detection logic could silently turn
    the whole file into a no-op that passes forever.
    """
    from typing import List

    from backend.common.models.management import ViewResponse

    async def list_something(session) -> List[ViewResponse]:  # no scope
        ...

    assert _returns_multiple_views(list_something)
    assert "scope" not in inspect.signature(list_something).parameters

    async def list_something_scoped(session, *, scope) -> List[ViewResponse]:
        ...

    assert _returns_multiple_views(list_something_scoped)
    assert "scope" in inspect.signature(list_something_scoped).parameters

    _ = typing, pytest  # keep the imports honest for linters
