"""An import that publishes itself (``autoPublish``).

Pins the step ``ImportExportService.run_import`` takes once an import is complete, recorded on the
job's ``summary.publish`` and never failing the import:

* a draft with every row applied goes to a publish job, as its owner, marked to check publish again;
* a file with rows that weren't imported leaves the draft for review;
* one that changed nothing closes its empty draft;
* a draft that fell behind main pulls it and is queued once it pulls clean (up to three pulls);
  one that pulls with conflicts is kept, with the reason;
* its publish job, finding main moved while it waited its turn, pulls the draft it holds and
  publishes it again, so the job ends published, or refused saying why (conflicts, or main moving
  on through three pulls), the import following along;
* a draft its publish refuses otherwise (it closed) is kept, with the reason;
* without ``autoPublish`` none of it happens.

Then the routes: asking for it needs publish (an API key: its owner's), a data source whose policy
lets you merge your own changes, and a draft of the import's own — each refused before anything is
created — and the request carries it to the job.
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning as versioning_ep
from backend.app.auth.dependencies import get_permission_claims
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.errors import BranchNotOpen
from backend.app.services.versioning.import_export import service as service_mod
from backend.app.services.versioning.import_export import uploads
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import BranchORM
from backend.app.services.versioning.service import NotUpToDate

_DONE = {"new": 2, "updated": 1, "unchanged": 5, "deleted": 0, "invalid": 0}


def _world(monkeypatch, summary, *, auto_publish=True):
    """A completed import (``auto_publish``) on draft br1, owned by alice, whose worker reports
    ``summary``. Returns the service, the job's row, and what the step did."""
    row = SimpleNamespace(workspace_id="ws", data_source_id="ds", scope_view_id=None,
                          reconcile_mode="upsert", branch_id="br1", graph_id="g1",
                          auto_publish=auto_publish, summary=dict(summary), updated_at=None)
    branch = SimpleNamespace(owner="alice", visibility="private")

    @contextlib.asynccontextmanager
    async def session():
        class _Session:
            async def get(self, orm, _key):
                return branch if orm is BranchORM else row
        yield _Session()

    class _Worker:
        def __init__(self, *_args, **_kwargs):
            self.created_node_facts = []

        async def run(self, _job_id):
            return dict(summary)

    monkeypatch.setattr(ver_db, "graphver_session", session)
    monkeypatch.setattr(service_mod, "ImportWorker", _Worker)
    did = SimpleNamespace(published=[], abandoned=[], pulled=[], pull={"clean": True})

    class _Versioning:
        async def abandon_draft(self, **kwargs):
            did.abandoned.append(kwargs)

        async def rebase_draft(self, **kwargs):
            did.pulled.append(kwargs)
            return did.pull

    svc = ImportExportService(versioning=_Versioning(), store=object())

    async def create_publish_job(**kwargs):
        did.published.append(kwargs)
        return {"job_id": "pjob_1"}

    svc.create_publish_job = create_publish_job
    return svc, row, did


async def test_a_complete_import_hands_its_draft_to_a_publish_job_as_its_owner(monkeypatch):
    svc, row, did = _world(monkeypatch, _DONE)
    assert await svc.run_import("job1") == _DONE                 # the import's own tallies
    (job,) = did.published
    assert {k: job[k] for k in ("workspace_id", "graph_id", "branch_id", "actor", "auto_publish")} == {
        "workspace_id": "ws", "graph_id": "g1", "branch_id": "br1", "actor": "alice",
        "auto_publish": True}
    assert row.summary["publish"] == {"state": "queued", "jobId": "pjob_1"}


@pytest.mark.parametrize("tally", [{"invalid": 3}, {"skipped": 2}])
async def test_rows_that_werent_imported_leave_the_draft_for_review(monkeypatch, tally):
    svc, row, did = _world(monkeypatch, {**_DONE, **tally})
    await svc.run_import("job1")
    assert did.published == [] and did.abandoned == []
    note = row.summary["publish"]
    assert (note["state"], note["reason"]["type"]) == ("skipped", "rows_refused")


async def test_an_import_that_changed_nothing_closes_its_empty_draft(monkeypatch):
    svc, row, did = _world(monkeypatch, {"new": 0, "updated": 0, "unchanged": 7, "deleted": 0,
                                         "invalid": 0})
    await svc.run_import("job1")
    assert did.published == []
    assert did.abandoned == [{"graph_id": "g1", "branch_id": "br1", "actor": "alice"}]
    assert row.summary["publish"] == {"state": "unchanged"}


@pytest.mark.parametrize("refusal, kind, pulls", [
    (NotUpToDate("br1", 3, 5), "not_up_to_date", 3),       # main kept moving through three pulls
    (BranchNotOpen("br1", "abandoned"), "branch_closed", 0),  # someone closed the draft meanwhile
])
async def test_a_draft_its_publish_refuses_is_kept_with_the_reason(monkeypatch, refusal, kind, pulls):
    svc, row, did = _world(monkeypatch, _DONE)

    async def refuse(**_kwargs):
        raise refusal

    svc.create_publish_job = refuse
    assert await svc.run_import("job1") == _DONE                 # complete, whatever the publish
    note = row.summary["publish"]
    assert (note["state"], note["reason"]["type"]) == ("skipped", kind)
    assert len(did.pulled) == pulls
    if kind == "not_up_to_date":
        assert note["reason"]["behindBy"] == 2


async def test_a_draft_main_moved_under_pulls_it_and_is_published(monkeypatch):
    svc, row, did = _world(monkeypatch, _DONE)
    behind = [NotUpToDate("br1", 3, 5)]

    async def create_publish_job(**kwargs):
        if behind:
            raise behind.pop()
        did.published.append(kwargs)
        return {"job_id": "pjob_2"}

    svc.create_publish_job = create_publish_job
    await svc.run_import("job1")
    assert [(p["branch_id"], p["actor"]) for p in did.pulled] == [("br1", "alice")]
    assert row.summary["publish"] == {"state": "queued", "jobId": "pjob_2", "pulls": 1}
    assert (did.published[0]["import_job_id"], did.published[0]["pulls"]) == ("job1", 1)


async def test_a_draft_that_pulls_with_conflicts_waits_for_review(monkeypatch):
    svc, row, did = _world(monkeypatch, _DONE)
    did.pull = {"clean": False, "conflicts": [{"entity_id": "n1"}, {"entity_id": "n2"}]}

    async def behind(**_kwargs):
        raise NotUpToDate("br1", 3, 5)

    svc.create_publish_job = behind
    await svc.run_import("job1")
    note = row.summary["publish"]
    assert (note["state"], note["reason"]["type"], note["reason"]["conflicts"], note["pulls"]) == (
        "skipped", "conflicts", 2, 1)


def _publish_world(monkeypatch, answers, *, pull=None, pulls=0, import_job="job1"):
    """Publish job pjob_1 of import ``import_job``'s draft br1 (owned by alice), its draft already
    pulled ``pulls`` times; the publish answers ``answers`` in turn. Returns the service, the
    import's row, and what the job did."""
    job = SimpleNamespace(field_scope={"actor": "alice", "message": "m", "autoPublish": True,
                                       **({"importJobId": import_job, "pulls": pulls} if import_job else {})},
                          graph_id="g1", branch_id="br1", workspace_id="ws", data_source_id="ds")
    imported = SimpleNamespace(summary={"publish": {"state": "queued", "jobId": "pjob_1"}}, updated_at=None)
    did = SimpleNamespace(pulled=[], released=0, published=0, finished=None)

    @contextlib.asynccontextmanager
    async def session():
        class _Session:
            async def get(self, _orm, key):
                return job if key == "pjob_1" else imported
        yield _Session()

    class _Versioning:
        async def merged_commit_id(self, **_kwargs):
            return None

        async def rebase_draft(self, **kwargs):
            did.pulled.append(kwargs)
            return pull or {"clean": True}

        async def release_publishing(self, **_kwargs):
            did.released += 1

    class _Lease:
        epoch = 0

        def check(self):
            pass

        async def finish(self, status="completed", **values):
            did.finished = {"status": status, **values}
            return True

    async def hook(_job):
        did.published += 1
        return answers.pop(0)

    monkeypatch.setattr(ver_db, "graphver_session", session)
    svc = ImportExportService(versioning=_Versioning(), store=object(), publish_hook=hook)
    return svc, imported, did, _Lease()


_BEHIND = {"error": {"status": 409, "detail": {"type": "not_up_to_date", "behindBy": 1}}}


async def test_its_publish_job_finding_main_moved_pulls_the_draft_it_holds_and_publishes_it(monkeypatch):
    svc, imported, did, lease = _publish_world(monkeypatch, [_BEHIND, {"commitId": "c9"}])
    assert await svc.run_publish("pjob_1", lease) == {"commitId": "c9"}
    assert [(p["branch_id"], p["actor"], p["publishing_ok"]) for p in did.pulled] == [("br1", "alice", True)]
    assert did.finished["status"] == "completed" and did.released == 0
    assert imported.summary["publish"] == {"state": "queued", "jobId": "pjob_1", "pulls": 1}


async def test_its_publish_job_ends_refused_with_the_conflicts_a_pull_found(monkeypatch):
    svc, imported, did, lease = _publish_world(
        monkeypatch, [_BEHIND], pull={"clean": False, "conflicts": [{"entity_id": "n1"}]})
    result = await svc.run_publish("pjob_1", lease)
    assert (result["error"]["detail"]["type"], result["error"]["detail"]["conflicts"]) == ("conflicts", 1)
    assert did.finished["status"] == "failed" and did.released == 1      # the draft, open again
    note = imported.summary["publish"]
    assert (note["state"], note["jobId"], note["pulls"], note["reason"]["type"]) == (
        "skipped", "pjob_1", 1, "conflicts")


async def test_its_publish_job_pulls_no_more_than_three_times_counting_the_imports(monkeypatch):
    svc, imported, did, lease = _publish_world(monkeypatch, [_BEHIND, _BEHIND, _BEHIND], pulls=1)
    result = await svc.run_publish("pjob_1", lease)
    assert result["error"]["detail"]["type"] == "not_up_to_date"
    assert len(did.pulled) == 2 and did.published == 3 and did.finished["status"] == "failed"
    assert (imported.summary["publish"]["state"], imported.summary["publish"]["pulls"]) == ("skipped", 3)


async def test_a_persons_publish_job_main_moved_under_is_refused_as_before(monkeypatch):
    svc, imported, did, lease = _publish_world(monkeypatch, [_BEHIND], import_job=None)
    assert (await svc.run_publish("pjob_1", lease))["error"]["detail"]["type"] == "not_up_to_date"
    assert did.pulled == [] and did.finished["status"] == "failed"


async def test_without_auto_publish_nothing_is_published(monkeypatch):
    svc, row, did = _world(monkeypatch, _DONE, auto_publish=False)
    await svc.run_import("job1")
    assert did.published == [] and did.abandoned == [] and "publish" not in row.summary


async def test_its_publish_job_is_marked_to_check_publish_again(monkeypatch):
    """``create_publish_job(auto_publish=True)`` marks the job's fields, which ``_publish_from_job``
    reads to hold the import's owner to publish when the job runs."""
    added = []

    class _Session:
        async def scalar(self, query):        # main's head is 0; the graph is in no other workspace
            return 0 if "main_head_commit_seq" in str(query) else None

        def add(self, job):
            added.append(job)

        async def flush(self):
            added[-1].id = f"pjob_{len(added)}"

    @contextlib.asynccontextmanager
    async def session():
        yield _Session()

    class _Versioning:                        # every check the draft must pass, passed
        async def _lock_lifecycle(self, *_args, **_kwargs):
            pass

        async def _lock_move(self, *_args, **_kwargs):
            pass

        async def _assert_writable(self, *_args):
            pass

        async def _lock_branch(self, *_args):
            return SimpleNamespace(kind="draft", status="open", base_commit_seq=0)

        def _require_open(self, _branch):
            pass

        async def _require_publish(self, *_args):
            pass

        async def _require_no_import(self, *_args):
            pass

    monkeypatch.setattr(ver_db, "graphver_session", session)
    svc = ImportExportService(versioning=_Versioning(), store=object())
    for auto_publish in (True, False):
        await svc.create_publish_job(workspace_id="ws", data_source_id="ds", graph_id="g1",
                                     branch_id="br1", actor="alice", message="m",
                                     auto_publish=auto_publish)
    assert [job.field_scope.get("autoPublish") for job in added] == [True, None]


# ── The routes ───────────────────────────────────────────────────────────────


class _Graphs:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}


class _Imports:
    def __init__(self, store):
        self.store = store
        self.created: list = []

    async def create_import_job(self, **kwargs):
        self.created.append(kwargs)
        return {"job_id": f"vjob_{len(self.created)}", "branch_id": "br_1",
                "source_uri": kwargs.get("source_uri") or "ws1/ds1/g1/vjob/source.ndjson"}

    async def find_job(self, **_kwargs):
        return None

    async def start_import(self, _job_id):
        return "pending"

    async def get_job(self, _job_id):
        return None


@pytest.fixture
def imports(tmp_path, monkeypatch):
    from backend.app.main import app

    monkeypatch.setattr(uploads, "PART_BYTES", 64)
    jobs = _Imports(LocalFsObjectStore(tmp_path))
    app.dependency_overrides[versioning_ep.get_versioning_service] = _Graphs
    app.dependency_overrides[versioning_ep.get_import_export_service] = lambda: jobs
    yield jobs
    for dependency in (versioning_ep.get_versioning_service, versioning_ep.get_import_export_service,
                       get_permission_claims):
        app.dependency_overrides.pop(dependency, None)


_IMPORTS = "/api/v1/ws1/versioning/graphs/g1/imports"


async def _completion(test_client) -> str:
    """An upload of one part, sent whole: its ``…/complete`` URL."""
    body = b'{"kind":"node","urn":"urn:a","entityType":"Table"}\n'
    up = (await test_client.post(f"{_IMPORTS}/uploads", json={
        "fileName": "f.ndjson", "size": len(body), "format": "ndjson"})).json()
    url = f"{_IMPORTS}/uploads/{up['uploadId']}"
    assert (await test_client.put(f"{url}/parts/0", content=body)).status_code == 200
    return f"{url}/complete"


async def test_asking_for_it_carries_it_to_the_job(test_client, imports):
    one = await test_client.post(_IMPORTS, params={"autoPublish": "true"}, content=b"{}\n")
    assert one.status_code == 202, one.text
    done = await test_client.post(await _completion(test_client), params={"autoPublish": "true"})
    assert done.status_code == 202, done.text
    assert [job["auto_publish"] for job in imports.created] == [True, True]
    plain = await test_client.post(_IMPORTS, content=b"{}\n")
    assert plain.status_code == 202 and imports.created[-1]["auto_publish"] is False


async def test_it_opens_a_draft_of_its_own(test_client, imports):
    for url in (_IMPORTS, await _completion(test_client)):
        refused = await test_client.post(url, params={"autoPublish": "true", "branchId": "br_7"},
                                         content=b"{}\n")
        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"]["type"] == "auto_publish_needs_own_draft"
    assert imports.created == []


async def test_it_needs_publish(test_client, imports):
    from backend.app.main import app

    url = await _completion(test_client)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="s", ws_perms={"ws1": ("workspace:datasource:read", "workspace:datasource:manage")})
    for target in (_IMPORTS, url):
        refused = await test_client.post(target, params={"autoPublish": "true"}, content=b"{}\n")
        assert refused.status_code == 403, refused.text
        assert refused.json()["detail"]["code"] == "publish_required"
    assert imports.created == []


async def test_it_needs_a_policy_that_lets_you_merge_your_own_changes(test_client, imports, monkeypatch):
    async def reviewed(_session, _data_source_id):
        return SimpleNamespace(self_merge=False)

    monkeypatch.setattr(versioning_ep, "_drafts_policy_of", reviewed)
    refused = await test_client.post(_IMPORTS, params={"autoPublish": "true"}, content=b"{}\n")
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["type"] == "review_required"
    assert imports.created == []
