"""Deleting, restoring and listing a graph's forks over HTTP.

* deleting and restoring a fork need ``workspace:datasource:manage``, listing a graph's forks
  needs ``…:read``, and no API key reaches any of them;
* a delete or a restore that changed something is recorded once; a restore that changed
  nothing, and every refusal, records nothing and answers 409 with its type.

The service rules run against Postgres in ``integration/test_versioning_fork.py``.
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning as V
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.activity import recorder
from backend.app.services.versioning.errors import LiveForks, NotAFork
from backend.app.services.versioning.service import PullRequestExists

_BASE = "/api/v1/{ws_id}/versioning/graphs/{graph_id}"
_ROUTES = {
    ("DELETE", _BASE): "workspace:datasource:manage",
    ("POST", _BASE + "/restore"): "workspace:datasource:manage",
    ("GET", _BASE + "/forks"): "workspace:datasource:read",
}


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def _mounted() -> dict:
    return {(m, p): (r, d) for m, p, r, d in api_key_surface.routes(app) if (m, p) in _ROUTES}


def test_fork_routes_are_mounted_with_their_permissions():
    found = _mounted()
    assert set(found) == set(_ROUTES)
    for key, perm in _ROUTES.items():
        assert _gate_perms(found[key][1]) == {perm}, key


def test_an_api_key_cannot_reach_them():
    for route, _ in _mounted().values():
        assert api_key_surface.rule_of(route) is None, route.endpoint.__name__
    for name in ("delete_fork", "restore_fork", "list_forks"):
        assert (V.__name__, name) not in api_key_surface.SURFACE


class _Svc:
    def __init__(self, answer):
        self.answer = answer

    async def _call(self, **_kw):
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer

    delete_fork = restore_fork = _call


@pytest.fixture
def recorded(monkeypatch):
    seen = []

    async def _record(_session, event_type, **fields):
        seen.append((event_type, fields))
        return True

    monkeypatch.setattr(recorder, "record_for_request", _record)
    return seen


_USER = SimpleNamespace(id="u1")


async def _delete(answer):
    return await V.delete_fork(ws_id="ws1", graph_id="f1", user=_USER, _meta={},
                               svc=_Svc(answer), session=None)


async def _restore(answer):
    return await V.restore_fork(ws_id="ws1", graph_id="f1", _user=_USER, svc=_Svc(answer),
                                session=None)


@pytest.mark.asyncio
async def test_delete_and_restore_record_once(recorded):
    await _delete("p1")
    await _restore("p1")
    assert recorded == [
        (f"workspace.versioning.fork_{verb}", {
            "workspace_id": "ws1", "target_type": "versioned_graph", "target_id": "f1",
            "details": {"forkParentGraphId": "p1"}, "best_effort": True})
        for verb in ("deleted", "restored")]


@pytest.mark.asyncio
@pytest.mark.parametrize("call, exc, kind", [
    (_delete, NotAFork("f1"), "not_a_fork"),
    (_delete, LiveForks("f1", 1), "live_forks"),
    (_delete, PullRequestExists("pr1", "br1"), "pull_request_exists"),
    (_restore, NotAFork("f1"), "not_a_fork"),
])
async def test_a_refusal_records_nothing(recorded, call, exc, kind):
    with pytest.raises(HTTPException) as err:
        await call(exc)
    assert (err.value.status_code, err.value.detail["type"]) == (409, kind)
    assert recorded == []


@pytest.mark.asyncio
async def test_a_restore_that_changed_nothing_records_nothing(recorded):
    await _restore(None)
    assert recorded == []
