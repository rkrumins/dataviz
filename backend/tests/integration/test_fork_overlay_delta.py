"""A fork's main as a patch set over its root's store — needs Postgres.

A fork reads through its root's published store, as a draft reads through main's: its ``main`` is
the root at the root's head with the fork's patch set laid over it (``branch_overlay_delta``). The
patch set describes the fork's value at its head against the root's at the root's head, over the
entities either side changed since they parted: the fork's own changes, each fork between it and
the root up to the base the level below reads it at, and the root's changes since the outermost
base. It is built from hashes and version-row columns alone; a reader loads the fork's value of
what it serves (``overlay_payloads``). When only the root moved, an earlier patch set is extended
by the root's window instead of built again. Past ``GRAPHVER_FORK_REWIND_MAX`` candidates, a
fork reads Postgres instead.
"""
import asyncio
import contextlib
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _n(eid, name=None, **props):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name or eid,
                        **({"properties": props} if props else {})}}


def _u(eid, name, **props):
    return {**_n(eid, name, **props), "op": "update"}


def _e(eid, src, tgt, etype="FLOWS", **props):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt,
                        **({"properties": props} if props else {})}}


def _ue(eid, src, tgt, etype="FLOWS", **props):
    return {**_e(eid, src, tgt, etype, **props), "op": "update"}


def _d(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _graph(svc, ops):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=ops)
    return gid


async def _fork(svc, gid):
    f = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob")
    return f["graph_id"], f["main_branch_id"]


def _shape(delta):
    """A patch set as sets, its order aside."""
    return {
        "created": {n["entityId"] for n in delta["nodesUpsert"] if n.get("lazy")},
        "modified": {n["entityId"] for n in delta["nodesModified"]},
        "removed": {n["entityId"] for n in delta["nodesRemove"]},
        "new": set(delta["nodesNew"]),
        "edges": {e["id"]: (e["sourceUrn"], e["targetUrn"], e["edgeType"])
                  for e in delta["edgesUpsert"]},
        "edgesRemoved": {e["id"]: (e["sourceUrn"], e["targetUrn"], e["edgeType"])
                         for e in delta["edgesRemove"]},
    }


@contextlib.contextmanager
def _no_payload_read():
    """Every read that loads a version's payload raises."""
    names = ("_values_at", "_current_values", "_state_as_of", "_payloads_by_version",
             "_composed_state")
    saved = {n: getattr(GraphVersioningService, n) for n in names}

    def refuse(name):
        async def _refused(self, *a, **kw):
            raise AssertionError(f"the patch set read payloads ({name})")
        return _refused
    for n in names:
        setattr(GraphVersioningService, n, refuse(n))
    try:
        yield
    finally:
        for n, fn in saved.items():
            setattr(GraphVersioningService, n, fn)


def _run(case):
    async def go():
        await models.create_schema_and_partitions()
        try:
            await case(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(go())


def test_a_forks_patch_set_is_its_head_against_the_roots():
    async def case(svc):
        root = await _graph(svc, [_n("A"), _n("B"), _n("C"), _n("D"), _n("E"),
                                  _e("eAB", "A", "B"), _e("eCD", "C", "D", w=1)])
        fork, fmain = await _fork(svc, root)
        # The fork's own: a node made, one renamed, one deleted (its edge goes with it), an edge
        # drawn and an edge given a property; E as the root will have it.
        await svc.apply_ops(graph_id=fork, actor="bob", message="fork's own", ops=[
            _n("N"), _u("A", "A fork"), _d("B"), _e("eNA", "N", "A"), _ue("eCD", "C", "D", w=2),
            _u("E", "E both")])
        # The root's since: a node made, one renamed, one deleted (and its edge), E the same.
        await svc.apply_ops(graph_id=root, actor="alice", message="root's since", ops=[
            _n("P"), _u("C", "C root"), _d("D"), _u("E", "E both")])

        with _no_payload_read():
            delta = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain)
        assert _shape(delta) == {
            "created": {"N", "D"},                     # only the fork has them now
            "modified": {"A", "C"},                    # both have them, as different values
            "removed": {"B", "P"},                     # only the root has them now
            "new": {"N", "D"},
            "edges": {"eNA": ("N", "A", "FLOWS"),      # only the fork's: drawn on it, or its
                      "eCD": ("C", "D", "FLOWS")},     # root's since deleted with D
            "edgesRemoved": {"eAB": ("A", "B", "FLOWS")},
        }, delta
        created = {n["entityId"]: n for n in delta["nodesUpsert"]}
        assert created["D"]["displayName"] == "D" and created["D"]["entityType"] == "Table"

        # A reader loads the fork's value of what it serves: its own, or its parent's at the base.
        got = {n["entityId"]: n["displayName"] for n in await svc.overlay_payloads(
            graph_id=fork, branch_id=fmain, entity_ids=["A", "C", "D", "N"])}
        assert got == {"A": "A fork", "C": "C", "D": "D", "N": "N"}
        edge, = await svc.overlay_payloads(graph_id=fork, branch_id=fmain, entity_ids=["eCD"],
                                           kind="edge")
        assert edge["properties"] == {"w": 2}

        # The root's head, the fork's head and the base it reads are what the patch set depends on.
        v1 = await svc.overlay_version(graph_id=fork, branch_id=fmain)
        await svc.apply_ops(graph_id=root, actor="alice", message="more", ops=[_n("Q")])
        v2 = await svc.overlay_version(graph_id=fork, branch_id=fmain)
        await svc.apply_ops(graph_id=fork, actor="bob", message="more", ops=[_n("M")])
        v3 = await svc.overlay_version(graph_id=fork, branch_id=fmain)
        assert len({v1, v2, v3}) == 3
        assert await svc.overlay_version(graph_id=fork, branch_id=fmain) == v3
    _run(case)


def test_a_fork_of_a_fork_takes_each_fork_up_to_its_base():
    async def case(svc):
        root = await _graph(svc, [_n("A"), _n("B")])
        mid, mid_main = await _fork(svc, root)
        await svc.apply_ops(graph_id=mid, actor="bob", message="mid", ops=[
            _u("A", "A mid"), _n("X")])
        leaf, leaf_main = await _fork(svc, mid)
        # After the leaf's fork point: the middle fork's change is not the leaf's to read, the
        # root's is the root's to show and the leaf's to rewind.
        await svc.apply_ops(graph_id=mid, actor="bob", message="mid late", ops=[_u("B", "B mid")])
        await svc.apply_ops(graph_id=root, actor="alice", message="root", ops=[_u("B", "B root")])
        await svc.apply_ops(graph_id=leaf, actor="carol", message="leaf", ops=[_n("Y")])

        with _no_payload_read():
            delta = await svc.branch_overlay_delta(graph_id=leaf, branch_id=leaf_main)
        shape = _shape(delta)
        assert (shape["created"], shape["modified"], shape["removed"]) == (
            {"X", "Y"}, {"A", "B"}, set()), delta
        got = {n["entityId"]: n["displayName"] for n in await svc.overlay_payloads(
            graph_id=leaf, branch_id=leaf_main, entity_ids=["A", "B", "X", "Y"])}
        assert got == {"A": "A mid", "B": "B", "X": "X", "Y": "Y"}
    _run(case)


def test_when_only_the_root_moved_the_patch_set_is_extended():
    async def case(svc):
        root = await _graph(svc, [_n("A"), _n("B"), _n("C"), _e("eAB", "A", "B")])
        fork, fmain = await _fork(svc, root)
        await svc.apply_ops(graph_id=fork, actor="bob", message="fork", ops=[
            _u("A", "A fork"), _n("N")])
        before = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain)
        # The root renames what the fork renamed too, renames another, makes one and deletes one.
        await svc.apply_ops(graph_id=root, actor="alice", message="root", ops=[
            _u("A", "A fork"), _u("B", "B root"), _n("P"), _d("C")])
        whole = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain)

        saved = GraphVersioningService._head_index

        async def refused(self, *a, **kw):
            raise AssertionError("an extension read the fork's own changes again")
        GraphVersioningService._head_index = refused
        try:
            extended = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain, extend=before)
        finally:
            GraphVersioningService._head_index = saved
        assert _shape(extended) == _shape(whole) == {
            "created": {"N", "C"}, "modified": {"B"}, "removed": {"P"}, "new": {"N", "C"},
            "edges": {}, "edgesRemoved": {}}, (extended, whole)

        # A patch set of another fork head is not extended: it is built again.
        await svc.apply_ops(graph_id=fork, actor="bob", message="fork again", ops=[_d("N")])
        rebuilt = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain, extend=whole)
        assert _shape(rebuilt) == _shape(await svc.branch_overlay_delta(
            graph_id=fork, branch_id=fmain))
        assert "N" not in _shape(rebuilt)["created"]
    _run(case)


def test_past_the_ceiling_a_fork_reads_postgres(monkeypatch):
    async def case(svc):
        root = await _graph(svc, [_n("A"), _n("B")])
        fork, _fmain = await _fork(svc, root)
        await svc.apply_ops(graph_id=fork, actor="bob", message="fork", ops=[_n("N"), _n("M")])
        monkeypatch.setattr(config, "FORK_REWIND_MAX", 3)
        assert await svc.fork_reads_from(fork) == "overlay"
        await svc.apply_ops(graph_id=root, actor="alice", message="root", ops=[_u("A", "A2"),
                                                                               _u("B", "B2")])
        assert await svc.fork_reads_from(fork) == "postgres"
    _run(case)


def test_a_fork_reads_its_roots_key_at_the_version_the_key_holds_whole():
    """Behind its root's head, a fork reads the root's key at the version the key serves, while the
    key holds exactly that (idle since it published): its patch set is against the root there, so
    it reads as the fork does, at whatever base, and never shows a change its root made since. A
    key a pass may have written part of a window into — a window in flight, a pass that failed,
    one under way — holds no version whole: the fork reads its root from Postgres, at its head."""
    from sqlalchemy import update

    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
    from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
    from backend.app.services.context_engine import ContextEngine
    from backend.app.services.versioning.models import ProjectionStateORM

    key = object()                                   # the root's FalkorDB provider

    class _Registry:
        async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
            return key

    async def _root_key(root, **values):
        async with db.graphver_session() as s:
            await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == root)
                            .values(**{"status": "idle", "window_rows": None, "last_error": None,
                                       **values}))
            await s.commit()

    async def _reader(svc, fork, fmain):
        reader = await ContextEngine._fork_main_reader(_Registry(), None, "ws1", svc, fork, fmain,
                                                       "bob")
        assert isinstance(reader, DraftOverlayProvider)
        return reader

    async def case(svc):
        root = await _graph(svc, [_n("A"), _n("B"), _n("C")])                    # head 2
        fork, fmain = await _fork(svc, root)                                     # base 2
        await svc.apply_ops(graph_id=fork, actor="bob", message="fork's own", ops=[_u("A", "A fork")])
        await svc.apply_ops(graph_id=root, actor="alice", message="root's since",
                            ops=[_u("B", "B root")])                             # head 3
        late, lmain = await _fork(svc, root)                                     # base 3
        await svc.apply_ops(graph_id=root, actor="alice", message="more", ops=[_n("P")])  # head 4
        await _root_key(root, projected_commit_seq=2, served_commit_seq=2)       # the key: root@2

        # Over the key at 2: the fork's own change, and nothing of the root's since.
        reader = await _reader(svc, fork, fmain)
        assert reader._base is key and reader._root_at == {"root_at": 2}
        assert reader._version[2] == 2
        with _no_payload_read():
            at_key = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain, root_at=2)
            at_head = await svc.branch_overlay_delta(graph_id=fork, branch_id=fmain)
        assert (_shape(at_key)["modified"], _shape(at_key)["removed"]) == ({"A"}, set())
        assert (_shape(at_head)["modified"], _shape(at_head)["removed"]) == ({"A", "B"}, {"P"})
        # A fork based after the key's version takes the root's changes in between: B as at 3.
        with _no_payload_read():
            late_key = await svc.branch_overlay_delta(graph_id=late, branch_id=lmain, root_at=2)
        assert (_shape(late_key)["modified"], _shape(late_key)["removed"]) == ({"B"}, set())
        wm = await svc.projection_watermark(fork)
        assert (wm["served"], wm["read_route"]["main"]) == (2, "falkordb")
        assert (await svc.overlay_version(graph_id=fork, branch_id=fmain, root_at=2))[2] == 2

        # A key part-way through a window holds no version whole: the root from Postgres, at 4.
        for dirty in ({"window_rows": 300_000}, {"last_error": "projection apply failed"},
                      {"status": "projecting"}):
            await _root_key(root, projected_commit_seq=2, served_commit_seq=2, **dirty)
            reader = await _reader(svc, fork, fmain)
            assert isinstance(reader._base, VersionedBranchProvider), dirty
            assert reader._root_at == {} and reader._version[2] == 4, dirty
            wm = await svc.projection_watermark(fork)
            assert (wm["served"], wm["read_route"]["main"]) == (None, "postgres"), dirty

        # At its head, the key serves the fork as before.
        await _root_key(root, projected_commit_seq=4, served_commit_seq=4)
        reader = await _reader(svc, fork, fmain)
        assert reader._base is key and reader._root_at == {} and reader._version[2] == 4
    _run(case)
