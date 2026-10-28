"""A data source whose lineage summaries live in a dedicated key: the projector writes none of
them, and hands every publish that changes lineage or containment to the aggregation job.

In ``dedicated`` mode the aggregation job builds a data source's ``:AGGREGATED`` rollups in a key
of their own (``<graph>_proj``), not in the graph's key the projector writes. So neither a publish
window (``_compute_rollup_deltas``) nor a reconcile (``_reconcile_in_place``) maintains rollups
there — not a cell, not the ``_GVRollupMeta`` bookkeeping. Each answers ``"stale"`` when lineage
or containment changed, which queues the job (``on_rollups_stale``); a change to neither queues
nothing. The edge-type resolver marks such a source with ``"dedicated"``, after its types.

Pure unit tests, on the fakes of ``test_versioning_rollup_canonical`` (4-level containment
chains) and ``test_projection_foreign_key_guard`` (the reconcile's reads and writes).
"""
import asyncio
import contextlib
from types import SimpleNamespace

from backend.app.services.versioning import projection
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.tests import test_projection_foreign_key_guard as fk
from backend.tests.test_versioning_rollup_canonical import _Session, _Svc

_FLOWS = {"sourceEntityId": "a3", "targetEntityId": "b3", "edgeType": "FLOWS"}


async def _dedicated(svc, graph_id):
    return (["CONTAINS"], ["FLOWS"], {}, "dedicated")


async def _in_source(svc, graph_id):
    return (["CONTAINS"], ["FLOWS"], {f"lvl{i}": i for i in range(4)})


def _rollup_queries(queries):
    return [q for q in queries if "AGGREGATED" in q or "_GVRollupMeta" in q]


# ── a publish window ────────────────────────────────────────────────────

class _Before(_Svc):
    """The 4-level chains, and what the window's edges were before it."""

    def __init__(self, before):
        super().__init__()
        self.before = before

    async def _values_at(self, s, gid, bid, ids, seq):
        return {**await super()._values_at(s, gid, bid, ids, seq),
                **{i: self.before[i] for i in ids if i in self.before}}


def _deltas(rows, before=None, resolver=_dedicated):
    p = FalkorProjector(graph_client_factory=lambda name, provider_id=None: None, batch_size=10,
                        edge_types_resolver=resolver)
    p._svc = _Before(before or {})
    return asyncio.run(p._compute_rollup_deltas(_Session(rows), SimpleNamespace(id="g1"),
                                                "main", 1, 2))


def test_a_window_that_changes_lineage_or_containment_is_stale():
    assert _deltas([("e1", "create", _FLOWS)]) == "stale"
    assert _deltas([("e1", "delete", None)], before={"e1": _FLOWS}) == "stale"
    moved = {"sourceEntityId": "b2", "targetEntityId": "a3", "edgeType": "CONTAINS"}
    assert _deltas([("c1", "create", moved)]) == "stale"
    # Regression guard (passes before the change): the same window in a source's own graph is
    # maintained in place, by pairs.
    assert isinstance(_deltas([("e1", "create", _FLOWS)], resolver=_in_source), dict)


def test_a_window_that_changes_neither_answers_nothing():
    # Regression guard (passes before the change): nothing for the job to rebuild.
    reweighed = {**_FLOWS, "weight": 2}
    assert _deltas([("e1", "update", reweighed)], before={"e1": _FLOWS}) is None
    owns = {"sourceEntityId": "a3", "targetEntityId": "b3", "edgeType": "OWNS"}
    assert _deltas([("o1", "create", owns)]) is None
    assert _deltas([]) is None


class _Graphver:
    """The projector's graphver sessions: one graph pinned to its data source's own key, its
    projection one window behind main, and that window's edge versions."""

    def __init__(self, rows):
        self.rows = rows
        self.ps = SimpleNamespace(
            status="idle", last_error=None, projected_commit_seq=1, target_commit_seq=2,
            falkor_graph_name="lineage", falkor_provider=None, owns_falkor_graph=False, epoch=0,
            failed_attempts=0, next_retry_at=None, physical_types=None)
        self.graph = SimpleNamespace(
            id="graph_1", data_source_id="ds_1", workspace_id="ws_1", fork_parent_graph_id=None,
            deleted_at=None, main_head_commit_seq=2)

    async def get(self, model, key):
        return {ProjectionStateORM: self.ps, GraphORM: self.graph}[model]

    async def scalar(self, clause):
        return True if "pg_try_advisory_lock" in str(clause) else None   # not being enabled

    async def execute(self, clause):
        return SimpleNamespace(all=lambda: list(self.rows))


def run_window(monkeypatch, rows, *, before=None, resolver=_dedicated, on_rollups_stale=None):
    """Project one publish window (``rows``: its edge versions) of a graph whose data source
    ``resolver`` describes. Returns what was written to the graph's key."""
    graphver, client = _Graphver(rows), fk._Client()

    @contextlib.asynccontextmanager
    async def session():
        yield graphver

    proj = FalkorProjector(graph_client_factory=lambda name, provider_id=None: client,
                           session_factory=session, edge_types_resolver=resolver,
                           on_rollups_stale=on_rollups_stale)
    chains = _Before(before or {})
    proj._svc._values_at = chains._values_at
    proj._svc._containment_parents_climb = chains._containment_parents_climb

    async def claim(graph_id, seen_epoch, from_seq):
        return seen_epoch + 1, 0

    async def finish(graph_id, mine, *, published, to_seq, error, attempts):
        return True

    async def main_branch_id(s, graph_id):
        return "main"

    async def no_changes(s, graph, main_id, from_seq, to_seq):
        return [], [], [], []

    async def verified(*a, **kw):
        return None, False

    async def not_interrupted(client):
        return False

    proj._claim, proj._finish = claim, finish
    proj._svc._main_branch_id = main_branch_id
    monkeypatch.setattr(proj, "_compute_changes", no_changes)
    monkeypatch.setattr(proj, "_verify_and_heal", verified)
    monkeypatch.setattr(projection, "reconcile_interrupted", not_interrupted)
    out = asyncio.run(proj.project_graph("graph_1"))
    assert out["projected"] == 2, out
    return client.queries


def test_a_window_writes_no_rollup_into_the_graphs_own_key(monkeypatch):
    stale = []

    async def hook(graph_id):
        stale.append(graph_id)

    queries = run_window(monkeypatch, [("e1", "create", _FLOWS)], on_rollups_stale=hook)
    assert _rollup_queries(queries) == [], queries
    assert stale == ["graph_1"]

    queries = run_window(monkeypatch, [("e1", "update", {**_FLOWS, "weight": 2})],
                         before={"e1": _FLOWS}, on_rollups_stale=hook)
    assert _rollup_queries(queries) == [] and stale == ["graph_1"], "nothing to rebuild"

    # Regression guard (passes before the change): in a source's own graph they are written.
    queries = run_window(monkeypatch, [("e1", "create", _FLOWS)], resolver=_in_source,
                         on_rollups_stale=hook)
    assert _rollup_queries(queries) and stale == ["graph_1"]


# ── a reconcile ─────────────────────────────────────────────────────────

_LINEAGE = ("Dataset", "urn:1", "FLOWS", "Dataset", "urn:2")


def _reconcile(monkeypatch, *, expected_edges, actual_edges, node_fp=1):
    proj, _, client = fk._projector()
    proj._edge_types_resolver = _dedicated
    fk._stub_reconcile(monkeypatch, proj,
                       expected=({fk._key(1): fk._node(1), fk._key(2): fk._node(2)},
                                 expected_edges),
                       actual=({fk._key(1): node_fp, fk._key(2): 2}, actual_edges, set(), []))
    written = []

    async def write_rollup_deltas(*a, **kw):
        written.append(a)
        return True

    monkeypatch.setattr(proj, "_write_rollup_deltas", write_rollup_deltas)
    out = asyncio.run(proj._reconcile_in_place(client, "g1", "main1", 2, False, {}))
    return out, _rollup_queries(client.queries) + written


def test_a_reconcile_that_changes_lineage_is_stale_and_writes_no_rollup(monkeypatch):
    out, rollups = _reconcile(monkeypatch, expected_edges={_LINEAGE: fk._edge(5)},
                              actual_edges={})
    assert out["rollups"] == "stale" and rollups == []
    out, rollups = _reconcile(monkeypatch, expected_edges={},
                              actual_edges={_LINEAGE: 5})
    assert out["rollups"] == "stale" and rollups == []


def test_a_reconcile_that_changes_neither_is_none(monkeypatch):
    out, rollups = _reconcile(monkeypatch, expected_edges={_LINEAGE: fk._edge(5)},
                              actual_edges={_LINEAGE: 5}, node_fp=9)
    assert out["writes"] == 1 and out["rollups"] == "none" and rollups == []
