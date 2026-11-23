"""An import into the Playground needs an identifier on every thing it names.

A Playground graph identifies its things by ``id`` (its data source's identifier property, kept
equal to the urn). A file whose rows give a thing neither its urn nor its ``id`` leaves it with no
identifier of its own for the next file to find it by — so there, and only there, such a row is
refused: "Needs an identifier (urn or id)" (``resolve.resolve_rows(require_identifier=True)``,
pinned row by row in ``test_import_resolve``). Where an import is made it is told so
(``import_settings.identityRequired``), its job keeps it — a resumed run too — and the dry run
(``/imports/validate``) says so of the same rows.
"""
from __future__ import annotations

import json

import pytest

from backend.app.api.v1.endpoints import versioning as V
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.node_identity import ResolvedNodeIdentity
from backend.app.services.versioning.import_export import service as service_mod
from backend.app.services.versioning.import_export.import_worker import ImportWorker, TooManyRows
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Lease


@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        ProviderORM(id="prov_1", name="Graphs", provider_type="falkordb"),
        WorkspaceORM(id="ws_play", name="Playground", kind="playground",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_1"})),
        WorkspaceORM(id="ws_team", name="Team"),
    ])
    await db_session.flush()
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_play", workspace_id="ws_play", provider_id="prov_1", graph_name="a"),
        WorkspaceDataSourceORM(id="ds_team", workspace_id="ws_team", provider_id="prov_1", graph_name="b"),
    ])
    await db_session.commit()


@pytest.mark.asyncio
async def test_only_an_import_into_the_playground_is_told_to_require_one(db_session, estate):
    assert (await V._import_settings_for(db_session, "ds_play", None))[1]["identityRequired"] is True
    for ds in ("ds_team", None):
        assert "identityRequired" not in (await V._import_settings_for(db_session, ds, None))[1]


class _Lease(Lease):
    def __init__(self):
        pass

    async def retry_transient(self, fn):
        return await fn()


@pytest.mark.parametrize("kept, required", [({"identityRequired": True}, True), ({}, False), (None, False)],
                         ids=["playground", "elsewhere", "made-before"])
async def test_a_job_runs_requiring_it_as_it_was_made(kept, required):
    worker = ImportWorker(versioning=None, store=None, facts=False)
    seen = []

    async def job(_job_id):
        return {"graph_id": "g1", "branch_id": "br1", "source_uri": "k", "import_format": "ndjson",
                "reconcile_mode": "upsert", "import_settings": kept}

    async def owner(*_args):
        return "usr_1"

    async def stage(*_args):
        seen.append(worker._identity_required)
        raise TooManyRows(1)
    for name, fake in (("_job", job), ("_branch_owner", owner), ("_stage", stage)):
        setattr(worker, name, fake)
    with pytest.raises(TooManyRows):
        await worker.run("vjob_1", lease=_Lease())
    assert seen == [required]


class _Graphs:
    async def main_branch_id(self, _graph_id):
        return "br_main"

    async def identity_scope(self, _graph_id):
        return "ds_play"


_FILE = b"\n".join(json.dumps(r).encode() for r in [
    {"kind": "node", "entityType": "Table", "qualifiedName": "db.orders", "displayName": "Orders"},
    {"kind": "node", "entityType": "Table", "urn": "urn:x", "displayName": "X"},
    {"kind": "node", "entityType": "Table", "prop.id": "daily", "displayName": "Daily"},
]) + b"\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("required", [True, False])
async def test_the_dry_run_says_which_rows_need_one(monkeypatch, required):
    async def _snapshot(**_kwargs):
        return object()

    async def _lookups(_self, _snap, _rows):
        return {"urn_to_eid": {}, "qname_to_eid": {}, "node_eids": set(), "current": {}}

    async def _identity(_ws, _ds):
        return ResolvedNodeIdentity(identity_property="id", identity_source="data_source")
    monkeypatch.setattr(service_mod, "open_snapshot", _snapshot)
    monkeypatch.setattr(ImportWorker, "_node_lookups", _lookups)
    ie = ImportExportService(versioning=_Graphs(), store=object(), identity_resolver=_identity)
    checked = await ie.validate_import(graph_id="g1", workspace_id="ws_play", data_source_id="ds_play",
                                       branch_id=None, data=_FILE, import_format="ndjson",
                                       identity_required=required)
    if required:
        assert (checked["summary"]["new"], checked["summary"]["invalid"]) == (2, 1)
        [refused] = [r for r in checked["rows"] if r["op"] == "invalid"]
        assert (refused["rowIndex"], refused["code"], refused["reasons"]) == (
            0, "no_key", ["Needs an identifier (urn or id)"])
    else:
        assert (checked["summary"]["new"], checked["summary"]["invalid"]) == (3, 0)
