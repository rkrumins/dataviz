"""Every Alembic revision id must fit the 32-char ``version_num`` column.

The default ``alembic_version.version_num`` is ``VARCHAR(32)``; any
revision id longer than 32 chars fails the post-migration UPDATE with
``StringDataRightTruncation`` and leaves the DB in an inconsistent
state (constraints / tables already applied, but ``alembic_version``
not advanced — and because Alembic uses transactional DDL the entire
upgrade chain rolls back, including every earlier migration that
*did* fit). The Phase 4 surface hit exactly that on a fresh laptop:
``20260527_1200_user_provenance_and_config`` (40 chars) blew the
upgrade. The two over-length ids in this branch were renamed to
``20260527_1200_sso_phase4`` / ``20260530_1200_display_rules`` and
this test guards the contract.

Implementation note: we parse the revision id out of the file via
``ast`` rather than importing the migration as a module, so a test
environment without ``alembic`` installed still exercises the length
check (the previous import-based version silently failed at
``from alembic import op`` and never reached the assertion).
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest


_MAX_REVISION_LENGTH = 32


def _versions_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "alembic" / "versions"


def _read_revision_id(path: Path) -> str:
    """Parse the module and find the top-level ``revision`` assignment.

    Returns the string literal verbatim. Raises ``AssertionError`` if
    the file doesn't declare one (which itself is a bug worth
    catching)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = (
            [node.target] if isinstance(node, ast.AnnAssign) else node.targets
        )
        for target in targets:
            if isinstance(target, ast.Name) and target.id == "revision":
                if isinstance(node.value, ast.Constant) and isinstance(
                    node.value.value, str
                ):
                    return node.value.value
    raise AssertionError(f"no top-level ``revision`` string in {path.name}")


@pytest.mark.parametrize(
    "migration_file",
    sorted(p.name for p in _versions_dir().glob("*.py") if not p.name.startswith("__")),
)
def test_every_alembic_revision_id_fits_32_char_column(migration_file: str):
    revision_id = _read_revision_id(_versions_dir() / migration_file)
    assert len(revision_id) <= _MAX_REVISION_LENGTH, (
        f"revision id {revision_id!r} ({len(revision_id)} chars) exceeds the "
        f"alembic_version VARCHAR({_MAX_REVISION_LENGTH}) limit. Rename "
        "the revision (and any ``down_revision`` references) before "
        "shipping — the migration runs but fails to mark itself applied, "
        "leaving the DB in an inconsistent rolled-back state."
    )
