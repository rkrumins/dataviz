"""View-scoped imports write canonical layer assignments for newly-created TOP-LEVEL entities.

Closes the "bulk-created entities never render in a curated view" trap: when a view-scoped import
CREATES entities, the view's canonical ``assignments`` map gains entries for the new top-level
entities (``assignedBy: 'import'``) so they belong to the view immediately. Descendants need no
entry — containment inheritance places them under their root at read time.

Three layers, all runnable under the container's real pytest (no GRAPHVER_E2E / live Postgres):

* ``compute_import_root_assignments`` — the pure top-level derivation (no DB). Top-level is decided
  from the batch's OWN containment edges (target = child), never a FalkorDB re-query.
* ``_write_view_import_assignments`` — the API-layer hook, against the management-DB aiosqlite
  harness (``db_session`` + monkeypatched ``get_async_session``/``_live_containment_types``): the
  merge preserves existing urns' entries and every other config key.
* ``ImportExportService.run_import`` / ``_apply_view_layout`` — the wiring: guarded on ``view_id``,
  and layout-writer failure is isolated onto the job summary, never failing the import.
"""
from __future__ import annotations

import contextlib
import json
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import versioning as versioning_ep
from backend.app.api.v1.endpoints.versioning import _write_view_import_assignments
from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import service as service_mod
from backend.app.services.versioning.import_export.import_worker import (
    compute_import_root_assignments,
)
from backend.app.services.versioning.import_export.service import ImportExportService


# ── helpers ────────────────────────────────────────────────────────────

def _node(eid, urn=None, layer_signal=None):
    return {"eid": eid, "urn": urn, "layer_signal": layer_signal}


_TWO_LAYERS = [
    {"id": "l0", "name": "Source", "order": 0},
    {"id": "l1", "name": "Curated", "order": 1},
]


# ═══════════════════════════════════════════════════════════════════════
# 1. compute_import_root_assignments — pure top-level derivation (no DB)
# ═══════════════════════════════════════════════════════════════════════

def test_three_level_chain_only_root_assigned():
    """A 3-level containment chain root->mid->leaf → ONLY the root gets an entry (assignedBy
    'import', inheritsChildren true); mid/leaf inherit and get none."""
    created = [_node("r", "urn:r"), _node("m", "urn:m"), _node("lf", "urn:lf")]
    edges = [("r", "m", "CONTAINS"), ("m", "lf", "CONTAINS")]
    out = compute_import_root_assignments(
        created, edges, ["CONTAINS"], _TWO_LAYERS, {}, now="2026-01-01T00:00:00Z")

    assert set(out) == {"urn:r"}, out
    entry = out["urn:r"]
    assert entry["layerId"] == "l0"          # no signal → first layer (order 0)
    assert entry["inheritsChildren"] is True
    assert entry["assignedBy"] == "import"
    assert entry["assignedAt"] == "2026-01-01T00:00:00Z"


def test_layer_signal_matches_existing_layer_id():
    created = [_node("r", "urn:r", layer_signal="l1")]
    out = compute_import_root_assignments(created, [], ["CONTAINS"], _TWO_LAYERS, {})
    assert out["urn:r"]["layerId"] == "l1"


def test_layer_signal_matches_existing_layer_name_case_insensitive():
    created = [_node("r", "urn:r", layer_signal="CURATED")]   # matches name "Curated"
    out = compute_import_root_assignments(created, [], ["CONTAINS"], _TWO_LAYERS, {})
    assert out["urn:r"]["layerId"] == "l1"


def test_layer_signal_unknown_falls_back_to_first_layer_by_order():
    # layers deliberately out of list-order to prove selection is by `order`, not position.
    layers = [{"id": "l1", "name": "Curated", "order": 1}, {"id": "l0", "name": "Source", "order": 0}]
    created = [_node("r", "urn:r", layer_signal="does-not-exist")]
    out = compute_import_root_assignments(created, [], ["CONTAINS"], layers, {})
    assert out["urn:r"]["layerId"] == "l0"


def test_existing_urn_not_overwritten():
    """An existing assignment for the same urn is never overwritten; a sibling new root still lands."""
    created = [_node("r", "urn:r"), _node("s", "urn:s")]
    existing = {"urn:r": {"layerId": "l1", "assignedBy": "user"}}
    out = compute_import_root_assignments(created, [], ["CONTAINS"], _TWO_LAYERS, existing)
    assert "urn:r" not in out                 # left to the pre-existing 'user' entry
    assert out["urn:s"]["layerId"] == "l0"


def test_no_layers_returns_empty():
    created = [_node("r", "urn:r")]
    assert compute_import_root_assignments(created, [], ["CONTAINS"], [], {}) == {}
    assert compute_import_root_assignments(created, [], ["CONTAINS"], None, {}) == {}


def test_node_without_urn_keyed_by_gv_eid():
    created = [_node("e42", urn=None)]
    out = compute_import_root_assignments(created, [], ["CONTAINS"], _TWO_LAYERS, {})
    assert set(out) == {"gv:e42"}, out


def test_multiple_independent_roots_all_assigned():
    created = [_node("a", "urn:a"), _node("b", "urn:b")]   # no edges → both top-level
    out = compute_import_root_assignments(created, [], ["CONTAINS"], _TWO_LAYERS, {})
    assert set(out) == {"urn:a", "urn:b"}


def test_non_containment_edge_does_not_make_child():
    """Only edges whose type is in ``containment_types`` establish parentage; a LINEAGE edge between
    two created nodes leaves both top-level."""
    created = [_node("a", "urn:a"), _node("b", "urn:b")]
    edges = [("a", "b", "LINEAGE")]
    out = compute_import_root_assignments(created, edges, ["CONTAINS"], _TWO_LAYERS, {})
    assert set(out) == {"urn:a", "urn:b"}


# ═══════════════════════════════════════════════════════════════════════
# 2. _write_view_import_assignments — the hook (management-DB harness)
# ═══════════════════════════════════════════════════════════════════════

async def _seed_view(session: AsyncSession, *, config: dict) -> ViewORM:
    ws = WorkspaceORM(name="WS")
    session.add(ws)
    await session.flush()
    view = ViewORM(name="V", workspace_id=ws.id, view_type="reference", config=json.dumps(config))
    session.add(view)
    await session.flush()
    return view


@pytest.fixture()
def _route_hook_to_test_db(monkeypatch, db_session: AsyncSession):
    """The hook opens its own management-DB session via ``get_async_session`` and resolves the live
    containment types via ``_live_containment_types``. Route the first to the test's in-memory
    ``db_session`` and stub the second to ``CONTAINS`` (no ontology service needed)."""
    @contextlib.asynccontextmanager
    async def _fake_get_async_session():
        yield db_session

    async def _fake_live_containment_types(session, ws, ds):
        return ["CONTAINS"]

    monkeypatch.setattr("backend.app.db.engine.get_async_session", _fake_get_async_session)
    monkeypatch.setattr(versioning_ep, "_live_containment_types", _fake_live_containment_types)


async def test_hook_adds_root_preserving_existing_and_other_config(
    _route_hook_to_test_db, db_session: AsyncSession
):
    """The hook adds only the new top-level root, preserves an existing urn's entry, and leaves
    every other config key (content/filters/name) and referenceLayout.displayRules untouched."""
    view = await _seed_view(db_session, config={
        "name": "V",
        "content": {"visibleEntityTypes": ["domain"], "entityScope": "curated"},
        "filters": {"quickFilters": ["keep-me"]},
        "layout": {"referenceLayout": {
            "layers": [{"id": "l0", "name": "Source", "order": 0}],
            "assignments": {"urn:existing": {"layerId": "l0", "assignedBy": "user"}},
            "displayRules": [{"rule": "keep"}],
        }},
    })

    created = [_node("root", "urn:new-root"), _node("child", "urn:new-child")]
    edges = [("root", "child", "CONTAINS")]
    result = await _write_view_import_assignments(
        view.workspace_id, "ds", view.id, created, edges)
    assert result == {"added": 1}, result

    refreshed = await db_session.get(ViewORM, view.id)
    cfg = json.loads(refreshed.config)
    ref = cfg["layout"]["referenceLayout"]
    assignments = ref["assignments"]

    assert "urn:new-root" in assignments and assignments["urn:new-root"]["assignedBy"] == "import"
    assert assignments["urn:new-root"]["inheritsChildren"] is True
    assert "urn:new-child" not in assignments                       # descendant inherits
    assert assignments["urn:existing"] == {"layerId": "l0", "assignedBy": "user"}   # untouched
    assert ref["displayRules"] == [{"rule": "keep"}]                # referenceLayout key preserved
    assert cfg["content"] == {"visibleEntityTypes": ["domain"], "entityScope": "curated"}
    assert cfg["filters"] == {"quickFilters": ["keep-me"]}          # sibling config keys preserved
    assert cfg["name"] == "V"


async def test_hook_noop_when_view_has_no_layers(
    _route_hook_to_test_db, db_session: AsyncSession
):
    """No layers in the referenceLayout → nowhere to place a root → the hook writes nothing."""
    view = await _seed_view(db_session, config={
        "layout": {"referenceLayout": {"layers": [], "assignments": {}}},
    })
    before = (await db_session.get(ViewORM, view.id)).config

    result = await _write_view_import_assignments(
        view.workspace_id, "ds", view.id, [_node("r", "urn:r")], [])
    assert result == {"added": 0}
    after = (await db_session.get(ViewORM, view.id)).config
    assert after == before                                          # config untouched


async def test_hook_missing_view_returns_zero(
    _route_hook_to_test_db, db_session: AsyncSession
):
    result = await _write_view_import_assignments(
        "ws", "ds", "does-not-exist", [_node("r", "urn:r")], [])
    assert result == {"added": 0}


# ═══════════════════════════════════════════════════════════════════════
# 3. ImportExportService wiring — guard + failure isolation (mocked graphver)
# ═══════════════════════════════════════════════════════════════════════

@contextlib.asynccontextmanager
async def _session_yielding(row):
    class _S:
        async def get(self, _orm, _key):
            return row
    yield _S()


def _service(layout_writer):
    return ImportExportService(versioning=object(), store=object(), layout_writer=layout_writer)


async def test_apply_view_layout_records_added_on_summary(monkeypatch):
    """Happy path: the writer's ``{added: N}`` is recorded on the job summary."""
    row = SimpleNamespace(summary={}, updated_at=None)
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))

    async def _writer(ws, ds, view_id, nodes, edges):
        return {"added": 3}

    svc = _service(_writer)
    worker = SimpleNamespace(created_node_facts=[_node("e", "urn:e")], batch_edge_facts=[])
    await svc._apply_view_layout("job1", "ws", "ds", "v1", worker)
    assert row.summary["viewAssignments"] == {"added": 3}


async def test_apply_view_layout_isolates_writer_failure(monkeypatch):
    """A raising layout writer must NOT propagate — the import is already committed. The failure is
    recorded on the job summary instead."""
    row = SimpleNamespace(summary={"new": 1}, updated_at=None)
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))

    async def _boom(ws, ds, view_id, nodes, edges):
        raise RuntimeError("layout boom")

    svc = _service(_boom)
    worker = SimpleNamespace(created_node_facts=[_node("e", "urn:e")], batch_edge_facts=[])
    await svc._apply_view_layout("job1", "ws", "ds", "v1", worker)   # must not raise
    assert row.summary["viewAssignments"] == {"error": "layout boom"}
    assert row.summary["new"] == 1                                   # pre-existing tally preserved


async def test_run_import_skips_layout_write_without_view_id(monkeypatch):
    """No scope_view_id on the job → the layout writer is never called (item 4)."""
    calls = []

    async def _spy(ws, ds, view_id, nodes, edges):
        calls.append(view_id)
        return {"added": 1}

    class _FakeWorker:
        def __init__(self, svc, store, scope=None, ontology=None):
            self.created_node_facts = [_node("e", "urn:e")]
            self.batch_edge_facts = []

        async def run(self, job_id):
            return {"new": 1, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}

    row = SimpleNamespace(
        workspace_id="ws", data_source_id="ds", scope_view_id=None,
        reconcile_mode="upsert", summary={}, updated_at=None)
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))
    monkeypatch.setattr(service_mod, "ImportWorker", _FakeWorker)

    summary = await _service(_spy).run_import("job1")
    assert summary["new"] == 1                     # import completed normally
    assert calls == []                             # no view scope → no layout write
    assert "viewAssignments" not in row.summary


def test_factory_wires_the_hook():
    """The production service factory injects the real hook — guards against the wiring going
    dangling (a stub writer in the tests above would otherwise hide a lost injection)."""
    svc = versioning_ep.get_import_export_service()
    assert svc._layout_writer is versioning_ep._write_view_import_assignments


async def test_run_import_calls_layout_write_with_view_id(monkeypatch):
    """With a scope_view_id AND created nodes, the writer IS called and its result recorded — the
    view_id gate is the only thing suppressing it in the test above."""
    calls = []

    async def _spy(ws, ds, view_id, nodes, edges):
        calls.append(view_id)
        return {"added": 2}

    class _FakeWorker:
        def __init__(self, svc, store, scope=None, ontology=None):
            self.created_node_facts = [_node("e", "urn:e")]
            self.batch_edge_facts = []

        async def run(self, job_id):
            return {"new": 1, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}

    row = SimpleNamespace(
        workspace_id="ws", data_source_id="ds", scope_view_id="v1",
        reconcile_mode="upsert", summary={}, updated_at=None)
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))
    monkeypatch.setattr(service_mod, "ImportWorker", _FakeWorker)

    summary = await _service(_spy).run_import("job1")
    assert summary["new"] == 1
    assert calls == ["v1"]
    assert row.summary["viewAssignments"] == {"added": 2}
