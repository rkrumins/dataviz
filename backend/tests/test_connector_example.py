"""The reference connector (docs/examples/connector) keeps to the published contract.

Every record it writes passes the record format's contract, the same source always gives the same
file and so the same idempotency key, and it speaks the import API as documented: check, then
import — in one request, or in resumable parts past the body limit, sending only the parts the
server lacks — then wait for the job. A refused row stops it before anything is imported.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import httpx
import pytest

from backend.app.services.versioning.import_export import contract

_DIR = Path(__file__).resolve().parents[2] / "docs" / "examples" / "connector"
_spec = importlib.util.spec_from_file_location("reference_connector", _DIR / "connector.py")
connector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(connector)
SOURCE = json.loads((_DIR / "source.json").read_text(encoding="utf-8"))
BASE = "/api/v1/ws1/versioning/graphs/g1"


def test_every_record_passes_the_contract_and_the_same_source_gives_the_same_file():
    records = list(connector.to_records(SOURCE))
    for record in records:
        contract.validate_record(record)
    kinds = [(r["kind"], r.get("entityType") or r.get("edgeType"), r.get("_op")) for r in records]
    assert kinds.count(("node", "Table", None)) == 2 and kinds.count(("node", "Column", None)) == 4
    assert ("edge", "FLOWS_TO", None) in kinds and ("node", "Table", "delete") in kinds
    assert all(v is not None for r in records for v in r.values()), "a missing value is left out"
    body = connector.ndjson(records)
    assert body == connector.ndjson(list(connector.to_records(SOURCE)))
    assert connector.idempotency_key(body) == connector.idempotency_key(body)


class _Server:
    """The import API, recorded: a check that refuses nothing, a job that runs once."""

    def __init__(self, *, refuse=False, upload=None):
        self.calls, self.refuse, self.upload, self.polls = [], refuse, upload, 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.calls.append((method, path[len(BASE):], dict(request.url.params), request.content))
        if path.endswith("/imports/validate"):
            rows = [{"rowIndex": 0, "op": "invalid", "reasons": ["no"]}] if self.refuse else []
            return httpx.Response(200, json={"summary": {"new": 1}, "rows": rows,
                                             "unknownColumns": []})
        if path.endswith("/imports/uploads") and method == "POST":
            return httpx.Response(201, json=self.upload)
        if "/parts/" in path:
            return httpx.Response(200, json={"part": int(path.rsplit("/", 1)[1])})
        if path.endswith("/complete") or (path.endswith("/imports") and method == "POST"):
            return httpx.Response(202, json={"jobId": "vjob_1", "branchId": "br_1"})
        if path.endswith("/imports/vjob_1"):
            self.polls += 1
            status = "completed" if self.polls > 1 else "running"
            return httpx.Response(200, json={"jobId": "vjob_1", "status": status,
                                             "summary": {"new": 9}})
        return httpx.Response(404)


def _graph(server):
    return connector.Graph(httpx.Client(base_url="http://test", transport=httpx.MockTransport(server)),
                           "ws1", "g1")


def test_it_checks_then_imports_once_under_the_files_key(monkeypatch):
    monkeypatch.setattr(connector.time, "sleep", lambda _s: None)
    server = _Server()
    result = connector.run(_graph(server), SOURCE)
    assert result["imported"]["status"] == "completed"
    methods = [(m, p) for m, p, _q, _b in server.calls]
    assert methods == [("POST", "/imports/validate"), ("POST", "/imports"),
                       ("GET", "/imports/vjob_1"), ("GET", "/imports/vjob_1")]
    _m, _p, query, body = server.calls[1]
    assert query == {"format": "ndjson", "idempotencyKey": connector.idempotency_key(body)}


def test_a_large_file_goes_up_in_parts_sending_only_those_the_server_lacks(monkeypatch):
    monkeypatch.setattr(connector.time, "sleep", lambda _s: None)
    monkeypatch.setattr(connector, "BODY_LIMIT", 10)
    body = connector.ndjson(list(connector.to_records(SOURCE)))
    step = -(-len(body) // 3)
    server = _Server(upload={"uploadId": "up1", "parts": 3, "partBytes": step, "received": [1]})
    graph = _graph(server)
    job = graph.wait(graph.start_import(body, key="k")["jobId"])
    assert job["status"] == "completed"
    parts = [(p, b) for m, p, _q, b in server.calls if m == "PUT"]
    assert [p for p, _b in parts] == ["/imports/uploads/up1/parts/0", "/imports/uploads/up1/parts/2"]
    assert parts[0][1] == body[:step] and parts[1][1] == body[2 * step:]
    assert ("POST", "/imports/uploads/up1/complete") in [(m, p) for m, p, _q, _b in server.calls]


def test_a_refused_row_stops_it_before_anything_is_imported():
    server = _Server(refuse=True)
    result = connector.run(_graph(server), SOURCE)
    assert result["imported"] is None
    assert [p for _m, p, _q, _b in server.calls] == ["/imports/validate"]


def test_an_answer_the_api_refuses_is_raised():
    graph = connector.Graph(httpx.Client(base_url="http://test", transport=httpx.MockTransport(
        lambda _r: httpx.Response(413, json={"detail": "too large"}))), "ws1", "g1")
    with pytest.raises(RuntimeError, match="413"):
        graph.validate(b"{}\n")
