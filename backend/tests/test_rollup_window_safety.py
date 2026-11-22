"""A window's lineage-summary deltas are applied only when nothing can have made them wrong, and
handed to the batch job (``"stale"``) when something may have:

* a summaries job that met the window — one pending or running, or one that ended since the graph's
  last publish (``_rollups_ran_since``): it reads the raw graph, then writes every cell from what it
  read, so it may write over the window's deltas, bring back cells they deleted, or count the
  window's edges a second time on top of them;
* an ontology that could not be read (``UNRESOLVED``) or a resolver that failed: nothing can tell
  which of the window's edges are lineage, and skipping its deltas lost them for good, since the
  next window's apply moves the summaries marker past it;
* a cell whose end is not in the key (held in quarantine, or under another label): its write
  matches nothing.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from backend.app.services.versioning import projection
from backend.app.services.versioning.projection import UNRESOLVED, FalkorProjector
from backend.tests.test_projection_fencing_unit import _PS, _projector


# ── a summaries job that met the window ────────────────────────────────────────────────────────

def test_a_window_a_summaries_job_met_hands_them_to_the_job(monkeypatch):
    for ran in (True, False):
        proj, ps, _client, seen = _projector(monkeypatch, ps=_PS(projected=3, target=5))
        ps.last_projected_at = "2026-11-13T12:00:00+00:00"
        asked = []

        async def compute(*a):
            return {("a", "b"): {"dw": 1, "types": {"FLOWS"}}}

        async def apply_rollups(*a):
            return True

        async def ran_since(data_source_id, since, ran=ran):
            asked.append((data_source_id, since))
            return ran

        proj._edge_types_resolver = object()
        monkeypatch.setattr(proj, "_compute_rollup_deltas", compute)
        monkeypatch.setattr(proj, "_apply_rollups", apply_rollups)
        monkeypatch.setattr(projection, "_rollups_ran_since", ran_since)
        asyncio.run(proj.project_graph("g1"))
        # Judged from the last publish: every raw write of the window came after it.
        assert asked == [("ds1", "2026-11-13T12:00:00+00:00")]
        assert ("g1" in seen["hooks"]) is ran, (ran, seen["hooks"])


def test_a_window_whose_deltas_did_not_apply_asks_nothing_more(monkeypatch):
    # An apply that refused (an overlap) is already the job's: no question to ask about a race.
    proj, _ps, _client, seen = _projector(monkeypatch, ps=_PS(projected=3, target=5))
    asked = []

    async def compute(*a):
        return {("a", "b"): {"dw": 1, "types": {"FLOWS"}}}

    async def refused(*a):
        return False

    async def ran_since(*a):
        asked.append(a)
        return False

    proj._edge_types_resolver = object()
    monkeypatch.setattr(proj, "_compute_rollup_deltas", compute)
    monkeypatch.setattr(proj, "_apply_rollups", refused)
    monkeypatch.setattr(projection, "_rollups_ran_since", ran_since)
    asyncio.run(proj.project_graph("g1"))
    assert asked == [] and "g1" in seen["hooks"]


async def test_a_job_meets_a_window_while_it_runs_or_when_it_ended_since_the_last_publish(
        db_session, monkeypatch):
    from backend.app.db import engine
    from backend.app.services.aggregation.models import AggregationJobORM

    @contextlib.asynccontextmanager
    async def readonly():
        yield db_session

    monkeypatch.setattr(engine, "get_readonly_session", readonly)
    published = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
    since = published.isoformat()
    jobs = iter(range(100))

    async def job(status, ended=None, ds="ds1"):
        db_session.add(AggregationJobORM(
            id=f"agg_{next(jobs)}", data_source_id=ds, status=status,
            completed_at=None if ended is None else (published + ended).isoformat()))
        await db_session.commit()

    ran = projection._rollups_ran_since
    assert await ran("ds1", since) is False                                  # no job at all
    await job("completed", ended=-timedelta(hours=1))
    await job("running", ds="ds_other")
    assert await ran("ds1", since) is False      # ended well before the publish; another source's
    await job("failed", ended=-timedelta(seconds=30))
    assert await ran("ds1", since) is True       # within the pods' clock skew of the publish
    assert await ran("ds1", None) is False       # no publish to judge from: only one still active
    await job("pending")
    assert await ran("ds1", None) is True
    assert await ran(None, since) is False       # no data source: no summaries


async def test_a_job_that_cannot_be_asked_about_met_the_window(monkeypatch):
    from backend.app.db import engine

    @contextlib.asynccontextmanager
    async def down():
        raise ConnectionError("management database down")
        yield  # pragma: no cover

    monkeypatch.setattr(engine, "get_readonly_session", down)
    assert await projection._rollups_ran_since("ds1", "2026-11-13T12:00:00+00:00") is True


# ── an ontology that could not be read ─────────────────────────────────────────────────────────

def _deltas(resolver):
    proj = FalkorProjector(graph_client_factory=lambda *a, **k: None, edge_types_resolver=resolver)
    return asyncio.run(proj._compute_rollup_deltas(None, SimpleNamespace(id="g1"), "main", 1, 2))


def test_an_unreadable_ontology_hands_the_windows_summaries_to_the_job():
    async def unresolved(svc, graph_id):
        return UNRESOLVED

    async def failing(svc, graph_id):
        raise RuntimeError("ontology service down")

    async def no_lineage(svc, graph_id):
        return None

    assert _deltas(unresolved) == "stale"
    assert _deltas(failing) == "stale"
    assert _deltas(no_lineage) is None               # no lineage: nothing to maintain


# ── a cell whose end is not in the key ─────────────────────────────────────────────────────────

class _Key:
    """A key at summaries marker 0 in the boundary regime, holding no cell yet, whose rollup
    writes land ``found`` of each batch."""

    def __init__(self, found):
        self.found, self.written = found, []

    async def query(self, cypher, params=None, timeout=None):
        batch = (params or {}).get("batch") or []
        rows: list = []
        if "_AggMeta {id: 'singleton'}) RETURN m.regime" in cypher:
            rows = [["boundary"]]
        elif "MERGE (a)-[r:AGGREGATED]->(b)" in cypher:
            self.written.extend(batch)
            rows = [[self.found(batch)]]
        return SimpleNamespace(result_set=rows)


def _cells():
    return {("urn:t1", "urn:t2"): {"dw": 2, "types": {"FLOWS"}},
            ("urn:t1", "urn:t3"): {"dw": 1, "types": {"FLOWS"}}}


def test_a_cell_whose_end_is_not_in_the_key_hands_the_summaries_to_the_job():
    proj = FalkorProjector(graph_client_factory=lambda *a, **k: None)
    all_landed = _Key(len)
    assert asyncio.run(proj._write_rollup_deltas(all_landed, _cells(), 5, guard_from_seq=3)) is True
    assert {(w["s"], w["t"], w["w"]) for w in all_landed.written} == {
        ("urn:t1", "urn:t2", 2), ("urn:t1", "urn:t3", 1)}
    one_short = _Key(lambda batch: len(batch) - 1)
    assert asyncio.run(proj._write_rollup_deltas(one_short, _cells(), 5, guard_from_seq=3)) is False


# ── a reconcile ────────────────────────────────────────────────────────────────────────────────

def test_a_full_seed_a_summaries_job_met_hands_them_to_the_job(monkeypatch):
    # As for a window: a reconcile that moved the summaries by its difference while a job met it.
    for ran in (True, False):
        ps = _PS(projected=0, target=5)
        ps.status, ps.rollup_state = "rebuilding", None
        proj, _ps, _client, seen = _projector(monkeypatch, ps=ps)

        async def reconcile(*a, **k):
            return {"writes": 1, "rollups": "applied", "structural": False}

        async def ran_since(data_source_id, since, ran=ran):
            return ran

        monkeypatch.setattr(proj, "_reconcile_in_place", reconcile)
        monkeypatch.setattr(projection, "_rollups_ran_since", ran_since)
        r = asyncio.run(proj.project_graph("g1"))
        assert r["projected"] == 5 and ("g1" in seen["hooks"]) is ran, (ran, seen["hooks"])


def test_a_reconcile_whose_cells_found_no_end_moves_no_marker(monkeypatch):
    """The reconcile's rollup cells that found no end in the key: the job derives them, and the
    summaries marker stays where it was, with ``reconciling`` set, so they read untrusted until
    then."""
    from backend.tests import test_projection_foreign_key_guard as fk

    schema = {("Schema", "urn:p1"): fk._node(3), ("Schema", "urn:p2"): fk._node(4)}
    contains = {("Schema", "urn:p1", "CONTAINS", "Dataset", "urn:1"): fk._edge(6),
                ("Schema", "urn:p2", "CONTAINS", "Dataset", "urn:2"): fk._edge(7)}
    flows = ("Dataset", "urn:1", "FLOWS", "Dataset", "urn:2")

    async def in_source(svc, graph_id):
        return (["CONTAINS"], ["FLOWS"], {})

    async def trusted(client, lineage):
        return True

    for landed, expect in ((True, "applied"), (False, "stale")):
        proj, _, client = fk._projector()
        proj._edge_types_resolver = in_source
        fk._stub_reconcile(
            monkeypatch, proj,
            expected=({fk._key(1): fk._node(1), fk._key(2): fk._node(2), **schema},
                      {**contains, flows: fk._edge(5)}),
            actual=({fk._key(1): 1, fk._key(2): 2, ("Schema", "urn:p1"): 3,
                     ("Schema", "urn:p2"): 4}, {k: v.fp for k, v in contains.items()}, set(), []))

        async def write(*a, landed=landed, **kw):
            return landed

        monkeypatch.setattr(proj, "_rollups_trusted", trusted)
        monkeypatch.setattr(proj, "_write_rollup_deltas", write)
        out = asyncio.run(proj._reconcile_in_place(client, "g1", "main1", 2, {}))
        marked = [q for q in client.queries if "_GVRollupMeta" in q and "SET m.seq" in q]
        assert (out["rollups"], bool(marked)) == (expect, landed), (out, client.queries)
