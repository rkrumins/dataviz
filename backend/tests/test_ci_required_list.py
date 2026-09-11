"""The required backend job is only a gate while it still reads the list.

`tests/ci-required-files.txt` names the test files that must pass before a
merge. A list like that fails quietly in two ways, and both have happened to
this repo's CI before: an entry stops pointing at a file that exists, so
pytest is handed a path it skips over; or the workflow step that reads it is
edited away, and the list sits there looking like coverage while gating
nothing at all.

Neither shows up as a red build. This is what makes them show up.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_LIST = Path(__file__).parent / "ci-required-files.txt"
_WORKFLOW = _REPO / ".github" / "workflows" / "backend-tests.yml"


def _entries() -> list[str]:
    return [
        line.strip()
        for line in _LIST.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def test_every_listed_file_exists() -> None:
    """A path that no longer resolves is handed to pytest and quietly does
    nothing — the file was renamed or deleted and its subject stopped being
    gated, with a green build the whole way."""
    missing = [e for e in _entries() if not (_REPO / "backend" / e).is_file()]
    assert missing == [], (
        f"{_LIST.name} names files that do not exist: {missing}. Rename the "
        f"entry, or delete it if the subject is genuinely gone."
    )


def test_the_list_is_sorted_and_has_no_duplicates() -> None:
    """So a reviewer can see at a glance what a diff to it adds, and so the
    same file cannot be gated twice while another is missed."""
    entries = _entries()
    assert entries == sorted(set(entries)), (
        "Keep the list sorted with no duplicates: "
        "`sort -u` the non-comment lines."
    )


def test_the_required_job_actually_reads_the_list() -> None:
    """The list is not the gate — the workflow step that reads it is. Editing
    that step away leaves a file full of paths that looks exactly like
    coverage and enforces nothing."""
    workflow = _WORKFLOW.read_text()
    # The job body only — the file header discusses both jobs in prose.
    _, _, body = workflow.partition("  connectivity-suite:")
    required, _, informational = body.partition("full-suite:")
    assert _LIST.name in required, (
        f"The REQUIRED job in {_WORKFLOW.name} no longer reads {_LIST.name}. "
        f"Every file it names is ungated until it does."
    )
    assert "continue-on-error" not in required, (
        "The job reading the list became informational; it gates nothing now."
    )
    assert informational, "Expected a `full-suite:` job after the required one."


def test_the_graph_read_path_is_gated() -> None:
    """The subjects this list exists for.

    A keyword selector cannot be trusted to catch these — that is why the
    list exists — so name them. Each is a file whose failure a user would
    feel: the cache that decides whether opening a view costs ten seconds,
    the routing that decides whether the replicas do any work, and the
    capacity arithmetic that decides whether a rebuild OOMs a shard.
    """
    entries = set(_entries())
    for must in (
        "tests/test_graph_cache.py",
        "tests/test_falkordb_replica_reads.py",
        "tests/test_graph_store_topology.py",
        "tests/test_shard_capacity.py",
        "tests/test_aggregated_read_budget.py",
        "tests/test_label_cache_warmup.py",
        "tests/test_configmap_matches_manifests.py",
    ):
        assert must in entries, f"{must} is not gated by the required job"


@pytest.mark.parametrize("entry", _entries())
def test_each_entry_is_a_file_pytest_collects(entry: str) -> None:
    """A directory or a helper module in the list is not a no-op — pytest
    walks a directory and would silently widen the gate, and a non-`test_`
    module contributes nothing while reading as coverage."""
    assert entry.startswith("tests/"), entry
    assert Path(entry).name.startswith("test_"), entry
    assert entry.endswith(".py"), entry
    assert re.fullmatch(r"[\w./-]+", entry), f"{entry} needs shell quoting"
