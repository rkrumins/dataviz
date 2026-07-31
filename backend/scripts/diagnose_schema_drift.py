"""Read-only: how far is the schema ahead of ``alembic_version``?

Why this exists
---------------
A database whose physical schema is *ahead* of its recorded revision fails
one migration at a time. You stamp past the failure, redeploy, and the next
revision dies the same way — ``DuplicateTable`` on ``invites``, then
``DuplicateColumn`` on ``revoked_refresh_jti.successor_jti``, and so on. Each
round costs a deploy to discover a fact the database could have told you up
front.

This answers the whole question in one pass: **is anything the target schema
expects actually missing?** If not, the schema is already at head and only the
version pointer is stale, so a single ``alembic stamp head`` reconciles it. If
something *is* missing, this prints exactly what — and stamping past it would
leave a permanently broken schema that no later migration repairs, which is the
failure mode worth spending a script to avoid.

Writes nothing. Runs no migrations. Safe against production.

Usage
-----
    MANAGEMENT_DB_URL=postgresql+asyncpg://... \\
        python -m backend.scripts.diagnose_schema_drift

Limits, stated plainly
----------------------
The comparison is ORM metadata vs. live schema — tables and columns. It does
NOT see CHECK constraints, indexes, defaults, or the data backfills some
migrations perform. So "nothing missing" means *structurally* at head, which
is what decides whether a stamp is safe, not a guarantee that every migration's
side effects have run. Where a pending revision does more than DDL, read it
before stamping past it.
"""
from __future__ import annotations

import os
import sys

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text


def _sync_url() -> str:
    """The Alembic-compatible sync DSN — same conversion ``upgrade.py`` uses."""
    try:
        return os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2")
    except KeyError:
        sys.exit("MANAGEMENT_DB_URL is not set.")


def _alembic_cfg() -> Config:
    from backend.app.db.engine import _alembic_config

    return _alembic_config()


def main() -> int:
    # Importing the models registers every table on Base.metadata, which is
    # this script's description of "what head expects".
    from backend.app.db.engine import Base
    import backend.app.db.models  # noqa: F401  (registration side effect)

    engine = create_engine(_sync_url(), pool_pre_ping=True)
    script = ScriptDirectory.from_config(_alembic_cfg())
    heads = set(script.get_heads())

    with engine.connect() as conn:
        try:
            applied = {
                r[0] for r in conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).fetchall()
            }
        except Exception as exc:
            sys.exit(f"Could not read alembic_version: {exc}")

        inspector = inspect(conn)
        live_tables = set(inspector.get_table_names())
        live_columns = {
            t: {c["name"] for c in inspector.get_columns(t)} for t in live_tables
        }

    print("=" * 68)
    print(f"recorded revision : {sorted(applied) or '(none)'}")
    print(f"expected head     : {sorted(heads)}")
    print("=" * 68)

    if applied == heads:
        print("\nalembic_version is already at head. Nothing to reconcile.")
        return 0

    # Which revisions sit between what the DB records and head.
    pending = []
    for rev in script.walk_revisions():
        if rev.revision in applied:
            break
        pending.append(rev)
    pending.reverse()

    print(f"\n{len(pending)} revision(s) pending:\n")
    for rev in pending:
        summary = (rev.doc or "").strip().splitlines()[0] if rev.doc else ""
        print(f"  {rev.revision}  {summary[:60]}")

    # The decisive question: does the live schema already contain everything
    # the ORM (i.e. head) describes?
    missing_tables = sorted(
        name for name in Base.metadata.tables
        if name.split(".")[-1] not in live_tables
        and "." not in name  # skip other-schema tables (aggregation.*)
    )
    missing_columns: list[str] = []
    for name, table in Base.metadata.tables.items():
        if "." in name:
            continue
        short = name.split(".")[-1]
        if short not in live_tables:
            continue
        for col in table.columns:
            if col.name not in live_columns.get(short, set()):
                missing_columns.append(f"{short}.{col.name}")

    print("\n" + "-" * 68)
    if not missing_tables and not missing_columns:
        print("The live schema already contains every table and column head")
        print("expects. The schema is AHEAD of the version pointer, which is")
        print("why each pending revision fails as a duplicate.")
        print()
        print("Reconcile in one step:")
        print()
        print("    python -m backend.scripts.upgrade current   # confirm the above")
        print(f"    alembic stamp {sorted(heads)[0]}")
        print()
        print("Read any pending revision that does more than DDL first — this")
        print("check sees tables and columns, not backfills or constraints.")
        return 0

    print("The live schema is MISSING things head expects. Do NOT stamp past")
    print("these — no later migration re-creates them:")
    print()
    for t in missing_tables:
        print(f"  missing table   {t}")
    for c in missing_columns:
        print(f"  missing column  {c}")
    print()
    print("Stamp only to the last revision whose effects are all present, then")
    print("run the upgrade so the rest apply normally.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
