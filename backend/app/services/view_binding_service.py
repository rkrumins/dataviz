"""View ↔ (graph, branch) binding service.

Implements the "view-as-branch" decisions from the plan:

- Every editable view binds to exactly one (graph_id, branch).
- Branch name is derived from the view's branching_policy:
    shared_main         -> view.merge_target_branch (typically 'main')
    per_view (default)  -> 'view/<view.id>'
    per_user_per_view   -> 'user/<uid>/view/<view.id>'
- The view's expected branch is materialised on first edit-mode entry
  (forked from merge_target_branch head); subsequent opens reuse it.
- `view_id` is stamped on every audit event produced through this
  view (handled by the commit path, which threads view_id through).

The service is pure orchestration over the existing repos:
- Reads the view from the **management** session.
- Reads the graph ref + creates branches in the **graph-store** session.
- Caller owns both transactions; the function only adds operations.

Edge cases the service guards against:

- View has no source_graph_id → ``ViewNotBoundError``.
- Caller requests a different branch than the policy resolves to →
  ``ViewBranchMismatchError`` (the endpoint maps to 422).
- Branching policy is unknown → ``ValueError`` (CHECK constraint
  should prevent at the DB layer; defence in depth here).
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories import graph_repo


class ViewBindingError(ValueError):
    """Base for view-binding failures the API maps to structured 422."""


class ViewNotBoundError(ViewBindingError):
    """View has no source_graph_id — not editable through the
    version-control path."""

    def __init__(self, view_id: str):
        self.view_id = view_id
        super().__init__(
            f"view {view_id!r} has no source_graph_id; not bound to a "
            "versioned graph"
        )


class ViewBranchMismatchError(ViewBindingError):
    """Caller requested a branch that disagrees with the view's policy."""

    def __init__(self, view_id: str, expected: str, actual: str):
        self.view_id = view_id
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"view {view_id!r} policy resolves to branch {expected!r}; "
            f"caller requested {actual!r}"
        )


@dataclass(frozen=True)
class ResolvedViewBinding:
    """The result of resolving a view's edit-mode binding."""

    view_id: str
    graph_id: str
    branch: str
    branching_policy: str
    merge_target_branch: str
    created_branch: bool   # True if this call materialised the branch


def resolve_branch(view: ViewORM, user_id: str) -> str:
    """Pure: derive the branch name for *view* + *user_id* per the
    view's branching_policy. No I/O."""
    policy = view.branching_policy or "per_view"
    if policy == "shared_main":
        return view.merge_target_branch or "main"
    if policy == "per_view":
        return f"view/{view.id}"
    if policy == "per_user_per_view":
        if not user_id:
            raise ValueError(
                "per_user_per_view requires a non-empty user_id"
            )
        return f"user/{user_id}/view/{view.id}"
    raise ValueError(f"unknown branching_policy {policy!r}")


async def ensure_branch(
    graph_store_session: AsyncSession,
    *,
    view: ViewORM,
    user_id: str,
) -> ResolvedViewBinding:
    """Resolve the view's branch; if it doesn't exist on the graph,
    create it forked from ``view.merge_target_branch`` head. Idempotent
    — re-running on an already-bound view is a no-op fast path. Caller
    must update ``view.source_branch`` on the management session if it
    differs from the resolved name (this function does not write to
    the management DB).
    """
    if not view.source_graph_id:
        raise ViewNotBoundError(view.id)

    branch = resolve_branch(view, user_id)
    merge_target = view.merge_target_branch or "main"

    # Fast path: branch already exists.
    existing = await graph_repo.get_branch_ref_or_none(
        graph_store_session,
        graph_id=view.source_graph_id,
        branch=branch,
    )
    if existing is not None:
        return ResolvedViewBinding(
            view_id=view.id,
            graph_id=view.source_graph_id,
            branch=branch,
            branching_policy=view.branching_policy or "per_view",
            merge_target_branch=merge_target,
            created_branch=False,
        )

    # Branch is not yet materialised — fork from merge_target's head.
    # If the merge target doesn't exist either (fresh graph), the fork
    # is from genesis (None).
    base_ref = await graph_repo.get_branch_ref_or_none(
        graph_store_session,
        graph_id=view.source_graph_id,
        branch=merge_target,
    )
    from_commit_id = base_ref.commit_id if base_ref else None
    await graph_repo.create_branch(
        graph_store_session,
        graph_id=view.source_graph_id,
        name=branch,
        from_commit_id=from_commit_id,
        created_by=user_id,
    )
    return ResolvedViewBinding(
        view_id=view.id,
        graph_id=view.source_graph_id,
        branch=branch,
        branching_policy=view.branching_policy or "per_view",
        merge_target_branch=merge_target,
        created_branch=True,
    )


def assert_branch_matches_view(
    view: ViewORM, *, user_id: str, branch: str
) -> None:
    """Guard that a caller-supplied branch matches the view's policy
    so a malicious or stale client cannot commit under a view's
    audit context onto an unrelated branch."""
    expected = resolve_branch(view, user_id)
    if branch != expected:
        raise ViewBranchMismatchError(view.id, expected, branch)


__all__ = [
    "ViewBindingError",
    "ViewNotBoundError",
    "ViewBranchMismatchError",
    "ResolvedViewBinding",
    "resolve_branch",
    "ensure_branch",
    "assert_branch_matches_view",
]
