from importlib import util
from pathlib import Path


def _load_revision(path: Path):
    spec = util.spec_from_file_location(path.stem, path)
    module = util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_0005_revision_id_fits_alembic_version_column():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0005_remove_legacy_primary_connection.py"
    module = _load_revision(path)

    assert len(module.revision) <= 32
