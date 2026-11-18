"""A database another build moved on — another branch's, deployed to the same environment, or a
newer release's before a rollback — upgrades with this one (``scripts/upgrade.py``).

* **Where the chains parted** (no database): a stamp of another line of work parts at the newest
  revision of ours older than it, walked in chain order; a newer release's, at our head; one older
  than all of ours, nowhere.
* **The upgrade job** (needs Postgres: ``GRAPHVER_E2E=1`` and ``MANAGEMENT_DB_URL``), on a scratch
  database of its own:
  - stamped with another branch's revision, it is rewound, upgraded to head, and passes ``check``;
  - the other branch's columns are left as they are;
  - when the schema still isn't at head after the rewind, the stamps go back as they were and the
    job fails, so it can't pass on a later run either;
  - a side branch that parted earlier than the guess (some of this build's migrations written
    while it was open, and never run there): the guess fails safely as above, and naming the
    revision both share (``--rewind-to``) upgrades it.
"""
import os
import subprocess
import sys
import uuid

import pytest

from backend.app.db.engine import _alembic_config
from backend.scripts import upgrade


def _script():
    from alembic.script import ScriptDirectory
    return ScriptDirectory.from_config(_alembic_config())


#: Revisions another line of work (PR #670) wrote on top of ``20261113_0900_gv_import_mentions``.
OTHER_LINE = ["20261113_1000_gv_ps_served_fill", "20261113_1100_build_policy", "20261113_1200_gv_ps_window_rows",
              "20261113_1300_gv_ps_read_mode", "20261113_1400_gv_ps_candidate", "20261116_1000_setting_values",
              "20261116_1100_settings_import", "20261116_1200_graph_watch"]


def test_where_the_chains_parted():
    script = _script()
    head = script.get_current_head()
    for rev in OTHER_LINE:
        assert upgrade._foreign(script, [rev, head]) == [rev]
        assert upgrade._parting_point(script, [rev]) == "20261113_0900_gv_import_mentions", rev
    # A newer release's: nothing of ours left to run.
    assert upgrade._parting_point(script, ["29991231_2359_from_the_future"]) == head
    # Older than everything of ours: nowhere to rewind to.
    assert upgrade._parting_point(script, ["0000_before_it_all"]) is None
    assert upgrade._foreign(script, [head]) == []


E2E = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E") or not os.getenv("MANAGEMENT_DB_URL"),
                         reason="set GRAPHVER_E2E=1 + MANAGEMENT_DB_URL (a live Postgres) to run")


@pytest.fixture
def scratch_db():
    """A database of its own on the same server, dropped after."""
    import psycopg2

    base = os.environ["MANAGEMENT_DB_URL"]
    name = f"upgrade_foreign_{uuid.uuid4().hex[:8]}"
    admin = psycopg2.connect(base.replace("postgresql+asyncpg://", "postgresql://"))
    admin.autocommit = True
    admin.cursor().execute(f'CREATE DATABASE "{name}"')
    try:
        yield base.rsplit("/", 1)[0] + "/" + name
    finally:
        admin.cursor().execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.close()


def _job(url, *args):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return subprocess.run([sys.executable, "-m", "backend.scripts.upgrade", *args], cwd=root,
                          env={**os.environ, "MANAGEMENT_DB_URL": url}, capture_output=True, text=True, timeout=900)


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
def test_another_branchs_database_upgrades_with_this_build(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # Another branch moved it on: its stamp, and a column of its own.
    _sql(scratch_db, "ALTER TABLE workspaces ADD COLUMN gv_build_policy text")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261113_1400_gv_ps_candidate'")
    assert _job(scratch_db, "check").returncode == 1

    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    assert "Rewinding to 20261113_0900_gv_import_mentions" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]
    assert _job(scratch_db, "check").returncode == 0
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_name = 'workspaces' AND column_name = 'gv_build_policy'") == [(1,)]


@E2E
def test_a_rewind_that_leaves_the_schema_short_puts_the_stamps_back(scratch_db):
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # A newer release's stamp parts at our head, so nothing runs — and a column of ours is missing.
    _sql(scratch_db, "ALTER TABLE workspaces DROP COLUMN review_threads_hold")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '29991231_2359_from_the_future'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 1, out.stderr[-3000:]
    assert "still not at head" in out.stderr
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("29991231_2359_from_the_future",)]


@E2E
def test_a_branch_that_parted_earlier_than_the_guess_upgrades_once_its_parting_is_named(scratch_db):
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # It parted at 20261117_1500 and never ran 20261118_1100_review_rules (one of its columns);
    # its own revision is dated after that one, so the guess takes review_rules as run.
    _sql(scratch_db, "ALTER TABLE workspaces DROP COLUMN review_threads_hold")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261118_1200_elsewhere'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 1 and "--rewind-to" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("20261118_1200_elsewhere",)]

    out = _job(scratch_db, "upgrade", "--rewind-to", "20261117_1500_gv_mr_sendback")
    assert out.returncode == 0, out.stderr[-3000:]
    assert "as named (--rewind-to)" in out.stderr
    assert _job(scratch_db, "check").returncode == 0
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_name = 'workspaces' AND column_name = 'review_threads_hold'") == [(1,)]
