"""The migration chain ends in one head.

Two PRs, each green on its own, can each add a revision on the same parent: merged, the chain
has two heads. #674 and #675 did, off ``20261117_1500_gv_mr_sendback``, and every deploy of main
stopped there until a merge revision joined them. The upgrade Job now reaches every head all the
same (``scripts/upgrade.py``), so a missed merge revision no longer takes a deployment down —
this keeps it from going unnoticed: a pull request that ends with two heads, merged with main
as CI checks it, fails here, and so does main on the push that gives it two.

Parsed with ``ast``, as ``test_alembic_revision_lengths`` does, so it runs with nothing but
pytest installed (the Guards workflow runs it with ``--noconftest``).
"""
from __future__ import annotations

import ast
from pathlib import Path


def _versions_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "alembic" / "versions"


def _revision_and_parents(path: Path) -> tuple[str, tuple[str, ...]]:
    revision, parents = None, ()
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
            continue
        for target in ([node.target] if isinstance(node, ast.AnnAssign) else node.targets):
            if not isinstance(target, ast.Name):
                continue
            if target.id == "revision":
                revision = ast.literal_eval(node.value)
            elif target.id == "down_revision":
                value = ast.literal_eval(node.value)
                parents = tuple(value) if isinstance(value, (tuple, list)) else ((value,) if value else ())
    assert isinstance(revision, str), f"no top-level ``revision`` string in {path.name}"
    return revision, parents


def heads(versions: Path) -> list[str]:
    """The revisions no other revision builds on."""
    chain = dict(_revision_and_parents(p) for p in versions.glob("*.py") if not p.name.startswith("__"))
    built_on = {parent for parents in chain.values() for parent in parents}
    return sorted(set(chain) - built_on)


def test_the_chain_has_one_head():
    found = heads(_versions_dir())
    assert len(found) == 1, (
        f"The migration chain has {len(found)} heads: {found}. Join them with a merge revision — "
        f"`alembic merge -m 'merge …' {' '.join(found)}` from backend/, with a revision id of at "
        "most 32 characters — so every database ends at the same place.")


def test_two_revisions_on_one_parent_are_two_heads(tmp_path):
    def write(name, revision, down):
        (tmp_path / f"{name}.py").write_text(f"revision = {revision!r}\ndown_revision = {down!r}\n")
    write("a", "base_rev", None)
    write("b", "left", "base_rev")
    write("c", "right", "base_rev")
    assert heads(tmp_path) == ["left", "right"]
    write("d", "joined", ("left", "right"))
    assert heads(tmp_path) == ["joined"]
