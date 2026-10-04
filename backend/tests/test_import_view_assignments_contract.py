"""View-scoped import roots under the placement contract (``placementContractEnabled``).

``contract_import_root_assignments`` finds the batch's top-level entities with the ontology's
containment DIRECTION and asks ``suggest_placement`` for each: an entry is written only when the
view is curated or the chosen layer differs from what the contract already computes. The hook
``_write_view_import_assignments`` takes that path while the flag is on and today's
``compute_import_root_assignments`` while it is off (tests/test_import_view_assignments.py).
"""
from __future__ import annotations

import contextlib
import json
import time

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints import versioning as versioning_ep
from backend.app.api.v1.endpoints.versioning import _write_view_import_assignments
from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning.import_export.import_worker import (
    ImportWorker,
    contract_import_root_assignments,
)
from backend.app.services.view_placement import PlacementSpec

_NOW = "2026-10-04T00:00:00Z"
_CONTAINS = {"CONTAINS": False, "BELONGS_TO": True}  # {TYPE: child is source}


def _node(eid, urn=None, layer_signal=None, entity_type=None, **facts):
    return {"eid": eid, "urn": urn, "layer_signal": layer_signal, "entity_type": entity_type, **facts}


def _spec(scope="all", **layer_extra):
    return PlacementSpec.from_config({
        "content": {"entityScope": scope},
        "layout": {"referenceLayout": {"layers": _layers(**layer_extra), "assignments": {}}},
    })


def _layers(**l1_extra):
    return [{"id": "l1", "name": "Curated", "order": 1, **l1_extra},
            {"id": "l0", "name": "Source", "order": 0}]


def _roots(created, spec, edges=(), existing=None):
    return contract_import_root_assignments(
        created, list(edges), spec, _CONTAINS, _layers(), existing or {}, now=_NOW)


def _entry(layer_id):
    return {"layerId": layer_id, "inheritsChildren": True, "assignedBy": "import", "assignedAt": _NOW}


# ── open views: pin only what the contract would not place there ───────

def test_open_view_rule_already_places_the_root():
    created = [_node("r", "urn:r", entity_type="Table")]
    assert _roots(created, _spec(entityTypes=["table"])) == {}


def test_open_view_without_a_placement_writes_nothing():
    """Today's import pins the first layer; under the contract an open view leaves an entity no
    rule claims unplaced at write time as well as at read time."""
    assert _roots([_node("r", "urn:r", entity_type="table")], _spec()) == {}


def test_open_view_exact_layer_id_signal_is_the_stamp():
    """The row's layerAssignment is also written to the node, where it stamps that layer."""
    assert _roots([_node("r", "urn:r", layer_signal="l1")], _spec()) == {}


def test_open_view_layer_name_signal_pins_that_layer():
    """A layer NAME is no stamp (stamps are ids), so the chosen layer differs: pin it."""
    created = [_node("r", "urn:r", layer_signal="curated", entity_type="table")]
    assert _roots(created, _spec(entityTypes=["dataset"])) == {"urn:r": _entry("l1")}


def test_open_view_signal_beats_a_rule_by_pinning():
    """An id signal needs no entry (its stamp outranks the rule); a name signal does."""
    spec = _spec(entityTypes=["table"])
    by_id = [_node("r", "urn:r", layer_signal="l0", entity_type="table")]
    by_name = [_node("s", "urn:s", layer_signal="Source", entity_type="table")]
    assert _roots(by_id, spec) == {}
    assert _roots(by_name, spec) == {"urn:s": _entry("l0")}


def test_property_rules_read_the_row_facts():
    spec = _spec(rules=[{"id": "fin", "priority": 1,
                         "propertyMatch": {"field": "owner", "operator": "equals", "value": "finance"}}])
    created = [_node("a", "urn:a", layer_signal="Source", properties={"owner": "Finance"}),
               _node("b", "urn:b", layer_signal="Curated", properties={"owner": "Finance"})]
    assert _roots(created, spec) == {"urn:a": _entry("l0")}


# ── curated views: always pin a root ────────────────────────────────────

def test_curated_view_unmatched_root_pins_the_first_layer_by_order():
    assert _roots([_node("r", "urn:r")], _spec("curated")) == {"urn:r": _entry("l0")}


def test_curated_view_pins_what_an_open_view_would_compute():
    created = [_node("r", "urn:r", entity_type="table")]
    assert _roots(created, _spec("curated", entityTypes=["table"])) == {"urn:r": _entry("l1")}


def test_curated_view_pins_the_signal():
    assert _roots([_node("r", "urn:r", layer_signal="l1")], _spec("curated")) == {"urn:r": _entry("l1")}


# ── roots by containment direction ──────────────────────────────────────

def test_belongs_to_child_is_the_edge_source():
    """Today's import takes the TARGET as the child of every containment edge, so a BELONGS_TO
    child was pinned and its parent was not."""
    created = [_node("t", "urn:term"), _node("g", "urn:glossary")]
    out = _roots(created, _spec("curated"), edges=[("t", "g", "BELONGS_TO")])
    assert set(out) == {"urn:glossary"}


def test_contains_child_is_the_edge_target_and_other_edges_do_not_count():
    created = [_node("p", "urn:p"), _node("c", "urn:c"), _node("d", "urn:d")]
    out = _roots(created, _spec("curated"), edges=[("p", "c", "contains"), ("p", "d", "LINEAGE")])
    assert set(out) == {"urn:p", "urn:d"}


def test_existing_keys_win_and_urnless_nodes_key_by_eid():
    created = [_node("r", "urn:r"), _node("e7")]
    out = _roots(created, _spec("curated"), existing={"urn:r": {"layerId": "l1"}})
    assert out == {"gv:e7": _entry("l0")}


def test_no_layers_means_nothing_to_place():
    spec = _spec("curated")
    assert contract_import_root_assignments([_node("r", "urn:r")], [], spec, _CONTAINS, [], {}) == {}


# ── the worker collects what the contract reads ─────────────────────────

def test_worker_collects_the_row_facts():
    worker = ImportWorker(versioning=None, store=None)
    worker._collect_facts([{"op": "create", "entity_kind": "node", "entity_id": "ent_1", "payload": {
        "urn": "urn:x", "layerAssignment": "l1", "entityType": "table", "displayName": "X",
        "tags": ["pii"], "properties": {"owner": "finance"}}}])
    assert worker.created_node_facts == [{
        "eid": "ent_1", "urn": "urn:x", "layer_signal": "l1", "entity_type": "table",
        "display_name": "X", "tags": ["pii"], "properties": {"owner": "finance"}}]


# ── the ontology's directions, best-effort ──────────────────────────────

async def test_live_containment_map_reads_directions_and_is_best_effort(monkeypatch, db_session):
    from backend.app.ontology.models import ResolvedOntology
    from backend.app.ontology.service import LocalOntologyService

    async def _resolve(self, **_kw):
        return ResolvedOntology(
            containment_edge_types=["CONTAINS", "BELONGS_TO"],
            edge_type_metadata={"BELONGS_TO": {"direction": "target-to-source"},
                                "CONTAINS": {"direction": "parent-to-child"}})

    async def _down(self, **_kw):
        raise RuntimeError("ontology service down")

    monkeypatch.setattr(LocalOntologyService, "resolve", _resolve)
    assert await versioning_ep._live_containment_map(db_session, "ws", "ds") == {"CONTAINS": False, "BELONGS_TO": True}
    monkeypatch.setattr(LocalOntologyService, "resolve", _down)
    assert await versioning_ep._live_containment_map(db_session, "ws", "ds") == {}


# ── the hook with the flag on ───────────────────────────────────────────

@pytest.fixture()
def _contract_on(monkeypatch, db_session: AsyncSession):
    """Flag on (primed in the cache, as a gate reads it), the hook's session routed to the test
    database, the ontology's directions stubbed. The legacy type reader must not be called."""
    feature_flags._cache = {**(feature_flags._cache or {}), "placementContractEnabled": True}
    feature_flags._cache_ts = time.monotonic()

    @contextlib.asynccontextmanager
    async def _session():
        yield db_session

    async def _directions(session, ws, ds):
        return {"CONTAINS": False, "BELONGS_TO": True}

    async def _legacy_types(session, ws, ds):
        raise AssertionError("the contract path reads directions, not bare types")

    monkeypatch.setattr("backend.app.db.engine.get_async_session", _session)
    monkeypatch.setattr(versioning_ep, "_live_containment_map", _directions)
    monkeypatch.setattr(versioning_ep, "_live_containment_types", _legacy_types)


async def _seed_view(session: AsyncSession, config: dict) -> ViewORM:
    ws = WorkspaceORM(name="WS")
    session.add(ws)
    await session.flush()
    view = ViewORM(name="V", workspace_id=ws.id, view_type="reference", config=json.dumps(config))
    session.add(view)
    await session.flush()
    return view


async def test_hook_places_roots_through_the_contract(_contract_on, db_session: AsyncSession):
    """Curated view: the glossary root is pinned (its BELONGS_TO term inherits), and the stored
    rule that can never match does not block the write, since the import leaves rules untouched."""
    view = await _seed_view(db_session, {
        "content": {"entityScope": "curated"},
        "layout": {"referenceLayout": {
            "layers": [{"id": "l0", "name": "Source", "order": 0, "rules": [{"id": "empty", "priority": 1}]}],
            "assignments": {"urn:old": {"layerId": "l0", "assignedBy": "user"}},
        }},
    })
    created = [_node("t", "urn:term"), _node("g", "urn:glossary")]

    result = await _write_view_import_assignments("ws", "ds", view.id, created, [("t", "g", "BELONGS_TO")])

    assert result == {"added": 1}
    ref = json.loads((await db_session.get(ViewORM, view.id)).config)["layout"]["referenceLayout"]
    assert set(ref["assignments"]) == {"urn:old", "urn:glossary"}
    assert ref["assignments"]["urn:glossary"]["layerId"] == "l0"
    assert ref["layers"][0]["rules"] == [{"id": "empty", "priority": 1}]


async def test_hook_writes_nothing_an_open_view_already_places(_contract_on, db_session: AsyncSession):
    view = await _seed_view(db_session, {
        "content": {"entityScope": "all"},
        "layout": {"referenceLayout": {
            "layers": [{"id": "l0", "name": "Source", "order": 0, "entityTypes": ["table"]}],
            "assignments": {},
        }},
    })
    before = (await db_session.get(ViewORM, view.id)).config

    result = await _write_view_import_assignments(
        "ws", "ds", view.id, [_node("r", "urn:r", entity_type="table")], [])

    assert result == {"added": 0}
    assert (await db_session.get(ViewORM, view.id)).config == before
