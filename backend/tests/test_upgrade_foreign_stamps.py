"""A database another build moved on — another branch's, deployed to the same environment, or a
newer release's before a rollback — upgrades with this one (``scripts/upgrade.py``).

* **Exactly where a database stands** (no database): a stamp ``alembic/other_lines.json`` records
  is placed at the last revisions of ours its lineage ran — what every recorded way it came about
  shares — beside any of ours still stamped.
* **Where the chains parted**, for a stamp nothing records: the newest revision of ours from an
  earlier minute than it, walked in chain order; a newer release's, at our head; one older than all
  of ours, nowhere.
* **The upgrade job** (needs Postgres: ``GRAPHVER_E2E=1`` and ``MANAGEMENT_DB_URL``), on a scratch
  database of its own:
  - stamped with another branch's revision, it is placed, upgraded to head, and passes ``check``;
  - placed exactly where the guess would be wrong;
  - stamped with a merge revision made by hand, which no commit has (a dev database's);
  - the other branch's columns are left as they are;
  - every build that migrates a database writes its chain into it (``alembic_lineage``), and a
    stamp only that lineage has — a merge revision made by hand, say — is placed exactly from it;
  - a stamp no lineage places is refused, with nothing changed, unless ``--recover`` (dev); then a
    side branch that parted earlier than the guess (some of this build's migrations written while
    it was open, and never run there) is placed below what the schema left short names, and
    upgraded again; ``--rewind-to`` still names a place outright;
  - when the schema still isn't at head and nothing of ours run again would bring it, the stamps go
    back as they were and the job fails, so it can't pass on a later run either;
  - a job stopped between placing a database and checking its schema leaves the placement open in
    ``alembic_history``, and the next one checks it;
  - each migration that runs is recorded with a checksum of its file, and a file changed since it
    ran is reported once;
  - a migration that gives up waiting for a lock is tried again, and the upgrade completes;
  - on a shared database, a build recorded as not from main is refused unless there's nothing to
    run, and one that records nothing is let through with a warning;
  - ``repair`` and ``current`` work on a database stamped with another build's revision.
"""
import os
import re
import subprocess
import sys
import uuid

import pytest

from backend.app.db.engine import _alembic_config
from backend.scripts import upgrade


def _script():
    from alembic.script import ScriptDirectory
    return ScriptDirectory.from_config(_alembic_config())


#: PR #670's line, off ``20261113_0900_gv_import_mentions``: its first five revisions are main's
#: too (``20261119_1400_merge_ps_build`` joins them), so a database #670's build moved to one of
#: them upgrades with no rewind; its later ones are not.
ADOPTED = ["20261113_1000_gv_ps_served_fill", "20261113_1100_build_policy", "20261113_1200_gv_ps_window_rows",
           "20261113_1300_gv_ps_read_mode", "20261113_1400_gv_ps_candidate"]
OTHER_LINE = ["20261116_1000_setting_values", "20261116_1100_settings_import", "20261116_1200_graph_watch"]


def test_where_the_chains_parted():
    script = _script()
    head = script.get_current_head()
    assert upgrade._foreign(script, [*ADOPTED, head]) == []
    for rev in OTHER_LINE:
        assert upgrade._foreign(script, [rev, head]) == [rev]
        assert upgrade._parting_point(script, [rev]) == "20261113_1400_gv_ps_candidate", rev
    # A newer release's: nothing of ours left to run.
    assert upgrade._parting_point(script, ["29991231_2359_from_the_future"]) == head
    # Older than everything of ours: nowhere to rewind to.
    assert upgrade._parting_point(script, ["0000_before_it_all"]) is None
    assert upgrade._foreign(script, [head]) == []
    # A dev database's merge revision, made by hand while main had two heads: ours from the same
    # minute (20261119_1200_gv_review_seen) may be newer, so it counts as not run.
    assert upgrade._parting_point(script, ["20261119_1200_merge_members_set"]) == "20261119_1100_gv_change_sets"


def test_a_recorded_stamp_is_placed_exactly():
    script, lines = _script(), upgrade._other_lines(_alembic_config())
    head = script.get_current_head()
    for stamp, placed in [
        ("20261116_1200_graph_watch", ["20261113_1400_gv_ps_candidate"]),      # #670's
        ("20261116_1100_settings_import", ["20261113_1400_gv_ps_candidate"]),  # #668's
        ("20261105_1000_import_results", ["20261103_1200_subset_views"]),      # #644's
        # #556's, where the guess says 20261018_1100_gv_ps_retired: its branch put it later.
        ("20261018_1200_change_check_secs", ["20261020_1000_ds_transfers"]),
    ]:
        assert upgrade._placed(script, lines, [stamp], []) == placed, stamp
    assert upgrade._parting_point(script, ["20261018_1200_change_check_secs"]) == "20261018_1100_gv_ps_retired"
    # One of ours stamped beside it that already ran past it stays the place.
    assert upgrade._placed(script, lines, ["20261116_1200_graph_watch"], [head]) == [head]
    # Dev's, recorded by hand both ways it can have come about: what both ran.
    assert upgrade._placed(script, lines, ["20261119_1200_merge_members_set"], []) == [
        "20261118_1000_member_sets", "20261119_1100_gv_change_sets"]
    # Nothing records it: no exact place.
    assert upgrade._placed(script, lines, ["20261119_1250_nowhere"], []) is None


def test_a_schema_left_short_places_it_below_the_migrations_that_make_what_is_missing():
    script = _script()
    head = script.get_current_head()
    gap = ["missing column public.workspaces.review_threads_hold"]      # 20261118_1100_review_rules's
    assert upgrade._below_gaps(script, ["20261118_1100_review_rules"], [], gap) == ["20261118_1000_gv_review_records"]
    # Below it on every line it's on, and nothing else moved.
    assert upgrade._below_gaps(script, [head], [], gap) == [
        "20261113_1400_gv_ps_candidate", "20261118_1000_gv_review_records", "20261118_1100_view_members"]
    # Ours it had stamped itself are trusted, not searched.
    assert upgrade._below_gaps(script, [head], [head], gap) is None
    # Made by create_all alone, by no migration: nothing of ours run again would bring it.
    assert upgrade._below_gaps(script, [head], [], ["missing column public.announcements.cta_text"]) is None


def test_placing_walks_the_lineage_down_to_this_chain():
    script = _script()
    lines = {
        "x1": [["20261117_1500_gv_mr_sendback"]], "x2": [["x1"]],
        # Two ways it came about: only what both ran counts as run.
        "y": [["20261118_1100_review_rules"], ["20261117_1500_gv_mr_sendback"]],
        "m": [["20261119_1100_gv_change_sets", "20261118_1000_member_sets"]],
        "z": [["nowhere"]],
    }
    assert upgrade._placed(script, lines, ["x2"], []) == ["20261117_1500_gv_mr_sendback"]
    assert upgrade._placed(script, lines, ["y"], []) == ["20261117_1500_gv_mr_sendback"]
    assert upgrade._placed(script, lines, ["m"], []) == ["20261118_1000_member_sets", "20261119_1100_gv_change_sets"]
    assert upgrade._placed(script, lines, ["x2", "m"], []) == ["20261118_1000_member_sets", "20261119_1100_gv_change_sets"]
    assert upgrade._placed(script, lines, ["z"], []) is None


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
def test_another_branchs_database_upgrades_with_this_build(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # Another branch moved it on: its stamp, and a column of its own.
    _sql(scratch_db, "ALTER TABLE workspaces ADD COLUMN other_line_column text")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261116_1200_graph_watch'")
    assert _job(scratch_db, "check").returncode == 1

    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    assert "Placing it at ['20261113_1400_gv_ps_candidate'], exactly" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]
    assert _job(scratch_db, "check").returncode == 0
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_name = 'workspaces' AND column_name = 'other_line_column'") == [(1,)]


@E2E
def test_a_rewind_that_leaves_the_schema_short_puts_the_stamps_back(scratch_db):
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # A newer release's stamp parts at our head, so nothing runs — and a column is missing that
    # only create_all makes, so nothing of ours run again brings it back.
    _sql(scratch_db, "ALTER TABLE announcements DROP COLUMN cta_text")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '29991231_2359_from_the_future'")
    # No lineage places it: refused, with nothing changed.
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 1 and "Nothing was changed" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("29991231_2359_from_the_future",)]
    out = _job(scratch_db, "upgrade", env={"SYNODIC_UPGRADE_RECOVER": "true"})
    assert out.returncode == 1, out.stderr[-3000:]
    assert "still not at head" in out.stderr
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("29991231_2359_from_the_future",)]


@E2E
def test_a_branch_that_parted_earlier_than_the_guess_recovers(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # It parted at 20261117_1500 and never ran 20261118_1100_review_rules (one of its columns);
    # its own revision is dated after that one, so the guess takes review_rules as run.
    _sql(scratch_db, "ALTER TABLE workspaces DROP COLUMN review_threads_hold")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261118_1200_elsewhere'")
    out = _job(scratch_db, "upgrade", "--recover")
    assert out.returncode == 0, out.stderr[-3000:]
    assert "placing it at ['20261118_1000_gv_review_records'] and upgrading again" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]
    assert _job(scratch_db, "check").returncode == 0
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_name = 'workspaces' AND column_name = 'review_threads_hold'") == [(1,)]

    # Named outright, the place is taken as given.
    _sql(scratch_db, "ALTER TABLE workspaces DROP COLUMN review_threads_hold")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261118_1200_elsewhere'")
    out = _job(scratch_db, "upgrade", "--rewind-to", "20261117_1500_gv_mr_sendback")
    assert out.returncode == 0, out.stderr[-3000:]
    assert "as named (--rewind-to)" in out.stderr
    assert _job(scratch_db, "check").returncode == 0
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_name = 'workspaces' AND column_name = 'review_threads_hold'") == [(1,)]


@E2E
def test_a_recorded_stamp_is_placed_where_its_branch_put_it(scratch_db):
    script = _script()
    head = script.get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261018_1200_change_check_secs'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    assert "Placing it at ['20261020_1000_ds_transfers'], exactly" in out.stderr, out.stderr[-3000:]
    # Exactly the revisions of ours it lacks, each once.
    ran = re.findall(r"Running upgrade .*? -> (\S+), ", out.stderr)
    lacks = {r.revision for r in script.walk_revisions()} - {
        r.revision for r in script.iterate_revisions("20261020_1000_ds_transfers", "base")}
    assert sorted(ran) == sorted(lacks)
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]


@E2E
def test_a_hand_made_merge_revision_upgrades(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261119_1200_merge_members_set'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    # Recorded by hand both ways it can have come about: placed at what both ran, by default.
    assert ("Placing it at ['20261118_1000_member_sets', '20261119_1100_gv_change_sets'], exactly"
            in out.stderr), out.stderr[-3000:]
    assert "Running upgrade 20261119_1100_gv_change_sets -> 20261119_1200_gv_review_seen" in out.stderr
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]
    assert _job(scratch_db, "check").returncode == 0


@E2E
def test_repair_and_current_work_on_another_builds_stamp(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261119_1200_merge_members_set'")
    out = _job(scratch_db, "current")
    assert out.returncode == 0 and "20261119_1200_merge_members_set" in out.stderr, out.stderr[-2000:]
    out = _job(scratch_db, "repair")
    assert out.returncode == 0, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]


@E2E
def test_a_database_keeps_the_lineage_of_every_build_that_migrated_it(scratch_db):
    script = _script()
    head = script.get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    assert f"its migration chain ends at ['{head}']" in out.stderr
    rows = dict(_sql(scratch_db, "SELECT revision, parents FROM alembic_lineage"))
    assert len(rows) == len(list(script.walk_revisions()))
    assert rows[head] == ",".join(sorted(script.get_revision(head).down_revision))

    # A build with a merge revision made by hand moved it on, and wrote its chain as it did:
    # no file or git ref has the revision, the database does.
    _sql(scratch_db, "INSERT INTO alembic_lineage VALUES "
                     "('20261119_1250_hand_merge', '20261118_1000_member_sets,20261119_1100_gv_change_sets')")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261119_1250_hand_merge'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    assert ("Placing it at ['20261118_1000_member_sets', '20261119_1100_gv_change_sets'], exactly, "
            "from this database's own lineage") in out.stderr, out.stderr[-3000:]
    # The guess would have taken 20261119_1200_gv_review_seen as run.
    assert "Running upgrade 20261119_1100_gv_change_sets -> 20261119_1200_gv_review_seen" in out.stderr
    assert "-> 20261118_1000_member_sets," not in out.stderr
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]


@E2E
def test_a_placement_a_stopped_job_left_unchecked_is_checked_by_the_next(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # A Job placed a database #670's build stamped, then was stopped before the check: the stamps
    # are the place, the history says it's open — and a column the place can't explain is gone.
    _sql(scratch_db, "ALTER TABLE announcements DROP COLUMN cta_text")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261113_1400_gv_ps_candidate'")
    _sql(scratch_db, "INSERT INTO alembic_history (revision, kind, detail) VALUES ('20261116_1200_graph_watch', "
                     "'placed', '{\"was\": [\"20261116_1200_graph_watch\"], "
                     "\"stamps\": [\"20261113_1400_gv_ps_candidate\"], \"kept\": []}')")
    out = _job(scratch_db, "upgrade")
    assert "stopped before its schema was checked: this one checks it" in out.stderr, out.stderr[-3000:]
    assert out.returncode == 1 and "still not at head" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("20261116_1200_graph_watch",)]
    assert _sql(scratch_db, "SELECT kind FROM alembic_history ORDER BY id DESC LIMIT 1") == [("restored",)]

    # With the column back, the place is borne out, and closed.
    _sql(scratch_db, "ALTER TABLE announcements ADD COLUMN cta_text text")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]
    assert _sql(scratch_db, "SELECT kind FROM alembic_history WHERE kind IN ('placed', 'verified', "
                            "'restored') ORDER BY id DESC LIMIT 1") == [("verified",)]


@E2E
def test_each_migration_is_recorded_with_a_checksum_and_a_changed_file_is_reported_once(scratch_db):
    from backend.app.db import migration_records

    script = _script()
    head = script.get_current_head()
    out = _job(scratch_db, "upgrade", "--no-fast-path")
    assert out.returncode == 0, out.stderr[-2000:]
    ran = dict(_sql(scratch_db, "SELECT revision, checksum FROM alembic_history WHERE kind = 'ran'"))
    assert set(ran) == {r.revision for r in script.walk_revisions()}
    assert ran[head] == migration_records.checksum(script.get_revision(head).path)

    # It ran here as a file this build's isn't any more.
    _sql(scratch_db, f"UPDATE alembic_history SET checksum = repeat('0', 64) WHERE revision = '{head}'")
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0 and f"Migration {head} has changed since it ran" in out.stderr, out.stderr[-3000:]
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0 and "has changed since it ran" not in out.stderr, out.stderr[-3000:]


@E2E
def test_a_migration_kept_waiting_for_a_lock_is_tried_again(scratch_db):
    import threading
    import time

    import psycopg2

    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # 20261118_1100_review_rules has to add its column back, so it needs workspaces' lock, and a
    # read holds a lock on workspaces for longer than the migration waits (its own 5s).
    _sql(scratch_db, "ALTER TABLE workspaces DROP COLUMN review_threads_hold")
    _sql(scratch_db, "DELETE FROM alembic_version")
    _sql(scratch_db, "INSERT INTO alembic_version VALUES ('20261118_1000_gv_review_records'), "
                     "('20261118_1000_member_sets'), ('20261113_1400_gv_ps_candidate')")
    reader = psycopg2.connect(scratch_db.replace("postgresql+asyncpg://", "postgresql://"))
    reader.cursor().execute("SELECT count(*) FROM workspaces")              # holds ACCESS SHARE

    def release():
        time.sleep(8)
        reader.rollback()
        reader.close()

    threading.Thread(target=release, daemon=True).start()
    out = _job(scratch_db, "upgrade", env={"MIGRATION_LOCK_TIMEOUT": "1s"})
    assert out.returncode == 0, out.stderr[-3000:]
    assert "gave up waiting for a lock (try 1)" in out.stderr, out.stderr[-3000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_name = 'workspaces' AND column_name = 'review_threads_hold'") == [(1,)]


@E2E
def test_only_builds_from_main_migrate_a_shared_database(scratch_db):
    script = _script()
    head = script.get_current_head()
    branch = {"SYNODIC_SHARED_DATABASE": "true", "SYNODIC_BUILD_SHA": "abc123",
              "SYNODIC_BUILD_REF": "claude/some-feature", "SYNODIC_BUILD_ON_MAIN": "false"}
    out = _job(scratch_db, "upgrade", env=branch)
    assert out.returncode == 1 and "only builds from main migrate a shared database" in out.stderr, out.stderr[-2000:]
    assert _sql(scratch_db, "SELECT count(*) FROM information_schema.tables WHERE table_name = 'users'") == [(0,)]

    # Built the way images were before builds recorded it: let through, with a warning.
    out = _job(scratch_db, "upgrade", "--shared-database")
    assert out.returncode == 0 and "doesn't record the commit it was built from" in out.stderr, out.stderr[-2000:]
    # At its head already: nothing to run, so nothing to refuse.
    out = _job(scratch_db, "upgrade", env=branch)
    assert out.returncode == 0 and "nothing to run" in out.stderr, out.stderr[-2000:]
    # Behind its head, a build from main moves it on.
    _sql(scratch_db, f"UPDATE alembic_version SET version_num = '{min(script.get_revision(head).down_revision)}'")
    _sql(scratch_db, "INSERT INTO alembic_version SELECT '20261119_1300_merge_member_sets' "
                     "WHERE NOT EXISTS (SELECT 1 FROM alembic_version WHERE version_num = '20261119_1300_merge_member_sets')")
    out = _job(scratch_db, "upgrade", env={**branch, "SYNODIC_BUILD_ON_MAIN": "true", "SYNODIC_BUILD_REF": "main"})
    assert out.returncode == 0, out.stderr[-2000:]
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [(head,)]


def test_the_job_waits_for_a_database_that_is_not_taking_connections_yet(monkeypatch):
    from sqlalchemy.exc import OperationalError

    refused = OperationalError("connect", {}, Exception("connection refused\nis the server running?"))
    tries, slept = [], []

    class Starting:
        def connect(self):
            tries.append(1)
            if len(tries) < 3:
                raise refused
            return "connected"

    class Down:
        def connect(self):
            raise refused

    monkeypatch.setattr(upgrade.time, "sleep", slept.append)
    assert upgrade._connect(Starting(), wait_secs=60) == "connected"
    assert len(tries) == 3 and slept == [1, 2]
    with pytest.raises(OperationalError):
        upgrade._connect(Down(), wait_secs=0)
