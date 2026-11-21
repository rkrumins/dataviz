"""The assistant's building blocks, one at a time."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from backend.ai_service import connections, settings_store
from backend.ai_service.agent import concepts as C
from backend.ai_service.agent import predicates as P
from backend.ai_service.agent.impact import humanize_cron
from backend.ai_service.agent.loop import ChatRequest, choose_persona
from backend.ai_service.agent.policy import DataPolicy
from backend.ai_service.agent.state import ConversationState
from backend.common.credential_crypto import REDACTION_MARKER


# ── Predicates ──────────────────────────────────────────────────────────


def _expand(node, results=None, concepts=None):
    return P.expand(node, result_set=lambda r: (results or {}).get(r),
                    concept=lambda n, _a: (concepts or {}).get(n.lower()))


def test_result_sets_and_concepts_expand_into_real_predicates():
    tag = {"kind": "tag", "op": "has", "values": ["pii"]}
    node = {"kind": "group", "op": "and", "children": [
        {"kind": "resultSet", "ref": "@r1"}, {"kind": "concept", "name": "PII"}]}
    out = _expand(node, results={"r1": {"kind": "entityType", "op": "in", "values": ["dataset"]}},
                  concepts={"pii": tag})
    assert out["children"] == [{"kind": "entityType", "op": "in", "values": ["dataset"]}, tag]
    assert P.validate(out)["kind"] == "group"


def test_an_unconfirmed_concept_stops_the_search():
    with pytest.raises(P.ConceptNeeded) as info:
        _expand({"kind": "concept", "name": "owner"})
    assert info.value.name == "owner"


def test_unknown_fields_and_kinds_are_errors_not_silently_dropped():
    with pytest.raises(P.PredicateInvalid, match="maxHop"):
        P.validate({"kind": "related", "axis": "downstream", "maxHop": 3,
                    "where": {"kind": "entityType", "values": ["dashboard"]}})
    with pytest.raises(P.PredicateInvalid, match="unknown kind"):
        P.validate({"kind": "fulltextMagic", "value": "x"})
    with pytest.raises(P.PredicateInvalid, match="no earlier result"):
        _expand({"kind": "resultSet", "ref": "r9"})


def test_validation_keeps_wire_names():
    out = P.validate(P.downstream_of(["urn:a"], max_hops=40))
    assert out["axis"] == "upstream" and out["maxHops"] == 10
    assert out["where"]["refs"] == [{"urn": "urn:a", "caseSensitive": True}]


# ── Data policy ─────────────────────────────────────────────────────────


def test_policy_withholds_what_the_administrator_withheld():
    policy = DataPolicy.from_settings({
        "sendDescriptions": False, "sendPropertyValues": False, "sendSampleValues": False,
        "maxResultRows": 2, "redactPatterns": [r"[\w.]+@[\w.]+"],
    })
    shaped = policy.apply({
        "name": "orders", "description": "secret plan", "properties": {"owner": "bob@corp.com"},
        "values": [1, 2], "items": [1, 2, 3, 4], "note": "mail ann@corp.com",
    })
    assert "description" not in shaped and "values" not in shaped
    assert shaped["properties"] == ["owner"]
    assert shaped["items"] == [1, 2, "… 2 more not shown"]
    assert shaped["note"] == "mail [redacted]"


# ── Concepts ────────────────────────────────────────────────────────────


def _grounding(properties, tags):
    return SimpleNamespace(properties=lambda: properties, tags=lambda: tags)


def test_concept_candidates_come_from_tags_properties_and_values():
    g = _grounding(
        properties=[
            {"key": "personal_data", "kinds": ["Boolean"], "values": [{"value": True}, {"value": False}]},
            {"key": "classification", "kinds": ["String"], "values": [{"value": "PII"}, {"value": "Public"}]},
            {"key": "rowCount", "kinds": ["Integer"]},
        ],
        tags=[{"tag": "pii"}, {"tag": "GDPR-Regulated"}, {"tag": "certified"}],
    )
    found = C.candidates_from(g, "PII")
    labels = [c.label for c in found]
    assert labels[0] == "Tag “pii”" and found[0].exact
    assert "personal_data is true" in labels
    assert "classification is “PII”" in labels
    assert "Tag “GDPR-Regulated”" in labels
    assert not any("rowCount" in l for l in labels)
    assert len({c.id for c in found}) == len(found) and found[0].id == C.option_id(found[0].predicate)


def test_attribute_terms_read_as_property_keys():
    g = _grounding(properties=[{"key": "updated_at", "kinds": ["String"]},
                               {"key": "last_modified", "kinds": ["String"]}], tags=[])
    keys = [c.property_key for c in C.candidates_from(g, "updated", want="property")]
    assert set(keys) == {"updated_at", "last_modified"}


def test_clarification_ids_are_stable():
    assert C.clarification_id("PII", "ds_1") == C.clarification_id("pii", "ds_1")
    assert C.clarification_id("PII", "ds_1") != C.clarification_id("PII", "ds_2")


# ── The rest ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("expr,words", [
    ("0 4 * * *", "daily at 04:00 UTC"), ("30 6 * * 1-5", "weekdays at 06:30 UTC"),
    ("0 2 1 * *", "monthly on day 1 at 02:00 UTC"), ("15 * * * *", "hourly at :15"),
    ("*/10 * * * *", "every 10 minutes"), ("@daily", None),
])
def test_schedules_read_in_plain_words(expr, words):
    assert humanize_cron(expr) == words


def test_persona_follows_the_question():
    def persona(message, **ctx):
        return choose_persona(ChatRequest(message=message, context=ctx), {"data": True, "help": True})

    assert persona("How do I share a view?") == "help"
    assert persona("How do I find the downstream dashboards of orders?", viewId="v") == "data"
    assert persona("What breaks if orders is dropped?") == "data"
    assert choose_persona(ChatRequest(message="How do I share?"), {"data": True, "help": False}) == "data"


def test_conversation_state_round_trips():
    state = ConversationState()
    ref = state.add_result(label="PII", predicate={"kind": "all"}, workspace_id="w",
                           data_source_id="d", view_id="v", total=3)
    state.confirm_concept("PII", "d", label="Tag pii", predicate={"kind": "tag", "values": ["pii"]})
    back = ConversationState.loads(state.dumps())
    assert back.result(ref.id).total == 3 and back.confirmed("pii", "d")["label"] == "Tag pii"
    assert back.next_ref == 2


def test_settings_reject_what_they_cannot_honour():
    with pytest.raises(settings_store.SettingsInvalid):
        settings_store._validate_patch({"dataPolicy": {"redactPatterns": ["("]}})
    with pytest.raises(settings_store.SettingsInvalid):
        settings_store._validate_patch({"personas": {"wizard": True}})
    clean = settings_store._validate_patch({"limits": {"maxStepsPerTurn": 99}, "retentionDays": 0})
    assert clean == {"limits": {"maxStepsPerTurn": 16}, "retentionDays": 1}


def _row(**kw):
    defaults = dict(name="gw", kind="openai_compatible", base_url="https://gw.example/v1",
                    auth_type="api_key", auth_config="{}", secrets_encrypted=None,
                    extra_headers="{}", options="{}", models='{"chat": "m"}', enabled=True)
    defaults.update(kw)
    return SimpleNamespace(**defaults)


def test_secrets_are_write_only_and_merge():
    from backend.common import credential_crypto

    row = _row(secrets_encrypted=credential_crypto.encrypt({"apiKey": "sk-1"}))
    merged = connections._merge(row, connections.ConnectionInput(models={"chat": "m2"}))
    assert merged["secrets"] == {"apiKey": "sk-1"}
    with pytest.raises(connections.ConnectionInvalid, match="redaction marker"):
        connections._merge(row, connections.ConnectionInput(secrets={"apiKey": REDACTION_MARKER}))
    cleared = connections._merge(row, connections.ConnectionInput(secretsClear=["apiKey"]))
    assert cleared["secrets"] == {}
    switched = connections._merge(row, connections.ConnectionInput(authType="basic"))
    assert switched["secrets"] == {}
    public = connections.public(SimpleNamespace(**{**row.__dict__, "id": "llm_1", "capabilities": "{}",
                                                   "last_test_at": None, "created_by": None,
                                                   "created_at": "", "updated_by": None, "updated_at": ""}))
    assert public["secrets"] == {"apiKey": {"configured": True}} and "sk-1" not in json.dumps(public)


def test_connections_refuse_what_would_misroute_credentials():
    def check(**body):
        connections._validate(connections._merge(None, connections.ConnectionInput(
            name="x", baseUrl="https://gw.example/v1", models={"chat": "m"}, **body)))

    with pytest.raises(connections.ConnectionInvalid, match="extraHeaders"):
        check(extraHeaders={"Authorization": "Bearer x"})
    with pytest.raises(connections.ConnectionInvalid, match="does not take"):
        check(authType="api_key", authConfig={"tokenUrl": "https://x"})
    with pytest.raises(connections.ConnectionInvalid, match="credentials"):
        connections._validate(connections._merge(None, connections.ConnectionInput(
            name="x", baseUrl="https://user:pw@gw.example/v1", models={"chat": "m"})))
    check(authType="token_mint", authConfig={"tokenUrl": "https://gw.example/token", "username": "svc"},
          secrets={"password": "p"})


def test_the_service_holds_none_of_the_web_tier():
    """It reads through the platform API as the person, so it must not carry the
    web tier's auth, permission or routing code that would let it read past it."""
    import subprocess
    import sys

    code = ("import sys; from backend.ai_service.app import create_app; create_app(start_background=False); "
            "print([m for m in sys.modules if m == 'backend.app.main' or m.startswith(("
            "'backend.app.auth', 'backend.app.api.v1.api', 'backend.app.services.permission_service', "
            "'backend.app.services.view_service', 'backend.app.providers'))])")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120,
                         cwd=__import__("pathlib").Path(__file__).resolve().parents[2])
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip().splitlines()[-1] == "[]"


# ── The shape of a data source ──────────────────────────────────────────

from backend.ai_service.agent import brief as B
from backend.ai_service.agent.grounding import Grounding, Target


def _prop(key, values, *, on="Node", total=500, kind="String", distinct=None):
    count = sum(n for _, n in values) if values else total
    return {"key": key, "count": count, "kinds": {kind: count}, "byEntityType": {on: count},
            "distinct": distinct if distinct is not None else len(values), "distinctExact": True,
            "values": [{"value": v, "count": n} for v, n in values]}


KIND = _prop("kind", [("table", 300), ("column", 150), ("dashboard", 30), ("job", 20)])


def _catalog(*props, types=(("Node", 500),)):
    return {"entities": sum(n for _, n in types), "entityTypes": [{"type": t, "count": n} for t, n in types],
            "properties": list(props)}


def test_the_detector_finds_what_kind_each_entity_is():
    found = B.detect_type_property(_catalog(KIND, _prop("name", [], distinct=480)), None, None)
    assert [c["key"] for c in found] == ["kind"] and found[0]["on"] == "Node" and found[0]["coverage"] == 1.0


def test_the_detector_leaves_real_schemas_alone():
    # Three populated types with real names: nothing to detect.
    three = _catalog(_prop("kind", [("a", 10), ("b", 10)], on="table"),
                     types=(("table", 300), ("column", 150), ("dashboard", 50)))
    assert B.detect_type_property(three, None, None) == []
    # A column-heavy view of a two-type source: a column's data type is not a kind of thing.
    data_type = _prop("dataType", [("varchar", 200), ("int", 100), ("date", 50)], on="column")
    assert B.detect_type_property(_catalog(data_type, types=(("column", 350), ("table", 20))), None, None) == []
    # Identities, near-constant keys and sentences don't qualify.
    constant = _prop("source", [("prod", 499), ("dev", 1)])
    prose = _prop("note", [("this is a long free text note about it", 250), ("another long note here ok", 250)])
    assert B.detect_type_property(_catalog(constant, prose), None, None) == []


def test_hierarchy_chains_read_top_to_bottom():
    schema = {"entityTypes": [{"id": "platform", "canContain": ["schema"]}, {"id": "schema", "canContain": ["table"]},
                              {"id": "table", "canContain": ["table", "column"]}, {"id": "column"}],
              "relationshipTypes": [{"class": "containment", "from": ["platform"], "to": ["dashboard"]}]}
    chains = B.hierarchy_chains(schema)
    assert chains[0] == ["platform", "schema", "table", "column"] and ["platform", "dashboard"] in chains


def test_hierarchy_chains_follow_levels_and_what_holds_entities():
    # A semantic layer's "can contain" lists are permissive; its levels and the data are not.
    schema = {"entityTypes": [
        {"id": "domain", "level": 0, "canContain": ["platform", "table"]},
        {"id": "platform", "level": 1, "canContain": ["schema", "platform", "system"]},
        {"id": "system", "level": 1, "canContain": ["schema", "platform"]},
        {"id": "schema", "level": 2, "canContain": ["table", "platform"]},
        {"id": "table", "level": 3, "canContain": ["column", "field"]},
        {"id": "column", "level": 4}, {"id": "field", "level": 4}],
        "relationshipTypes": [{"class": "containment", "from": ["domain", "platform", "system", "schema"],
                               "to": ["platform", "system", "schema", "table", "column"]}]}
    present = {"platform": 7, "system": 2, "schema": 30, "table": 300, "column": 4000}
    chains = B.hierarchy_chains(schema, present=present)
    assert chains[0] == ["platform", "schema", "table", "column"]      # domain and field hold nothing
    assert all(c[:2] != ["platform", "system"] for c in chains)        # never sideways across a level


def test_kinds_of_thing_are_read_through_the_type_property():
    out = P.rewrite_types({"kind": "group", "op": "and", "children": [
        {"kind": "entityType", "op": "in", "values": ["table", "Node"]},
        {"kind": "entityType", "op": "notIn", "values": ["job"]}]}, on="Node", key="kind", kinds={"table", "job"})
    keep, drop = out["children"]
    assert keep["op"] == "or" and {"kind": "entityType", "op": "in", "values": ["Node"]} in keep["children"]
    assert drop["op"] == "not" and drop["children"][0]["children"][1]["value"] == ["job"]
    assert P.validate(out)


def test_the_card_fits_its_budget_by_shedding_detail():
    card = {"entityTypes": [{"id": f"t{i}", "description": "x" * 150} for i in range(40)],
            "relationships": [{"id": f"R{i}", "description": "y" * 150} for i in range(40)],
            "properties": [{"key": f"p{i}", "values": [{"value": "v" * 40, "count": 1}] * 6} for i in range(60)],
            "tags": [{"tag": f"tag{i}", "count": i} for i in range(40)]}
    policy = DataPolicy(max_result_rows=200)
    text = B.fit(card, policy, limit=8000)
    assert len(text) <= 8000 and "(truncated)" not in text and json.loads(text)["entityTypes"][0]["id"] == "t0"


def test_terminal_types_and_owner_keys_come_from_the_data():
    g = Grounding(target=Target(), schema={"relationshipTypes": [
        {"class": "lineage", "from": ["table"], "to": ["table", "dashboard"]},
        {"class": "containment", "from": ["db"], "to": ["table"]}]},
        catalog={"properties": [{"key": "owning_team", "count": 9}, {"key": "data_steward", "count": 30},
                                {"key": "rowCount", "count": 99}]})
    assert g.terminal_types() == {"dashboard"}
    assert g.owner_keys("owner") == ["owner", "data_steward", "owning_team"]
    g.type_property, g.value_sets = {"on": "Node", "key": "kind"}, {"kind": [{"value": "table", "count": 3}]}
    assert g.display_type({"entityType": "Node", "properties": {"kind": "table"}}) == "table"
    assert g.display_type({"entityType": "Other", "properties": {"kind": "table"}}) == "Other"


def test_one_edge_type_spelled_two_ways_is_one_connection():
    g = Grounding(target=Target(), schema={"relationshipTypes": [{"id": "related", "class": "other"}],
                                          "containmentEdgeTypes": [], "lineageEdgeTypes": []},
                  introspection={"edgeTypeStats": [{"id": "RELATED", "count": 887}]})
    assert [(c["id"], c["count"]) for c in B._connections(g, g.schema)] == [("RELATED", 887)]

