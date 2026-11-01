"""Update from parent: a fork takes its parent's newer changes — Postgres and FalkorDB.

A fork reads its parent at a base, per commit (``fork_bases``). Update from parent takes the
parent's changes since the base in force at the fork's head (``B``) up to the parent's head
(``P``): one ``sync_parent`` commit on the fork's main and a base row ``(that commit, P)``, in one
transaction. Only what both sides changed goes through the 3-way merge (base: the parent at ``B``);
the rest shows through once the base moves, so a clean update writes nothing. Conflicts answer as a
pull's do, and ``resolutions`` settle them. A node the parent deleted takes the fork's own edges to
it with it; an edge the parent drew to a node the fork deleted is deleted on the fork.

The parent is projected into a FalkorDB key of its own, for real, after each of its commits, and
each fork is read through its overlay over that key as ContextEngine reads it, as well as from
Postgres.
"""
import contextlib
import os

import pytest

from backend.app.services.versioning.errors import ForkUpdateConflicts, NotAFork
from backend.common.models.graph import EdgeQuery, NodeQuery
from backend.tests.integration.test_fork_overlay_delta import _d, _e, _fork, _n, _run, _u, _ue

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable")]

CONT = ["CONTAINS"]


class _Root:
    """A parent graph in a FalkorDB key of its own, projected after each of its commits."""

    def __init__(self, svc, key, base, projector):
        self.svc, self.key, self.base, self.projector = svc, key, base, projector
        self.gid = None

    async def make(self, ops):
        self.gid = (await self.svc.create_graph(
            data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice",
            falkor_graph_name=self.key, owns_falkor_graph=True))["graph_id"]
        await self.edit(ops, "seed")
        return self.gid

    async def edit(self, ops, message="parent"):
        await self.svc.apply_ops(graph_id=self.gid, actor="alice", message=message, ops=ops)
        result = await self.projector.project_graph(self.gid)
        assert not result.get("verify_error"), result

    async def reader(self, gid, branch_id=None):
        """A fork's main read as ContextEngine reads it, or a draft on it over that."""
        from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
        plan = await self.svc.fork_read_plan(gid)
        assert plan["reads_from"] == "overlay"
        p = DraftOverlayProvider(self.base, svc=self.svc, graph_id=gid, branch_id=plan["main_id"],
                                 fork=True, version=plan["version"])
        p.set_containment_edge_types(CONT)
        if branch_id is not None:
            p = DraftOverlayProvider(p, svc=self.svc, graph_id=gid, branch_id=branch_id)
            p.set_containment_edge_types(CONT)
        return p


@contextlib.asynccontextmanager
async def _projected(svc):
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.versioning.projection import FalkorProjector

    host, port = os.getenv("FALKORDB_HOST", "localhost"), int(os.getenv("FALKORDB_PORT", "6379"))
    key = "gvt_sync_" + os.urandom(4).hex()
    pool = ConnectionPool(host=host, port=port, max_connections=4)
    handle = FalkorDB(connection_pool=pool)
    base = FalkorDBProvider(host=host, port=port, graph_name=key)
    base.set_containment_edge_types(CONT)
    try:
        yield _Root(svc, key, base, FalkorProjector(lambda _name, _provider=None: handle.select_graph(key)))
    finally:
        try:
            await handle.select_graph(key).delete()
        except Exception:
            pass
        await pool.disconnect()


async def _state(svc, gid, branch_id, as_of=None):
    """``({node: name}, {edge: (source, target)})`` as Postgres composes the branch."""
    st = await svc.materialize_state(graph_id=gid, branch_id=branch_id, as_of_seq=as_of)
    return ({e: p.get("displayName") for e, p in st["nodes"].items()},
            {e: (p["sourceEntityId"], p["targetEntityId"]) for e, p in st["edges"].items()})


async def _read(p, urns):
    """The same, as a reader serves it (a node's id is its urn here)."""
    nodes = {n.urn: n.display_name for n in await p.get_nodes(NodeQuery(urns=sorted(urns), limit=100))}
    edges = {e.id: (e.source_urn, e.target_urn)
             for e in await p.get_edges(EdgeQuery(edge_types=["FLOWS"], limit=100))}
    return nodes, edges


async def _agrees(root, gid, branch_id, urns):
    """The fork read through its overlay is what Postgres says it is; returns that."""
    want = await _state(root.svc, gid, branch_id)
    main = (await root.svc.fork_read_plan(gid))["main_id"]
    got = await _read(await root.reader(gid, None if branch_id == main else branch_id), urns)
    assert got == want
    return want


async def _rows_of(gid, seq):
    """How many version rows the graph's commit at ``seq`` wrote."""
    from sqlalchemy import func, select

    from backend.app.services.versioning import db
    from backend.app.services.versioning.models import EdgeVersionORM, NodeVersionORM
    async with db.graphver_session() as s:
        return sum([int(await s.scalar(select(func.count()).select_from(m).where(
            m.graph_id == gid, m.commit_seq == seq)) or 0) for m in (NodeVersionORM, EdgeVersionORM)])


async def _base(gid):
    from backend.app.services.versioning import db
    from backend.app.services.versioning.models import GraphORM
    from backend.app.services.versioning.service import fork_base_at
    async with db.graphver_session() as s:
        g = await s.get(GraphORM, gid)
        return await fork_base_at(s, g, g.main_head_commit_seq)


def test_a_clean_update_takes_the_parents_changes_and_writes_nothing():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _e("ab", "A", "B")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own",
                                ops=[_n("N"), _e("nb", "N", "B")])
            await root.edit([_u("A", "A two"), _n("C")])
            head = (await svc.get_graph(gid))["main_head_commit_seq"]
            urns = {"A", "B", "C", "N"}
            before = await _agrees(root, fgid, fmain, urns)
            assert before[0] == {"A": "A", "B": "B", "N": "N"}
            listed = {f["graph_id"]: f for f in await svc.list_forks(graph_id=gid, workspace_id="ws1",
                                                                     limit=10)}
            assert (listed[fgid]["behind"], listed[fgid]["update_recommended"]) == (2, False)

            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert (out["parent_seq"], out["wrote"], out["up_to_date"]) == (head, 0, False)
            assert await _agrees(root, fgid, fmain, urns) == (
                {"A": "A two", "B": "B", "C": "C", "N": "N"}, {"ab": ("A", "B"), "nb": ("N", "B")})
            fork = await svc.get_graph(fgid)
            assert await _base(fgid) == head
            assert await _rows_of(fgid, fork["main_head_commit_seq"]) == 0
            (entry,) = await svc.commit_log(graph_id=fgid, branch_id=fmain, limit=1)
            assert (entry["commit_id"], entry["kind"], entry["message"]) == (
                out["commit_id"], "sync_parent", f"Update from {gid}@{head}")

            # Up to date: nothing to do, and no commit.
            again = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert (again["up_to_date"], again["commit_id"], again["parent_seq"]) == (True, None, head)
            assert (await svc.get_graph(fgid))["main_head_commit_seq"] == fork["main_head_commit_seq"]

            # Time travel to before the update reads the old base.
            assert await _state(svc, fgid, fmain, as_of=fork["main_head_commit_seq"] - 1) == before

            # Its distance says so: nothing behind, no update to recommend.
            listed = {f["graph_id"]: f for f in await svc.list_forks(graph_id=gid, workspace_id="ws1",
                                                                     limit=10)}
            assert (listed[fgid]["behind"], listed[fgid]["update_recommended"]) == (0, False)

            with pytest.raises(NotAFork):
                await svc.update_fork_from_parent(fork_graph_id=gid, actor="alice")
    _run(case)


def test_a_conflicting_update_answers_its_conflicts_and_resolutions_settle_them():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await root.edit([_u("A", "A parent"), _u("B", "B parent")])
            head = (await svc.get_graph(fgid))["main_head_commit_seq"]
            with pytest.raises(ForkUpdateConflicts) as exc:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert [(c["entity_id"], c["path"], c["ours"], c["theirs"])
                    for c in exc.value.conflicts] == [("A", ["displayName"], "A fork", "A parent")]
            assert exc.value.detail["type"] == "fork_update_conflicts"
            assert exc.value.seeds["A"]["displayName"] == "A fork"
            assert (await svc.get_graph(fgid))["main_head_commit_seq"] == head      # nothing written
            assert await _base(fgid) == (await svc.get_graph(fgid))["fork_base_commit_seq"]

            resolved = {**exc.value.seeds["A"], "displayName": "A both"}
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob",
                                                    resolutions={"A": resolved})
            assert out["wrote"] == 1
            assert (await _agrees(root, fgid, fmain, {"A", "B"}))[0] == {"A": "A both", "B": "B parent"}
    _run(case)


def test_a_node_the_parent_deleted_takes_the_forks_edges_or_conflicts_with_its_edit():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _n("X")])
            fgid, fmain = await _fork(svc, gid)
            # The fork draws edges of its own to X and edits A; the parent deletes both.
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own",
                                ops=[_e("ax", "A", "X"), _e("xb", "X", "B"), _u("A", "A fork")])
            await root.edit([_d("X"), _d("A")])
            with pytest.raises(ForkUpdateConflicts) as exc:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert [(c["entity_id"], c["kind"]) for c in exc.value.conflicts] == [("A", "delete/modify")]
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob",
                                                    resolutions={"A": None})
            # A goes, as resolved, and the fork's own edges to X go with X.
            assert out["wrote"] == 3
            assert await _agrees(root, fgid, fmain, {"A", "B", "X"}) == ({"B": "B"}, {})
    _run(case)


def test_an_edge_the_parent_drew_to_a_node_the_fork_deleted_is_deleted_on_the_fork():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B"), _n("Y"), _e("ab", "A", "B")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_d("Y")])
            # The parent draws a new edge to Y and points an old one at it.
            await root.edit([_n("C"), _e("cy", "C", "Y"), _e("ca", "C", "A"), _ue("ab", "A", "Y")])
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert out["wrote"] == 2
            assert await _agrees(root, fgid, fmain, {"A", "B", "C", "Y"}) == (
                {"A": "A", "B": "B", "C": "C"}, {"ca": ("C", "A")})
    _run(case)


def test_a_fork_of_a_fork_updates_from_its_parent():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A")])
            mid, mmain = await _fork(svc, gid)
            leaf, lmain = await _fork(svc, mid)
            await root.edit([_n("R")])
            await svc.apply_ops(graph_id=mid, actor="bob", message="mid", ops=[_n("M")])
            # The middle fork takes the root's change; the leaf then the middle's, the root's in it.
            assert (await svc.update_fork_from_parent(fork_graph_id=mid, actor="bob"))["wrote"] == 0
            urns = {"A", "M", "R"}
            assert (await _agrees(root, mid, mmain, urns))[0] == {"A": "A", "M": "M", "R": "R"}
            assert (await _agrees(root, leaf, lmain, urns))[0] == {"A": "A"}
            assert (await svc.update_fork_from_parent(fork_graph_id=leaf, actor="carol"))["wrote"] == 0
            assert (await _agrees(root, leaf, lmain, urns))[0] == {"A": "A", "M": "M", "R": "R"}
    _run(case)


def test_a_draft_on_the_fork_is_behind_after_an_update_and_pull_latest_takes_it():
    """Read through the overlays too: the draft's over the fork's, which is over its root's key."""
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A")])
            fgid, fmain = await _fork(svc, gid)
            draft = await svc.open_draft(graph_id=fgid, owner="bob")
            await svc.apply_ops(graph_id=fgid, branch_id=draft, actor="bob", message="draft",
                                ops=[_n("D")])
            await root.edit([_n("P")])
            urns = {"A", "D", "P"}
            assert (await svc.branch_freshness(graph_id=fgid, branch_id=draft))["behind"] is False

            await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert (await _agrees(root, fgid, fmain, urns))[0] == {"A": "A", "P": "P"}
            assert (await svc.branch_freshness(graph_id=fgid, branch_id=draft))["behind"] is True
            assert (await _agrees(root, fgid, draft, urns))[0] == {"A": "A", "D": "D"}

            pulled = await svc.rebase_draft(graph_id=fgid, branch_id=draft, actor="bob")
            assert pulled["clean"] is True
            assert (await svc.branch_freshness(graph_id=fgid, branch_id=draft))["behind"] is False
            assert (await _agrees(root, fgid, draft, urns))[0] == {"A": "A", "D": "D", "P": "P"}
    _run(case)


def test_a_forks_cached_patch_set_follows_an_update(monkeypatch):
    """The overlay's cached patch set is keyed by the fork's head and the base each of its layers
    reads: an update moves both, so the next read builds it again; when only the root moves, the
    patch set held is extended by the root's changes, which stay out of the fork's reads."""
    from backend.app.providers import draft_overlay_provider as overlay
    from backend.app.services.versioning import service as versioning

    extended = []
    real = versioning._extended_patch
    monkeypatch.setattr(versioning, "_extended_patch", lambda *a: extended.append(1) or real(*a))

    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_n("N")])
            urns = {"A", "N", "P1", "P2"}

            async def seen():
                return set((await _read(await root.reader(fgid), urns))[0])

            def held():
                (key,) = [k for k in overlay._DELTAS._items if k[0] == fgid]
                return key

            await root.edit([_n("P1")], "p1")
            assert await seen() == {"A", "N"}
            first = held()
            await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert await seen() == {"A", "N", "P1"}
            built = held()
            assert built[2][1] != first[2][1] and not extended          # new bases: built again
            await root.edit([_n("P2")], "p2")
            assert await seen() == {"A", "N", "P1"}                      # P2 is not taken in
            assert held()[2][:2] == built[2][:2] and extended == [1]    # the same fork, extended
            await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert await seen() == urns and extended == [1]
    _run(case)


def test_an_update_that_writes_nothing_keeps_the_forks_review_approved():
    """A ``sync_parent`` commit that wrote no rows is no content, as a pull that rewrote nothing
    is not; one that wrote rows makes the review's approvals stale."""
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            pr = await svc.open_pr(source_graph_id=fgid, actor="bob", reviewers=["carol"])
            await svc.approve_pr(pr_id=pr, actor="carol")
            assert (await svc.get_pr(pr))["approval_status"] == "approved"

            await root.edit([_n("C")])
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob"))["wrote"] == 0
            assert (await svc.get_pr(pr))["approval_status"] == "approved"

            await root.edit([_u("A", "A parent")])
            with pytest.raises(ForkUpdateConflicts) as exc:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            out = await svc.update_fork_from_parent(
                fork_graph_id=fgid, actor="bob",
                resolutions={"A": {**exc.value.seeds["A"], "displayName": "A both"}})
            assert out["wrote"] == 1
            meta = await svc.get_pr(pr)
            assert (meta["approval_status"], meta["stale_approved_by"]) == ("pending", ["carol"])
    _run(case)


# ── what a resolution may do, and the gate on what an update writes ──────────────────────────
def test_a_resolution_for_something_not_in_conflict_is_refused():
    """A resolution settles a conflict the update raised, and nothing else: one for an entity in no
    conflict is refused, naming it, and nothing is written."""
    from backend.app.services.versioning.errors import ResolutionsWithoutConflict

    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            await root.edit([_u("A", "A parent"), _u("B", "B parent")])
            head = (await svc.get_graph(fgid))["main_head_commit_seq"]
            with pytest.raises(ForkUpdateConflicts) as exc:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            settled = {"A": {**exc.value.seeds["A"], "displayName": "A both"}}
            with pytest.raises(ResolutionsWithoutConflict) as refused:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob", resolutions={
                    **settled, "B": None, "X1": {"urn": "X1", "entityType": "Table"}})
            assert refused.value.status_code == 422
            assert refused.value.detail["ids"] == ["B", "X1"]
            assert (await svc.get_graph(fgid))["main_head_commit_seq"] == head
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob",
                                                      resolutions=settled))["wrote"] == 1
    _run(case)


def test_an_update_that_would_write_an_untyped_or_undeclared_node_is_refused_by_the_gate():
    """What an update writes faces the gate every write does: nothing created untyped, and under a
    strict ontology no undeclared type."""
    from backend.app.services.versioning.ontology import EntityRule, OntologyRules
    from backend.app.services.versioning.service import OntologyViolation

    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A")])
            fgid, _fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_d("A")])
            await root.edit([_u("A", "A parent")])
            with pytest.raises(ForkUpdateConflicts) as exc:
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            assert [c["kind"] for c in exc.value.conflicts] == ["delete/modify"]
            head = (await svc.get_graph(fgid))["main_head_commit_seq"]
            with pytest.raises(OntologyViolation):
                await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob", resolutions={
                    "A": {"displayName": "A kept"}})
            rules = OntologyRules(entity_types={"Table": EntityRule()})
            with pytest.raises(OntologyViolation):
                await svc.update_fork_from_parent(
                    fork_graph_id=fgid, actor="bob", ontology_rules=rules,
                    resolutions={"A": {"urn": "A", "entityType": "Whatever", "displayName": "A"}})
            assert (await svc.get_graph(fgid))["main_head_commit_seq"] == head
            out = await svc.update_fork_from_parent(
                fork_graph_id=fgid, actor="bob", ontology_rules=rules,
                resolutions={"A": {"urn": "A", "entityType": "Table", "displayName": "A kept"}})
            assert out["wrote"] == 1
    _run(case)


# ── history across an update ──────────────────────────────────────────────────────────────────
def test_reverting_an_update_or_restoring_past_one_is_refused():
    """An update changes the parent the fork reads, which no commit of the fork's own can take back:
    reverting it, or restoring to before it, is refused (crosses_update)."""
    from backend.app.services.versioning.errors import CrossesUpdate

    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, fmain = await _fork(svc, gid)
            await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
            before = (await svc.commit_log(graph_id=fgid, branch_id=fmain, limit=1))[0]["commit_id"]
            await root.edit([_e("ab", "A", "B")])
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            head = (await svc.get_graph(fgid))["main_head_commit_seq"]
            with pytest.raises(CrossesUpdate) as exc:
                await svc.revert_commit(graph_id=fgid, commit_id=out["commit_id"], actor="bob")
            assert (exc.value.status_code, exc.value.detail["type"]) == (409, "crosses_update")
            assert "fork again" in exc.value.detail["message"]
            with pytest.raises(CrossesUpdate):
                await svc.restore_to_commit(graph_id=fgid, commit_id=before, actor="bob")
            with pytest.raises(CrossesUpdate):
                await svc.restore_preview(graph_id=fgid, commit_id=before)
            assert (await svc.get_graph(fgid))["main_head_commit_seq"] == head
    _run(case)


def test_a_restore_within_one_base_still_works():
    async def case(svc):
        async with _projected(svc) as root:
            gid = await root.make([_n("A"), _n("B")])
            fgid, fmain = await _fork(svc, gid)
            await root.edit([_e("ab", "A", "B")])
            out = await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob")
            await svc.apply_ops(graph_id=fgid, actor="bob", message="later",
                                ops=[_u("A", "A fork"), _d("B")])
            preview = await svc.restore_preview(graph_id=fgid, commit_id=out["commit_id"])
            assert preview["edges"] == {"create": 1, "update": 0, "delete": 0}, preview
            assert await svc.restore_to_commit(graph_id=fgid, commit_id=out["commit_id"], actor="bob")
            assert await _agrees(root, fgid, fmain, {"A", "B"}) == (
                {"A": "A", "B": "B"}, {"ab": ("A", "B")})
    _run(case)
