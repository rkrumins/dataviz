"""The replace guard on a view and on a fork, and allowMassDelete past its early stop — Postgres.

Pins:
- A view's replace is judged on the view as main holds it, and on what its draft makes. A file
  naming the view's entities by other urns matches none of them and makes them all again outside
  the view: refused, and refused again when sent into the draft that holds its rows. Sent with
  allowMassDelete, it deletes the view's own entities and nothing else.
- A fork's replace is judged on the main it reads, its parent's and its own. A file naming the
  entities it inherits by other urns stops after its first window, and is refused at the end with
  the early stop off; a file that really leaves out part of the fork's main goes through.
- ``allowMassDelete`` takes a replace past the early stop too: a file that really replaces the
  graph, larger than a window, deletes what it leaves out.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export.import_worker import lease_job
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

#: The view's placements, as its scope resolver reads them on the import's draft.
VIEW = {"scope": None}


async def _scope(_ws, _ds, _view_id, _branch_id):
    return VIEW["scope"]


def _urn(key: str, i: int) -> str:
    return f"urn:{key}:{i}"


def _row(key: str, i: int) -> dict:
    return {"kind": "node", "urn": _urn(key, i), "entityType": "Table", "displayName": f"{key}{i}"}


def _chain(key: str, n: int) -> list:
    """``n`` nodes keyed ``key`` and an edge from each to the next: ``2n - 1`` entities."""
    return [_row(key, i) for i in range(n)] + [
        {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": _urn(key, i), "targetUrn": _urn(key, i + 1)}
        for i in range(n - 1)]


async def _run_job(ie, store, gid, lines, **kw):
    """An import by urn run the way the transfer lane runs it, so a refusal fails the job: its row."""
    key = storage_key("ws1", gid, "job", f"{os.urandom(3).hex()}.ndjson")
    body = ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

    async def _one():
        yield body
    await store.put_stream(key, _one())
    kw.setdefault("reconcile_mode", "replace")
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                     import_format="ndjson", source_uri=key, identifier="urn", **kw)
    lease = await lease_job(job["job_id"])
    await ie._run_safe(job["job_id"], lease, ie.run_import)
    return job, await ie.get_job(job["job_id"])


async def _published(svc, ie, store, gid, lines) -> None:
    job, got = await _run_job(ie, store, gid, lines, reconcile_mode="upsert")
    assert got["status"] == "completed", got
    await svc.publish(graph_id=gid, branch_id=job["branch_id"], actor="u", message="seed")


async def _urns(svc, gid, branch_id) -> set:
    state = await svc.materialize_state(graph_id=gid, branch_id=branch_id)
    return {p["urn"] for p in state["nodes"].values()}


def _counts(job) -> tuple:
    guard = job["summary"]["replaceGuard"]
    return guard["state"], guard["live"], guard["deletes"], guard["creates"]


def _run(case, monkeypatch):
    monkeypatch.setattr(config, "IMPORT_REPLACE_GUARD_MIN_LIVE", 10)

    async def run():
        await models.create_schema_and_partitions()
        root = tempfile.mkdtemp(prefix="replace-guard-")
        try:
            svc = GraphVersioningService()
            ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root),
                                     replace_scope_resolver=_scope)
            await case(svc, ie, ie.store)
        finally:
            shutil.rmtree(root, ignore_errors=True)
            await db.dispose_engine()
    asyncio.run(run())


async def _graph(svc, ie, store, lines) -> str:
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await _published(svc, ie, store, gid, lines)
    return gid


def test_a_views_replace_is_judged_on_the_view_as_main_holds_it(monkeypatch):
    async def case(svc, ie, store):
        # The view places twelve nodes (23 entities with their edges); three more are not its.
        gid = await _graph(svc, ie, store, _chain("v", 12) + [_row("x", i) for i in range(3)])
        VIEW["scope"] = {"assigned_urns": [_urn("v", i) for i in range(12)], "inherit_urns": [],
                         "containment_types": []}
        # The view's tables by other urns: by identifier=urn the file matches none of them, and
        # makes all 23 again outside the view.
        other = _chain("o", 12)
        job, got = await _run_job(ie, store, gid, other, scope_view_id="v1")
        assert got["status"] == "failed", got
        assert got["summary"]["failure"]["code"] == "mass_delete_blocked", got["summary"]
        assert _counts(got) == ("blocked", 23, 23, 23), got["summary"]["replaceGuard"]
        draft = job["branch_id"]
        # Sent again into that draft, its rows match what the first run made there, and the draft
        # still makes the view again: refused all the same.
        _job, again = await _run_job(ie, store, gid, other, scope_view_id="v1", branch_id=draft)
        assert (again["summary"]["unchanged"], again["summary"]["new"]) == (23, 0), again["summary"]
        assert _counts(again) == ("blocked", 23, 23, 23), again["summary"]["replaceGuard"]
        # With allowMassDelete it deletes the view's own entities, and nothing else.
        _job, allowed = await _run_job(ie, store, gid, other, scope_view_id="v1", branch_id=draft,
                                       allow_mass_delete=True)
        assert allowed["status"] == "completed", allowed
        assert _counts(allowed)[0] == "overridden" and allowed["summary"]["deleted"] == 23
        assert await _urns(svc, gid, draft) == (
            {_urn("o", i) for i in range(12)} | {_urn("x", i) for i in range(3)})
    _run(case, monkeypatch)


def test_a_forks_replace_is_judged_on_the_main_it_reads(monkeypatch):
    async def case(svc, ie, store):
        parent = await _graph(svc, ie, store, _chain("v", 12))
        fork = (await svc.fork_graph(parent_graph_id=parent, workspace_id="ws1", actor="u"))["graph_id"]
        other = _chain("o", 12)
        # Its first full window finds none of the 23 entities the fork reads: it stops there.
        monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 5)
        _job, stopped = await _run_job(ie, store, fork, other)
        assert stopped["status"] == "failed", stopped
        assert stopped["summary"]["failure"]["code"] == "identifier_matched_nothing", stopped["summary"]
        assert "in a graph of 23" in stopped["errorMessage"], stopped["errorMessage"]
        # With the early stop off, the guard refuses it at the end.
        monkeypatch.setattr(config, "IMPORT_REPLACE_MIN_MATCH_FRACTION", 0)
        _job, got = await _run_job(ie, store, fork, other)
        assert got["summary"]["failure"]["code"] == "mass_delete_blocked", got["summary"]
        assert _counts(got) == ("blocked", 23, 23, 23), got["summary"]["replaceGuard"]

        # A fork with twelve nodes of its own, over the 23 it inherits: a file that leaves out
        # eight of its own is a main that shrank by eight of 35, not a scope made again.
        own = [_row("f", i) for i in range(12)]
        await _published(svc, ie, store, fork, own)
        job, shrank = await _run_job(ie, store, fork, _chain("v", 12) + own[8:])
        assert shrank["status"] == "completed", shrank
        assert _counts(shrank) == ("passed", 35, 8, 0), shrank["summary"]["replaceGuard"]
        assert await _urns(svc, fork, job["branch_id"]) == (
            {_urn("v", i) for i in range(12)} | {_urn("f", i) for i in range(8, 12)})
    _run(case, monkeypatch)


def test_allow_mass_delete_takes_a_replace_past_the_early_stop_too(monkeypatch):
    async def case(svc, ie, store):
        gid = await _graph(svc, ie, store, _chain("v", 12))
        monkeypatch.setattr(config, "IMPORT_COMMIT_WINDOW", 5)
        # A file that really replaces the graph: none of its rows find an entity, and it is sent
        # with allowMassDelete, so it is read whole and deletes what it leaves out.
        job, got = await _run_job(ie, store, gid, _chain("o", 12), allow_mass_delete=True)
        assert got["status"] == "completed", got
        assert _counts(got) == ("overridden", 23, 23, 23), got["summary"]["replaceGuard"]
        assert got["summary"]["deleted"] == 23
        assert await _urns(svc, gid, job["branch_id"]) == {_urn("o", i) for i in range(12)}
    _run(case, monkeypatch)
