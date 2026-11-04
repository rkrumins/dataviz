"""A reference connector: a source system's catalog into a data source's graph.

It does what any connector does, through the documented HTTP API alone
(docs/CONNECTOR_GUIDE.md):

1. map the source's records to import records (format v1, ``GET …/imports/schema``): a node per
   table and column, an edge per containment and lineage link, a delete for what the source
   dropped — each node pointed at by a urn of the source's own, which never changes;
2. write them as NDJSON;
3. check them without importing (``POST …/imports/validate``);
4. import them into a draft — in one request, or in resumable parts past 100 MB — under an
   idempotency key drawn from the file, so a retried run never imports it twice;
5. wait for the job, and report what it did.

Run it again on the same source and nothing changes: every row points at its node by the same
urn, and the server derives the same ids from them. Change the source and only what changed is
written. The draft is reviewed and published like any other.

Usage::

    SYNODIC_URL=https://synodic.example.com SYNODIC_TOKEN=nxsat_… \\
        python connector.py source.json --workspace ws_… --graph gv_… [--check]

Needs only ``httpx``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from typing import Any, Dict, Iterator, List, Optional

import httpx

#: A file larger than this goes up in parts (``POST …/imports/uploads``).
BODY_LIMIT = 100 * 1024 * 1024
FINISHED = ("completed", "failed", "cancelled")


def to_records(source: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """The source's catalog as import records. A urn here is the source's own name for a thing;
    the server stores it nowhere, but finds the node by it on every later run."""
    system = source.get("system", "acme")

    def urn(kind: str, name: str) -> str:
        return f"urn:{system}:{kind}:{name}"

    for table in source.get("tables", []):
        yield _clean({"kind": "node", "urn": urn("table", table["name"]), "entityType": "Table",
                      "displayName": table["name"], "description": table.get("description"),
                      "prop.owner": table.get("owner"), "prop.tier": table.get("tier")})
        for column in table.get("columns", []):
            name = f"{table['name']}.{column['name']}"
            yield _clean({"kind": "node", "urn": urn("column", name), "entityType": "Column",
                          "displayName": column["name"], "prop.dataType": column.get("type")})
            yield {"kind": "edge", "edgeType": "CONTAINS", "sourceUrn": urn("table", table["name"]),
                   "targetUrn": urn("column", name)}
    for link in source.get("lineage", []):
        yield {"kind": "edge", "edgeType": "FLOWS_TO", "sourceUrn": urn("table", link["from"]),
               "targetUrn": urn("table", link["to"])}
    for name in source.get("removed", []):                 # what the source dropped since
        yield {"kind": "node", "urn": urn("table", name), "entityType": "Table", "_op": "delete"}


def _clean(record: Dict[str, Any]) -> Dict[str, Any]:
    """Leave out what the source doesn't say: a missing value keeps what the graph holds (to
    remove a property, send ``\\N``)."""
    return {k: v for k, v in record.items() if v is not None}


def ndjson(records: List[Dict[str, Any]]) -> bytes:
    """The records as an NDJSON file, byte for byte the same for the same records."""
    return "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in records).encode()


def idempotency_key(body: bytes) -> str:
    """The same file, the same key: sent again, an import answers with the job it started."""
    return "connector:" + hashlib.sha256(body).hexdigest()[:40]


class Graph:
    """One versioned graph, over the API."""

    def __init__(self, http: httpx.Client, workspace: str, graph: str):
        self.http = http
        self.base = f"/api/v1/{workspace}/versioning/graphs/{graph}"

    def validate(self, body: bytes) -> Dict[str, Any]:
        return _ok(self.http.post(f"{self.base}/imports/validate", params={"format": "ndjson"},
                                  content=body))

    def start_import(self, body: bytes, *, key: str, branch_id: Optional[str] = None) -> Dict[str, Any]:
        params = {"format": "ndjson", "idempotencyKey": key, **({"branchId": branch_id} if branch_id else {})}
        if len(body) <= BODY_LIMIT:
            return _ok(self.http.post(f"{self.base}/imports", params=params, content=body))
        upload = _ok(self.http.post(f"{self.base}/imports/uploads", json={
            "fileName": "connector.ndjson", "size": len(body), "format": "ndjson"}))
        step, done = upload["partBytes"], set(upload.get("received") or [])
        for n in range(upload["parts"]):
            if n not in done:                              # a resumed upload sends only the rest
                _ok(self.http.put(f"{self.base}/imports/uploads/{upload['uploadId']}/parts/{n}",
                                  content=body[n * step:(n + 1) * step]))
        return _ok(self.http.post(f"{self.base}/imports/uploads/{upload['uploadId']}/complete",
                                  params={k: v for k, v in params.items() if k == "branchId"}))

    def wait(self, job_id: str, *, every: float = 2.0, limit: float = 3600.0) -> Dict[str, Any]:
        deadline = time.monotonic() + limit
        while True:
            job = _ok(self.http.get(f"{self.base}/imports/{job_id}"))
            if job["status"] in FINISHED:
                return job
            if time.monotonic() > deadline:
                raise TimeoutError(f"import {job_id} is still {job['status']}")
            time.sleep(every)


def _ok(response: httpx.Response) -> Dict[str, Any]:
    if response.status_code >= 400:
        raise RuntimeError(f"{response.request.method} {response.request.url.path}: "
                           f"{response.status_code} {response.text}")
    return response.json()


def run(graph: Graph, source: Dict[str, Any], *, check_only: bool = False) -> Dict[str, Any]:
    body = ndjson(list(to_records(source)))
    check = graph.validate(body)
    refused = [r for r in check["rows"] if r["op"] == "invalid"]
    if check_only or refused:
        return {"checked": check, "imported": None}
    started = graph.start_import(body, key=idempotency_key(body))
    return {"checked": check, "imported": graph.wait(started["jobId"])}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", help="the source system's catalog (JSON)")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--graph", required=True, help="the data source's versioned graph id")
    parser.add_argument("--check", action="store_true", help="check the file, import nothing")
    args = parser.parse_args(argv)
    with open(args.source, encoding="utf-8") as f:
        source = json.load(f)
    with httpx.Client(base_url=os.environ["SYNODIC_URL"], timeout=120,
                      headers={"Authorization": f"Bearer {os.environ['SYNODIC_TOKEN']}"}) as http:
        result = run(Graph(http, args.workspace, args.graph), source, check_only=args.check)
    print(json.dumps({"would": result["checked"]["summary"],
                      "refused": [r for r in result["checked"]["rows"] if r["op"] == "invalid"],
                      "unknownColumns": result["checked"]["unknownColumns"],
                      "job": result["imported"] and {k: result["imported"].get(k) for k in
                                                     ("jobId", "branchId", "status", "summary")}},
                     indent=2))
    return 0 if result["imported"] is None or result["imported"]["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
