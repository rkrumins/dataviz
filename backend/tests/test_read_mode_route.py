"""A graph's own read mode (``PUT /admin/versioning/graphs/{graph_id}/read-mode``): what its readers
get while a newer version lands — ``latest``, ``in_place`` or ``beside`` — or null, the platform's.
For system administrators only, never an API key; a fork follows its root; ``beside`` needs a key
the platform owns; a change is recorded with the mode before and after.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.activity import catalogue

_ADMIN = SimpleNamespace(id="usr_admin")


class _Svc:
    """The versioning service as the route uses it: one graph, its key's owner and its mode."""

    def __init__(self, *, fork=False, owned=True, mode=None, projected=True):
        self.fork, self.owned, self.mode, self.projected = fork, owned, mode, projected
        self.set_to = []

    async def get_graph(self, graph_id):
        if graph_id != "g1":
            return None
        return {"graph_id": "g1", "workspace_id": "ws1", "data_source_id": "ds1",
                "fork_parent_graph_id": "g0" if self.fork else None}

    async def projection_watermark(self, graph_id):
        return {"owns_falkor_graph": self.owned, "read_mode": self.mode or "in_place"}

    async def set_read_mode(self, graph_id, mode):
        self.set_to.append(mode)
        if not self.projected:
            return False, None
        before, self.mode = self.mode, mode
        return True, before


async def _put(svc, mode, graph_id="g1"):
    recorded = []

    async def record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    with patch.object(va, "get_versioning_service", lambda: svc), \
            patch.object(va.recorder, "record_for_request", record):
        out = await va.set_graph_read_mode(graph_id, va.ReadModeRequest(mode=mode),
                                           user=_ADMIN, session=None)
    return out, recorded


async def test_a_graph_takes_a_mode_of_its_own_and_null_gives_it_the_platforms_again():
    svc = _Svc()
    out, recorded = await _put(svc, "latest")
    assert out == {"graphId": "g1", "readMode": "latest", "readModeEffective": "latest"}
    assert recorded == [("platform.versioning.read_mode_changed", {"details": {
        "graphId": "g1", "workspaceId": "ws1", "dataSourceId": "ds1",
        "from": None, "to": "latest"}, "best_effort": True})]
    out, recorded = await _put(svc, None)
    assert out["readMode"] is None and recorded[0][1]["details"]["from"] == "latest"


async def test_the_same_mode_again_records_nothing():
    _out, recorded = await _put(_Svc(mode="beside"), "beside")
    assert recorded == []


@pytest.mark.parametrize("svc, mode, status, kind", [
    (_Svc(fork=True), "latest", 409, "not_for_forks"),
    (_Svc(owned=False), "beside", 422, "read_mode_unavailable"),
    (_Svc(projected=False), "latest", 409, "not_projected"),
])
async def test_what_a_graph_cannot_take_is_refused_naming_why(svc, mode, status, kind):
    with pytest.raises(HTTPException) as exc:
        await _put(svc, mode)
    assert exc.value.status_code == status and exc.value.detail["type"] == kind


async def test_a_customers_own_key_may_still_read_latest_or_in_place():
    for mode in ("latest", "in_place"):
        out, _ = await _put(_Svc(owned=False), mode)
        assert out["readMode"] == mode


async def test_an_unknown_graph_is_a_404():
    with pytest.raises(HTTPException) as exc:
        await _put(_Svc(), "latest", graph_id="nope")
    assert exc.value.status_code == 404


def test_an_unknown_mode_is_refused_before_the_route():
    with pytest.raises(ValueError):
        va.ReadModeRequest(mode="fastest")


def test_the_route_is_for_platform_admins_only_and_never_for_api_keys():
    routes = {m: (r, d) for m, p, r, d in api_key_surface.routes(app)
              if p == "/api/v1/admin/versioning/graphs/{graph_id}/read-mode"}
    assert set(routes) == {"PUT"}
    route, dependant = routes["PUT"]
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    assert "system:admin" in perms
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def test_the_activity_log_says_what_readers_get_now():
    severity, summary = catalogue.summarize("platform.versioning.read_mode_changed",
                                            {"details": {"graphId": "g1", "to": "beside"}})
    assert severity == "info" and "switch when ready" in summary
    _sev, summary = catalogue.summarize("platform.versioning.read_mode_changed",
                                        {"details": {"graphId": "g1", "to": None}})
    assert "platform default" in summary
    assert catalogue.LABELS["platform.versioning.read_mode_changed"]
