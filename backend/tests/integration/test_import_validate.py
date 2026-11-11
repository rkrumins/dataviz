"""A dry run reads a file as an import would and writes nothing — needs Postgres.

``validate_import`` parses, normalizes and resolves a file against ``main`` (or a draft) the way an
import resolves a window — the same matching, the same new ids (derived from the file's pointers),
the same reasons a row is refused — and opens no draft, makes no job and writes no row. It names the
columns the record format doesn't know, and refuses a file larger than one window.
"""
import asyncio
import json
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export.resolve import pointer_id
from backend.app.services.versioning.import_export.service import DryRunTooLarge, ImportExportService
from backend.app.services.versioning.models import BranchORM, CommitORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

ONTOLOGY = {"node_types": ["Table"], "edge_types": ["FLOWS"]}


async def _ontology(_ws, _ds):
    return ONTOLOGY


def _ndjson(*lines) -> bytes:
    return ("\n".join(json.dumps(x) for x in lines) + "\n").encode()


async def _counts(gid):
    async with db.graphver_session() as s:
        return tuple([await s.scalar(select(func.count()).select_from(t).where(t.graph_id == gid))
                      for t in (JobORM, BranchORM, CommitORM)])


async def _run(svc) -> None:
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "urn:A",
         "payload": {"urn": "urn:A", "entityType": "Table", "displayName": "A"}}])
    ie = ImportExportService(versioning=svc, store=None, ontology_resolver=_ontology)
    before = await _counts(gid)
    data = _ndjson(
        {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A renamed"},
        {"kind": "node", "urn": "urn:li:new", "entityType": "Table", "displayName": "new",
         "prop_owner": "a typo"},
        {"kind": "node", "urn": "urn:li:bad", "entityType": "Nonsense"},
        {"kind": "edge", "edgeType": "FLOWS", "sourceUrn": "urn:li:new", "targetUrn": "urn:A"},
        {"kind": "view", "name": "not a row"},
    )
    out = await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds,
                                   branch_id=None, data=data, import_format="ndjson")
    assert out["summary"] == {"new": 2, "updated": 1, "unchanged": 0, "deleted": 0,
                              "invalid": 1, "skipped": 1}, out["summary"]
    rows = {r["rowIndex"]: r for r in out["rows"]}
    assert rows[0]["op"] == "update" and rows[0]["matchedEntityId"] == "urn:A"
    assert rows[1]["op"] == "create" and rows[1]["matchedEntityId"] == pointer_id(ds, "urn:li:new"), \
        "the id an import would give it"
    assert rows[2]["op"] == "invalid" and "not a valid entity type" in rows[2]["reasons"][0]
    assert rows[2]["code"] == "invalid_type" and rows[1]["code"] is None
    assert rows[3]["op"] == "create" and rows[3]["kind"] == "edge", "an edge to a node made above it"
    assert out["unknownColumns"] == ["prop_owner"] and out["checkedAgainst"] == "main"
    assert out["identifier"] == "entity_id" and out["hints"] == [], out["hints"]
    assert await _counts(gid) == before, "no job, no draft, no commit"

    # By urn alone, a row a qualifiedName names is refused: the same file, read as that import would.
    by_name = _ndjson({"kind": "node", "qualifiedName": "db.a", "entityType": "Table"},
                      {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A"})
    strict = await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds,
                                      branch_id=None, data=by_name, import_format="ndjson",
                                      identifier="urn")
    assert strict["identifier"] == "urn" and [(r["rowIndex"], r["code"]) for r in strict["rows"]] == [
        (0, "no_key")], strict["rows"]

    # Against a draft that already renamed A, the same row changes nothing.
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="rename", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "urn:A",
         "payload": {"displayName": "A renamed"}}])
    on_draft = await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds,
                                        branch_id=draft, data=data, import_format="ndjson")
    assert on_draft["summary"]["unchanged"] == 1 and on_draft["checkedAgainst"] == draft

    # A delete of what isn't there is done already: unchanged, not listed, and counted in a hint.
    gone = await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds, branch_id=None,
                                    data=_ndjson({"kind": "node", "urn": "urn:li:gone",
                                                  "entityType": "Table", "_op": "delete"}),
                                    import_format="ndjson")
    assert (gone["summary"]["unchanged"], gone["summary"]["invalid"], gone["rows"]) == (1, 0, [])
    assert gone["hints"] == [gone["hints"][0]] and gone["hints"][0].startswith(
        "1 delete row finds nothing to delete"), gone["hints"]

    # One window at most, and a file it can't read says so.
    window, config.IMPORT_COMMIT_WINDOW = config.IMPORT_COMMIT_WINDOW, 2
    try:
        with pytest.raises(DryRunTooLarge):
            await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds,
                                     branch_id=None, data=data, import_format="ndjson")
    finally:
        config.IMPORT_COMMIT_WINDOW = window
    with pytest.raises(ValueError):
        await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds,
                                 branch_id=None, data=b'{"kind": "node", "urn": \n',
                                 import_format="ndjson")


def test_a_dry_run_reads_a_file_as_an_import_would_and_writes_nothing():
    async def run():
        await models.create_schema_and_partitions()
        try:
            await _run(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())
