"""The projector never destroys a FalkorDB graph the platform did not create.

A versioned graph pinned to a data source's own FalkorDB graph (``owns_falkor_graph`` false)
shares that key with whatever the source put there. So:

* a reconcile into such a key deletes nothing the version log doesn't hold — urn-less nodes,
  extra copies of a relationship, entities and relationships its other writers put there —
  whatever their share of the key; only what history tombstoned is swept;
* a pass that finds more in such a key than history holds publishes, and hands back how much
  (``external_drift``); a pass whose own edge did not land heals instead; a key the platform
  minted still holds such a pass back, saying what to do;
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
        self.physical_types = {"nodes": {}, "edges": {}}    # recorded: spelled as declared
        self.external_drift = None
        self.last_projected_at = None
        self.progress_done = None
        self.progress_total = None
        self.epoch = 0
        self.failed_attempts = 0
        self.next_retry_at = None


class _Graph:
    id = "g1"
    data_source_id = "ds1"
    workspace_id = "ws1"
    fork_parent_graph_id = None
    deleted_at = None
    main_head_commit_seq = 2


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

    proj = FalkorProjector(graph_client_factory=lambda name, provider_id=None: client,
                           session_factory=session)

    # The fenced writes, applied to the fake row.
    async def claim(graph_id, seen_epoch, from_seq):
        ps.status = "rebuilding" if from_seq <= 0 else "projecting"
        return seen_epoch + 1, ps.failed_attempts

    async def finish(graph_id, mine, *, published, to_seq, error, attempts,
                     surplus=projection._UNCOUNTED):
        ps.status, ps.last_error = "idle", error
        if published:
            ps.projected_commit_seq = to_seq
            if surplus is not projection._UNCOUNTED:
                ps.external_drift = surplus
        elif attempts is not None:
            ps.failed_attempts = attempts + 1
        return True

    proj._claim, proj._finish = claim, finish
    return proj, ps, client


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

    async def small(s, graph_id, main_id):
        return len(exp_nodes) + len(exp_edges)       # reconciled in one pass, not a page at a time

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

    monkeypatch.setattr(proj, "_live_count", small)
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


def _stub_sweep(monkeypatch, proj):
    swept = []

    async def sweep(client, graph_id, main_id):
        swept.append(graph_id)

    monkeypatch.setattr(proj, "_sweep_tombstoned", sweep)
    return swept


def test_a_reconcile_of_a_customer_key_deletes_nothing_history_does_not_hold(monkeypatch):
    """Expected empty, the key holding three entities and a relationship: none of it is deleted,
    whatever its share of the key; what history tombstoned is swept after."""
    proj, _, client = _projector()
    e = ("Dataset", "urn:1", "FLOWS_TO", "Dataset", "urn:2")
    writes = _stub_reconcile(monkeypatch, proj,
                             actual=({_key(1): 1, _key(2): 2, _key(3): 3}, {e: 5}, set(), []))
    swept = _stub_sweep(monkeypatch, proj)
    out = _reconcile(proj, client, owned=False)
    assert writes == {"node_deletes": [], "edge_key_deletes": []}, writes
    assert not any("DETACH DELETE" in q for q in client.queries), client.queries
    assert swept == ["g1"]
    assert out["rollups"] != "applied", "what stays can't be moved out of the rollups by delta"


def test_a_reconcile_of_a_key_the_platform_minted_deletes_what_history_does_not_hold(monkeypatch):
    # Regression guard (passes before the change): the platform's own key keeps today's rule.
    proj, _, client = _projector(ps=_PS(owns=True))
    writes = _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                             actual=({_key(1): 1, _key(2): 2, _key(3): 3}, {}, set(), []))
    swept = _stub_sweep(monkeypatch, proj)
    _reconcile(proj, client)
    assert writes["node_deletes"] == [("urn:2", "Dataset"), ("urn:3", "Dataset")]
    assert swept == []


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


def _stub_counts(monkeypatch, proj, pg, *falkor):
    """Postgres counts ``pg``; FalkorDB answers ``falkor`` in turn (the last one from then on)."""
    seen = list(falkor)

    async def pg_counts(*a):
        return pg

    async def falkor_counts(client, owned=True):
        return seen.pop(0) if len(seen) > 1 else seen[0]

    monkeypatch.setattr(proj, "_pg_live_counts", pg_counts)
    monkeypatch.setattr(proj, "_falkor_counts", falkor_counts)


def test_a_full_seed_of_a_customer_key_holding_more_publishes_and_says_how_much(monkeypatch):
    proj, ps, _ = _projector(ps=_PS(projected=0, target=2))
    calls = []

    async def reconcile(*a, **kw):
        calls.append(kw.get("owned"))
        return {"writes": 0, "rollups": "none"}

    _stub_window(monkeypatch, proj, reconcile)
    _stub_counts(monkeypatch, proj, (1, 0), (3, 1))
    _stub_sweep(monkeypatch, proj)
    r = asyncio.run(proj.project_graph("g1"))
    assert r.get("verify_error") is None and r["projected"] == 2, r
    assert calls == [False]
    assert ps.projected_commit_seq == 2 and ps.external_drift == (2, 1)


def test_a_pass_that_did_not_count_leaves_the_flag_alone(monkeypatch):
    """A pass counts only when its window is main's head (and verify is on, and the counts
    answer). One that didn't neither raises the flag nor clears it: under steady writes most
    passes are such, and the flag would come and go."""
    proj, ps, _ = _projector(ps=_PS(projected=0, target=2))
    ps.external_drift = (2, 1)

    async def reconcile(*a, **kw):
        return {"writes": 0, "rollups": "none"}

    _stub_window(monkeypatch, proj, reconcile)
    _stub_counts(monkeypatch, proj, None, (3, 1))           # the head moved on: not counted
    r = asyncio.run(proj.project_graph("g1"))
    assert r.get("verify_error") is None and r["projected"] == 2, r
    assert ps.external_drift == (2, 1)
    # Regression guard (passes before the change): a pass that counted none clears it.
    _stub_counts(monkeypatch, proj, (1, 0), (1, 0))
    ps.projected_commit_seq = 0
    asyncio.run(proj.project_graph("g1"))
    assert ps.external_drift is None


def test_a_key_the_platform_minted_holding_more_is_held_back_and_says_what_to_do(monkeypatch):
    proj, ps, _ = _projector(ps=_PS(projected=0, target=2, owns=True))

    async def reconcile(*a, **kw):
        return {"writes": 0, "rollups": "none"}

    _stub_window(monkeypatch, proj, reconcile)
    _stub_counts(monkeypatch, proj, (1, 0), (3, 1))
    _stub_sweep(monkeypatch, proj)
    r = asyncio.run(proj.project_graph("g1"))
    assert r["projected"] == 0 and ps.projected_commit_seq == 0, r
    assert "Rebuild replaces it with what history holds" in r["verify_error"], r
    assert "Bring" not in r["verify_error"], "nothing but the projector writes a minted key"
    assert "enablement" not in r["verify_error"], "re-enabling answers 'already enabled'"


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

def test_heal_of_unowned_key_never_deletes(monkeypatch):
    proj, _, client = _projector()
    # Postgres holds 3, FalkorDB 1 keyed + 2 urn-less: the incremental window's heal reconciles,
    # keeping all of it; the shortfall it couldn't write is held back as before.
    writes = _stub_reconcile(monkeypatch, proj, expected=({_key(1): _node(1)}, {}),
                             actual=({_key(1): 1, _key(2): 2, _key(3): 3}, {}, set(), [7]))
    _stub_counts(monkeypatch, proj, (3, 0), (1, 0))
    _stub_sweep(monkeypatch, proj)
    err, healed = asyncio.run(proj._verify_and_heal(client, "g1", "main1", 1, 2, False, owned=False))
    assert err.startswith("projection verify mismatch") and healed is False, err
    assert writes["node_deletes"] == []
    assert not any(_UNKEYED_DELETE in q for q in client.queries), client.queries


def test_a_customer_key_holding_more_is_kept_and_counted(monkeypatch):
    proj, _, client = _projector()
    _stub_counts(monkeypatch, proj, (3, 2), (5, 3))
    swept = _stub_sweep(monkeypatch, proj)
    outcome = {}
    err, healed = asyncio.run(proj._verify_and_heal(
        client, "g1", "main1", 1, 2, False, owned=False, heal_outcome=outcome))
    assert (err, healed, outcome) == (None, False, {"surplus": (2, 1)})
    assert swept == ["g1"], "a surplus not seen before is swept for history's deletes first"


def test_a_surplus_already_counted_is_not_swept_again(monkeypatch):
    """Sweeping reads every tombstone of the graph: on a key whose other writers keep it above
    history, it runs when the surplus changes, not on every pass."""
    proj, _, client = _projector()
    _stub_counts(monkeypatch, proj, (3, 2), (5, 3))
    swept = _stub_sweep(monkeypatch, proj)
    outcome = {}
    err, _ = asyncio.run(proj._verify_and_heal(
        client, "g1", "main1", 1, 2, False, owned=False, heal_outcome=outcome,
        drift={"nodes": 2, "edges": 1, "via": "verify"}))
    assert err is None and outcome == {"surplus": (2, 1)} and swept == []


def test_an_edge_of_the_pass_that_did_not_land_is_healed_whatever_the_surplus(monkeypatch):
    proj, _, client = _projector()
    healed_with = []

    async def reconcile(client, graph_id, main_id, to_seq, is_fork, level_map, **kw):
        healed_with.append(kw.get("owned"))
        return {"writes": 1, "rollups": "none"}

    monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
    _stub_counts(monkeypatch, proj, (3, 2), (4, 3))
    _stub_sweep(monkeypatch, proj)
    outcome = {}
    err, healed = asyncio.run(proj._verify_and_heal(
        client, "g1", "main1", 1, 2, False, owned=False, heal_outcome=outcome, dropped=1))
    assert (err, healed, healed_with) == (None, True, [False])
    assert outcome["surplus"] == (1, 1)


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
