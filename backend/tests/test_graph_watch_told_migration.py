"""``20261123_0100_graph_watch_told``, without a database server: the revision follows #670's merge
revision and fits ``alembic_version``; its table is the ORM's; its DDL is guarded, so it runs on a
database ``create_all`` already built and runs again; each graph watched already gets a marker not
read yet (so the worker starts it at the head, telling nobody of what came before), and one there
already is left as it is; the downgrade takes it away.

On Postgres, every route a database comes into existence by is ``integration/test_graph_digest_live.py``.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.app.db.models import GraphWatchToldORM

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_REVISION = _VERSIONS / "20261123_0100_graph_watch_told.py"


def _module(path: Path = _REVISION):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(conn, step: str, path: Path = _REVISION) -> None:
    """Run a revision's ``upgrade`` or ``downgrade`` on ``conn``, as alembic would."""
    module = _module(path)
    with Operations.context(MigrationContext.configure(conn)):
        getattr(module, step)()


@pytest.fixture
def conn():
    """A database at the revision before: the watch tables, as ``20261116_1200_graph_watch`` makes
    them."""
    engine = sa.create_engine("sqlite://")
    with engine.connect() as c:
        _run(c, "upgrade", _VERSIONS / "20261116_1200_graph_watch.py")
        yield c
    engine.dispose()


def _shape(conn) -> tuple:
    inspector = sa.inspect(conn)
    return ({c["name"]: (str(c["type"]), c["nullable"]) for c in inspector.get_columns("graph_watch_told")},
            sorted(i["name"] for i in inspector.get_indexes("graph_watch_told")),
            inspector.get_pk_constraint("graph_watch_told")["constrained_columns"])


def _marks(conn) -> dict:
    return {ds: (told, to, through) for ds, told, to, through in conn.execute(sa.text(
        "SELECT data_source_id, told_seq, round_to, round_through FROM graph_watch_told"))}


def test_the_revision_follows_the_merge_revision_and_fits_alembic_version():
    module = _module()
    assert module.revision == _REVISION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261122_1400_merge_watch_rules"


def test_its_table_is_the_orms_and_it_runs_again_on_what_create_all_built(conn):
    _run(conn, "upgrade")
    migrated = _shape(conn)
    _run(conn, "upgrade")                                     # guarded: a second run changes nothing
    assert _shape(conn) == migrated
    assert migrated[2] == ["data_source_id"]
    assert {name: nullable for name, (_type, nullable) in migrated[0].items()} == {
        "data_source_id": False, "told_seq": True, "round_to": True, "round_through": True,
        "updated_at": False}

    baseline = sa.create_engine("sqlite://")
    with baseline.connect() as built:
        _run(built, "upgrade", _VERSIONS / "20261116_1200_graph_watch.py")
        GraphWatchToldORM.__table__.create(built)
        orm = _shape(built)
        _run(built, "upgrade")                                # the baseline already holds it all
        assert _shape(built) == orm
    baseline.dispose()
    assert set(orm[0]) == set(migrated[0]) and orm[1:] == migrated[1:]


def test_each_graph_watched_already_gets_a_marker_not_read_yet(conn):
    insert = sa.text("INSERT INTO graph_watches (id, user_id, data_source_id, entity_urn, created_at) "
                     "VALUES (:id, :u, :ds, :urn, CURRENT_TIMESTAMP)")
    for i, (user_id, ds, urn) in enumerate([("usr_a", "ds_1", None), ("usr_b", "ds_1", "urn:t:x"),
                                            ("usr_a", "ds_2", "urn:t:y")]):
        conn.execute(insert, {"id": f"gw_{i}", "u": user_id, "ds": ds, "urn": urn})
    _run(conn, "upgrade")
    assert _marks(conn) == {"ds_1": (None, None, None), "ds_2": (None, None, None)}
    conn.execute(sa.text("UPDATE graph_watch_told SET told_seq = 40, round_to = 42, "
                         "round_through = 'usr_a' WHERE data_source_id = 'ds_1'"))
    conn.execute(insert, {"id": "gw_9", "u": "usr_c", "ds": "ds_3", "urn": None})
    _run(conn, "upgrade")                                     # run again: a marker there is kept
    assert _marks(conn) == {"ds_1": (40, 42, "usr_a"), "ds_2": (None, None, None),
                            "ds_3": (None, None, None)}


def test_the_downgrade_takes_it_away(conn):
    _run(conn, "upgrade")
    _run(conn, "downgrade")
    assert not sa.inspect(conn).has_table("graph_watch_told")
    assert sa.inspect(conn).has_table("graph_watches")        # what came before stays
    _run(conn, "downgrade")                                   # and again: nothing left to drop
