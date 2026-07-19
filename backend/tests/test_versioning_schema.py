"""Schema-shape tests for the ``graphver`` store — no live DB required.

These compile every model to the PostgreSQL dialect and assert the partitioning
invariants that Postgres enforces at runtime (partition key present in every
partitioned PK), so a bad model definition fails in CI rather than at migration.
"""
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import configure_mappers
from sqlalchemy.schema import CreateIndex, CreateTable

from backend.app.services.versioning import config, db, models

_PG = postgresql.dialect()
_EXPECTED_TABLES = {
    "graphs", "branches", "branch_members", "merge_requests", "projection_state",
    "jobs", "import_rows", "commits", "node_versions", "edge_versions", "entity_heads",
    "merkle_nodes", "working_changes",
}


def test_all_models_compile_for_postgres():
    configure_mappers()
    md = db.VersioningBase.metadata
    assert {t.split(".")[-1] for t in md.tables} == _EXPECTED_TABLES
    for table in md.sorted_tables:
        assert "CREATE TABLE" in str(CreateTable(table).compile(dialect=_PG))
        for index in table.indexes:
            str(CreateIndex(index).compile(dialect=_PG))  # raises on bad index


def test_partitioned_tables_are_hash_partitioned_on_graph_id():
    md = db.VersioningBase.metadata
    for tname in models.PARTITIONED_TABLES:
        table = md.tables[f"{models._SCHEMA}.{tname}"]
        ddl = str(CreateTable(table).compile(dialect=_PG))
        # Postgres requires the partition key in every PK/UNIQUE of a
        # partitioned table — assert we satisfy that.
        assert "PARTITION BY HASH (graph_id)" in ddl, tname
        assert "graph_id" in [c.name for c in table.primary_key.columns], tname


def test_everything_lives_in_the_configured_schema():
    schema = config.graphver_schema()
    for table in db.VersioningBase.metadata.tables.values():
        assert table.schema == schema


def test_version_tables_have_no_is_head_column():
    # Append-only discipline: heads live in entity_heads, not an is_head flag.
    for tname in ("node_versions", "edge_versions"):
        cols = db.VersioningBase.metadata.tables[f"{models._SCHEMA}.{tname}"].columns
        assert "is_head" not in cols
