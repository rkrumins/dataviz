"""A canvas save sent with an ``Idempotency-Key`` can be retried without creating anything twice.

The route stores the key as ``changes:{actor}:{key}`` on the commit, and names the entities the
save creates deterministically: by the op's client ref when it is at least 16 characters (every
canvas temp ref is), otherwise by the key and the op's turn in the batch. So a retry of the same
batch names the same entities, a later batch that still carries the same staged create names the
same entity, and a script that reuses a short ref like ``n1`` under a new key never overwrites
what an earlier save created. The actor is part of every seed. No database needed.
"""
import re
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import graph
from backend.app.api.v1.endpoints.graph import _replay_minters, _resolve_change_ops
from backend.app.ontology.urn import make_urn
from backend.app.services.versioning import service

_STAGED = "urn:staged:3f9a1c7b-2e4d-4a8f"          # a canvas temp ref (>= 16 characters)


def _op(op, kind, id=None, ref=None, payload=None):
    return SimpleNamespace(op=op, kind=kind, id=id, ref=ref, payload=payload, base_version=None,
                           unset_properties=None)


def _batch():
    return [
        _op("create", "node", ref=_STAGED, payload={"entityType": "Table", "displayName": "T"}),
        _op("create", "node", ref="n1", payload={"entityType": "Table", "displayName": "U"}),
        _op("create", "edge", ref="staged-edge_0123456789",
            payload={"edgeType": "HAS", "sourceEntityId": _STAGED, "targetEntityId": "n1"}),
        _op("move", "node", id="n1", ref="contains-" + _STAGED,
            payload={"parentEntityId": _STAGED, "edgeType": "CONTAINS"}),
    ]


def _resolve(scope, key, ops=None):
    return _resolve_change_ops(ops or _batch(), *_replay_minters(scope, key, make_urn), by_ref=True)


def test_a_retry_of_the_same_batch_names_the_same_entities():
    first, second = _resolve("g/b/u", "k1"), _resolve("g/b/u", "k1")
    assert first == second
    _ops, assigned = first
    assert re.fullmatch(r"urn:synodic:manual:table:[0-9a-f]{32}", assigned[_STAGED])
    assert re.fullmatch(r"ent_[0-9a-f]{32}", assigned["staged-edge_0123456789"])


def test_a_long_ref_names_the_same_entity_under_any_key():
    _, a = _resolve("g/b/u", "k1")
    _, b = _resolve("g/b/u", "k2", [_batch()[0]])      # an edited batch that still carries it
    assert a[_STAGED] == b[_STAGED]
    assert a["contains-" + _STAGED] == _resolve("g/b/u", "k2")[1]["contains-" + _STAGED]


def test_a_short_ref_is_named_by_the_key_and_its_turn():
    _, a = _resolve("g/b/u", "k1")
    _, b = _resolve("g/b/u", "k2")
    assert a["n1"] != b["n1"], "a script reusing 'n1' under a new key must not overwrite"
    assert len({a[_STAGED], a["n1"], a["staged-edge_0123456789"], a["contains-" + _STAGED]}) == 4


def test_another_principal_or_branch_never_shares_an_id():
    _, mine = _resolve("g/b/alice", "k1")
    for scope in ("g/b/bob", "g/b2/alice"):
        _, theirs = _resolve(scope, "k1")
        assert not set(mine.values()) & set(theirs.values())


class _Svc:
    calls: list = []

    async def get_graph_by_data_source(self, ds):
        return {"graph_id": "g1", "workspace_id": "ws1", "kind": "manual"}

    async def apply_ops_detailed(self, **kw):
        _Svc.calls.append(kw)
        return service.ApplyResult("cmt_1", {}, {})


class _Cache:
    async def bump_generation(self, scope):
        return None


@pytest.fixture
def route(monkeypatch):
    _Svc.calls = []
    monkeypatch.setattr(service, "GraphVersioningService", _Svc)
    monkeypatch.setattr(graph, "get_graph_cache", lambda: _Cache())

    async def no_types(engine):
        return []

    async def no_rules(engine, *, fail_closed=False):
        return None

    monkeypatch.setattr(graph, "_resolve_containment_types", no_types)
    monkeypatch.setattr(graph, "_resolve_ontology_rules", no_rules)

    async def call(key, actor="u1"):
        request = graph.GraphChangesRequest(ops=[graph.GraphChangeOp(
            op="create", kind="node", ref="n1", payload={"entityType": "Table", "displayName": "T"})])
        return await graph.apply_graph_changes(
            "ws1", request, dataSourceId="ds1", branchId="br1", idempotency_key=key,
            user=SimpleNamespace(id=actor), engine=None)
    return call


async def test_the_route_stores_the_key_per_actor_and_answers_a_retry_alike(route):
    first, second = await route("k1"), await route("k1")
    assert first["assigned"] == second["assigned"]
    assert [c["idempotency_key"] for c in _Svc.calls] == ["changes:u1:k1", "changes:u1:k1"]
    assert _Svc.calls[0]["ops"] == _Svc.calls[1]["ops"]
    other = await route("k1", actor="u2")
    assert _Svc.calls[2]["idempotency_key"] == "changes:u2:k1"
    assert other["assigned"]["n1"] != first["assigned"]["n1"]


async def test_without_a_key_nothing_is_stored_and_every_id_is_new(route):
    first, second = await route(None), await route(None)
    assert [c["idempotency_key"] for c in _Svc.calls] == [None, None]
    assert first["assigned"]["n1"] != second["assigned"]["n1"]
