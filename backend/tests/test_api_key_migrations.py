"""API keys' migrations, as a database that is serving traffic runs them.

The upgrade job applies its revisions in one transaction, so every lock is
held until the whole upgrade commits — and a failed upgrade changes nothing.
Within that:

* the ledger's ``api_key_id`` column and its index were the upgrade's last
  step, so the ledger's exclusive lock — reads included — lasts only for its
  own build. Only cheap revisions may follow it (``20261018_1200_layout_templates``
  adds three nullable columns and swaps a CHECK; ``20261018_1300_tpl_lifecycle``
  adds nullable columns, two empty tables and a v1 row per template, and swaps
  a CHECK; ``20261019_1000_ws_access`` adds columns with constant defaults,
  swaps CHECKs, builds a partial index on the small ``access_requests`` and
  seeds a permission and a role; ``20261019_1600_access_life`` adds nullable
  columns and a constant default, swaps a CHECK and creates two empty
  tables), since on a database upgrading through them the lock is also held
  while they run;
* a revision that locks a table other requests use bounds how long it waits
  for that lock (``lock_timeout``), so a long-running reader makes the
  upgrade give up, to be run again, instead of queueing every later query
  on the table behind it.
"""
from __future__ import annotations

import ast
import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_EARLIER = "20261013_1200_activity_api_key.py"
_LAST = "20261014_1200_aal_api_key.py"
#: The cheap revisions right after the ledger's, in order.
_NEXT = "20261018_1200_layout_templates"
_THEN = "20261018_1300_tpl_lifecycle"
_THIRD = "20261019_1000_ws_access"
_FOURTH = "20261019_1600_access_life"
#: Every revision that locks a table other requests use, and in which
#: direction: ``users`` for the key's foreign key, ``user_identities``, and
#: the ledger.
_ON_LIVE_TABLES = {
    "20261012_1000_api_keys.py": ("upgrade", "downgrade"),
    _EARLIER: ("downgrade",),
    "20261013_1300_api_key_scale.py": ("upgrade", "downgrade"),
    _LAST: ("upgrade", "downgrade"),
    f"{_NEXT}.py": ("upgrade", "downgrade"),
    f"{_THEN}.py": ("upgrade", "downgrade"),
    f"{_THIRD}.py": ("upgrade", "downgrade"),
    f"{_FOURTH}.py": ("upgrade", "downgrade"),
    # graphver.projection_state, which every projection pass writes.
    "20261017_1500_gv_ps_keys.py": ("upgrade", "downgrade"),
    "20261017_1550_gv_ps_fencing.py": ("upgrade", "downgrade"),
    # graphver.commits, which every save writes.
    "20261017_1900_gv_commits_idem.py": ("upgrade", "downgrade"),
    # graphver.jobs, which every job's heartbeat writes.
    "20261017_1950_gv_ingest_active.py": ("upgrade", "downgrade"),
    # graphver.projection_state again: the reseeding status.
    "20261017_2000_gv_ps_reseeding.py": ("upgrade", "downgrade"),
    # graphver.merge_requests, which every review writes.
    "20261018_1000_gv_mr_approvals.py": ("upgrade", "downgrade"),
    # graphver.projection_state again: a moved graph's retired keys.
    "20261018_1100_gv_ps_retired.py": ("upgrade", "downgrade"),
    # graphver.graphs, which every main commit writes.
    "20261018_1200_gv_lifecycle.py": ("upgrade", "downgrade"),
}


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"_m_{name[:-3]}", _VERSIONS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(conn, name: str, step: str = "upgrade") -> None:
    with Operations.context(MigrationContext.configure(conn)):
        getattr(_load(name), step)()


def _ledger(conn) -> None:
    conn.execute(sa.text(
        "CREATE TABLE auth_audit_log (id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL)"
    ))


def _shape(conn) -> tuple[set, set]:
    inspector = sa.inspect(conn)
    return (
        {c["name"] for c in inspector.get_columns("auth_audit_log")},
        {i["name"] for i in inspector.get_indexes("auth_audit_log")},
    )


def test_the_ledger_is_changed_by_the_last_revision_only():
    with sa.create_engine("sqlite://").connect() as conn:
        _ledger(conn)
        _run(conn, _EARLIER)
        assert _shape(conn) == ({"id", "occurred_at"}, set())
        _run(conn, _LAST)
        assert _shape(conn) == (
            {"id", "occurred_at", "api_key_id"}, {"idx_aal_api_key_occurred"},
        )


def test_a_database_that_built_them_earlier_finds_nothing_left_to_do():
    """Databases that ran ``20261013_1200`` while it still built the column
    and its index — development, CI, staging — keep them; the last revision
    finds them there, and they come back down one revision at a time."""
    with sa.create_engine("sqlite://").connect() as conn:
        _ledger(conn)
        conn.execute(sa.text("ALTER TABLE auth_audit_log ADD COLUMN api_key_id TEXT"))
        conn.execute(sa.text(
            "CREATE INDEX idx_aal_api_key_occurred ON auth_audit_log "
            "(api_key_id, occurred_at) WHERE api_key_id IS NOT NULL"
        ))
        _run(conn, _LAST)
        assert _shape(conn) == (
            {"id", "occurred_at", "api_key_id"}, {"idx_aal_api_key_occurred"},
        )
        _run(conn, _LAST, "downgrade")
        assert _shape(conn) == ({"id", "occurred_at"}, set())
        _run(conn, _EARLIER, "downgrade")
        assert _shape(conn) == ({"id", "occurred_at"}, set())


def test_a_database_left_between_the_two_still_comes_back_down():
    """One upgraded before the column moved, and never past it: going down
    through ``20261013_1200`` removes what that revision once built."""
    with sa.create_engine("sqlite://").connect() as conn:
        _ledger(conn)
        conn.execute(sa.text("ALTER TABLE auth_audit_log ADD COLUMN api_key_id TEXT"))
        conn.execute(sa.text(
            "CREATE INDEX idx_aal_api_key_occurred ON auth_audit_log "
            "(api_key_id, occurred_at) WHERE api_key_id IS NOT NULL"
        ))
        _run(conn, _EARLIER, "downgrade")
        assert _shape(conn) == ({"id", "occurred_at"}, set())


def test_the_chain_ends_at_the_ledger_revision():
    """One head, and nothing after the ledger revision touches the ledger,
    so its exclusive lock still lasts only for its own build.

    Revisions after it still run inside the same transaction when an
    upgrade starts below it: a database jumping straight from before
    ``20261014_1200`` to a later head holds the ledger's lock through every
    later revision too. Deploy that revision on its own first."""
    config = Config()
    config.set_main_option("script_location", str(_VERSIONS.parent))
    scripts = ScriptDirectory.from_config(config)
    assert len(scripts.get_heads()) == 1, scripts.get_heads()
    later = [
        s for s in scripts.walk_revisions(base=_LAST[:-3], head="heads")
        if s.revision != _LAST[:-3]
    ]
    assert [
        s.revision for s in later if "auth_audit_log" in Path(s.path).read_text()
    ] == []
    # The cheap revisions right after the ledger's stay in order, so the ledger's lock still
    # covers only them before the ones that follow.
    assert scripts.get_revision(_THEN).down_revision == _NEXT
    assert scripts.get_revision(_NEXT).down_revision == _LAST[:-3]
    assert scripts.get_revision(_THIRD).down_revision == _THEN
    assert scripts.get_revision(_FOURTH).down_revision == _THIRD


@pytest.mark.parametrize("name", sorted(_ON_LIVE_TABLES))
def test_a_revision_on_a_live_table_bounds_its_wait_for_the_lock(name):
    """First thing: the timeout must be in force before any DDL asks for a
    lock."""
    tree = ast.parse((_VERSIONS / name).read_text())
    functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    assert "SET LOCAL lock_timeout" in ast.unparse(functions["_bound_lock_wait"]), name
    for step in _ON_LIVE_TABLES[name]:
        first = functions[step].body[0]
        called = first.value.func.id if (
            isinstance(first, ast.Expr) and isinstance(first.value, ast.Call)
            and isinstance(first.value.func, ast.Name)
        ) else None
        assert called == "_bound_lock_wait", f"{name}: {step}() starts without it"
