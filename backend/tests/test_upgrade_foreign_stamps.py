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
  - a side branch that parted earlier than the guess (some of this build's migrations written
    while it was open, and never run there): the schema left short names them, and the job places
    it below them and upgrades again, by itself; ``--rewind-to`` still names a place outright;
  - when the schema still isn't at head and nothing of ours run again would bring it, the stamps go
    back as they were and the job fails, so it can't pass on a later run either;
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
    # Nothing records it: no exact place.
    assert upgrade._placed(script, lines, ["20261119_1200_merge_members_set"], []) is None


def test_a_schema_left_short_places_it_below_the_migrations_that_make_what_is_missing():
    script = _script()
    head = script.get_current_head()
    gap = ["missing column public.workspaces.review_threads_hold"]      # 20261118_1100_review_rules's
    assert upgrade._below_gaps(script, ["20261118_1100_review_rules"], [], gap) == ["20261118_1000_gv_review_records"]
    # Below it on every line it's on, and nothing else moved.
    assert upgrade._below_gaps(script, [head], [], gap) == [
        "20261113_1400_gv_ps_candidate", "20261118_1000_gv_review_records", "20261118_1000_member_sets"]
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
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 1, out.stderr[-3000:]
    assert "still not at head" in out.stderr
    assert _sql(scratch_db, "SELECT version_num FROM alembic_version") == [("29991231_2359_from_the_future",)]


@E2E
def test_a_branch_that_parted_earlier_than_the_guess_upgrades_by_itself(scratch_db):
    head = _script().get_current_head()
    out = _job(scratch_db, "upgrade")
    assert out.returncode == 0, out.stderr[-2000:]
    # It parted at 20261117_1500 and never ran 20261118_1100_review_rules (one of its columns);
    # its own revision is dated after that one, so the guess takes review_rules as run.
    _sql(scratch_db, "ALTER TABLE workspaces DROP COLUMN review_threads_hold")
    _sql(scratch_db, "UPDATE alembic_version SET version_num = '20261118_1200_elsewhere'")
    out = _job(scratch_db, "upgrade")
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
    assert "Placing it at ['20261119_1100_gv_change_sets']" in out.stderr, out.stderr[-3000:]
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
    assert f"This build's migration chain ends at ['{head}']" in out.stderr
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
