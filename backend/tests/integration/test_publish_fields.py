"""The fields an entity type defines hold at publish — needs Postgres.

A team gives a field of an entity type a type, allowed values, or "required" (``EntityRule.fields``).
Editing never waits on them — the drawers and the bulk dialog warn — so publishing is the gate, as
it is for a field kept unique: a draft that gives an entity a value its field refuses, or leaves a
required field without one, is refused, naming each entity, field and value. Only what the draft
changes is judged: data that predates a rule stays publishable. The same on each squash a publish
can take — the full merge, the narrow copy (rows judged from their identity columns, so the values
are read in full for the types with field rules) and the paged one. A refusal names the first
hundred values and counts them all, per entity type, field and rule — the paged publish judging the
fields of every page after the first it refuses, so the count is the whole draft's.
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
        assert exc.value.detail["byField"] == [
            {"entityType": "Table", "field": "owner", "fieldName": "Owner", "rule": "field_required", "count": 1,
             "ids": ["gv:urn:New"], "idsComplete": True},
            {"entityType": "Table", "field": "tier", "fieldName": "Tier", "rule": "field_not_allowed", "count": 1,
             "ids": ["gv:urn:New"], "idsComplete": True}]
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
        # A paged publish judges every page's fields (here a page is one entity), not only the first.
        assert found == [("urn:Legacy", "field_type", "rows"), ("urn:Owned", "field_required", "owner")]
        # Without field rules the same draft publishes.
        assert await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                                 ontology_rules=OntologyRules())
    _run(case)


@pytest.mark.parametrize("path", PATHS)
def test_a_refusal_counts_every_value_to_change_by_field_page_after_page(path, monkeypatch):
    """Judged a page of nodes at a time, it keeps the first values and counts the rest — for a
    paged publish, past the first page that breaks a rule, nothing of it written."""
    from backend.app.services.versioning import ontology
    _take(path, monkeypatch)
    monkeypatch.setattr(config, "FIELD_CHECK_PAGE", 2)
    monkeypatch.setattr(ontology, "FIELD_EXAMPLES", 3)

    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table(f"urn:New{i}", tier="bronze", rows=1) for i in range(5)]
                             + [_table("urn:Fine", owner="ana", tier="gold")])
        main = await svc.main_branch_id(gid)
        published = await svc.commit_log(graph_id=gid, branch_id=main)
        with pytest.raises(FieldViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        detail = exc.value.detail
        assert detail["total"] == 10 and len(detail["violations"]) == 3
        news = [f"gv:urn:New{i}" for i in range(5)]
        assert detail["byField"] == [
            {"entityType": "Table", "field": "owner", "fieldName": "Owner", "rule": "field_required", "count": 5,
             "ids": news, "idsComplete": True},
            {"entityType": "Table", "field": "tier", "fieldName": "Tier", "rule": "field_not_allowed", "count": 5,
             "ids": news, "idsComplete": True}]
        assert [v["entity_id"] for v in detail["violations"]] == ["urn:New0", "urn:New0", "urn:New1"]
        assert await svc.commit_log(graph_id=gid, branch_id=main) == published      # nothing published
    _run(case)


@pytest.mark.parametrize("path", PATHS)
def test_a_refusal_names_the_entities_to_fix_and_one_bulk_job_on_them_lets_it_publish(path, monkeypatch):
    """Per field, the refusal names the entities it refused as a bulk property job's ``ids`` target
    names them — new in the draft, or emptied there, which a search of Published never reaches —
    up to as many as one job takes (``idsComplete`` says when that is all), across pages. A
    "Fill if empty" on them is what the publish needed."""
    from backend.app.services.versioning import ontology
    from backend.app.services.versioning.import_export.service import ImportExportService
    _take(path, monkeypatch)
    monkeypatch.setattr(config, "FIELD_CHECK_PAGE", 2)
    monkeypatch.setattr(ontology, "FIELD_IDS_MAX", 3)

    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table(f"urn:New{i}", tier="gold") for i in range(4)]
                             + [_table("urn:Owned", op="update", owner=PROP_DELETE)])
        with pytest.raises(FieldViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        [owner] = exc.value.detail["byField"]
        assert (owner["rule"], owner["count"], owner["idsComplete"]) == ("field_required", 5, False)
        assert len(owner["ids"]) == 3 and set(owner["ids"]) < {
            "gv:urn:New0", "gv:urn:New1", "gv:urn:New2", "gv:urn:New3", "gv:urn:Owned"}

        monkeypatch.setattr(ontology, "FIELD_IDS_MAX", config.PROPERTY_JOB_MAX_IDS)
        with pytest.raises(FieldViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        [owner] = exc.value.detail["byField"]
        assert owner["idsComplete"] is True and len(owner["ids"]) == 5

        ie = ImportExportService(versioning=svc)
        job = (await ie.create_property_job(
            workspace_id="ws1", data_source_id=None, graph_id=gid, branch_id=draft, actor="alice",
            op={"kind": "fillEmpty", "key": "owner", "value": "ana"}, target={"ids": owner["ids"]},
            message=None, key="key-fill-required-1"))["job_id"]
        assert (await ie.run_property(job))["changed"] == 5
        assert await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                                 ontology_rules=RULES)
    _run(case)
