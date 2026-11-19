"""The lineage record the upgrade Job places other builds' databases with, and the merge check.

Pure ``ast``/``json``, no database and no app imports: it runs in the Guards workflow with
``--noconftest``.

* ``backend/alembic/other_lines.json`` is whole: every set of parents it gives a revision leads,
  through revisions it records, down to this chain, so walking a stamp's lineage always arrives
  here; the parents a branch's tip has are among them.
* ``scripts/check_migration_chain.problems``: a merge may add revisions, never drop or re-parent
  one the base has, and never re-parent one that was pushed (it may already be deployed).
"""
import json
from pathlib import Path

from backend.scripts.check_migration_chain import chain, problems

ROOT = Path(__file__).resolve().parents[2]
RECORD = json.loads((ROOT / "backend" / "alembic" / "other_lines.json").read_text(encoding="utf-8"))


def test_every_recorded_lineage_reaches_this_chain():
    ours, recorded = chain(ROOT), RECORD["revisions"]
    for revision, entry in recorded.items():
        assert entry["parents"], revision
        for parents in entry["parents"]:
            assert all(isinstance(p, str) for p in parents), revision
            missing = [p for p in parents if p not in ours and p not in recorded]
            assert not missing, f"{revision}'s parents {missing} are neither this chain's nor recorded"
        for parents in entry["at_tips"]:
            assert parents in entry["parents"], revision

    def reaches(revision, seen=()):
        if revision in ours:
            return True
        assert revision not in seen, f"the record's lineage loops at {revision}"
        return all(all(reaches(p, (*seen, revision)) for p in ps) for ps in recorded[revision]["parents"])

    for revision in recorded:
        assert reaches(revision), revision


BASE = {"a": [], "b": ["a"], "c": ["b"]}


def test_a_merge_may_add_revisions_with_the_parents_they_were_pushed_with():
    assert problems(BASE, {**BASE, "d": ["c"]}, {"d": [["c"]]}) == []
    assert problems(BASE, {**BASE, "d": ["c"]}, {}) == []                 # never pushed elsewhere


def test_a_merge_may_not_drop_or_reparent_a_revision_the_base_has():
    dropped = problems(BASE, {"a": [], "b": ["a"]}, {})
    assert len(dropped) == 1 and dropped[0].startswith("c is gone")
    moved = problems(BASE, {**BASE, "x": ["a"], "c": ["x"]}, {})
    assert len(moved) == 1 and moved[0].startswith("c has parents ['x']; the base has ['b']")


def test_a_merge_may_not_reparent_a_revision_that_was_pushed():
    # Pushed on c, and maybe deployed there; merged on d, a database stamped with it would be
    # taken to have run d too.
    found = problems(BASE, {**BASE, "d": ["c"], "e": ["d"]}, {"e": [["c"], ["d"]]})
    assert len(found) == 1 and "e has parents ['d'], and was pushed with [['c']]" in found[0]
