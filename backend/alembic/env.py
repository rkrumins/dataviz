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
