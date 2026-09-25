"""Replace reconcile mode — the deliberate delete-on-absence override. Every EXISTING entity in
scope that no file row matched is deleted (upsert never does this): edges first, then nodes, a page
at a time. A view-scoped replace deletes only the view's own entities. The snapshot, the job's
matched ids and the versioning service are faked; integration/test_import_windows.py runs it on
Postgres."""
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
