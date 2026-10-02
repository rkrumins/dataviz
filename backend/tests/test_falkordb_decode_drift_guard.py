"""A label-anchored read never returns rows decoded with a dead graph's catalogue.

``MATCH (n:Layer)`` guarantees Layer is among n's labels. A row that comes back
WITHOUT any of the labels it was matched on was decoded through id tables loaded
from a graph since dropped and written again (graph_generation) — the wizard's
top level then listed types the ontology never declared ('domain', 'schemaField').
The provider forgets its tables and reads once more; still stale means the graph
is being rewritten under the read, which is a retryable 503, never a cached answer.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.adapters import ProviderLoading
from backend.common.models.graph import NodeQuery


class _Result:
    def __init__(self, result_set):
        self.result_set = result_set


def _row(labels, urn="urn:1", name="One"):
    return [SimpleNamespace(labels=labels, properties={"urn": urn, "displayName": name}), 0]


def _make_provider(*answers):
    """A flat-graph provider whose reads answer ``answers`` in turn (the last one
    repeats); counts become 1. Records every read and every forget."""
    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0
    p._redis = None

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    p._resolved_containment_types = set()
    p._resolved_containment_types_set = True
    p.reads, p.forgets = [], 0
    queue = list(answers)

    async def _ro_query(cypher, params=None, **kw):
        if "count(" in cypher:
            return _Result([[1]])
        p.reads.append((cypher, dict(params or {})))
        return _Result(queue.pop(0) if len(queue) > 1 else queue[0])

    p._ro_query = _ro_query
    forget = p._forget_graph_state

    def _spy():
        p.forgets += 1
        forget()

    p._forget_graph_state = _spy
    return p


async def test_a_stale_top_level_page_is_read_again_with_fresh_tables():
    p = _make_provider([_row(["schemaField"])], [_row(["Layer"])])
    res = await p.get_top_level_or_orphan_nodes(entity_types=["Layer"])
    assert (p.forgets, len(p.reads)) == (1, 2)
    assert [n.entity_type for n in res.nodes] == ["Layer"]


async def test_a_multi_label_node_carries_its_anchor_and_passes():
    p = _make_provider([_row(["Entity", "Layer"])])
    res = await p.get_top_level_or_orphan_nodes(entity_types=["Layer"])
    assert (p.forgets, len(p.reads)) == (0, 1)
    assert len(res.nodes) == 1


async def test_a_page_still_stale_after_the_re_read_is_a_retryable_503():
    p = _make_provider([_row(["schemaField"])])
    with pytest.raises(ProviderLoading) as exc:
        await p.get_top_level_or_orphan_nodes(entity_types=["Layer"])
    assert exc.value.retry_after_seconds == 1
    assert (p.forgets, len(p.reads)) == (1, 2)


async def test_an_unanchored_top_level_read_is_not_checked():
    p = _make_provider([_row(["schemaField"])])
    await p.get_top_level_or_orphan_nodes(entity_types=None)
    assert (p.forgets, len(p.reads)) == (0, 1)


async def test_a_stale_type_page_is_read_again_with_fresh_tables():
    p = _make_provider([_row(["schemaField"])], [_row(["Layer"])])
    nodes = await p.get_nodes(NodeQuery(entityTypes=["Layer"]))
    assert (p.forgets, len(p.reads)) == (1, 2)
    assert [n.entity_type for n in nodes] == ["Layer"]


async def test_a_stale_urn_bucket_is_read_again_and_the_residue_is_not_checked():
    p = _make_provider()
    seen = []

    async def _buckets(urns):
        return [("Layer", ["urn:u"]), ("", ["urn:v"])]

    async def _ro_query(cypher, params=None, **kw):
        anchored = cypher.startswith("MATCH (n:Layer)")
        seen.append(anchored)
        if anchored:
            # Stale on the first read, fresh on the second.
            return _Result([_row(["schemaField" if seen.count(True) == 1 else "Layer"], "urn:u", "U")])
        # The unanchored residue: any labels at all, never a reason to re-read.
        return _Result([_row(["Whatever"], "urn:v", "V")])

    p._label_buckets = _buckets
    p._ro_query = _ro_query
    nodes = await p.get_nodes(NodeQuery(urns=["urn:u", "urn:v"]))
    assert p.forgets == 1
    assert seen.count(True) == 2 and seen.count(False) == 2      # one re-read of the gather
    assert {n.urn: n.entity_type for n in nodes} == {"urn:u": "Layer", "urn:v": "Whatever"}
