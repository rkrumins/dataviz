"""Fail a merge whose migrations would leave a database upgrading out of order.

A database stamped at a revision is taken to have run everything below it, so a merge must keep
every place a database can be stamped at meaning what it meant. Against the base branch (``main``):

* **Every revision the base has is here, with the same parents.** Dropped, a database stamped
  there is stranded; moved, the Job takes it to have run what the new parents bring, and skips it.
* **Every revision this adds has the parents it was ever pushed with**, on any branch. A branch's
  build may have taken a database there already; with other parents it would be misplaced in the
  same way. Re-parenting a pushed revision means a new id: the old one stays in
  ``alembic/other_lines.json``, where the Job finds what a database stamped with it ran.

It warns, without failing, when a migration the base has is changed here: databases that ran it
never run the change (the upgrade Job says so too, from the checksums it keeps). A change that
matters belongs in a new migration; one that only guards DDL already applied, say, needn't be.

The chain ending in one head is ``tests/test_alembic_single_head.py``'s. Guards (``alembic-guards.yml``) runs this
on every pull request into ``main``, and on every push to it, from the merged checkout, with every
branch fetched::

    python -m backend.scripts.check_migration_chain <base checkout>
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from backend.scripts.other_lines import VERSIONS, _revision_and_parents, every_version


def files(root: Path) -> dict[str, Path]:
    """The revisions under ``root``'s ``backend/alembic/versions``, each with its file."""
    out = {}
    for path in (root / VERSIONS).glob("*.py"):
        found = _revision_and_parents(path.read_text(encoding="utf-8"))
        if found:
            out[found[0]] = path
    return out


def chain(root: Path) -> dict[str, list[str]]:
    """The revisions under ``root``'s ``backend/alembic/versions``, each with its parents."""
    return {revision: _revision_and_parents(path.read_text(encoding="utf-8"))[1]
            for revision, path in files(root).items()}


def edited(base: dict[str, Path], here: dict[str, Path]) -> list[str]:
    """The revisions both have whose files differ."""
    return sorted(r for r in set(base) & set(here) if base[r].read_bytes() != here[r].read_bytes())


def problems(base: dict, here: dict, pushed: dict) -> list[str]:
    """What's wrong with ``here`` against ``base``, and with every version of a revision git has
    (``pushed``: revision → each set of parents it was given)."""
    out = []
    for revision, parents in sorted(base.items()):
        if revision not in here:
            out.append(f"{revision} is gone; the base has it, with parents {parents}. A database "
                       "stamped there could no longer upgrade: put it back.")
        elif here[revision] != parents:
            out.append(f"{revision} has parents {here[revision]}; the base has {parents}. A database "
                       "stamped there would be taken to have run what the new ones bring: put them "
                       "back, and join the lines with a merge revision.")
    for revision in sorted(set(here) - set(base)):
        other = [p for p in pushed.get(revision, []) if p != here[revision]]
        if other:
            out.append(f"{revision} has parents {here[revision]}, and was pushed with {other}. A "
                       "database a build took there would be taken to have run what the new ones "
                       "bring: give it a new revision id (and run `python -m "
                       "backend.scripts.other_lines`), or put its parents back and join the lines "
                       "with a merge revision.")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("base", type=Path, help="a checkout of the base branch")
    args = parser.parse_args()
    here = chain(Path(__file__).resolve().parents[2])
    found = problems(chain(args.base), here, every_version())
    for revision in edited(files(args.base), files(Path(__file__).resolve().parents[2])):
        print(f"::warning title=Migration changed::{revision} is changed here. Databases that ran it "
              "never run the change; if it matters, it belongs in a new migration.")
    for line in found:
        print(f"::error title=Migration chain::{line}")
    if found:
        return 1
    print(f"The migration chain keeps every revision of the base's as it was, and adds "
          f"{len(set(here) - set(chain(args.base)))} with the parents they were pushed with.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
