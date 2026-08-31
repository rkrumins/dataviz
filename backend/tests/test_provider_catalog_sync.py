"""Provider catalog sync -- the catalog, ``ProviderType``, the DB CHECK
constraint, and the newest migration touching it must never drift apart.

``ProviderType`` (pydantic/OpenAPI needs static members) and the DB CHECK
constraint (SQL, not Python) both stay hand-written rather than generated
from the catalog -- these tests are the drift guard that replaces
generation, per plan §3.6. Two tiers, not one equality:

* API-exposed types: ``ProviderType`` members == catalog ``registered_type_ids()``.
* DB-accepted types: the CHECK constraint == the migration's ``_NEW_TYPES``
  == ``registered_type_ids() | LEGACY_DB_ONLY_TYPES`` (``{"mock"}`` today --
  accepted by the DB, never registrable in the catalog; see D7).
"""
import ast
import re
from pathlib import Path

import backend.app.providers.falkordb  # noqa: F401  (registers "falkordb" -- see catalog/__init__.py docstring)
import backend.common.providers.catalog  # noqa: F401  (registers neo4j/datahub/spanner)
from backend.app.db.models import ProviderORM
from backend.common.models.management import ProviderType
from backend.common.providers.catalog import LEGACY_DB_ONLY_TYPES, registered_type_ids

_VERSIONS_DIR = Path(__file__).resolve().parent.parent / "alembic" / "versions"
_CONSTRAINT_NAME = "ck_providers_provider_type"


def _db_check_types() -> set:
    constraint = next(
        c for c in ProviderORM.__table__.constraints
        if getattr(c, "name", None) == _CONSTRAINT_NAME
    )
    return set(re.findall(r"'([^']+)'", str(constraint.sqltext)))


def _newest_provider_type_migration() -> Path:
    hits = [p for p in _VERSIONS_DIR.glob("*.py") if _CONSTRAINT_NAME in p.read_text()]
    assert len(hits) == 1, (
        f"expected exactly one migration touching {_CONSTRAINT_NAME}, found {hits!r} -- "
        "if a new one was added (e.g. PR 3's arcadedb), point this test at the newest "
        "instead of asserting there is only one."
    )
    return hits[0]


def _migration_new_types(path: Path) -> set:
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "_NEW_TYPES" for t in node.targets
        ):
            return {elt.value for elt in node.value.elts}
    raise AssertionError(f"{path.name} has no module-level _NEW_TYPES assignment")


def test_provider_type_enum_matches_catalog():
    """Every API-exposed provider type is registered, and vice versa."""
    enum_types = {member.value for member in ProviderType}
    assert enum_types == set(registered_type_ids()), (
        "ProviderType and the catalog disagree. If the missing side is the "
        "catalog and your provider class lives under backend/app/, the fix is "
        "NOT another import in this file next to line 19's falkordb one -- "
        "that turns this test green while production still raises "
        "ValueError: Unknown provider_type on the first real dispatch. The "
        "eager import belongs in both dispatchers, backend/app/providers/"
        "manager.py and backend/app/registry/provider_registry.py, the way "
        "falkordb's is (DEVELOPER_GUIDE.md, 'Adding a graph data provider', "
        "step 3)."
    )


def test_db_check_constraint_matches_catalog_plus_legacy():
    expected = set(registered_type_ids()) | set(LEGACY_DB_ONLY_TYPES)
    assert _db_check_types() == expected


def test_newest_migration_new_types_matches_catalog_plus_legacy():
    expected = set(registered_type_ids()) | set(LEGACY_DB_ONLY_TYPES)
    migration = _newest_provider_type_migration()
    assert _migration_new_types(migration) == expected, migration.name


def test_db_check_constraint_matches_newest_migration():
    """The two hand-written sources of truth for the DB-accepted set agree
    with each other, independent of the catalog."""
    migration = _newest_provider_type_migration()
    assert _db_check_types() == _migration_new_types(migration)
