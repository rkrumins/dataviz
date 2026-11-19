"""Every revision ``alembic/env.py`` translates a stamp from leads into this chain.

No database: the renamed-revision map is read from ``alembic/env.py`` (it runs only inside alembic)
and checked against the on-disk chain. A database another build stamped with a revision this chain
never had is placed by the upgrade Job from ``alembic/other_lines.json`` instead
(``test_alembic_lineage.py``, ``test_upgrade_foreign_stamps.py``), and a migration kept waiting for
a lock is run again by the Job (``test_upgrade_foreign_stamps.py``)."""
from __future__ import annotations

import ast
import os

import pytest
from alembic.script import ScriptDirectory

from backend.app.db.engine import _alembic_config

_ENV = os.path.join(os.path.dirname(__file__), "..", "alembic", "env.py")


def _renamed_revisions() -> dict:
    with open(_ENV) as env:
        tree = ast.parse(env.read())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                getattr(t, "id", None) == "_RENAMED_REVISIONS" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("alembic/env.py has no _RENAMED_REVISIONS")


@pytest.fixture(scope="module")
def chain() -> ScriptDirectory:
    return ScriptDirectory.from_config(_alembic_config())


def test_every_renamed_revision_leads_into_the_chain(chain):
    """A stamped old id is translated to a revision the chain holds, and the old id itself is gone:
    otherwise the translation would be skipped, or would leave the database unresolvable."""
    known = {r.revision for r in chain.walk_revisions()}
    for old, new in _renamed_revisions().items():
        assert old not in known, f"{old} is still in the chain: it needs no translation"
        assert new in known, f"{old} translates to {new}, which the chain does not hold"
