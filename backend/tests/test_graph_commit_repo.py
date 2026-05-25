"""Tests for the commit persistence adapter.

Pure part (compute_commit_hash) is fully tested. The DB orchestration
(ref optimistic guard, head-moved, lost-race, atomic outbox) is tested
with a typed fake AsyncSession — no live Postgres in the authoring
env; full persistence is covered by the Phase-1 integration suite.
"""
import types

import pytest

from backend.app.db.repositories.graph_commit_repo import (
    HeadMovedError,
    compute_commit_hash,
    persist_commit,
)
from backend.app.services.graph_versioning.commit import NodeState, plan_commit


# ── pure: compute_commit_hash ──────────────────────────────────────

def test_commit_hash_is_deterministic_and_sensitive():
    base = dict(
        root_hash="r1", parent_ids=["p0"], author="alice",
        message="msg", committed_at="2026-05-16T00:00:00+00:00",
    )
    h = compute_commit_hash(**base)
    assert h == compute_commit_hash(**base)
    assert h != compute_commit_hash(**{**base, "root_hash": "r2"})
    assert h != compute_commit_hash(**{**base, "parent_ids": []})
    assert h != compute_commit_hash(**{**base, "message": "other"})
    assert h != compute_commit_hash(**{**base, "committed_at": "2026-01-01T00:00:00+00:00"})


# ── fake session ───────────────────────────────────────────────────

class _Ref:
    def __init__(self, commit_id, revision=3):
        self.id = "gref_1"
        self.commit_id = commit_id
        self.revision = revision


class _FakeSession:
    """Routes execute() by statement type: Select -> ref lookup,
    Update -> ref advance (configurable rowcount), Insert -> no-op."""

    def __init__(self, ref, update_rowcount=1):
        self._ref = ref
        self._update_rowcount = update_rowcount
        self.added = []
        self.update_called = False

    async def execute(self, stmt):
        name = type(stmt).__name__
        if name == "Select":
            return types.SimpleNamespace(
                scalar_one_or_none=lambda: self._ref
            )
        if name == "Update":
            self.update_called = True
            return types.SimpleNamespace(rowcount=self._update_rowcount)
        # Insert (pg_insert ... on_conflict_do_nothing)
        return types.SimpleNamespace()

    def add(self, obj):
        self.added.append(obj)


def _plan():
    nodes = {"urn:a": NodeState("urn:a", "T", "a", {"x": 0, "y": 0}, {})}
    return nodes, plan_commit(
        base_snapshot=None, nodes=nodes, edges={},
        partition_count=64, schema_mode="schemaless",
    )


@pytest.mark.asyncio
async def test_ref_missing_raises_lookup():
    nodes, plan = _plan()
    with pytest.raises(LookupError):
        await persist_commit(
            _FakeSession(ref=None), graph_id="g1", branch="main",
            plan=plan, node_states=nodes, edge_states={},
            author="a", message="m", expected_head_commit_id=None,
        )


@pytest.mark.asyncio
async def test_head_moved_when_expected_mismatch_and_nothing_written():
    nodes, plan = _plan()
    sess = _FakeSession(ref=_Ref(commit_id="gcmt_REAL"))
    with pytest.raises(HeadMovedError) as ei:
        await persist_commit(
            sess, graph_id="g1", branch="main", plan=plan,
            node_states=nodes, edge_states={},
            author="a", message="m",
            expected_head_commit_id="gcmt_STALE",  # != ref.commit_id
        )
    assert ei.value.current_head == "gcmt_REAL"
    # Guard fired before any commit/audit/outbox rows were added.
    assert sess.added == []
    assert sess.update_called is False


@pytest.mark.asyncio
async def test_lost_race_zero_rowcount_raises_head_moved():
    nodes, plan = _plan()
    sess = _FakeSession(ref=_Ref(commit_id=None), update_rowcount=0)
    with pytest.raises(HeadMovedError):
        await persist_commit(
            sess, graph_id="g1", branch="main", plan=plan,
            node_states=nodes, edge_states={},
            author="a", message="m", expected_head_commit_id=None,
        )
    assert sess.update_called is True  # advance attempted, lost the race


@pytest.mark.asyncio
async def test_happy_path_writes_commit_audit_and_outbox_atomically():
    nodes, plan = _plan()
    sess = _FakeSession(ref=_Ref(commit_id=None), update_rowcount=1)
    result = await persist_commit(
        sess, graph_id="g1", branch="main", plan=plan,
        node_states=nodes, edge_states={},
        author="alice", message="init", expected_head_commit_id=None,
        actor="usr_1",
    )
    added_types = {type(o).__name__ for o in sess.added}
    # Commit row, the change-event audit row, and the outbox event were
    # all appended to the SAME session (one atomic transaction).
    assert "GraphCommitORM" in added_types
    assert "GraphChangeEventORM" in added_types
    assert "GraphStoreOutboxEventORM" in added_types
    assert sess.update_called is True
    assert result.commit_id.startswith("gcmt_")
    assert result.root_hash == plan.root_hash
    assert result.delta_summary["nodes_added"] == 1
    # Commit hash is reproducible from the recorded fields.
    commit_row = next(o for o in sess.added if type(o).__name__ == "GraphCommitORM")
    assert commit_row.commit_hash == compute_commit_hash(
        root_hash=plan.root_hash,
        parent_ids=[],
        author="alice",
        message="init",
        committed_at=commit_row.committed_at,
    )


# ── V1-1 / V1-2 / V1-4: trunk substrate ────────────────────────────


class _TrunkAwareFakeSession(_FakeSession):
    """Extends the base fake to handle the V1-4 trunk_log Select that
    re-reads the autoincrement ``commit_seq`` after ``flush()``."""

    def __init__(self, ref, *, commit_seq=42, **kw):
        super().__init__(ref, **kw)
        self._commit_seq = commit_seq
        self.flushed = False
        self._first_select_consumed = False

    async def flush(self):
        self.flushed = True

    async def execute(self, stmt):
        name = type(stmt).__name__
        if name == "Select":
            if not self._first_select_consumed:
                # First select: ref lookup (matches base fake).
                self._first_select_consumed = True
                return types.SimpleNamespace(
                    scalar_one_or_none=lambda: self._ref
                )
            # Second select: commit_seq re-read for trunk_log write.
            return types.SimpleNamespace(
                scalar_one=lambda: self._commit_seq
            )
        if name == "Update":
            self.update_called = True
            return types.SimpleNamespace(rowcount=self._update_rowcount)
        return types.SimpleNamespace()


@pytest.mark.asyncio
async def test_default_branch_drops_extra_parent_ids_and_writes_trunk_log():
    """V1-1 squash gate: trunk commits are always single-parent.
    V1-4 substrate: a graph_trunk_log row is appended in the same txn."""
    nodes, plan = _plan()
    sess = _TrunkAwareFakeSession(
        ref=_Ref(commit_id="gcmt_PREV", revision=5), commit_seq=99,
    )
    result = await persist_commit(
        sess, graph_id="g1", branch="main", plan=plan,
        node_states=nodes, edge_states={},
        author="alice", message="squash from feature",
        expected_head_commit_id="gcmt_PREV",
        # Caller (merge service) supplied a draft tip — must be dropped:
        extra_parent_ids=["gcmt_DRAFT"],
        is_default_branch=True,
        merge_source_commit_id="gcmt_DRAFT",
        merge_source_branch="feature-x",
    )
    commit_row = next(o for o in sess.added if type(o).__name__ == "GraphCommitORM")
    # V1-1: trunk parent_ids has exactly one entry (the prior trunk head).
    assert commit_row.parent_ids == ["gcmt_PREV"]
    # V1-2: provenance pointer persisted on the commit row.
    assert commit_row.merge_source_commit_id == "gcmt_DRAFT"
    assert commit_row.merge_source_branch == "feature-x"
    # V1-4: trunk_log row appended.
    trunk_rows = [o for o in sess.added if type(o).__name__ == "GraphTrunkLogORM"]
    assert len(trunk_rows) == 1
    tl = trunk_rows[0]
    assert tl.graph_id == "g1"
    assert tl.commit_id == result.commit_id
    assert tl.commit_seq == 99
    assert sess.flushed is True


@pytest.mark.asyncio
async def test_non_default_branch_keeps_extra_parents_no_trunk_log():
    """Feature-into-feature merges keep the two-parent shape and do
    NOT write to trunk_log."""
    nodes, plan = _plan()
    sess = _FakeSession(
        ref=_Ref(commit_id="gcmt_PREV", revision=5), update_rowcount=1,
    )
    await persist_commit(
        sess, graph_id="g1", branch="feature-y", plan=plan,
        node_states=nodes, edge_states={},
        author="alice", message="merge X into Y",
        expected_head_commit_id="gcmt_PREV",
        extra_parent_ids=["gcmt_FEATURE_X"],
        is_default_branch=False,  # NOT trunk
    )
    commit_row = next(o for o in sess.added if type(o).__name__ == "GraphCommitORM")
    # Two parents preserved on non-trunk merges.
    assert commit_row.parent_ids == ["gcmt_PREV", "gcmt_FEATURE_X"]
    # No provenance fields set.
    assert commit_row.merge_source_commit_id is None
    assert commit_row.merge_source_branch is None
    # No trunk_log row appended.
    trunk_rows = [o for o in sess.added if type(o).__name__ == "GraphTrunkLogORM"]
    assert trunk_rows == []


@pytest.mark.asyncio
async def test_direct_main_commit_writes_trunk_log_with_null_provenance():
    """Direct-on-trunk commits (not a merge) still write trunk_log but
    leave provenance fields NULL."""
    nodes, plan = _plan()
    sess = _TrunkAwareFakeSession(
        ref=_Ref(commit_id="gcmt_PREV", revision=2), commit_seq=7,
    )
    await persist_commit(
        sess, graph_id="g1", branch="main", plan=plan,
        node_states=nodes, edge_states={},
        author="alice", message="direct edit",
        expected_head_commit_id="gcmt_PREV",
        is_default_branch=True,
        # No merge_source_* supplied — direct commit, not a merge.
    )
    commit_row = next(o for o in sess.added if type(o).__name__ == "GraphCommitORM")
    assert commit_row.parent_ids == ["gcmt_PREV"]
    assert commit_row.merge_source_commit_id is None
    assert commit_row.merge_source_branch is None
    trunk_rows = [o for o in sess.added if type(o).__name__ == "GraphTrunkLogORM"]
    assert len(trunk_rows) == 1
    assert trunk_rows[0].commit_seq == 7
