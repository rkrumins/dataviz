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
    upgrade   [--revision REV]   alembic upgrade (default: head); a database
              [--rewind-to REV]  another build moved on is rewound onto this
                                 build's chain first (see ``_rewind_foreign``),
                                 to REV when named
    plan      [--json]           what ``upgrade`` would do now, changing nothing;
                                 exit 1 when it would refuse
    backup     --dir DIR         pg_dump before an upgrade changes the database
                                 (only then, unless --force); see ``cmd_backup``
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
import json
import logging
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from backend.app.db import migration_records, schema_plan
from backend.app.db.engine import _alembic_config
from backend.app.db.schema_plan import Refused

# Where a database stands, and what to do with a stamp another build wrote: app/db/schema_plan.py,
# by the names this script, and its tests, use.
_ancestors, _below_gaps, _built_from = schema_plan.ancestors, schema_plan.below_gaps, schema_plan.built_from
_foreign, _is_virgin, _maximal = schema_plan.foreign, schema_plan.is_virgin, schema_plan.maximal
_parting_point, _placed, _ran = schema_plan.parting_point, schema_plan.placed, schema_plan.ran
_stamps = schema_plan.stamps

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


def _connect(engine, wait_secs: int = 120):
    """A connection, waiting up to ``wait_secs`` for a database that isn't taking them yet:
    starting, failing over, or behind a proxy sidecar still coming up. Compose runs the Job once,
    so it can't count on a retry from outside."""
    from sqlalchemy.exc import OperationalError

    deadline, pause = time.monotonic() + wait_secs, 1
    while True:
        try:
            return engine.connect()
        except OperationalError as error:
            if time.monotonic() + pause > deadline:
                raise
            log.warning("The database isn't taking connections yet (%s); trying again in %ds.",
                        str(error.orig).strip().splitlines()[0], pause)
            time.sleep(pause)
            pause = min(pause * 2, 15)


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
        with _connect(engine) as conn:
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
    from backend.app.db.seed_reference_data import (
        reconcile_reference_data,
        seed_reference_data,
    )

    engine = create_engine(_sync_url(), pool_pre_ping=True)
    with engine.begin() as conn:
        written = seed_reference_data(conn)
        reconcile_reference_data(conn)          # records every entry as applied
    log.info("Seeded reference data: %s", written)

    # Before the stamp: a database stamped at head without it is one ``check`` passes and
    # every graph read refuses.
    _build_graphver()

    command.stamp(cfg, "heads")
    log.info("Stamped to head")


def _graphver_here() -> bool:
    """Whether the version store lives in the management database: ``GRAPHVER_DB_URL`` unset (the
    shipped deployments), or naming that same database."""
    from backend.app.services.versioning import config as gv_config

    return gv_config.graphver_db_url() == os.environ["MANAGEMENT_DB_URL"]


def _build_graphver() -> None:
    """The version store's schema (``graphver``), built as a versioning worker builds it when it
    starts: ``create_schema_and_partitions``, idempotent, serialised by a lock of its own. Graph
    reads need it and no migration makes it, so a fresh install without it answered 503 to every
    one until a worker had started."""
    import asyncio

    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from backend.app.services.versioning import config as gv_config
    from backend.app.services.versioning import models as gv_models

    async def build() -> None:
        engine = create_async_engine(gv_config.graphver_db_url(), poolclass=NullPool)
        try:
            await gv_models.create_schema_and_partitions(engine)
        finally:
            await engine.dispose()

    asyncio.run(build())
    log.info("Built the version store's schema (%s)", gv_config.graphver_schema())


def _other_lines(cfg) -> dict[str, list[list[str]]]:
    """``alembic/other_lines.json`` beside this build's migrations (:func:`schema_plan.other_lines`)."""
    return schema_plan.other_lines(cfg.get_main_option("script_location"))


def _set_stamps(conn, stamps: list[str]) -> None:
    conn.execute(text("DELETE FROM alembic_version"))
    for v in stamps:
        conn.execute(text("INSERT INTO alembic_version (version_num) VALUES (:v)"), {"v": v})


def _rewind_foreign(cfg, to: str | None = None,
                    recover: bool = False) -> tuple[list[str], list[str], list[str]] | None:
    """Move a database another build migrated onto this build's chain, so it can upgrade in order.

    Where it goes is :func:`schema_plan.placement`: exactly, from the lineage the database keeps
    (``app/db/migration_records.py``) or the record (``alembic/other_lines.json``); at ``to``, named
    by an operator; with ``recover``, where the chains most likely parted. A stamp none of those
    places is :class:`Refused`, with nothing changed. The other build's tables and columns stay,
    for when its migrations arrive with it. Returns the stamps as they were (to put back if the
    upgrade doesn't bring the schema to head), as placed, and those of ours it kept; None when
    nothing was foreign."""
    script = ScriptDirectory.from_config(cfg)
    engine = create_engine(_sync_url(), pool_pre_ping=True)
    with engine.begin() as conn:
        was = _stamps(conn)
        place = schema_plan.placement(script, was, _other_lines(cfg),
                                      migration_records.read_chain(conn), to, recover)
        if place is None:
            if to is not None:
                log.warning("--rewind-to %s: alembic_version names nothing this build doesn't have; "
                            "nothing to rewind", to)
            return None
        log.warning(
            "alembic_version names %s, which this build doesn't have: another build — another "
            "branch's, or a newer release's — moved this database on. Placing it at %s, %s; this "
            "build's migrations it lacks run in order, and the other build's tables and columns are "
            "left as they are.", place.foreign, place.stamps, place.how)
        _set_stamps(conn, place.stamps)
        # With the stamps, in one transaction: a Job stopped before the schema is checked leaves
        # this open, and the next one checks it.
        migration_records.ensure(conn)
        migration_records.record_step(conn, place.foreign[0], "placed", None,
                                      {"was": was, "stamps": place.stamps, "kept": place.kept})
    return was, place.stamps, place.kept


def _upgrade(cfg, revision: str) -> None:
    """``alembic upgrade``, again when a migration gives up waiting for a lock (``lock_timeout``,
    set in ``alembic/env.py``): that one rolled back, the ones before it stand, and the traffic it
    would have held up got through. Six tries, 5s to 60s apart; any other error is raised."""
    from psycopg2.errors import LockNotAvailable
    from sqlalchemy.exc import OperationalError

    for attempt, pause in enumerate((5, 10, 20, 40, 60, None), start=1):
        try:
            command.upgrade(cfg, revision)
            return
        except OperationalError as error:
            if not isinstance(error.orig, LockNotAvailable) or pause is None:
                raise
            log.warning("A migration gave up waiting for a lock (try %d): %s. Trying again in %ds.",
                        attempt, str(error.orig).strip().splitlines()[0], pause)
            time.sleep(pause)


def _to_every_head(cfg, revision: str) -> str:
    """``head`` as every head (``heads``): two PRs green on their own can each add a revision on
    one parent, and merged the chain has two heads until a merge revision joins them. Alembic
    refuses ``head`` then ("Multiple heads are present"), and every deploy would stop there;
    ``heads`` brings a database to each of them. CI's single-head guard
    (``tests/test_alembic_single_head.py``) says the merge revision is due."""
    if revision not in ("head", "heads"):
        return revision
    heads = ScriptDirectory.from_config(cfg).get_heads()
    if len(heads) > 1:
        log.warning("The migration chain has %d heads: %s. Upgrading to each; a merge revision "
                    "should join them.", len(heads), sorted(heads))
    return "heads"


@_with_advisory_lock
def cmd_upgrade(revision: str, fast_path: bool = True, rewind_to: str | None = None,
                recover: bool = False, shared_database: bool = False) -> int:
    cfg = _alembic_config()
    script = ScriptDirectory.from_config(cfg)
    where, on_main = _built_from()
    # First, so an image older than expected is plain from its first lines.
    log.info("This build: %s (%s); its migration chain ends at %s", where,
             {True: "on main", False: "not on main", None: "on main or not, unrecorded"}[on_main],
             sorted(script.get_heads()))
    revision = _to_every_head(cfg, revision)
    engine = create_engine(_sync_url(), pool_pre_ping=True)

    if shared_database and on_main is None:
        # Every image built before builds recorded it: refusing would stop deployments that work.
        log.warning("This database is shared (--shared-database), and this image doesn't record "
                    "the commit it was built from, so it can't be held to main's: build it with "
                    "deploy/build-images.sh.")
    if shared_database and on_main is False:
        # Only main's migrations reach a database others use: a branch's would stamp it with
        # revisions main may never have, as main's builds would then find.
        with engine.connect() as conn:
            stamps = _stamps(conn)
        if stamps != sorted(script.get_heads()):
            log.error("This database is shared (--shared-database), and this build is from %s, not "
                      "a commit on main: only builds from main migrate a shared database. Nothing "
                      "was changed. Deploy a build from main (deploy/build-images.sh records where "
                      "an image was built from), or give this build a database of its own.", where)
            return 1
        log.info("Shared database, a build not from main: the database is at its head already, "
                 "so there is nothing to run.")
        return 0

    if fast_path and revision == "heads":
        with engine.connect() as conn:
            virgin = _is_virgin(conn)
        if virgin:
            _install_fresh(cfg)
            log.info("Upgrade complete (fresh install)")
            return 0

    with engine.begin() as conn:
        for changed, path in migration_records.changed(conn, script):
            # It ran here before its file changed: the change won't reach this database.
            log.warning("Migration %s has changed since it ran on this database; the change won't "
                        "reach it. A change that matters belongs in a new migration.", changed)
            migration_records.record_step(conn, changed, "changed", path)

    with engine.connect() as conn:
        left_open, foreign_now = migration_records.open_placement(conn), _foreign(script, _stamps(conn))
    if left_open is not None and not foreign_now:
        placed = left_open["was"], left_open["stamps"], left_open["kept"]
        log.warning("An upgrade placed this database at %s (it was stamped %s) and stopped before its "
                    "schema was checked: this one checks it.", placed[1], placed[0])
    else:
        try:
            placed = _rewind_foreign(cfg, rewind_to, recover)
        except Refused as refused:
            log.error("%s", refused)
            return 1
    log.info("Alembic upgrade -> %s", revision)
    _upgrade(cfg, revision)
    if revision == "heads":
        # As a fresh install has it: the graphver migrations change the schema only once it
        # exists, so a database migrated here without it is otherwise at head and still refuses
        # every graph read.
        _build_graphver()
    if placed is not None and revision == "heads":
        # Placed by this build: head is claimed only once the schema bears it out.
        was, stamps, kept = placed
        gaps, _defaults, _extras = _compare_schema(create_engine(_sync_url(), pool_pre_ping=True))
        lower = _below_gaps(script, stamps, kept, gaps) if gaps and recover and rewind_to is None else None
        if lower is not None:
            # Migrations of ours it was taken to have run make what's missing: it never ran them.
            # Placed below them, they run (as does what follows them: each is safe to run twice).
            log.warning("Placed at %s, the schema is still short of head: %s. This build's "
                        "migrations that make it were taken as run; placing it at %s and "
                        "upgrading again.", stamps, gaps[:10], lower)
            with create_engine(_sync_url(), pool_pre_ping=True).begin() as conn:
                _set_stamps(conn, lower)
            _upgrade(cfg, revision)
            gaps, _defaults, _extras = _compare_schema(create_engine(_sync_url(), pool_pre_ping=True))
        # Still short: the stamps go back as they were, so the next run fails as loudly.
        if gaps:
            with create_engine(_sync_url(), pool_pre_ping=True).begin() as conn:
                _set_stamps(conn, was)
                migration_records.record_step(conn, was[0], "restored", None, {"gaps": gaps[:10]})
            log.error(
                "Placed at %s, the schema is still not at head — %d mismatch(es), first 10: %s. "
                "alembic_version is back to %s. Name the last revision of this build's the database "
                "ran: `upgrade --rewind-to <revision>`%s.", stamps, len(gaps), gaps[:10], was,
                "" if recover or rewind_to else "; or let this build correct the place from what's "
                "missing: `upgrade --recover`")
            return 1
        with create_engine(_sync_url(), pool_pre_ping=True).begin() as conn:
            migration_records.record_step(conn, min(script.get_heads()), "verified", None)
    if revision == "heads":
        _reconcile_reference_data(script)
    log.info("Upgrade complete")
    return 0


def _reconcile_reference_data(script) -> None:
    """Built-in permissions, roles and grants this database hasn't had yet, added once
    (:func:`reconcile_reference_data`); anything it did is in ``alembic_history`` as ``seeded``."""
    from backend.app.db.seed_reference_data import reconcile_reference_data

    with create_engine(_sync_url(), pool_pre_ping=True).begin() as conn:
        report = reconcile_reference_data(conn)
        if any(report["added"].values()) or report["notGranted"] or report["skipped"]:
            migration_records.ensure(conn)
            migration_records.record_step(conn, min(script.get_heads()), "seeded", None, report)


def cmd_plan(as_json: bool = False, recover: bool = False, shared_database: bool = False,
             rewind_to: str | None = None) -> int:
    """What ``upgrade`` would do to this database now, changing nothing: no lock, no writes.

    The decision is the Job's own (:func:`schema_plan.plan_upgrade`). Exit 0 when it would go
    ahead, or there's nothing to do; 1 when it would refuse."""
    cfg = _alembic_config()
    script = ScriptDirectory.from_config(cfg)
    with _connect(create_engine(_sync_url(), pool_pre_ping=True)) as conn:
        inputs = schema_plan.gather(conn, script, cfg.get_main_option("script_location"))
    plan = schema_plan.plan_upgrade(script, **inputs, built=_built_from(), recover=recover,
                                    shared=shared_database, rewind_to=rewind_to)
    print(json.dumps(plan, indent=2) if as_json else schema_plan.describe(plan))
    return 1 if plan["verdict"] == "refused" else 0


def cmd_backup(directory: str, keep: int = 5, bucket: str | None = None,
               prefix: str = "synodic-db-backups", endpoint_url: str | None = None,
               region: str | None = None, force: bool = False, recover: bool = False,
               shared_database: bool = False) -> int:
    """Back the database up before an upgrade changes it: ``pg_dump`` to ``directory``, checked,
    the newest ``keep`` kept, and copied to ``bucket`` when one is named.

    Only when the upgrade would change something (:func:`schema_plan.plan_upgrade` says
    ``upgrade``), unless ``force``: a deploy with nothing to migrate costs nothing. Exit 0 when the
    backup is made or not needed; 1 when it fails, so a pre-upgrade hook stops the upgrade instead
    of migrating without one."""
    cfg = _alembic_config()
    script = ScriptDirectory.from_config(cfg)
    if not force:
        with _connect(create_engine(_sync_url(), pool_pre_ping=True)) as conn:
            inputs = schema_plan.gather(conn, script, cfg.get_main_option("script_location"))
        plan = schema_plan.plan_upgrade(script, **inputs, built=_built_from(), recover=recover,
                                        shared=shared_database)
        if plan["verdict"] != "upgrade":
            log.info("No backup needed: an upgrade would be %s. %s",
                     plan["verdict"].replace("_", " "), plan["reason"])
            return 0
        log.info("Backing up before the upgrade: %s", plan["reason"])
    try:
        path = _dump(Path(directory), min(script.get_heads()))
        _prune(Path(directory), keep)
        if bucket:
            _upload(path, bucket, prefix, endpoint_url, region)
    except (OSError, RuntimeError) as error:
        log.error("Backup failed: %s", error)
        return 1
    return 0


def _libpq_url() -> str:
    """The database for ``pg_dump``: ``BACKUP_DATABASE_URL`` — a direct connection, where
    ``MANAGEMENT_DB_URL`` goes through a transaction pooler ``pg_dump`` can't use — or
    ``MANAGEMENT_DB_URL``, in libpq's form."""
    url = os.getenv("BACKUP_DATABASE_URL") or os.environ["MANAGEMENT_DB_URL"]
    return re.sub(r"^postgres(?:ql)?\+\w+://", "postgresql://", url)


def _dump(directory: Path, head: str) -> Path:
    """``pg_dump`` in its custom format, written beside its final name and moved there only once
    ``pg_restore`` can read it back."""
    directory.mkdir(parents=True, exist_ok=True)
    for left in directory.glob("*.dump.partial"):           # a run stopped part-way
        left.unlink()
    url = _libpq_url()
    database = re.sub(r"[^\w.-]", "_", url.rsplit("/", 1)[-1].split("?", 1)[0]) or "db"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final = directory / f"{database}-{stamp}-to-{head}.dump"
    partial = final.with_name(final.name + ".partial")
    started = time.monotonic()
    done = subprocess.run(["pg_dump", "--format=custom", f"--file={partial}", f"--dbname={url}"],
                          capture_output=True, text=True, check=False)
    if done.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"pg_dump exited {done.returncode}: {done.stderr.strip()[-500:]}")
    if partial.stat().st_size == 0 or subprocess.run(["pg_restore", "--list", str(partial)],
                                                     capture_output=True, check=False).returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError("pg_dump wrote a file pg_restore can't read")
    partial.rename(final)
    log.info("Backed up to %s (%.1f MB in %.0fs)", final, final.stat().st_size / 1e6,
             time.monotonic() - started)
    return final


def _prune(directory: Path, keep: int) -> None:
    """Keep the newest ``keep`` dumps; their names lead with when they were made."""
    for old in sorted(directory.glob("*.dump"), key=lambda p: p.name.rsplit("-to-", 1)[0])[:-keep or None]:
        old.unlink()
        log.info("Removed the older backup %s", old.name)


def _upload(path: Path, bucket: str, prefix: str, endpoint_url: str | None, region: str | None) -> None:
    """Copy ``path`` to an S3-compatible bucket (GCS through its S3 endpoint, with HMAC keys), with
    the app's client settings: credentials from boto3's chain (``AWS_ACCESS_KEY_ID`` and
    ``AWS_SECRET_ACCESS_KEY``, or a role). Retention is the bucket's lifecycle rule."""
    try:
        import boto3.session
        from botocore.config import Config
    except ImportError as error:
        raise RuntimeError("uploading needs boto3: pip install -r backend/requirements-s3.txt") from error
    client = boto3.session.Session().client("s3", endpoint_url=endpoint_url or None, region_name=region or None,
                                            config=Config(signature_version="s3v4",
                                                          retries={"mode": "standard", "max_attempts": 5},
                                                          request_checksum_calculation="when_required",
                                                          response_checksum_validation="when_required"))
    key = f"{prefix.strip('/')}/{path.name}" if prefix.strip("/") else path.name
    try:
        client.upload_file(str(path), bucket, key)
    except Exception as error:  # boto3 raises many kinds; the message says which
        raise RuntimeError(f"uploading to s3://{bucket}/{key} failed: {error}") from error
    log.info("Copied to s3://%s/%s", bucket, key)


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


def _graphver_tables() -> list:
    """The version store's tables, as its models declare them (the hash partitions of each
    partitioned one are not declared, only the table they partition)."""
    from backend.app.services.versioning.db import VersioningBase
    from backend.app.services.versioning import models as _graphver_models  # noqa: F401

    return list(VersioningBase.metadata.sorted_tables)


def _type_name(column_type, dialect) -> str:
    """A column type as Postgres names it. A ``FLOAT`` with no precision is stored as ``DOUBLE
    PRECISION`` and reflected so: told the same, or every ``Float`` column reads as a mismatch."""
    try:
        name = str(column_type.compile(dialect=dialect))
    except Exception:  # unmappable type — fall back to the class name
        return column_type.__class__.__name__.upper()
    return "DOUBLE PRECISION" if name == "FLOAT" else name


def _compare_schema(engine, graphver: bool = False) -> tuple[list[str], list[str], list[str]]:
    """Compare the live database against ORM metadata — with ``graphver``, the version store's
    tables too (``verify-schema``, where the store lives in this database).

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
        return _type_name(column_type, dialect)

    tables = list(_orm_metadata().sorted_tables) + (_graphver_tables() if graphver else [])
    inspector = sa_inspect(engine)

    failures: list[str] = []
    default_diffs: list[str] = []
    extra_columns: list[str] = []

    for table in tables:
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

    The version store's tables (``graphver``) are held to its models too
    when it lives in this database: ``upgrade`` builds them, and a database
    without them refuses every graph read.
    """
    engine = create_engine(_sync_url(), pool_pre_ping=True)
    graphver = _graphver_here()
    failures, default_diffs, extra_columns = _compare_schema(engine, graphver=graphver)

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
        "tolerated", len(_orm_metadata().sorted_tables) + (len(_graphver_tables()) if graphver else 0),
        len(default_diffs),
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
    # pointers and popping one would silently mis-report the rest. A stamp
    # another build wrote isn't in this chain to walk from.
    foreign = _foreign(script, sorted(applied))
    known = [v for v in applied if v not in foreign]
    lower = tuple(known) if known else "base"
    skipped = [rev.revision for rev in script.iterate_revisions("heads", lower)]
    log.warning(
        "Schema already satisfies head but alembic_version does not. "
        "Marking %d revision(s) applied without running them: %s",
        len(skipped), skipped,
    )
    if foreign:
        # Alembic's own stamp starts from the stamps it reads, and can't from these.
        with engine.begin() as conn:
            _set_stamps(conn, sorted(expected))
            migration_records.record_chain(conn, script)
    else:
        command.stamp(cfg, "heads")
    log.info("Stamped to head: %s", sorted(expected))
    return 0


@_with_advisory_lock
def cmd_downgrade(revision: str) -> int:
    log.warning("Alembic downgrade -> %s (destructive!)", revision)
    command.downgrade(_alembic_config(), revision)
    log.warning("Downgrade complete")
    return 0


def cmd_current() -> int:
    cfg = _alembic_config()
    with create_engine(_sync_url(), pool_pre_ping=True).connect() as conn:
        stamps = _stamps(conn)
    foreign = _foreign(ScriptDirectory.from_config(cfg), stamps)
    if foreign:
        # Alembic's own report can't resolve them, and stops.
        log.warning("alembic_version names %s; this build doesn't have %s. `upgrade` places the "
                    "database on this build's chain first.", stamps, foreign)
        return 0
    command.current(cfg, verbose=True)
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
    up.add_argument(
        "--rewind-to",
        metavar="REV",
        help="A database another build moved on (alembic_version names revisions this build "
             "doesn't have): place it at REV, the last revision of this build's it ran",
    )
    up.add_argument(
        "--recover",
        action="store_true",
        help="A database another build moved on, which no lineage places: estimate where it "
             "stands, and correct the estimate from what the schema lacks. For dev and local "
             "databases; production fails instead, with nothing changed. "
             "Or SYNODIC_UPGRADE_RECOVER=true",
    )
    up.add_argument(
        "--shared-database",
        action="store_true",
        help="Others use this database: migrate it only from a build of a commit on main. "
             "Or SYNODIC_SHARED_DATABASE=true",
    )

    plan = sub.add_parser("plan", help="What `upgrade` would do to this database now, changing nothing")
    plan.add_argument("--json", action="store_true", help="the plan as JSON, on stdout")
    plan.add_argument("--recover", action="store_true", help="as `upgrade --recover` would")
    plan.add_argument("--shared-database", action="store_true", help="as `upgrade --shared-database` would")
    plan.add_argument("--rewind-to", metavar="REV", help="as `upgrade --rewind-to REV` would")

    backup = sub.add_parser("backup", help="pg_dump the database before an upgrade changes it")
    backup.add_argument("--dir", required=True, help="where the dumps go (a volume, to keep them)")
    backup.add_argument("--keep", type=int, default=5, help="how many dumps to keep there (default 5)")
    backup.add_argument("--bucket", help="also copy each dump to this S3-compatible bucket")
    backup.add_argument("--prefix", default="synodic-db-backups", help="key prefix in the bucket")
    backup.add_argument("--endpoint-url", help="the bucket's endpoint, e.g. https://storage.googleapis.com")
    backup.add_argument("--region", help="the bucket's region")
    backup.add_argument("--force", action="store_true",
                        help="back up even when an upgrade would change nothing")
    backup.add_argument("--recover", action="store_true", help="plan as `upgrade --recover` would")
    backup.add_argument("--shared-database", action="store_true",
                        help="plan as `upgrade --shared-database` would")

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
        # Also as variables: a chart newer than its image passes them without breaking it.
        return cmd_upgrade(args.revision, fast_path=not args.no_fast_path, rewind_to=args.rewind_to,
                           recover=args.recover or os.getenv("SYNODIC_UPGRADE_RECOVER") == "true",
                           shared_database=args.shared_database
                           or os.getenv("SYNODIC_SHARED_DATABASE") == "true")
    if args.cmd == "plan":
        return cmd_plan(args.json, recover=args.recover or os.getenv("SYNODIC_UPGRADE_RECOVER") == "true",
                        shared_database=args.shared_database
                        or os.getenv("SYNODIC_SHARED_DATABASE") == "true", rewind_to=args.rewind_to)
    if args.cmd == "backup":
        return cmd_backup(args.dir, keep=args.keep, bucket=args.bucket, prefix=args.prefix,
                          endpoint_url=args.endpoint_url, region=args.region, force=args.force,
                          recover=args.recover or os.getenv("SYNODIC_UPGRADE_RECOVER") == "true",
                          shared_database=args.shared_database
                          or os.getenv("SYNODIC_SHARED_DATABASE") == "true")
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
