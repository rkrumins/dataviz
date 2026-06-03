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


@_with_advisory_lock
def cmd_upgrade(revision: str) -> int:
    log.info("Alembic upgrade -> %s", revision)
    command.upgrade(_alembic_config(), revision)
    log.info("Upgrade complete")
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

    down = sub.add_parser("downgrade", help="Run alembic downgrade")
    down.add_argument("--revision", required=True)

    sub.add_parser("current", help="Show currently applied revision(s)")
    sub.add_parser("heads", help="Show available head revision(s)")
    sub.add_parser("history", help="Show migration history")

    chk = sub.add_parser("check", help="Exit 0 iff schema is at head")
    chk.add_argument("--wait", type=int, default=0,
                     help="Poll up to N seconds for schema to reach head")

    args = parser.parse_args()

    if args.cmd == "upgrade":
        return cmd_upgrade(args.revision)
    if args.cmd == "downgrade":
        return cmd_downgrade(args.revision)
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
