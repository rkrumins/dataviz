"""``20261116_1200_graph_watch``, without a database server: the revision follows the settings import
and fits ``alembic_version``; its tables are the ORM's; its DDL is guarded, so it runs on a database
``create_all`` already built and runs again; "watch the whole graph" is one row per person and graph
although NULLs are distinct to a unique constraint; and the downgrade takes it all away.

On Postgres, every route a database comes into existence by (``backend.scripts.upgrade``: a fresh
install, the chain replayed, an existing database moved forward) is
``integration/test_graph_digest_live.py``.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.app.db.models import GraphSeenORM, GraphWatchORM

_REVISION = (Path(__file__).resolve().parents[1] / "alembic" / "versions"
             / "20261116_1200_graph_watch.py")


def _module():
    spec = importlib.util.spec_from_file_location(_REVISION.stem, _REVISION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(conn, step: str) -> None:
    """Run the revision's ``upgrade`` or ``downgrade`` on ``conn``, as alembic would."""
    module = _module()
    with Operations.context(MigrationContext.configure(conn)):
        getattr(module, step)()


@pytest.fixture
def conn():
    engine = sa.create_engine("sqlite://")
    with engine.connect() as c:
        yield c
    engine.dispose()


def _shape(conn) -> dict:
    inspector = sa.inspect(conn)
    return {t: ({c["name"]: (str(c["type"]), c["nullable"]) for c in inspector.get_columns(t)},
                sorted(i["name"] for i in inspector.get_indexes(t)),
                sorted(u["name"] for u in inspector.get_unique_constraints(t)),
                inspector.get_pk_constraint(t)["constrained_columns"])
            for t in ("graph_seen", "graph_watches")}


def test_the_revision_follows_the_settings_import_and_fits_alembic_version():
    module = _module()
    assert module.revision == _REVISION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261116_1100_settings_import"


def test_its_tables_are_the_orms_and_it_runs_again_on_what_create_all_built(conn):
    _run(conn, "upgrade")
    migrated = _shape(conn)
    _run(conn, "upgrade")                                     # guarded: a second run changes nothing
    assert _shape(conn) == migrated
    assert migrated["graph_seen"][3] == ["user_id", "data_source_id"]
    assert set(migrated["graph_watches"][1]) == {"ix_graph_watches_ds", "uq_graph_watches_graph"}
    assert migrated["graph_watches"][2] == ["uq_graph_watches"]

    baseline = sa.create_engine("sqlite://")
    with baseline.connect() as built:
        GraphSeenORM.__table__.create(built)
        GraphWatchORM.__table__.create(built)
        orm = _shape(built)
        _run(built, "upgrade")                                # the baseline already holds it all
        assert _shape(built) == orm
    baseline.dispose()
    later = {"graph_watches": {"entity_kind"}}                # ``20261203_1000_watch_edges``'s
    for table in ("graph_seen", "graph_watches"):
        assert set(orm[table][0]) - later.get(table, set()) == set(migrated[table][0]), table
        assert orm[table][1:] == migrated[table][1:], table


def test_watching_the_whole_graph_is_one_row_per_person_and_graph(conn):
    _run(conn, "upgrade")
    insert = sa.text("INSERT INTO graph_watches (id, user_id, data_source_id, entity_urn, created_at) "
                     "VALUES (:id, :u, :ds, :urn, CURRENT_TIMESTAMP)")
    conn.execute(insert, {"id": "gw_1", "u": "usr_a", "ds": "ds_1", "urn": None})
    with pytest.raises(sa.exc.IntegrityError):
        conn.execute(insert, {"id": "gw_2", "u": "usr_a", "ds": "ds_1", "urn": None})
    conn.rollback()
    conn.execute(insert, {"id": "gw_1", "u": "usr_a", "ds": "ds_1", "urn": None})
    conn.execute(insert, {"id": "gw_3", "u": "usr_a", "ds": "ds_1", "urn": "urn:t:orders"})
    conn.execute(insert, {"id": "gw_4", "u": "usr_b", "ds": "ds_1", "urn": None})        # another
    conn.execute(insert, {"id": "gw_5", "u": "usr_a", "ds": "ds_2", "urn": None})        # elsewhere
    with pytest.raises(sa.exc.IntegrityError):
        conn.execute(insert, {"id": "gw_6", "u": "usr_a", "ds": "ds_1", "urn": "urn:t:orders"})


def test_the_downgrade_takes_it_all_away(conn):
    _run(conn, "upgrade")
    _run(conn, "downgrade")
    inspector = sa.inspect(conn)
    assert not inspector.has_table("graph_seen") and not inspector.has_table("graph_watches")
    _run(conn, "downgrade")                                   # and again: nothing left to drop
