"""Replace reconcile mode — the deliberate delete-on-absence override. Every EXISTING entity in
scope that no file row matched is deleted (upsert never does this): edges first, then nodes, a page
at a time. A view-scoped replace deletes only the view's own entities. The snapshot, the job's
matched ids and the versioning service are faked; integration/test_import_windows.py runs it on
Postgres."""
import contextlib
import json

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.snapshot import Winner


class _Snap:
    page_size = 2

    def __init__(self, nodes, edges):
        self._nodes = list(nodes)
        self._edges = dict(edges)             # eid -> (source, target)

    async def iter_live(self, kind):
        ids = self._nodes if kind == "node" else list(self._edges)
        for i in range(0, len(ids), self.page_size):
            yield [Winner(eid, True) for eid in ids[i:i + self.page_size]]

    async def lookup_live(self, kind, ids):
        return {eid: Winner(eid, True) for eid in ids if eid in self._nodes}

    async def edges_between(self, sources, targets):
        return {(s, t, "CONTAINS"): eid for eid, (s, t) in self._edges.items() if s in sources and t in targets}


class _Versioning:
    def __init__(self):
        self.deletes = []

    async def apply_ops(self, *, ops, **_kw):
        self.deletes += [(op["entity_kind"], op["entity_id"]) for op in ops if op["op"] == "delete"]


def _worker(matched, scope=None):
    svc = _Versioning()
    worker = ImportWorker(svc, store=None, scope=scope)

    async def unmatched(_job_id, eids):
        return [eid for eid in eids if eid not in matched]

    worker._unmatched = unmatched
    return worker, svc


async def test_every_entity_no_row_matched_is_deleted_edges_first():
    # The graph: nodes n1..n3 and the node this import created; edges e1, e2. The file matched n1
    # and e1, and created new_ent (a created entity is matched by the id it was given).
    worker, svc = _worker({"n1", "e1", "new_ent"})
    snap = _Snap(["n1", "n2", "n3", "new_ent"], {"e1": ("n1", "n2"), "e2": ("n2", "n3")})

    assert await worker._delete_absent("vjob_1", snap, "g1", "br1", "u") == 3
    assert svc.deletes == [("edge", "e2"), ("node", "n2"), ("node", "n3")]


async def test_nothing_to_delete_when_every_entity_was_matched():
    worker, svc = _worker({"n1", "e1"})
    snap = _Snap(["n1"], {"e1": ("n1", "n1")})

    assert await worker._delete_absent("vjob_1", snap, "g1", "br1", "u") == 0
    assert svc.deletes == []


async def test_a_view_scoped_replace_deletes_only_the_views_own_entities(monkeypatch):
    # The view places A, which holds B and C; X is outside it, with an edge x_a into A.
    async def view_entities(_snap, _scope):
        return {"keep": {"A", "B", "C"}}

    monkeypatch.setattr(import_worker, "view_entities", view_entities)
    worker, svc = _worker({"A", "B", "a_b"}, scope={"assigned_urns": ["urn:A"]})
    snap = _Snap(["A", "B", "C", "X"], {"a_b": ("A", "B"), "b_c": ("B", "C"), "x_a": ("X", "A")})

    assert await worker._delete_absent("vjob_1", snap, "g1", "br1", "u") == 2
    assert svc.deletes == [("edge", "b_c"), ("node", "C")], "X and x_a are outside the view"


# ── A replace refuses to delete when the file has rows it couldn't apply ─────────────────────
# A replace deletes whatever no row matched. A row that is invalid, or a record that is neither a
# node nor an edge, may name an entity the file means to keep, so its entity would be deleted.


class _Lease:
    epoch = 1

    def __init__(self):
        self.checkpoints = []

    async def retry_transient(self, fn):
        return await fn()

    async def checkpoint(self, _s, **values):
        self.checkpoints.append(values)


def _replace(monkeypatch, summary):
    worker, svc = _worker(set())
    worker._lease = _Lease()
    windows = []

    async def open_snapshot(**_kw):
        return _Snap(["n1", "n2"], {})

    async def position(_job_id):
        return import_worker._Position("edge:9", dict(summary), 10, 10)

    async def next_window(*_a):
        windows.append(_a)
        return False

    monkeypatch.setattr(import_worker, "open_snapshot", open_snapshot)
    worker._position, worker._next_window = position, next_window
    return worker, svc, windows


async def test_a_replace_with_an_invalid_row_deletes_nothing(monkeypatch):
    worker, svc, _ = _replace(monkeypatch, {"new": 9, "invalid": 1})
    with pytest.raises(ValueError, match="Nothing was deleted: 1 row"):
        await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "replace")
    assert svc.deletes == []


async def test_a_replace_with_skipped_records_writes_nothing(monkeypatch):
    worker, svc, windows = _replace(monkeypatch, {"skipped": 1})
    with pytest.raises(ValueError, match="Nothing was deleted: 1 record"):
        await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "replace")
    assert svc.deletes == [] and windows == [], "refused before the first window"


async def test_an_upsert_reports_skipped_records_and_applies_the_rest(monkeypatch):
    worker, _svc, windows = _replace(monkeypatch, {"new": 2, "skipped": 1})
    summary = await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "upsert")
    assert summary == {"new": 2, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0,
                       "skipped": 1}
    assert len(windows) == 1


def test_a_record_is_a_node_or_an_edge_whatever_its_case_and_anything_else_is_counted():
    rows, skipped = import_worker._normalize_page([
        {"kind": "Node", "urn": "urn:a"}, {"kind": " edge ", "sourceUrn": "urn:a"},
        {"kind": "thing"}, ["not", "a", "record"]])
    assert [kind for kind, _row in rows] == ["node", "edge"]
    assert skipped == 2


async def test_the_skipped_count_is_kept_with_the_parse(monkeypatch):
    """Stored on the job when the parse ends, so a worker that takes the job over later still
    knows it."""
    worker, _svc = _worker(set())
    worker._lease = _Lease()

    async def position(_job_id):
        return import_worker._Position("parse:2", {}, 0, 0)

    async def parse(*_a):
        return 5, 3

    @contextlib.asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(ver_db, "graphver_session", session)
    worker._position, worker._parse = position, parse
    await worker._stage("vjob_1", "src", "ndjson")
    (cp,) = worker._lease.checkpoints
    assert (cp["last_cursor"], cp["total"], cp["summary"]) == ("node:-1", 5, {"skipped": 3})


async def test_a_resumed_parse_counts_every_skipped_record_of_the_file(tmp_path):
    """A resumed parse reads the file again from the top and stages only the rows past those
    already staged, but counts the skipped records of the whole file."""
    store = LocalFsObjectStore(tmp_path)
    lines = [{"kind": "thing"}, {"kind": "node", "urn": "urn:a"}, {"kind": "node", "urn": "urn:b"},
             {"kind": "x"}, {"kind": "edge", "sourceUrn": "urn:a", "targetUrn": "urn:b"}]

    async def body():
        yield "".join(json.dumps(line) + "\n" for line in lines).encode()

    await store.put_stream("source", body())
    worker = ImportWorker(None, store)
    staged = []

    async def flush(batch):
        staged.extend(batch)

    worker._flush, worker._skip = flush, 2
    assert await worker._parse("vjob_1", "source", "ndjson") == (3, 2)
    assert [(r["row_index"], r["kind"]) for r in staged] == [(2, "edge")]
