"""What a projection pass holds in quarantine (``projection_quarantine``), and the edges that wait
for a held node.

Pins:
- An edge one of whose end nodes the pass holds, and the key lacks, is held with it rather than
  sent, where it would match nothing: every such edge of a chunk in one write, with one
  ``quarantine_next_at`` update. An edge to a held node the key holds (its own update held) is
  sent, as is every other.
- What a pass holds is looked up, never scanned: a chunk that lands, and an edge chunk, cost their
  own size, however much the pass holds.

Pure unit tests — no Postgres, no FalkorDB.
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from backend.app.services.versioning.projection import FalkorProjector, _Held, _PASS_HELD


class _Store:
    """The quarantine's Postgres side: each statement a session executes, with its rows."""

    def __init__(self):
        self.executed = []

    @contextlib.asynccontextmanager
    async def session(self):
        yield self

    async def execute(self, stmt, rows=None):
        self.executed.append((stmt, rows))
        return SimpleNamespace(first=lambda: (1,), rowcount=len(rows or ()))


class _Key:
    """A key holding the nodes ``present`` under ``Dataset``; it records the edges merged."""

    def __init__(self, present):
        self.present, self.merged = set(present), []

    async def query(self, cypher, params=None, timeout=None):
        params = params or {}
        if cypher.endswith("RETURN u, n.gvHash"):
            return SimpleNamespace(result_set=[[u, "fp"] for u in params["urns"]
                                               if u in self.present])
        if "MERGE (a)-[r:" in cypher:
            self.merged.extend(item["eid"] for item in params["batch"])
            return SimpleNamespace(result_set=[[len(params["batch"])]])
        return SimpleNamespace(result_set=[])


class _NoScan(set):
    """What a pass holds, which may be looked up and added to but never iterated."""

    def __iter__(self):
        raise AssertionError("what the pass holds was scanned")


def _edge(eid, src, tgt):
    return (eid, src, tgt, {"edgeType": "FLOWS"}, "Dataset", "Dataset")


_EDGES = [_edge("PC1", "urn:p", "urn:c1"), _edge("PC2", "urn:p", "urn:c2"),
          _edge("CP", "urn:c3", "urn:p"), _edge("YX", "urn:y", "urn:x"),
          _edge("AB", "urn:a", "urn:b")]


@pytest.fixture()
def held():
    """A pass that holds P (a new node, not in the key) and X (in the key, its update held)."""
    h = _Held("g1")
    token = _PASS_HELD.set(h)
    h.keys.update({("node", "urn:p"), ("node", "urn:x")})
    yield h
    _PASS_HELD.reset(token)


async def test_an_edge_to_a_held_node_the_key_lacks_is_held_with_it_in_one_write(held):
    store, key = _Store(), _Key({"urn:x", "urn:y", "urn:a", "urn:b", "urn:c1", "urn:c2", "urn:c3"})
    p = FalkorProjector(graph_client_factory=lambda *_a: key, session_factory=store.session,
                        batch_size=50)
    assert await p._apply(key, [], _EDGES, [], []) == 0
    assert key.merged == ["YX", "AB"], key.merged
    inserts = [rows for stmt, rows in store.executed if stmt.is_insert]
    assert [sorted(r["entity_key"] for r in rows) for rows in inserts] == [[
        "CP@FLOWS:urn:c3->urn:p", "PC1@FLOWS:urn:p->urn:c1", "PC2@FLOWS:urn:p->urn:c2"]], inserts
    assert all(r["params"]["batch"][0]["eid"] in r["entity_key"] and len(r["params"]["batch"]) == 1
               and "end node is held" in r["error"] for r in inserts[0]), inserts
    assert sum(stmt.is_update for stmt, _rows in store.executed) == 1     # quarantine_next_at
    assert {("edge", "PC1@FLOWS:urn:p->urn:c1"), ("node", "urn:x")} <= held.keys


async def test_what_a_pass_holds_is_looked_up_never_scanned(held):
    held.keys = _NoScan(held.keys)
    store, key = _Store(), _Key({"urn:x", "urn:y", "urn:a", "urn:b"})
    p = FalkorProjector(graph_client_factory=lambda *_a: key, session_factory=store.session,
                        batch_size=50)
    await p._apply(key, [], _EDGES, [], [])
    assert key.merged == ["YX", "AB"], key.merged
    await p._release("edge_merge", [{"eid": "PC1", "rel": "FLOWS", "src": "urn:p",
                                     "tgt": "urn:c1"}])
    assert ("edge", "PC1@FLOWS:urn:p->urn:c1") not in held.keys and ("node", "urn:p") in held.keys
