"""`init_aggregation_db`'s additive list and the alembic chain are a mirror.

The Control Plane adds columns two ways. `init_aggregation_db` runs a list
of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements on start, so a
Control Plane that boots before a migration has run still works; the
alembic chain adds the same columns, so a database upgraded without the app
running gets them too. Each file's comments say it is "mirrored" with the
other. Nothing checked that it was.

It was not. `observed_cell_ratio` reached main-line code with:

  * a db_init statement that had lost its `ALTER TABLE` prefix, making it
    invalid SQL — and the loop wraps each statement in a try/except so one
    bad additive migration cannot fail start-up, so it failed silently on
    every boot;
  * no migration at all.

`0001_baseline` create_all()s the current ORM, so a brand-new environment
had the column and every existing one did not, while the write path issued
an UPDATE naming it. Fresh installs are exactly where this is invisible.

Pure text parsing: no database, no app import. Runs in the Guards workflow.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_DB_INIT = _BACKEND / "app" / "services" / "aggregation" / "db_init.py"
_VERSIONS = _BACKEND / "alembic" / "versions"

_ADD_COLUMN = re.compile(
    r"ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(?P<col>\w+)", re.IGNORECASE,
)


def _statements() -> list[str]:
    """Every string literal in the `_additive_migrations` tuple, with
    adjacent literals concatenated the way Python concatenates them.

    Read from the AST rather than by importing: the module pulls in the
    whole app, and this check needs none of it.
    """
    tree = ast.parse(_DB_INIT.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(t, ast.Name) and t.id == "_additive_migrations"
            for t in node.targets
        ):
            continue
        out = []
        for element in node.value.elts:
            out.append(_flatten(element))
        return out
    pytest.fail(f"no `_additive_migrations` tuple found in {_DB_INIT.name}")


def _flatten(node: ast.AST) -> str:
    """An f-string, a plain string, or the implicit concatenation of both,
    rendered with `{SCHEMA_NAME}`-style placeholders left as `?`."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(
            v.value if isinstance(v, ast.Constant) else "?"
            for v in node.values
        )
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _flatten(node.left) + _flatten(node.right)
    return ""


_STATEMENTS = _statements()
#: `DO $$ ... $$` is how the list expresses a conditional DDL block, which
#: plain `IF NOT EXISTS` cannot say (re-shaping a CHECK constraint, swapping a
#: partial index). It is a whole statement like the rest.
_LEADING = ("ALTER TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX", "CREATE TABLE",
            "UPDATE", "INSERT INTO", "DROP INDEX", "COMMENT ON", "DO $$")


@pytest.mark.parametrize("statement", _STATEMENTS)
def test_every_additive_statement_is_a_whole_statement(statement: str) -> None:
    """A fragment is not a no-op — it is a silent one. The loop catches and
    logs each statement's exception so one failure cannot stop start-up,
    which means a statement that is not SQL at all fails on every boot and
    nothing ever goes red."""
    body = statement.strip().lstrip("?").strip()
    assert body.upper().startswith(_LEADING), (
        f"not a complete SQL statement: {statement[:90]!r}. An entry that "
        f"starts mid-clause has lost the line above it — most often its "
        f"`f\"ALTER TABLE {{SCHEMA_NAME}}.<table> \"` prefix."
    )


def _migration_text() -> str:
    return "\n".join(
        p.read_text() for p in _VERSIONS.glob("*.py")
    )


@pytest.mark.parametrize(
    "column",
    sorted({
        m.group("col")
        for s in _STATEMENTS
        for m in [_ADD_COLUMN.search(s)]
        if m
    }),
)
def test_every_additively_added_column_has_a_migration(column: str) -> None:
    """The other half of the mirror. A column only db_init adds exists on
    every running deployment and on no database upgraded without the app —
    and `0001_baseline` create_all()s the current ORM, so a FRESH install
    has it too. That leaves exactly one shape of database missing it, which
    is the shape nobody develops against."""
    assert column in _migration_text(), (
        f"`{column}` is added by init_aggregation_db but by no migration in "
        f"{_VERSIONS.name}/. A database upgraded without the app running "
        f"will not have it, while fresh installs and running deployments "
        f"will — add the migration, guarded by an inspector check like its "
        f"siblings."
    )


# ── one bad statement must not void the other thirty-four ───────────────
#
# `init_aggregation_db` wrapped all 35 additive statements in ONE
# `engine.begin()` with a per-statement try/except that logs and continues.
# On PostgreSQL that try/except is inert: the first error puts the
# transaction in an aborted state, so every LATER statement fails with
# InFailedSQLTransactionError and is logged the same way — and COMMIT on an
# aborted transaction silently performs a ROLLBACK, so nothing escapes the
# context manager and init logs "complete (35 additive migrations applied)"
# with NOT ONE of them applied. Including the ones that had already
# succeeded before the bad statement.
#
# Reproduced against PostgreSQL 16: a single malformed ALTER left a table
# with only its original column and a clean success log.
#
# That is how the `observed_cell_ratio` incident this module's docstring
# describes actually behaved — not one column lost on every boot, but all
# of them. The statement was fixed; the mechanism that amplified it was not,
# so the next typo does it again. The guard above is text-only and cannot
# see this: it compares column NAMES between two files and executes nothing.


def test_each_additive_statement_gets_its_own_transaction():
    """A per-statement try/except only means what it says if a failure
    cannot poison its neighbours' transaction."""
    import ast

    src = _DB_INIT.read_text()
    tree = ast.parse(src)

    loop = None
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.For)
            and isinstance(node.iter, ast.Name)
            and node.iter.id == "_additive_migrations"
        ):
            loop = node
            break
    assert loop is not None, "the additive-migration loop has moved"

    # The transaction must be opened INSIDE the loop body, per statement.
    opens_inside = any(
        isinstance(inner, ast.AsyncWith)
        and "begin" in ast.dump(inner.items[0].context_expr)
        for inner in ast.walk(loop)
    )
    assert opens_inside, (
        "all 35 additive statements still share one transaction. On "
        "PostgreSQL the first failure aborts it, every later statement "
        "fails too, COMMIT silently rolls back, and init reports success "
        "with nothing applied."
    )


def test_the_loop_is_not_wrapped_in_one_outer_transaction():
    """The inner per-statement transaction is pointless if an outer one
    still spans the whole loop — the abort would propagate to it."""
    import ast

    tree = ast.parse(_DB_INIT.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncWith):
            continue
        if "begin" not in ast.dump(node.items[0].context_expr):
            continue
        for inner in ast.walk(node):
            if (
                isinstance(inner, ast.For)
                and isinstance(inner.iter, ast.Name)
                and inner.iter.id == "_additive_migrations"
            ):
                raise AssertionError(
                    "the additive loop runs inside an outer engine.begin(); "
                    "one aborted statement still takes the rest with it"
                )
