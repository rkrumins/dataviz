"""``20261120_1000_saved_narrowings``: a view's saved narrowings get a table of their own.

The upgrade creates ``view_saved_narrowings`` and its index, guarded so a database that
already has them (a ``create_all`` baseline) is left as it is; the downgrade drops both.
The table it makes is the one the ORM declares.
"""
import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.app.db.models import ViewSavedNarrowingORM

_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261120_1000_saved_narrowings.py"


def _load():
    spec = importlib.util.spec_from_file_location("_saved_narrowings_migration", _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mig = _load()


def test_the_revision_follows_the_view_members_merge_and_fits():
    assert mig.revision == _MIGRATION.stem and len(mig.revision) <= 32
    assert mig.down_revision == "20261119_1500_merge_view_members"


@pytest.fixture()
def db():
    """The views table as the revision before this one leaves it (the columns that matter)."""
    engine = sa.create_engine("sqlite://")

    @sa.event.listens_for(engine, "connect")
    def _fks(dbapi_conn, _rec):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE views (id TEXT PRIMARY KEY, name TEXT)"))
        conn.execute(sa.text("INSERT INTO views VALUES ('v1', 'one')"))
    return engine


def run(engine, step: str) -> None:
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            getattr(mig, step)()


def test_the_upgrade_makes_the_table_the_orm_declares(db):
    run(db, "upgrade")
    with db.connect() as conn:
        inspector = sa.inspect(conn)
        columns = {c["name"]: c for c in inspector.get_columns("view_saved_narrowings")}
        indexes = {i["name"]: i["column_names"] for i in inspector.get_indexes("view_saved_narrowings")}
        fks = inspector.get_foreign_keys("view_saved_narrowings")
    orm = ViewSavedNarrowingORM.__table__
    assert set(columns) == {c.name for c in orm.columns}
    assert {n for n, c in columns.items() if c["nullable"]} == {c.name for c in orm.columns if c.nullable}
    assert indexes == {"idx_vsn_view": ["view_id", "created_at"]}
    assert [(fk["referred_table"], fk["constrained_columns"], fk["options"].get("ondelete")) for fk in fks] == [
        ("views", ["view_id"], "CASCADE")]

    with db.begin() as conn:
        # held_complete defaults to true for a row that leaves it out.
        conn.execute(sa.text(
            "INSERT INTO view_saved_narrowings (id, view_id, name, spec, held_count, created_at, updated_at) "
            "VALUES ('n_00000001', 'v1', 'Mine', '{}', 0, 't', 't')"))
        assert conn.execute(sa.text("SELECT held_complete FROM view_saved_narrowings")).scalar_one() in (1, True)
        conn.execute(sa.text("DELETE FROM views WHERE id = 'v1'"))
        assert conn.execute(sa.text("SELECT count(*) FROM view_saved_narrowings")).scalar_one() == 0

    run(db, "upgrade")      # again: guarded


def test_the_downgrade_drops_it(db):
    run(db, "upgrade")
    run(db, "downgrade")
    with db.connect() as conn:
        assert not sa.inspect(conn).has_table("view_saved_narrowings")
    run(db, "downgrade")    # again: guarded
