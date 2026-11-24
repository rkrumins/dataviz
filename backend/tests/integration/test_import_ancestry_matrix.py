"""A file that says where each entity sits imports exactly as the same file without it — needs
Postgres.

Every export can carry five informational columns, each entity's parent and path
(``common.ancestry_columns``), and none has to. So for every format the import reads (CSV, TSV,
NDJSON, JSON, Excel), one graph is exported twice by the export job, with them and without, and
both files are:

* checked by a dry run (``validate_import``), into a graph that has none of it and back into the
  graph it came from: the same answer, with no column it doesn't know, nothing refused, nothing
  skipped;
* imported into a graph that has none of it: the same tally, the same entities, and none of the
  five a property; and each file imported over the other's import changes nothing.

An edge file that says where its edges sit (an export never does) imports as it would without, and
so does a view package's data with them and without. A lineage download (a member set) or a
search's matches, sent to the import as they are, are no import file: every row is passed by,
the same with the columns or without.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.member_sets import download
from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export import stream
from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.ancestry_columns import ANCESTRY_COLUMNS
from backend.common.models.search import SEARCH_EXPORT_BASE_COLUMNS, export_columns

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

FORMATS = ("csv", "tsv", "ndjson", "json", "xlsx")
CONTAINMENT = {"CONTAINS": False}
ONTOLOGY = {"node_types": ["Database", "Schema", "Table"], "edge_types": ["CONTAINS", "FEEDS"]}
NOTHING = {"new": 0, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}


async def _ontology(_ws, _ds):
    return ONTOLOGY


def _n(eid, etype, name, **payload):
    return {"op": "create", "entity_kind": "node", "entity_id": eid, "payload": {
        "urn": f"urn:{eid}", "entityType": etype, "displayName": name, "qualifiedName": f"q.{eid}", **payload}}


def _e(eid, src, tgt, etype, **payload):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt, **payload}}


#: A warehouse holding a schema of two tables, one feeding the other, and a table at the top of
#: the graph; properties of every shape a cell takes (text, a number, a list, a nested object).
SEED = [
    _n("db", "Database", "Warehouse"), _n("sc", "Schema", "gold"),
    _n("t1", "Table", "orders", tags=["pii"], properties={"owner": "team", "rows": 5, "cols": ["id", "at"]}),
    _n("t2", "Table", "revenue", properties={"schema": {"cols": [{"n": "id"}]}}),
    _n("top", "Table", "loose"),
    _e("c1", "db", "sc", "CONTAINS"), _e("c2", "sc", "t1", "CONTAINS"), _e("c3", "sc", "t2", "CONTAINS"),
    _e("f1", "t1", "t2", "FEEDS", confidence=0.5, properties={"via": "etl"}),
]


async def _bytes(store, key):
    return b"".join([c async for c in store.open_stream(key)])


async def _put(store, key, data):
    async def once():
        yield data
    await store.put_stream(key, once())
    return key


async def _records(fmt, data):
    async def once():
        yield data
    return [r async for r in get_adapter(fmt).parse(once())]


async def _graph(svc, name):
    ds = f"ds_{name}_" + os.urandom(4).hex()
    return ds, (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]


async def _state(svc, gid, branch):
    """A branch's entities as an import made them, by URN: what any graph they land in holds alike
    (their entity ids are the graph's own)."""
    state = await svc.materialize_state(graph_id=gid, branch_id=branch)
    urn = {eid: p.get("urn") for eid, p in state["nodes"].items()}
    nodes = {p["urn"]: p for p in state["nodes"].values()}
    edges = sorted((urn[p["sourceEntityId"]], urn[p["targetEntityId"]], p["edgeType"],
                    json.dumps({k: v for k, v in p.items() if k not in ("sourceEntityId", "targetEntityId")},
                               sort_keys=True))
                   for p in state["edges"].values())
    return nodes, edges


async def _import(ie, ds, gid, fmt, key, branch=None):
    job = await ie.create_import_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, actor="u",
                                     import_format=fmt, source_uri=key, branch_id=branch)
    summary = await ie.run_import(job["job_id"])
    assert (await ie.get_job(job["job_id"]))["status"] == "completed"
    return job["branch_id"], summary


async def _dry_run(ie, ds, gid, fmt, data):
    return await ie.validate_import(graph_id=gid, workspace_id="ws1", data_source_id=ds, branch_id=None,
                                    data=data, import_format=fmt)


def _clean(answer):
    """A dry run with nothing to warn of: no column it doesn't know, nothing refused or passed by."""
    assert answer["unknownColumns"] == [] and answer["hints"] == [], answer
    assert answer["summary"]["invalid"] == 0 and answer["summary"]["skipped"] == 0, answer["summary"]
    return answer


async def _formats(svc, ie, store, src_ds, src):
    for fmt in FORMATS:
        files = {}
        for placed in (True, False):
            job = await ie.create_export_job(workspace_id="ws1", data_source_id=src_ds, graph_id=src, actor="u",
                                             export_format=fmt, with_path=CONTAINMENT if placed else None)
            await ie.run_export(job["job_id"])
            files[placed] = job["result_uri"]
        data = {placed: await _bytes(store, key) for placed, key in files.items()}
        t1 = {placed: next(r for r in await _records(fmt, blob) if r.get("urn") == "urn:t1")
              for placed, blob in data.items()}
        assert t1[True]["parentName"] == "gold" and set(ANCESTRY_COLUMNS) <= set(t1[True]), fmt
        assert not set(ANCESTRY_COLUMNS) & set(t1[False]), fmt

        # A dry run: into a graph that has none of it, and back into the one it came from.
        fresh_ds, fresh = await _graph(svc, "dry")
        into = [_clean(await _dry_run(ie, fresh_ds, fresh, fmt, blob)) for blob in data.values()]
        assert into[0] == into[1] and into[0]["summary"]["new"] == len(SEED), (fmt, into)
        back = [_clean(await _dry_run(ie, src_ds, src, fmt, blob)) for blob in data.values()]
        assert back[0] == back[1] and back[0]["summary"]["unchanged"] == len(SEED), (fmt, back)

        # Applied: each into a graph of its own, then the other file over it.
        made = {}
        for placed in (True, False):
            ds, gid = await _graph(svc, fmt)
            branch, summary = await _import(ie, ds, gid, fmt, files[placed])
            assert summary == {**NOTHING, "new": len(SEED)}, (fmt, placed, summary)
            _, again = await _import(ie, ds, gid, fmt, files[not placed], branch)
            assert again == {**NOTHING, "unchanged": len(SEED)}, (fmt, placed, again)
            made[placed] = await _state(svc, gid, branch)
        assert made[True] == made[False], fmt
        nodes, _edges = made[True]
        assert set(nodes["urn:t1"]["properties"]) == {"owner", "rows", "cols"}, fmt
        assert not any(set(ANCESTRY_COLUMNS) & set(p) | set(ANCESTRY_COLUMNS) & set(p.get("properties") or {})
                       for p in nodes.values()), "where it sat is never imported"


async def _edge_files(svc, ie, store, src_ds, src):
    """An edge file of the source graph's flows, made with where each edge sits and without."""
    edges = [{"kind": "edge", "edgeType": "FEEDS", "sourceUrn": "urn:t2", "targetUrn": "urn:top",
              "prop.via": "manual"}]
    stray = [{**r, "parentUrn": "urn:sc", "parentName": "gold", "parentType": "Schema",
              "path": ["Warehouse", "gold"], "pathUrns": ["urn:db", "urn:sc"]} for r in edges]
    for fmt in FORMATS:
        data = {}
        for placed, records in ((True, stray), (False, edges)):
            async def pages(placed=True, records=records):
                yield [dict(r) for r in records]
            data[placed] = b"".join([c async for c in stream.write_export(pages, fmt=fmt, placed=placed)])
        assert (await _records(fmt, data[True]))[0]["parentName"] == "gold", fmt
        answers = [_clean(await _dry_run(ie, src_ds, src, fmt, blob)) for blob in data.values()]
        assert answers[0] == answers[1] and answers[0]["summary"]["new"] == 1, (fmt, answers)
        made = {}
        for placed in (True, False):
            key = await _put(store, storage_key("ws1", src, f"edges-{fmt}-{placed}", f"source.{fmt}"), data[placed])
            branch, summary = await _import(ie, src_ds, src, fmt, key)
            assert summary == {**NOTHING, "new": 1}, (fmt, placed, summary)
            made[placed] = await _state(svc, src, branch)
        assert made[True] == made[False], fmt


async def _package_data(svc, ie, store, src_ds, src, monkeypatch):
    """A view package's data, with where each entity sits and without: the same draft."""
    from backend.app.services.view_transfer import package
    from backend.tests.integration.test_view_package_roundtrip import _upload
    from backend.tests.test_view_transfer_package import BUNDLE

    async def bundle_of(_session, _options, _ws, _ds):
        return json.loads(BUNDLE), None

    monkeypatch.setattr(package, "build_bundle", bundle_of)
    made = {}
    for placed in (True, False):
        job = await ie.create_export_job(
            workspace_id="ws1", data_source_id=src_ds, graph_id=src, actor="u",
            package={"fileName": "p.view-package.zip", "scope": "source", "dataVersion": "published",
                     "views": [{"viewId": "view_1", "version": 3}], "actor": "u", "withPath": placed},
            with_path=CONTAINMENT if placed else None)
        await ie.run_export(job["job_id"])
        result = (await ie.get_job(job["job_id"]))["resultUri"]
        source = await _upload(store, ie, await _bytes(store, result))
        ds, gid = await _graph(svc, "pkg")
        draft = await svc.open_draft(graph_id=gid, owner="bob", name="Import")
        imp = await ie.create_import_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, actor="bob",
                                         import_format="ndjson", source_uri=source, branch_id=draft)
        assert await ie.run_import(imp["job_id"]) == {**NOTHING, "new": len(SEED)}, placed
        made[placed] = await _state(svc, gid, draft)
    assert made[True] == made[False]


async def _not_import_files(svc, ie):
    """A lineage download's file and a search's, as the import reads them: rows of no kind, each
    passed by, with where each entity sits or without."""
    ds, gid = await _graph(svc, "trace")
    member = {"urn": "urn:t1", "name": "orders", "type": "Table", "qualifiedName": "q.t1", "via": "seed",
              "hops": None, "hopsUp": 0, "hopsDown": None, "nearestSeed": "urn:t1", "parentUrn": "urn:sc",
              "parentName": "gold", "parentType": "Schema", "path": ["Warehouse", "gold"],
              "pathUrns": ["urn:db", "urn:sc"]}
    match = {"urn": "urn:t1", "displayName": "orders", "entityType": "Table", "qualifiedName": "q.t1", **{
        c: member[c] for c in ANCESTRY_COLUMNS}}
    for columns, row in ((download.BASE_COLUMNS, member), (download.MEMBER_COLUMNS, member),
                         (export_columns([], with_path=True), match), (SEARCH_EXPORT_BASE_COLUMNS, match)):
        text = download._header(columns) + download._csv([row], columns)
        answer = await _dry_run(ie, ds, gid, "csv", text)
        assert answer["summary"] == {**NOTHING, "skipped": 1}, (columns, answer)


async def _run(root, monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    store = LocalFsObjectStore(root)
    ie = ImportExportService(versioning=svc, store=store, ontology_resolver=_ontology)
    src_ds, src = await _graph(svc, "src")
    await svc.apply_ops(graph_id=src, actor="u", message="seed", ops=SEED)
    await _formats(svc, ie, store, src_ds, src)
    await _edge_files(svc, ie, store, src_ds, src)
    await _package_data(svc, ie, store, src_ds, src, monkeypatch)
    await _not_import_files(svc, ie)


def test_a_file_with_where_each_entity_sits_imports_as_the_same_file_without(monkeypatch):
    root = tempfile.mkdtemp(prefix="ancestry-matrix-")

    async def run():
        try:
            await _run(root, monkeypatch)
        finally:
            await db.dispose_engine()
    try:
        asyncio.run(run())
    finally:
        shutil.rmtree(root, ignore_errors=True)
