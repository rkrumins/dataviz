"""Introspection helpers for migrations that must survive a drifted database.

Why not ``if_not_exists=True``
------------------------------
Alembic 1.16+ accepts ``if_not_exists`` on ``add_column`` / ``create_table`` /
``create_index`` and ``if_exists`` on ``drop_constraint``, and it is the
obvious way to write this. It compiles to ``ALTER TABLE … ADD COLUMN IF NOT
EXISTS``, which **Postgres supports and SQLite does not** — so a migration
written that way dies with ``sqlite3.OperationalError: near "EXISTS"`` the
moment anything runs the chain against SQLite. The test suite does exactly
that (``test_invite_lifecycle.py`` replays the migrations to check they agree
with the ORM), so the guard that made production deploys survive broke the
build.

Asking the inspector instead is dialect-neutral: it works on both, and it does
not depend on which Alembic version is installed. ``20260728_1500_idp_lifecycle``
already did it this way by hand; this is that pattern, shared.

When to reach for it
--------------------
Only for revisions that have actually met a database whose physical schema was
ahead of ``alembic_version``. DDL here is transactional, so one duplicate does
not skip a statement — it rolls back the entire upgrade and blocks every
revision behind it. That is what makes the guard worth the noise; it is not a
default to apply to new migrations, which should fail loudly on a schema they
did not expect.
"""
from __future__ import annotations

import sqlalchemy as sa


def has_table(bind, table: str) -> bool:
    return sa.inspect(bind).has_table(table)


def has_column(bind, table: str, column: str) -> bool:
    """False when the table itself is absent — the column cannot be there
    either, and the caller's next move is the same in both cases."""
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return False
    return column in {c["name"] for c in inspector.get_columns(table)}


def has_index(bind, table: str, index: str) -> bool:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return False
    return index in {i["name"] for i in inspector.get_indexes(table)}


def has_constraint(bind, table: str, name: str) -> bool:
    """CHECK constraints only — the one kind this codebase re-defines.

    SQLite exposes them through ``get_check_constraints`` like Postgres does,
    but older reflection paths raise rather than return empty, so a failure to
    introspect is reported as "not present": the caller then attempts the
    create, and a genuine duplicate surfaces as a real error rather than being
    silently swallowed here.
    """
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return False
    try:
        return name in {c["name"] for c in inspector.get_check_constraints(table)}
    except (NotImplementedError, sa.exc.SQLAlchemyError):
        return False


__all__ = ["has_table", "has_column", "has_index", "has_constraint"]
