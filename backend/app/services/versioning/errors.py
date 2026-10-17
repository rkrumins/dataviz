"""Versioning errors that carry their own HTTP answer.

Each class names its status, the JSON ``detail`` the client reads, and any
headers. Every router maps them the same way: ``versioning._domain_errors``
maps :data:`HTTP_MAPPED` before its other clauses (``BranchNotOpen`` is a
``ValueError``, which that context manager otherwise answers with 404), and
``main.py`` registers a handler for each class, for the routes that do not use
that context manager (provider-backed graph writes, ContextEngine paths).

The module imports nothing, so any versioning module can raise these.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


class _HttpMapped(Exception):
    status_code: int = 409

    def __init__(self, message: str, detail: Dict[str, Any],
                 headers: Optional[Dict[str, str]] = None):
        super().__init__(message)
        self.detail = {**detail, "message": message}
        self.headers = headers


class BranchNotOpen(_HttpMapped, ValueError):
    """A write, checkpoint, pull or publish reached a draft that is merged,
    abandoned or being published. Its edits could never reach main."""

    def __init__(self, branch_id: str, status: str):
        self.branch_id, self.status = branch_id, status
        super().__init__(f"branch {branch_id} is {status}",
                         {"type": "branch_closed", "status": status, "branchId": branch_id})


class MainWriteForbidden(_HttpMapped, ValueError):
    """A route that writes drafts was handed main. Main changes only by
    publish, merge, revert, restore or an import job."""

    def __init__(self, message: str = "edits go to a draft; main changes only by publishing it"):
        super().__init__(message, {"type": "main_write_forbidden"})


class AccessDenied(RuntimeError):
    """Actor lacks the branch role required for an operation on a draft."""


class NotDraftOwner(_HttpMapped, AccessDenied):
    """A write reached someone else's private draft. Only its owner writes it;
    workspace managers may read it, but not write it."""

    status_code = 403

    def __init__(self, branch_id: str, owner: Optional[str]):
        self.branch_id, self.owner = branch_id, owner
        super().__init__(f"draft {branch_id} belongs to {owner}",
                         {"type": "access_denied", "code": "not_draft_owner",
                          "branchId": branch_id, "owner": owner})


class HeadMoved(_HttpMapped, RuntimeError):
    """An approval named the head the reviewer saw, and the draft has moved on
    since: what they approved is not what would merge."""

    def __init__(self, pr_id: str, head_commit_id: Optional[str]):
        self.pr_id, self.head_commit_id = pr_id, head_commit_id
        super().__init__(f"pr {pr_id} has changed since it was reviewed",
                         {"type": "head_moved", "prId": pr_id, "headCommitId": head_commit_id})


class LockBusy(_HttpMapped, RuntimeError):
    """A graph or draft lock was not granted within the lock timeout."""

    status_code = 503

    def __init__(self, message: str = "the graph is busy; try again", retry_after: int = 2):
        super().__init__(message, {"type": "lock_busy", "retryable": True},
                         {"Retry-After": str(retry_after)})


class ContentionExhausted(LockBusy):
    """Every retry of a write lost to a concurrent writer."""

    def __init__(self, message: str = "the graph is busy; try again", retry_after: int = 2):
        super().__init__(message, retry_after)


class JobActive(_HttpMapped, RuntimeError):
    """Another job of the same kind is already running on this branch.
    Same shape as ``BootstrapConflict``'s ``job_active``."""

    def __init__(self, job_id: str, message: str = "a job is already running on this branch"):
        self.job_id = job_id
        super().__init__(message, {"type": "job_active", "jobId": job_id})


class CurationAtRisk(_HttpMapped, RuntimeError):
    """A re-sync would treat people's edits on main as drift and undo them."""

    def __init__(self, message: str, last_human_commit: Optional[Dict[str, Any]] = None):
        super().__init__(message, {"type": "curation_at_risk",
                                   "lastHumanCommit": last_human_commit})


class MassDeleteBlocked(_HttpMapped, RuntimeError):
    """A re-sync would delete more of the graph than the configured limit."""

    def __init__(self, deletes: int, limit: int, message: str, live: Optional[int] = None):
        self.deletes, self.limit = deletes, limit
        super().__init__(message, {"type": "mass_delete_blocked", "deletes": deletes,
                                   "live": live, "limit": limit})


class ForkLimit(_HttpMapped, RuntimeError):
    """The graph already has as many live forks as the configured limit."""

    def __init__(self, limit: int):
        self.limit = limit
        super().__init__(f"this graph already has {limit} forks; delete one to fork it again",
                         {"type": "fork_limit", "limit": limit})


HTTP_MAPPED = (BranchNotOpen, MainWriteForbidden, NotDraftOwner, HeadMoved, LockBusy, JobActive,
               CurationAtRisk, MassDeleteBlocked, ForkLimit)
