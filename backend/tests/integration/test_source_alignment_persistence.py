"""Live persistence for per-source vocabulary alignment (Task E, Day-N criteria b & c):
the mapping row exists with the case variant recorded, ``has_drift`` is set with details,
explicit decisions win over auto-derivation, and the schema-hash guard is idempotent.

Runs against the dev management DB (``ontology_source_mappings``). Auto-skips if the
session factory can't connect.
"""
from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import delete
from sqlalchemy.exc import OperationalError, SQLAlchemyError

# One event loop for the module: the process-global DB engine pool binds to the loop that
# first opens a connection, so per-test loops would orphan it ("Event loop is closed").
pytestmark = pytest.mark.asyncio(loop_scope="module")


@asynccontextmanager
async def _session():
    from backend.app.db.engine import get_session_factory
    try:
        factory = get_session_factory()
        async with factory() as session:
            yield session
    except (OperationalError, SQLAlchemyError, OSError) as exc:  # pragma: no cover
        pytest.skip(f"management DB unavailable: {exc}")


async def _cleanup(session, ds_id):
    from backend.app.db.models import OntologySourceMappingORM
    await session.execute(
        delete(OntologySourceMappingORM).where(
            OntologySourceMappingORM.data_source_id == ds_id))
    await session.commit()


async def test_dayN_persists_drift_and_case_variant_and_is_idempotent():
    from backend.app.db.repositories import ontology_source_mapping_repo as repo
    from backend.app.ontology.source_alignment import derive_alignment

    ds_id = f"ds_taskE_{uuid.uuid4().hex[:8]}"
    async with _session() as session:
        try:
            align = derive_alignment(
                declared_relationship_types=["has", "to"], declared_entity_types=["Dataset"],
                observed_relationship_types=["HAS", "TO"], observed_entity_types=["Dataset"])
            row = await repo.persist_alignment(
                session, data_source_id=ds_id, ontology_id=None, alignment=align)
            await session.commit()

            # (c) has_drift true with details for the mismatched types.
            assert row.has_drift is True
            details = {d["declared"]: d for d in json.loads(row.drift_details)}
            assert details["has"]["observed"] == ["HAS"]
            assert details["has"]["kind"] == "case_variant"
            # (b) the case variant is recorded in the relationship mapping.
            rel = json.loads(row.relationship_type_mappings)
            assert rel["has"]["observed"] == ["HAS"]

            # Idempotent: re-persist with an unchanged observed schema → no new write.
            prior_hash = row.last_seen_schema_hash
            row2 = await repo.persist_alignment(
                session, data_source_id=ds_id, ontology_id=None, alignment=align)
            await session.commit()
            assert row2.last_seen_schema_hash == prior_hash

            # No explicit overrides yet (everything is auto).
            ex_rel, ex_ent = await repo.load_explicit_mappings(session, ds_id, None)
            assert ex_rel == {} and ex_ent == {}
        finally:
            await _cleanup(session, ds_id)


async def test_multi_variant_confirm_flips_to_explicit():
    from backend.app.db.repositories import ontology_source_mapping_repo as repo
    from backend.app.ontology.source_alignment import derive_alignment

    ds_id = f"ds_taskE_{uuid.uuid4().hex[:8]}"
    async with _session() as session:
        try:
            align = derive_alignment(
                declared_relationship_types=["has"], declared_entity_types=[],
                observed_relationship_types=["has", "HAS", "Has"], observed_entity_types=[])
            await repo.persist_alignment(
                session, data_source_id=ds_id, ontology_id=None, alignment=align)
            await session.commit()

            # Keep the proposed merge → entry becomes explicit and is fed back on next derive.
            row = await repo.set_variant_decision(
                session, data_source_id=ds_id, ontology_id=None, declared="has",
                keep_merged=True, dimension="relationship")
            await session.commit()
            rel = json.loads(row.relationship_type_mappings)
            assert rel["has"]["auto"] is False
            assert rel["has"]["needsConfirmation"] is False

            ex_rel, _ = await repo.load_explicit_mappings(session, ds_id, None)
            assert "has" in ex_rel  # now wins over auto on re-derivation
        finally:
            await _cleanup(session, ds_id)
