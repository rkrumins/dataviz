"""A graph's own read mode (``PUT /admin/versioning/graphs/{graph_id}/read-mode``): what its readers
get while a newer version lands — ``latest``, ``in_place`` or ``beside`` — or null (``inherit``),
its workspace's or the platform's. For system administrators only, never an API key; a fork follows
its root; ``beside`` needs a key the platform owns; a change is recorded with the mode before and
after, in the save's own transaction.

The route saves through the settings store, at the graph's scope (``set_read_mode``): ``legacy_api``,
by the administrator, for the reason they gave; written through to ``projection_state.read_mode``,
so the previous image, rolled back to, reads by it; then announced, and this process reads it at
once. Its answer says the mode in force, where it was chosen and why it differs.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.auth import api_key_surface
from backend.app.common import activity_context
from backend.app.main import app
from backend.app.services.activity import catalogue
from backend.app.services.settings import effects, legacy
from backend.app.services.versioning import build_policy
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.service import GraphVersioningService

_ADMIN = SimpleNamespace(id="usr_admin")
_WHY = [{"code": "builds_off", "text": "...", "fix": {"feature": "candidateKeysEnabled",
                                                      "to": True}}]


class _Svc:
    """The versioning service as the route uses it: one graph, its key's owner and its mode."""

    def __init__(self, *, fork=False, owned=True, mode=None, projected=True):
        self.fork, self.owned, self.mode, self.projected = fork, owned, mode, projected
        self.saved = []

    async def get_graph(self, graph_id):
        if graph_id != "g1":
            return None
        return {"graph_id": "g1", "workspace_id": "ws1", "data_source_id": "ds1",
                "fork_parent_graph_id": "g0" if self.fork else None}

    async def projection_watermark(self, graph_id):
        beside = self.mode == "beside"
        return {"owns_falkor_graph": self.owned,
                "read_mode": "in_place" if beside else self.mode or "latest",
                "read_mode_source": "graph" if self.mode else "platform",
                "read_mode_why": _WHY if beside else []}

    async def set_read_mode(self, graph_id, mode, *, actor=None, reason=None, source="api",
                            session=None, on_change=None, check=None):
        self.saved.append({"mode": mode, "actor": actor, "reason": reason, "source": source,
                           "session": session})
        self.check = check
        if not self.projected:
            return False, None
        before, self.mode = self.mode, mode
        if on_change is not None and before != mode:
            await on_change(session, before)
        return True, before


async def _put(svc, mode, graph_id="g1"):
    recorded = []

    async def record(session, event_type, **fields):
        recorded.append((session, event_type, fields))
        return True

    token = activity_context.bind(activity_context.ActivityContext(
        actor_id=_ADMIN.id, stated_reason="Large imports on Mondays"))
    try:
        with patch.object(va, "get_versioning_service", lambda: svc), \
                patch.object(va.recorder, "record_for_request", record):
            out = await va.set_graph_read_mode(graph_id, va.ReadModeRequest(mode=mode),
                                               user=_ADMIN, session="the request's session")
    finally:
        activity_context.reset(token)
    return out, recorded


async def test_a_graph_takes_a_mode_of_its_own_and_null_gives_it_the_inherited_one_again():
    svc = _Svc()
    out, recorded = await _put(svc, "latest")
    assert out == {"graphId": "g1", "readMode": "latest", "readModeEffective": "latest",
                   "readModeSource": "graph", "readModeWhy": []}
    assert svc.saved == [{"mode": "latest", "actor": "usr_admin",
                          "reason": "Large imports on Mondays", "source": "legacy_api",
                          "session": "the request's session"}]
    assert recorded == [("the request's session", "platform.versioning.read_mode_changed", {
        "details": {"graphId": "g1", "workspaceId": "ws1", "dataSourceId": "ds1",
                    "from": None, "to": "latest"}})]
    out, recorded = await _put(svc, None)
    assert (out["readMode"], out["readModeSource"]) == (None, "platform")
    assert recorded[0][2]["details"]["from"] == "latest"


async def test_inherit_clears_the_graphs_mode_as_null_does():
    svc = _Svc(mode="in_place")
    out, recorded = await _put(svc, "inherit")
    assert svc.saved[0]["mode"] is None and out["readMode"] is None
    assert recorded[0][2]["details"] == {"graphId": "g1", "workspaceId": "ws1",
                                         "dataSourceId": "ds1", "from": "in_place", "to": None}


async def test_switch_when_ready_answers_the_mode_in_force_and_why():
    out, _ = await _put(_Svc(), "beside")
    assert (out["readMode"], out["readModeEffective"]) == ("beside", "in_place")
    assert [w["code"] for w in out["readModeWhy"]] == ["builds_off"]


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


# ── Saving it: the settings store, written through ────────────────────────────────────────────────
class _GraphStore:
    """The graph store's two rows a save reads: the graph and its projection state."""

    def __init__(self, mode=None):
        self.graph = SimpleNamespace(id="g1", data_source_id="ds1", workspace_id="ws1")
        self.ps = SimpleNamespace(graph_id="g1", read_mode=mode, owns_falkor_graph=True)

    def __call__(self):
        store = self

        class _Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, model, graph_id):
                return {GraphORM: store.graph, ProjectionStateORM: store.ps}[model]
        return _Session()


class _Management:
    """The management database's session: the writer lock, the write-through's flush, the
    commit."""

    def __init__(self):
        self.done = []

    async def execute(self, *_a, **_kw):
        self.done.append("lock")

    async def flush(self):
        self.done.append("flush")

    async def commit(self):
        self.done.append("commit")

    async def rollback(self):
        self.done.append("rollback")


@pytest.fixture
def saving(settings_world, monkeypatch):
    """What a save sets in motion beyond the store: the write-through to the graph store's column
    and the announcements, recorded."""
    written, announced = [], []

    async def write_graphs(values):
        written.append({ds: dict(cols) for ds, cols in values.items()})

    async def after_save(change_set):
        announced.append([(a.key, a.scope, a.scope_id) for a in change_set.applied])

    monkeypatch.setattr(legacy, "_write_graphs", write_graphs)
    monkeypatch.setattr(effects, "after_save", after_save)
    return SimpleNamespace(world=settings_world, written=written, announced=announced)


def _in_force():
    return build_policy.read_mode_for(workspace_id="ws1", data_source_id="ds1",
                                      platform_copy=True)


async def test_a_graphs_mode_is_saved_in_the_store_and_written_through(saving):
    """The old route's save: the graph's value in the store (``legacy_api``, who, why), the old
    column written in the same transaction, the activity recorded there too, the graph's route
    announced, and this process reading it at once."""
    svc, session, changes = GraphVersioningService(_GraphStore()), _Management(), []

    async def on_change(s, before):
        changes.append((s, before))

    found = await svc.set_read_mode("g1", "in_place", actor="usr_admin", reason="Mondays",
                                    source="legacy_api", session=session, on_change=on_change)
    assert found == (True, None)
    row = saving.world.rows[("reads.mode", "graph", "ds1")]
    assert (row.value, row.version, row.updated_by) == ("in_place", 1, "usr_admin")
    (change_set,) = saving.world.saves
    assert (change_set.source, change_set.actor, change_set.reason) == (
        "legacy_api", "usr_admin", "Mondays")
    assert saving.written == [{"ds1": {"read_mode": "in_place"}}]
    assert changes == [(session, None)] and session.done[-2:] == ["flush", "commit"]
    assert saving.announced == [[("reads.mode", "graph", "ds1")]]
    assert (_in_force().effective, _in_force().source) == ("in_place", "graph")

    # Cleared: inherited again, in the store and the old column; the same mode again: nothing.
    assert await svc.set_read_mode("g1", None, session=_Management(),
                                   on_change=on_change) == (True, "in_place")
    assert saving.world.rows[("reads.mode", "graph", "ds1")].value is None
    assert saving.written[-1] == {"ds1": {"read_mode": None}}
    assert changes[-1][1] == "in_place" and _in_force().source == "default"
    assert await svc.set_read_mode("g1", None, session=_Management(),
                                   on_change=on_change) == (True, None)
    assert len(saving.world.saves) == 2 and len(changes) == 2


async def test_a_graph_with_no_projection_state_saves_nothing(saving):
    store = _GraphStore()
    store.ps = None
    svc = GraphVersioningService(store)
    assert await svc.set_read_mode("g1", "latest", session=_Management()) == (False, None)
    assert saving.world.saves == [] and saving.written == []


async def test_before_the_graphs_values_are_copied_their_mode_is_the_graph_stores(
        saving, monkeypatch):
    """With the graph store in a database of its own, until the versioning worker has copied the
    graphs' values into the store (``legacy_graph``), a graph's own mode is its column's: its
    mode before a save is that one, and a mode only the column held is cleared there too."""
    saving.world.not_imported(monkeypatch)
    store = _GraphStore(mode="beside")
    svc = GraphVersioningService(store)
    await build_policy.resolve()
    assert await svc.set_read_mode("g1", None, session=_Management()) == (True, "beside")
    assert saving.world.saves == [], "the store held nothing to clear"
    assert store.ps.read_mode is None, "cleared where it was held"


async def test_under_the_platforms_lock_a_graphs_mode_is_refused_and_nothing_is_saved(
        saving, monkeypatch):
    """The old route's save is checked as the settings API checks a PATCH
    (``settings.service.checker``), under the writer lock: a mode the platform locked is refused
    for a system administrator too, and nothing is saved, written through or announced. Clearing
    the graph's own mode is still allowed."""
    from backend.app.services.settings import service as settings_service

    async def no_switches(_session):
        return {}

    monkeypatch.setattr(settings_service, "_switches", no_switches)    # no feature store here
    saving.world.set("reads.mode", "platform", "", "latest", limits={"lock": True})
    svc, session = GraphVersioningService(_GraphStore()), _Management()
    check = settings_service.checker(settings_service.SYSTEM_ADMIN, "ws1")
    with pytest.raises(settings_service.InvalidSettings) as refused:
        await svc.set_read_mode("g1", "in_place", session=session, check=check)
    assert [e["code"] for e in refused.value.errors] == ["locked"]
    assert session.done == [], "nothing flushed or committed"
    assert saving.world.saves == [] and saving.written == [] and saving.announced == []
    assert await svc.set_read_mode("g1", None, session=_Management(), check=check) == (True, None)


async def test_the_route_refuses_a_locked_mode_as_the_settings_api_does(monkeypatch):
    """The route hands the save the settings API's check for a system administrator in the
    graph's workspace, and answers what it refuses as the settings API does: 422 with each
    error."""
    from backend.app.services.settings import service as settings_service

    checked = []

    def checker(editor, workspace_id):
        checked.append((editor, workspace_id))

        async def check(*_a):
            raise settings_service.InvalidSettings([{"key": "reads.mode", "code": "locked",
                                                     "message": "Read mode is set for the whole "
                                                                "platform and can't be chosen here"}])
        return check

    class _Checking(_Svc):
        async def set_read_mode(self, graph_id, mode, *, check=None, **kw):
            await check(None, "graph", "ds1", [])
            return await super().set_read_mode(graph_id, mode, check=check, **kw)

    monkeypatch.setattr(settings_service, "checker", checker)
    svc = _Checking()
    with pytest.raises(HTTPException) as exc:
        await _put(svc, "in_place")
    assert exc.value.status_code == 422 and exc.value.detail["type"] == "invalid_settings"
    assert [e["code"] for e in exc.value.detail["errors"]] == ["locked"]
    assert checked == [(settings_service.SYSTEM_ADMIN, "ws1")] and svc.saved == []
