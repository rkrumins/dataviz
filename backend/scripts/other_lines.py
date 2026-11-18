"""Write ``backend/alembic/other_lines.json``: the migration revisions this tree doesn't have.

A database can be stamped with a revision that only another line of work has — a branch's build
deployed to the same environment — and Alembic then can't locate it. The upgrade Job looks such a
stamp up here: each revision's parents, so it can walk from the stamp to the revisions of this
chain the database ran, set ``alembic_version`` to exactly those, and upgrade from there
(``scripts/upgrade.py``). Nothing in it is ever run.

Read from git: every version of every file under ``backend/alembic/versions/`` in every commit
of every ref the clone has, so a revision renamed, re-parented or dropped since still has its
parents here. Fetch every branch, and every pull request's head (a merged one's branch may be
gone, and its build deployed), then run from the repository root::

    git fetch origin '+refs/heads/*:refs/remotes/origin/*' '+refs/pull/*/head:refs/remotes/pull/*'
    python -m backend.scripts.other_lines

``--check`` exits 1, naming them, when the file lacks a revision git has, a set of parents git
has for it, or the parents a branch's tip has for it.

The file is frozen. A database migrated since each database kept its own lineage
(``app/db/migration_records.py``) is placed from that, and only builds from ``main`` migrate a
shared database. Regenerate it only to place a database an older build of a branch stamped.
Entries marked ``by_hand`` (a stamp no commit has, worked out from an environment) are kept.
"""
from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSIONS = "backend/alembic/versions"
OUT = ROOT / "backend" / "alembic" / "other_lines.json"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def _revision_and_parents(source: str) -> tuple[str, list[str]] | None:
    """A migration's ``revision`` and ``down_revision`` (a list; empty for a base), else None."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    revision, parents = None, []
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
            continue
        for target in ([node.target] if isinstance(node, ast.AnnAssign) else node.targets):
            if not isinstance(target, ast.Name):
                continue
            try:
                value = ast.literal_eval(node.value)
            except ValueError:
                continue
            if target.id == "revision":
                revision = value
            elif target.id == "down_revision":
                parents = list(value) if isinstance(value, (tuple, list)) else ([value] if value else [])
    return (revision, sorted(parents)) if isinstance(revision, str) else None


def _here() -> set[str]:
    """The revisions this tree's chain has."""
    out = set()
    for path in (ROOT / VERSIONS).glob("*.py"):
        found = _revision_and_parents(path.read_text(encoding="utf-8"))
        if found:
            out.add(found[0])
    return out


def every_version() -> dict[str, list[list[str]]]:
    """Every revision any commit of any ref has, with every set of parents it was given there."""
    seen_blobs: dict[str, tuple[str, list[str]] | None] = {}
    out: dict[str, list[list[str]]] = {}
    for commit in _git("log", "--all", "--format=%H", "--", VERSIONS).split():
        for row in _git("ls-tree", commit, f"{VERSIONS}/").splitlines():
            meta, path = row.split("\t", 1)
            blob = meta.split()[2]
            if not path.endswith(".py"):
                continue
            if blob not in seen_blobs:
                seen_blobs[blob] = _revision_and_parents(_git("cat-file", "-p", blob))
            found = seen_blobs[blob]
            if found and found[1] not in out.setdefault(found[0], []):
                out[found[0]].append(found[1])
    return out


def collect() -> dict:
    """Every revision any commit of any ref has and this tree doesn't: every set of parents it was
    given (``parents``), the refs whose tip has it (``on``), and the parents it has there
    (``at_tips``) — what a build deployed from a branch as it is now would have stamped."""
    here, every = _here(), every_version()
    # A set of parents naming a revision no commit defines is from a commit no build could run.
    runnable = lambda variants: [ps for ps in variants if all(p in here or p in every for p in ps)]
    lines = {revision: {"parents": runnable(variants), "on": [], "at_tips": []}
             for revision, variants in every.items() if revision not in here and runnable(variants)}
    tips = _git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin").split()
    for ref in tips:
        for row in _git("ls-tree", "--name-only", ref, f"{VERSIONS}/").splitlines():
            if not row.endswith(".py"):
                continue
            found = _revision_and_parents(_git("show", f"{ref}:{row}"))
            if found and found[0] in lines and found[1] in lines[found[0]]["parents"]:
                entry = lines[found[0]]
                if ref not in entry["on"]:
                    entry["on"].append(ref)
                if found[1] not in entry["at_tips"]:
                    entry["at_tips"].append(found[1])
    for entry in lines.values():
        for k in ("parents", "on", "at_tips"):
            entry[k].sort()
    # Kept: what's known of a stamp no commit has (a merge made by hand in an environment).
    previous = json.loads(OUT.read_text()) if OUT.exists() else {}
    lines.update({rev: entry for rev, entry in previous.get("revisions", {}).items()
                  if entry.get("by_hand") and rev not in lines and rev not in here})
    return {"about": previous.get("about", "Migration revisions main's chain doesn't have, with "
                                           "their parents. Never run."),
            "revisions": dict(sorted(lines.items()))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if the file is out of date with git")
    args = parser.parse_args()
    doc = collect()
    if args.check:
        have = json.loads(OUT.read_text()).get("revisions", {}) if OUT.exists() else {}
        # More than this clone can see is fine (a pull request's head since deleted, say).
        stale = sorted(rev for rev, entry in doc["revisions"].items()
                       if rev not in have
                       or any(p not in have[rev].get(k, []) for k in ("parents", "at_tips") for p in entry[k]))
        if stale:
            print(f"{OUT.relative_to(ROOT)} is out of date for {len(stale)} revision(s) git has: "
                  f"{stale}. Fetch every branch and run `python -m backend.scripts.other_lines`, "
                  "then commit the file.", file=sys.stderr)
            return 1
        print(f"{OUT.name} records every revision git has that this chain doesn't "
              f"({len(doc['revisions'])}).")
        return 0
    OUT.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(doc['revisions'])} revisions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
