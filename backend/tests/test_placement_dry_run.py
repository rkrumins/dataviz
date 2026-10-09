"""``backend/scripts/placement_dry_run.py``: what turning ``placementContractEnabled`` on would change.

The diff itself is checked case by case against the shared corpus in
tests/test_placement_legacy_parity.py; this file covers the rest of the report: the request the
canvas builds, the canvas-only constructs, the sample read from a view's engine, the per-view
summary and the command line.
"""
from __future__ import annotations

import contextlib
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.models.graph import GraphEdge, GraphNode
from backend.scripts import placement_dry_run as dry


def _view_config(layers, assignments=None, scope="all"):
    return {"content": {"entityScope": scope},
            "layout": {"referenceLayout": {"layers": layers, "assignments": assignments or {}}}}


def _node(urn, entity_type="table", **kw):
    return GraphNode(urn=urn, displayName=urn, entityType=entity_type, **kw)


def _edge(src, tgt, edge_type="CONTAINS"):
    return GraphEdge(id=f"{src}->{tgt}", sourceUrn=src, targetUrn=tgt, edgeType=edge_type)


# ── the request the canvas builds ───────────────────────────────────────

def test_the_legacy_request_mirrors_the_canvas():
    config = _view_config(
        [{"id": "a", "name": "A", "order": 0, "entityTypes": ["table"],
          "entityAssignments": [{"urn": "urn:old", "inheritsChildren": False}]}],
        {"urn:x": {"layerId": "a", "assignedBy": "import"}, "urn:y": {"layerId": "a", "assignedBy": "rule",
                                                                      "inheritsChildren": None}})
    request = dry.build_legacy_request(config, ["urn:x", "urn:y"])

    layer = request.layers[0]
    assert (layer.color, layer.sequence, layer.rules, layer.entity_assignments) == ("#808080", 0, [], [])
    assert set(request.assignments) == {"urn:x", "urn:y", "urn:old"}  # legacy entries normalised in
    assert request.assignments["urn:old"].inherits_children is False
    assert request.assignments["urn:x"].assigned_by == "user"           # 'import' reads as a user placement
    assert request.assignments["urn:y"].assigned_by == "rule"
    assert request.assignments["urn:y"].inherits_children is True       # null means the default
    assert {a.priority for a in request.assignments.values()} == {1000}
    assert request.entity_scope == "all"
    assert request.urns == ["urn:x", "urn:y"]


def test_a_config_the_server_refuses_is_rejected():
    config = _view_config([{"id": "a", "name": "A", "order": 0, "rules": [{"id": "r", "tags": ["pii"]}]}])
    with pytest.raises(ValidationError):
        dry.build_legacy_request(config, [])


async def test_the_diff_reports_old_and_new_for_changed_members_only():
    config = _view_config([{"id": "a", "name": "A", "order": 0, "entityTypes": ["schema"]},
                           {"id": "b", "name": "B", "order": 1, "entityTypes": ["table"]}])
    nodes = [_node("p", "schema"), _node("c"), _node("k", "column")]
    edges = [_edge("p", "c"), _edge("c", "k")]

    diff = await dry.diff_placements(config, {"CONTAINS": False}, nodes, edges)

    # c now takes its own rule (decision 2) and k follows c; p is unchanged and not listed.
    assert diff == {
        "c": ({"layerId": "a", "source": "inherited"}, {"layerId": "b", "source": "rule", "ruleId": "_type_b_table"}),
        "k": ({"layerId": "a", "source": "inherited"}, {"layerId": "b", "source": "inherited", "inheritedFrom": "c"}),
    }
    rejected = _view_config([{"id": "a", "name": "A", "order": 0.5}])
    assert await dry.diff_placements(rejected, {}, nodes, []) == dry.REJECTED


# ── canvas-only constructs ──────────────────────────────────────────────

def test_config_flags_name_every_canvas_only_construct():
    config = _view_config([
        {"id": "a", "name": "A", "order": 0, "entityTypes": ["Dataset"], "showUnassigned": True,
         "rules": [{"id": "r1", "priority": 1, "urnPattern": "urn:li:*"},
                   {"id": "r2", "priority": 1, "urnPattern": ""},
                   {"id": "r3", "priority": 1, "propertyMatch": {"field": "owner", "value": "x"}}]},
        {"id": "b", "name": "B", "order": 1, "entityTypes": ["dataset"]},
    ])
    assert dry.config_flags(config) == [
        "duplicate-types", "authored-rules", "empty-rule", "glob-pattern", "property-rule", "fallback-layer"]


def test_config_flags_are_empty_for_a_plain_view_and_fallback_is_open_scope_only():
    assert dry.config_flags(_view_config([{"id": "a", "name": "A", "order": 0, "entityTypes": ["table"]}])) == []
    curated = _view_config([{"id": "a", "name": "A", "order": 0, "showUnassigned": True}], scope="curated")
    assert dry.config_flags(curated) == []


# ── the sample ──────────────────────────────────────────────────────────

class _Engine:
    """The ContextEngine reads ``_sample`` makes, recorded."""

    def __init__(self, nodes, edges=(), chains=None, declared=("dataset",)):
        self.nodes = {n.urn: n for n in nodes}
        self.edges = list(edges)
        self.chains = chains
        self.declared = declared
        self.node_queries, self.chain_calls, self.edge_queries = [], [], []

    async def get_resolved_ontology(self):
        from backend.app.ontology.models import ResolvedOntology
        return ResolvedOntology(
            entity_type_definitions={t: {} for t in self.declared},
            containment_edge_types=["CONTAINS", "BELONGS_TO"],
            edge_type_metadata={"BELONGS_TO": {"direction": "target-to-source"}})

    async def get_nodes_query(self, query):
        self.node_queries.append(query)
        if query.urns:
            return [self.nodes[u] for u in query.urns if u in self.nodes]
        hits = [n for n in self.nodes.values()
                if (query.entity_types and n.entity_type in query.entity_types)
                or (query.tags and set(query.tags) & set(n.tags))]
        return hits[: query.limit]

    async def get_ancestor_chains(self, urns):
        self.chain_calls.append(list(urns))
        if self.chains is None:
            raise NotImplementedError("no containment walk")
        return {u: self.chains.get(u, []) for u in urns}

    async def get_edges(self, query):
        self.edge_queries.append(query)
        return self.edges


async def test_the_sample_reads_claims_tags_explicit_entries_and_their_ancestors(monkeypatch):
    monkeypatch.setattr(dry, "_CHAIN_CHUNK", 2)
    config = _view_config(
        [{"id": "a", "name": "A", "order": 0, "entityTypes": ["Dataset"],
          "rules": [{"id": "r", "priority": 1, "tags": ["pii"], "entityTypes": ["DATASET"]}]}],
        {"urn:e": {"layerId": "a"}})
    engine = _Engine(
        [_node("urn:d", "dataset"), _node("urn:t", "table", tags=["pii"]), _node("urn:e", "folder"),
         _node("urn:p", "schema")],
        edges=[_edge("urn:p", "urn:d")], chains={"urn:d": ["urn:p"]})

    nodes, edges, containment, capped = await dry._sample(engine, config)

    claimed = [q.entity_types for q in engine.node_queries if q.entity_types]
    assert claimed == [["dataset"]]  # both spellings map to the one declared id
    assert [q.tags for q in engine.node_queries if q.tags] == [["pii"]]
    assert engine.chain_calls == [["urn:d", "urn:e"], ["urn:t"]]
    assert sorted(n.urn for n in nodes) == ["urn:d", "urn:e", "urn:p", "urn:t"]
    assert sorted(engine.edge_queries[0].source_urns) == ["urn:d", "urn:e", "urn:p", "urn:t"]
    assert edges == [_edge("urn:p", "urn:d")]
    assert containment == {"CONTAINS": False, "BELONGS_TO": True}
    assert capped is False


async def test_the_sample_says_when_it_is_capped_and_tolerates_no_chains(monkeypatch):
    monkeypatch.setattr(dry, "PER_TYPE_SAMPLE", 1)
    config = _view_config([{"id": "a", "name": "A", "order": 0, "entityTypes": ["table"]}])
    engine = _Engine([_node("urn:1"), _node("urn:2")], chains=None, declared=())

    nodes, _edges, _containment, capped = await dry._sample(engine, config)

    assert capped is True
    assert [n.urn for n in nodes] == ["urn:1"]


# ── the summary ─────────────────────────────────────────────────────────

_VIEW = SimpleNamespace(id="v1", name="Lake", workspace_id="ws1")


def test_the_summary_counts_transitions_and_lists_what_to_fix():
    config = _view_config(
        [{"id": "a", "name": "A", "order": 0, "rules": [{"id": "empty", "priority": 1}]},
         {"id": "b", "name": "B", "order": 1}],
        {"urn:s": {"layerId": "gone"}})
    diff = {
        "urn:1": ({"layerId": "b", "source": "inherited"}, {"layerId": "a", "source": "rule", "ruleId": "r"}),
        "urn:2": ({"layerId": "b", "source": "inherited"}, {"layerId": "a", "source": "rule", "ruleId": "r"}),
        "urn:s": ({"layerId": "gone", "source": "explicit"}, {"layerId": None, "source": "none", "staleExplicit": True}),
    }

    row = dry._summarise(_VIEW, config, [_node("urn:1"), _node("urn:2"), _node("urn:s")], diff, False)

    assert row == {
        "view": "v1", "name": "Lake", "workspace": "ws1", "scope": "all", "sampled": 3, "capped": False,
        "rejected": False, "changed": 3,
        "byTransition": {"explicit->none +stale": 1, "inherited->rule": 2},
        "examples": {"explicit->none +stale": ["urn:s"], "inherited->rule": ["urn:1", "urn:2"]},
        "inertRules": [{"layerId": "a", "ruleId": "empty",
                        "reason": "has no criteria, so it can never place anything"}],
        "staleExplicit": {"count": 1, "examples": ["urn:s"]},
        "canvasOnly": ["authored-rules", "empty-rule"],
    }
    text = dry._render(row)
    assert text[0] == 'view v1 "Lake" (scope all, 3 sampled): 3 would change'
    assert "  inherited->rule: 2  e.g. urn:1, urn:2" in text


def test_a_rejected_view_and_a_quiet_view():
    config = _view_config([{"id": "a", "name": "A", "order": 0, "entityTypes": ["table"]}])
    rejected = dry._summarise(_VIEW, config, [], dry.REJECTED, True)
    assert (rejected["rejected"], rejected["changed"], rejected["byTransition"]) == (True, None, {})
    assert dry._render(rejected) == ['view v1 "Lake" (scope all, 0 sampled, capped): the server refuses this config today']
    assert dry._render(dry._summarise(_VIEW, config, [], {}, False)) == []


# ── the command line ────────────────────────────────────────────────────

def test_main_prints_each_view_and_writes_json(monkeypatch, tmp_path, capsys):
    rows = [
        dry._summarise(_VIEW, _view_config([{"id": "a", "name": "A", "order": 0}]), [], dry.REJECTED, False),
        {"view": "v2", "name": "Broken", "workspace": "ws1", "error": "ProviderUnavailable: down"},
    ]
    seen = {}

    async def _run(view_ids, workspace_id):
        seen.update(views=view_ids, workspace=workspace_id)
        return rows

    monkeypatch.setattr(dry, "_run", _run)
    out = tmp_path / "report.json"

    assert dry.main(["--view", "v1", "--view", "v2", "--workspace", "ws1", "--json", str(out)]) == 0

    assert seen == {"views": ["v1", "v2"], "workspace": "ws1"}
    printed = capsys.readouterr().out.splitlines()
    assert 'view v2 "Broken": error: ProviderUnavailable: down' in printed
    assert printed[-1] == "1 view(s) would change, of 2 with layers."
    assert json.loads(out.read_text()) == rows


async def test_run_reports_every_live_view_with_layers_and_survives_a_failure(monkeypatch, db_session):
    ws = WorkspaceORM(name="WS")
    db_session.add(ws)
    await db_session.flush()
    layers = [{"id": "a", "name": "A", "order": 0, "entityTypes": ["table"]}]
    for view_id, view_layers, deleted_at in [("v_down", layers, None), ("v_ok", layers, None),
                                             ("v_flat", [], None), ("v_gone", layers, "2026-10-01T00:00:00Z")]:
        db_session.add(ViewORM(id=view_id, name=view_id, workspace_id=ws.id, view_type="reference",
                               config=json.dumps(_view_config(view_layers)), deleted_at=deleted_at))
    await db_session.flush()

    @contextlib.asynccontextmanager
    async def _session():
        yield db_session

    calls = []

    async def _for_workspace(workspace_id, registry, session, data_source_id=None):
        calls.append(workspace_id)
        if len(calls) == 1:  # v_down: views are read in id order
            raise RuntimeError("provider down")
        return _Engine([_node("urn:1")], chains={})

    monkeypatch.setattr(dry, "get_async_session", _session)
    monkeypatch.setattr(dry.ContextEngine, "for_workspace", _for_workspace)

    rows = await dry._run(None, ws.id)

    assert [row["view"] for row in rows] == ["v_down", "v_ok"]  # no layers, or deleted: skipped
    assert rows[0]["error"] == "RuntimeError: provider down"
    assert (rows[1]["sampled"], rows[1]["changed"]) == (1, 0)
