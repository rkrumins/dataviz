"""The projector never destroys a FalkorDB graph the platform did not create.

A versioned graph pinned to a data source's own FalkorDB graph (``owns_falkor_graph`` false)
shares that key with whatever the source put there. So:

* a reconcile into such a key deletes neither its urn-less nodes nor the extra copies of a
  relationship — what the version log never held is not the log's to remove;
* a full replay that would delete more than half of what the key holds is refused
  (``SeedRefused``): the watermark is held back, the error is recorded, nothing raises;
* nothing projects into a graph whose "enable version control" job is unfinished, or into a
  tombstoned graph's retained pin;
* eviction considers only keys the platform minted, of live graphs past genesis, with no
  unfinished bootstrap — one predicate, correlated to the row being evicted;
* a bootstrap onto a key another versioned graph already projects into is a 409
  ``graph_key_in_use``.

Pure unit tests — no Postgres, no FalkorDB (fakes in the style of
``test_projection_cancellation_unit.py``).
"""
import asyncio
import contextlib
from types import SimpleNamespace

import pytest
from sqlalchemy import update
from sqlalchemy.dialects import postgresql

from backend.app.services.versioning import bootstrap_worker, projection
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.projection_reconcile import (
    ActualEdge, ActualNode, ExpectedEdge, ExpectedNode,
)
from backend.app.services.versioning.service import ConcurrencyError

_UNKEYED_DELETE = "WHERE id(n) = i DETACH DELETE"


class _Client:
    """Records every query the projector sends."""

    def __init__(self):
        self.queries = []

    async def query(self, cypher, params=None, **_kw):
        self.queries.append(cypher)
        return SimpleNamespace(result_set=[])

    async def delete(self):
        self.queries.append("<GRAPH.DELETE>")


class _PS:
    def __init__(self, projected=0, target=2, owns=False):
        self.status = "idle"
        self.last_error = None
        self.projected_commit_seq = projected
        self.target_commit_seq = target
        self.falkor_graph_name = "customer_graph"
        self.falkor_provider = None
        self.owns_falkor_graph = owns
        self.last_projected_at = None
        self.progress_done = None
        self.progress_total = None


class _Graph:
    id = "g1"
    data_source_id = "ds1"
    workspace_id = "ws1"
    fork_parent_graph_id = None
    deleted_at = None


class _Session:
    def __init__(self, ps, graph, bootstrap_status=None):
        self._ps, self._graph, self._bootstrap = ps, graph, bootstrap_status

    async def get(self, model, key):
        return {ProjectionStateORM: self._ps, GraphORM: self._graph}[model]

    async def scalar(self, clause):
        sql = str(clause)
        if "pg_try_advisory_lock" in sql:
            return True
        assert "jobs" in sql, sql                         # the not-bootstrapping check
        return self._bootstrap

    async def execute(self, clause):
        assert "pg_advisory_unlock" in str(clause), str(clause)


def _projector(ps=None, graph=None, bootstrap_status=None, client=None):
    ps, graph, client = ps or _PS(), graph or _Graph(), client or _Client()

    @contextlib.asynccontextmanager
    async def session():
        yield _Session(ps, graph, bootstrap_status)

    return FalkorProjector(graph_client_factory=lambda name, provider_id=None: client,
                           session_factory=session), ps, client


def _node(i):
    return ExpectedNode(entity_id=f"e{i}", ref=("node", "g1", f"v{i}"), fp=i)


def _edge(i):
    return ExpectedEdge(entity_id=f"r{i}", ref=("edge", "g1", f"w{i}"), fp=i)


def _key(i):
    return ("Dataset", f"urn:{i}")


def _stub_reconcile(monkeypatch, proj, *, expected=({}, {}), actual=({}, {}, set(), [])):
    """The reconcile's reads: Postgres says ``expected`` (nodes, edges); FalkorDB holds
    ``actual`` (nodes, edges, parallel edge keys, urn-less internal ids). Records the writes."""
    writes = {"node_deletes": [], "edge_key_deletes": []}
    exp_nodes, exp_edges = expected
    act_nodes, act_edges, parallel, unkeyed = actual

    async def expected_projection(s, graph, main_id, to_seq, level_map):
        return exp_nodes, exp_edges, {}

    async def scan(client):
        return ({k: ActualNode(fp=fp) for k, fp in act_nodes.items()},
                {k: 1 for k in act_nodes},
                {k: ActualEdge(fp=fp) for k, fp in act_edges.items()},
                set(parallel), list(unkeyed))

    async def payloads(s, refs):
        return {r[2]: {"displayName": r[2]} for r in refs}

    async def apply(client, node_upserts, edge_upserts, node_deletes, edge_deletes, **_kw):
        writes["node_deletes"] += list(node_deletes)

    async def delete_edges_by_key(client, keys, progress=None):
        writes["edge_key_deletes"] += list(keys)

    monkeypatch.setattr(proj, "_expected_projection", expected_projection)
    monkeypatch.setattr(proj, "_scan_projection", scan)
    monkeypatch.setattr(proj._svc, "_payloads_by_version", payloads)
    monkeypatch.setattr(proj, "_apply", apply)
    monkeypatch.setattr(proj, "_delete_edges_by_key", delete_edges_by_key)
    return writes


def _reconcile(proj, client, **kw):
    return asyncio.run(proj._reconcile_in_place(client, "g1", "main1", 2, False, {}, **kw))


# ── the in-place reconcile ──────────────────────────────────────────────

def test_unkeyed_nodes_survive_reconcile_of_unowned_key(monkeypatch):
    proj, _, client = _projector()
    _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                    actual=({_key(1): 1}, {}, set(), [7, 8]))
    _reconcile(proj, client, owned=False)
    assert not any(_UNKEYED_DELETE in q for q in client.queries), client.queries


def test_parallel_edges_survive_reconcile_of_unowned_key(monkeypatch):
    proj, _, client = _projector()
    e = ("Dataset", "urn:1", "FLOWS_TO", "Dataset", "urn:2")
    writes = _stub_reconcile(
        monkeypatch, proj, expected=({_key(1): _node(1), _key(2): _node(2)}, {e: _edge(5)}),
        actual=({_key(1): 1, _key(2): 2}, {e: 5}, {e}, []))
    _reconcile(proj, client, owned=False)
    assert e not in writes["edge_key_deletes"], writes


def test_owned_key_still_clears_unkeyed(monkeypatch):
    # Regression guard (passes before the change): a key the platform minted keeps today's rule.
    proj, _, client = _projector()
    _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                    actual=({_key(1): 1}, {}, set(), [7]))
    _reconcile(proj, client)
    assert any(_UNKEYED_DELETE in q for q in client.queries), client.queries


def test_seed_refused_when_expected_empty(monkeypatch):
    proj, _, client = _projector()
    writes = _stub_reconcile(monkeypatch, proj,
                             actual=({_key(1): 1, _key(2): 2, _key(3): 3}, {}, set(), []))
    with pytest.raises(projection.SeedRefused, match="3 of 3"):
        _reconcile(proj, client, owned=False)
    assert client.queries == [] and writes["node_deletes"] == []


def test_seed_refused_over_half_but_allowed_at_half(monkeypatch):
    proj, _, client = _projector()
    _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                    actual=({_key(1): 1, _key(2): 2, _key(3): 3}, {}, set(), []))
    with pytest.raises(projection.SeedRefused):
        _reconcile(proj, client, owned=False)             # 2 of 3

    proj, _, client = _projector()
    writes = _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                             actual=({_key(1): 1, _key(2): 2}, {}, set(), []))
    _reconcile(proj, client, owned=False)                 # 1 of 2: allowed
    assert writes["node_deletes"] == [("urn:2", "Dataset")]


# ── project_graph ───────────────────────────────────────────────────────

def _stub_window(monkeypatch, proj, reconcile):
    async def main_branch_id(s, graph_id):
        return "main1"

    async def no_level_map(graph_id):
        return {}

    async def not_interrupted(client):
        return False

    monkeypatch.setattr(proj._svc, "_main_branch_id", main_branch_id)
    monkeypatch.setattr(proj, "_resolve_level_map", no_level_map)
    monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
    monkeypatch.setattr(projection, "reconcile_interrupted", not_interrupted)


def test_full_seed_refusal_holds_watermark(monkeypatch):
    proj, ps, _ = _projector(ps=_PS(projected=0, target=2))
    calls = []

    async def refusing(*a, **kw):
        calls.append(kw.get("owned"))
        raise projection.SeedRefused("refusing to delete 3 of 3 entities")

    _stub_window(monkeypatch, proj, refusing)
    r = asyncio.run(proj.project_graph("g1"))
    assert "refusing" in r["verify_error"] and r["projected"] == 0, r
    assert calls == [False]
    assert ps.projected_commit_seq == 0 and ps.target_commit_seq == 0
    assert ps.status == "idle" and "refusing" in ps.last_error

    again = asyncio.run(proj.project_graph("g1"))       # held back: later polls are no-ops
    assert again["noop"] is True and calls == [False], again


def test_full_seed_skipped_while_bootstrapping(monkeypatch):
    proj, ps, client = _projector(bootstrap_status="pending")
    calls = []

    async def reconcile(*a, **kw):
        calls.append(1)

    _stub_window(monkeypatch, proj, reconcile)
    r = asyncio.run(proj.project_graph("g1"))
    assert r == {"projected": 0, "applied": 0, "noop": True, "skipped": "bootstrapping"}, r
    assert calls == [] and client.queries == [] and ps.status == "idle"


def test_incremental_window_skipped_while_bootstrapping(monkeypatch):
    proj, ps, client = _projector(ps=_PS(projected=1, target=2), bootstrap_status="failed")
    _stub_window(monkeypatch, proj, None)
    r = asyncio.run(proj.project_graph("g1"))
    assert r["skipped"] == "bootstrapping" and client.queries == [], r


def test_tombstoned_graph_is_not_projected(monkeypatch):
    graph = _Graph()
    graph.deleted_at = "2026-10-17T00:00:00Z"
    proj, ps, client = _projector(graph=graph)
    _stub_window(monkeypatch, proj, None)
    r = asyncio.run(proj.project_graph("g1"))
    assert r == {"projected": 0, "applied": 0, "noop": True, "skipped": "deleted"}, r
    assert client.queries == [] and ps.status == "idle"


def test_project_pending_skips_tombstoned_graphs():
    seen = []

    class _Result:
        def scalars(self):
            return SimpleNamespace(all=lambda: [])

    class _S:
        async def execute(self, stmt):
            seen.append(str(stmt.compile(dialect=postgresql.dialect())))
            return _Result()

    @contextlib.asynccontextmanager
    async def session():
        yield _S()

    proj = FalkorProjector(graph_client_factory=lambda *a, **k: None, session_factory=session)
    assert asyncio.run(proj.project_pending()) == []
    assert "graphs.deleted_at IS NULL" in seen[0], seen[0]


# ── the bounded heal ────────────────────────────────────────────────────

def test_heal_of_unowned_key_never_deletes_and_never_raises(monkeypatch):
    proj, _, client = _projector()
    # Postgres holds 3, FalkorDB 1 keyed + 2 urn-less: the incremental window's heal reconciles,
    # and that reconcile would delete 2 of 3 — refused, recorded, not raised.
    _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                    actual=({_key(1): 1, _key(2): 2, _key(3): 3}, {}, set(), [7]))

    async def pg_counts(*a):
        return (3, 0)

    async def falkor_counts(client, owned=True):
        return (1, 0)

    monkeypatch.setattr(proj, "_pg_live_counts", pg_counts)
    monkeypatch.setattr(proj, "_falkor_counts", falkor_counts)
    err, healed = asyncio.run(proj._verify_and_heal(client, "g1", "main1", 1, 2, False, owned=False))
    assert err.startswith("projection heal reconcile failed"), err
    assert not any(_UNKEYED_DELETE in q for q in client.queries), client.queries


# ── eviction ────────────────────────────────────────────────────────────

def test_evictable_is_one_correlated_predicate():
    from backend.app.services.versioning.cache_manager import _evictable

    sql = str(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == "g1", *_evictable())
              .values(status="evicted").compile(dialect=postgresql.dialect()))
    where = sql.split(" WHERE ", 1)[1]
    assert "owns_falkor_graph IS true" in where, sql
    subqueries = where.split("EXISTS")[1:]
    assert len(subqueries) == 2, sql
    for sub in subqueries:                       # correlated to the row being evicted, not free
        assert "projection_state.graph_id" in sub, sub
        assert "FROM projection_state" not in sub, sub
    assert "graphs.deleted_at IS NULL" in where and "graphs.main_head_commit_seq >" in where, sql
    assert "NOT (EXISTS" in where and "jobs.job_type" in where, sql


# ── enabling version control onto a key already in use ──────────────────

def test_bootstrap_onto_a_key_in_use_is_graph_key_in_use(monkeypatch):
    class _S:
        async def execute(self, stmt):
            return SimpleNamespace(scalars=lambda: SimpleNamespace(first=lambda: None))

    @contextlib.asynccontextmanager
    async def session():
        yield _S()

    async def refuse(self, **kw):
        raise ConcurrencyError("another versioned data source already projects into this graph")

    monkeypatch.setattr(bootstrap_worker.db, "graphver_session", session)
    monkeypatch.setattr(bootstrap_worker.GraphVersioningService, "create_graph", refuse)
    with pytest.raises(bootstrap_worker.BootstrapConflict) as caught:
        asyncio.run(bootstrap_worker.create_bootstrap_job(
            data_source_id="ds2", workspace_id="ws1", actor="u1", falkor_graph_name="shared"))
    assert caught.value.detail["type"] == "graph_key_in_use"
