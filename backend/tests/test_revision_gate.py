"""A graph read that names a past revision (``?asOfSeq=``) is held to the routes that can answer it.

Every ``/{ws_id}/graph`` route carries ``revision_gate``. With the switch on (as it ships), a route on
``REVISION_READS`` builds its engine at the revision; a write, or a read that only plans one, is 409
``revision_read_only``; every other route 501 ``revision_unsupported`` — never the graph as it is
now. With the switch turned off a request naming a revision is 403 ``feature_disabled``, and
one naming none is as before. A view's share link reaches the graph as it is now, not its history.
"""
import asyncio
import time
from typing import Optional

import pytest
from fastapi import Depends, FastAPI, HTTPException
from starlette.requests import Request

from backend.app.api.v1 import revision_gate as rg
from backend.app.api.v1.endpoints import graph as G
from backend.app.auth import api_key_surface
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims

WS = "/api/v1/ws1/graph"


def _flags(**values):
    feature_flags._cache = {**(feature_flags._cache or {}), **values}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture()
def on():
    _flags(revisionViewerEnabled=True, versioningEnabled=True)
    yield
    _flags(revisionViewerEnabled=False, versioningEnabled=True)


@pytest.fixture()
def engine_sees(test_client):
    """The engine, replaced by one that answers 418 with the revision it was asked to read at."""
    from backend.app.main import app

    async def engine(asOfSeq: Optional[int] = Depends(rg.revision_gate)):
        raise HTTPException(status_code=418, detail={"asOfSeq": asOfSeq})

    app.dependency_overrides[G.get_context_engine] = engine
    return test_client


def _calls(dependant):
    stack = [dependant]
    while stack:
        dep = stack.pop()
        if getattr(dep, "call", None) is not None:
            yield dep.call
        stack.extend(dep.dependencies)


def _graph_routes():
    from backend.app.api.v2.api import api_v2_router
    from backend.app.main import app

    v2 = FastAPI()                                     # mounted only with TRACE_V2_ENABLED
    v2.include_router(api_v2_router, prefix="/api/v2")
    for source in (app, v2):
        for method, path, route, dependant in api_key_surface.routes(source):
            if "/{ws_id}/graph" in path:
                yield method, path, route, dependant


def _key(route):
    return route.endpoint.__module__, route.endpoint.__name__


# ── Every graph route is held to it ──────────────────────────────────────────────────────────────

def test_every_graph_route_carries_the_gate():
    routes = list(_graph_routes())
    assert len(routes) > 70
    ungated = sorted(f"{m} {p}" for m, p, _r, d in routes if rg.revision_gate not in set(_calls(d)))
    assert not ungated, f"mount these with Depends(revision_gate): {ungated}"


def test_what_reads_a_revision_reads_it_through_the_engine_and_every_write_is_refused_as_one():
    routes = list(_graph_routes())
    routed = {_key(r) for _m, _p, r, _d in routes}
    assert rg.REVISION_READS <= routed, sorted(rg.REVISION_READS - routed)
    assert rg.REVISION_WRITES <= routed, sorted(rg.REVISION_WRITES - routed)
    assert not rg.REVISION_READS & rg.REVISION_WRITES
    for method, path, route, dependant in routes:
        if _key(route) in rg.REVISION_READS:
            assert G.get_context_engine in set(_calls(dependant)), f"{method} {path}"
            assert method in ("GET", "POST"), f"{method} {path}"
        if method in ("PUT", "PATCH", "DELETE"):
            assert _key(route) in rg.REVISION_WRITES, f"{method} {path} writes: list it"


def test_the_client_lists_the_reads_a_revision_answers():
    """The client refuses at a revision, before sending it, every read the server would refuse: its
    list (frontend/src/providers/revisionReads.ts) and this gate's are one, the fixture both read."""
    import re
    from pathlib import Path
    fixture = Path(__file__).parent / "fixtures" / "revision_reads.txt"
    listed = {line.strip() for line in fixture.read_text().splitlines()
              if line.strip() and not line.startswith("#")}
    served = {f"{method} " + re.sub(r"\{[^}]+\}", "{urn}", path.split("/{ws_id}/graph", 1)[1])
              for method, path, route, _d in _graph_routes() if _key(route) in rg.REVISION_READS}
    assert listed == served


# ── What a request naming a revision is answered ─────────────────────────────────────────────────

async def test_a_listed_read_builds_its_engine_at_the_revision(engine_sees, on):
    resp = await engine_sees.get(f"{WS}/nodes/urn:a", params={"asOfSeq": 3})
    assert resp.status_code == 418 and resp.json()["detail"] == {"asOfSeq": 3}
    resp = await engine_sees.post(f"{WS}/canvas/bootstrap", params={"asOfSeq": 0}, json={})
    assert resp.status_code == 418 and resp.json()["detail"] == {"asOfSeq": 0}
    # A name search is the one search that reads the graph as it was, and a closure the one trace.
    resp = await engine_sees.post(f"{WS}/search/names", params={"asOfSeq": 3}, json={"q": "x"})
    assert resp.status_code == 418 and resp.json()["detail"] == {"asOfSeq": 3}
    resp = await engine_sees.post(f"{WS}/trace/closure", params={"asOfSeq": 3}, json={"urn": "u"})
    assert resp.status_code == 418 and resp.json()["detail"] == {"asOfSeq": 3}


async def test_a_read_naming_no_revision_is_as_before_whatever_the_switch(engine_sees):
    resp = await engine_sees.get(f"{WS}/nodes/urn:a")
    assert resp.status_code == 418 and resp.json()["detail"] == {"asOfSeq": None}
    resp = await engine_sees.post(f"{WS}/search", json={"query": "x"})
    assert resp.status_code == 418


async def test_a_write_at_a_revision_is_refused_as_read_only(engine_sees, on):
    resp = await engine_sees.post(f"{WS}/nodes/create", params={"asOfSeq": 3},
                                  json={"urn": "urn:z", "entityType": "Table", "displayName": "Z"})
    assert resp.status_code == 409 and resp.json()["detail"]["type"] == "revision_read_only"
    resp = await engine_sees.delete(f"{WS}/edges/e1", params={"asOfSeq": 3})
    assert resp.status_code == 409 and resp.json()["detail"]["type"] == "revision_read_only"


async def test_a_read_that_answers_from_now_is_refused_never_answered(engine_sees, on):
    for method, path, body in (("post", "/search", {"query": "x"}),
                               ("post", "/search/advanced", {}),
                               ("post", "/trace/v2", {}),
                               ("post", "/trace/expand", {}),
                               ("get", "/metadata/entity-types", None),
                               ("get", "/stats", None),
                               ("get", "/metadata/schema", None)):
        kw = {"params": {"asOfSeq": 3}}
        if body is not None:
            kw["json"] = body
        resp = await getattr(engine_sees, method)(f"{WS}{path}", **kw)
        assert resp.status_code == 501, (path, resp.text)
        assert resp.json()["detail"]["type"] == "revision_unsupported", path
        assert resp.json()["detail"]["reason"] == "route", path


async def test_the_switch_off_refuses_a_revision(engine_sees):
    _flags(revisionViewerEnabled=False)
    resp = await engine_sees.get(f"{WS}/nodes/urn:a", params={"asOfSeq": 3})
    assert resp.status_code == 403
    assert resp.json()["detail"]["type"] == "feature_disabled"
    assert resp.json()["detail"]["feature"] == "revisionViewerEnabled"


async def test_version_control_off_refuses_a_revision(engine_sees, on):
    _flags(versioningEnabled=False)
    resp = await engine_sees.get(f"{WS}/nodes/urn:a", params={"asOfSeq": 3})
    assert resp.status_code == 403 and resp.json()["detail"]["feature"] == "versioningEnabled"


async def test_a_revision_must_be_a_seq(engine_sees, on):
    resp = await engine_sees.get(f"{WS}/nodes/urn:a", params={"asOfSeq": -1})
    assert resp.status_code == 422


def _request(path="/api/v1/ws1/graph/nodes/urn:a"):
    return Request({"type": "http", "method": "GET", "path": path, "headers": [],
                    "query_string": b"", "path_params": {"ws_id": "ws1"}})


def test_a_view_link_reaches_the_graph_as_it_is_now_not_its_history(on):
    """A share link's identity holds no data source read (``capability_gate``)."""
    viewer = PermissionClaims(sid="s", global_perms=(), ws_perms={"ws1": ()})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(rg.revision_gate(_request(), asOfSeq=3, claims=viewer))
    assert exc.value.status_code == 403 and exc.value.detail["error"] == "missing_permission"
    # Grants that could not be read are an unanswered question, not a refusal.
    unknown = PermissionClaims(sid="s", global_perms=(), ws_perms={}, ws_available=False)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(rg.revision_gate(_request(), asOfSeq=3, claims=unknown))
    assert exc.value.status_code == 503
    # And none of it is asked when no revision is named.
    assert asyncio.run(rg.revision_gate(_request(), asOfSeq=None, claims=viewer)) is None
