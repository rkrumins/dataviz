"""The database schema, as the super-admin Infrastructure page shows it.

Where the database stands against this server's migration chain, what an upgrade with this build
would do (the upgrade Job's own decision, ``app/db/schema_plan.py``), and what upgrades have done
to it (``alembic_history``: each migration run or stamped, each placement and its check, each
changed migration reported, each reference-data reconciliation).

Read live on each call, not from the startup snapshot ``engine.get_schema_state`` keeps: the page
is opened to find out what is true now. Sync (Alembic's script directory, a psycopg2 connection),
so the endpoint runs it in a worker thread.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

HISTORY_ROWS = 50


def schema_status() -> dict:
    from alembic.script import ScriptDirectory
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.pool import NullPool

    from backend.app.db import migration_records, schema_plan
    from backend.app.db.engine import _alembic_config

    cfg = _alembic_config()
    script = ScriptDirectory.from_config(cfg)
    engine = create_engine(os.environ["MANAGEMENT_DB_URL"].replace("+asyncpg", "+psycopg2"),
                           poolclass=NullPool, connect_args={"connect_timeout": 5})
    try:
        with engine.connect() as conn:
            inputs = schema_plan.gather(conn, script, cfg.get_main_option("script_location"))
            history = []
            if inspect(conn).has_table(migration_records.HISTORY):
                history = [
                    {"id": row.id, "revision": row.revision, "kind": row.kind,
                     "at": row.at.isoformat() if row.at else None, "build": row.build,
                     "detail": json.loads(row.detail) if row.detail else None}
                    for row in conn.execute(text(
                        f"SELECT id, revision, kind, at, build, detail FROM {migration_records.HISTORY} "
                        f"ORDER BY id DESC LIMIT {HISTORY_ROWS}"))]
    finally:
        engine.dispose()
    where, on_main = schema_plan.built_from()
    plan = schema_plan.plan_upgrade(script, **inputs, built=(where, on_main))
    expected = sorted(script.get_heads())
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "applied": inputs["stamped"],
        "expected": expected,
        "atHead": inputs["stamped"] == expected,
        "build": {"from": where, "onMain": on_main},
        "plan": plan,
        "history": history,
        "lastSeeded": next((h for h in history if h["kind"] == "seeded"), None),
    }
