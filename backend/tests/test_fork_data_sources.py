"""A fork's data source, without a database server: the schema and what a fork's row takes from
its parent.

A fork of a versioned graph is a row in ``workspace_data_sources`` of its own, keyed by the fork
graph's ``dsfork_…`` id. It names the data source it was forked from, never a FalkorDB graph
(``ck_ds_fork_no_key``), and takes its parent's governing settings. The fork route, the reads and
the lifecycle run against Postgres in ``tests/integration/test_fork_data_sources.py``.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services import fork_sources

_REVISION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261030_1200_ds_fork_of.py"


def _migration():
    spec = importlib.util.spec_from_file_location(_REVISION.stem, _REVISION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_fork_column_is_declared_and_migrated():
    table = WorkspaceDataSourceORM.__table__
    column = table.c.fork_of_data_source_id
    (fk,) = column.foreign_keys
    assert column.nullable and fk.target_fullname == "workspace_data_sources.id"
    assert fk.ondelete == "RESTRICT"
    assert any(i.name == "idx_ds_fork_of" and [c.name for c in i.columns] == ["fork_of_data_source_id"]
               for i in table.indexes)
    check = next(c for c in table.constraints if getattr(c, "name", "") == "ck_ds_fork_no_key")
    assert str(check.sqltext) == "fork_of_data_source_id IS NULL OR graph_name IS NULL"
    migration = _migration()
    assert migration.revision == _REVISION.stem and len(migration.revision) <= 32
    assert migration.down_revision == "20261030_1100_gv_fork_bases"


def test_a_fork_row_takes_its_parents_governing_settings():
    parent = SimpleNamespace(
        id="ds_parent", workspace_id="ws_1", provider_id="prov_1", label=None, graph_name="sales",
        ontology_id="ont_1", is_restricted=True, access_level="admin", identity_property="id",
        name_property="title", draft_default_visibility="private", draft_levels="any",
        review_self_approval=False, review_self_merge=True)
    row = fork_sources.fork_row(parent, ds_id="dsfork_abc", name="Plan", parent_graph_id="g_1",
                                actor="u_1")
    assert (row.id, row.workspace_id, row.provider_id) == ("dsfork_abc", "ws_1", "prov_1")
    assert row.label == "sales · Plan" and row.graph_name is None and not row.is_primary
    assert row.fork_of_data_source_id == "ds_parent" and row.source_mode == "managed"
    assert json.loads(row.extra_config)["origin"] == {
        "kind": "fork", "parentDataSourceId": "ds_parent", "parentGraphId": "g_1"}
    assert {c: getattr(row, c) for c in fork_sources.GOVERNING} == {
        c: getattr(parent, c) for c in fork_sources.GOVERNING}
