"""PATCH /edges/{id}: a partial update on every layer, and removal only when asked.

FalkorDB used to SET ``r.properties`` to the request's bag, so editing one property of an edge
dropped every other; there was no way to remove one at all. Each layer now applies the same
patch: ``properties`` sets, ``unsetProperties`` removes, the rest is kept.
"""
import json
from typing import Any, Dict, List

import pytest

from backend.app.providers import versioned_write_provider as vwp
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import GraphEdge, UpdateEdgeRequest
from backend.common.property_patch import PROP_DELETE, InvalidPatch


class _RecordingProvider:
    """Only what ``ContextEngine.update_edge`` touches."""

    def __init__(self):
        self.calls: List[tuple] = []

    async def update_edge(self, edge_id, properties):
        self.calls.append((edge_id, properties))
        return GraphEdge(id=edge_id, sourceUrn="a", targetUrn="b", edgeType="FLOWS_TO", properties={})


# ── the request model + the engine ─────────────────────────────────────────────
def test_request_accepts_unset_properties_by_alias():
    req = UpdateEdgeRequest.model_validate({"properties": {"a": 1}, "unsetProperties": ["b"]})
    assert req.unset_properties == ["b"]
    assert UpdateEdgeRequest.model_validate({}).unset_properties == []


@pytest.mark.asyncio
async def test_engine_turns_unset_into_the_provider_patch():
    provider = _RecordingProvider()
    engine = ContextEngine(provider=provider)
    res = await engine.update_edge(
        "e1", UpdateEdgeRequest.model_validate({"properties": {"a": 1}, "unsetProperties": ["b"]}))
    assert res.success
    assert provider.calls == [("e1", {"a": 1, "b": PROP_DELETE})]


@pytest.mark.asyncio
async def test_engine_refuses_a_contradictory_patch_before_any_write():
    provider = _RecordingProvider()
    engine = ContextEngine(provider=provider)
    with pytest.raises(InvalidPatch):
        await engine.update_edge(
            "e1", UpdateEdgeRequest.model_validate({"properties": {"a": 1}, "unsetProperties": ["a"]}))
    assert provider.calls == []


# ── FalkorDB: read, patch, write back ──────────────────────────────────────────
class _Result:
    def __init__(self, rows):
        self.result_set = rows


def _falkor(stored: Dict[str, Any] | None):
    """A FalkorDB provider whose `_query` plays one edge with ``stored`` as its JSON bag."""
    provider = FalkorDBProvider.__new__(FalkorDBProvider)
    state = {"props": None if stored is None else json.dumps(stored), "queries": []}

    async def _ensure_connected():
        return None

    async def _query(cypher, params=None, **_):
        state["queries"].append(cypher)
        if state["props"] is None:
            return _Result([])
        if "SET r.properties" in cypher:
            state["props"] = params["props"]
            return _Result([["a", "b", "FLOWS_TO", {"id": params["eid"], "properties": state["props"]}]])
        return _Result([[state["props"]]])

    provider._ensure_connected = _ensure_connected
    provider._query = _query
    return provider, state


@pytest.mark.asyncio
async def test_falkordb_patch_keeps_unnamed_properties_and_removes_marked_ones():
    provider, state = _falkor({"a": 1, "b": 2, "c": 3})
    edge = await provider.update_edge("e1", {"b": 20, "c": PROP_DELETE, "d": 4})
    assert json.loads(state["props"]) == {"a": 1, "b": 20, "d": 4}
    assert edge.properties == {"a": 1, "b": 20, "d": 4}
    assert PROP_DELETE not in state["props"]


@pytest.mark.asyncio
async def test_falkordb_missing_edge_is_none_and_writes_nothing():
    provider, state = _falkor(None)
    assert await provider.update_edge("e1", {"a": 1}) is None
    assert not any("SET" in q for q in state["queries"])


# ── versioned branch provider: commits the patch, answers with the result ──────
class _BranchSvc:
    def __init__(self, cur):
        self.cur = cur
        self.applied: List[dict] = []

    async def entity_value(self, *, graph_id, entity_id, branch_id=None):
        return self.cur

    async def apply_ops(self, **kw):
        self.applied.extend(kw["ops"])
        return "c1"


@pytest.mark.asyncio
async def test_branch_provider_commits_the_patch_and_returns_the_patched_edge():
    svc = _BranchSvc({"sourceEntityId": "a", "targetEntityId": "b", "edgeType": "FLOWS_TO",
                      "confidence": 0.5, "properties": {"a": 1, "b": 2}})
    provider = VersionedBranchProvider(svc, graph_id="g", branch_id="br")
    edge = await provider.update_edge("e1", {"b": PROP_DELETE, "c": 3})
    assert svc.applied == [{"op": "update", "entity_kind": "edge", "entity_id": "e1",
                            "payload": {"properties": {"b": PROP_DELETE, "c": 3}}}]
    assert edge.properties == {"a": 1, "c": 3}              # the marker is never echoed
    assert (edge.source_urn, edge.target_urn, edge.edge_type) == ("a", "b", "FLOWS_TO")


@pytest.mark.asyncio
async def test_branch_provider_missing_edge_is_none():
    svc = _BranchSvc(None)
    assert await VersionedBranchProvider(svc, graph_id="g", branch_id="br").update_edge("e1", {"a": 1}) is None
    assert svc.applied == []


# ── versioned write-through: records the patch, forwards the same patch ────────
class _WriteSvc(_BranchSvc):
    async def entity_value(self, *, graph_id, entity_id, branch_id=None):
        return self.cur


@pytest.mark.asyncio
async def test_write_through_records_and_forwards_the_same_patch(monkeypatch):
    async def _flag_on():
        return None
    monkeypatch.setattr(vwp, "_require_versioning_flag", _flag_on)
    inner = _RecordingProvider()
    svc = _WriteSvc({"edgeType": "FLOWS_TO", "properties": {"a": 1}})
    provider = vwp.VersionedWriteProvider(inner, workspace_id="ws", data_source_id="ds", actor="u", svc=svc)
    provider._gid = "g"
    await provider.update_edge("e1", {"a": PROP_DELETE})
    assert svc.applied == [{"op": "update", "entity_kind": "edge", "entity_id": "e1",
                            "payload": {"properties": {"a": PROP_DELETE}}}]
    assert inner.calls == [("e1", {"a": PROP_DELETE})]
