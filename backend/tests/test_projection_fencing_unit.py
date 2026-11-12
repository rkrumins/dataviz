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
* A rebuild that resumes from its cursor retries what its earlier passes held; one that starts
  over clears it.
* A pass that went through all its pages clears its cursor, held back by its verify or not, and
  so does an operator's rebuild that is accepted (``forget_cursor``), so neither is resumed.
* A paged window resumed from its cursor knows what the pages earlier passes wrote did (a
  structural change, writes dropped), and carries it on in every page's cursor.
* A full replay that stops at a page stays ``rebuilding``; a window that stops so goes back to
  idle. With the Graph residency switch on, a key holding the cursor of a rebuild that stopped so
  is resumed, not queued for a load as a first seed, also once a pass that failed after it has
  left the graph idle; asking for the cursor does not create a key that is not there.
* Only passes that fail in a row on a timeout or a memory refusal (``pressure_failures``) rebuild
  a window: a pass that ends any other way starts the count again, a cancel leaves it.
* The summaries a rebuild owes the job (``rollup_state.moved``) are handed over by the full seed
  that publishes, never moved by its difference again; a window that moved them and escalates
  owes its rebuild them.

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
        return False, [], []

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
                         last_projected_at=None, epoch=0, owns_falkor_graph=False)
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


def test_a_busy_graph_counts_itself_once_per_interval(monkeypatch):
    """Doc 19 §3.8: a pass that applied only main's newest commits re-counts the whole graph in both
    stores at most every PROJECTION_VERIFY_INTERVAL_SECS; one that verified dirty asks again."""
    from backend.app.services.versioning import config

    proj, ps, _client, _seen = _projector(monkeypatch, ps=_PS(projected=3, target=5))
    verifies = []

    async def verify(*a, **k):
        verifies.append(a[3])                     # from_seq
        return None, False
    monkeypatch.setattr(proj, "_verify_and_heal", verify)
    monkeypatch.setattr(config, "PROJECTION_VERIFY_INTERVAL_SECS", 300)
    for _ in range(3):
        asyncio.run(proj.project_graph("g1"))
    assert len(verifies) == 1, verifies

    # A pass that dropped a write is always verified.
    async def dropped(*a, **k):
        return 1
    monkeypatch.setattr(proj, "_apply", dropped)
    asyncio.run(proj.project_graph("g1"))
    assert len(verifies) == 2, verifies

    # A dirty verify (healed) asks for the next pass to verify too.
    async def healed(*a, **k):
        verifies.append(a[3])
        return None, True
    monkeypatch.setattr(proj, "_verify_and_heal", healed)
    asyncio.run(proj.project_graph("g1"))
    async def none(*a, **k):
        return 0
    monkeypatch.setattr(proj, "_apply", none)
    monkeypatch.setattr(proj, "_verify_and_heal", verify)
    asyncio.run(proj.project_graph("g1"))
    assert len(verifies) == 4, verifies

    # 0 verifies every pass, as before.
    monkeypatch.setattr(config, "PROJECTION_VERIFY_INTERVAL_SECS", 0)
    asyncio.run(proj.project_graph("g1"))
    asyncio.run(proj.project_graph("g1"))
    assert len(verifies) == 6, verifies


def test_a_rebuild_that_clears_held_changes_hands_the_rollups_to_the_job(monkeypatch):
    """A full seed clears the graph's held statements and rewrites them. Their window's rollups
    moved while the key lacked them, so moving the rollups by the reconcile's difference would
    count them twice: the rollups go to the job instead. With nothing held, they move."""
    for cleared, expect in ((True, ["g1"]), (False, [])):
        ps = _PS(projected=0, target=5)
        ps.status, ps.quarantine_next_at = "rebuilding", "2000-01-01T00:00:00+00:00"
        proj, ps, _client, _seen = _projector(monkeypatch, ps=ps)
        stale = []

        async def rollups_stale(graph_id):
            stale.append(graph_id)

        async def retry(client, graph_id, *, full_seed, cleared=cleared):
            assert full_seed
            return cleared

        async def reconcile(*a, **k):
            return {"writes": 1, "rollups": "applied", "structural": False}

        proj._on_rollups_stale = rollups_stale
        monkeypatch.setattr(proj, "_retry_quarantined", retry)
        monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
        r = asyncio.run(proj.project_graph("g1"))
        assert r["projected"] == 5 and stale == expect, (r, stale)


def test_a_rebuild_that_resumes_retries_what_its_earlier_passes_held(monkeypatch):
    """A full seed that resumes from its cursor writes nothing again before where it stopped, so
    what its earlier passes held is retried, as a window retries it, never cleared unwritten. One
    that starts over clears it."""
    for cursor, expect in (([[0, 5, "node", "ent_9", False, 0]], False), ([], True)):
        ps = _PS(projected=0, target=5)
        ps.status, ps.quarantine_next_at = "rebuilding", "2000-01-01T00:00:00+00:00"
        proj, ps, client, _seen = _projector(monkeypatch, ps=ps)
        retried = []

        async def query(cypher, params=None, cursor=cursor, **k):
            return SimpleNamespace(result_set=cursor if cypher == projection._CURSOR_READ else [])

        async def retry(client, graph_id, *, full_seed):
            retried.append(full_seed)
            return False

        async def reconcile(*a, **k):
            return {"writes": 0, "rollups": "none", "structural": False}

        client.query = query
        monkeypatch.setattr(proj, "_retry_quarantined", retry)
        monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
        asyncio.run(proj.project_graph("g1"))
        assert retried == [expect], (cursor, retried)


def test_a_full_seed_owed_the_summaries_hands_them_to_the_job(monkeypatch):
    """The summaries a rebuild owes the job (``rollup_state.moved``: a rebuild before it cleared
    what was held, or the window that escalated moved them) are handed over by the full seed that
    publishes, never moved by its difference again, whatever it finds."""
    for state, expect in (({"moved": "2026-11-12T00:00:00+00:00"}, (True, ["g1"])),
                          (None, (False, []))):
        ps = _PS(projected=0, target=5)
        ps.status, ps.rollup_state = "rebuilding", state
        proj, ps, _client, _seen = _projector(monkeypatch, ps=ps)
        stale, moved = [], []

        async def rollups_stale(graph_id):
            stale.append(graph_id)

        async def reconcile(*a, rollups_moved_this_pass=False, **k):
            moved.append(rollups_moved_this_pass)
            return {"writes": 1, "rollups": "applied", "structural": False}

        proj._on_rollups_stale = rollups_stale
        monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
        r = asyncio.run(proj.project_graph("g1"))
        assert r["projected"] == 5 and (moved[0], stale) == expect, (r, moved, stale)


def test_an_escalation_owes_its_rebuild_the_summaries_its_window_moved(monkeypatch):
    """A window that moved the summaries, or owed them to the job, and then escalates owes its
    rebuild them, as the heal it replaces passed ``rollups_moved_this_pass``. One that moved
    none owes nothing."""
    for deltas, applied, expect in (({("a", "b"): {"dw": 1}}, True, True),
                                    ("stale", False, True), ({}, False, False)):
        proj, _ps, _client, _seen = _projector(monkeypatch, ps=_PS(projected=3, target=5),
                                               verify_error="short")
        escalated = []

        async def compute(*a, deltas=deltas):
            return deltas

        async def apply_rollups(*a, applied=applied):
            return applied

        async def verify(*a, heal_outcome=None, **k):
            heal_outcome["escalate"] = "it holds less than history"
            return "short", False

        async def escalate(graph_id, mine, reason, cause, *, summaries_moved=False):
            escalated.append(summaries_moved)
            return True

        proj._edge_types_resolver = object()
        monkeypatch.setattr(proj, "_compute_rollup_deltas", compute)
        monkeypatch.setattr(proj, "_apply_rollups", apply_rollups)
        monkeypatch.setattr(proj, "_verify_and_heal", verify)
        monkeypatch.setattr(proj, "_escalate", escalate)
        monkeypatch.setattr(config, "PROJECTION_VERIFY_INTERVAL_SECS", 0)
        asyncio.run(proj.project_graph("g1"))
        assert escalated == [expect], (deltas, escalated)


# ── the cursor across passes ───────────────────────────────────────────

def test_an_accepted_rebuild_starts_over_and_one_in_flight_keeps_its_cursor(monkeypatch):
    """An operator's rebuild that is accepted clears the pass cursor in the graph's pinned key, so
    its first pass replays main from the start rather than resume a rebuild that stopped part-way
    and then failed. One refused as already running leaves the cursor to the rebuild in flight."""
    from backend.app.api.v1.endpoints import versioning as ep

    for started in (True, False):
        proj, _ps, client, _seen = _projector(monkeypatch)

        async def repaired(graph_id):
            return None

        async def watermark(graph_id):
            return {"falkor_graph_name": "real_pinned_graph"}

        async def request(graph_id, started=started):
            return started

        async def model(session, wm):
            return ep.WatermarkModel.model_construct()

        svc = SimpleNamespace(projection_watermark=watermark, request_projection_rebuild=request)
        monkeypatch.setattr(ep, "_repair_projection_target", repaired)
        monkeypatch.setattr(ep, "_get_projector", lambda: proj)
        monkeypatch.setattr(ep, "_watermark_model", model)
        r = asyncio.run(ep.rebuild_projection(
            "ws1", "g1", background=SimpleNamespace(add_task=lambda *a: None), _user=None,
            _meta={}, svc=svc, session=None))
        assert r.started is started
        assert [c for c, _p in client.queries] == ([projection._CURSOR_CLEAR] if started else [])


def test_a_full_seed_through_its_pages_leaves_no_cursor_whatever_its_verify_found(monkeypatch):
    """A full seed that went through all its pages clears its cursor, also when its verify holds
    it back: a pass after it (a retry, an operator's rebuild) reconciles the key from the start,
    rather than resume past its last page and write nothing."""
    for verify_error in ("count mismatch", None):
        ps = _PS(projected=0, target=5)
        ps.status = "rebuilding"
        proj, ps, client, seen = _projector(monkeypatch, ps=ps, verify_error=verify_error)

        async def reconcile(*a, cursor=None, **k):
            await cursor.page_done("edge", "ent_9", 1)            # its last page
            return {"writes": 1, "rollups": "none", "structural": False}

        monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
        asyncio.run(proj.project_graph("g1"))
        sent = [c for c, _p in client.queries]
        assert projection._CURSOR_CLEAR in sent[sent.index(projection._CURSOR_WRITE):], sent
        assert seen["finish"][0][2]["published"] is (verify_error is None)


def test_a_resumed_paged_window_knows_what_its_earlier_pages_did(monkeypatch):
    """A paged window resumed from its cursor starts from what the pages earlier passes wrote did:
    they retyped a node (structural) and dropped a write. The pass that publishes the window
    reports both, so it bumps the graph's generation and verifies, though its own pages did
    neither; and each of its pages' cursors carries them on, for a pass after it."""
    proj, _ps, client, _seen = _projector(monkeypatch)
    pages = {"node": [(([("n2", "u2", {"entityType": "Dataset"})], [], [], []), "v2")],
             "edge": [(([], [], [], []), "v3")]}

    async def window_rows(*a):
        return 2

    async def window_pages(s, graph, main_id, from_seq, to_seq, kind, after=""):
        for page in pages[kind]:
            yield page

    monkeypatch.setattr(proj, "_window_rows", window_rows)
    monkeypatch.setattr(proj, "_window_pages", window_pages)
    cursor = projection._Cursor(client, 3, 5, ("node", "v1"), None, structural=True, dropped=1)
    assert asyncio.run(proj._apply_paged(client, "g1", "main1", 3, 5, level_map={},
                                         provider_id=None, owned=True, cursor=cursor)) == (1, True, 1)
    writes = [p for c, p in client.queries if c == projection._CURSOR_WRITE]
    assert [(p["step"], p["structural"], p["dropped"]) for p in writes] == [
        ("node", True, 1), ("edge", True, 1)]


def test_a_full_replay_that_stops_at_a_page_stays_a_rebuild(monkeypatch):
    """Past its time box a pass stops at a page. A full replay stays ``rebuilding``: back at idle,
    with the Graph residency switch on, the pass that resumes it would be taken for a first seed
    and queued for a load into a fresh key, leaving its pages and its cursor behind. A window goes
    back to idle, as it was."""
    for projected, status in ((0, "rebuilding"), (3, "idle")):
        ps = _PS(projected=projected, target=5)
        ps.status = "rebuilding" if projected == 0 else "idle"
        proj, ps, _client, seen = _projector(monkeypatch, ps=ps)

        async def stop(*a, **k):
            raise projection._PassPartial(7)

        async def paged(*a):
            return None                                      # a window too large to hold

        monkeypatch.setattr(proj, "_compute_changes", paged)
        monkeypatch.setattr(proj, "_reconcile_in_place", stop)
        monkeypatch.setattr(proj, "_apply_paged", stop)
        r = asyncio.run(proj.project_graph("g1"))
        assert r["partial"] and seen["finish"][0][2]["status"] == status, (r, seen["finish"])


def test_with_residency_on_a_key_holding_a_stopped_rebuild_is_resumed_not_queued(monkeypatch):
    """With the Graph residency switch on, a pass from 0 over an idle key the platform owns is a
    first seed, queued for a load, unless the key holds the cursor of a rebuild that stopped at a
    page: a pass that failed or was cancelled after it left the graph idle, and this pass claims
    the row and resumes it in place. A key with no cursor, one that does not exist (asking does
    not create it) or one out of reach is queued, as before."""
    stopped = [[0, 5, "fk_edge", "20000", False, 0]]
    for found, queued in ((stopped, False), ([], True), ("missing", True), ("unreachable", True)):
        proj, _ps, client, seen = _projector(monkeypatch, ps=_PS(projected=0, target=5))
        asked = []

        async def ro_query(cypher, params=None, found=found, **k):
            if found == "missing":
                raise RuntimeError("Invalid graph operation on empty key")
            return SimpleNamespace(result_set=found if cypher == projection._CURSOR_READ else [])

        def unreachable(name, provider_id=None):
            raise ConnectionError("FalkorDB is down")

        async def on(session=None):
            return True

        async def queue(graph_id, seen_epoch):
            asked.append(graph_id)
            return True

        async def reconcile(*a, **k):
            return {"writes": 0, "rollups": "none", "structural": False}

        client.ro_query = ro_query
        if found == "unreachable":
            proj._client = unreachable
        monkeypatch.setattr(projection.residency_policy, "switch_state", on)
        monkeypatch.setattr(proj, "_queue_first_seed", queue)
        monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
        r = asyncio.run(proj.project_graph("g1"))
        expect = (["g1"], False) if queued else ([], True)          # (queued, claimed)
        assert (asked, bool(seen["claim"])) == expect, (found, r)
        if found == "missing":
            assert client.queries == [], client.queries           # nothing sent that makes the key


def test_only_failures_in_a_row_under_pressure_rebuild_a_window(monkeypatch):
    """The escalation counts the passes in a row that failed on a timeout or a memory refusal
    (``pressure_failures``), not every failed or held-back pass (``failed_attempts``, 2 here):
    after failures of another kind, one timeout does not rebuild the graph, and the third timeout
    in a row does. A pass that fails under pressure counts one more, any other end starts the
    count again, and a cancel leaves it as it is."""
    monkeypatch.setattr(config, "PROJECTION_ESCALATE", True)
    monkeypatch.setattr(config, "PROJECTION_ESCALATE_AFTER", 3)
    for before, exc, pressure, escalates in (
            (0, TimeoutError("Query timed out"), True, False),
            (2, TimeoutError("Query timed out"), True, True),
            (2, RuntimeError("falkordb down"), False, False),
            (2, asyncio.CancelledError(), None, False)):
        ps = _PS(projected=3, target=5)
        ps.pressure_failures = before
        proj, ps, _client, seen = _projector(monkeypatch, ps=ps)
        escalated = []

        async def boom(*a, exc=exc, **k):
            raise exc

        async def escalate(graph_id, mine, reason, cause, *, summaries_moved=False):
            escalated.append(cause)
            return True

        monkeypatch.setattr(proj, "_apply", boom)
        monkeypatch.setattr(proj, "_escalate", escalate)
        try:
            asyncio.run(proj.project_graph("g1"))
        except (TimeoutError, RuntimeError, asyncio.CancelledError):
            pass
        assert seen["finish"][0][2]["pressure"] is pressure, (exc, seen["finish"])
        assert escalated == (["failures"] if escalates else []), (exc, escalated)
