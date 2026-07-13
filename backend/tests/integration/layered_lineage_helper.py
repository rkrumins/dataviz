"""Test helper: provision a versioned graph from the schema-configurable
layered-lineage generator, ingested under a derived+published custom ontology.

Consolidates the hand-rolled node/edge builders per test file into one
parametrizable factory: pick a ConversionSchema preset, a seed, and structural
knobs, and get back a fully provisioned strict graph (management rows + versioned
store + FalkorDB projection) plus the handles a test needs to assert against.

Graphs are pinned under the ``gvt_`` prefix so ``integration/conftest.py`` sweeps
them (and their ProjectionStateORM rows) at session end.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

from backend.scripts.generate_layered_lineage_model import LayeredLineageModelGenerator
from backend.scripts.layered_lineage_schema import ConversionSchema, convert_model, ingest_versioned


async def seed_workspace_provider() -> dict:
    """Create the management tables (idempotent) plus a fresh workspace and an
    enabled FalkorDB provider row. Returns ``{"workspace", "provider"}`` ids."""
    from backend.app.db.engine import PoolRole, get_engine, get_session_factory
    from backend.app.db.models import (
        Base as MgmtBase, OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM,
    )

    eng = get_engine(PoolRole.WEB)
    async with eng.begin() as conn:
        await conn.run_sync(
            MgmtBase.metadata.create_all,
            tables=[WorkspaceORM.__table__, ProviderORM.__table__,
                    OntologyORM.__table__, WorkspaceDataSourceORM.__table__],
        )
    suffix = os.urandom(4).hex()
    ids = {"workspace": f"ws_ll_{suffix}", "provider": f"prov_ll_{suffix}"}
    async with get_session_factory(PoolRole.WEB)() as s:
        s.add(WorkspaceORM(id=ids["workspace"], name="Layered Lineage Test WS"))
        s.add(ProviderORM(
            id=ids["provider"], name="layered-lineage-falkor", provider_type="falkordb",
            host=os.getenv("FALKORDB_HOST", "falkordb"),
            port=int(os.getenv("FALKORDB_PORT", "6379"))))
        await s.commit()
    return ids


async def provision_ingested_graph(
    *,
    schema: ConversionSchema,
    workspace_id: str,
    provider_id: str,
    seed: int = 42,
    layers: int = 3,
    depth: int = None,
    orphans: int = 0,
    graph_name: str = None,
    project: bool = True,
    **gen_knobs,
) -> SimpleNamespace:
    """Generate a layered-lineage model, convert it under ``schema``, and ingest it through
    the versioned service into a ``gvt_``-pinned strict graph. Returns handles:
    ``model``, ``converted``, ``ontology_id``, ``data_source_id``, ``graph_id``,
    ``main_branch_id``, ``graph_name``, ``rules``, ``svc``."""
    from backend.app.services.versioning.service import GraphVersioningService

    graph_name = graph_name or ("gvt_ll_" + os.urandom(3).hex())
    model = LayeredLineageModelGenerator(
        num_layers=layers, seed=seed, depth=depth, orphans=orphans, **gen_knobs).generate()
    cg = convert_model(model, schema)

    result = await ingest_versioned(
        schema=schema, cg=cg, workspace_id=workspace_id, provider_id=provider_id,
        graph_name=graph_name, actor="layered_lineage_helper", project=project)

    return SimpleNamespace(
        model=model,
        converted=cg,
        ontology_id=result["ontology_id"],
        data_source_id=result["data_source_id"],
        graph_id=result["graph_id"],
        main_branch_id=result["main_branch_id"],
        graph_name=graph_name,
        rules=result["rules"],
        canonicalized=result["canonicalized"],
        svc=GraphVersioningService(),
    )
