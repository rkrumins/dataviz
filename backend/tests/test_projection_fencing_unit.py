"""A projection pass is fenced by ``projection_state.epoch``, and a held-back graph is retried.

* The pass projects up to ``max(target, main head)``: a graph whose verify failed is no longer
  pinned at ``projected == target`` below the head, where every later pass was a no-op.
* It claims the row (a CAS on epoch and projected) before touching FalkorDB, and its final write
  succeeds only while the epoch is still its own. Whatever reset the watermark under it (evict,
  rebuild, repin, a second writer) wins: the pass lowers the watermark to where it started, fires
  no publish hooks and nudges the worker.
* A failed pass leaves ``target`` alone and backs off through ``failed_attempts``/``next_retry_at``.
* A publishing pass writes the ``_GVProjMeta`` marker (seq, epoch) last, after the verify and
  before the watermark; with ``GRAPHVER_PROJECTION_WAIT_REPLICAS`` set, a marker the replicas did
  not confirm holds the watermark as ``replica_unconfirmed``.
* The bootstrap head flip bumps the epoch in the transaction its lease fences.
* An explicit rebuild that finds a pass in flight, or loses its fence, nudges the worker.

Pure unit tests — no Postgres, no FalkorDB (fakes in the style of
``test_projection_cancellation_unit.py``).
"""
import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from backend.app.services.versioning import bootstrap_worker, config, projection
from backend.app.services.versioning.models import (
    BranchORM, GraphORM, JobORM, ProjectionStateORM,
)
from backend.app.services.versioning.projection import FalkorProjector


class _PS:
    def __init__(self, projected=3, target=3):
        self.status = "idle"
        self.last_error = None
        self.projected_commit_seq = projected
        self.target_commit_seq = target
        self.falkor_graph_name = "real_pinned_graph"
        self.falkor_provider = None
        self.owns_falkor_graph = True
        self.last_projected_at = None
        self.progress_done = None
        self.progress_total = None
        self.epoch = 4
        self.failed_attempts = 2
        self.next_retry_at = None


class _Graph:
    id = "g1"
    data_source_id = "ds1"
    workspace_id = "ws1"
    fork_parent_graph_id = None
    deleted_at = None
    main_head_commit_seq = 5


class _Session:
    def __init__(self, ps, graph, bootstrap_status):
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


class _Client:
    def __init__(self):
        self.touched = False
        self.queries = []

    async def query(self, cypher, params=None, **k):
        self.touched = True
        self.queries.append((cypher, params))
        return SimpleNamespace(result_set=[])


def _projector(monkeypatch, *, ps=None, bootstrap_status=None, claim=(5, 2), finish=True,
               verify_error=None):
    """A projector over fakes whose window compute, apply and verify are stubbed; records the
    fenced writes, the window computed, the publish hooks and the nudges."""
    ps, client = ps or _PS(), _Client()
    seen = {"claim": [], "finish": [], "yield": [], "window": [], "hooks": [], "nudge": []}

    @contextlib.asynccontextmanager
    async def session():
        yield _Session(ps, _Graph(), bootstrap_status)

    async def on_hook(arg):
        seen["hooks"].append(arg)

    proj = FalkorProjector(graph_client_factory=lambda name, provider_id=None: client,
                           session_factory=session, on_projected=on_hook,
                           on_rollups_stale=on_hook)

    async def _claim(graph_id, seen_epoch, from_seq):
        seen["claim"].append((graph_id, seen_epoch, from_seq))
        return claim

    async def _finish(graph_id, mine, **kw):
        seen["finish"].append((graph_id, mine, kw))
        return finish

    async def _yield(graph_id, from_seq):
        seen["yield"].append((graph_id, from_seq))

    async def main_branch_id(s, graph_id):
        return "main1"

    async def compute(s, graph, main_id, from_seq, to_seq):
        seen["window"].append((from_seq, to_seq))
        return [], [], [], []

    async def window_meta(s, graph, main_id, from_seq, changes):
        return False, []

    async def noop(*a, **k):
        return None

    async def no_level_map(graph_id):
        return {}

    async def not_interrupted(client):
        return False

    async def verify(*a, **k):
        return verify_error, False

    async def nudge(graph_id):
        seen["nudge"].append(graph_id)

    monkeypatch.setattr(proj, "_claim", _claim)
    monkeypatch.setattr(proj, "_finish", _finish)
    monkeypatch.setattr(proj, "_yield_superseded", _yield)
    monkeypatch.setattr(proj._svc, "_main_branch_id", main_branch_id)
    monkeypatch.setattr(proj, "_compute_changes", compute)
    monkeypatch.setattr(proj, "_window_meta", window_meta)
    monkeypatch.setattr(proj, "_relabel_in_place", noop)
    monkeypatch.setattr(proj, "_apply", noop)
    monkeypatch.setattr(proj, "_resolve_level_map", no_level_map)
    monkeypatch.setattr(proj, "_verify_and_heal", verify)
    monkeypatch.setattr(projection, "reconcile_interrupted", not_interrupted)
    monkeypatch.setattr(projection, "nudge_projection", nudge)
    return proj, ps, client, seen


def test_a_held_back_graph_projects_up_to_the_head(monkeypatch):
    # projected == target == 3 below head 5 — what a failed verify used to leave: every later
    # pass was a no-op, forever.
    proj, ps, _client, seen = _projector(monkeypatch, ps=_PS(projected=3, target=3))
    r = asyncio.run(proj.project_graph("g1"))
    assert seen["window"] == [(3, 5)], r
    assert seen["claim"] == [("g1", 4, 3)]
    _gid, mine, kw = seen["finish"][0]
    assert mine == 5 and kw["published"] is True and kw["to_seq"] == 5
    assert r["projected"] == 5 and not r["noop"], r


def test_a_lost_claim_touches_nothing_and_nudges(monkeypatch):
    proj, _ps, client, seen = _projector(monkeypatch, claim=None)
    r = asyncio.run(proj.project_graph("g1"))
    assert r == {"projected": 3, "applied": 0, "noop": True, "skipped": "superseded"}, r
    assert not client.touched and seen["window"] == [] and seen["finish"] == []
    assert seen["nudge"] == ["g1"]


def test_a_lost_fence_lowers_the_watermark_and_fires_no_hooks(monkeypatch):
    proj, _ps, _client, seen = _projector(monkeypatch, finish=False)
    r = asyncio.run(proj.project_graph("g1"))
    assert seen["yield"] == [("g1", 3)]
    assert seen["nudge"] == ["g1"]
    assert seen["hooks"] == [], "a superseded pass published nothing"
    assert r["skipped"] == "superseded" and r["projected"] == 3, r


def test_an_unfaithful_pass_backs_off_and_leaves_target_alone(monkeypatch):
    proj, ps, _client, seen = _projector(monkeypatch, ps=_PS(projected=3, target=5),
                                         verify_error="count mismatch")
    r = asyncio.run(proj.project_graph("g1"))
    _gid, mine, kw = seen["finish"][0]
    assert kw["published"] is False and kw["error"] == "count mismatch"
    assert kw["attempts"] == 2, "the claimed failed_attempts, so the backoff grows"
    assert ps.target_commit_seq == 5, "target is the publishers', never the projector's"
    assert seen["hooks"] == [] and seen["yield"] == []
    assert r["projected"] == 3 and r["verify_error"] == "count mismatch", r


def test_a_failed_apply_backs_off_and_a_cancel_does_not(monkeypatch):
    for exc, attempts in ((RuntimeError("falkordb down"), 2), (asyncio.CancelledError(), None)):
        proj, _ps, _client, seen = _projector(monkeypatch)

        async def boom(*a, **k):
            raise exc
        monkeypatch.setattr(proj, "_apply", boom)
        try:
            asyncio.run(proj.project_graph("g1"))
        except (RuntimeError, asyncio.CancelledError):
            pass
        _gid, mine, kw = seen["finish"][0]
        assert mine == 5 and kw["published"] is False and kw["attempts"] == attempts, kw


def test_nothing_projects_while_bootstrapping_even_below_the_head(monkeypatch):
    # The genesis pin (projected == target == 1) no longer stops a pass by itself once the head
    # counts: the unfinished-bootstrap skip must, before anything is claimed or computed.
    proj, _ps, client, seen = _projector(monkeypatch, ps=_PS(projected=1, target=1),
                                         bootstrap_status="running")
    r = asyncio.run(proj.project_graph("g1"))
    assert r.get("skipped") == "bootstrapping", r
    assert seen["claim"] == [] and seen["window"] == [] and not client.touched


def test_the_retry_delay_doubles_up_to_the_cap(monkeypatch):
    monkeypatch.setattr(config, "PROJECTION_RETRY_BASE_SECS", 5)
    monkeypatch.setattr(config, "PROJECTION_RETRY_MAX_SECS", 60)

    def delay(attempts):
        at = datetime.fromisoformat(projection._retry_at(attempts))
        return round((at - datetime.now(timezone.utc)) / timedelta(seconds=1))

    assert [delay(n) for n in (1, 2, 3, 5, 30)] == [5, 10, 20, 60, 60]


# ── the marker ──────────────────────────────────────────────────────────

def test_the_marker_is_written_last_between_the_verify_and_the_watermark(monkeypatch):
    proj, _ps, client, seen = _projector(monkeypatch, claim=(7, 2))
    order = []
    verify, finish = proj._verify_and_heal, proj._finish

    async def ordered_verify(*a, **k):
        order.append("verify")
        return await verify(*a, **k)

    async def ordered_finish(*a, **k):
        order.append("finish")
        return await finish(*a, **k)

    async def ordered_query(cypher, params=None, **k):
        order.append(("query", cypher, params))
    monkeypatch.setattr(proj, "_verify_and_heal", ordered_verify)
    monkeypatch.setattr(proj, "_finish", ordered_finish)
    monkeypatch.setattr(client, "query", ordered_query)

    r = asyncio.run(proj.project_graph("g1"))
    assert [o if isinstance(o, str) else o[0] for o in order] == ["verify", "query", "finish"]
    _q, cypher, params = order[1]
    assert "MERGE (m:_GVProjMeta {id: 'meta'})" in cypher, cypher
    assert params == {"seq": 5, "epoch": 7}, "the published seq and this pass's epoch"
    assert seen["finish"][0][2]["published"] is True and r["projected"] == 5, r


def test_a_held_back_pass_writes_no_marker(monkeypatch):
    proj, _ps, client, _seen = _projector(monkeypatch, verify_error="count mismatch")
    asyncio.run(proj.project_graph("g1"))
    assert client.queries == []


def test_a_marker_the_replicas_did_not_confirm_holds_the_watermark(monkeypatch):
    monkeypatch.setattr(config, "PROJECTION_WAIT_REPLICAS", 1)
    monkeypatch.setattr(config, "PROJECTION_WAIT_MS", 200)
    for acked in (0, None):
        proj, _ps, client, seen = _projector(monkeypatch, claim=(7, 2))
        calls = []

        async def write_and_wait(query, **kw):
            calls.append((query, kw))
            return acked
        client.write_and_wait = write_and_wait

        r = asyncio.run(proj.project_graph("g1"))
        [(query, kw)] = calls
        assert "_GVProjMeta" in query and "seq=5" in query and "epoch=7" in query, query
        assert kw["min_replicas"] == 1 and kw["wait_ms"] == 200, kw
        assert client.queries == [], "the marker went out with its WAIT, not as a plain query"
        _gid, mine, fkw = seen["finish"][0]
        assert fkw["published"] is False and fkw["attempts"] == 2, fkw
        assert fkw["error"].startswith("replica_unconfirmed"), fkw
        assert seen["hooks"] == [] and r["projected"] == 3, (acked, r)


def test_a_marker_the_replicas_confirmed_publishes(monkeypatch):
    monkeypatch.setattr(config, "PROJECTION_WAIT_REPLICAS", 1)
    proj, _ps, client, seen = _projector(monkeypatch)

    async def write_and_wait(query, **kw):
        return 1
    client.write_and_wait = write_and_wait
    r = asyncio.run(proj.project_graph("g1"))
    assert seen["finish"][0][2]["published"] is True and r["projected"] == 5, r


# ── rebuild_now ─────────────────────────────────────────────────────────

def test_an_explicit_rebuild_that_finds_a_pass_in_flight_nudges(monkeypatch):
    from backend.app.api.v1.endpoints import versioning as ep

    for skipped in ("in-flight", "superseded"):
        nudged = []

        class _Proj:
            async def project_graph(self, graph_id):
                return {"noop": True, "skipped": skipped}

        async def nudge(graph_id):
            nudged.append(graph_id)

        monkeypatch.setattr(ep, "_get_projector", lambda: _Proj())
        monkeypatch.setattr(ep, "nudge_projection", nudge)
        asyncio.run(ep.rebuild_now("g1"))
        assert nudged == ["g1"], skipped


# ── the bootstrap head flip ─────────────────────────────────────────────

def test_the_bootstrap_head_flip_bumps_the_epoch_in_the_fenced_transaction():
    ps = SimpleNamespace(projected_commit_seq=1, target_commit_seq=1, status="idle",
                         last_projected_at=None, epoch=0)
    rows = {JobORM: SimpleNamespace(summary={}), GraphORM: SimpleNamespace(),
            BranchORM: SimpleNamespace(), ProjectionStateORM: ps}
    sessions = []

    class _S:
        async def get(self, model, key):
            if model is ProjectionStateORM:
                sessions.append(("ps", self))
            return rows[model]

    @contextlib.asynccontextmanager
    async def session():
        yield _S()

    class _Lease:
        job_id = "job1"

        async def checkpoint(self, s, **kw):
            sessions.append(("checkpoint", s))

    runner = bootstrap_worker.BootstrapRunner(None, session_factory=session)

    async def import_commit(s, graph_id):
        return SimpleNamespace(id="c2", commit_seq=2, stats=None)

    async def main_branch_id(s, graph_id):
        return "main1"
    runner._import_commit, runner._main_branch_id = import_commit, main_branch_id

    assert asyncio.run(runner._phase_finalize(_Lease(), "g1")) is True
    assert ps.projected_commit_seq == ps.target_commit_seq == 2
    assert str(ps.epoch) == str(ProjectionStateORM.epoch + 1), ps.epoch
    (first, s1), (second, s2) = sessions
    assert (first, second) == ("checkpoint", "ps") and s1 is s2
