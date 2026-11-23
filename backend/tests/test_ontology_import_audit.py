"""Importing a semantic layer file that changes something is recorded as ``imported``.

The audit log's ``ck_oal_action_enum`` didn't allow ``imported``, so every such import failed on
the check (``20261129_1100_oal_imported`` swaps it; the ORM carries the new list for databases
built from it).
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.db.models import OntologyAuditLogORM
from backend.app.db.repositories import ontology_definition_repo as repo
from backend.common.models.management import OntologyCreateRequest, OntologyImportRequest


@pytest.mark.asyncio
async def test_an_import_that_changes_a_layer_is_recorded_as_imported(db_session):
    made = await repo.create_ontology(db_session, OntologyCreateRequest(name="Lineage"), actor="usr_ada")
    req = OntologyImportRequest(name="Lineage", description="Now with tables",
                                entityTypeDefinitions={"table": {"name": "Table"}})

    out = await repo.import_ontology(db_session, req, made.id, actor="usr_ada")

    assert out.status != "no_changes", out
    actions = (await db_session.execute(
        select(OntologyAuditLogORM.action).where(OntologyAuditLogORM.ontology_id == out.ontology.id)
    )).scalars().all()
    assert "imported" in actions
