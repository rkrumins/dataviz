"""The upgrade Job's plan, reference-data reconciliation and pre-upgrade backup.

* **The plan** (``app/db/schema_plan.plan_upgrade``, ``synodic-upgrade plan``): what an upgrade
  would do, changing nothing — and exactly what the Job then does.
* **Reference data** (``reconcile_reference_data``): built-in permissions, roles and grants added
  to ``rbac_seed`` reach existing databases once; what an admin removed stays removed.
* **The backup** (``synodic-upgrade backup``): only when an upgrade would change something.

The end-to-end cases need Postgres (``GRAPHVER_E2E=1`` and ``MANAGEMENT_DB_URL``); each makes a
database of its own.
"""
import json
import os
import re
import subprocess
import sys
import uuid

import pytest

from backend.app.db import schema_plan
from backend.app.db.engine import _alembic_config


def _script():
    from alembic.script import ScriptDirectory
    return ScriptDirectory.from_config(_alembic_config())


def _plan(stamped, **kw):
    inputs = {"virgin": False, "own": {}, "lines": schema_plan.other_lines(_alembic_config().get_main_option(
        "script_location")), "open_placement": None, "changed": [], "built": ("main at abc", True)}
    inputs.update(kw)
    return schema_plan.plan_upgrade(_script(), stamped=stamped, **inputs)


def test_the_plan_says_what_an_upgrade_would_do():
    script = _script()
    head = script.get_current_head()
    assert _plan([head])["verdict"] == "up_to_date"
    assert _plan([], virgin=True)["verdict"] == "fresh_install"

    behind = _plan(list(script.get_revision(head).down_revision))
    assert behind["verdict"] == "upgrade" and behind["wouldRun"] == [head]

    # #670's stamp: placed exactly, then everything the heads need that it doesn't have.
    placed = _plan(["20261116_1200_graph_watch"])
    assert placed["placement"]["stamps"] == ["20261113_1400_gv_ps_candidate"]
    have = schema_plan.ancestors(script, ["20261113_1400_gv_ps_candidate"])
    assert set(placed["wouldRun"]) == {r.revision for r in script.walk_revisions()} - have
    assert placed["wouldRun"][-1] == head                   # ancestors first

    refused = _plan(["29991231_2359_nowhere"])
    assert refused["verdict"] == "refused" and "--rewind-to" in refused["reason"]
    assert _plan(["29991231_2359_nowhere"], recover=True)["verdict"] == "upgrade"


def test_the_plan_holds_a_shared_database_to_main():
    script = _script()
    behind = list(script.get_revision(script.get_current_head()).down_revision)
    branch = ("claude/x at abc", False)
    assert _plan(behind, shared=True, built=branch)["verdict"] == "refused"
    assert _plan([script.get_current_head()], shared=True, built=branch)["verdict"] == "up_to_date"
    unrecorded = _plan(behind, shared=True, built=("an unrecorded commit", None))
    assert unrecorded["verdict"] == "upgrade" and any("doesn't record" in w for w in unrecorded["warnings"])


E2E = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E") or not os.getenv("MANAGEMENT_DB_URL"),
                         reason="set GRAPHVER_E2E=1 + MANAGEMENT_DB_URL (a live Postgres) to run")


@pytest.fixture
def scratch_db():
    """A database of its own on the same server, dropped after."""
    import psycopg2

    base = os.environ["MANAGEMENT_DB_URL"]
    name = f"upgrade_extras_{uuid.uuid4().hex[:8]}"
    admin = psycopg2.connect(base.replace("postgresql+asyncpg://", "postgresql://"))
    admin.autocommit = True
    admin.cursor().execute(f'CREATE DATABASE "{name}"')
    try:
        yield base.rsplit("/", 1)[0] + "/" + name
    finally:
        admin.cursor().execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.close()


def _job(url, *args, env=None):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return subprocess.run([sys.executable, "-m", "backend.scripts.upgrade", *args], cwd=root,
                          env={**os.environ, "MANAGEMENT_DB_URL": url, **(env or {})},
                          capture_output=True, text=True, timeout=900)


def _sql(url, statement):
    import psycopg2

    conn = psycopg2.connect(url.replace("postgresql+asyncpg://", "postgresql://"))
    conn.autocommit = True
    try:
        cur = conn.cursor()
        cur.execute(statement)
        return cur.fetchall() if cur.description else None
    finally:
        conn.close()


@E2E
def test_the_plan_is_what_the_job_then_does(scratch_db):
    out = _job(scratch_db, "plan", "--json")
    assert out.returncode == 0 and json.loads(out.stdout)["verdict"] == "fresh_install", out.stderr[-2000:]
    assert _job(scratch_db, "upgrade").returncode == 0
    assert json.loads(_job(scratch_db, "plan", "--json").stdout)["verdict"] == "up_to_date"

    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261116_1200_graph_watch'")
    plan = json.loads(_job(scratch_db, "plan", "--json").stdout)
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    assert re.findall(r"Running upgrade .*? -> (\S+), ", out.stderr) == plan["wouldRun"]

    # Refused, with the same exit code the Job would give, and nothing changed.
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '29991231_2359_nowhere'")
    out = _job(scratch_db, "plan")
    assert out.returncode == 1 and "Nothing was changed" in out.stdout, out.stdout[-2000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("29991231_2359_nowhere",)]
