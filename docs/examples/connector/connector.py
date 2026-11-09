"""A reference connector: a source system's catalog, or any NDJSON, CSV or TSV file, into a data
source's graph, through the documented HTTP API alone (docs/CONNECTOR_GUIDE.md).

1. Map the source's records to import records (format v1, ``GET …/imports/schema``), each node
   pointed at by a urn of the source's own, and write them to an NDJSON file on disk. Or bring a
   file you already have (``--file``): gigabytes are fine.
2. Send the file in resumable parts (``POST …/imports/uploads``), several at once, read from disk.
   An answer the server says to ask again for is asked again. A run that stops is resumed by the
   next one, from a state file kept beside the file.
3. Import it into a draft (``…/complete``). With ``--publish``, the import publishes itself onto the
   published graph once every row is applied (``autoPublish``). With ``--bulk``, it loads the
   published graph itself, with no draft and no publish (``bulk``): the fastest way in for a large
   file, which lands whole once every row is in.
4. Follow the import, then its publish, and report what they did.

Run it again on the same source and nothing changes: every row points at its node by the same urn,
and the server derives the same ids from them. Change the source, and only what changed is written.

Usage::

    export SYNODIC_URL=https://synodic.example.com SYNODIC_TOKEN=nxsat_…   # a service account's key
    python connector.py source.json --workspace ws_… --graph graph_… --check     # a dry run only
    python connector.py source.json --workspace ws_… --graph graph_… --publish
    python connector.py --file export.csv --workspace ws_… --graph graph_… --publish
    python connector.py --file big.ndjson --workspace ws_… --graph graph_… --bulk

Needs only ``httpx``.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from typing import Any

import httpx

#: Parts sent at once. Each part (16 MiB) must arrive within the API's 120 s, so a slow uplink wants
#: fewer: 4 at once needs about 4.5 Mbit/s.
PARALLEL = 4
#: Answers worth asking again for: the server was busy, timed out, or failed for a moment.
RETRY = frozenset({408, 425, 429, 500, 502, 503, 504})
FINISHED = ("completed", "failed", "cancelled")
#: How much of a file the dry run takes (``POST …/imports/validate``): 8 MiB and 10,000 rows.
CHECK_BYTES, CHECK_ROWS = 8 * 1024 * 1024, 10_000
FORMATS = {"ndjson": "ndjson", "jsonl": "ndjson", "csv": "csv", "tsv": "tsv"}


def to_records(source: dict[str, Any]) -> Iterator[dict[str, Any]]:
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


def _clean(record: dict[str, Any]) -> dict[str, Any]:
    """Leave out what the source doesn't say: a missing value keeps what the graph holds (to
    remove a property, send ``\\N``)."""
    return {k: v for k, v in record.items() if v is not None}


def write_ndjson(records: Iterable[dict[str, Any]], path: str) -> None:
    """The records as an NDJSON file, written as they come: byte for byte the same file for the
    same records, so a run that stopped is resumed by the next."""
    with open(path, "w", encoding="utf-8", newline="\n") as out:
        out.writelines(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n"
                       for record in records)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class ApiError(RuntimeError):
    """An answer the API refused with, and its ``detail``."""

    def __init__(self, response: httpx.Response):
        self.status = response.status_code
        try:
            self.detail = response.json().get("detail")
        except ValueError:
            self.detail = response.text
        super().__init__(f"{response.request.method} {response.request.url.path}: "
                         f"{self.status} {self.detail}")


class Api:
    """The HTTP API, asked again where its answer says to: a 429 or 503 after its ``Retry-After``,
    another of ``RETRY`` or a dropped connection after a pause that grows. Each call the connector
    makes does no harm sent twice: a part replaces itself, completing an upload again answers with
    its import, and a publish whose answer was lost finds its draft published."""

    def __init__(self, http: httpx.Client, *, attempts: int = 6, sleep: Callable = time.sleep):
        self.http, self.attempts, self.sleep = http, attempts, sleep

    def __call__(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        for attempt in range(1, self.attempts + 1):
            try:
                response = self.http.request(method, path, **kwargs)
            except httpx.TransportError:
                if attempt == self.attempts:
                    raise
                self.sleep(_pause(attempt))
                continue
            if response.status_code not in RETRY or attempt == self.attempts:
                break
            self.sleep(_retry_after(response) or _pause(attempt))
        if response.status_code >= 400:
            raise ApiError(response)
        return response.json()


def _pause(attempt: int) -> float:
    return min(30.0, 2.0 ** attempt)


def _retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After", "").strip()
    return float(value) if value.isdigit() else None


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class Graph:
    """One versioned graph, over the API."""

    def __init__(self, api: Api, workspace: str, graph: str, *, sleep: Callable = time.sleep,
                 log: Callable[[str], None] = _log):
        self.api, self.graph, self.sleep, self.log = api, graph, sleep, log
        self.base = f"/api/v1/{workspace}/versioning/graphs/{graph}"

    def check(self, path: str, fmt: str) -> dict[str, Any]:
        """A dry run of the file's first rows, as many as a dry run takes: what they would do, and
        why any would be refused. Advisory for a larger file: an edge whose end node comes later in
        it reads as refused here."""
        return self.api("POST", f"{self.base}/imports/validate", params={"format": fmt},
                        content=_head(path, fmt))

    def upload(self, path: str, fmt: str, state_path: str) -> dict[str, Any]:
        """The file, sent in parts; returns the upload as the server holds it. The same file (by its
        sha256) that an earlier run began to send is resumed: only the parts the server lacks are
        sent, and none once it was completed. An upload that expired (24 h) is begun again."""
        digest, upload = sha256_of(path), None
        state = _read_state(state_path)
        if state.get("sha256") == digest and state.get("graph") == self.graph:
            try:
                upload = self.api("GET", f"{self.base}/imports/uploads/{state['uploadId']}")
            except ApiError as exc:
                if exc.status != 404:
                    raise
        if upload is None:
            upload = self.api("POST", f"{self.base}/imports/uploads", json={
                "fileName": os.path.basename(path), "size": os.path.getsize(path), "format": fmt})
            _write_state(state_path, {"sha256": digest, "graph": self.graph,
                                      "uploadId": upload["uploadId"]})
        if not upload.get("jobId"):
            self._send(path, upload)
        return upload

    def _send(self, path: str, upload: dict[str, Any]) -> None:
        url, step = f"{self.base}/imports/uploads/{upload['uploadId']}/parts", upload["partBytes"]
        missing = sorted(set(range(upload["parts"])) - set(upload["received"]))

        def send(n: int) -> None:
            size = min(step, upload["size"] - n * step)
            self.api("PUT", f"{url}/{n}", content=_Part(path, n * step, size),
                     headers={"Content-Length": str(size)})

        done, every = upload["parts"] - len(missing), max(1, upload["parts"] // 20)
        with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
            for _ in pool.map(send, missing):
                done += 1
                if done % every == 0 or done == upload["parts"]:
                    self.log(f"sent {done} of {upload['parts']} parts")

    def start(self, upload: dict[str, Any], *, publish: bool, bulk: bool = False) -> dict[str, Any]:
        """Import the uploaded file: into a draft, or with ``bulk`` into the published graph itself.
        Completing an upload again answers with its import."""
        params = {"bulk": "true"} if bulk else {"autoPublish": "true"} if publish else {}
        return self.api("POST", f"{self.base}/imports/uploads/{upload['uploadId']}/complete",
                        params=params)

    def follow(self, path: str, label: str, *, every: float = 2.0, most: float = 30.0) -> dict[str, Any]:
        """A job, polled until it finishes, saying where it has got whenever that changes. The
        pause between polls grows to ``most``: a multi-gigabyte import runs for hours."""
        seen = None
        while True:
            job = self.api("GET", path)
            where = (job.get("status"), job.get("phase"), job.get("processed"))
            if where != seen:
                self.log(f"{label} {job.get('status')}"
                         + (f": {job['phase']} {job.get('processed')}/{job.get('total')}"
                            if job.get("phase") else ""))
                seen = where
            if job["status"] in FINISHED:
                return job
            self.sleep(every)
            every = min(most, every * 1.5)

    def published(self, job: dict[str, Any], *, wait: float = 60.0) -> dict[str, Any]:
        """How the import's publish of itself went (``summary.publish``), followed to its end. It is
        written just after the import completes; one the worker stopped before writing is done
        here instead: the draft published as its owner publishes it."""
        waited = 0.0
        while not (job.get("summary") or {}).get("publish") and waited < wait:
            self.sleep(5)
            waited += 5
            job = self.api("GET", f"{self.base}/imports/{job['jobId']}")
        note = (job.get("summary") or {}).get("publish")
        if note is None:
            return self.publish_draft(job["branchId"])
        if note["state"] == "queued":
            return _outcome(self.follow(f"{self.base}/publish-jobs/{note['jobId']}", "publish"))
        return note

    def publish_draft(self, branch_id: str) -> dict[str, Any]:
        """Publish the draft, unless it is published already, or being published."""
        while True:
            branch = self.api("GET", f"{self.base}/branches/{branch_id}")
            if branch["status"] == "merged":
                return {"state": "completed"}
            if branch["status"] != "publishing":
                break
            self.sleep(10)
        try:
            answer = self.api("POST", f"{self.base}/branches/{branch_id}/publish",
                              json={"message": "Published by the connector"})
        except ApiError as exc:                            # sent twice: the first one landed
            if exc.status == 409 and self.api("GET", f"{self.base}/branches/{branch_id}")["status"] \
                    in ("merged", "publishing"):
                return self.publish_draft(branch_id)
            raise
        if answer.get("jobId"):                            # a large draft publishes as a job
            return _outcome(self.follow(f"{self.base}/publish-jobs/{answer['jobId']}", "publish"))
        return {"state": "completed", "commitId": answer.get("commitId")}


class _Part:
    """One part of the file, read from disk as it is sent, 1 MiB at a time, and read afresh for each
    attempt: memory stays small however many parts are in flight, and a part sent again is whole."""

    def __init__(self, path: str, offset: int, size: int):
        self.path, self.offset, self.size = path, offset, size

    def __iter__(self) -> Iterator[bytes]:
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            left = self.size
            while left:
                block = f.read(min(1024 * 1024, left))
                if not block:
                    raise OSError(f"{self.path} is shorter than when its upload began")
                left -= len(block)
                yield block


def _outcome(job: dict[str, Any]) -> dict[str, Any]:
    return {"state": job["status"], "commitId": job.get("commitId"), "error": job.get("error")}


def _head(path: str, fmt: str) -> bytes:
    """The file's first whole lines, as many as a dry run takes (a CSV's header, then its rows)."""
    out, rows = bytearray(), CHECK_ROWS + (1 if fmt in ("csv", "tsv") else 0)
    with open(path, "rb") as f:
        for line in f:
            if rows == 0 or len(out) + len(line) > CHECK_BYTES:
                break
            out += line
            rows -= 1
    return bytes(out)


def _read_state(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_state(path: str, state: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f)


def run(graph: Graph, path: str, fmt: str, *, publish: bool, state_path: str,
        bulk: bool = False) -> dict[str, Any]:
    """Send the file, import it, and — with ``publish`` — see it published. With ``bulk`` the
    import lands on the published graph itself (``summary.landed``)."""
    upload = graph.upload(path, fmt, state_path)
    started = graph.start(upload, publish=publish, bulk=bulk)
    job = graph.follow(f"{graph.base}/imports/{started['jobId']}", "import")
    result: dict[str, Any] = {"uploadId": upload["uploadId"], "job": {
        k: job.get(k) for k in ("jobId", "branchId", "status", "summary", "errorMessage")}}
    if bulk:
        result["bulk"] = True
    elif publish and job["status"] == "completed":
        result["publish"] = graph.published(job)
    return result


def succeeded(result: dict[str, Any]) -> bool:
    """Imported — and, when asked, published, or there was nothing to publish. A bulk import that
    refused rows landed the rest: the run says so (``summary.invalid``, and the job's preview names
    them) and does not count as a success."""
    if result["job"]["status"] != "completed":
        return False
    if result.get("bulk"):
        return not int((result["job"].get("summary") or {}).get("invalid") or 0)
    return "publish" not in result or result["publish"]["state"] in ("completed", "unchanged")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", nargs="?", help="the source system's catalog (JSON) to map")
    parser.add_argument("--file", help="send this file instead: NDJSON, CSV or TSV")
    parser.add_argument("--format", choices=sorted(set(FORMATS.values())),
                        help="the file's format (default: from its extension)")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--graph", required=True, help="the data source's versioned graph id (graph_…)")
    parser.add_argument("--publish", action="store_true",
                        help="publish the import once every row is applied")
    parser.add_argument("--bulk", action="store_true",
                        help="load the published graph itself, with no draft (adds and updates only)")
    parser.add_argument("--check", action="store_true", help="dry-run the file's first rows, import nothing")
    parser.add_argument("--state", help="where to keep the upload's state (default: beside the file)")
    args = parser.parse_args(argv)
    if bool(args.source) == bool(args.file):
        parser.error("give a catalog to map, or --file to send")
    if args.source:
        with open(args.source, encoding="utf-8") as f:
            source = json.load(f)
        path, fmt = os.path.splitext(args.source)[0] + ".ndjson", "ndjson"
        write_ndjson(to_records(source), path)
    else:
        path = args.file
        fmt = args.format or FORMATS.get(os.path.splitext(path)[1].lstrip(".").lower())
        if fmt is None:
            parser.error("say the file's --format: ndjson, csv or tsv")
    with httpx.Client(base_url=os.environ["SYNODIC_URL"], timeout=150,
                      headers={"Authorization": f"Bearer {os.environ['SYNODIC_TOKEN']}"}) as http:
        graph = Graph(Api(http), args.workspace, args.graph)
        if args.check:
            print(json.dumps(graph.check(path, fmt), indent=2))
            return 0
        result = run(graph, path, fmt, publish=args.publish, bulk=args.bulk,
                     state_path=args.state or path + ".upload.json")
    print(json.dumps(result, indent=2))
    return 0 if succeeded(result) else 1


if __name__ == "__main__":
    sys.exit(main())
