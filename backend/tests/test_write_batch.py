"""A versioned provider inside a write batch holds its writes for one commit (``write_batch``).

While the batch is open, what a command created can be read back and deleted, as when each write
committed at once. A write that needs its committed answer (an edge's update) commits what the
batch holds with it, in order. Outside a batch, every write commits as it always did.
"""
import pytest

from backend.app.providers import versioned_write_provider as vwp
from backend.app.providers import write_batch
from backend.app.services.versioning.service import ApplyResult
from backend.common.models.graph import GraphEdge, GraphNode


class _Svc:
    def __init__(self):
        self.commits = []

    async def apply_ops_detailed(self, *, ops, message, **_kw):
        self.commits.append((message, [(o["op"], o["entity_id"]) for o in ops]))
        written = {o["entity_id"]: (o["entity_kind"], {"sourceEntityId": "A", "targetEntityId": "B",
                                                       "edgeType": "LINEAGE"}) for o in ops}
        return ApplyResult(commit_id=f"c{len(self.commits)}", written=written)

    async def entity_recorded(self, **_kw):
        return True

    async def resolve_edges(self, *, edge_ids, **_kw):
        return {e: (e, {}) for e in edge_ids if e.startswith("stored")}


class _Inner:
    async def get_node(self, urn):
        return None


@pytest.fixture
def provider(monkeypatch):
    async def none(*_a, **_kw):
        return None
    monkeypatch.setattr(vwp, "_require_versioning_flag", none)
    monkeypatch.setattr(vwp, "nudge_projection", none)
    p = vwp.VersionedWriteProvider(_Inner(), workspace_id="ws", data_source_id="ds", actor="pat",
                                   svc=_Svc())
    p._gid = "g1"
    return p


def _node(urn):
    return GraphNode(urn=urn, entityType="Table", displayName=urn)


def _edge(eid):
    return GraphEdge(id=eid, sourceUrn="A", targetUrn="B", edgeType="LINEAGE")


async def test_a_batch_is_one_commit_in_order_and_reads_back_what_it_holds(provider):
    with write_batch.deferring() as batch:
        await provider.create_node(_node("A"))
        assert (await provider.get_node("A")).urn == "A"            # held, read back
        await provider.create_edge(_edge("e_new"))
        assert await provider.delete_edge("e_new") is True           # made in this batch: deleted
        assert await provider.delete_edge("stored_e") is True
        assert await provider.delete_edge("ghost") is False          # neither held nor stored
        assert provider._svc.commits == []                           # nothing committed yet
    assert batch.owner is provider
    await provider.commit_deferred(batch.drain(), "batch: 5 commands")
    assert provider._svc.commits == [("batch: 5 commands", [
        ("create", "A"), ("create", "e_new"), ("delete", "e_new"), ("delete", "stored_e")])]
    assert await provider.get_node("A") is None                       # batch closed: read the store


async def test_a_write_that_needs_its_answer_commits_what_the_batch_holds_with_it(provider):
    with write_batch.deferring() as batch:
        await provider.create_node(_node("A"))
        edge = await provider.update_edge("stored_e", {"by": "pat"})
        assert edge is not None and edge.edge_type == "LINEAGE"
        assert provider._svc.commits == [("update edge stored_e", [("create", "A"), ("update", "stored_e")])]
        assert batch.ops == []


async def test_outside_a_batch_every_write_commits_at_once(provider):
    await provider.create_node(_node("A"))
    await provider.create_node(_node("B"))
    assert [m for m, _ in provider._svc.commits] == ["create node A", "create node B"]
