"""``POST /api/v1/admin/versioning/graphs/{graphId}/projection/move`` — move a versioned graph's
projection to another FalkorDB provider or key (doc 14 §6 KeyMigration, phase 1).

* It is a platform administrator's action (``system:admin``), recorded in the activity log, and it
  is not open to API keys.
* Only a key the platform owns moves: an unpinned graph, a graph still projecting into the
  customer's own key and a key other data sources read are refused before anything is written.
* Without a key it mints the graph's first free platform key on the provider; a retry of a move
  that already happened changes nothing. An explicit key must be the graph's own platform key or
  one of its retired keys (a move back), and must not already exist unless it is ours.
* A move schedules the reseed of the new key and is recorded; the service does the swap.

The swap, the reseed and the old key's retirement run against Postgres in
``integration/test_versioning_projection_provider_routing.py``.
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
from backend.app.services.versioning.errors import (JobActive, LockBusy, ProjectionKeyInUse,
                                                    ProjectionKeyInvalid, ProjectionNotAdopted)
from backend.app.services.versioning.service import ConcurrencyError

_PATH = "/api/v1/admin/versioning/graphs/{graph_id}/projection/move"
GID = "graph_01J9ZK3M4N5P6Q7R8S9TABCDEF"
_ADMIN = SimpleNamespace(id="usr_admin")


class _Svc:
    def __init__(self, *, pin="gvt_k1", provider="prov_A", owned=True, retired=(), raises=None):
        self.wm = {"falkor_graph_name": pin, "falkor_provider": provider,
                   "owns_falkor_graph": owned, "retired_keys": list(retired)}
        self.raises = raises
        self.moves = []

    async def get_graph(self, graph_id):
        return ({"graph_id": GID, "workspace_id": "ws1", "data_source_id": "ds1"}
                if graph_id == GID else None)

    async def projection_watermark(self, graph_id):
        return dict(self.wm)

    async def move_projection(self, **kw):
        self.moves.append(kw)
        if self.raises:
            raise self.raises
        cur = {"providerId": self.wm["falkor_provider"] or "default",
               "key": self.wm["falkor_graph_name"]}
        return {"changed": True, "from": cur,
                "to": {"providerId": kw["provider"], "key": kw["key"]},
                "retiring": {"name": cur["key"], "provider": self.wm["falkor_provider"]}}


class _Session:
    """The management session: only the aggregation-job check reads through it."""

    def __init__(self, job=None):
        self.job = job

    async def execute(self, stmt):
        return SimpleNamespace(scalar_one_or_none=lambda: self.job)


async def _move(svc, body, *, keys=frozenset(), ds=None, bindings=(), job=None):
    """Call the route with its management and FalkorDB lookups stubbed. Returns the response,
    the background tasks, what was recorded and what was asked of the lookups."""
    ds = ds if ds is not None else SimpleNamespace(projection_mode=None, provider_id="prov_ds")
    seen = {"usable": [], "bindings": [], "listed": [], "recorded": []}

    async def usable(session, ws_id, provider_id, *, subject):
        seen["usable"].append((ws_id, provider_id, subject))

    async def key_bindings(session, provider_id, graph_name, exclude_ds=None):
        seen["bindings"].append((provider_id, graph_name, exclude_ds))
        return list(bindings)

    async def get_ds(session, ds_id):
        assert ds_id == "ds1"
        return ds

    async def list_keys(provider_id):
        seen["listed"].append(provider_id)
        return None if keys is None else set(keys)

    async def watermark_model(session, wm):
        return {"wm": wm["falkor_graph_name"]}

    async def record(session, event_type, **fields):
        seen["recorded"].append((event_type, fields))
        return True

    background = BackgroundTasks()
    with ExitStack() as stack:
        for target, name, fn in (
                (va, "get_versioning_service", lambda: svc),
                (va.managed_sources, "assert_provider_usable", usable),
                (va.managed_sources, "graph_key_bindings", key_bindings),
                (va.data_source_repo, "get_data_source_orm", get_ds),
                (va.falkor_graph_registry, "list_graph_keys", list_keys),
                (va, "_watermark_model", watermark_model),
                (va.recorder, "record_for_request", record)):
            stack.enter_context(patch.object(target, name, fn))
        out = await va.move_projection(
            GID if body.pop("graph", True) else "graph_unknown",
            va.ProjectionMoveRequest.model_validate(body), background,
            user=_ADMIN, session=_Session(job))
    return out, background, seen


@pytest.mark.asyncio
async def test_without_a_key_it_mints_the_first_free_platform_key_and_reseeds_it():
    svc = _Svc()
    out, background, seen = await _move(svc, {"providerId": "prov_B"})

    key = keymigrate.owned_key(GID, 1)
    (move,) = svc.moves
    assert {k: move[k] for k in ("graph_id", "provider", "key", "actor")} == {
        "graph_id": GID, "provider": "prov_B", "key": key, "actor": "usr_admin"}
    assert move["shard_map"]["tag"] == f"{GID[-8:].lower()}.1"
    assert move["shard_map"]["slot"] == key_slot(key)
    assert move["shard_map"]["chosenBy"] == "usr_admin" and move["shard_map"]["chosenAt"]
    assert seen["usable"] == [("ws1", "prov_B", "Versioned graph projections")]
    assert seen["listed"] == ["prov_B"]
    assert out == {"graphId": GID, "changed": True,
                   "from": {"providerId": "prov_A", "key": "gvt_k1"},
                   "to": {"providerId": "prov_B", "key": key},
                   "retiring": {"name": "gvt_k1", "provider": "prov_A"},
                   "watermark": {"wm": "gvt_k1"}}

    (task,) = background.tasks
    assert (task.func, task.args) == (va.rebuild_now, (GID,))
    ((event_type, fields),) = seen["recorded"]
    assert event_type == "platform.versioning.projection_moved"
    assert fields["details"] == {"graphId": GID, "workspaceId": "ws1", "dataSourceId": "ds1",
                                 "from": out["from"], "to": out["to"]}
    assert fields["best_effort"] is True


@pytest.mark.asyncio
async def test_a_minted_key_skips_keys_that_exist_and_the_graphs_retired_keys():
    svc = _Svc(retired=[{"name": keymigrate.owned_key(GID, 2), "provider": "prov_C"}])
    await _move(svc, {"providerId": "prov_B"}, keys={keymigrate.owned_key(GID, 1), "other"})
    assert svc.moves[0]["key"] == keymigrate.owned_key(GID, 3)
    assert svc.moves[0]["shard_map"]["tag"] == f"{GID[-8:].lower()}.3"


@pytest.mark.asyncio
async def test_a_retry_without_a_key_changes_nothing():
    """Already on a platform key of that provider: no new key is minted and nothing moves."""
    key = keymigrate.owned_key(GID, 1)
    svc = _Svc(pin=key, provider="prov_B")
    out, background, seen = await _move(svc, {"providerId": "prov_B"})
    assert out["changed"] is False and out["retiring"] is None
    assert out["from"] == out["to"] == {"providerId": "prov_B", "key": key}
    assert svc.moves == [] and seen["listed"] == [] and seen["recorded"] == []
    assert background.tasks == []


@pytest.mark.asyncio
async def test_keys_that_cannot_be_listed_are_never_taken_as_free():
    svc = _Svc()
    with pytest.raises(HTTPException) as exc:
        await _move(svc, {"providerId": "prov_B"}, keys=None)
    assert exc.value.status_code == 503
    assert exc.value.detail["type"] == "provider_unreachable" and exc.value.detail["retryable"]
    assert svc.moves == []


@pytest.mark.asyncio
@pytest.mark.parametrize("key", [
    "nexus_lineage", "gvp_graph_other{abcdefgh.1}", f"gvp_{GID}{{ABCDEFGH.1}}", "gvt_old"])
async def test_an_explicit_key_must_be_the_graphs_own(key):
    # gvt_old is retired, but on another provider.
    svc = _Svc(retired=[{"name": "gvt_old", "provider": "prov_C"}])
    with pytest.raises(ProjectionKeyInvalid) as exc:
        await _move(svc, {"providerId": "prov_B", "key": key})
    assert (exc.value.status_code, exc.value.detail["type"]) == (422, "invalid_target_key")
    assert svc.moves == []


@pytest.mark.asyncio
async def test_a_move_back_onto_a_retired_key_is_accepted_though_it_exists():
    svc = _Svc(pin=keymigrate.owned_key(GID, 1), provider="prov_B",
               retired=[{"name": "gvt_old", "provider": None}])
    out, _, _ = await _move(svc, {"providerId": "default", "key": "gvt_old"}, keys={"gvt_old"})
    assert svc.moves[0]["key"] == "gvt_old" and svc.moves[0]["shard_map"]["tag"] is None
    assert out["changed"] is True


@pytest.mark.asyncio
async def test_a_platform_key_that_already_exists_is_in_use():
    svc = _Svc()
    key = keymigrate.owned_key(GID, 4)
    with pytest.raises(ProjectionKeyInUse) as exc:
        await _move(svc, {"providerId": "prov_B", "key": key}, keys={key})
    assert exc.value.detail == {"type": "graph_key_in_use", "providerId": "prov_B", "key": key,
                                "message": exc.value.detail["message"]}
    assert svc.moves == []


@pytest.mark.asyncio
@pytest.mark.parametrize("pin,owned,reason", [
    (None, True, "unpinned"), (f"gv_{GID}", True, "unpinned"), ("cust", False, "customer_key")])
async def test_only_a_key_the_platform_owns_moves(pin, owned, reason):
    svc = _Svc(pin=pin, owned=owned)
    with pytest.raises(ProjectionNotAdopted) as exc:
        await _move(svc, {"providerId": "prov_B"})
    assert (exc.value.status_code, exc.value.detail["type"], exc.value.detail["reason"]) == (
        409, "projection_not_adopted", reason)
    assert svc.moves == []


@pytest.mark.asyncio
async def test_a_key_other_data_sources_read_is_refused():
    svc = _Svc(provider=None)
    with pytest.raises(ProjectionNotAdopted) as exc:
        await _move(svc, {"providerId": "prov_B"}, bindings=[{"kind": "dataSource"}])
    assert (exc.value.detail["reason"], exc.value.detail["sharedWith"]) == ("shared", 1)
    _, _, seen = await _move(_Svc(provider=None), {"providerId": "prov_B"})
    # A NULL pin provider is the data source's own; its own data source is left out.
    assert seen["bindings"] == [("prov_ds", "gvt_k1", "ds1")]
    assert svc.moves == []


@pytest.mark.asyncio
async def test_a_dedicated_rollup_graph_or_a_running_rollup_job_is_refused():
    svc = _Svc()
    with pytest.raises(HTTPException) as exc:
        await _move(svc, {"providerId": "prov_B"},
                    ds=SimpleNamespace(projection_mode="dedicated", provider_id="prov_ds"))
    assert (exc.value.status_code, exc.value.detail["type"]) == (422, "projection_mode_unsupported")
    with pytest.raises(JobActive) as exc:
        await _move(svc, {"providerId": "prov_B"}, job="agg_1")
    assert exc.value.detail["type"] == "job_active" and exc.value.detail["jobId"] == "agg_1"
    assert svc.moves == []


@pytest.mark.asyncio
@pytest.mark.parametrize("raises,status,kind", [
    (ConcurrencyError("enabling version control has not finished"), 409, "bootstrapping"),
    (LockBusy(), 503, "lock_busy"),
    (ProjectionKeyInUse("prov_B", "k"), 409, "graph_key_in_use")])
async def test_what_the_service_refuses_is_answered(raises, status, kind):
    with pytest.raises(HTTPException) as exc:
        await _move(_Svc(raises=raises), {"providerId": "prov_B"})
    assert (exc.value.status_code, exc.value.detail["type"]) == (status, kind)


@pytest.mark.asyncio
async def test_an_unknown_graph_is_not_found():
    with pytest.raises(HTTPException) as exc:
        await _move(_Svc(), {"providerId": "prov_B", "graph": False})
    assert exc.value.status_code == 404


def _route():
    found = [(m, r, d) for m, p, r, d in api_key_surface.routes(app) if p == _PATH]
    assert [m for m, _, _ in found] == ["POST"], found
    return found[0][1], found[0][2]


def _gate_perms(dependant) -> set:
    perms, stack = set(), [dependant]
    while stack:
        dep = stack.pop()
        perm = getattr(getattr(dep, "call", None), "required_permission", None)
        if perm:
            perms.add(perm)
        stack.extend(dep.dependencies)
    return perms


def test_the_route_is_mounted_for_platform_admins_only():
    _, dependant = _route()
    assert "system:admin" in _gate_perms(dependant)


def test_an_api_key_cannot_reach_it():
    """Keys reach only the routes on the surface; this one is deliberately not there."""
    route, _ = _route()
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE


def test_the_activity_log_can_say_what_happened():
    severity, summary = catalogue.summarize(
        "platform.versioning.projection_moved",
        {"details": {"graphId": GID, "to": {"providerId": "prov_B", "key": "gvp_x"}}})
    assert severity == "warning"
    assert GID in summary and "gvp_x" in summary
    assert catalogue.LABELS["platform.versioning.projection_moved"]
    assert catalogue.category_of("platform.versioning.projection_moved") == "platform"
