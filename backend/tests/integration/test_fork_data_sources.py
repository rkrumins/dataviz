"""A fork is a data source of its own — needs Postgres (management and graphver).

Forking a graph makes a row in ``workspace_data_sources`` keyed by the fork graph's ``dsfork_…``
id, in the parent's workspace and on its provider, naming no FalkorDB graph, with the parent's
governing settings copied. The row commits before the fork graph is made (the two are separate
databases), and is deleted again when the fork cannot be made: no row is ever left without its
graph. The schema refuses a fork row that names a graph, and won't go back below the revision while
fork rows exist.
"""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from sqlalchemy import select

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

WS = "ws_forks"
R = "workspace:datasource:read"
M = "workspace:datasource:manage"
#: The parent's governing settings, every one set away from its default.
GOVERNING = {"is_restricted": True, "access_level": "write", "identity_property": "id",
             "name_property": "title", "draft_default_visibility": "private",
             "draft_levels": "private_only", "review_self_approval": False,
             "review_self_merge": False}


def _mgmt():
    from backend.app.db.engine import PoolRole, get_session_factory
    return get_session_factory(PoolRole.WEB)()


def _client(perms=(R, M), ws=WS):
    """The versioning router over in-process ASGI, the caller holding ``perms`` in ``ws``."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    async def _user():
        return SimpleNamespace(id="u_forker", email="f@example.com")

    async def _claims():
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: perms})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _parent(svc, label="Sales", **settings):
    """A data source in ``WS`` on a FalkorDB provider, with an ontology and ``settings``, and its
    versioned graph. Returns ``(data source id, graph id)``."""
    from backend.app.db.models import (
        OntologyORM, ProviderORM, WorkspaceDataSourceORM, WorkspaceORM)

    await models.create_schema_and_partitions()
    suffix = os.urandom(4).hex()
    ds_id = f"ds_fk_{suffix}"
    async with _mgmt() as s:
        if await s.get(WorkspaceORM, WS) is None:
            s.add(WorkspaceORM(id=WS, name="Forks"))
        s.add(ProviderORM(id=f"prov_fk_{suffix}", name=f"falkor-{suffix}",
                          provider_type="falkordb", host="localhost", port=6379))
        s.add(OntologyORM(id=f"ont_fk_{suffix}", name=f"Ontology {suffix}", is_published=True))
        await s.flush()
        s.add(WorkspaceDataSourceORM(
            id=ds_id, workspace_id=WS, provider_id=f"prov_fk_{suffix}", graph_name=f"g_{suffix}",
            label=label, ontology_id=f"ont_fk_{suffix}", **settings))
        await s.commit()
    graph = await svc.create_graph(data_source_id=ds_id, workspace_id=WS, actor="alice")
    return ds_id, graph["graph_id"]


async def _row(ds_id):
    from backend.app.db.models import WorkspaceDataSourceORM
    async with _mgmt() as s:
        return await s.get(WorkspaceDataSourceORM, ds_id)


async def _fork(c, gid, body=None):
    return await c.post(f"/api/v1/{WS}/versioning/graphs/{gid}/forks", json=body)


def _run(case):
    async def go():
        try:
            await case(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(go())


# ── creating a fork ──────────────────────────────────────────────────────────────────────────
def test_a_fork_is_a_data_source_with_its_parents_settings(monkeypatch):
    from backend.app.services.activity import recorder

    recorded = []

    async def _record(session, event_type, **fields):
        recorded.append((event_type, fields))
        return True

    monkeypatch.setattr(recorder, "record_for_request", _record)

    async def case(svc):
        parent_ds, gid = await _parent(svc, **GOVERNING)
        async with _client() as c:
            r = await _fork(c, gid, {"name": "  Q3 plan  "})
            assert r.status_code == 201, r.text
            body = r.json()
            ds_id, fork_gid = body["dataSourceId"], body["graphId"]
            assert ds_id.startswith("dsfork_")
            assert (await svc.get_graph(fork_gid))["data_source_id"] == ds_id
            parent, row = await _row(parent_ds), await _row(ds_id)
            assert (row.workspace_id, row.provider_id) == (WS, parent.provider_id)
            assert row.label == "Sales · Q3 plan" and row.graph_name is None
            assert row.fork_of_data_source_id == parent_ds and row.source_mode == "managed"
            assert row.created_by == "u_forker" and not row.is_primary and row.is_active
            assert json.loads(row.extra_config) == {"origin": {
                "kind": "fork", "parentDataSourceId": parent_ds, "parentGraphId": gid}}
            assert row.ontology_id == parent.ontology_id
            for column, value in GOVERNING.items():
                assert getattr(row, column) == value, column
            assert [e for e, _f in recorded] == ["workspace.versioning.fork_created"]

            # Unnamed, it is "Fork" and the end of its id; the list names each fork's source.
            r = await _fork(c, gid)
            assert r.status_code == 201, r.text
            unnamed = r.json()["dataSourceId"]
            assert (await _row(unnamed)).label == f"Sales · Fork {unnamed[-6:]}"
            listed = (await c.get(f"/api/v1/{WS}/versioning/graphs/{gid}/forks")).json()
            assert {(f["dataSourceId"], f["label"]) for f in listed} == {
                (ds_id, "Sales · Q3 plan"), (unnamed, f"Sales · Fork {unnamed[-6:]}")}

            # A name is 1 to 80 characters once trimmed.
            for bad in ("   ", "x" * 81):
                assert (await _fork(c, gid, {"name": bad})).status_code == 422
    _run(case)


def test_a_fork_that_cannot_be_made_leaves_no_data_source(monkeypatch):
    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.services.versioning.errors import ForkLimit

    async def forks_of(parent_ds):
        async with _mgmt() as s:
            return (await s.execute(select(WorkspaceDataSourceORM.id).where(
                WorkspaceDataSourceORM.fork_of_data_source_id == parent_ds))).scalars().all()

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            # Refused before anything is written: the cap, and a trashed parent.
            monkeypatch.setattr(config, "MAX_FORKS_PER_GRAPH", 1)
            assert (await _fork(c, gid)).status_code == 201
            r = await _fork(c, gid)
            assert r.status_code == 409 and r.json()["detail"]["type"] == "fork_limit", r.text
            assert len(await forks_of(parent_ds)) == 1
            monkeypatch.setattr(config, "MAX_FORKS_PER_GRAPH", 10)

            # Refused after the row is written (fork_graph checks again under its lock): the row
            # is deleted, and the refusal answered as before.
            async def refuse(*a, **k):
                raise ForkLimit(1)

            monkeypatch.setattr(GraphVersioningService, "fork_graph", refuse)
            r = await _fork(c, gid)
            assert r.status_code == 409 and r.json()["detail"]["type"] == "fork_limit", r.text
            assert len(await forks_of(parent_ds)) == 1
    _run(case)


def test_fork_graph_takes_only_a_fork_id():
    async def case(svc):
        _parent_ds, gid = await _parent(svc)
        with pytest.raises(ValueError):
            await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob",
                                 data_source_id="ds_not_a_fork")
        made = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob",
                                    data_source_id="dsfork_chosen" + os.urandom(3).hex())
        assert made["data_source_id"].startswith("dsfork_chosen")
        minted = await svc.fork_graph(parent_graph_id=gid, workspace_id=WS, actor="bob")
        assert minted["data_source_id"].startswith("dsfork_")
    _run(case)


# ── the schema ───────────────────────────────────────────────────────────────────────────────
_REVISION = "20261030_1200_ds_fork_of"


def _migration():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "alembic" / "versions" / f"{_REVISION}.py"
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_fork_column_migrates_both_ways_and_names_no_graph():
    """The check refuses a fork row that names a graph; the downgrade refuses while fork rows
    exist, and drops the column once none do; the upgrade is safe to re-run."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    url = os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2")
    engine = sa.create_engine(url)
    migration = _migration()

    def run(conn, step):
        with Operations.context(MigrationContext.configure(conn)):
            getattr(migration, step)()

    def columns(conn):
        return {c["name"] for c in sa.inspect(conn).get_columns("workspace_data_sources")}

    async def seed():
        await _parent(GraphVersioningService())

    asyncio.run(seed())
    asyncio.run(db.dispose_engine())
    with engine.connect() as conn:
        trans = conn.begin()
        try:
            ws, prov = conn.execute(sa.text(
                "SELECT workspace_id, provider_id FROM workspace_data_sources "
                "WHERE workspace_id = :ws LIMIT 1"), {"ws": WS}).one()
            insert = sa.text(
                "INSERT INTO workspace_data_sources (id, workspace_id, provider_id, graph_name, "
                "fork_of_data_source_id, is_primary, is_active, is_restricted, write_back_enabled, "
                "aggregation_status, aggregation_edge_count, created_at, updated_at) VALUES "
                "(:id, :ws, :prov, :graph, :parent, false, true, false, false, 'none', 0, "
                "'2026-10-30', '2026-10-30')")
            parent = conn.execute(sa.text("SELECT id FROM workspace_data_sources "
                                          "WHERE workspace_id = :ws LIMIT 1"), {"ws": ws}).scalar()
            with pytest.raises(sa.exc.IntegrityError, match="ck_ds_fork_no_key"):
                with conn.begin_nested():
                    conn.execute(insert, {"id": "dsfork_named", "ws": ws, "prov": prov,
                                          "graph": "a_key", "parent": parent})
            conn.execute(insert, {"id": "dsfork_schema", "ws": ws, "prov": prov, "graph": None,
                                  "parent": parent})
            with pytest.raises(RuntimeError, match="fork data source row"):
                with conn.begin_nested():
                    run(conn, "downgrade")
            conn.execute(sa.text("DELETE FROM workspace_data_sources "
                                 "WHERE fork_of_data_source_id IS NOT NULL"))
            run(conn, "downgrade")
            assert "fork_of_data_source_id" not in columns(conn)
            run(conn, "upgrade")
            run(conn, "upgrade")                                       # idempotent
            assert "fork_of_data_source_id" in columns(conn)
            assert "idx_ds_fork_of" in {i["name"] for i in sa.inspect(conn).get_indexes(
                "workspace_data_sources")}
        finally:
            trans.rollback()
    engine.dispose()
