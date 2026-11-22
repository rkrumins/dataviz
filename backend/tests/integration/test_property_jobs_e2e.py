"""Bulk property jobs against Postgres: one property operation over many entities of a draft,
written by the transfer lane a window at a time — each window one commit, recorded with the job's
checkpoint — and never on main.

* A window is one commit, named by the operation and its place; a worker superseded mid-job leaves
  no window half-written, and the job resumes from its cursor without writing one twice.
* The same Idempotency-Key is the same job; a second job on the draft, and its publish, wait for
  the first; a cancel stops it after its window, keeping what it wrote.
* A rename skips an entity that holds the new key, unless it overwrites; what a job could not write
  — not in the draft, deleted there, a conflict, refused by the write gate — is counted and listed.
* A search target is resolved by the job itself (a stub here: the search engine needs FalkorDB),
  and one that matches too much is refused as soon as it has matched more than a job edits; each
  match is checked again on the draft's values, and one the draft changed out of the search is
  left alone (``no_longer_matches``) — unless the search can't be checked that way, which the
  summary says. A draft closed under a job stops it, saying why.
* The routes: preview, create, follow, cancel, the refused rows as CSV.
* Relationships (an edge job): named by id — ``edge:<id>`` re-keyed ones by the id the graph calls
  them — or as a Connections search names one without (``source|TYPE|target``); deleted in the
  draft, a roll-up (refused ``derived``); a Connections search target; their routes, and the read
  the relationship drawer compares several relationships by.
* An undo puts back what a job's windows wrote, newest window first, from the draft's history — a
  rename's both keys, a clean-up's values in the kind they were, a relationship's properties, what
  a draft that pulled since held then; leaves one changed since alone (``changed_since``), listed;
  is one job a key, resumes and cancels as a job does; and is refused for a job published in whole
  or in part, undone already, that wrote nothing, or is an undo.
"""
import asyncio
import os

import pytest
from sqlalchemy import select, update

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.errors import BranchNotOpen, JobActive, UndoRefused
from backend.app.services.versioning.import_export.import_worker import lease_job
from backend.app.services.versioning.import_export.runner import TransferRunner
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Superseded
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.property_patch import PROP_DELETE

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")

RENAME = {"kind": "rename", "key": "owner", "to": "steward", "onConflict": "skip"}


def _node(i, etype="Dataset", **props):
    return {"op": "create", "entity_kind": "node", "entity_id": f"N{i}",
            "payload": {"urn": f"urn:n{i}", "entityType": etype, "displayName": f"N{i}",
                        "properties": props}}


async def _draft(owner="alice", nodes=None, n=8):
    """A graph seeded on main — ``n`` nodes holding ``owner``, unless ``nodes`` says — and a draft."""
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor=owner))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor=owner, message="seed",
                        ops=nodes or [_node(i, owner=f"o{i}") for i in range(n)])
    return svc, ds, gid, await svc.open_draft(graph_id=gid, owner=owner)


async def _create(ie, ds, gid, draft, op, target, key="key-property-0001", actor="alice"):
    return (await ie.create_property_job(workspace_id="ws1", data_source_id=ds, graph_id=gid,
                                         branch_id=draft, actor=actor, op=op, target=target,
                                         message=None, key=key))["job_id"]


async def _props(svc, gid, bid, eid):
    return ((await svc.entity_value(graph_id=gid, entity_id=eid, branch_id=bid)) or {}).get("properties")


async def _messages(gid, bid):
    async with db.graphver_session() as s:
        return list((await s.execute(select(models.CommitORM.message).where(
            models.CommitORM.graph_id == gid, models.CommitORM.branch_id == bid)
            .order_by(models.CommitORM.commit_seq))).scalars())


def _on_window(svc, n, hook):
    """Run ``hook()`` as the ``n``-th window starts to write (before its commit)."""
    real, calls = svc.apply_ops, []

    async def apply_ops(**kw):
        calls.append(kw["message"])
        if len(calls) == n:
            await hook()
        return await real(**kw)
    svc.apply_ops = apply_ops
    return calls


async def _csv(ie, job_id):
    return b"".join([c async for c in await ie.property_refused_rows(job_id)]).decode().splitlines()


# ── windows, commits, resume ──────────────────────────────────────────────────
async def _windows_and_resume(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(8)] + ["urn:nope"]
    job_id = await _create(ie, ds, gid, draft, RENAME, {"ids": ids})
    seeded = await _messages(gid, draft)

    # Another worker takes the job over while the second window writes: that window rolls back
    # with its checkpoint, and the superseded run stops.
    lease = await lease_job(job_id)
    _on_window(svc, 2, lambda: lease_job(job_id))
    with pytest.raises(Superseded):
        await ie.run_property(job_id, lease=lease)
    assert await _messages(gid, draft) == seeded + ["Bulk property: Rename owner → steward (1/3)"]
    assert await _props(svc, gid, draft, "N3") == {"owner": "o3"}

    # Resumed from its cursor: the windows after the first, each once.
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    summary = await ie.run_property(job_id)
    assert await _messages(gid, draft) == seeded + [
        f"Bulk property: Rename owner → steward ({i}/3)" for i in (1, 2, 3)]
    for i in range(8):
        assert await _props(svc, gid, draft, f"N{i}") == {"steward": f"o{i}"}
        assert await _props(svc, gid, None, f"N{i}") == {"owner": f"o{i}"}       # main untouched
    assert (summary["changed"], summary["missing"], summary["commits"]) == (8, 1, 3)
    assert summary["refused"]["byReason"] == {"missing": 1}
    job = await ie.get_property_job(job_id)
    assert (job["status"], job["progress"], job["processed"], job["total"]) == ("completed", 1.0, 9, 9)
    assert job["target"] == {"kind": "ids", "count": 9} and job["op"] == RENAME
    log = await svc.commit_log(graph_id=gid, branch_id=draft)
    by_message = {c["message"]: c["commit_id"] for c in log}
    assert job["summary"]["firstCommitId"] == by_message["Bulk property: Rename owner → steward (1/3)"]
    assert job["summary"]["lastCommitId"] == by_message["Bulk property: Rename owner → steward (3/3)"]
    assert await _csv(ie, job_id) == ["urn,entityId,reason,detail", "urn:nope,,missing,Not in this draft."]
    await db.dispose_engine()


def test_each_window_is_one_commit_and_a_superseded_job_resumes_without_repeating_one(monkeypatch):
    asyncio.run(_windows_and_resume(monkeypatch))


# ── the planner's statistics ──────────────────────────────────────────────────
async def _statistics(monkeypatch) -> None:
    from backend.app.services.versioning.import_export import property_job

    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    job_id = await _create(ie, ds, gid, draft, RENAME, {"ids": [f"urn:n{i}" for i in range(8)]})
    before, windows = len(await _messages(gid, draft)), []

    async def analyze(graph_id):
        assert graph_id == gid
        windows.append(len(await _messages(gid, draft)) - before)
    monkeypatch.setattr(property_job, "_analyze_graph", analyze)
    await ie.run_property(job_id)
    # Before the first window (main's rows, a publish's perhaps, not in them yet) and after it (the
    # draft's own): planned for a handful of rows, each id's read scanned the whole branch.
    assert windows == [0, 1]
    await db.dispose_engine()


def test_a_job_refreshes_the_planners_statistics_before_its_first_window_and_after_it(monkeypatch):
    asyncio.run(_statistics(monkeypatch))


# ── one at a time, idempotent, publish waits, cancel keeps what landed ─────────
async def _one_at_a_time(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(8)]
    first = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-first-0001")
    assert await _create(ie, ds, gid, draft, RENAME, {"ids": ids[:1]}, key="key-first-0001") == first
    with pytest.raises(JobActive) as busy:
        await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-second-001")
    assert busy.value.job_id == first
    with pytest.raises(JobActive, match="bulk property edit"):
        await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="too soon")
    assert await ie.active_draft_job(draft) == first

    # Cancelled as its second window writes: that window rolls back, the first stays.
    lease = await lease_job(first)
    _on_window(svc, 2, lambda: ie.cancel_property_job(first, actor="alice"))
    await ie.run_property_safe(first, lease)
    job = await ie.get_property_job(first)
    assert job["status"] == "cancelled" and job["summary"]["cancelled"] is True
    assert (job["summary"]["changed"], job["summary"]["commits"]) == (3, 1)
    assert [await _props(svc, gid, draft, f"N{i}") for i in (2, 3)] == [{"steward": "o2"}, {"owner": "o3"}]
    assert not await ie.cancel_property_job(first, actor="alice")                # ended already

    # The draft is free again: the next job runs, and the draft publishes once it is done.
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    second = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-second-001")
    await ie.run_property(second)
    assert (await ie.get_property_job(second))["summary"]["changed"] == 5
    assert await ie.active_draft_job(draft) is None
    await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="steward")
    assert await _props(svc, gid, None, "N7") == {"steward": "o7"}
    await db.dispose_engine()


def test_one_job_a_draft_its_key_once_publish_waits_and_cancel_keeps_written_windows(monkeypatch):
    asyncio.run(_one_at_a_time(monkeypatch))


# ── rename conflicts, deleted entities, the write gate ───────────────────────
async def _skips_and_refusals() -> None:
    svc, ds, gid, draft = await _draft(nodes=[
        _node(0, owner="a"), _node(1, owner="b", steward="x"), _node(2, other=1),
        _node(3, owner="d"), _node(4, "Legacy", owner="e"), _node(5, "Legacy", owner="f")])
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(4)]
    skip = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-skip-00001")
    summary = await ie.run_property(skip)
    assert (summary["changed"], summary["unchanged"], summary["conflicts"]) == (2, 1, 1)
    assert await _props(svc, gid, draft, "N1") == {"owner": "b", "steward": "x"}
    assert await _csv(ie, skip) == ["urn,entityId,reason,detail",
                                    "urn:n1,N1,conflict,It already has steward."]
    over = await _create(ie, ds, gid, draft, {**RENAME, "onConflict": "overwrite"}, {"ids": ids},
                         key="key-over-00001")
    assert (await ie.run_property(over))["changed"] == 1
    assert await _props(svc, gid, draft, "N1") == {"steward": "b"}

    # Deleted in the draft; refused by a strict ontology that no longer declares Legacy.
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="drop N3",
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "N3"}])
    async with db.graphver_session() as s:
        await s.execute(update(models.GraphORM).where(models.GraphORM.id == gid).values(
            ontology_spec={"entityTypes": ["Dataset"]}, ontology_enforcement="strict"))
    before = len(await _messages(gid, draft))
    tier = await _create(ie, ds, gid, draft, {"kind": "set", "key": "tier", "value": "gold",
                                              "onConflict": "skip"},
                         {"ids": ["urn:n0", "gv:N0", "urn:n3", "urn:n4", "urn:n5"]}, key="key-tier-00001")
    summary = await ie.run_property(tier)
    assert (summary["changed"], summary["unchanged"], summary["deletedInDraft"], summary["commits"]) == (1, 1, 1, 1)
    assert summary["refused"]["byReason"] == {"deleted_in_draft": 1, "write_refused": 2}
    assert len(await _messages(gid, draft)) == before + 1
    assert (await _props(svc, gid, draft, "N0"))["tier"] == "gold"
    assert "tier" not in await _props(svc, gid, draft, "N4")
    rows = await _csv(ie, tier)
    assert {r.split(",")[0] for r in rows[1:]} == {"urn:n3", "urn:n4", "urn:n5"}
    assert sum(",write_refused," in r for r in rows) == 2 and "urn:n3,N3,deleted_in_draft" in rows[1]
    assert PROP_DELETE not in str(await svc.entity_value(graph_id=gid, entity_id="N1", branch_id=draft))
    await db.dispose_engine()


def test_rename_skips_or_overwrites_and_every_entity_not_written_is_counted_and_listed():
    asyncio.run(_skips_and_refusals())


# ── a search target; too many matches; a draft closed under the job ──────────
async def _search_target(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)
    asked = []

    async def targets(job):
        asked.append(job["target"])
        for urn in ("urn:n0", "urn:n1", "urn:n2", "urn:gone"):
            yield urn

    svc, ds, gid, draft = await _draft(n=4)
    ie = ImportExportService(versioning=svc, property_targets=targets)
    search = {"viewId": "v1", "predicate": {"kind": "hasProperty", "key": "owner"}, "scopeMode": "view"}
    job_id = await _create(ie, ds, gid, draft, {"kind": "remove", "key": "owner", "onConflict": "skip"}, search)
    assert (await ie.get_property_job(job_id))["target"] == {"kind": "predicate", **search}
    await TransferRunner(lambda: ie).run_job(await lease_job(job_id))            # as the lane runs it
    summary = (await ie.get_property_job(job_id))["summary"]
    assert asked == [{"kind": "predicate", **search}]
    assert (summary["changed"], summary["missing"], summary["commits"]) == (3, 1, 2)          # 2 windows
    assert await _props(svc, gid, draft, "N2") == {} and await _props(svc, gid, draft, "N3") == {"owner": "o3"}
    assert (await ie.get_property_job(job_id))["total"] == 4

    monkeypatch.setattr(config, "PROPERTY_JOB_MAX_TARGETS", 3)
    too_many = await _create(ie, ds, gid, draft, {"kind": "remove", "key": "x", "onConflict": "skip"},
                             search, key="key-too-many-1")
    await ie.run_property_safe(too_many, await lease_job(too_many))
    job = await ie.get_property_job(too_many)
    assert job["status"] == "failed" and job["error"]["code"] == "too_many_targets", job
    await db.dispose_engine()


async def _too_big_search_ends_early(monkeypatch) -> None:
    """A search matching more than a job edits stops the job once it has matched one more —
    never reading the rest, and writing nothing."""
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)
    monkeypatch.setattr(config, "PROPERTY_JOB_MAX_TARGETS", 3)
    pulled = []

    async def targets(job):
        for i in range(1000):
            pulled.append(i)
            yield f"urn:n{i % 4}"

    svc, ds, gid, draft = await _draft(n=4)
    ie = ImportExportService(versioning=svc, property_targets=targets)
    search = {"viewId": "v1", "predicate": {"kind": "all"}, "scopeMode": "view"}
    seeded = await _messages(gid, draft)
    job_id = await _create(ie, ds, gid, draft, {"kind": "remove", "key": "owner", "onConflict": "skip"}, search)
    await ie.run_property_safe(job_id, await lease_job(job_id))
    job = await ie.get_property_job(job_id)
    assert job["status"] == "failed" and job["error"]["code"] == "too_many_targets", job
    assert "more than 3 entities" in job["error"]["message"]
    assert len(pulled) == 4 and await _messages(gid, draft) == seeded
    await db.dispose_engine()


def test_a_search_matching_too_much_stops_as_soon_as_it_has(monkeypatch):
    asyncio.run(_too_big_search_ends_early(monkeypatch))


async def _search_rechecked(monkeypatch) -> None:
    """The search runs on the published graph; each window checks its matches again on the
    draft's values and leaves alone what the draft changed out of it, as the Review step's
    draft-aware counts do. A search its values can't answer edits what it matched, and says so."""
    from backend.app.services.versioning.import_export import property_job

    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)

    async def targets(job):
        for urn in ("urn:n0", "urn:n1", "urn:n2"):        # gold on the published graph
            yield urn

    svc, ds, gid, draft = await _draft(nodes=[_node(i, tier="gold") for i in range(3)])
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="n1 is silver now",
                        ops=[{"op": "update", "entity_kind": "node", "entity_id": "N1",
                              "payload": {"properties": {"tier": "silver"}}}])
    ie = ImportExportService(versioning=svc, property_targets=targets)
    set_flag = {"kind": "set", "key": "flag", "value": "x", "onConflict": "skip"}
    gold = {"viewId": "v1", "scopeMode": "view",
            "predicate": {"kind": "property", "key": "tier", "op": "eq", "value": "gold"}}
    job_id = await _create(ie, ds, gid, draft, set_flag, gold)
    await TransferRunner(lambda: ie).run_job(await lease_job(job_id))
    job = await ie.get_property_job(job_id)
    summary = job["summary"]
    assert (summary["changed"], summary["noLongerMatches"]) == (2, 1), summary
    assert summary["refused"]["byReason"] == {"no_longer_matches": 1}
    assert summary["recheck"] == {"exact": True, "note": None}
    assert await _props(svc, gid, draft, "N1") == {"tier": "silver"}               # left alone
    assert (await _props(svc, gid, draft, "N2"))["flag"] == "x"
    assert await _csv(ie, job_id) == ["urn,entityId,reason,detail", "urn:n1,N1,no_longer_matches,"
                                      "In this draft it no longer matches the search."]

    # Under a container: where an entity sits isn't its own value, so every match is edited.
    under = {**gold, "predicate": {"kind": "descendantOf", "urns": ["urn:n0"]}}
    job_id = await _create(ie, ds, gid, draft, {**set_flag, "value": "y"}, under, key="key-recheck-002")
    await TransferRunner(lambda: ie).run_job(await lease_job(job_id))
    summary = (await ie.get_property_job(job_id))["summary"]
    assert (summary["changed"], summary["noLongerMatches"]) == (3, 0), summary
    assert summary["recheck"] == {"exact": False, "note": property_job.RECHECK_APPROXIMATE}
    await db.dispose_engine()


def test_a_search_target_is_checked_again_on_the_drafts_values(monkeypatch):
    asyncio.run(_search_rechecked(monkeypatch))


def test_a_search_target_is_resolved_by_the_job_and_one_matching_too_much_is_refused(monkeypatch):
    asyncio.run(_search_target(monkeypatch))


async def _draft_closed(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    job_id = await _create(ie, ds, gid, draft, RENAME, {"ids": [f"urn:n{i}" for i in range(8)]})
    _on_window(svc, 2, lambda: svc.abandon_draft(graph_id=gid, branch_id=draft, actor="alice"))
    await ie.run_property_safe(job_id, await lease_job(job_id))
    job = await ie.get_property_job(job_id)
    assert job["status"] == "failed" and job["error"]["code"] == "draft_closed", job
    assert "abandoned" in job["error"]["message"] and job["summary"]["commits"] == 1
    await db.dispose_engine()


def test_a_draft_closed_under_a_job_stops_it_saying_why(monkeypatch):
    asyncio.run(_draft_closed(monkeypatch))


# ── clean-ups write the kind they ask for; a publish lists the jobs it took ───
def _cleanup(kind, key, **kw):
    return {"kind": kind, "key": key, "onConflict": "skip", **kw}


async def _stats(gid, commit_id):
    async with db.graphver_session() as s:
        return (await s.execute(select(models.CommitORM.stats).where(
            models.CommitORM.graph_id == gid, models.CommitORM.id == commit_id))).scalar_one()


async def _cleanups_and_their_audit() -> None:
    from .test_main_activity import _events

    svc, ds, gid, draft = await _draft(nodes=[
        _node(0, dept="Finance", tier="42", score=1.0), _node(1, dept="finance ", tier=7, score=2.5),
        _node(2, dept="FINANCE", tier="x"), _node(3, dept=["fin  ops", "FIN OPS"], tier=1.0)])
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(4)]

    async def run(op, key, target=ids, message=None):
        job_id = (await ie.create_property_job(
            workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft, actor="alice",
            op=op, target={"ids": target}, message=message, key=key))["job_id"]
        return job_id, await ie.run_property(job_id)

    # A convert writes the kind asked for — over what a save would keep — and leaves what won't.
    convert = _cleanup("convert", "tier", toKind="Integer", onFail="skip")
    counts = await ie.preview_property_counts(graph_id=gid, branch_id=draft, op=convert, ids=ids)
    assert (counts["wouldChange"], counts["unconvertible"]) == (2, 1), counts
    convert_job, summary = await run(convert, "key-convert-0001", message="Tier is a number")
    assert (summary["changed"], summary["unchanged"], summary["unconvertible"]) == (2, 1, 1)
    assert summary["refused"]["byReason"] == {"unconvertible": 1}
    tiers = [(await _props(svc, gid, draft, f"N{i}"))["tier"] for i in range(4)]
    assert tiers == [42, 7, "x", 1] and [type(t) for t in tiers] == [int, int, str, int]
    assert await _csv(ie, convert_job) == [
        "urn,entityId,reason,detail", "urn:n2,N2,unconvertible,\"Its tier holds \"\"x\"\", which isn't an integer.\""]
    assert (await _props(svc, gid, None, "N0"))["tier"] == "42"                       # main untouched

    # A set of 1 over 1.0 is written as counted (a save would have kept 1.0).
    _job, summary = await run(_cleanup("set", "score", value=1), "key-set-score-01", ids[:2])
    assert summary["changed"] == 2
    assert [(await _props(svc, gid, draft, f"N{i}"))["score"] for i in (0, 1)] == [1, 1]
    assert type((await _props(svc, gid, draft, "N0"))["score"]) is int

    # Near-duplicates merged; a list normalised; text replaced in any case.
    merge = _cleanup("mapValues", "dept", map=[
        {"from": "finance ", "fromKind": "String", "to": "Finance", "toKind": "String"},
        {"from": "FINANCE", "fromKind": "String", "to": "Finance", "toKind": "String"}], dedupeList=True)
    _job, summary = await run(merge, "key-merge-dept-1")
    assert (summary["changed"], summary["unchanged"]) == (2, 2)
    _job, summary = await run(_cleanup("normalize", "dept", trim=True, collapseSpaces=True, case="lower",
                                       dedupeList=True), "key-normalize-01", ids[3:])
    assert summary["changed"] == 1 and (await _props(svc, gid, draft, "N3"))["dept"] == ["fin ops"]
    _job, summary = await run(_cleanup("replace", "dept", find="FIN", replaceWith="Fin", matchCase=False,
                                       wholeValue=False), "key-replace-0001")
    assert (summary["changed"], summary["unchanged"]) == (1, 3)
    assert [(await _props(svc, gid, draft, f"N{i}"))["dept"] for i in range(4)] == [
        "Finance", "Finance", "Finance", ["Fin ops"]]
    # One that changes nothing writes no commit, and a publish has nothing of it to list.
    _job, summary = await run(_cleanup("replace", "dept", find="zzz", replaceWith="y"), "key-replace-0002")
    assert summary["commits"] == 0

    # The publish lists every job that wrote to the draft, oldest first, and stamps each.
    published = await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="Clean up")
    listed = (await _stats(gid, published))["propertyJobs"]
    assert listed["total"] == 5 and [j["label"] for j in listed["jobs"]] == [
        "Convert tier to Integer", "Set score", "Merge 2 values of dept",
        "Normalize dept (trim, collapse spaces, lower case, each value once)", "Replace “FIN” → “Fin” in dept"]
    first = listed["jobs"][0]
    assert (first["jobId"], first["changed"], first["refused"], first["actor"], first["message"],
            first["status"]) == (convert_job, 2, 1, "alice", "Tier is a number", "completed")
    job = await ie.get_property_job(convert_job)
    assert job["summary"]["publishedCommitId"] == published
    assert (await ie.get_property_job(_job))["summary"].get("publishedCommitId") is None    # wrote nothing
    assert (await _props(svc, gid, None, "N0"))["tier"] == 42                             # on main, as converted

    # Its activity event carries them, and says so.
    from backend.app.services.activity import catalogue
    [event] = [p for t, p in await _events(ds) if t == "workspace.versioning.published"]
    assert event["details"]["propertyJobs"] == listed and "jobId" not in event["details"]
    assert catalogue.summarize("workspace.versioning.published", {**event, "target_label": "Sales"})[1] == (
        "Published 4 changes to Sales, including Convert tier to Integer and 4 more bulk edits")

    # A later publish lists none of them again.
    again = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=again, actor="alice", message="one more",
                        ops=[{"op": "update", "entity_kind": "node", "entity_id": "N1",
                              "payload": {"properties": {"tier": 8}}}])
    later = await svc.publish(graph_id=gid, branch_id=again, actor="alice", message="later")
    assert "propertyJobs" not in (await _stats(gid, later))
    await db.dispose_engine()


def test_clean_ups_write_the_kind_they_ask_for_and_a_publish_lists_the_jobs_it_took():
    asyncio.run(_cleanups_and_their_audit())


async def _partial_merge() -> None:
    """A review merged in part lists a job all of whose changes landed (and stamps it), lists one
    only some of whose did as partial (unstamped), and leaves out one none of whose did; the
    review that merges the rest lists what is left."""
    cont = ["CONTAINS"]
    svc, ds, gid, draft = await _draft(n=5)
    ie = ImportExportService(versioning=svc)
    rename = await _create(ie, ds, gid, draft, RENAME, {"ids": ["urn:n0", "urn:n1"]}, key="key-partial-001")
    await ie.run_property(rename)
    tier = await _create(ie, ds, gid, draft, {"kind": "set", "key": "tier", "value": "gold", "onConflict": "skip"},
                         {"ids": ["urn:n2"]}, key="key-partial-002")
    await ie.run_property(tier)
    gone = await _create(ie, ds, gid, draft, {"kind": "remove", "key": "owner", "onConflict": "skip"},
                         {"ids": ["urn:n3"]}, key="key-partial-003")
    await ie.run_property(gone)

    pr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="alice", title="Stewards")
    await svc.decide_changes(pr_id=pr, actor="bo", verdict="accepted", entity_ids=["N0", "N2"],
                             containment_edge_types=cont)
    await svc.decide_changes(pr_id=pr, actor="bo", verdict="rejected", entity_ids=["N1", "N3"],
                             reason="Later", containment_edge_types=cont)
    # What a job wrote, and how much of it lands, is counted in SQL on the draft's changeset.
    async with db.graphver_session() as s:
        row = await s.get(models.JobORM, rename)
        assert await svc._property_job_entities(s, gid, draft, row, {"N0", "N2"}) == (2, 1)
        assert await svc._property_job_entities(s, gid, draft, row, set()) == (2, 0)
    part = await svc.merge_mr(mr_id=pr, actor="cy", message="Some", containment_edge_types=cont, mode="accepted")
    listed = (await _stats(gid, part))["propertyJobs"]
    assert [(j["jobId"], j.get("partial", False)) for j in listed["jobs"]] == [(rename, True), (tier, False)]
    assert (await ie.get_property_job(rename))["summary"].get("publishedCommitId") is None
    # Part of it is on main: said so, for what reads the job (an undo refuses it).
    assert (await ie.get_property_job(rename))["summary"]["landedCommitIds"] == [part]
    assert "landedCommitIds" not in (await ie.get_property_job(tier))["summary"]
    assert (await ie.get_property_job(tier))["summary"]["publishedCommitId"] == part
    assert (await ie.get_property_job(gone))["summary"].get("publishedCommitId") is None

    rest = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="alice", title="The rest")
    merged = await svc.merge_mr(mr_id=rest, actor="cy", message="Rest", containment_edge_types=cont)
    listed = (await _stats(gid, merged))["propertyJobs"]
    assert [(j["jobId"], j.get("partial", False)) for j in listed["jobs"]] == [(rename, False), (gone, False)]
    for job_id in (rename, gone):
        assert (await ie.get_property_job(job_id))["summary"]["publishedCommitId"] == merged
    await db.dispose_engine()


def test_a_review_merged_in_part_lists_the_jobs_whose_changes_landed():
    asyncio.run(_partial_merge())


# ── the routes ────────────────────────────────────────────────────────────────
async def _routes() -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints.versioning import get_import_export_service
    from .test_versioning_main_write_publish import MIA, PAT, V1, _app

    svc, ds, gid, draft = await _draft(owner="pat", n=2)
    main = await svc.main_branch_id(gid)
    app, _G = _app()
    ie = get_import_export_service()
    ids = ["urn:n0", "urn:n1", "urn:nope"]
    body = {"op": RENAME, "target": {"ids": ids}}
    jobs = f"{V1}/graphs/{gid}/branches/{draft}/property-jobs"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"{jobs}/preview", json=body, headers=PAT)
        assert r.status_code == 200, r.text
        preview = r.json()
        assert preview["refusal"] is None and preview["activeJobId"] is None
        assert preview["counts"] == {"matched": 2, "haveKey": 2, "haveTo": 0, "missing": 1,
                                     "wouldChange": 2, "unconvertible": None}
        assert preview["nameBudget"]["verdict"] == "ok" and preview["nameBudget"]["ceiling"] == 65_534
        assert preview["warnings"] == []                  # no field rules here: nothing publishing refuses
        reserved = {"op": {"kind": "set", "key": "displayName", "value": "x"}, "target": {"ids": ids}}
        r = await c.post(f"{jobs}/preview", json=reserved, headers=PAT)
        assert r.json()["refusal"]["code"] == "reserved_key", r.text
        r = await c.post(f"{V1}/graphs/{gid}/branches/{main}/property-jobs/preview", json=body, headers=PAT)
        assert r.json()["refusal"]["code"] == "main_write_forbidden", r.text
        unseen = {"op": RENAME, "target": {"viewId": "v_nope", "predicate": {"kind": "hasProperty", "key": "owner"}}}
        r = await c.post(f"{jobs}/preview", json=unseen, headers=PAT)
        assert r.json()["refusal"]["code"] == "view_not_found", r.text

        key = {**PAT, "Idempotency-Key": "key-route-0001"}
        assert (await c.post(jobs, json=body, headers=PAT)).status_code == 422          # no key
        r = await c.post(jobs, json=reserved, headers=key)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "reserved_key", r.text
        r = await c.post(jobs, json=unseen, headers=key)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "view_not_found", r.text
        r = await c.post(f"{V1}/graphs/{gid}/branches/{main}/property-jobs", json=body, headers=key)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "main_write_forbidden", r.text
        r = await c.post(jobs, json=body, headers=key)
        assert r.status_code == 202, r.text
        job = r.json()
        assert (job["status"], job["phase"], job["target"], job["progress"]) == (
            "pending", "queued", {"kind": "ids", "count": 3}, 0.0)
        again = await c.post(jobs, json=body, headers=key)
        assert again.status_code == 202 and again.json()["jobId"] == job["jobId"]
        r = await c.post(jobs, json=body, headers={**PAT, "Idempotency-Key": "key-route-0002"})
        assert r.status_code == 409, r.text
        assert (r.json()["detail"]["code"], r.json()["detail"]["jobId"]) == ("job_active", job["jobId"])
        assert (await c.post(f"{jobs}/preview", json=body, headers=PAT)).json()["activeJobId"] == job["jobId"]

        await ie.run_property(job["jobId"])
        url = f"{V1}/graphs/{gid}/property-jobs/{job['jobId']}"
        r = await c.get(url, headers=PAT)
        assert r.status_code == 200, r.text
        done = r.json()
        assert (done["status"], done["progress"], done["error"]) == ("completed", 1.0, None)
        assert {k: done["summary"][k] for k in ("changed", "missing", "commits")} == {
            "changed": 2, "missing": 1, "commits": 1}
        r = await c.get(f"{url}/refused", params={"format": "csv"}, headers=PAT)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv"), r.text
        assert r.text.splitlines()[1] == "urn:nope,,missing,Not in this draft."
        r = await c.post(f"{url}/cancel", headers=PAT)
        assert r.status_code == 200 and r.json()["status"] == "completed"
        # Someone who can't read pat's private draft doesn't see its jobs.
        assert (await c.get(url, headers=MIA)).status_code == 404
        other = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                        actor="pat"))["graph_id"]
        assert (await c.get(f"{V1}/graphs/{other}/property-jobs/{job['jobId']}", headers=PAT)).status_code == 404
    await db.dispose_engine()


def test_the_routes_preview_create_follow_cancel_and_list_refused_rows():
    asyncio.run(_routes())


# ── relationships ─────────────────────────────────────────────────────────────
def _edge(eid, src, tgt, etype="FLOWS_TO", **props):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt, "properties": props}}


#: N0 → N1 → N2 → N3 and more: E3 kept as ``edge:E3`` (a graph copied in re-keys an edge whose id a
#: node held, and still calls it E3), E4 found by its ends and type, E5 deleted in the draft, R1 a
#: roll-up.
EDGE_KEYS = ["E1", "E2", "E3", "urn:n0|FEEDS|urn:n2", "E5", "R1", "nope", "urn:n0|NOPE|urn:n1"]


async def _edge_draft(owner="alice"):
    svc, ds, gid, draft = await _draft(owner=owner, nodes=[_node(i) for i in range(4)] + [
        _edge("E1", "N0", "N1", owner="a"), _edge("E2", "N1", "N2", owner="b", steward="x"),
        _edge("edge:E3", "N2", "N3", owner="c"), _edge("E4", "N0", "N2", "FEEDS"),
        _edge("E5", "N0", "N3", owner="d"), _edge("R1", "N0", "N3", "AGGREGATED", owner="r")])
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor=owner, message="drop E5",
                        ops=[{"op": "delete", "entity_kind": "edge", "entity_id": "E5"}])
    return svc, ds, gid, draft


async def _edge_jobs() -> None:
    svc, ds, gid, draft = await _edge_draft()
    ie = ImportExportService(versioning=svc)
    job_id = await ie.create_property_job(
        workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft, actor="alice", op=RENAME,
        target={"ids": EDGE_KEYS}, message=None, key="key-edges-00001", entity_kind="edge")
    summary = await ie.run_property(job_id["job_id"])
    assert (summary["changed"], summary["unchanged"], summary["conflicts"], summary["deletedInDraft"],
            summary["missing"], summary["commits"]) == (2, 1, 1, 1, 2, 1)
    assert summary["refused"]["byReason"] == {"conflict": 1, "deleted_in_draft": 1, "missing": 2, "derived": 1}
    assert await _props(svc, gid, draft, "E1") == {"steward": "a"}
    assert await _props(svc, gid, draft, "edge:E3") == {"steward": "c"}        # by the id the graph calls it
    assert await _props(svc, gid, draft, "E2") == {"owner": "b", "steward": "x"}
    assert await _props(svc, gid, draft, "R1") == {"owner": "r"}               # a roll-up is never edited
    assert await _props(svc, gid, None, "E1") == {"owner": "a"}                # main untouched
    assert (await svc.entity_value(graph_id=gid, entity_id="E1", branch_id=draft))["targetEntityId"] == "N1"
    job = await ie.get_property_job(job_id["job_id"])
    assert (job["entityKind"], job["target"]) == ("edge", {"kind": "ids", "count": len(EDGE_KEYS)})
    rows = {r.split(",")[0]: r for r in (await _csv(ie, job_id["job_id"]))[1:]}
    assert rows["E2"].startswith("E2,E2,conflict") and rows["E5"].startswith("E5,E5,deleted_in_draft")
    assert rows["R1"].startswith("R1,R1,derived") and rows["nope"] == "nope,,missing,Not in this draft."

    # Named twice — by its id and by its ends — an edge is written once.
    tier = await ie.create_property_job(
        workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft, actor="alice",
        op={"kind": "set", "key": "tier", "value": "gold", "onConflict": "skip"},
        target={"ids": ["urn:n0|FEEDS|urn:n2", "E4"]}, message=None, key="key-edges-00002", entity_kind="edge")
    summary = await ie.run_property(tier["job_id"])
    assert (summary["changed"], summary["unchanged"]) == (1, 1)
    assert await _props(svc, gid, draft, "E4") == {"tier": "gold"}
    assert (await ie.get_property_job(tier["job_id"]))["entityKind"] == "edge"

    counts = await ie.preview_property_counts(graph_id=gid, branch_id=draft, op=RENAME, ids=EDGE_KEYS,
                                              entity_kind="edge")
    assert counts == {"matched": 4, "haveKey": 1, "haveTo": 3, "missing": 3, "derived": 1,
                      "wouldChange": 0, "unconvertible": None}
    await db.dispose_engine()


def test_an_edge_job_edits_relationships_by_id_by_their_ends_and_never_a_roll_up():
    asyncio.run(_edge_jobs())


async def _edge_search(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)
    asked = []

    async def targets(job):
        asked.append((job["entityKind"], job["target"]["predicate"]))
        for key in ("E1", "urn:n0|FEEDS|urn:n2", "E2", "R1"):
            yield key

    svc, ds, gid, draft = await _edge_draft()
    ie = ImportExportService(versioning=svc, property_targets=targets)
    search = {"viewId": "v1", "predicate": {"kind": "edges", "edgeTypes": ["FLOWS_TO"]}, "scopeMode": "view"}
    job_id = (await ie.create_property_job(
        workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft, actor="alice",
        op={"kind": "remove", "key": "owner", "onConflict": "skip"}, target=search, message=None,
        key="key-edge-search1", entity_kind="edge"))["job_id"]
    await TransferRunner(lambda: ie).run_job(await lease_job(job_id))
    job = await ie.get_property_job(job_id)
    assert asked == [("edge", search["predicate"])] and job["status"] == "completed", job
    assert (job["summary"]["changed"], job["summary"]["unchanged"], job["summary"]["commits"]) == (2, 1, 2)
    assert job["summary"]["refused"]["byReason"] == {"derived": 1}
    assert await _props(svc, gid, draft, "E1") == {} and await _props(svc, gid, draft, "E2") == {"steward": "x"}
    await db.dispose_engine()


def test_a_connections_search_target_edits_every_relationship_it_matches(monkeypatch):
    asyncio.run(_edge_search(monkeypatch))


async def _edge_routes() -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints.versioning import get_import_export_service
    from .test_versioning_main_write_publish import MIA, PAT, V1, _app

    svc, ds, gid, draft = await _edge_draft(owner="pat")
    app, _G = _app()
    ie = get_import_export_service()
    body = {"op": RENAME, "target": {"edgeIds": EDGE_KEYS}}
    jobs = f"{V1}/graphs/{gid}/branches/{draft}/property-jobs"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"{jobs}/preview", json=body, headers=PAT)
        assert r.status_code == 200, r.text
        preview = r.json()
        assert preview["refusal"] is None and preview["nameBudget"]["verdict"] == "ok"
        assert preview["counts"] == {"matched": 4, "haveKey": 3, "haveTo": 1, "missing": 3, "derived": 1,
                                     "wouldChange": 2, "unconvertible": None}
        reserved = {"op": {"kind": "set", "key": "confidence", "value": 1}, "target": {"edgeIds": ["E1"]}}
        assert (await c.post(f"{jobs}/preview", json=reserved, headers=PAT)).json()["refusal"]["code"] == "reserved_key"
        r = await c.post(jobs, json=body, headers={**PAT, "Idempotency-Key": "key-edge-route-1"})
        assert r.status_code == 202, r.text
        assert (r.json()["entityKind"], r.json()["target"]) == ("edge", {"kind": "ids", "count": len(EDGE_KEYS)})
        await ie.run_property(r.json()["jobId"])
        assert await _props(svc, gid, draft, "edge:E3") == {"steward": "c"}

        # Several relationships read as the draft has them, each with the token an edit is sent with.
        read = f"{V1}/graphs/{gid}/edges/read"
        refs = [{"id": "E1"}, {"id": "E3"}, {"id": "bundle:x", "source": "urn:n0", "target": "urn:n2",
                                             "edgeType": "FEEDS"}, {"id": "E5"}, {"id": "nope"}]
        r = await c.post(read, params={"branchId": draft}, json={"refs": refs}, headers=PAT)
        assert r.status_code == 200, r.text
        got = r.json()
        by_id = {e["id"]: e for e in got["edges"]}
        assert [e["id"] for e in got["edges"]] == ["E1", "E3", "bundle:x"]
        assert (got["deleted"], got["missing"]) == (["E5"], ["nope"])
        assert (by_id["E3"]["entityId"], by_id["E3"]["properties"]) == ("edge:E3", {"steward": "c"})
        assert (by_id["bundle:x"]["entityId"], by_id["bundle:x"]["edgeType"]) == ("E4", "FEEDS")
        assert (by_id["E1"]["sourceEntityId"], by_id["E1"]["targetEntityId"]) == ("N0", "N1")
        summary = await c.get(f"{V1}/graphs/{gid}/entities/E1/summary",
                              params={"branchId": draft, "kind": "edge", "include": "value"}, headers=PAT)
        assert by_id["E1"]["version"] == summary.json()["version"], summary.text
        r = await c.post(read, json={"refs": refs}, headers=PAT)                    # main, as published
        assert {e["id"]: e["properties"] for e in r.json()["edges"]}["E1"] == {"owner": "a"}
        assert "E5" in {e["id"] for e in r.json()["edges"]} and r.json()["deleted"] == []
        assert (await c.post(read, params={"branchId": draft}, json={"refs": refs}, headers=MIA)).status_code == 404
        assert (await c.post(read, json={"refs": []}, headers=PAT)).status_code == 422
    await db.dispose_engine()


def test_the_edge_routes_preview_create_and_read_several_relationships():
    asyncio.run(_edge_routes())


# ── the preview's sample: a few entities, before and after ────────────────────
def _sample_search(monkeypatch, *, hits=(), edges=(), refuse=None):
    """``…/preview/sample``'s search over a stub engine (the search engine needs FalkorDB): one page
    of ``hits`` (urns), or of a Connections search's ``edges`` (ids) — the view readable. Returns
    the queries it was asked."""
    from types import SimpleNamespace
    from backend.app.api.v1.endpoints import graph as graph_ep, versioning as versioning_ep
    from backend.app.services import advanced_search_service
    from backend.app.services.view_transfer import sources

    asked = []

    class Search:
        def __init__(self, engine, **kw):
            self.can_read = kw["can_read_view"]

        async def search(self, query, run_context=None):
            if refuse:
                raise advanced_search_service.ValidationError(refuse)
            asked.append(query)
            return SimpleNamespace(hits=[SimpleNamespace(node=SimpleNamespace(urn=u)) for u in hits],
                                   edges=[SimpleNamespace(id=e) for e in edges]), None

    async def engine_for(*_a, **_kw):
        return SimpleNamespace(provider=SimpleNamespace())

    async def readable(*_a, **_kw):
        return True

    async def data_version(_engine):
        return "dv1"

    monkeypatch.setattr(advanced_search_service, "AdvancedSearchService", Search)
    monkeypatch.setattr(sources, "engine_for", engine_for)
    monkeypatch.setattr(versioning_ep, "_property_job_view_readable", readable)
    monkeypatch.setattr(graph_ep, "_search_data_version", data_version)
    monkeypatch.setattr(graph_ep, "_statement_admission", lambda _engine: None)
    return asked


async def _sample(monkeypatch) -> None:
    """A few entities before and after, read on the draft as a window reads them — named by id
    (new in the draft too), or a search's first page checked again on the draft's values — and
    each planned as the job plans it: changed, unchanged, or skipped and why."""
    from httpx import ASGITransport, AsyncClient
    from .test_versioning_main_write_publish import MIA, PAT, V1, _app

    svc, ds, gid, draft = await _draft(owner="pat", nodes=[
        _node(0, tier="gold", owner="o0"), _node(1, tier="gold", owner="o1", steward="s1"),
        _node(2, tier="gold"), _node(3, tier="gold", owner="o3"), _node(4, tier="gold", owner="o4")])
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="pat", message="draft edits", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "N4", "payload": {"properties": {"tier": "silver"}}},
        {"op": "delete", "entity_kind": "node", "entity_id": "N3"}, _node(9, "Table", tier="gold", owner="o9")])
    main = await svc.main_branch_id(gid)
    app, _G = _app()
    sample = f"{V1}/graphs/{gid}/branches/{draft}/property-jobs/preview/sample"
    ids = ["urn:n0", "gv:N1", "urn:n2", "urn:n3", "urn:nope", "gv:N9", "gv:N0"]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(sample, json={"op": RENAME, "target": {"ids": ids}}, headers=PAT)
        assert r.status_code == 200, r.text
        assert r.json() == {"truncated": False, "rows": [
            {"id": "N0", "urn": "urn:n0", "name": "N0", "type": "Dataset", "before": "o0", "after": "o0",
             "outcome": "change"},
            {"id": "N1", "urn": "urn:n1", "name": "N1", "type": "Dataset", "before": "o1", "to": "s1",
             "after": "s1", "outcome": "skip", "reason": "conflict"},
            {"id": "N2", "urn": "urn:n2", "name": "N2", "type": "Dataset", "outcome": "unchanged"},
            {"id": "urn:n3", "name": "urn:n3", "type": None, "outcome": "skip", "reason": "missing"},
            {"id": "urn:nope", "name": "urn:nope", "type": None, "outcome": "skip", "reason": "missing"},
            {"id": "N9", "urn": "urn:n9", "name": "N9", "type": "Table", "before": "o9", "after": "o9",
             "outcome": "change"}]}                                   # gv:N0 is N0 again: one row
        many = {"op": RENAME, "target": {"ids": [f"urn:x{i}" for i in range(9)]}}
        r = await c.post(sample, json=many, headers=PAT)
        assert (len(r.json()["rows"]), r.json()["truncated"]) == (8, True), r.text

        # A search's first page, on the draft: N4 matched as published, and the draft made it silver.
        asked = _sample_search(monkeypatch, hits=["urn:n0", "urn:n4", "urn:n2"])
        gold = {"viewId": "v1", "scopeMode": "view",
                "predicate": {"kind": "property", "key": "tier", "op": "eq", "value": "gold"}}
        r = await c.post(sample, json={"op": RENAME, "target": gold}, headers=PAT)
        assert r.status_code == 200, r.text
        assert [(row["id"], row["outcome"], row.get("reason")) for row in r.json()["rows"]] == [
            ("N0", "change", None), ("N4", "skip", "no_longer_matches"), ("N2", "unchanged", None)]
        assert r.json()["rows"][1]["before"] == "o4" and r.json()["truncated"] is False
        query = asked[0]
        assert (query.scope.view_id, query.scope.scope_mode, query.options.results, query.options.page_size) == (
            "v1", "view", "hits", 9)

        _sample_search(monkeypatch, refuse="view_not_found: view 'v1' not found")
        r = await c.post(sample, json={"op": RENAME, "target": gold}, headers=PAT)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "search_refused", r.text
        r = await c.post(f"{V1}/graphs/{gid}/branches/{main}/property-jobs/preview/sample",
                         json={"op": RENAME, "target": {"ids": ids}}, headers=PAT)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "main_write_forbidden", r.text
        # Someone who can't read pat's private draft can't read its entities this way either.
        assert (await c.post(sample, json={"op": RENAME, "target": {"ids": ids}}, headers=MIA)).status_code == 404
    await db.dispose_engine()


def test_the_sample_shows_entities_before_and_after_by_id_and_by_search(monkeypatch):
    asyncio.run(_sample(monkeypatch))


async def _edge_sample(monkeypatch) -> None:
    from httpx import ASGITransport, AsyncClient
    from .test_versioning_main_write_publish import PAT, V1, _app

    svc, ds, gid, draft = await _edge_draft(owner="pat")
    app, _G = _app()
    sample = f"{V1}/graphs/{gid}/branches/{draft}/property-jobs/preview/sample"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(sample, json={"op": RENAME, "target": {"edgeIds": EDGE_KEYS}}, headers=PAT)
        assert r.status_code == 200, r.text
        missing = {"type": None, "outcome": "skip", "reason": "missing"}
        assert r.json() == {"truncated": False, "rows": [
            {"id": "E1", "name": "N0 → N1", "type": "FLOWS_TO", "before": "a", "after": "a", "outcome": "change"},
            {"id": "E2", "name": "N1 → N2", "type": "FLOWS_TO", "before": "b", "to": "x", "after": "x",
             "outcome": "skip", "reason": "conflict"},
            {"id": "edge:E3", "name": "N2 → N3", "type": "FLOWS_TO", "before": "c", "after": "c", "outcome": "change"},
            {"id": "E4", "name": "N0 → N2", "type": "FEEDS", "outcome": "unchanged"},
            {"id": "E5", "name": "E5", **missing},                     # deleted in the draft
            {"id": "R1", "name": "N0 → N3", "type": "AGGREGATED", "before": "r", "outcome": "skip",
             "reason": "derived"},
            {"id": "nope", "name": "nope", **missing},
            {"id": "urn:n0|NOPE|urn:n1", "name": "urn:n0|NOPE|urn:n1", **missing}]}

        # A Connections search: its first page of edges, by their ids.
        asked = _sample_search(monkeypatch, edges=["E1", "R1"])
        search = {"viewId": "v1", "scopeMode": "view", "predicate": {"kind": "edges", "edgeTypes": ["FLOWS_TO"]}}
        r = await c.post(sample, json={"op": RENAME, "target": search}, headers=PAT)
        assert r.status_code == 200, r.text
        assert [(row["id"], row["outcome"]) for row in r.json()["rows"]] == [("E1", "change"), ("R1", "skip")]
        # A page of edges: the search fills in its own result shape.
        assert asked[0].options.page_size == 9 and "results" not in asked[0].options.model_fields_set
    await db.dispose_engine()


def test_the_sample_shows_relationships_before_and_after_never_a_roll_up_changed(monkeypatch):
    asyncio.run(_edge_sample(monkeypatch))


# ── undo a bulk job, from the draft's history ─────────────────────────────────
async def _undo(ie, ds, gid, job_id, key="key-undo-00001", actor="alice"):
    return (await ie.create_undo_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, job_id=job_id,
                                     actor=actor, key=key))["job_id"]


async def _undo_a_rename(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    rename = await _create(ie, ds, gid, draft, RENAME, {"ids": [f"urn:n{i}" for i in range(8)]})
    await ie.run_property(rename)
    # Since: one entity's new key edited by hand, one entity deleted.
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="by hand", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "N1", "payload": {"properties": {"steward": "mine"}}},
        {"op": "delete", "entity_kind": "node", "entity_id": "N2"}])
    seen = await _messages(gid, draft)

    undo = await _undo(ie, ds, gid, rename)
    assert await _undo(ie, ds, gid, rename) == undo                         # the same key: the same undo
    job = await ie.get_property_job(undo)
    assert job["op"] == {"kind": "undo", "key": "owner", "to": "steward", "sourceJobId": rename,
                         "sourceLabel": "Rename owner → steward"}
    assert job["target"]["kind"] == "undo" and len(job["target"]["commits"]) == 3
    summary = await ie.run_property(undo)
    assert (summary["changed"], summary["changedSince"], summary["deletedInDraft"],
            summary["commits"]) == (6, 1, 1, 3)
    assert await _messages(gid, draft) == seen + [
        f"Bulk property: Undo: Rename owner → steward ({i}/3)" for i in (1, 2, 3)]
    for i in (0, 3, 4, 5, 6, 7):
        assert await _props(svc, gid, draft, f"N{i}") == {"owner": f"o{i}"}
    assert await _props(svc, gid, draft, "N1") == {"steward": "mine"}            # changed since: left as it is
    assert sorted((await _csv(ie, undo))[1:]) == [
        "urn:n1,N1,changed_since,Its steward changed since the bulk change — left as it is.",
        "urn:n2,N2,deleted_in_draft,Deleted in this draft."]
    job = await ie.get_property_job(undo)
    assert (job["status"], job["processed"], job["total"], job["progress"]) == ("completed", 8, 8, 1.0)
    assert (await ie.get_property_job(rename))["summary"]["undoneBy"] == undo

    with pytest.raises(UndoRefused) as again:
        await _undo(ie, ds, gid, rename, key="key-undo-00002")
    assert (again.value.code, again.value.status_code, again.value.detail["jobId"]) == (
        "already_undone", 409, undo)
    with pytest.raises(UndoRefused) as twice:
        await _undo(ie, ds, gid, undo, key="key-undo-00003")
    assert (twice.value.code, twice.value.status_code) == ("undo_of_undo", 422)

    # A publish lists both, by what they did.
    published = await svc.publish(graph_id=gid, branch_id=draft, actor="alice", message="Back")
    listed = (await _stats(gid, published))["propertyJobs"]
    assert [j["label"] for j in listed["jobs"]] == ["Rename owner → steward", "Undo: Rename owner → steward"]
    assert await _props(svc, gid, None, "N0") == {"owner": "o0"}
    await db.dispose_engine()


def test_an_undo_puts_back_what_a_job_wrote_and_leaves_what_changed_since(monkeypatch):
    asyncio.run(_undo_a_rename(monkeypatch))


async def _undo_clean_ups(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft(nodes=[
        _node(0, dept="a", tier="42", score=1.0), _node(1, dept="b", tier="7"), _node(2, dept="x", tier="x")])
    ie = ImportExportService(versioning=svc)
    ids = ["urn:n0", "urn:n1", "urn:n2"]

    async def run(op, target, key):
        job_id = await _create(ie, ds, gid, draft, op, {"ids": target}, key=key)
        await ie.run_property(job_id)
        return job_id

    # Named twice, in two windows: N0's dept is merged a → b by the first, then b → c by the second.
    merge = await run(_cleanup("mapValues", "dept", map=[
        {"from": "a", "fromKind": "String", "to": "b", "toKind": "String"},
        {"from": "b", "fromKind": "String", "to": "c", "toKind": "String"}]), ids + ["gv:N0"], "key-merge-twice1")
    convert = await run(_cleanup("convert", "tier", toKind="Integer", onFail="skip"), ids, "key-convert-0002")
    score = await run(_cleanup("set", "score", value=1), ids[:1], "key-set-score-02")
    assert [await _props(svc, gid, draft, f"N{i}") for i in range(3)] == [
        {"dept": "c", "tier": 42, "score": 1}, {"dept": "c", "tier": 7}, {"dept": "x", "tier": "x"}]

    # Undone newest window first, N0 ends as it began; each value in the kind it was stored as.
    for job_id, key, changed in ((merge, "key-undo-merge01", 3), (convert, "key-undo-conv001", 2),
                                 (score, "key-undo-score01", 1)):
        summary = await ie.run_property(await _undo(ie, ds, gid, job_id, key=key))
        assert (summary["changed"], summary["changedSince"]) == (changed, 0), summary
    props = [await _props(svc, gid, draft, f"N{i}") for i in range(3)]
    assert props == [{"dept": "a", "tier": "42", "score": 1.0}, {"dept": "b", "tier": "7"},
                     {"dept": "x", "tier": "x"}]
    assert (type(props[0]["score"]), type(props[0]["tier"])) == (float, str)
    await db.dispose_engine()


def test_an_undo_of_clean_ups_goes_newest_window_first_and_keeps_each_kind(monkeypatch):
    asyncio.run(_undo_clean_ups(monkeypatch))


async def _undo_after_a_pull() -> None:
    """What a draft held before a job is what it read then: a pull since moved its base."""
    svc, ds, gid, draft = await _draft(n=2)
    ie = ImportExportService(versioning=svc)
    tier = await _create(ie, ds, gid, draft, {"kind": "set", "key": "tier", "value": "gold", "onConflict": "skip"},
                         {"ids": ["urn:n0", "urn:n1"]})
    await ie.run_property(tier)
    other = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=other, actor="bob", message="new owner", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "N0", "payload": {"properties": {"owner": "bob"}}}])
    await svc.publish(graph_id=gid, branch_id=other, actor="bob", message="new owner")
    assert (await svc.rebase_draft(graph_id=gid, branch_id=draft, actor="alice"))["clean"]
    assert await _props(svc, gid, draft, "N0") == {"owner": "bob", "tier": "gold"}

    summary = await ie.run_property(await _undo(ie, ds, gid, tier))
    assert (summary["changed"], summary["changedSince"]) == (2, 0), summary
    assert [await _props(svc, gid, draft, f"N{i}") for i in (0, 1)] == [{"owner": "bob"}, {"owner": "o1"}]
    await db.dispose_engine()


def test_an_undo_reads_what_the_draft_held_before_the_job_even_after_a_pull():
    asyncio.run(_undo_after_a_pull())


async def _undo_relationships_removals_and_fills() -> None:
    svc, ds, gid, draft = await _edge_draft()
    ie = ImportExportService(versioning=svc)
    edges = await ie.create_property_job(
        workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft, actor="alice",
        op={"kind": "remove", "key": "owner", "onConflict": "skip"}, target={"ids": ["E1", "E2", "E3"]},
        message=None, key="key-edge-undo-01", entity_kind="edge")
    await ie.run_property(edges["job_id"])
    fill = await _create(ie, ds, gid, draft,
                         {"kind": "fillEmpty", "key": "owner", "value": "ana", "onConflict": "skip"},
                         {"ids": ["urn:n0", "urn:n1"]}, key="key-fill-undo-01")
    await ie.run_property(fill)
    assert await _props(svc, gid, draft, "E2") == {"steward": "x"}
    assert await _props(svc, gid, draft, "N0") == {"owner": "ana"}

    undo = await _undo(ie, ds, gid, edges["job_id"])
    assert (await ie.get_property_job(undo))["entityKind"] == "edge"
    assert (await ie.run_property(undo))["changed"] == 3
    assert [await _props(svc, gid, draft, e) for e in ("E1", "E2", "edge:E3")] == [
        {"owner": "a"}, {"owner": "b", "steward": "x"}, {"owner": "c"}]
    assert (await ie.run_property(await _undo(ie, ds, gid, fill, key="key-undo-fill01")))["changed"] == 2
    assert [await _props(svc, gid, draft, f"N{i}") for i in (0, 1)] == [{}, {}]
    await db.dispose_engine()


def test_an_undo_covers_relationship_jobs_removals_and_fills():
    asyncio.run(_undo_relationships_removals_and_fills())


async def _undo_resumes_and_cancels(monkeypatch) -> None:
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 3)
    svc, ds, gid, draft = await _draft()
    ie = ImportExportService(versioning=svc)
    ids = [f"urn:n{i}" for i in range(8)]
    source = await _create(ie, ds, gid, draft, RENAME, {"ids": ids})
    with pytest.raises(JobActive) as busy:                   # the job itself, while it may run
        await _undo(ie, ds, gid, source)
    assert busy.value.job_id == source
    await ie.run_property(source)

    # Superseded as its second window writes: that window rolls back, and the undo resumes from its
    # cursor, writing each window once.
    undo = await _undo(ie, ds, gid, source)
    with pytest.raises(JobActive):                           # one job a draft: a second undo waits
        await _undo(ie, ds, gid, source, key="key-undo-other1")
    seen = await _messages(gid, draft)
    lease = await lease_job(undo)
    _on_window(svc, 2, lambda: lease_job(undo))
    with pytest.raises(Superseded):
        await ie.run_property(undo, lease=lease)
    assert [await _props(svc, gid, draft, f"N{i}") for i in (7, 3)] == [{"owner": "o7"}, {"steward": "o3"}]
    assert (await ie.get_property_job(source))["summary"].get("undoneBy") is None
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    summary = await ie.run_property(undo)
    assert (summary["changed"], summary["commits"]) == (8, 3)
    assert await _messages(gid, draft) == seen + [
        f"Bulk property: Undo: Rename owner → steward ({i}/3)" for i in (1, 2, 3)]

    # Cancelled as its second window writes: the first stays put back, and the source is not undone
    # until an undo asked again puts back the rest — what is back already is left as it is.
    again = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-property-0002")
    await ie.run_property(again)
    cancelled = await _undo(ie, ds, gid, again, key="key-undo-cancel1")
    _on_window(svc, 2, lambda: ie.cancel_property_job(cancelled, actor="alice"))
    await ie.run_property_safe(cancelled, await lease_job(cancelled))
    job = await ie.get_property_job(cancelled)
    assert (job["status"], job["summary"]["changed"], job["summary"]["commits"]) == ("cancelled", 2, 1)
    assert [await _props(svc, gid, draft, f"N{i}") for i in (7, 3)] == [{"owner": "o7"}, {"steward": "o3"}]
    assert (await ie.get_property_job(again))["summary"].get("undoneBy") is None
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    rest = await _undo(ie, ds, gid, again, key="key-undo-rest001")
    summary = await ie.run_property(rest)
    assert (summary["changed"], summary["unchanged"], summary["changedSince"]) == (6, 2, 0)
    assert (await ie.get_property_job(again))["summary"]["undoneBy"] == rest

    # A cancelled job is undone for the windows it wrote.
    third = await _create(ie, ds, gid, draft, RENAME, {"ids": ids}, key="key-property-0003")
    _on_window(svc, 2, lambda: ie.cancel_property_job(third, actor="alice"))
    await ie.run_property_safe(third, await lease_job(third))
    svc.apply_ops = GraphVersioningService.apply_ops.__get__(svc)
    assert (await ie.get_property_job(third))["status"] == "cancelled"
    summary = await ie.run_property(await _undo(ie, ds, gid, third, key="key-undo-third01"))
    assert (summary["changed"], summary["commits"]) == (3, 1)
    assert [await _props(svc, gid, draft, f"N{i}") for i in range(8)] == [{"owner": f"o{i}"} for i in range(8)]
    await db.dispose_engine()


def test_an_undo_resumes_after_a_takeover_and_a_cancelled_one_keeps_what_it_put_back(monkeypatch):
    asyncio.run(_undo_resumes_and_cancels(monkeypatch))


async def _undo_refused() -> None:
    cont = ["CONTAINS"]
    svc, ds, gid, draft = await _draft(n=4)
    ie = ImportExportService(versioning=svc)
    rename = await _create(ie, ds, gid, draft, RENAME, {"ids": ["urn:n0", "urn:n1"]}, key="key-refused-001")
    await ie.run_property(rename)
    nothing = await _create(ie, ds, gid, draft, _cleanup("replace", "owner", find="zzz", replaceWith="y"),
                            {"ids": ["urn:n0"]}, key="key-refused-002")
    await ie.run_property(nothing)
    with pytest.raises(UndoRefused) as empty:
        await _undo(ie, ds, gid, nothing)
    assert (empty.value.code, empty.value.status_code) == ("nothing_to_undo", 422)

    # Part of it merged to main by a review: not undone on the draft, nor once the rest lands.
    pr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="alice", title="Stewards")
    await svc.decide_changes(pr_id=pr, actor="bo", verdict="accepted", entity_ids=["N0"],
                             containment_edge_types=cont)
    await svc.decide_changes(pr_id=pr, actor="bo", verdict="rejected", entity_ids=["N1"],
                             reason="Later", containment_edge_types=cont)
    await svc.merge_mr(mr_id=pr, actor="cy", message="Some", containment_edge_types=cont, mode="accepted")
    with pytest.raises(UndoRefused) as part:
        await _undo(ie, ds, gid, rename)
    assert (part.value.code, part.value.status_code) == ("job_published", 409)
    rest = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="alice", title="The rest")
    await svc.merge_mr(mr_id=rest, actor="cy", message="Rest", containment_edge_types=cont)
    with pytest.raises(UndoRefused, match="published") as whole:
        await _undo(ie, ds, gid, rename, key="key-undo-00002")
    assert whole.value.code == "job_published"

    # A draft discarded under a job that never reached main: closed.
    later = await svc.open_draft(graph_id=gid, owner="alice")
    tier = await _create(ie, ds, gid, later, {"kind": "set", "key": "tier", "value": "gold", "onConflict": "skip"},
                         {"ids": ["urn:n2"]}, key="key-refused-003")
    await ie.run_property(tier)
    await svc.abandon_draft(graph_id=gid, branch_id=later, actor="alice")
    with pytest.raises(BranchNotOpen):
        await _undo(ie, ds, gid, tier, key="key-undo-00003")
    await db.dispose_engine()


def test_an_undo_is_refused_once_published_in_whole_or_part_for_nothing_and_on_a_closed_draft():
    asyncio.run(_undo_refused())


async def _undo_routes() -> None:
    from httpx import ASGITransport, AsyncClient
    from backend.app.api.v1.endpoints.versioning import get_import_export_service
    from .test_versioning_main_write_publish import MIA, PAT, V1, _app

    svc, ds, gid, draft = await _draft(owner="pat", n=2)
    app, _G = _app()
    ie = get_import_export_service()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(f"{V1}/graphs/{gid}/branches/{draft}/property-jobs",
                         json={"op": RENAME, "target": {"ids": ["urn:n0", "urn:n1"]}},
                         headers={**PAT, "Idempotency-Key": "key-route-undo1"})
        source = r.json()["jobId"]
        url = f"{V1}/graphs/{gid}/property-jobs/{source}/undo"
        r = await c.post(url, headers={**PAT, "Idempotency-Key": "key-route-undo2"})
        assert r.status_code == 409 and r.json()["detail"]["code"] == "job_active", r.text
        await ie.run_property(source)

        assert (await c.post(url, headers=PAT)).status_code == 422                  # no key
        key = {**PAT, "Idempotency-Key": "key-route-undo3"}
        r = await c.post(url, headers=key)
        assert r.status_code == 202, r.text
        undo = r.json()
        assert (undo["status"], undo["op"]["kind"], undo["op"]["sourceJobId"], undo["total"]) == (
            "pending", "undo", source, 2)
        assert (await c.post(url, headers=key)).json()["jobId"] == undo["jobId"]
        r = await c.post(url, headers={**PAT, "Idempotency-Key": "key-route-undo4"})
        assert r.status_code == 409, r.text
        assert (r.json()["detail"]["code"], r.json()["detail"]["jobId"]) == ("job_active", undo["jobId"])
        assert (await c.post(url, headers={**MIA, "Idempotency-Key": "key-route-undo5"})).status_code == 404

        await ie.run_property(undo["jobId"])
        r = await c.get(f"{V1}/graphs/{gid}/property-jobs/{source}", headers=PAT)
        assert r.json()["summary"]["undoneBy"] == undo["jobId"], r.text
        r = await c.post(url, headers={**PAT, "Idempotency-Key": "key-route-undo6"})
        assert r.status_code == 409, r.text
        assert (r.json()["detail"]["code"], r.json()["detail"]["jobId"]) == ("already_undone", undo["jobId"])
        r = await c.post(f"{V1}/graphs/{gid}/property-jobs/{undo['jobId']}/undo",
                         headers={**PAT, "Idempotency-Key": "key-route-undo7"})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "undo_of_undo", r.text
        assert await _props(svc, gid, draft, "N0") == {"owner": "o0"}
    await db.dispose_engine()


def test_the_undo_route_answers_with_the_undo_and_says_why_it_refuses():
    asyncio.run(_undo_routes())
