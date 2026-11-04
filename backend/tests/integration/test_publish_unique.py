"""A field its type keeps unique stays unique when a draft is published — needs Postgres.

A team marks a field of an entity type "Must be unique" (``EntityRule.unique_fields``). Imports
never create a second node with a value one already carries; edits on the canvas aren't checked
while a person works, so publishing is the gate: a draft that would leave two live nodes of the
type with the same value is refused, naming each value and who carries it.
"""
import os

import pytest

from backend.app.services.versioning.errors import UniqueViolation
from backend.app.services.versioning.ontology import EntityRule, OntologyRules
from backend.tests.integration.test_fork_overlay_delta import _run

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

RULES = OntologyRules(entity_types={"Table": EntityRule(unique_fields=frozenset({"serial"}))})


def _table(eid, serial=None, name=None):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name or eid,
                        **({"properties": {"serial": serial}} if serial else {})}}


async def _graph(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_table("urn:M", "SN-1")])
    return gid


async def _draft(svc, gid, ops):
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="edit", ops=ops)
    return draft


def test_a_publish_that_repeats_a_unique_value_on_main_is_refused():
    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table("urn:N", "SN-1")])
        with pytest.raises(UniqueViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        v, = exc.value.detail["violations"]
        assert (v["type"], v["field"], v["value"]) == ("Table", "serial", "SN-1")
        assert v["entities"] == ["urn:M", "urn:N"]
        assert exc.value.status_code == 409 and exc.value.detail["total"] == 1
    _run(case)


def test_a_publish_that_repeats_a_unique_value_within_the_draft_is_refused():
    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table("urn:A", "SN-2"), _table("urn:B", "SN-2")])
        with pytest.raises(UniqueViolation) as exc:
            await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                              ontology_rules=RULES)
        assert exc.value.detail["violations"][0]["entities"] == ["urn:A", "urn:B"]
    _run(case)


def test_unique_values_and_unflagged_fields_publish():
    async def case(svc):
        gid = await _graph(svc)
        draft = await _draft(svc, gid, [_table("urn:C", "SN-3")])
        assert await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                                 ontology_rules=RULES)
        # The same repeat as above, with no field kept unique: nothing to refuse.
        draft = await _draft(svc, gid, [_table("urn:D", "SN-1")])
        assert await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="go",
                                 ontology_rules=OntologyRules())
    _run(case)
