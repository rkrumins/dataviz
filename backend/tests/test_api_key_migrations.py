"""API keys' migrations, as a database that is serving traffic runs them.

The upgrade job applies its revisions in one transaction, so every lock is
held until the whole upgrade commits — and a failed upgrade changes nothing.
Within that:

* the ledger's ``api_key_id`` column and its index are the upgrade's last
  step, so the ledger's exclusive lock — reads included — lasts only for its
  own build, not for every revision after it;
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
#: Every revision that locks a table other requests use, and in which
#: direction: ``users`` for the key's foreign key, ``user_identities``, and
#: the ledger.
_ON_LIVE_TABLES = {
    "20261012_1000_api_keys.py": ("upgrade", "downgrade"),
    _EARLIER: ("downgrade",),
    "20261013_1300_api_key_scale.py": ("upgrade", "downgrade"),
    _LAST: ("upgrade", "downgrade"),
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


def test_nothing_that_locks_a_live_table_runs_after_the_ledger():
    """The ledger is last among the revisions that take a lock.

    Was ``get_heads() == [the ledger]``. The reason behind that assertion
    is the one worth keeping: the upgrade runs in a single transaction, so
    the ledger's exclusive lock — reads included — is held until the whole
    upgrade commits, and putting it last keeps that to its own build
    rather than to every revision after it.

    Pinning the literal tip also pinned something it did not mean to: that
    no revision may ever be added after the API-key work. A branch that
    adds one has only bad options, and the tidy-looking one is the actual
    bug — re-parenting it *before* the ledger means alembic never runs it
    on any database already stamped at the ledger, because alembic only
    walks forward. Silently, and permanently. Main's own earlier merge
    note makes the same point from the other side: re-parent forward,
    because the target is already stamped and there is nothing to stamp
    back.

    So this now asserts what the docstring at the top of this file
    actually claims. It still fails for the case that matters — a revision
    locking ``users``, ``user_identities`` or the ledger landing after it
    — and it still fails if the chain forks.
    """
    config = Config()
    config.set_main_option("script_location", str(_VERSIONS.parent))
    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()
    assert len(heads) == 1, f"the migration chain has forked: {heads}"

    ledger = _LAST[:-3]
    after = [
        rev.revision
        for rev in script.iterate_revisions(heads[0], ledger)
        if rev.revision != ledger
    ]
    locks_a_live_table = {name[:-3] for name in _ON_LIVE_TABLES}

    offenders = sorted(set(after) & locks_a_live_table)
    assert not offenders, (
        f"{offenders} lock a live table and run after the ledger, so the "
        f"ledger's exclusive lock is held for their work too"
    )


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
