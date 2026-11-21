"""``20261122_1100_reusable_changes``: a view's bulk recipes become reusable changes, in place.

The upgrade renames ``view_bulk_recipes`` to ``view_reusable_changes``, its ``recipe`` column to
``change`` and its index to ``idx_vrc_view``, keeping every row. A database whose baseline built
the new table from the models has both tables; the new one is empty there, so it goes and the
old one is renamed. The downgrade renames them back.
"""
import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.app.db.models import ViewReusableChangeORM

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_MIGRATION = _VERSIONS / "20261122_1100_reusable_changes.py"
_BEFORE = _VERSIONS / "20261122_1000_view_bulk_recipes.py"
_ROW = {"id": "b1", "view_id": "v1", "position": 0, "name": "Own them",
        "body": '{"op": {"kind": "remove", "key": "tmp"}, "target": {"kind": "view"}}'}


def _load(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(engine, path: Path, step: str) -> None:
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            getattr(_load(path), step)()


def tables(engine) -> dict:
    """Each library table there is: its columns and its indexes."""
    inspector = sa.inspect(engine)
    return {
        name: (sorted(c["name"] for c in inspector.get_columns(name)),
               sorted(i["name"] for i in inspector.get_indexes(name)))
        for name in ("view_bulk_recipes", "view_reusable_changes") if inspector.has_table(name)
    }


def rows(engine, table: str, column: str) -> list:
    with engine.connect() as conn:
        return conn.execute(sa.text(f"SELECT id, name, {column} FROM {table}")).all()


@pytest.fixture()
def db():
    """The tables as the revision before this one leaves them, one bulk recipe kept."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE views (id TEXT PRIMARY KEY)"))
        conn.execute(sa.text("INSERT INTO views VALUES ('v1')"))
    run(engine, _BEFORE, "upgrade")
    with engine.begin() as conn:
        conn.execute(sa.text(
            "INSERT INTO view_bulk_recipes (id, view_id, position, name, recipe, created_at, updated_at) "
            "VALUES (:id, :view_id, :position, :name, :body, 't', 't')"), _ROW)
    return engine


def test_the_revision_follows_the_bulk_recipes_and_fits():
    mig = _load(_MIGRATION)
    assert mig.revision == _MIGRATION.stem and len(mig.revision) <= 32
    assert mig.down_revision == "20261122_1000_view_bulk_recipes"


def test_the_upgrade_renames_the_table_its_column_and_index_and_keeps_the_rows(db):
    run(db, _MIGRATION, "upgrade")
    [(columns, indexes)] = tables(db).values()
    assert list(tables(db)) == ["view_reusable_changes"]
    assert "change" in columns and "recipe" not in columns and indexes == ["idx_vrc_view"]
    assert rows(db, "view_reusable_changes", "change") == [("b1", "Own them", _ROW["body"])]

    run(db, _MIGRATION, "upgrade")      # again: guarded, and changes nothing
    assert rows(db, "view_reusable_changes", "change") == [("b1", "Own them", _ROW["body"])]


def test_the_models_table_is_given_way_while_empty_and_kept_once_it_holds_rows(db):
    ViewReusableChangeORM.__table__.create(db)
    assert set(tables(db)) == {"view_bulk_recipes", "view_reusable_changes"}
    run(db, _MIGRATION, "upgrade")
    assert list(tables(db)) == ["view_reusable_changes"]
    assert rows(db, "view_reusable_changes", "change") == [("b1", "Own them", _ROW["body"])]

    run(db, _MIGRATION, "downgrade")
    ViewReusableChangeORM.__table__.create(db)
    with db.begin() as conn:
        conn.execute(sa.text(
            "INSERT INTO view_reusable_changes (id, view_id, position, name, change, created_at, updated_at) "
            "VALUES ('c1', 'v1', 0, 'Newer', '{}', 't', 't')"))
    run(db, _MIGRATION, "upgrade")
    assert set(tables(db)) == {"view_bulk_recipes", "view_reusable_changes"}, "a table with rows is never dropped"


def test_the_downgrade_renames_them_back(db):
    run(db, _MIGRATION, "upgrade")
    run(db, _MIGRATION, "downgrade")
    [(columns, indexes)] = tables(db).values()
    assert list(tables(db)) == ["view_bulk_recipes"]
    assert "recipe" in columns and "change" not in columns and indexes == ["idx_vbr_view"]
    assert rows(db, "view_bulk_recipes", "recipe") == [("b1", "Own them", _ROW["body"])]
