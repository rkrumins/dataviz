"""An export's plan answers within its budget, whatever the graph (``stream.count``, ``plan_export``).

The Export dialog asks for the plan before every export. It counted page by page, but looked at the
clock only between pages, and a whole published graph's head count, the first page of a large layer
and a view's entities ran for as long as they took: on a large graph, a draft, a fork, a past
revision or a view of one, the plan outlasted the gateway in front of the app and came back 504,
every time it was asked. Now the budget covers every read, the one under way included, and what
isn't known by then is unknown (``None``), never waited for.

Pins: a head count, a first page or a view's entities that don't come back in time leave the counts
unknown, at the budget; pages keep being counted until it runs out; a count that fits is exact; a
timeout that isn't the budget's is raised, not taken for unknown counts; and the route answers
within the budget with the view's contribution and its emptiness unknown. The snapshot is faked at
its read boundary; integration/test_export_stream.py counts real ones.
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from backend.app.api.v1.endpoints import versioning
from backend.app.services.versioning.import_export import snapshot as snapshot_module
from backend.app.services.versioning.import_export import stream
from backend.app.services.versioning.import_export.snapshot import Winner

BUDGET = 0.3
#: Long enough for an answer at the budget, short enough that a read waited for fails the test.
PATIENCE = 5.0


async def _never():
    await asyncio.Event().wait()


def node(eid: str, etype: str = "Table") -> Winner:
    return Winner(eid, True, f"v_{eid}", "g1", f"h_{eid}", urn=f"urn:{eid}", entity_type=etype,
                  payload=json.dumps({"entityType": etype}))


def edge(eid: str, src: str, tgt: str) -> Winner:
    return Winner(eid, True, f"v_{eid}", "g1", f"h_{eid}", source_id=src, target_id=tgt, edge_type="LINEAGE")


class _Snap:
    """A snapshot whose reads take as long as they are told to: ``hang`` names the ones that never
    come back (``heads``, ``first_page``, ``descendants``); ``endless`` serves pages forever."""

    page_size = 2
    as_of_seq, branch_id = 7, "br_main"

    def __init__(self, nodes=(), edges=(), *, hang=(), heads=None, endless=False) -> None:
        self._by = {"node": {w.entity_id: w for w in nodes}, "edge": {w.entity_id: w for w in edges}}
        self._hang, self._heads, self._endless = set(hang), heads, endless

    async def head_counts(self):
        if "heads" in self._hang:
            await _never()
        return self._heads

    async def iter_live(self, kind, payload=False, limit=None):
        if "first_page" in self._hang:
            await _never()
        if self._endless:
            i = 0
            while True:
                await asyncio.sleep(0.01)
                yield [node(f"n{i}"), node(f"n{i + 1}")] if kind == "node" else [edge(f"e{i}", "a", "b")]
                i += 2
        rows = sorted(self._by[kind].values(), key=lambda w: w.entity_id)
        for i in range(0, len(rows), self.page_size):
            yield rows[i:i + self.page_size]

    async def lookup_live(self, kind, entity_ids, payload=False):
        return {eid: self._by[kind][eid] for eid in entity_ids if eid in self._by[kind]}

    async def nodes_by_urn(self, urns):
        urns = set(urns)
        return {w.urn: w.entity_id for w in self._by["node"].values() if w.urn in urns}

    async def containment_descendants(self, roots, containment_types):
        if "descendants" in self._hang:
            await _never()
        return set()


async def _timed(coro):
    """``coro``'s answer and how long it took; fails the test if it isn't back in ``PATIENCE``."""
    t = time.monotonic()
    out = await asyncio.wait_for(coro, PATIENCE)
    return out, time.monotonic() - t


UNKNOWN = {"nodes": None, "edges": None, "exact": False, "seen": 0}


async def test_a_head_count_that_does_not_come_back_in_time_leaves_the_counts_unknown():
    out, took = await _timed(stream.count(_Snap(hang={"heads"}), stream.Selection.of(), budget_s=BUDGET))
    assert out == UNKNOWN
    assert BUDGET <= took < BUDGET + 0.5, took


async def test_a_first_page_that_does_not_come_in_time_leaves_the_counts_unknown():
    # A draft, a fork or a past revision has no head count: its first page is the first read.
    out, took = await _timed(stream.count(_Snap(hang={"first_page"}), stream.Selection.of(), budget_s=BUDGET))
    assert out == UNKNOWN
    assert took < BUDGET + 0.5, took
    # A selection is counted page by page even on a published graph.
    out, _ = await _timed(stream.count(_Snap(hang={"first_page"}, heads={"node": 9, "edge": 9}),
                                       stream.Selection.of(types=["Table"]), budget_s=BUDGET))
    assert out == UNKNOWN


async def test_pages_are_counted_until_the_budget_runs_out():
    out, took = await _timed(stream.count(_Snap(endless=True), stream.Selection.of(), budget_s=BUDGET))
    assert out["nodes"] is None and out["edges"] is None and out["exact"] is False
    assert out["seen"] > 0, "what was counted by then says the export isn't empty"
    assert took < BUDGET + 0.5, took


async def test_a_count_that_fits_the_budget_is_exact():
    snap = _Snap([node("a"), node("b"), node("c", "Column")], [edge("ab", "a", "b"), edge("bc", "b", "c")])
    assert await stream.count(snap, stream.Selection.of(), budget_s=BUDGET) == {"nodes": 3, "edges": 2, "exact": True}
    assert await stream.count(snap, stream.Selection.of(types=["table"]), budget_s=BUDGET) == {
        "nodes": 2, "edges": 1, "exact": True}
    published = _Snap(heads={"node": 5, "edge": 4})
    assert await stream.count(published, stream.Selection.of(), budget_s=BUDGET) == {"nodes": 5, "edges": 4, "exact": True}


async def test_a_timeout_that_is_not_the_budgets_is_raised():
    class _PoolTimedOut(_Snap):
        async def head_counts(self):
            raise TimeoutError("no connection came free")

    with pytest.raises(TimeoutError, match="no connection"):
        await stream.count(_PoolTimedOut(), stream.Selection.of(), budget_s=BUDGET)


async def test_a_view_too_large_to_resolve_in_time_is_unknown():
    scope = {"assigned_urns": ["urn:a", "urn:b"], "inherit_urns": ["urn:a"], "containment_types": ["CONTAINS"]}
    snap = _Snap([node("a"), node("b")], hang={"descendants"})
    out, took = await _timed(stream.view_entities(snap, scope, budget_s=BUDGET))
    assert out is None and took < BUDGET + 0.5, (out, took)
    # Without a budget (the export itself) it is found, however long that takes.
    found = await stream.view_entities(_Snap([node("a"), node("b")]), scope)
    assert found == {"keep": {"a", "b"}, "placed": 2, "found": 2}


async def _plan(monkeypatch, snap, *, view_id=None, scope=None):
    """``plan_export`` over ``snap``, with the access check passed and the view's design ``scope``."""
    async def _allowed(*args, **kwargs):
        return None

    async def _open(**kwargs):
        return snap

    async def _scope(*args, **kwargs):
        return scope

    monkeypatch.setattr(stream, "PLAN_BUDGET_S", BUDGET)
    monkeypatch.setattr(versioning, "_check_export_access", _allowed)
    monkeypatch.setattr(versioning, "_view_export_scope", _scope)
    monkeypatch.setattr(snapshot_module, "open_snapshot", _open)
    return await _timed(versioning.plan_export(
        ws_id="ws1", graph_id="g1", format="ndjson", as_of_seq=None, view_id=view_id, branch_id=None,
        ids=None, types=None, user=None, claims=None, viewer=None, meta={"data_source_id": "ds1"},
        session=None, svc=None))


async def test_the_plan_answers_within_its_budget_whatever_it_waits_on(monkeypatch):
    plan, took = await _plan(monkeypatch, _Snap(hang={"heads"}))
    assert took < BUDGET + 0.5, took
    assert (plan["nodes"], plan["edges"], plan["exact"], plan["empty"]) == (None, None, False, None)
    assert plan["formatLimit"] is None and plan["asOfSeq"] == 7

    # A view whose entities take too long to find: what it places is known, the rest isn't.
    scope = {"assigned_urns": ["urn:a", "urn:b", "urn:a"], "inherit_urns": ["urn:a"], "containment_types": ["CONTAINS"]}
    plan, took = await _plan(monkeypatch, _Snap([node("a"), node("b")], hang={"descendants"}),
                             view_id="v1", scope=scope)
    assert took < BUDGET + 0.5, took
    assert plan["view"] == {"viewId": "v1", "placements": 2, "found": None, "entities": None}
    assert (plan["nodes"], plan["edges"], plan["empty"]) == (None, None, None)

    # Found in time, it is counted in what is left of the budget.
    plan, _ = await _plan(monkeypatch, _Snap([node("a"), node("b"), node("c")], [edge("ab", "a", "b")]),
                          view_id="v1", scope=scope)
    assert plan["view"] == {"viewId": "v1", "placements": 2, "found": 2, "entities": 2}
    assert (plan["nodes"], plan["edges"], plan["exact"], plan["empty"]) == (2, 1, True, False)
