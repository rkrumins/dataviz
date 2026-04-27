from importlib import util
from pathlib import Path

import pytest


def _load_revision(path: Path):
    spec = util.spec_from_file_location(path.stem, path)
    module = util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _versions_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "alembic" / "versions"


@pytest.mark.parametrize(
    "migration_file",
    sorted(p.name for p in _versions_dir().glob("*.py") if not p.name.startswith("__")),
)
def test_every_alembic_revision_id_fits_32_char_column(migration_file: str):
    """The ``alembic_version`` table is a VARCHAR(32) in Postgres; any
    revision id longer than that fails the post-migration UPDATE with
    ``StringDataRightTruncation``, leaving the DB in an inconsistent
    state (constraints changed but head not recorded). Lock every
    revision at CI so the length check runs once per migration."""
    module = _load_revision(_versions_dir() / migration_file)
    assert len(module.revision) <= 32, (
        f"revision id '{module.revision}' ({len(module.revision)} chars) "
        "exceeds alembic_version VARCHAR(32) limit"
    )
