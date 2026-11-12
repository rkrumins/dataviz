"""The reference connector (docs/examples/connector) keeps to the published contract.

Every record it writes passes the record format's contract, and the same source always gives the
same file. It speaks the import API as documented, against a server that answers as the real one
does:

* the file goes up in resumable parts, read from disk, several at once;
* a run that stopped is resumed by the next, which sends only the parts the server lacks, and
  sends none once the upload is complete;
* an answer the server says to ask again for is asked again after its ``Retry-After``;
* with ``--publish`` the import publishes itself, and the connector follows that publish to its
  end;
* an import that couldn't publish itself fails the run, with the reason;
* one whose publish was never written is published by the connector.

Every call it makes is one an API key may make (``api_key_surface``).
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import httpx
import pytest
from starlette.routing import compile_path

from backend.app.services.versioning.import_export import contract

_DIR = Path(__file__).resolve().parents[2] / "docs" / "examples" / "connector"
_spec = importlib.util.spec_from_file_location("reference_connector", _DIR / "connector.py")
connector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(connector)
SOURCE = json.loads((_DIR / "source.json").read_text(encoding="utf-8"))
BASE = "/api/v1/ws1/versioning/graphs/g1"
PART = 64


class _Server:
    """The import API as it answers: an upload's parts kept as they arrive, an import that runs
    once and reports how its publish went (``note``: a ``summary.publish``, or ``None`` when the
    worker never wrote one), and a publish job that lands."""

    def __init__(self, *, note=None, busy=frozenset(), branch="open", failure=None):
        self.calls, self.uploads, self.polls = [], {}, 0
        self.note, self.busy, self.branch, self.failure = note, set(busy), branch, failure

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path
        self.calls.append((method, path, dict(request.url.params)))
        tail = path[len(BASE):]
        if tail == "/imports/uploads" and method == "POST":
            body = json.loads(request.content)
            upload = {"uploadId": f"iu_{len(self.uploads)}", "fileName": body["fileName"],
                      "size": body["size"], "format": body["format"], "partBytes": PART,
                      "parts": -(-body["size"] // PART), "jobId": None, "parts_in": {}}
            self.uploads[upload["uploadId"]] = upload
            return httpx.Response(201, json=self._view(upload))
        found = re.fullmatch(r"/imports/uploads/(iu_\d+)(/parts/(\d+)|/complete)?", tail)
        if found:
            upload = self.uploads.get(found.group(1))
            if upload is None:
                return httpx.Response(404, json={"detail": "This upload has expired or was never started."})
            if found.group(3) is not None:                                  # PUT a part
                n = int(found.group(3))
                if n in self.busy:
                    self.busy.discard(n)
                    return httpx.Response(503, headers={"Retry-After": "7"}, json={"detail": "busy"})
                upload["parts_in"][n] = request.content
                return httpx.Response(200, json={"part": n, "size": len(request.content)})
            if found.group(2) == "/complete":
                upload["jobId"] = "vjob_1"
                return httpx.Response(202, json={"jobId": "vjob_1", "branchId": "br_1", "status": "pending"})
            return httpx.Response(200, json=self._view(upload))
        if tail == "/imports/vjob_1":
            self.polls += 1
            if self.polls == 1:
                return httpx.Response(200, json={"jobId": "vjob_1", "branchId": "br_1", "status": "running",
                                                 "phase": "nodes", "processed": 1, "total": 2})
            summary = {"new": 9, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}
            if self.failure is not None:
                return httpx.Response(200, json={"jobId": "vjob_1", "branchId": "br_1", "status": "failed",
                                                 "errorMessage": "Nothing was deleted: …",
                                                 "summary": {**summary, "failure": self.failure}})
            if self.note is not None:
                summary["publish"] = self.note
            return httpx.Response(200, json={"jobId": "vjob_1", "branchId": "br_1", "status": "completed",
                                             "summary": summary})
        if tail.startswith("/publish-jobs/"):
            return httpx.Response(200, json={"jobId": tail.rsplit("/", 1)[1], "graphId": "g1",
                                             "status": "completed", "commitId": "cmt_1", "revisionId": 7,
                                             "error": None})
        if tail == "/branches/br_1" and method == "GET":
            return httpx.Response(200, json={"branchId": "br_1", "kind": "draft", "status": self.branch})
        if tail == "/branches/br_1/publish":
            self.branch = "merged"
            return httpx.Response(200, json={"commitId": "cmt_2", "revisionId": 8, "status": "completed"})
        if tail == "/imports/validate":
            return httpx.Response(200, json={"summary": {"new": 1}, "rows": [], "unknownColumns": [],
                                             "hints": []})
        return httpx.Response(404, json={"detail": "not found"})

    @staticmethod
    def _view(upload):
        return {**{k: v for k, v in upload.items() if k != "parts_in"}, "received": sorted(upload["parts_in"])}

    def sent(self, upload_id: str) -> bytes:
        parts = self.uploads[upload_id]["parts_in"]
        return b"".join(parts[n] for n in sorted(parts))


@pytest.fixture
def world(tmp_path):
    """The source's file on disk, and a connector to a server that answers as the API does."""
    path = tmp_path / "source.ndjson"
    connector.write_ndjson(connector.to_records(SOURCE), str(path))
    slept = []

    def graph(server):
        api = connector.Api(httpx.Client(base_url="http://test", transport=httpx.MockTransport(server)),
                            sleep=slept.append)
        return connector.Graph(api, "ws1", "g1", sleep=slept.append, log=lambda _message: None)

    return path, str(tmp_path / "state.json"), graph, slept


def test_every_record_passes_the_contract_and_the_same_source_gives_the_same_file(tmp_path):
    records = list(connector.to_records(SOURCE))
    for record in records:
        contract.validate_record(record)
    kinds = [(r["kind"], r.get("entityType") or r.get("edgeType"), r.get("_op")) for r in records]
    assert kinds.count(("node", "Table", None)) == 2 and kinds.count(("node", "Column", None)) == 4
    assert ("edge", "FLOWS_TO", None) in kinds and ("node", "Table", "delete") in kinds
    assert all(v is not None for r in records for v in r.values()), "a missing value is left out"
    first, second = tmp_path / "a.ndjson", tmp_path / "b.ndjson"
    connector.write_ndjson(connector.to_records(SOURCE), str(first))
    connector.write_ndjson(iter(records), str(second))
    assert first.read_bytes() == second.read_bytes()
    assert connector.sha256_of(str(first)) == connector.sha256_of(str(second))


def test_a_file_goes_up_in_parts_from_disk_and_publishes_itself(world):
    path, state, graph, _slept = world
    server = _Server(note={"state": "queued", "jobId": "pjob_1"})
    result = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state)
    (upload_id,) = server.uploads
    assert server.sent(upload_id) == path.read_bytes(), "every part, in order, as the file has it"
    assert ("POST", f"{BASE}/imports/uploads/{upload_id}/complete",
            {"reconcileMode": "upsert", "autoPublish": "true"}) in server.calls
    assert ("GET", f"{BASE}/publish-jobs/pjob_1", {}) in server.calls
    assert result["publish"] == {"state": "completed", "commitId": "cmt_1", "revisionId": 7, "error": None}
    assert connector.succeeded(result)


def test_a_run_that_stopped_is_resumed_sending_only_the_missing_parts(world):
    path, state, graph, _slept = world
    server = _Server(note={"state": "unchanged"})
    first = graph(server)
    upload = first.api("POST", f"{BASE}/imports/uploads", json={
        "fileName": "source.ndjson", "size": path.stat().st_size, "format": "ndjson"})
    data = path.read_bytes()
    for n in (0, 2):                                   # what the run that stopped got through
        first.api("PUT", f"{BASE}/imports/uploads/{upload['uploadId']}/parts/{n}",
                  content=data[n * PART:(n + 1) * PART])
    Path(state).write_text(json.dumps({"sha256": connector.sha256_of(str(path)), "graph": "g1",
                                       "uploadId": upload["uploadId"]}))
    server.calls.clear()
    result = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state)
    puts = sorted(int(p.rsplit("/", 1)[1]) for m, p, _q in server.calls if m == "PUT")
    assert 0 not in puts and 2 not in puts and puts == [n for n in range(upload["parts"]) if n not in (0, 2)]
    assert len(server.uploads) == 1 and server.sent(upload["uploadId"]) == data
    assert result["publish"] == {"state": "unchanged"} and connector.succeeded(result)

    server.calls.clear()                               # once complete, nothing is sent again
    connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state)
    assert [m for m, _p, _q in server.calls if m == "PUT"] == []


def test_a_busy_server_is_asked_again_after_its_retry_after(world):
    path, state, graph, slept = world
    server = _Server(note={"state": "queued", "jobId": "pjob_1"}, busy={1})
    result = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state)
    assert 7.0 in slept, "it waited as long as the server asked"
    assert server.sent(next(iter(server.uploads))) == path.read_bytes() and connector.succeeded(result)


def test_an_import_that_could_not_publish_itself_fails_the_run_with_the_reason(world):
    path, state, graph, _slept = world
    reason = {"type": "rows_refused", "rows": 2, "message": "2 row(s) weren't imported."}
    server = _Server(note={"state": "skipped", "reason": reason})
    result = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state)
    assert result["publish"] == {"state": "skipped", "reason": reason}
    assert not connector.succeeded(result)


def test_a_publish_the_import_never_wrote_is_done_by_the_connector(world):
    """The worker stopped between the import and its publish: the connector waits a minute for the
    import to say how its publish went, then publishes the draft itself."""
    path, state, graph, _slept = world
    server = _Server(note=None)
    result = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state)
    assert ("POST", f"{BASE}/branches/br_1/publish", {}) in server.calls
    assert result["publish"] == {"state": "completed", "commitId": "cmt_2", "revisionId": 8}
    assert connector.succeeded(result)


def test_without_publish_the_draft_waits_for_review(world):
    path, state, graph, _slept = world
    server = _Server(note=None)
    result = connector.run(graph(server), str(path), "ndjson", publish=False, state_path=state)
    assert "publish" not in result and result["job"]["branchId"] == "br_1" and connector.succeeded(result)
    assert [c for c in server.calls if "/publish" in c[1]] == []


def test_the_dry_run_sends_no_more_than_a_dry_run_reads(world, monkeypatch):
    path, _state, graph, _slept = world
    monkeypatch.setattr(connector, "CHECK_ROWS", 3)
    head = connector._head(str(path), "ndjson")
    assert head.count(b"\n") == 3 and path.read_bytes().startswith(head)
    monkeypatch.setattr(connector, "CHECK_BYTES", 10)
    assert connector._head(str(path), "ndjson") == b"", "never half a line"
    server = _Server()
    assert graph(server).check(str(path), "ndjson")["summary"] == {"new": 1}
    assert server.calls == [("POST", f"{BASE}/imports/validate", {"format": "ndjson"})]


def test_an_answer_the_api_refuses_is_raised_with_its_detail():
    api = connector.Api(httpx.Client(base_url="http://test", transport=httpx.MockTransport(
        lambda _r: httpx.Response(413, json={"detail": "too large"}))), sleep=lambda _s: None)
    with pytest.raises(connector.ApiError, match="413") as refused:
        api("POST", f"{BASE}/imports/validate", content=b"{}\n")
    assert refused.value.detail == "too large"


def test_every_call_it_makes_is_one_an_api_key_may_make(world):
    """Held against the routes the app mounts and opens to keys: a renamed route, or one a key
    can't call, fails here rather than in a team's nightly run."""
    from backend.app.auth import api_key_surface
    from backend.app.main import app

    path, state, graph, _slept = world
    routes = [(method, compile_path(route)[0]) for method, route, _rule in api_key_surface.eligible(app)]
    calls = set()
    for n, server in enumerate((_Server(note={"state": "queued", "jobId": "pjob_1"}), _Server(note=None))):
        connector.run(graph(server), str(path), "ndjson", publish=True, state_path=f"{state}.{n}")
        graph(server).check(str(path), "ndjson")
        calls |= {(m, p) for m, p, _q in server.calls}
    unknown = sorted(f"{m} {p}" for m, p in calls
                     if not any(m == method and regex.match(p) for method, regex in routes))
    assert not unknown, unknown


def test_a_full_replace_is_completed_as_one_and_publishes_itself(world):
    """``--replace --identifier urn --publish``: the upload is completed as a replace matched by
    urn, which publishes itself."""
    path, state, graph, _slept = world
    server = _Server(note={"state": "queued", "jobId": "pjob_1"})
    result = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state,
                           replace=True, identifier="urn")
    (upload_id,) = server.uploads
    assert ("POST", f"{BASE}/imports/uploads/{upload_id}/complete",
            {"reconcileMode": "replace", "identifier": "urn", "autoPublish": "true"}) in server.calls
    assert connector.succeeded(result)


def test_a_replace_the_guard_refused_says_why_and_its_retry_sends_the_file_again(world):
    """A replace the guard refused fails the run with the server's code. The retry, with
    ``--allow-mass-delete`` into the same draft, is a new upload (an upload is imported once): it is
    completed into that draft, and the connector publishes the draft, as autoPublish can't go with it."""
    path, state, graph, _slept = world
    logged = []
    server = _Server(failure={"code": "mass_delete_blocked", "action": "allow_mass_delete"})
    g = graph(server)
    g.log = logged.append
    refused = connector.run(g, str(path), "ndjson", publish=True, state_path=state, replace=True)
    assert refused["job"]["status"] == "failed" and not connector.succeeded(refused)
    assert any("mass_delete_blocked" in line for line in logged), logged

    server.failure = None
    retried = connector.run(graph(server), str(path), "ndjson", publish=True, state_path=state,
                            replace=True, allow_mass_delete=True, branch="br_1")
    assert len(server.uploads) == 2, "the retry is an upload of its own"
    assert ("POST", f"{BASE}/imports/uploads/iu_1/complete",
            {"reconcileMode": "replace", "allowMassDelete": "true", "branchId": "br_1"}) in server.calls
    assert ("POST", f"{BASE}/branches/br_1/publish", {}) in server.calls
    assert retried["publish"] == {"state": "completed", "commitId": "cmt_2", "revisionId": 8}
    assert connector.succeeded(retried)
