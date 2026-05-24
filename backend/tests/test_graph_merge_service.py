"""Unit tests for graph_merge_service.

The end-to-end merge path needs a live Graph Store (handled by the
integration suite). What's pure-enough to unit-test here:

- ``find_merge_base`` LCA walk (mocked session yielding parent_ids)
- conflict / violation serialisation shapes
- DB-vs-pure conflict class mapping
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services import graph_merge_service
from backend.app.services.graph_merge_service import (
    _PURE_TO_DB_CONFLICT_CLASS,
    _serialise_conflicts,
    _serialise_violations,
    find_merge_base,
)
from backend.app.services.graph_versioning.merge import (
    IntegrityViolation,
    MergeConflict,
)


# ── find_merge_base ─────────────────────────────────────────────────


def _scripted_parents(graph: dict[str, list[str]]):
    """Build a fake AsyncSession whose execute(select(parent_ids)) returns
    scripted parent lists from ``graph`` keyed by commit_id."""

    class _Result:
        def __init__(self, value):
            self._value = value

        def scalar_one_or_none(self):
            return self._value

    async def _execute(stmt):
        # Inspect the WHERE clause to pull out the commit_id literal.
        # SQLAlchemy stores it on .compile()/params, but here we
        # short-circuit by inspecting the str() form which contains
        # the value at the end after "= " (works for the simple
        # `WHERE id = :literal` shape this function emits).
        text = str(stmt.compile(compile_kwargs={"literal_binds": True}))
        # extract commit_id (last quoted literal)
        import re
        m = re.findall(r"'([^']+)'", text)
        commit_id = m[-1] if m else None
        return _Result(graph.get(commit_id))

    sess = MagicMock()
    sess.execute = AsyncMock(side_effect=_execute)
    return sess


@pytest.mark.asyncio
async def test_lca_linear_history():
    # A → B → C ; both heads = C; LCA = C
    sess = _scripted_parents({"C": ["B"], "B": ["A"], "A": []})
    lca = await find_merge_base(sess, graph_id="g", head_a="C", head_b="C")
    assert lca == "C"


@pytest.mark.asyncio
async def test_lca_diverged_at_b():
    # A → B → C (target) ; A → B → D (source) ; LCA = B
    sess = _scripted_parents({
        "C": ["B"], "D": ["B"], "B": ["A"], "A": [],
    })
    lca = await find_merge_base(sess, graph_id="g", head_a="C", head_b="D")
    assert lca == "B"


@pytest.mark.asyncio
async def test_lca_one_is_ancestor_of_other():
    # target = C, source = A (ancestor) ; LCA = A
    sess = _scripted_parents({"C": ["B"], "B": ["A"], "A": []})
    lca = await find_merge_base(sess, graph_id="g", head_a="C", head_b="A")
    assert lca == "A"


@pytest.mark.asyncio
async def test_lca_handles_none_head():
    sess = _scripted_parents({})
    assert await find_merge_base(sess, graph_id="g", head_a=None, head_b="X") is None
    assert await find_merge_base(sess, graph_id="g", head_a="X", head_b=None) is None


@pytest.mark.asyncio
async def test_lca_disjoint_histories_returns_none():
    # Two unrelated commit chains, no common ancestor.
    sess = _scripted_parents({
        "X1": ["X2"], "X2": [], "Y1": ["Y2"], "Y2": [],
    })
    assert await find_merge_base(sess, graph_id="g", head_a="X1", head_b="Y1") is None


# ── conflict serialisation ──────────────────────────────────────────


def test_serialise_conflicts_renames_ours_theirs_to_target_source():
    cs = (
        MergeConflict(
            key="urn:x", kind="node", conflict_class="modify_modify",
            base_hash="h_base", ours_hash="h_target", theirs_hash="h_source",
        ),
    )
    out = _serialise_conflicts(cs)
    assert out == [{
        "key": "urn:x",
        "kind": "node",
        "conflict_class": "modify_modify",
        "base_content_hash": "h_base",
        "source_content_hash": "h_source",   # was theirs_hash
        "target_content_hash": "h_target",   # was ours_hash
    }]


def test_serialise_violations_keeps_code_detail_key():
    vs = (
        IntegrityViolation(code="dangling_edge", detail="edge x -> Y", key="x"),
    )
    assert _serialise_violations(vs) == [
        {"code": "dangling_edge", "detail": "edge x -> Y", "key": "x"}
    ]


def test_pure_to_db_conflict_class_maps_modify_modify_to_attr():
    """The DB CHECK constraint allows {attr,add_add,edit_delete,
    dangling_edge,edge_endpoint,structural} but the pure engine emits
    `modify_modify` — verify the mapping prevents constraint
    violations."""
    assert _PURE_TO_DB_CONFLICT_CLASS["modify_modify"] == "attr"
    assert _PURE_TO_DB_CONFLICT_CLASS["add_add"] == "add_add"
    assert _PURE_TO_DB_CONFLICT_CLASS["edit_delete"] == "edit_delete"
