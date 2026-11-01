"""Merging a fork's review over HTTP, and as a job when it is large — needs Postgres (management and
graphver).

Both merge routes (``/pulls/{id}/merge``, ``/merge-requests/{id}/merge``) refuse a fork behind its
parent: 409 ``not_up_to_date`` with ``reason: parent_moved`` and how far behind, "Update from
parent first". A review that changes more than ``SYNC_PUBLISH_MAX_CHANGES`` entities is merged by
a ``fork_merge`` job on the transfer lane instead (202 ``{jobId}``): queued only up to date and
approved, it pins the fork's head and holds the review ``merging``, so a second merge is refused
(409 ``job_active``) until the job ends. Run, it lands as the route's merge would, and run again
after it landed it answers with the review's merge. A refused job hands the review back at once;
one that died, when the reaper finds it.
"""
import os

import pytest

from backend.tests.integration.test_fork_data_sources import WS, _client, _fork, _parent, _run
from backend.tests.integration.test_fork_overlay_delta import _n, _u

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

PERMS = ("workspace:datasource:read", "workspace:datasource:manage", "workspace:datasource:publish")


async def _review(svc, c, *, reviewers=None):
    """A parent, a fork of it made through the API with a change of its own, and its review."""
    _ds, gid = await _parent(svc, label="Sales")
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
    r = await _fork(c, gid, {"name": "Q3"})
    assert r.status_code == 201, r.text
    fgid = r.json()["graphId"]
    await svc.apply_ops(graph_id=fgid, actor="bob", message="own", ops=[_u("A", "A fork")])
    pr = await svc.open_pr(source_graph_id=fgid, actor="bob", reviewers=reviewers)
    return gid, fgid, pr


def _merge_url(pr, route):
    return f"/api/v1/{WS}/versioning/{route}/{pr}/merge"


def test_both_merge_routes_refuse_a_fork_behind_its_parent(forks_on):
    async def case(svc):
        async with _client(PERMS) as c:
            gid, fgid, pr = await _review(svc, c)
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_n("C")])
            for route in ("pulls", "merge-requests"):
                r = await c.post(_merge_url(pr, route), json={"message": "m"})
                assert r.status_code == 409, r.text
                detail = r.json()["detail"]
                assert (detail["type"], detail["reason"], detail["behind"]) == (
                    "not_up_to_date", "parent_moved", 1)
                assert "update from parent first" in detail["message"]
            r = await c.post(f"/api/v1/{WS}/versioning/graphs/{fgid}/update-from-parent", json={})
            assert r.status_code == 200, r.text
            r = await c.post(_merge_url(pr, "merge-requests"), json={"message": "m"})
            assert r.status_code == 200 and r.json()["commitId"], r.text
            assert (await svc.get_pr(pr))["status"] == "merged"
    _run(case)


def test_a_large_review_is_merged_by_a_job_that_holds_it_merging(monkeypatch, forks_on):
    from backend.app.services.versioning import config as vconfig

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        from backend.app.api.v1.endpoints.versioning import get_import_export_service
        from backend.app.services.versioning.import_export.import_worker import lease_job

        ie = get_import_export_service()
        async with _client(PERMS) as c:
            gid, fgid, pr = await _review(svc, c)
            pinned = (await svc.get_graph(fgid))["main_head_commit_seq"]
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "by job"})
            assert r.status_code == 202, r.text
            job_id = r.json()["jobId"]
            assert r.json()["graphId"] == gid
            assert (await svc.get_pr(pr))["status"] == "merging"
            for route in ("pulls", "merge-requests"):               # one merge at a time
                r = await c.post(_merge_url(pr, route), json={"message": "again"})
                assert r.status_code == 409, r.text
                assert (r.json()["detail"]["type"], r.json()["detail"]["jobId"]) == ("job_active", job_id)

            # The fork moves on after the job pinned its head: the job merges what it pinned.
            await svc.apply_ops(graph_id=fgid, actor="bob", message="later", ops=[_n("L")])
            await lease_job(job_id)                                  # the first attempt's worker...
            landed = await svc.merge_pr(pr_id=pr, actor="u_forker", message="by job",
                                        pinned_seq=pinned, queued=True)
            result = await ie.run_fork_job(job_id)                   # ...died: the next one runs
            got = await ie.get_job(job_id)
            assert (got["status"], got["attempt"], result) == ("completed", 2, {"commitId": landed}), got
            meta = await svc.get_pr(pr)
            assert (meta["status"], meta["resulting_commit_id"]) == ("merged", landed)
            r = await c.get(f"/api/v1/{WS}/versioning/graphs/{gid}/publish-jobs/{job_id}")
            assert (r.json()["status"], r.json()["commitId"]) == ("completed", landed), r.text
            pmain = await svc.main_branch_id(gid)
            nodes = (await svc.materialize_state(graph_id=gid, branch_id=pmain))["nodes"]
            assert nodes["A"]["displayName"] == "A fork" and "L" not in nodes
    _run(case)


def test_a_merge_job_lands_and_one_refused_or_dead_hands_the_review_back(monkeypatch, forks_on):
    from backend.app.services.versioning import config as vconfig

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        from backend.app.api.v1.endpoints.versioning import get_import_export_service
        from backend.app.services.versioning.import_export.import_worker import lease_job

        ie = get_import_export_service()
        async with _client(PERMS) as c:
            gid, fgid, pr = await _review(svc, c, reviewers=["carol"])
            # Not approved: refused before it is queued, the review left as it was.
            r = await c.post(_merge_url(pr, "merge-requests"), json={"message": "m"})
            assert r.status_code == 409 and r.json()["detail"]["type"] == "approval_required", r.text
            await svc.approve_pr(pr_id=pr, actor="carol")
            assert (await svc.get_pr(pr))["status"] == "approved"

            # Refused when it runs (the parent moved since): the review is handed back at once.
            r = await c.post(_merge_url(pr, "merge-requests"), json={"message": "m"})
            assert r.status_code == 202, r.text
            job_id = r.json()["jobId"]
            await svc.apply_ops(graph_id=gid, actor="alice", message="parent", ops=[_n("C")])
            result = await ie.run_fork_job(job_id)
            assert (result["error"]["status"], result["error"]["detail"]["type"]) == (409, "not_up_to_date")
            assert (await ie.get_job(job_id))["status"] == "failed"
            assert (await svc.get_pr(pr))["status"] == "approved"

            # Up to date again, queued, and its worker dies for good: the reaper hands it back.
            assert (await svc.update_fork_from_parent(fork_graph_id=fgid, actor="bob"))["wrote"] == 0
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "m"})
            assert r.status_code == 202, r.text
            dead = await lease_job(r.json()["jobId"])
            assert await svc.release_merging() == []                 # its job still runs
            await dead.fail("the worker was lost", "infrastructure")
            assert await svc.release_merging() == [pr]
            assert (await svc.get_pr(pr))["status"] == "approved"

            # And a job that runs to the end lands it.
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "landed"})
            assert r.status_code == 202, r.text
            result = await ie.run_fork_job(r.json()["jobId"])
            meta = await svc.get_pr(pr)
            assert (meta["status"], meta["resulting_commit_id"]) == ("merged", result["commitId"])
            assert result["commitId"]
            assert await svc.release_merging() == []
    _run(case)


def test_a_merge_job_whose_review_merged_under_it_completes_with_that_merge(monkeypatch, forks_on):
    """A superseded attempt's merge lands between this attempt's look at the review and its merge:
    the merge is refused (the review merged), and the job completes with that merge all the same."""
    from backend.app.services.versioning import config as vconfig

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        from backend.app.api.v1.endpoints.versioning import (get_import_export_service,
                                                             get_versioning_service)

        ie, api_svc = get_import_export_service(), get_versioning_service()
        async with _client(PERMS) as c:
            gid, fgid, pr = await _review(svc, c)
            pinned = (await svc.get_graph(fgid))["main_head_commit_seq"]
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "raced"})
            assert r.status_code == 202, r.text
            looked, zombie = api_svc.get_pr, []

            async def looks_then_the_zombie_lands(pr_id):
                seen = await looked(pr_id)
                if not zombie:
                    zombie.append(await svc.merge_pr(pr_id=pr, actor="u_forker", message="zombie",
                                                     pinned_seq=pinned, queued=True))
                return seen
            monkeypatch.setattr(api_svc, "get_pr", looks_then_the_zombie_lands)
            result = await ie.run_fork_job(r.json()["jobId"])
            assert result == {"commitId": zombie[0]}, result
            assert (await ie.get_job(r.json()["jobId"]))["status"] == "completed"
    _run(case)


def test_a_review_being_merged_can_be_neither_closed_nor_given_reviewers(monkeypatch, forks_on):
    from backend.app.services.versioning import config as vconfig
    from backend.app.services.versioning.errors import JobActive

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        async with _client(PERMS) as c:
            _gid, _fgid, pr = await _review(svc, c)
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "m"})
            assert r.status_code == 202, r.text
            with pytest.raises(JobActive):
                await svc.close_pr(pr_id=pr, actor="bob")
            with pytest.raises(JobActive):
                await svc.update_pr(pr_id=pr, reviewers=["carol"])
            r = await c.post(f"/api/v1/{WS}/versioning/pulls/{pr}/close")
            assert (r.status_code, r.json()["detail"]["type"]) == (409, "job_active"), r.text
            meta = await svc.get_pr(pr)
            assert (meta["status"], meta["reviewers"]) == ("merging", None)
    _run(case)


def test_the_overview_counts_a_review_being_merged_as_open(monkeypatch, forks_on):
    from backend.app.services.system_status.probes import probe_overview
    from backend.app.services.versioning import config as vconfig

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        async with _client(PERMS) as c:
            _gid, _fgid, pr = await _review(svc, c)
            before = (await probe_overview(None))["openReviews"]
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "m"})
            assert r.status_code == 202, r.text
            assert (await probe_overview(None))["openReviews"] == before
    _run(case)


def test_a_drafts_review_sent_to_the_fork_merge_route_is_refused_early():
    async def case(svc):
        async with _client(PERMS) as c:
            _ds, gid = await _parent(svc)
            await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A")])
            draft = await svc.open_draft(graph_id=gid, owner="u_forker", visibility="public")
            await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u_forker", message="d",
                                ops=[_u("A", "A draft")])
            mr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="u_forker")
            r = await c.post(_merge_url(mr, "pulls"), json={"message": "m"})
            assert r.status_code == 404, r.text
            assert (await svc.get_pr(mr))["status"] != "merged"
    _run(case)


def test_a_merge_job_queued_before_forks_were_turned_off_fails_and_hands_the_review_back(monkeypatch):
    from backend.app.services.versioning import config as vconfig
    from backend.tests.integration.test_forks_feature_flag import REFUSED, _forks
    from backend.tests.integration.test_forks_feature_flag import _client as _switched

    monkeypatch.setattr(vconfig, "SYNC_PUBLISH_MAX_CHANGES", 0)

    async def case(svc):
        from backend.app.api.v1.endpoints.versioning import get_import_export_service

        ie = get_import_export_service()
        _forks(True)
        async with _switched() as c:
            gid, _fgid, pr = await _review(svc, c)
            head = (await svc.get_graph(gid))["main_head_commit_seq"]
            r = await c.post(_merge_url(pr, "pulls"), json={"message": "m"})
            assert r.status_code == 202, r.text
            _forks(False)
            result = await ie.run_fork_job(r.json()["jobId"])
            assert result == {"error": {"status": 403, "detail": REFUSED}}, result
            assert (await ie.get_job(r.json()["jobId"]))["status"] == "failed"
            assert (await svc.get_pr(pr))["status"] == "mergeable"
            assert (await svc.get_graph(gid))["main_head_commit_seq"] == head
    _run(case)
