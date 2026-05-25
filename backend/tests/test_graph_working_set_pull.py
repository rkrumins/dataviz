"""Tests for the V1-6 pull / rebase semantics.

Pure-logic tests with an in-memory ``Snapshot`` + fake session. The
endpoint wiring is covered by the integration suite.
"""
from __future__ import annotations

from typing import Any

import pytest

from backend.app.db.repositories.graph_working_set_repo import (
    rebase_against_snapshot,
)
from backend.app.services.graph_versioning.manifest import (
    PartitionManifest,
    Snapshot,
    partition_for,
)


class _Row:
    def __init__(
        self, *,
        change_type, object_kind, object_id,
        base_content_hash=None,
    ):
        self.change_type = change_type
        self.object_kind = object_kind
        self.object_id = object_id
        self.base_content_hash = base_content_hash


class _WS:
    def __init__(self, base):
        self.id = "ws_1"
        self.base_commit_id = base
        self.ws_change_version = 7
        self.updated_at = "old"


class _Session:
    """Routes execute() to return the supplied working-change rows.
    Captures session.delete() calls so tests can assert drops."""

    def __init__(self, rows):
        self._rows = list(rows)
        self.deleted = []

    async def execute(self, stmt):
        import types
        return types.SimpleNamespace(
            scalars=lambda: types.SimpleNamespace(
                all=lambda: list(self._rows)
            )
        )

    async def delete(self, obj):
        self.deleted.append(obj)


def _snapshot(entries: dict[str, tuple[str, str]], *, partition_count=64):
    """Build a Snapshot whose manifest contains the given
    ``key -> (kind, content_hash)`` entries."""
    partitions: dict[int, PartitionManifest] = {}
    by_partition: dict[int, dict[str, tuple[str, str]]] = {}
    for k, v in entries.items():
        p = partition_for(k, partition_count)
        by_partition.setdefault(p, {})[k] = v
    for p, ents in by_partition.items():
        partitions[p] = PartitionManifest(
            partition_index=p, manifest_hash=f"ph_{p}", entries=ents,
        )
    return Snapshot(
        partition_count=partition_count,
        root_hash="r",
        partitions=partitions,
    )


@pytest.mark.asyncio
async def test_clean_rebase_when_hash_matches_current():
    """update_node where the staged base equals the current hash is a
    clean rebase — staged op stays in the working set."""
    sess = _Session([
        _Row(
            change_type="update_node", object_kind="node",
            object_id="urn:n1", base_content_hash="h_OLD",
        ),
    ])
    snap = _snapshot({"urn:n1": ("node", "h_OLD")})
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["rebased"] == 1
    assert result["dropped"] == 0
    assert result["conflicts"] == []


@pytest.mark.asyncio
async def test_edit_edit_conflict_when_hash_differs():
    sess = _Session([
        _Row(
            change_type="update_node", object_kind="node",
            object_id="urn:n1", base_content_hash="h_BASE",
        ),
    ])
    snap = _snapshot({"urn:n1": ("node", "h_REMOTE_CHANGED")})
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["rebased"] == 0
    assert len(result["conflicts"]) == 1
    c = result["conflicts"][0]
    assert c["conflict_class"] == "edit_edit"
    assert c["object_id"] == "urn:n1"
    assert c["base_content_hash"] == "h_BASE"
    assert c["current_content_hash"] == "h_REMOTE_CHANGED"


@pytest.mark.asyncio
async def test_edit_delete_conflict_when_object_gone():
    sess = _Session([
        _Row(
            change_type="update_node", object_kind="node",
            object_id="urn:n1", base_content_hash="h_OLD",
        ),
    ])
    snap = _snapshot({})  # object no longer present at new HEAD
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["conflicts"][0]["conflict_class"] == "edit_delete"
    assert result["conflicts"][0]["current_content_hash"] is None


@pytest.mark.asyncio
async def test_delete_delete_silently_drops():
    """Both sides deleted the same object → staged op is just removed
    from the working set; no conflict surfaces."""
    row = _Row(
        change_type="delete_node", object_kind="node",
        object_id="urn:n1", base_content_hash="h_OLD",
    )
    sess = _Session([row])
    snap = _snapshot({})  # object gone on remote too
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["dropped"] == 1
    assert result["conflicts"] == []
    assert sess.deleted == [row]


@pytest.mark.asyncio
async def test_delete_edit_conflict():
    """We staged a delete; remote modified the object → delete_edit."""
    sess = _Session([
        _Row(
            change_type="delete_node", object_kind="node",
            object_id="urn:n1", base_content_hash="h_OLD",
        ),
    ])
    snap = _snapshot({"urn:n1": ("node", "h_REMOTE_MOD")})
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["conflicts"][0]["conflict_class"] == "delete_edit"


@pytest.mark.asyncio
async def test_add_add_collision():
    """Both sides independently created an object with the same key →
    add_add."""
    sess = _Session([
        _Row(
            change_type="add_node", object_kind="node",
            object_id="urn:n1", base_content_hash=None,
        ),
    ])
    snap = _snapshot({"urn:n1": ("node", "h_REMOTE_NEW")})
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["conflicts"][0]["conflict_class"] == "add_add"


@pytest.mark.asyncio
async def test_add_with_no_remote_is_clean():
    """We added an object that doesn't exist on remote → clean rebase
    (the add still applies)."""
    sess = _Session([
        _Row(
            change_type="add_node", object_kind="node",
            object_id="urn:n2", base_content_hash=None,
        ),
    ])
    snap = _snapshot({})
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["rebased"] == 1
    assert result["conflicts"] == []


@pytest.mark.asyncio
async def test_empty_working_set_returns_zero_with_advanced_base():
    sess = _Session([])
    ws = _WS(base="gcmt_OLD")
    result = await rebase_against_snapshot(
        sess, working_set=ws, new_base_commit_id="gcmt_NEW",
        snapshot=_snapshot({}),
    )
    assert result["rebased"] == 0
    assert result["dropped"] == 0
    assert result["conflicts"] == []
    assert result["previous_base"] == "gcmt_OLD"
    assert result["new_base"] == "gcmt_NEW"
    assert ws.base_commit_id == "gcmt_NEW"
    assert ws.ws_change_version == 8  # bumped


@pytest.mark.asyncio
async def test_advances_base_even_with_conflicts():
    """The pull always advances base_commit_id — conflicts don't
    block the rebase. The conflicted staged ops stay in the working
    set with their original base_content_hash so the user can
    resolve."""
    sess = _Session([
        _Row(
            change_type="update_node", object_kind="node",
            object_id="urn:n1", base_content_hash="h_BASE",
        ),
    ])
    snap = _snapshot({"urn:n1": ("node", "h_REMOTE")})
    ws = _WS(base="gcmt_OLD")
    result = await rebase_against_snapshot(
        sess, working_set=ws, new_base_commit_id="gcmt_NEW",
        snapshot=snap,
    )
    assert ws.base_commit_id == "gcmt_NEW"
    assert result["previous_base"] == "gcmt_OLD"
    assert len(result["conflicts"]) == 1
    # The conflicted row was NOT deleted — user resolves and re-commits.
    assert sess.deleted == []


@pytest.mark.asyncio
async def test_mixed_workload_classifies_each_op_independently():
    rows = [
        _Row(
            change_type="add_node", object_kind="node",
            object_id="urn:new", base_content_hash=None,
        ),
        _Row(
            change_type="update_node", object_kind="node",
            object_id="urn:clean", base_content_hash="h_clean",
        ),
        _Row(
            change_type="update_node", object_kind="node",
            object_id="urn:edit_edit", base_content_hash="h_base_ee",
        ),
        _Row(
            change_type="delete_node", object_kind="node",
            object_id="urn:dd", base_content_hash="h_dd",
        ),
        _Row(
            change_type="delete_edge", object_kind="edge",
            object_id="urn:edge_de", base_content_hash="h_de_base",
        ),
    ]
    sess = _Session(rows)
    snap = _snapshot({
        "urn:clean": ("node", "h_clean"),            # clean
        "urn:edit_edit": ("node", "h_remote_diff"),  # conflict
        # urn:new not present → clean add
        # urn:dd not present → drop
        "urn:edge_de": ("edge", "h_de_modified"),    # delete_edit
    })
    result = await rebase_against_snapshot(
        sess, working_set=_WS(base="gcmt_OLD"),
        new_base_commit_id="gcmt_NEW", snapshot=snap,
    )
    assert result["rebased"] == 2  # new + clean
    assert result["dropped"] == 1  # dd
    klasses = sorted(c["conflict_class"] for c in result["conflicts"])
    assert klasses == ["delete_edit", "edit_edit"]
