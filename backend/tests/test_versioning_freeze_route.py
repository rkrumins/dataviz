"""``POST /api/v1/{ws}/versioning/graphs/{graph_id}/lifecycle/freeze`` and ``…/unfreeze`` — a
publisher pauses and resumes editing of a versioned graph.

* Both need ``workspace:datasource:publish`` and ``manage``, and are not open to API keys.
* A real change is recorded in the activity log once; repeating it changes and records nothing.
* A stale ``expectedRev`` is 409 ``version_conflict`` naming the current rev.
"""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import graph as G
from backend.app.api.v1.endpoints import versioning as V
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.versioning.errors import VersionConflict

_BASE = "/api/v1/{ws_id}/versioning/graphs/{graph_id}/lifecycle/"
_META = {"graph_id": "g1", "workspace_id": "ws1", "data_source_id": "ds1"}


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


@pytest.mark.parametrize("verb", ["freeze", "unfreeze"])
def test_freeze_and_unfreeze_need_publish_and_manage(verb):
    found = [(m, r, d) for m, p, r, d in api_key_surface.routes(app) if p == _BASE + verb]
    assert [m for m, _, _ in found] == ["POST"], found
    _, route, dependant = found[0]
    assert {"workspace:datasource:publish", "workspace:datasource:manage"} <= _gate_perms(dependant)
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


class _Svc:
    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    async def set_frozen(self, **kw):
        self.calls.append(kw)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


async def _freeze(svc, rev):
    return await V.freeze_graph(ws_id="ws1", graph_id="g1", body=V.LifecycleRequest(expectedRev=rev),
                                _user=SimpleNamespace(id="u"), _publisher=SimpleNamespace(id="u"),
                                meta=_META, svc=svc, session=object())


@pytest.mark.asyncio
async def test_a_freeze_is_recorded_once():
    svc, recorded = _Svc({"graph_id": "g1", "state": "frozen", "rev": 1, "changed": True},
                         {"graph_id": "g1", "state": "frozen", "rev": 1, "changed": False}), []

    async def record(session, event_type, data_source_id, details=None):
        recorded.append((event_type, data_source_id, details))

    with patch.object(G, "_record_versioning", record):
        first = await _freeze(svc, 0)
        again = await _freeze(svc, 0)

    assert svc.calls == [{"graph_id": "g1", "frozen": True, "expected_rev": 0}] * 2
    assert V.LifecycleResponse.model_validate(first).model_dump(by_alias=True) == {
        "graphId": "g1", "state": "frozen", "rev": 1}
    assert again["rev"] == 1
    assert recorded == [("workspace.versioning.frozen", "ds1", {"graphId": "g1", "rev": 1})]


@pytest.mark.asyncio
async def test_an_unfreeze_is_recorded_as_such():
    svc, recorded = _Svc({"graph_id": "g1", "state": "live", "rev": 2, "changed": True}), []

    async def record(session, event_type, data_source_id, details=None):
        recorded.append(event_type)

    with patch.object(G, "_record_versioning", record):
        await V.unfreeze_graph(ws_id="ws1", graph_id="g1", body=V.LifecycleRequest(expectedRev=1),
                               _user=SimpleNamespace(id="u"), _publisher=SimpleNamespace(id="u"),
                               meta=_META, svc=svc, session=object())

    assert svc.calls == [{"graph_id": "g1", "frozen": False, "expected_rev": 1}]
    assert recorded == ["workspace.versioning.unfrozen"]


@pytest.mark.asyncio
async def test_a_stale_rev_is_409_version_conflict():
    with pytest.raises(HTTPException) as refused:
        await _freeze(_Svc(VersionConflict("lifecycle", 2)), 0)
    assert refused.value.status_code == 409
    detail = refused.value.detail
    assert (detail["type"], detail["resource"], detail["currentVersion"]) == ("version_conflict",
                                                                              "lifecycle", 2)


def test_expected_rev_is_required_and_not_negative():
    with pytest.raises(ValueError):
        V.LifecycleRequest.model_validate({})
    with pytest.raises(ValueError):
        V.LifecycleRequest.model_validate({"expectedRev": -1})


@pytest.mark.parametrize("event_type", ["workspace.versioning.frozen", "workspace.versioning.unfrozen"])
def test_the_activity_log_can_say_what_happened(event_type):
    _, summary = catalogue.summarize(event_type, {"target_label": "Orders"})
    assert "Orders" in summary
    assert catalogue.LABELS[event_type]
