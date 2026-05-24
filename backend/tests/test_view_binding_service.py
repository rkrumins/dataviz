"""Unit tests for the view-binding service.

`resolve_branch` is pure and tested directly with a fake ViewORM-shaped
SimpleNamespace. `ensure_branch` is tested with a mocked Graph-Store
session so the branch-creation contract is pinned without needing a
live Postgres.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services.view_binding_service import (
    ResolvedViewBinding,
    ViewBranchMismatchError,
    ViewNotBoundError,
    assert_branch_matches_view,
    ensure_branch,
    resolve_branch,
)


def _view(**overrides):
    defaults = {
        "id": "view_1",
        "source_graph_id": "g1",
        "source_branch": None,
        "branching_policy": "per_view",
        "merge_target_branch": "main",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ── resolve_branch (pure) ──────────────────────────────────────────

def test_resolve_branch_per_view_default():
    assert resolve_branch(_view(), "alice") == "view/view_1"


def test_resolve_branch_shared_main_uses_merge_target():
    v = _view(branching_policy="shared_main", merge_target_branch="trunk")
    assert resolve_branch(v, "alice") == "trunk"


def test_resolve_branch_shared_main_defaults_to_main():
    v = _view(branching_policy="shared_main", merge_target_branch=None)
    assert resolve_branch(v, "alice") == "main"


def test_resolve_branch_per_user_per_view_includes_uid():
    v = _view(branching_policy="per_user_per_view")
    assert resolve_branch(v, "alice") == "user/alice/view/view_1"
    assert resolve_branch(v, "bob") == "user/bob/view/view_1"


def test_resolve_branch_per_user_requires_uid():
    v = _view(branching_policy="per_user_per_view")
    with pytest.raises(ValueError, match="user_id"):
        resolve_branch(v, "")


def test_resolve_branch_unknown_policy_raises():
    with pytest.raises(ValueError, match="unknown branching_policy"):
        resolve_branch(_view(branching_policy="anarchy"), "alice")


def test_resolve_branch_missing_policy_falls_back_to_per_view():
    # Defence-in-depth: the DB CHECK forbids NULL, but defensive code
    # should still produce a sane default.
    assert resolve_branch(_view(branching_policy=None), "alice") == "view/view_1"


# ── assert_branch_matches_view ─────────────────────────────────────

def test_assert_branch_matches_view_passes_when_correct():
    assert_branch_matches_view(_view(), user_id="alice", branch="view/view_1")


def test_assert_branch_matches_view_rejects_mismatch():
    with pytest.raises(ViewBranchMismatchError) as exc:
        assert_branch_matches_view(
            _view(), user_id="alice", branch="some/other/branch"
        )
    assert exc.value.expected == "view/view_1"
    assert exc.value.actual == "some/other/branch"


# ── ensure_branch (mocked DB) ──────────────────────────────────────

def _mock_session_returning(existing_ref, base_ref=None):
    """Fake session whose graph_repo.get_branch_ref_or_none returns
    a scripted sequence and whose create_branch records calls."""
    sess = MagicMock()
    sess.add = MagicMock()
    sess.execute = AsyncMock()
    return sess


@pytest.mark.asyncio
async def test_ensure_branch_raises_when_view_unbound(monkeypatch):
    v = _view(source_graph_id=None)
    with pytest.raises(ViewNotBoundError):
        await ensure_branch(MagicMock(), view=v, user_id="alice")


@pytest.mark.asyncio
async def test_ensure_branch_fast_path_when_branch_exists(monkeypatch):
    v = _view()
    existing = SimpleNamespace(commit_id="gcmt_42", name="view/view_1")

    async def fake_get(session, *, graph_id, branch):
        assert graph_id == "g1"
        assert branch == "view/view_1"
        return existing

    create_calls: list = []

    async def fake_create(session, *, graph_id, name, from_commit_id, created_by):
        create_calls.append((graph_id, name, from_commit_id, created_by))
        return None

    monkeypatch.setattr(
        "backend.app.services.view_binding_service.graph_repo.get_branch_ref_or_none",
        fake_get,
    )
    monkeypatch.setattr(
        "backend.app.services.view_binding_service.graph_repo.create_branch",
        fake_create,
    )

    result = await ensure_branch(MagicMock(), view=v, user_id="alice")
    assert isinstance(result, ResolvedViewBinding)
    assert result.branch == "view/view_1"
    assert result.created_branch is False
    assert create_calls == []


@pytest.mark.asyncio
async def test_ensure_branch_creates_when_absent_forking_from_target(monkeypatch):
    v = _view()
    target_ref = SimpleNamespace(commit_id="gcmt_main_head", name="main")

    async def fake_get(session, *, graph_id, branch):
        if branch == "view/view_1":
            return None
        if branch == "main":
            return target_ref
        return None

    create_calls: list = []

    async def fake_create(session, *, graph_id, name, from_commit_id, created_by):
        create_calls.append((graph_id, name, from_commit_id, created_by))
        return SimpleNamespace(commit_id=from_commit_id, name=name)

    monkeypatch.setattr(
        "backend.app.services.view_binding_service.graph_repo.get_branch_ref_or_none",
        fake_get,
    )
    monkeypatch.setattr(
        "backend.app.services.view_binding_service.graph_repo.create_branch",
        fake_create,
    )

    result = await ensure_branch(MagicMock(), view=v, user_id="alice")
    assert result.created_branch is True
    assert result.branch == "view/view_1"
    assert create_calls == [("g1", "view/view_1", "gcmt_main_head", "alice")]


@pytest.mark.asyncio
async def test_ensure_branch_creates_from_genesis_when_target_absent(monkeypatch):
    v = _view()

    async def fake_get(*a, **k):
        return None  # neither view branch nor main exist (fresh graph)

    create_calls: list = []

    async def fake_create(session, *, graph_id, name, from_commit_id, created_by):
        create_calls.append((graph_id, name, from_commit_id, created_by))
        return SimpleNamespace(commit_id=from_commit_id, name=name)

    monkeypatch.setattr(
        "backend.app.services.view_binding_service.graph_repo.get_branch_ref_or_none",
        fake_get,
    )
    monkeypatch.setattr(
        "backend.app.services.view_binding_service.graph_repo.create_branch",
        fake_create,
    )

    result = await ensure_branch(MagicMock(), view=v, user_id="alice")
    assert result.created_branch is True
    assert create_calls == [("g1", "view/view_1", None, "alice")]
