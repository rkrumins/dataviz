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


class DraftNotReadable(AccessDenied):
    """READ_DRAFT (doc 13): the viewer may not read this draft. ``_domain_errors`` answers 404
    "unknown branch", the same as a branch that doesn't exist, so its existence doesn't leak."""


class NotDraftOwner(_HttpMapped, AccessDenied):
    """A write reached someone else's private draft. Only its owner writes it;
    workspace managers may read it, but not write it."""

    status_code = 403

    def __init__(self, branch_id: str, owner: Optional[str]):
        self.branch_id, self.owner = branch_id, owner
        super().__init__(f"draft {branch_id} belongs to {owner}",
                         {"type": "access_denied", "code": "not_draft_owner",
                          "branchId": branch_id, "owner": owner})


class DraftRoleRequired(_HttpMapped, AccessDenied):
    """A write reached a shared draft the actor is not a member of in a role
    that allows it: ``required`` names the role (editor, or maintainer to
    publish, abandon or manage members)."""

    status_code = 403

    def __init__(self, branch_id: str, required: str):
        self.branch_id, self.required = branch_id, required
        super().__init__(f"needs {required} access to shared draft {branch_id}",
                         {"type": "access_denied", "code": "not_owner_or_member",
                          "required": required, "branchId": branch_id})


class SelfReview(_HttpMapped, AccessDenied):
    """PR_REVIEW (doc 13): a PR's author, or its source draft's owner, approved it. An
    approval is someone else's review of the changes."""

    status_code = 403

    def __init__(self, pr_id: str):
        self.pr_id = pr_id
        super().__init__(f"the author or the draft's owner cannot approve pr {pr_id}",
                         {"type": "access_denied", "code": "self_review", "prId": pr_id})


class PublishRequired(_HttpMapped, AccessDenied):
    """A person without ``workspace:datasource:publish`` wrote a versioned graph's main directly
    (a graph route with no draft, or a bulk ingest), in person or with their API key."""

    status_code = 403

    def __init__(self):
        super().__init__("editing the published version needs publish permission; "
                         "start a draft to make these edits and send them for review",
                         {"type": "access_denied", "code": "publish_required",
                          "required": "workspace:datasource:publish"})


class GroupsUnavailable(_HttpMapped, RuntimeError):
    """The actor's groups could not be looked up, and a group decides their
    role on the draft. Never read as "no groups": that would refuse a member."""

    status_code = 503

    def __init__(self):
        super().__init__("couldn't check your groups; try again",
                         {"type": "groups_unavailable", "retryable": True}, {"Retry-After": "2"})


class IneligibleMember(_HttpMapped, RuntimeError):
    """Who was to be added to a draft cannot hold the role: the owner, an unknown user or
    group, or a user without the workspace access the role needs. A RuntimeError, so no
    ``except ValueError`` turns it into a 404."""

    status_code = 422
    _MESSAGES = {
        "owner": "the draft's owner already has full access",
        "unknown_user": "no such user",
        "unknown_group": "no such group",
        "no_read": "they can't read this workspace's data sources",
        "no_manage": "they can't edit this workspace's data sources, so they can only be a viewer",
    }

    def __init__(self, subject_id: str, reason: str):
        self.subject_id, self.reason = subject_id, reason
        super().__init__(f"can't add {subject_id}: {self._MESSAGES[reason]}",
                         {"type": "ineligible_member", "subjectId": subject_id, "reason": reason})


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


class NotAFork(_HttpMapped, RuntimeError):
    """A fork route reached a graph that fork_graph did not mint: a data source's graph, or a
    fork bound to a data source. Those go to the trash and back with their data source."""

    def __init__(self, graph_id: str):
        self.graph_id = graph_id
        super().__init__(f"graph {graph_id} is not a fork; it goes with its data source",
                         {"type": "not_a_fork", "graphId": graph_id})


class LiveForks(_HttpMapped, RuntimeError):
    """The graph still has live forks, which read its history."""

    def __init__(self, graph_id: str, forks: int):
        self.graph_id, self.forks = graph_id, forks
        super().__init__(f"{forks} live fork(s) read graph {graph_id}; delete them first",
                         {"type": "live_forks", "graphId": graph_id, "forks": forks})


class ForkNotRestorable(_HttpMapped, RuntimeError):
    """A trashed fork cannot come back: its purge is queued (``purging``), or its parent is
    gone (``parent_deleted``)."""

    def __init__(self, graph_id: str, reason: str):
        self.graph_id, self.reason = graph_id, reason
        super().__init__(f"fork {graph_id} cannot be restored: {reason}",
                         {"type": "fork_not_restorable", "graphId": graph_id, "reason": reason})


class GraphMoved(_HttpMapped, RuntimeError):
    """A data source's move found its versioned graph in neither the workspace it moves from nor
    the one it moves to: another move of the source got there first."""

    def __init__(self, graph_id: str):
        self.graph_id = graph_id
        super().__init__(f"graph {graph_id} has been moved to another workspace by another request",
                         {"type": "graph_moved", "graphId": graph_id})


class ProjectionNotAdopted(_HttpMapped, RuntimeError):
    """A projection move reached a key the platform has not adopted: the graph is unpinned
    (``unpinned``), or still projects into the customer's own FalkorDB graph (``customer_key``),
    which a move must never write or drop (doc 14 L2 moves owned keys only)."""

    def __init__(self, reason: str, message: str = "", **extra: Any):
        self.reason = reason
        super().__init__(message or f"this graph's projection cannot be moved: {reason}",
                         {"type": "projection_not_adopted", "reason": reason, **extra})


class ProjectionKeyInUse(_HttpMapped, RuntimeError):
    """The FalkorDB key a projection move targets already holds another graph's projection.
    Same type as ``BootstrapConflict``'s ``graph_key_in_use``."""

    def __init__(self, provider_id: str, key: str):
        self.provider_id, self.key = provider_id, key
        super().__init__(f"FalkorDB graph {key} on {provider_id} is already in use",
                         {"type": "graph_key_in_use", "providerId": provider_id, "key": key})


class ProjectionKeyInvalid(_HttpMapped, RuntimeError):
    """A projection move named a key that is neither this graph's own platform key
    (``gvp_<graphId>{<tag>.<n>}``) nor one of its retired keys."""

    status_code = 422

    def __init__(self, key: str):
        self.key = key
        super().__init__(f"{key} is not a FalkorDB key this graph can move to",
                         {"type": "invalid_target_key", "key": key})


class GraphNotWritable(_HttpMapped, RuntimeError):
    """A content write reached a graph that is not live: editing is paused (``frozen``), or it is
    in the trash (``trashed``) or being permanently deleted (``purging``). A state a later schema
    stores that this code has no words for is refused the same way. Not a ``ConcurrencyError``,
    which answers 'integrity', nor a ``ValueError``, which answers 404."""

    _MESSAGES = {
        "frozen": "Editing is paused on this graph. A publisher can resume it from the data "
                  "source's Version control tab. Your change was not saved.",
        "trashed": "This graph is in the trash. Restore its data source to change it.",
        "purging": "This graph is being permanently deleted.",
    }

    def __init__(self, state: str):
        self.state = state
        super().__init__(self._MESSAGES.get(state, "This graph can't be changed right now."),
                         {"type": "graph_not_writable", "state": state, "reason": state,
                          "retryable": False})


class VersionConflict(_HttpMapped, RuntimeError):
    """A compare-and-set named a version of ``resource`` that is no longer current."""

    def __init__(self, resource: str, current: int):
        self.resource, self.current = resource, current
        super().__init__(f"the {resource} has changed since you loaded it; reload and try again",
                         {"type": "version_conflict", "resource": resource,
                          "currentVersion": current})


HTTP_MAPPED = (BranchNotOpen, MainWriteForbidden, NotDraftOwner, DraftRoleRequired, SelfReview,
               GroupsUnavailable, IneligibleMember, HeadMoved, LockBusy, JobActive, CurationAtRisk,
               MassDeleteBlocked, ForkLimit, NotAFork, LiveForks, ForkNotRestorable, GraphMoved,
               ProjectionNotAdopted, ProjectionKeyInUse, ProjectionKeyInvalid, PublishRequired,
               GraphNotWritable, VersionConflict)
