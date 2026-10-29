"""
Unit tests for the write side of node identity — ``bind_node_write``.

The read path and the conformance stamp map a source's own properties ONTO the platform's ``urn`` /
``displayName``. Nothing mapped the other way, so a node the platform wrote itself (created or
renamed in the editor, imported, staged through the API) carried no ``name``/``title``/``id`` of its
own. The rule judges a write on the node before and after it, never on the operation that made it.
"""
import copy
import json
from pathlib import Path

import pytest

from backend.app.providers.falkordb_provider import _sanitize_node_properties
from backend.app.services.node_identity import (
    ResolvedNodeIdentity,
    bind_node_write,
    bind_node_writes,
)
from backend.app.services.versioning.changeset import fold_batch_ops
from backend.app.services.versioning.service import _is_edge_payload
from backend.common.property_patch import apply_patch

DEFAULT = ResolvedNodeIdentity()                                          # urn / name
MAPPED = ResolvedNodeIdentity(identity_property="id", name_property="title")


def _node(display="Orders", urn="urn:x:1", **props):
    return {"urn": urn, "entityType": "dataset", "displayName": display, "properties": props}


# ── creating a node whose urn the server minted ────────────────────────────────

def test_a_new_node_gets_its_name_property_from_its_display_name():
    assert bind_node_write(None, _node(), DEFAULT, minted=True)["properties"] == {"name": "Orders"}


def test_a_mapped_source_gets_its_own_name_and_identity_properties():
    out = bind_node_write(None, _node(), MAPPED, minted=True)
    assert out["properties"] == {"title": "Orders", "id": "urn:x:1"}


def test_a_minted_node_never_keeps_copied_values():
    """Duplicate copies its original's whole bag: the copy may not claim the original's identity,
    nor keep the original's name under its new one."""
    copied = _node("Orders (Copy)", title="Orders", id="urn:x:original", owner="ana")
    out = bind_node_write(None, copied, MAPPED, minted=True)
    assert out["properties"] == {"title": "Orders (Copy)", "id": "urn:x:1", "owner": "ana"}


def test_a_blank_display_name_is_filled_from_the_name_property():
    out = bind_node_write(None, _node("", title="Orders"), MAPPED, minted=True)
    assert out["displayName"] == "Orders"
    assert out["properties"] == {"title": "Orders", "id": "urn:x:1"}


def test_without_a_urn_there_is_no_identity_to_bind():
    value = {"entityType": "dataset", "displayName": "Orders"}
    assert bind_node_write(None, value, MAPPED)["properties"] == {"title": "Orders"}


# ── creating a node that brings its own urn (restore, import, stage) ───────────

def test_an_own_urn_create_fills_what_is_empty():
    assert bind_node_write(None, _node(), MAPPED)["properties"] == {"title": "Orders", "id": "urn:x:1"}


def test_an_own_urn_create_keeps_the_values_it_brings():
    value = _node(title="ORD", id="42")
    assert bind_node_write(None, value, MAPPED) is value


# ── updating a node ─────────────────────────────────────────────────────────────

def test_a_rename_carries_the_name_property_while_the_two_agree():
    out = bind_node_write(_node("Orders", name="Orders"), _node("Sales", name="Orders"), DEFAULT)
    assert out["displayName"] == "Sales" and out["properties"] == {"name": "Sales"}


def test_a_rename_of_a_node_without_a_name_property_gives_it_one():
    assert bind_node_write(_node("Orders"), _node("Sales"), DEFAULT)["properties"] == {"name": "Sales"}


def test_a_rename_leaves_a_name_that_deliberately_differs():
    """A technical name beside a friendly display name (OpenMetadata keeps both) is not a copy."""
    value = _node("All orders", name="customer_orders")
    assert bind_node_write(_node("Customer Orders", name="customer_orders"), value, DEFAULT) is value


def test_editing_both_keeps_both():
    value = _node("Customer Orders", name="customer_orders")
    assert bind_node_write(_node("Orders", name="Orders"), value, DEFAULT) is value


def test_editing_the_name_property_carries_the_display_name_while_the_two_agree():
    out = bind_node_write(_node("Orders", title="Orders"), _node("Orders", title="Sales"), MAPPED)
    assert out["displayName"] == "Sales" and out["properties"]["title"] == "Sales"


def test_editing_a_name_property_that_differs_leaves_the_display_name():
    value = _node("Orders", title="ord_v2", id="urn:x:1")
    assert bind_node_write(_node("Orders", title="ord", id="urn:x:1"), value, MAPPED) is value


def test_a_removed_name_property_stays_removed():
    value = _node("Orders")
    assert bind_node_write(_node("Orders", name="Orders"), value, DEFAULT) is value


def test_a_blank_display_name_is_never_copied():
    value = _node("", name="Orders")
    assert bind_node_write(_node("Orders", name="Orders"), value, DEFAULT) is value


def test_any_save_fills_a_name_property_the_node_never_had():
    value = {**_node("Orders"), "description": "every order"}
    assert bind_node_write(_node("Orders"), value, DEFAULT)["properties"] == {"name": "Orders"}


def test_the_identity_property_is_filled_when_missing_and_never_changed():
    filled = bind_node_write(_node(title="Orders"), _node(title="Orders"), MAPPED)
    assert filled["properties"]["id"] == "urn:x:1"
    kept = _node(title="Orders", id="42")
    assert bind_node_write(_node(title="Orders", id="42"), kept, MAPPED) is kept
    removed = _node(title="Orders")
    assert bind_node_write(_node(title="Orders", id="42"), removed, MAPPED) is removed


def test_values_agree_as_text_but_only_text_becomes_a_display_name():
    prior = _node("5", name=5)
    assert bind_node_write(prior, _node("6", name=5), DEFAULT)["properties"] == {"name": "6"}
    value = _node("5", name=7)
    assert bind_node_write(prior, value, DEFAULT) is value


# ── which properties are bound ──────────────────────────────────────────────────

def test_when_the_identity_is_the_name_property_the_name_wins():
    same = ResolvedNodeIdentity(identity_property="name", name_property="name")
    assert bind_node_write(None, _node(), same, minted=True)["properties"] == {"name": "Orders"}


@pytest.mark.parametrize("identity", [
    ResolvedNodeIdentity(identity_property="qualifiedName", name_property="displayName"),
    ResolvedNodeIdentity(identity_property="urn", name_property="description"),
])
def test_a_field_the_platform_owns_is_never_bound(identity):
    value = _node()
    assert bind_node_write(None, value, identity, minted=True) is value


# ── what callers rely on ────────────────────────────────────────────────────────

def test_it_never_mutates_and_binding_twice_changes_nothing_more():
    prior = _node("Orders", title="Orders", id="urn:x:1")
    value = _node("Sales", title="Orders", id="urn:x:1")
    before = copy.deepcopy((prior, value))
    once = bind_node_write(prior, value, MAPPED)
    assert (prior, value) == before
    assert once["properties"]["title"] == "Sales"
    assert bind_node_write(prior, once, MAPPED) is once


def test_a_node_already_bound_is_returned_as_is():
    value = _node(name="Orders")
    assert bind_node_write(None, value, DEFAULT, minted=True) is value


# ── the shared corpus: the editor says what a save does before it happens ──────

_NAME_CORPUS = Path(__file__).parent / "fixtures" / "node_identity" / "name_binding.json"


@pytest.mark.parametrize("case", json.loads(_NAME_CORPUS.read_text())["cases"], ids=lambda c: c["name"])
def test_the_shared_name_corpus(case):
    """The editor predicts what a save stores for a name with a TypeScript twin of this rule
    (``boundName``, ``frontend/src/components/dataSource/NodeIdentity.tsx``), which runs the same
    cases — so the Name input never says anything the server won't do."""
    prop = case["mapping"]["nameProperty"]

    def payload(shape):
        return None if shape is None else {"urn": "urn:x:1", **shape}

    out = bind_node_write(payload(case["prior"]), payload(case["value"]),
                          ResolvedNodeIdentity(name_property=prop), minted=case["minted"])
    assert out.get("displayName") == case["expect"]["displayName"]
    assert (out.get("properties") or {}).get(prop) == case["expect"]["name"]


# ── a whole write, as ``_apply_ops_once`` composes one ─────────────────────────

def _write(ops, stored, identity):
    """What a batch of ``ops`` writes over ``stored``: the fold, each update merged onto the stored
    value, then the binding — the steps ``GraphVersioningService._apply_ops_once`` takes."""
    fold = fold_batch_ops(ops, is_edge_payload=_is_edge_payload,
                          sanitize_node=_sanitize_node_properties)
    values = dict(fold.new_vals)
    for eid in fold.update_ids:
        values[eid] = apply_patch(stored.get(eid), values[eid])
    values.update(bind_node_writes(
        values, stored, kind_by_entity=fold.kind_by_entity, identity=identity,
        created={e for e in values if e not in fold.update_ids},
        minted={o["entity_id"] for o in ops if o.get("minted")}))
    return values


def _create(eid, display, minted=True, **props):
    op = {"op": "create", "entity_kind": "node", "entity_id": eid,
          "payload": _node(display, urn=eid, **props)}
    return {**op, "minted": True} if minted else op


def _update(eid, **payload):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": payload}


def test_a_node_renamed_before_its_first_save_is_named_by_its_last_name():
    out = _write([_create("u1", "Orders"), _update("u1", displayName="Sales")], {}, MAPPED)
    assert out["u1"]["properties"] == {"title": "Sales", "id": "u1"}


def test_a_new_nodes_name_property_follows_its_display_name_even_when_set_in_the_same_save():
    """The contract: a new node is named by its display name; set the property apart after saving."""
    ops = [_create("u1", "Orders"), _update("u1", properties={"title": "ORD"})]
    assert _write(ops, {}, MAPPED)["u1"]["properties"]["title"] == "Orders"


def test_a_node_deleted_and_created_again_is_judged_as_new():
    stored = {"u1": _node("Old", urn="u1", title="Old", id="u1")}
    ops = [{"op": "delete", "entity_kind": "node", "entity_id": "u1", "payload": None},
           _create("u1", "New", minted=False)]
    assert _write(ops, stored, MAPPED)["u1"]["properties"] == {"title": "New", "id": "u1"}


def test_a_stored_node_whose_name_differs_keeps_it_through_a_rename():
    stored = {"u1": _node("Orders", urn="u1", title="ord", id="u1")}
    out = _write([_update("u1", displayName="Sales")], stored, MAPPED)
    assert out["u1"]["displayName"] == "Sales" and out["u1"]["properties"]["title"] == "ord"


def test_edges_and_deletions_are_left_alone():
    stored = {"u1": _node(urn="u1", title="Orders", id="u1")}
    edge = {"op": "create", "entity_kind": "edge", "entity_id": "e1",
            "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "u1", "targetEntityId": "u2"}}
    gone = {"op": "delete", "entity_kind": "node", "entity_id": "u1", "payload": None}
    out = _write([edge, gone], stored, MAPPED)
    assert "properties" not in out["e1"] and out["u1"] is None
    assert bind_node_writes(stored, stored, kind_by_entity={"u1": "node"}, identity=MAPPED) == {}


# ── how the write paths come by the mapping ────────────────────────────────────

async def test_a_save_uses_the_engines_mapping_and_binds_nothing_without_one():
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints.graph import _node_identity_for_write

    async def unreadable():
        return None
    engine = SimpleNamespace(_node_identity=MAPPED, _resolve_node_identity=unreadable,
                             _data_source_id="ds_1")
    assert await _node_identity_for_write(engine) is MAPPED
    engine._node_identity = None
    assert await _node_identity_for_write(engine) is None, "never the code defaults"


async def test_the_versioning_routes_resolve_the_graphs_data_source(db_session):
    from backend.app.api.v1.endpoints.versioning import _node_identity_for_meta
    from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
    from backend.app.services.node_identity import invalidate_global_defaults_cache

    invalidate_global_defaults_cache()
    db_session.add(ProviderORM(id="prov_wb", name="P", provider_type="falkordb",
                               identity_property="id"))
    db_session.add(WorkspaceORM(id="ws_wb", name="W"))
    db_session.add(WorkspaceDataSourceORM(id="ds_wb", workspace_id="ws_wb", provider_id="prov_wb",
                                          graph_name="g", name_property="title"))
    await db_session.flush()
    resolved = await _node_identity_for_meta(db_session, {"data_source_id": "ds_wb"})
    assert (resolved.identity_property, resolved.name_property) == ("id", "title")
    assert await _node_identity_for_meta(db_session, None) is None
    assert await _node_identity_for_meta(None, {"data_source_id": "ds_wb"}) is None, \
        "unreadable: nothing is bound"


async def test_the_save_route_hands_the_service_the_mapping_and_marks_minted_nodes(monkeypatch):
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints import graph as graph_ep
    from backend.app.services.versioning import service as service_mod

    seen = {}

    class _Service:
        async def get_graph_by_data_source(self, _ds):
            return {"graph_id": "g1", "workspace_id": "ws1", "kind": "manual"}

        async def apply_ops_detailed(self, **kw):
            seen.update(kw)
            return SimpleNamespace(commit_id="cmt_1", written={}, urns={})

    class _Cache:
        async def bump_generation(self, _scope):
            pass

    async def ontology_metadata():
        return SimpleNamespace(containment_edge_types=[])

    monkeypatch.setattr(service_mod, "GraphVersioningService", _Service)
    monkeypatch.setattr(graph_ep, "get_graph_cache", lambda: _Cache())
    engine = SimpleNamespace(_node_identity=MAPPED, _data_source_id="ds1", _db_session=None,
                             get_ontology_metadata=ontology_metadata)
    request = graph_ep.GraphChangesRequest(ops=[graph_ep.GraphChangeOp(
        op="create", kind="node", ref="tmp1", payload={"entityType": "dataset", "displayName": "Orders"})])

    await graph_ep.apply_graph_changes("ws1", request, dataSourceId="ds1", branchId="br1",
                                       idempotency_key=None, user=SimpleNamespace(id="usr_1"),
                                       engine=engine)
    assert seen["node_identity"] is MAPPED
    [create] = seen["ops"]
    assert create["minted"] is True
