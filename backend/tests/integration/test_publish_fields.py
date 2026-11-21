"""The fields an entity type defines hold at publish — needs Postgres.

A team gives a field of an entity type a type, allowed values, or "required" (``EntityRule.fields``).
Editing never waits on them — the drawers and the bulk dialog warn — so publishing is the gate, as
it is for a field kept unique: a draft that gives an entity a value its field refuses, or leaves a
required field without one, is refused, naming each entity, field and value. Only what the draft
changes is judged: data that predates a rule stays publishable. The same on each squash a publish
can take — the full merge, the narrow copy (rows judged from their identity columns, so the values
are read in full for the types with field rules) and the paged one.
"""
import os

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.errors import FieldViolation
from backend.app.services.versioning.ontology import EntityRule, FieldRule, OntologyRules
from backend.common.property_patch import PROP_DELETE
from backend.tests.integration.test_fork_overlay_delta import _run

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

RULES = OntologyRules(entity_types={"Table": EntityRule(fields={
    "tier": FieldRule(type="status", allowed=("gold", "silver"), name="Tier"),
    "owner": FieldRule(required=True, name="Owner"),
    "rows": FieldRule(type="number", name="Rows"),
})})
PATHS = ("narrow", "full", "paged")


def _table(eid, op="create", **props):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid.split(":")[-1],
                        "properties": props}}


async def _graph(svc):
    """A graph whose main holds a Table that predates the rules: a tier they don't allow, no owner."""
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[
        _table("urn:Legacy", tier="bronze", rows="many"), _table("urn:Owned", owner="ana", tier="gold")])
    return gid


async def _draft(svc, gid, ops):
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="edit", ops=ops)
    return draft


def _take(path, monkeypatch):
    monkeypatch.setattr(config, "NARROW_SQUASH", path != "full")
    if path == "paged":
        monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 0)
        monkeypatch.setattr(config, "SQUASH_PAGE", 1)


@pytest.mark.parametrize("path", PATHS)
def test_a_publish_giving_values_their_fields_refuse_is_refused(path, monkeypatch):
    _take(path, monkeypatch)

    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table("urn:New", tier="bronze", rows="12")])
        with pytest.raises(FieldViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        assert exc.value.status_code == 409 and exc.value.detail["type"] == "field_violation"
        found = exc.value.detail["violations"]
        assert [(v["entity_id"], v["rule"], v["field"]) for v in found] == [
            ("urn:New", "field_required", "owner"), ("urn:New", "field_not_allowed", "tier")]
        assert found[1]["value"] == "bronze" and found[1]["name"] == "New" and found[1]["type"] == "Table"
        assert found[1]["reason"] == "Tier must be one of 'gold', 'silver' — 'bronze' isn't."
        assert exc.value.detail["total"] == 2
    _run(case)


@pytest.mark.parametrize("path", PATHS)
def test_values_that_predate_the_rules_stay_publishable(path, monkeypatch):
    _take(path, monkeypatch)

    async def case(svc):
        gid = await _graph(svc)
        # The legacy Table renamed, its bad tier and missing owner untouched; a good new one.
        draft = await _draft(svc, gid, [
            {"op": "update", "entity_kind": "node", "entity_id": "urn:Legacy",
             "payload": {"displayName": "Legacy (renamed)"}},
            _table("urn:Good", owner="bo", tier="silver", rows=3)])
        assert await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                                 ontology_rules=RULES)
    _run(case)


@pytest.mark.parametrize("path", PATHS)
def test_emptying_a_required_field_or_changing_a_value_badly_is_refused(path, monkeypatch):
    _take(path, monkeypatch)

    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table("urn:Owned", op="update", owner=PROP_DELETE),
                                        _table("urn:Legacy", op="update", rows="lots")])
        with pytest.raises(FieldViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        found = [(v["entity_id"], v["rule"], v["field"]) for v in exc.value.detail["violations"]]
        both = [("urn:Legacy", "field_type", "rows"), ("urn:Owned", "field_required", "owner")]
        # A paged publish stops at the first page that breaks a rule (here a page is one entity).
        assert found == (both[:1] if path == "paged" else both)
        # Without field rules the same draft publishes.
        assert await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                                 ontology_rules=OntologyRules())
    _run(case)
