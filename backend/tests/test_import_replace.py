"""Replace reconcile mode — the deliberate delete-on-absence override. Every EXISTING entity not
matched by a file row is deleted (upsert never does this). Pure test of the derivation."""
from backend.app.services.versioning.import_export.import_worker import _append_replace_deletes


def _run() -> None:
    # graph has nodes n1/n2/n3 + edges e1/e2; the file only touched n1 (update) + minted a new node.
    resolutions = [
        {"matched_entity_id": "n1", "kind": "node", "status": "updated"},
        {"matched_entity_id": "new_ent", "kind": "node", "status": "new"},   # create → not in graph yet
        {"matched_entity_id": "e1", "kind": "edge", "status": "unchanged"},
    ]
    indexes = {"node_eids": {"n1", "n2", "n3"}, "edge_eids": {"e1", "e2"}}
    ops, count = _append_replace_deletes([{"op": "update", "entity_kind": "node", "entity_id": "n1"}],
                                         resolutions, indexes)
    deletes = {o["entity_id"] for o in ops if o["op"] == "delete"}
    # n2,n3 (unmatched nodes) + e2 (unmatched edge) deleted; n1/e1 kept; the minted create ignored.
    assert deletes == {"n2", "n3", "e2"}, deletes
    assert count == 3, count

    # upsert-style call (no replace) is simply never invoked; sanity: empty graph → nothing deleted.
    _, c2 = _append_replace_deletes([], [], {"node_eids": set(), "edge_eids": set()})
    assert c2 == 0


def test_import_replace():
    _run()


if __name__ == "__main__":
    _run()
    print("import replace: OK")
