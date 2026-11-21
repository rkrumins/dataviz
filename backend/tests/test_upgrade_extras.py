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


def _behind(script) -> list[str]:
    """The revision(s) just before head: a merge's parents, or a linear head's one parent."""
    down = script.get_revision(script.get_current_head()).down_revision
    return list(down) if isinstance(down, (tuple, list)) else [down]


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

    behind = _plan(_behind(script))
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
    behind = _behind(script)
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
                          capture_output=True, text=True, timeout=900, check=False)


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


def _grants(url, role):
    return {p for (p,) in _sql(url, f"SELECT permission_id FROM role_permissions WHERE role_name = '{role}'")}


@E2E
def test_a_fresh_install_records_every_built_in_entry_as_applied(scratch_db):
    from backend.app.config.rbac_seed import PERMISSIONS, ROLE_GRANTS, SYSTEM_ROLES

    assert _job(scratch_db, "upgrade").returncode == 0
    counts = dict(_sql(scratch_db, "SELECT kind, count(*) FROM reference_data_applied GROUP BY kind"))
    assert counts == {"permission": len(PERMISSIONS), "role": len(SYSTEM_ROLES), "grant": len(ROLE_GRANTS)}
    assert _sql(scratch_db, "SELECT count(*) FROM alembic_history WHERE kind = 'seeded'") == [(0,)]


@E2E
def test_built_in_entries_reach_an_existing_database_once_and_an_admins_removal_stays(scratch_db):
    assert _job(scratch_db, "upgrade").returncode == 0
    # A database from before the record: no record, a built-in permission it never had (with its
    # grants), and a grant an admin removed from a built-in role.
    _sql(scratch_db, "DROP TABLE reference_data_applied")
    _sql(scratch_db, "DELETE FROM permissions WHERE id = 'workspace:native-query:read'")     # cascades
    _sql(scratch_db, "DELETE FROM role_permissions WHERE role_name = 'org_auditor' "
                     "AND permission_id = 'system:audit:read'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    # The permission it never had, and its grants: new in this run, so added.
    assert "workspace:native-query:read" in _grants(scratch_db, "workspace_viewer")
    # The removed grant can't be told from one never made: left out, and reported.
    assert "system:audit:read" not in _grants(scratch_db, "org_auditor")
    assert "org_auditor:system:audit:read" in out.stderr
    [(detail,)] = _sql(scratch_db, "SELECT detail FROM alembic_history WHERE kind = 'seeded'")
    report = json.loads(detail)
    assert report["first"] and report["added"]["permissions"] == ["workspace:native-query:read"]
    assert report["notGranted"] == ["org_auditor:system:audit:read"]

    # A built-in grant added to the code after that (unrecorded here, and missing): added once.
    _sql(scratch_db, "DELETE FROM reference_data_applied WHERE key = 'workspace_viewer:workspace:native-query:read'")
    _sql(scratch_db, "DELETE FROM role_permissions WHERE role_name = 'workspace_viewer' "
                     "AND permission_id = 'workspace:native-query:read'")
    assert _job(scratch_db, "upgrade").returncode == 0
    assert "workspace:native-query:read" in _grants(scratch_db, "workspace_viewer")

    # An admin removes it again: recorded, so it stays removed, upgrade after upgrade.
    _sql(scratch_db, "DELETE FROM role_permissions WHERE role_name = 'workspace_viewer' "
                     "AND permission_id = 'workspace:native-query:read'")
    for _ in range(2):
        assert _job(scratch_db, "upgrade").returncode == 0
    assert "workspace:native-query:read" not in _grants(scratch_db, "workspace_viewer")


@E2E
def test_a_backup_is_made_only_when_an_upgrade_would_change_something(scratch_db, tmp_path):
    script = _script()
    head = script.get_current_head()
    assert _job(scratch_db, "upgrade").returncode == 0
    out = _job(scratch_db, "backup", "--dir", str(tmp_path))
    assert out.returncode == 0 and "No backup needed" in out.stderr, out.stderr[-2000:]
    assert list(tmp_path.iterdir()) == []

    # Behind its head: dumped, readable, named for where the upgrade takes it.
    _sql(scratch_db, f"UPDATE alembic_version SET version_num = '{min(script.get_revision(head).down_revision)}'")
    _sql(scratch_db, "INSERT INTO alembic_version VALUES ('20261119_1300_merge_member_sets')")
    out = _job(scratch_db, "backup", "--dir", str(tmp_path), "--keep", "2")
    assert out.returncode == 0, out.stderr[-2000:]
    [dump] = list(tmp_path.glob("*.dump"))
    assert dump.name.endswith(f"-to-{head}.dump") and dump.stat().st_size > 0
    assert subprocess.run(["pg_restore", "--list", str(dump)], capture_output=True, check=False).returncode == 0

    # Forced, at any time; the newest two kept.
    for _ in range(2):
        assert _job(scratch_db, "backup", "--dir", str(tmp_path), "--keep", "2", "--force").returncode == 0
    dumps = sorted(p.name for p in tmp_path.glob("*.dump"))
    assert len(dumps) == 2 and dump.name not in dumps
    assert not list(tmp_path.glob("*.partial"))


@E2E
def test_a_backup_that_fails_says_so_and_leaves_nothing_half_written(scratch_db, tmp_path):
    assert _job(scratch_db, "upgrade").returncode == 0
    out = _job(scratch_db, "backup", "--dir", str(tmp_path), "--force",
               env={"BACKUP_DATABASE_URL": scratch_db.rsplit("/", 1)[0] + "/no_such_database"})
    assert out.returncode == 1 and "Backup failed: pg_dump exited" in out.stderr, out.stderr[-2000:]
    assert list(tmp_path.iterdir()) == []


def test_a_backup_is_copied_to_the_bucket(tmp_path, monkeypatch):
    import types

    from backend.scripts import upgrade

    sent = {}

    class Client:
        def upload_file(self, filename, bucket, key):
            sent.update(filename=filename, bucket=bucket, key=key)

    session = types.SimpleNamespace(Session=lambda: types.SimpleNamespace(client=lambda *a, **kw: (
        sent.update(endpoint=kw["endpoint_url"], checksums=kw["config"].request_checksum_calculation), Client())[1]))
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(session=session))
    monkeypatch.setitem(sys.modules, "boto3.session", session)
    monkeypatch.setitem(sys.modules, "botocore", types.SimpleNamespace())
    monkeypatch.setitem(sys.modules, "botocore.config", types.SimpleNamespace(
        Config=lambda **kw: types.SimpleNamespace(**kw)))
    dump = tmp_path / "synodic-20261118T200000Z-to-head.dump"
    dump.write_bytes(b"x")
    upgrade._upload(dump, "backups", "/synodic-db-backups/", "https://storage.googleapis.com", None)
    assert sent == {"endpoint": "https://storage.googleapis.com", "checksums": "when_required",
                    "filename": str(dump), "bucket": "backups", "key": f"synodic-db-backups/{dump.name}"}


@E2E
def test_the_admin_schema_status_reads_the_database_live(scratch_db, monkeypatch):
    from backend.app.services.system_status.schema import schema_status

    script = _script()
    head = script.get_current_head()
    assert _job(scratch_db, "upgrade").returncode == 0
    monkeypatch.setenv("MANAGEMENT_DB_URL", scratch_db)
    status = schema_status()
    assert status["atHead"] and status["applied"] == [head] and status["plan"]["verdict"] == "up_to_date"
    assert {"stamped", "ran"} & {h["kind"] for h in status["history"]}

    # Another build's stamp: shown, with where the upgrade would place it and what it would run.
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261116_1200_graph_watch'")
    status = schema_status()
    assert not status["atHead"] and status["plan"]["placement"]["stamps"] == ["20261113_1400_gv_ps_candidate"]
    assert status["plan"]["wouldRun"][-1] == head
