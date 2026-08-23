"""Every ``limit`` query parameter has an upper bound.

Eight graph endpoints declared ``Query(100, ge=1)`` — a lower bound and
nothing else — so ``?limit=100000000`` was accepted and flowed into
SKIP/LIMIT against FalkorDB. They are the costliest reads in the app
(node and edge listings, ancestors, descendants), and the only thing
stopping one was the 60-second tier timeout, which still occupies a
worker for the full minute.

Written as a walk over the live route graph rather than eight cases,
because the failure mode is *forgetting*: the same file already had a
correctly capped listing three hundred lines above the uncapped ones.
A drift guard catches the ninth one; eight hand-written cases do not.

The same walk pattern as ``test_nav_catalogue`` — see ``_walk`` there,
which reads permission tags off route dependencies.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute

from backend.app.main import app


#: Parameter names that page or slice a result set. A bound on these is
#: what keeps one request from asking for the whole graph.
_BOUNDED_PARAMS = ("limit", "page_size", "per_page", "top_k")

#: Paths where an unbounded value cannot cost anything — none today.
#: Kept so an exemption has to be written down and justified rather than
#: achieved by quietly dropping ``le=``.
_ALLOWED_UNBOUNDED: set[str] = set()


def _iter_routes():
    """Yield ``(path, dependant)`` for every mounted APIRoute.

    Newer FastAPI includes routers lazily: children no longer flatten
    into ``app.routes`` but sit under ``_IncludedRouter`` wrappers, and
    only ``effective_candidates()`` resolves their absolute paths. A
    naive walk over ``app.routes`` finds nine health endpoints and
    reports success — which is why the self-check below exists.

    Same traversal as ``test_nav_catalogue._iter_route_gates``.
    """
    import fastapi.routing as _fr

    def _emit(ctx):
        original = getattr(ctx, "original_route", None)
        if isinstance(original, APIRoute):
            path = getattr(ctx, "path", "") or ""
            dependant = getattr(ctx, "dependant", None) or original.dependant
            yield path, dependant

    def _walk(routes):
        for route in routes:
            if isinstance(route, _fr._IncludedRouter):
                for cand in route.effective_candidates():
                    if isinstance(cand, _fr._IncludedRouter):
                        yield from _walk([cand])
                    else:
                        yield from _emit(cand)
                for cand in route.effective_low_priority_routes():
                    yield from _emit(cand)
            elif isinstance(route, APIRoute):
                yield route.path, route.dependant

    yield from _walk(app.routes)


def _unbounded_params(dependant) -> list[str]:
    offenders = []
    for param in dependant.query_params:
        if param.name.lower() not in _BOUNDED_PARAMS:
            continue
        field_info = getattr(param, "field_info", None)
        metadata = getattr(field_info, "metadata", ()) or ()
        has_upper = any(
            hasattr(m, "le") or hasattr(m, "lt") for m in metadata
        )
        if not has_upper:
            offenders.append(param.name)
    return offenders


def test_every_paging_parameter_declares_an_upper_bound():
    findings: list[str] = []
    for path, dependant in _iter_routes():
        if path in _ALLOWED_UNBOUNDED:
            continue
        for name in _unbounded_params(dependant):
            findings.append(f"{path} — {name}")

    assert not findings, (
        "These parameters accept an unbounded value. Add ``le=`` (the graph "
        "listings use 1000), or add the route to _ALLOWED_UNBOUNDED with a "
        "reason:\n  " + "\n  ".join(sorted(set(findings)))
    )


def test_the_guard_can_actually_see_a_missing_bound():
    """Asserts the walk works, so a green run means something.

    A route-graph test that silently matches zero routes is the classic
    way this kind of guard stops testing anything.
    """
    from fastapi import Query

    probe = FastAPI()

    @probe.get("/unbounded")
    async def _unbounded(limit: int = Query(100, ge=1)):  # noqa: ANN202
        return limit

    @probe.get("/bounded")
    async def _bounded(limit: int = Query(100, ge=1, le=50)):  # noqa: ANN202
        return limit

    by_path = {
        r.path: r.dependant for r in probe.routes if isinstance(r, APIRoute)
    }
    assert _unbounded_params(by_path["/unbounded"]) == ["limit"]
    assert _unbounded_params(by_path["/bounded"]) == []


def test_the_walk_reaches_the_real_route_graph():
    """Without this, a traversal that finds nothing reports success."""
    paths = [p for p, _d in _iter_routes()]
    assert len(paths) > 100, f"only {len(paths)} routes walked"
    assert any("/graph/nodes" in p for p in paths)
    # And it must reach a route that actually declares a limit, or the
    # main assertion is vacuous.
    assert any(
        _has_limit_param(d) for _p, d in _iter_routes()
    ), "no route with a limit parameter was reached"


def _has_limit_param(dependant) -> bool:
    return any(
        p.name.lower() in _BOUNDED_PARAMS for p in dependant.query_params
    )
