"""synodic-upgrade — standalone schema management CLI.

Modelled on datahub-upgrade. Runs in a dedicated container image
(``backend/Dockerfile.upgrade``) and is never invoked from the FastAPI
lifespan.

Two deployment roles:

* **Helm pre-install/pre-upgrade hook Job** — runs ``upgrade`` to bring
  the schema to head (or ``downgrade --revision X`` for manual rollbacks).
* **initContainer on every backend service Pod** — runs
  ``check --wait N`` and exits 0 only if the schema matches every
  Alembic head. Pods fail to start otherwise.

Subcommands:
    upgrade   [--revision REV]   alembic upgrade (default: head)
    downgrade  --revision REV    alembic downgrade
    repair                       reconcile a version pointer that trails the
                                 physical schema (see ``cmd_repair``)
    verify-schema                exit 0 iff the live schema structurally
                                 matches the ORM (CI convergence gate)
    current                      show currently applied revision(s)
    heads                        show available head revision(s)
    history                      show migration history
    check    [--wait SECS]       exit 0 iff schema matches every head;
                                 poll up to SECS waiting for it

Usage (in-container):
    python -m backend.scripts.upgrade upgrade
    python -m backend.scripts.upgrade check --wait 60
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time

from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from backend.app.db.engine import _alembic_config

# 'SYNO' as int — namespace for ``pg_advisory_lock`` so multiple
# invocations of this script (Job + ad-hoc ``kubectl exec``) serialise
# cleanly. The lock is released on disconnect even if Python crashes.
LOCK_KEY = 0x53594E4F

log = logging.getLogger("synodic-upgrade")


def _sync_url() -> str:
    """Return the Alembic-compatible sync DSN.

    The app uses ``postgresql+asyncpg://`` at runtime; Alembic itself is
    sync and needs psycopg2. Strip the async driver suffix.
    """
    return os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2")


def _with_advisory_lock(fn):
    """Wrap a command so it executes while holding ``pg_advisory_lock``.

    Defense-in-depth: the Helm Job runs with ``parallelism: 1`` so two
    upgrades shouldn't normally collide, but ad-hoc invocations (e.g.
    ``kubectl exec`` from a maintenance pod) can race. The lock makes
    every invocation safe.
    """

    def _wrapped(*args, **kwargs):
        engine = create_engine(
            _sync_url(), isolation_level="AUTOCOMMIT", pool_pre_ping=True
        )
        with engine.connect() as conn:
            # The aggregation schema must exist before Alembic ``env.py``
            # imports models that reference it. The Helm db-init-job
            # already creates it; this keeps the script self-sufficient
            # for non-Helm invocations.
            conn.execute(text("CREATE SCHEMA IF NOT EXISTS aggregation"))
            log.info("Acquiring advisory lock %d", LOCK_KEY)
            conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_KEY})
            try:
                return fn(*args, **kwargs)
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})

    return _wrapped


#: Any of these present means the database is not virgin. ``users`` alone
#: would do; the other two make the check survive a future rename.
_APP_TABLES = ("users", "workspaces", "providers")


def _is_virgin(conn) -> bool:
    """True when this database has no schema of ours at all.

    Checked here rather than in ``alembic/env.py`` on purpose:
    ``env.py::_ensure_wide_alembic_version_column`` creates
    ``alembic_version`` as a side effect of being imported, so anything
    asking this question after env.py has loaded sees a table that env.py
    itself just made and concludes the database is not virgin.

    ``alembic_version`` present but EMPTY still counts as virgin — that is
    the state env.py leaves behind if a first run dies early, and treating
    it as "already installed" would send a blank database down the
    migration path to fail on the first ``ALTER``.
    """
    from sqlalchemy import inspect as sa_inspect

    inspector = sa_inspect(conn)
    if any(inspector.has_table(name) for name in _APP_TABLES):
        return False
    if not inspector.has_table("alembic_version"):
        return True
    return conn.execute(text("SELECT count(*) FROM alembic_version")).scalar() == 0


def _install_fresh(cfg) -> None:
    """Build a virgin database directly at head instead of replaying.

    ``0001_baseline`` is ``Base.metadata.create_all()`` against the LIVE
    ORM, so a fresh database is born holding today's schema. Replaying the
    rest of the chain on top of that then re-applies ~70 revisions' worth
    of ``ALTER``s that are already there — which is why every migration
    had to be written defensively, and why the ones that weren't took the
    whole deployment down.

    Running baseline and stamping head ends that: the chain now only ever
    runs against databases that predate it, which is the contract Alembic
    is actually built around.

    ``0001_baseline`` is reused rather than calling ``create_all`` again
    here, so there stays exactly one place that turns ORM metadata into
    tables.
    """
    log.info("Virgin database — installing at head without replaying the chain")
    command.upgrade(cfg, "0001_baseline")

    # create_all builds the tables; it does not write a single row. The
    # RBAC rows have only ever existed as INSERTs inside the migrations
    # we just skipped, and a database with no permissions and no roles
    # cannot authorise anybody.
    from backend.app.db.seed_reference_data import seed_reference_data

    engine = create_engine(_sync_url(), pool_pre_ping=True)
    with engine.begin() as conn:
        written = seed_reference_data(conn)
    log.info("Seeded reference data: %s", written)

    command.stamp(cfg, "head")
    log.info("Stamped to head")


@_with_advisory_lock
def cmd_upgrade(revision: str, fast_path: bool = True) -> int:
    cfg = _alembic_config()

    if fast_path and revision == "head":
        engine = create_engine(_sync_url(), pool_pre_ping=True)
        with engine.connect() as conn:
            virgin = _is_virgin(conn)
        if virgin:
            _install_fresh(cfg)
            log.info("Upgrade complete (fresh install)")
            return 0

    log.info("Alembic upgrade -> %s", revision)
    command.upgrade(cfg, revision)
    log.info("Upgrade complete")
    return 0


def _orm_metadata():
    """Return the management ``MetaData`` with every ORM module imported.

    Same import set as ``alembic/env.py`` — the modules are imported for
    their side effect of registering tables on ``Base.metadata``. Imported
    lazily so ``--help`` and ``current`` don't pay for it.
    """
    from backend.app.db.engine import Base
    from backend.app.db import models as _management_models  # noqa: F401
    from backend.app.services.aggregation import models as _agg_models  # noqa: F401

    return Base.metadata


def _compare_schema(engine) -> tuple[list[str], list[str], list[str]]:
    """Compare the live database against ORM metadata.

    Returns ``(failures, default_diffs, extra_columns)``:

    * **failures** — a table or column the ORM declares and the database
      lacks, or one whose type or nullability disagrees. An empty list
      means the live schema satisfies head, whatever ``alembic_version``
      claims, which is the one question ``repair`` needs answered. It is a
      comparison against ORM metadata rather than a per-revision replay
      precisely so it cannot lie about a migration having "probably" run.
    * **default_diffs** — a ``server_default`` on one side and not the
      other. Reported, never a failure by itself; see ``cmd_verify_schema``.
    * **extra_columns** — in the database, in no ORM model.
    """
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy.dialects import postgresql

    dialect = postgresql.dialect()

    def _type_of(column_type) -> str:
        try:
            return str(column_type.compile(dialect=dialect))
        except Exception:  # unmappable type — fall back to the class name
            return column_type.__class__.__name__.upper()

    metadata = _orm_metadata()
    inspector = sa_inspect(engine)

    failures: list[str] = []
    default_diffs: list[str] = []
    extra_columns: list[str] = []

    for table in metadata.sorted_tables:
        qualified = f"{table.schema or 'public'}.{table.name}"
        if not inspector.has_table(table.name, schema=table.schema):
            failures.append(f"missing table {qualified}")
            continue

        live = {
            c["name"]: c
            for c in inspector.get_columns(table.name, schema=table.schema)
        }
        for col in table.columns:
            actual = live.get(col.name)
            if actual is None:
                failures.append(f"missing column {qualified}.{col.name}")
                continue
            if _type_of(col.type) != _type_of(actual["type"]):
                failures.append(
                    f"type mismatch {qualified}.{col.name}: "
                    f"orm={_type_of(col.type)} db={_type_of(actual['type'])}"
                )
            if col.nullable != actual["nullable"]:
                failures.append(
                    f"nullability mismatch {qualified}.{col.name}: "
                    f"orm nullable={col.nullable} db nullable={actual['nullable']}"
                )
            if (col.server_default is not None) != (actual.get("default") is not None):
                default_diffs.append(
                    f"{qualified}.{col.name}: orm server_default="
                    f"{col.server_default is not None} "
                    f"db default={actual.get('default')!r}"
                )

        extra_columns.extend(
            f"{qualified}.{name}" for name in live if name not in table.columns
        )

    return failures, default_diffs, extra_columns


def cmd_verify_schema(strict_defaults: bool = False) -> int:
    """Fail if the live schema disagrees with the ORM on structure.

    The two ways a database gets built — ``create_all`` on the virgin
    path, the migration chain everywhere else — have no mechanism forcing
    them to agree, and they had silently diverged:
    ``context_models.visibility`` existed only on databases new enough to
    have been created after it entered the ORM. This is the check that
    makes such a split fail a pull request instead of surfacing as an
    ``UndefinedColumn`` months later.

    STRUCTURE is enforced: a table or column the ORM declares must exist,
    with matching nullability and compiled type.

    SERVER DEFAULTS are reported, not enforced. 41 columns currently carry
    a default on migrated databases that a fresh one lacks, because
    migrations write ``server_default=`` where the ORM declares only a
    Python-side ``default=``. Every write through SQLAlchemy supplies the
    value either way, so this bites only raw SQL that omits the column.
    The list is in ``docs/TECHNICAL_DEBT.md``; ``--strict-defaults`` turns
    it into a failure for anyone working through it.

    Columns present in the database but absent from the ORM are reported
    too, never failed — those are leftovers on long-lived databases
    (``resource_grants.expires_at``, ``views.display_rules``) and dropping
    them is a deliberate act, not a CI job's decision.
    """
    engine = create_engine(_sync_url(), pool_pre_ping=True)
    failures, default_diffs, extra_columns = _compare_schema(engine)

    for line in extra_columns:
        log.info("Column in database but not in the ORM (ignored): %s", line)
    for line in default_diffs:
        log.warning("server_default differs: %s", line)
    if default_diffs:
        log.warning(
            "%d server_default difference(s) — known drift, see "
            "docs/TECHNICAL_DEBT.md", len(default_diffs),
        )

    if failures:
        for line in failures:
            log.error("Schema mismatch: %s", line)
        log.error(
            "%d structural mismatch(es) between the ORM and this database. "
            "A column the ORM declares must be added by a migration, not "
            "only by create_all — otherwise it exists on fresh installs "
            "and nowhere else.", len(failures),
        )
        return 1

    if strict_defaults and default_diffs:
        log.error("--strict-defaults: %d default difference(s)", len(default_diffs))
        return 1

    log.info(
        "Schema matches the ORM: %d tables verified, %d default difference(s) "
        "tolerated", len(_orm_metadata().sorted_tables), len(default_diffs),
    )
    return 0


@_with_advisory_lock
def cmd_repair() -> int:
    """Stamp forward when the schema is ahead of ``alembic_version``.

    A database can end up with a version pointer that trails its own
    schema — a partially-recorded run, a restore, a hand-edited pointer,
    or a previous image whose script directory didn't contain the
    revisions the database had already applied. ``upgrade`` then replays
    migrations whose work is already done and dies on ``DuplicateColumn``
    / ``DuplicateTable``, and because every service gates on the upgrade
    Job completing, the whole deployment stays down.

    The rule here is conservative: stamp head **only** when the ORM finds
    nothing missing from the live schema. If anything is genuinely absent
    the command refuses and names it, because the correct action then is
    ``upgrade``, not a stamp that would mark unapplied work as done.

    Every revision being marked applied is logged by id, so an operator
    can see exactly what is being skipped rather than trusting a summary.
    """
    cfg = _alembic_config()
    script = ScriptDirectory.from_config(cfg)
    expected = set(script.get_heads())

    engine = create_engine(_sync_url(), pool_pre_ping=True)
    with engine.connect() as conn:
        from sqlalchemy import inspect as sa_inspect

        if not sa_inspect(conn).has_table("alembic_version"):
            log.error(
                "No alembic_version table — this database has never been "
                "migrated. Run `upgrade`, not `repair`."
            )
            return 1
        applied = {
            r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version"))
        }

    if applied == expected:
        log.info("Already at head: %s — nothing to repair", sorted(applied))
        return 0

    gaps, _defaults, _extras = _compare_schema(engine)
    if gaps:
        log.error(
            "Refusing to stamp: the schema is genuinely behind head. "
            "%d mismatch(es), first 10: %s. Run `upgrade` instead.",
            len(gaps), gaps[:10],
        )
        return 1

    # Tuple, not ``applied.pop()`` — a multi-head database has several
    # pointers and popping one would silently mis-report the rest.
    lower = tuple(applied) if applied else "base"
    skipped = [rev.revision for rev in script.iterate_revisions("heads", lower)]
    log.warning(
        "Schema already satisfies head but alembic_version does not. "
        "Marking %d revision(s) applied without running them: %s",
        len(skipped), skipped,
    )
    command.stamp(cfg, "head")
    log.info("Stamped to head: %s", sorted(expected))
    return 0


@_with_advisory_lock
def cmd_downgrade(revision: str) -> int:
    log.warning("Alembic downgrade -> %s (destructive!)", revision)
    command.downgrade(_alembic_config(), revision)
    log.warning("Downgrade complete")
    return 0


def cmd_current() -> int:
    command.current(_alembic_config(), verbose=True)
    return 0


def cmd_heads() -> int:
    command.heads(_alembic_config(), verbose=True)
    return 0


def cmd_history() -> int:
    command.history(_alembic_config(), verbose=True)
    return 0


def cmd_check(wait_secs: int) -> int:
    """Exit 0 iff ``alembic_version`` matches every head in the script directory.

    Polls every 2s up to ``wait_secs``. Exits 1 on persistent mismatch
    or missing ``alembic_version`` table.
    """
    cfg = _alembic_config()
    expected = set(ScriptDirectory.from_config(cfg).get_heads())
    deadline = time.monotonic() + wait_secs

    while True:
        try:
            engine = create_engine(_sync_url(), pool_pre_ping=True)
            with engine.connect() as conn:
                rows = conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).fetchall()
            applied = {r[0] for r in rows}
            if applied == expected:
                log.info("Schema verified at head: %s", sorted(applied))
                return 0
            log.warning(
                "Schema mismatch: applied=%s expected=%s",
                sorted(applied),
                sorted(expected),
            )
        except Exception as exc:
            log.warning("Schema check failed: %s", exc)

        if time.monotonic() >= deadline:
            log.error(
                "Schema check timed out after %ds — upgrade job has not run",
                wait_secs,
            )
            return 1
        time.sleep(2)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(prog="synodic-upgrade")
    sub = parser.add_subparsers(dest="cmd", required=True)

    up = sub.add_parser("upgrade", help="Run alembic upgrade")
    up.add_argument("--revision", default="head")
    up.add_argument(
        "--no-fast-path",
        action="store_true",
        help="Replay the migration chain even on a virgin database "
             "(what CI uses to keep the chain itself exercised)",
    )

    down = sub.add_parser("downgrade", help="Run alembic downgrade")
    down.add_argument("--revision", required=True)

    sub.add_parser(
        "repair",
        help="Stamp head when the schema is already ahead of alembic_version",
    )

    ver = sub.add_parser(
        "verify-schema",
        help="Exit 0 iff the live schema structurally matches the ORM",
    )
    ver.add_argument(
        "--strict-defaults",
        action="store_true",
        help="Also fail on server_default differences (known drift; see "
             "docs/TECHNICAL_DEBT.md)",
    )

    sub.add_parser("current", help="Show currently applied revision(s)")
    sub.add_parser("heads", help="Show available head revision(s)")
    sub.add_parser("history", help="Show migration history")

    chk = sub.add_parser("check", help="Exit 0 iff schema is at head")
    chk.add_argument("--wait", type=int, default=0,
                     help="Poll up to N seconds for schema to reach head")

    args = parser.parse_args()

    if args.cmd == "upgrade":
        return cmd_upgrade(args.revision, fast_path=not args.no_fast_path)
    if args.cmd == "downgrade":
        return cmd_downgrade(args.revision)
    if args.cmd == "repair":
        return cmd_repair()
    if args.cmd == "verify-schema":
        return cmd_verify_schema(strict_defaults=args.strict_defaults)
    if args.cmd == "current":
        return cmd_current()
    if args.cmd == "heads":
        return cmd_heads()
    if args.cmd == "history":
        return cmd_history()
    if args.cmd == "check":
        return cmd_check(args.wait)
    return 2


if __name__ == "__main__":
    sys.exit(main())
