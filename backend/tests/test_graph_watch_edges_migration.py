"""``20261203_1000_watch_edges``, without a database server: the revision follows
``20261202_1000_bootstrap_review`` and fits ``alembic_version``; it gives ``graph_watches`` the
ORM's ``entity_kind``, every watch there already an entity's (``node``); its DDL is guarded, so it
runs on a database ``create_all`` already built and runs again; the downgrade takes the
relationship watches away with the column.

On Postgres, every route a database comes into existence by is ``integration/test_graph_digest_live.py``.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.app.db.models import GraphWatchORM

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_REVISION = _VERSIONS / "20261203_1000_watch_edges.py"
_WATCHES = _VERSIONS / "20261116_1200_graph_watch.py"


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
    """A database before it: ``graph_watches`` as ``20261116_1200_graph_watch`` makes it."""
    engine = sa.create_engine("sqlite://")
    with engine.connect() as c:
        _run(c, "upgrade", _WATCHES)
        yield c
    engine.dispose()


def _columns(conn) -> dict:
    return {c["name"]: (str(c["type"]), c["nullable"])
            for c in sa.inspect(conn).get_columns("graph_watches")}


def _insert(conn, i: int, urn, kind=None) -> None:
    """A watch of ``usr_a``'s in ``ds_1``; with no ``kind``, as a writer from before the column."""
    cols = "id, user_id, data_source_id, entity_urn, created_at"
    vals = ":id, 'usr_a', 'ds_1', :urn, CURRENT_TIMESTAMP"
    if kind is not None:
        cols, vals = cols + ", entity_kind", vals + ", :kind"
    conn.execute(sa.text(f"INSERT INTO graph_watches ({cols}) VALUES ({vals})"),
                 {"id": f"gw_{i}", "urn": urn, "kind": kind})


def _watches(conn) -> list:
    return sorted(tuple(r) for r in conn.execute(sa.text(
        "SELECT id, entity_urn, entity_kind FROM graph_watches")))


def test_the_revision_follows_the_bootstrap_review_and_fits_alembic_version():
    module = _module()
    assert module.revision == _REVISION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261202_1000_bootstrap_review"


def test_every_watch_there_already_is_an_entitys_and_it_runs_again(conn):
    _insert(conn, 1, None)
    _insert(conn, 2, "urn:t:orders")
    _run(conn, "upgrade")
    assert _columns(conn)["entity_kind"] == ("TEXT", False)
    assert _watches(conn) == [("gw_1", None, "node"), ("gw_2", "urn:t:orders", "node")]
    _insert(conn, 3, "urn:uuid:feeds", "edge")
    _insert(conn, 4, "urn:t:invoices")                        # what an older writer leaves: an entity
    _run(conn, "upgrade")                                     # guarded: a second run changes nothing
    assert _watches(conn)[2:] == [("gw_3", "urn:uuid:feeds", "edge"), ("gw_4", "urn:t:invoices", "node")]


def test_its_column_is_the_orms_and_it_runs_on_what_create_all_built(conn):
    _run(conn, "upgrade")
    baseline = sa.create_engine("sqlite://")
    with baseline.connect() as built:
        GraphWatchORM.__table__.create(built)
        orm = _columns(built)
        _run(built, "upgrade")                                # the baseline already holds it
        assert _columns(built) == orm
    baseline.dispose()
    assert set(orm) == set(_columns(conn)) and orm["entity_kind"] == _columns(conn)["entity_kind"]


def test_the_downgrade_takes_the_relationship_watches_away_with_it(conn):
    _run(conn, "upgrade")
    _insert(conn, 1, None)
    _insert(conn, 2, "urn:t:orders", "node")
    _insert(conn, 3, "urn:uuid:feeds", "edge")
    _run(conn, "downgrade")
    assert "entity_kind" not in _columns(conn)
    assert sorted(tuple(r) for r in conn.execute(sa.text(
        "SELECT id, entity_urn FROM graph_watches"))) == [("gw_1", None), ("gw_2", "urn:t:orders")]
    _run(conn, "downgrade")                                   # and again: nothing left to drop
