"""Alembic environment for Synodic — Postgres v16 only.

Resolves `MANAGEMENT_DB_URL` (asyncpg form) and rewrites it to its sync
equivalent (`postgresql+psycopg2://`) because Alembic itself runs sync.
The application keeps using asyncpg at runtime — this only affects the
migration tool.

Falls back to the dev credentials provisioned by `docker-compose.dev.yml`
when no env var is set, so a clone-and-run dev workflow stays one
command away.
"""
from __future__ import annotations

import logging
import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# ---------------------------------------------------------------------------
# Make the backend package importable regardless of where alembic was invoked.
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent           # backend/alembic
BACKEND_DIR = HERE.parent                        # backend
REPO_ROOT = BACKEND_DIR.parent                   # repo root
for path in (REPO_ROOT, BACKEND_DIR):
    p = str(path)
    if p not in sys.path:
        sys.path.insert(0, p)

# ---------------------------------------------------------------------------
# Import every ORM module so Base.metadata is fully populated. Add new
# domain modules here as they are introduced.
# ---------------------------------------------------------------------------
from backend.app.db.engine import Base  # noqa: E402  — Base is the metadata target
from backend.app.db import models as _management_models  # noqa: E402,F401
from backend.app.services.aggregation import models as _aggregation_models  # noqa: E402,F401

target_metadata = Base.metadata

config = context.config
if config.config_file_name is not None:
    # `disable_existing_loggers=False` is critical: when `init_db()` retries
    # this env module (Postgres not yet reachable at boot), the first run's
    # fileConfig would otherwise silence every logger already set up by the
    # app — including `backend.app.db.engine`'s own retry-warning logger.
    fileConfig(config.config_file_name, disable_existing_loggers=False)
logger = logging.getLogger("alembic.env")


_DEV_FALLBACK_URL = "postgresql+asyncpg://synodic:synodic@localhost:5432/synodic"
_ASYNC_PREFIX = "postgresql+asyncpg://"
_SYNC_PREFIX = "postgresql+psycopg2://"


def _resolve_async_url() -> str:
    url = os.getenv("MANAGEMENT_DB_URL", _DEV_FALLBACK_URL)
    if not url.startswith(_ASYNC_PREFIX):
        raise RuntimeError(
            f"Synodic requires Postgres v16+ via asyncpg. MANAGEMENT_DB_URL "
            f"must start with '{_ASYNC_PREFIX}' (got: {url[:30]!r})."
        )
    return url


def _to_sync_url(async_url: str) -> str:
    return _SYNC_PREFIX + async_url[len(_ASYNC_PREFIX):]


SYNC_DB_URL = _to_sync_url(_resolve_async_url())
config.set_main_option("sqlalchemy.url", SYNC_DB_URL)
logger.info("Alembic resolved DB URL: %s", SYNC_DB_URL.split("@")[-1])  # creds redacted


def run_migrations_offline() -> None:
    """Generate SQL without a live DB connection."""
    context.configure(
        url=SYNC_DB_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _ensure_wide_alembic_version_column(connection) -> None:
    """Ensure ``alembic_version.version_num`` can hold long revision ids.

    Alembic creates this column as ``VARCHAR(32)`` by default. A revision
    id longer than 32 chars causes a ``StringDataRightTruncation`` on the
    post-migration ``UPDATE alembic_version``, silently rolling back the
    migration that just ran. This is exactly the trap the
    ``20260527_1200_sso_phase4`` docstring describes.

    The primary defence is the ≤32-char contract enforced by
    ``tests/test_alembic_revision_lengths.py`` (over-length ids are
    renamed to fit). This function is the safety net, and it must cover
    the FRESH-INSTALL case too:

    An earlier version of this bailed out when the table was absent —
    "fresh DB, alembic will create it, we re-run on next boot". That
    reasoning is wrong, and it is why a brand-new environment could not
    be built at all. On a fresh database alembic creates the table
    ITSELF, mid-run, at the default VARCHAR(32); there is no "next boot"
    because the very first ``upgrade head`` is what fails. So a fresh
    install got no protection from the widen, and a long id at the head
    of the chain rolled the entire upgrade back — every table with it.

    Creating the table up-front at VARCHAR(128) closes that hole:
    alembic's own ``_ensure_version_table`` issues a ``checkfirst``
    CREATE, so it adopts ours instead of making a narrow one. An empty
    ``alembic_version`` reads as "no revision applied" — identical to no
    table at all — so the chain still runs from base. Column shape and PK
    name (``alembic_version_pkc``) are exactly alembic's, so nothing
    downstream can tell the difference.
    """
    from sqlalchemy import inspect as sa_inspect, text

    inspector = sa_inspect(connection)
    if not inspector.has_table("alembic_version"):
        connection.execute(text(
            "CREATE TABLE alembic_version ("
            "version_num VARCHAR(128) NOT NULL, "
            "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
        ))
        connection.commit()
        return
    cols = {c["name"]: c for c in inspector.get_columns("alembic_version")}
    col = cols.get("version_num")
    if col is None:
        return
    # SQLAlchemy reports the length on the type object for VARCHAR.
    current_len = getattr(col["type"], "length", None)
    if current_len is not None and current_len >= 128:
        return
    logger.info(
        "Widening alembic_version.version_num from VARCHAR(%s) to VARCHAR(128) "
        "so long revision ids don't truncate.", current_len,
    )
    connection.execute(text(
        "ALTER TABLE alembic_version "
        "ALTER COLUMN version_num TYPE VARCHAR(128)"
    ))
    connection.commit()


def _translate_renamed_alembic_version(connection) -> None:
    """Map a stamped OLD revision id onto its current one.

    Three revisions were renamed to fit the 32-char ``version_num``
    column. A database stamped with the old id cannot resolve it, so it
    is rewritten here before Alembic reads the chain.

    This function used to do a second thing: any revision it could not
    find on disk at all, it stamped back to ``0001_baseline``. That was
    the single most destructive line in the migration path. It never
    touched the schema, so the "recovery" was to replay ~70 revisions
    over a fully-populated production database — and since
    ``0001_baseline`` is ``create_all`` of the live ORM, the replay was
    guaranteed to hit an ``ALTER`` for something already present and die
    partway through, leaving the pointer somewhere in the middle.

    An unresolvable revision means the database was migrated by code
    newer than this image, or by a branch this image does not have.
    Neither is repairable by guessing, and both are made worse by
    replaying. So it now raises and names the fix.
    """
    from sqlalchemy import inspect as sa_inspect, text
    from alembic.script import ScriptDirectory

    inspector = sa_inspect(connection)
    if not inspector.has_table("alembic_version"):
        return  # Fresh database — nothing to reset

    row = connection.execute(text("SELECT version_num FROM alembic_version")).fetchone()
    if row is None:
        return  # Table exists but empty

    current_version = row[0]

    # Renamed revisions: translate a stamped OLD id to its new id before
    # the resolvability check below, so a database stamped with the old id
    # (possible wherever the widen above ran before the rename shipped)
    # resolves normally instead of being treated as unknown.
    _RENAMED_REVISIONS = {
        # 34 chars — over the default VARCHAR(32); shortened 2026-07-10.
        "20260707_1400_view_layout_overlays": "20260707_1400_view_layout_ovl",
        # 40 chars — over the default VARCHAR(32); shortened 2026-07-12.
        # Databases whose version_num had already been widened to 128 (see
        # _ensure_wide_alembic_version_column) DID record the long id, so they
        # must be translated rather than reset to baseline.
        "20260712_1730_view_activity_data_changed": "20260712_1730_val_data_changed",
        # 38 chars — over the default VARCHAR(32); shortened 2026-07-21.
        "20260719_1200_rebrand_default_branding": "20260719_1200_rebrand_branding",
    }
    renamed_to = _RENAMED_REVISIONS.get(current_version)
    if renamed_to:
        logger.info(
            "Translating renamed alembic revision '%s' -> '%s'.",
            current_version, renamed_to,
        )
        connection.execute(text(
            "UPDATE alembic_version SET version_num = :new"
        ), {"new": renamed_to})
        connection.commit()
        current_version = renamed_to

    script = ScriptDirectory.from_config(config)
    try:
        script.get_revision(current_version)
        return  # Revision is in the on-disk chain — nothing to fix.
    except Exception as exc:
        # ScriptDirectory raises ResolutionError (a subclass of
        # CommandError) for unknown revisions. Catch broadly because the
        # exact exception type varies across alembic versions.
        raise RuntimeError(
            f"alembic_version records '{current_version}', which this image's "
            "migration chain does not contain. That means the database was "
            "migrated by newer code, or by a branch this image was not built "
            "from — deploy the image that owns that revision. Do NOT stamp "
            "back to a baseline: the schema would be left untouched and the "
            "whole chain would replay over live data. If the schema really is "
            "at head and only the pointer is wrong, run "
            "`synodic-upgrade repair`, which verifies that before stamping."
        ) from exc


def run_migrations_online() -> None:
    """Apply migrations against a live Postgres.

    ``connect_args['connect_timeout']`` is the psycopg2 TCP deadline. Without
    it, a Postgres that's down or behind a filtered port hangs the process
    on the kernel's default ~75s SYN timeout — the exact symptom we hit
    pre-fix. Retry backoff around this call lives in
    `backend.app.db.engine.init_db` so dev startup tolerates a Postgres
    that comes up a few seconds late.
    """
    connect_timeout = int(os.getenv("DB_CONNECT_TIMEOUT_SECS", "5"))
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args={"connect_timeout": connect_timeout},
    )
    with connectable.connect() as connection:
        # Size version_num BEFORE the migration body runs — otherwise
        # alembic's own UPDATE alembic_version at the end of a long-id
        # revision crashes with StringDataRightTruncation and silently
        # rolls back the migration. Creates the table on a fresh DB so
        # the safety net covers new installs, not just migrated ones.
        _ensure_wide_alembic_version_column(connection)
        # Resolve renamed revision ids BEFORE Alembic reads the chain,
        # and fail loudly on one that cannot be resolved at all.
        _translate_renamed_alembic_version(connection)

        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()
        # SQLAlchemy 2.0: explicit commit required when not using engine.begin().
        # Without this the alembic_version row write rolls back on close.
        connection.commit()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
