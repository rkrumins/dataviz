"""``POST /api/v1/admin/versioning/graphs/{graphId}/adopt`` — Adopt (doc 17): a graph projecting
into the customer's own FalkorDB key moves onto a platform key on the same provider.

* The same reseed move as a projection move (doc 14 §6): a fresh platform key, reseeded from
  Postgres a page at a time, Postgres serving reads until it catches up. With residency on the key
  is placed on the provider's master with the most room, and the seed is admission-checked first:
  409 ``capacity_insufficient`` when it would not fit.
* The customer's key is left exactly as it was: the service never writes, drops or retires it.
* Refused where a move is: an unpinned graph, a graph already on a platform key, a dedicated rollup
  graph (422), a running rollup job, a key other data sources read, a provider whose keys cannot be
  listed; a fork (409 ``not_for_forks``); an unknown graph (404).
* A system administrator's action, recorded, never an API key's.

The swap and the customer's key left untouched run against Postgres and FalkorDB in
``integration/test_graph_residency.py``.
"""
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import BackgroundTasks, HTTPException

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.graph_store.topology import key_slot
from backend.app.services.versioning import keymigrate
from backend.app.services.versioning.errors import JobActive, ProjectionAlreadyAdopted
from backend.app.services.versioning.service import ConcurrencyError

GID = "graph_01J9ZK3M4N5P6Q7R8S9TABCDEF"
_ADMIN = SimpleNamespace(id="usr_admin")
_DRIFT = {"at": "2026-10-30T09:00:00+00:00", "nodes": 2, "edges": 1, "via": "verify"}


class _Svc:
    def __init__(self, *, pin="nexus_lineage", provider="prov_A", owned=False, fork=False,
                 known=True, raises=None):
        self.meta = ({"graph_id": GID, "workspace_id": "ws1", "data_source_id": "ds1",
                      "fork_parent_graph_id": "g0" if fork else None} if known else None)
        self.wm = {"falkor_graph_name": pin, "falkor_provider": provider, "owns_falkor_graph": owned,
                   "retired_keys": [{"name": keymigrate.owned_key(GID, 1), "provider": "prov_A"}],
                   "status": "idle", "residency_state": "resident"}
        self.raises, self.adopted = raises, []

    async def get_graph(self, graph_id):
        return self.meta

    async def projection_watermark(self, graph_id):
        return dict(self.wm)

    async def adopt_projection(self, **kw):
        self.adopted.append(kw)
        if self.raises:
            raise self.raises
        return {"from": {"providerId": "prov_A", "key": self.wm["falkor_graph_name"]},
                "to": {"providerId": "prov_A", "key": kw["key"]}, "externalDrift": _DRIFT}


class _Session:
    def __init__(self, job=None):
        self.job = job

    async def execute(self, stmt):
        return SimpleNamespace(scalar_one_or_none=lambda: self.job)


async def _adopt(svc, *, keys=frozenset(), ds=None, bindings=(), job=None, residency_on=False,
                 fits=(True, "10.0.0.3:6379", 0), placed=None):
    ds = ds if ds is not None else SimpleNamespace(projection_mode=None, provider_id="prov_A")
    seen = {"listed": [], "recorded": [], "placed": [], "bindings": []}

    async def key_bindings(session, provider_id, graph_name, exclude_ds=None):
        seen["bindings"].append((provider_id, graph_name, exclude_ds))
        return list(bindings)

    async def get_ds(session, ds_id):
        return ds

    async def list_keys(provider_id):
        seen["listed"].append(provider_id)
        return None if keys is None else set(keys)

    async def admission(graph_id):
        return fits

    async def place_key(graph_id, provider, taken):
        seen["placed"].append((provider, set(taken)))
        return placed

    async def watermark_model(session, wm):
        return {"wm": wm["falkor_graph_name"]}

    async def record(session, event_type, **fields):
        seen["recorded"].append((event_type, fields))
        return True

    background = BackgroundTasks()
    with ExitStack() as stack:
        for target, name, fn in (
                (va, "get_versioning_service", lambda: svc),
                (va.managed_sources, "graph_key_bindings", key_bindings),
                (va.data_source_repo, "get_data_source_orm", get_ds),
                (va.falkor_graph_registry, "list_graph_keys", list_keys),
                (va.residency, "admission", admission),
                (va.residency, "place_key", place_key),
                (va.vconfig, "RESIDENCY_ENABLED", residency_on),
                (va, "_watermark_model", watermark_model),
                (va.recorder, "record_for_request", record)):
            stack.enter_context(patch.object(target, name, fn))
        out = await va.adopt_projection(GID, background, user=_ADMIN, session=_Session(job))
    return out, background, seen


async def test_adopt_reseeds_a_fresh_platform_key_on_the_same_provider_and_is_recorded():
    svc = _Svc()
    out, background, seen = await _adopt(svc, keys={keymigrate.owned_key(GID, 2), "nexus_lineage"})
    key = keymigrate.owned_key(GID, 3)              # 1 is a retired key, 2 exists on the provider
    (adopted,) = svc.adopted
    assert (adopted["graph_id"], adopted["key"], adopted["actor"]) == (GID, key, "usr_admin")
    assert adopted["shard_map"]["slot"] == key_slot(key)
    assert adopted["shard_map"]["chosenBy"] == "usr_admin"
    assert seen["listed"] == ["prov_A"] and seen["placed"] == []
    assert out == {"graphId": GID, "from": {"providerId": "prov_A", "key": "nexus_lineage"},
                   "to": {"providerId": "prov_A", "key": key}, "watermark": {"wm": "nexus_lineage"}}
    (task,) = background.tasks
    assert (task.func, task.args) == (va.rebuild_now, (GID,))
    ((event, fields),) = seen["recorded"]
    assert event == "platform.versioning.projection_adopted" and fields["best_effort"] is True
    assert fields["details"] == {"graphId": GID, "workspaceId": "ws1", "dataSourceId": "ds1",
                                 "from": out["from"], "to": out["to"], "externalDrift": _DRIFT}


async def test_with_residency_on_the_key_is_placed_and_the_seed_admitted_first():
    placed = keymigrate.owned_key(GID, 7)
    svc = _Svc()
    _out, _bg, seen = await _adopt(svc, residency_on=True, placed=(placed, "10.0.0.3:6379"),
                                   keys={"nexus_lineage"})
    assert svc.adopted[0]["key"] == placed
    assert svc.adopted[0]["shard_map"]["master"] == "10.0.0.3:6379"
    assert seen["placed"] == [("prov_A", {"nexus_lineage", keymigrate.owned_key(GID, 1)})]

    svc = _Svc()
    with pytest.raises(HTTPException) as caught:
        await _adopt(svc, residency_on=True, fits=(False, "10.0.0.2:6379", 2 * 1024 ** 3))
    detail = caught.value.detail
    assert caught.value.status_code == 409 and detail["type"] == "capacity_insufficient"
    assert (detail["master"], detail["shortfallBytes"]) == ("10.0.0.2:6379", 2 * 1024 ** 3)
    assert svc.adopted == []


@pytest.mark.parametrize("svc, status, kind", [
    (_Svc(known=False), 404, None),
    (_Svc(fork=True), 409, "not_for_forks"),
    (_Svc(pin=None), 409, "projection_not_adopted"),
    (_Svc(pin=f"gv_{GID}"), 409, "projection_not_adopted"),
    (_Svc(pin=keymigrate.owned_key(GID, 1), owned=True), 409, "already_adopted"),
])
async def test_what_cannot_be_adopted_is_refused_before_anything_is_written(svc, status, kind):
    with pytest.raises(Exception) as caught:
        await _adopt(svc)
    assert caught.value.status_code == status
    if kind:
        assert caught.value.detail["type"] == kind
    assert svc.adopted == []


async def test_a_dedicated_rollup_graph_a_running_rollup_job_or_a_shared_key_is_refused():
    svc = _Svc()
    with pytest.raises(HTTPException) as caught:
        await _adopt(svc, ds=SimpleNamespace(projection_mode="dedicated", provider_id="prov_A"))
    assert (caught.value.status_code, caught.value.detail["type"]) == (
        422, "projection_mode_unsupported")
    with pytest.raises(JobActive):
        await _adopt(svc, job="agg_1")
    with pytest.raises(Exception) as caught:
        await _adopt(svc, bindings=[{"dataSourceId": "ds2"}])
    assert caught.value.detail["type"] == "projection_not_adopted"
    assert caught.value.detail["reason"] == "shared"
    with pytest.raises(HTTPException) as caught:
        await _adopt(svc, keys=None)                 # cannot verify a key is free: never assume it
    assert (caught.value.status_code, caught.value.detail["type"]) == (503, "provider_unreachable")
    assert svc.adopted == []


@pytest.mark.parametrize("raises, status, kind", [
    (ConcurrencyError("enabling version control has not finished"), 409, "bootstrapping"),
    (ProjectionAlreadyAdopted("gvp_x"), 409, "already_adopted"),
])
async def test_what_the_service_refuses_is_answered(raises, status, kind):
    with pytest.raises(HTTPException) as caught:
        await _adopt(_Svc(raises=raises))
    assert (caught.value.status_code, caught.value.detail["type"]) == (status, kind)


def test_the_route_is_for_platform_admins_only_and_never_for_api_keys():
    path = "/api/v1/admin/versioning/graphs/{graph_id}/adopt"
    found = [(r, d) for m, p, r, d in api_key_surface.routes(app) if p == path and m == "POST"]
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
    event = "platform.versioning.projection_adopted"
    severity, summary = catalogue.summarize(event, {"details": {
        "graphId": GID, "from": {"key": "nexus_lineage"}, "to": {"key": "gvp_x"}}})
    assert severity == "info" and GID in summary and "nexus_lineage" in summary
    assert catalogue.LABELS[event] and catalogue.category_of(event) == "platform"
