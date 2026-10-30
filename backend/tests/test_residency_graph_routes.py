"""A system administrator's residency actions on one graph (doc 17), under ``/admin/versioning``.

* ``POST /graphs/{gid}/load`` — Load now: asks for an evicted graph's load, which admission
  decides like any other; a graph in FalkorDB is left alone.
* ``PUT /graphs/{gid}/residency`` ``{"class": ...}`` — Always, Standard or Coldline. Always on a
  graph out of FalkorDB is admission-checked now: 409 ``capacity_insufficient`` naming the master
  and the shortfall when its load would not fit, else its load is asked for. Recorded.

A fork has no key of its own: 409 ``not_for_forks``. System administrators only, never an API key.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.versioning import residency

_ADMIN = SimpleNamespace(id="usr_admin")


class _Svc:
    def __init__(self, state="resident", residency_class="standard", fork=False, known=True):
        self.wm = {"residency": residency_class, "residency_state": state,
                   "status": {"resident": "idle"}.get(state, state)}
        self.meta = ({"graph_id": "g1", "workspace_id": "ws1", "data_source_id": "ds1",
                      "fork_parent_graph_id": "g0" if fork else None} if known else None)

    async def get_graph(self, gid):
        return self.meta

    async def projection_watermark(self, gid):
        return dict(self.wm)


@pytest.fixture
def world(monkeypatch):
    """What the routes asked for, set and recorded."""
    out = SimpleNamespace(loads=[], classes=[], recorded=[], admission=(True, "m1:6379", 0))

    async def request_load(gid):
        out.loads.append(gid)

    async def set_class(gid, residency_class):
        out.classes.append((gid, residency_class))
        return out.svc.wm["residency"]

    async def admission(gid):
        return out.admission

    async def record(session, event_type, **fields):
        out.recorded.append((event_type, fields))
        return True

    monkeypatch.setattr(residency, "request_load", request_load)
    monkeypatch.setattr(residency, "set_class", set_class)
    monkeypatch.setattr(residency, "admission", admission)
    monkeypatch.setattr(va.recorder, "record_for_request", record)
    out.svc = _Svc()
    monkeypatch.setattr(va, "get_versioning_service", lambda: out.svc)
    return out


async def test_load_now_asks_for_an_evicted_graph_s_load(world):
    for state in ("evicted", "waiting_capacity"):
        world.svc = _Svc(state=state)
        out = await va.load_graph("g1", _user=_ADMIN)
        assert out == {"graphId": "g1", "state": state, "loadRequested": True}
    assert world.loads == ["g1", "g1"]


async def test_load_now_leaves_a_graph_in_falkordb_or_loading_alone(world):
    for state in ("resident", "rehydrating"):
        world.svc = _Svc(state=state)
        out = await va.load_graph("g1", _user=_ADMIN)
        assert out["loadRequested"] is False and out["state"] == state
    assert world.loads == []


@pytest.mark.parametrize("call", ["load", "class"])
async def test_an_unknown_graph_is_a_404_and_a_fork_a_409(world, call):
    async def run():
        if call == "load":
            return await va.load_graph("g1", _user=_ADMIN)
        return await va.set_graph_residency(
            "g1", va.ResidencyClassRequest.model_validate({"class": "always"}),
            user=_ADMIN, session=object())

    world.svc = _Svc(known=False)
    with pytest.raises(HTTPException) as caught:
        await run()
    assert caught.value.status_code == 404
    world.svc = _Svc(fork=True)
    with pytest.raises(HTTPException) as caught:
        await run()
    assert caught.value.status_code == 409 and caught.value.detail["type"] == "not_for_forks"
    assert world.loads == world.classes == world.recorded == []


async def _set(world, residency_class):
    return await va.set_graph_residency(
        "g1", va.ResidencyClassRequest.model_validate({"class": residency_class}),
        user=_ADMIN, session=object())


async def test_always_on_a_graph_out_of_falkordb_that_does_not_fit_is_refused(world):
    world.svc = _Svc(state="evicted")
    world.admission = (False, "10.0.0.2:6379", 3 * 1024 ** 3)
    with pytest.raises(HTTPException) as caught:
        await _set(world, "always")
    detail = caught.value.detail
    assert caught.value.status_code == 409 and detail["type"] == "capacity_insufficient"
    assert detail["master"] == "10.0.0.2:6379" and detail["shortfallBytes"] == 3 * 1024 ** 3
    assert "10.0.0.2:6379" in detail["message"] and "3.0 GiB" in detail["message"]
    assert world.classes == world.loads == world.recorded == []


async def test_always_on_a_graph_out_of_falkordb_that_fits_is_set_and_loaded(world):
    world.svc = _Svc(state="evicted", residency_class="coldline")
    out = await _set(world, "always")
    assert out == {"graphId": "g1", "residency": "always", "state": "evicted"}
    assert world.classes == [("g1", "always")] and world.loads == ["g1"]
    assert world.recorded == [("platform.versioning.residency_changed", {
        "details": {"graphId": "g1", "workspaceId": "ws1", "dataSourceId": "ds1",
                    "from": "coldline", "to": "always"}, "best_effort": True})]


async def test_any_class_on_a_resident_graph_is_set_with_no_admission_and_no_load(world):
    world.admission = (False, "m1:6379", 1)                    # would refuse, if it were asked
    for cls in ("always", "coldline"):
        await _set(world, cls)
    assert world.classes == [("g1", "always"), ("g1", "coldline")] and world.loads == []
    assert [r[1]["details"]["to"] for r in world.recorded] == ["always", "coldline"]


async def test_the_same_class_again_records_nothing(world):
    await _set(world, "standard")
    assert world.recorded == []


def test_only_the_three_classes():
    with pytest.raises(ValidationError):
        va.ResidencyClassRequest.model_validate({"class": "hot"})


@pytest.mark.parametrize("path, method", [
    ("/api/v1/admin/versioning/graphs/{graph_id}/load", "POST"),
    ("/api/v1/admin/versioning/graphs/{graph_id}/residency", "PUT"),
])
def test_the_routes_are_for_platform_admins_only(path, method):
    found = [(r, d) for m, p, r, d in api_key_surface.routes(app) if p == path and m == method]
    assert len(found) == 1
    route, dependant = found[0]
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perms.add(getattr(getattr(dep, "call", None), "required_permission", None))
        stack.extend(dep.dependencies)
    assert "system:admin" in perms
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def test_the_activity_log_can_say_what_happened():
    severity, summary = catalogue.summarize(
        "platform.versioning.residency_changed",
        {"details": {"graphId": "g1", "from": "standard", "to": "always"}})
    assert severity == "info" and "g1" in summary and "always" in summary.lower()
    assert catalogue.LABELS["platform.versioning.residency_changed"]
    assert catalogue.category_of("platform.versioning.residency_changed") == "platform"
