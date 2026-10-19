"""Moving a data source — with its views, version history, rollups and access — to another workspace.

A data source used to change workspace only when nothing was built on it, and for a sound
reason: the views on it name their workspace too. Move the source alone and its views keep
reading it from a workspace it no longer lives in, through an access check that no longer
describes it. So everything that names the source's workspace moves with it, in one step that
can be put back:

* the source row, and every view on it — trashed ones too (restoring one later must not strand
  it in the old workspace), and the views with no source of their own that read it as the old
  workspace's default (left behind, they would silently re-point at a different graph);
* each moved view's activity history, so the old workspace's feed stops listing views it no
  longer holds;
* the versioned graph and every job run on it, in the version store, FIRST — that store can be
  a separate database, so if the rest fails the graph is put back (:func:`_execute`);
* the aggregation state, so drift and reconciliation invalidate the right caches.

Access. Owners, and the people and teams a view is shared with, keep it wherever it lives.
Views shared with the whole workspace switch audience to the new workspace's members; the mover
chooses which of the people and teams losing them keep view-only access to exactly those views
— a grant, never a membership, so nothing else in the new workspace opens to them.

Two ways to move. Someone who administers both workspaces moves it directly. Someone who
administers only the source asks, and the destination's admins accept (which runs the same
move) or decline. The proposer decides who keeps access; the reviewer sees a fresh preview and
what changed since the ask. A move can be undone for :data:`UNDO_DAYS` while it is the source's
latest and nothing new has been built on it in its new home.

Every read is :func:`preflight`, shared by the preview and the move itself, so what a person
confirmed is what happens — and the preview's ``token`` refuses a move whose picture changed
after it was read rather than doing something nobody saw.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.common.activity_context import current_provenance
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db import advisory
from backend.app.db.models import (
    CatalogItemORM,
    ContextModelORM,
    DataSourceTransferORM,
    GroupMemberORM,
    GroupORM,
    ProviderORM,
    ResourceGrantORM,
    RoleBindingORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    view_is_live,
)
from backend.app.db.repositories import (
    data_source_repo,
    data_source_transfer_repo as transfer_repo,
    notification_repo,
    role_repo,
    view_activity_repo,
)
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.services import workspace_access
from backend.app.services.activity import recorder
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
    AggregationJobORM,
)
from backend.app.services.feature_flags import feature_flags
from backend.app.services.node_identity import load_node_identity
from backend.app.services.permission_service import PermissionClaims, has_permission, resolve
from backend.app.services.versioning import lifecycle
from backend.common.models.management import (
    DataSourceMoveRequest,
    DataSourceTransferDetail,
    DataSourceTransferResponse,
    ImpactedEntity,
    TransferAccess,
    TransferChanges,
    TransferDestination,
    TransferIdentity,
    TransferIssue,
    TransferPersonRef,
    TransferPreview,
    TransferPrimary,
    TransferSubject,
    TransferSubjectRef,
    TransferVersioning,
    TransferView,
    TransferViewCounts,
    TransferWorkspaceRef,
)

logger = logging.getLogger(__name__)

#: How long the destination's admins have to answer a request.
REQUEST_DAYS = 14
#: How long a move can be undone for.
UNDO_DAYS = 7
#: Preview rows past this are counted, not listed.
_VIEW_LIST_CAP = 500
#: Rows per IN (...) when rewriting by id.
_CHUNK = 500
#: How long a retried move or answer, whose first try went through but whose response was lost,
#: is given that result rather than an error.
_REPLAY_WINDOW = timedelta(minutes=10)

_ADMIN = "workspace:admin"
_MANAGE = "workspace:datasource:manage"
#: A role that carries any of these reads every workspace-shared view in its workspace.
_READS_VIEWS = frozenset({"workspace:view:read", "workspace:view:*", _ADMIN})
_DIRECTORY_FLAG = "workspaceDirectoryEnabled"


# ── small helpers ────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        value = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _recent(ts: Optional[str]) -> bool:
    when = _parse(ts)
    return when is not None and datetime.now(timezone.utc) - when <= _REPLAY_WINDOW


def _answered_by(row: DataSourceTransferORM, user_id: str, answer: str) -> bool:
    """The same answer from the same person, again: a retry whose first try went through."""
    at = row.undone_at if answer == "undone" else row.resolved_at
    by = row.undone_by if answer == "undone" else row.resolved_by
    return row.status == answer and by == user_id and _recent(at)


def _load(raw: Optional[str]) -> dict:
    try:
        value = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _chunks(ids: list[str]) -> Iterable[list[str]]:
    for i in range(0, len(ids), _CHUNK):
        yield ids[i:i + _CHUNK]


def _label(ds: WorkspaceDataSourceORM) -> str:
    return ds.label or ds.graph_name or ds.id


def _plural(n: int, one: str, many: Optional[str] = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _issue(code: str, message: str, severity: str = "info", *, transient: bool = False,
           items: Optional[list[ImpactedEntity]] = None) -> TransferIssue:
    return TransferIssue(code=code, message=message, severity=severity, transient=transient,
                         items=items or [])


def _conflict(error: str, message: str, issues: Optional[list[TransferIssue]] = None) -> HTTPException:
    detail: dict = {"error": error, "message": message}
    if issues:
        detail["issues"] = [i.model_dump() for i in issues]
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _refuse(blockers: list[TransferIssue]) -> None:
    if blockers:
        raise _conflict("blocked", blockers[0].message, blockers)


def _is_admin(claims: PermissionClaims, ws_id: str) -> bool:
    return has_permission(claims, _ADMIN, workspace_id=ws_id)


async def _deny(session: AsyncSession, user_id: str, permission: str, ws_id: str, message: str):
    """A refusal shaped like ``requires()``'s, and audited like one."""
    from backend.app.auth.dependencies import _audit_access_denied

    scope = {"type": "workspace", "id": ws_id}
    await _audit_access_denied(session, user_id=user_id, permission=permission, scope_obj=scope)
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error": "missing_permission", "permission": permission, "scope": scope,
                "message": message},
    )


async def _live_workspace(session: AsyncSession, ws_id: str) -> WorkspaceORM:
    ws = (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == ws_id, WorkspaceORM.deleted_at.is_(None))
    )).scalar_one_or_none()
    if ws is None:
        raise HTTPException(status_code=404, detail=f"Workspace '{ws_id}' not found")
    return ws


async def _lock_live(session: AsyncSession, ds_id: str) -> Optional[WorkspaceDataSourceORM]:
    """The live data source, its row locked for the rest of the transaction — or None."""
    return (await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.id == ds_id, WorkspaceDataSourceORM.deleted_at.is_(None))
        .with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def source_in(session: AsyncSession, ds_id: str, ws_id: str, *,
                    lock: bool = False) -> WorkspaceDataSourceORM:
    """The live data source ``ds_id`` in workspace ``ws_id``, or 404. ``lock`` takes its row
    for the rest of the transaction: moves, undos, accepts and deletes of one source queue."""
    stmt = select(WorkspaceDataSourceORM).where(
        WorkspaceDataSourceORM.id == ds_id, WorkspaceDataSourceORM.deleted_at.is_(None))
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    ds = (await session.execute(stmt)).scalar_one_or_none()
    if ds is None or ds.workspace_id != ws_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    return ds


# ── what a move takes with it ────────────────────────────────────────


@dataclass
class _View:
    id: str
    name: str
    visibility: str
    created_by: Optional[str]
    trashed: bool
    follows_default: bool
    publish_requested: bool
    context_model_id: Optional[str]
    #: Waiting in a draft to go live: it moves with the source (its draft does too), but no one
    #: else sees it until the draft is published.
    staged: bool = False

    @property
    def live(self) -> bool:
        return not self.trashed and not self.staged


@dataclass
class _Loser:
    """A person or team who reads moved views today and would lose them."""
    type: str
    id: str
    role: str
    views: list[str]
    name: str = ""
    email: Optional[str] = None
    member_count: Optional[int] = None


@dataclass
class Preflight:
    ds: WorkspaceDataSourceORM
    source: WorkspaceORM
    target: WorkspaceORM
    views: list[_View]
    mode: Optional[str]
    blockers: list[TransferIssue]
    notes: list[TransferIssue]
    losers: dict[tuple[str, str], _Loser]
    counts: dict
    was_primary: bool
    was_default: bool
    becomes_primary: bool
    pin_destination_default: Optional[str]
    pin_destination_label: Optional[str]
    identity_pin: dict
    facts: Optional[dict]
    token: str = ""
    reach_b: set = field(default_factory=set)

    @property
    def has_views(self) -> bool:
        return bool(self.views)

    @property
    def view_ids(self) -> list[str]:
        return [v.id for v in self.views]


async def _views_on(session: AsyncSession, ds: WorkspaceDataSourceORM,
                    was_default: bool) -> list[_View]:
    """Every view that moves: those on the source (trashed ones too) and, when the source is its
    workspace's default, the views with no source of their own — they read it today."""
    cols = (ViewORM.id, ViewORM.name, ViewORM.visibility, ViewORM.created_by, ViewORM.deleted_at,
            ViewORM.publish_requested_at, ViewORM.context_model_id, ViewORM.draft_branch_id)
    rows = [(r, False) for r in (await session.execute(
        select(*cols).where(ViewORM.data_source_id == ds.id).order_by(ViewORM.name)
    )).all()]
    if was_default:
        rows += [(r, True) for r in (await session.execute(
            select(*cols).where(
                ViewORM.workspace_id == ds.workspace_id, ViewORM.data_source_id.is_(None),
            ).order_by(ViewORM.name)
        )).all()]
    return [
        _View(id=r[0], name=r[1], visibility=r[2] or "private", created_by=r[3],
              trashed=r[4] is not None, follows_default=follows,
              publish_requested=r[5] is not None, context_model_id=r[6],
              staged=r[7] is not None)
        for r, follows in rows
    ]


async def _org_wide_people(session: AsyncSession) -> set[str]:
    people: set[str] = set()
    for perm in workspace_access.ORG_WIDE_PERMISSIONS:
        people |= await notification_repo.users_with_global_permission(session, perm)
    return people


async def _access_plan(
    session: AsyncSession, source_id: str, target_id: str, live: list[_View],
) -> tuple[dict[tuple[str, str], _Loser], dict, set[str]]:
    """Who reads the moved views today and would not after: ``(losers, counts, reach_b)``.

    Only views shared with the whole workspace change audience. Private views stay with their
    owners and the people they're shared with, published ones with everyone; explicit grants
    are keyed by view and keep working wherever the view lives. ``reach_b`` is everyone who can
    open the destination (directly, through a team, or by an organization-wide role).
    """
    shared_ws = [v for v in live if v.visibility == "workspace"]
    grants: dict[str, set[tuple[str, str]]] = {}
    live_ids = [v.id for v in live]
    for chunk in _chunks(live_ids):
        for rid, st, sid in (await session.execute(
            select(ResourceGrantORM.resource_id, ResourceGrantORM.subject_type,
                   ResourceGrantORM.subject_id)
            .where(ResourceGrantORM.resource_type == "view", ResourceGrantORM.resource_id.in_(chunk))
        )).all():
            grants.setdefault(rid, set()).add((st, sid))

    now = datetime.now(timezone.utc)
    bindings = [
        b for b in (await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.scope_type == "workspace",
                RoleBindingORM.scope_id.in_([source_id, target_id]),
            )
        )).scalars().all()
        if not _is_expired(b.expires_at, now=now)
    ]
    perms = await role_repo.role_names_with_permissions(session, sorted({b.role_name for b in bindings}))
    readers = {r for r, ps in perms.items() if _READS_VIEWS & set(ps)}
    in_a = [b for b in bindings if b.scope_id == source_id and b.role_name in readers]
    in_b = [b for b in bindings if b.scope_id == target_id]

    group_ids = (
        {b.subject_id for b in in_a + in_b if b.subject_type == "group"}
        | {sid for subjects in grants.values() for st, sid in subjects if st == "group"}
    )
    members: dict[str, set[str]] = {}
    user_groups: dict[str, set[str]] = {}
    group_names: dict[str, str] = {}
    if group_ids:
        live_groups = {gid: name for gid, name in (await session.execute(
            select(GroupORM.id, GroupORM.name)
            .where(GroupORM.id.in_(sorted(group_ids)), GroupORM.deleted_at.is_(None))
        )).all()}
        group_names.update(live_groups)
        if live_groups:
            for gid, uid in (await session.execute(
                select(GroupMemberORM.group_id, GroupMemberORM.user_id)
                .where(GroupMemberORM.group_id.in_(sorted(live_groups)))
            )).all():
                members.setdefault(gid, set()).add(uid)
                user_groups.setdefault(uid, set()).add(gid)

    b_groups = {b.subject_id for b in in_b if b.subject_type == "group"}
    b_users = {b.subject_id for b in in_b if b.subject_type == "user"}
    for gid in b_groups:
        b_users |= members.get(gid, set())
    b_reader_groups = {b.subject_id for b in in_b if b.subject_type == "group" and b.role_name in readers}
    b_readers = {b.subject_id for b in in_b if b.subject_type == "user" and b.role_name in readers}
    for gid in b_reader_groups:
        b_readers |= members.get(gid, set())
    org_wide = await _org_wide_people(session)

    losers: dict[tuple[str, str], _Loser] = {}
    for b in in_a:
        key = (b.subject_type, b.subject_id)
        if key in losers or not shared_ws:
            continue
        if b.subject_type == "group":
            if b.subject_id in b_reader_groups or b.subject_id not in group_names:
                continue
            lost = [v.id for v in shared_ws if key not in grants.get(v.id, ())]
        else:
            uid = b.subject_id
            if uid in b_readers or uid in org_wide:
                continue
            via = {("group", g) for g in user_groups.get(uid, ())}
            lost = [
                v.id for v in shared_ws
                if v.created_by != uid and not ({key} | via) & grants.get(v.id, set())
            ]
        if lost:
            losers[key] = _Loser(type=b.subject_type, id=b.subject_id,
                                 role=workspace_access.role_label(b.role_name), views=lost)

    # Names, in one query per kind.
    user_ids = sorted(i for t, i in losers if t == "user")
    if user_ids:
        for uid, first, last, email in (await session.execute(
            select(UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email)
            .where(UserORM.id.in_(user_ids))
        )).all():
            loser = losers[("user", uid)]
            loser.name = " ".join(p for p in (first, last) if p).strip() or email
            loser.email = email
    for (t, i), loser in losers.items():
        if t == "group":
            loser.name = group_names.get(i, "A team")
            loser.member_count = len(members.get(i, ()))
        elif not loser.name:
            loser.name = "A former member"

    counts = {
        "creators": len({v.created_by for v in live if v.created_by}),
        "sharedWith": len(set().union(*grants.values())) if grants else 0,
        "everyone": sum(1 for v in live if v.visibility == "enterprise"),
        "gainsPeople": len(b_readers) if shared_ws else 0,
        "gainsViews": len(shared_ws),
        "adminViews": sum(1 for v in live if v.visibility == "private"),
    }
    return losers, counts, b_users | org_wide


async def _connected_in(session: AsyncSession, ds: WorkspaceDataSourceORM, ws_id: str) -> bool:
    """Whether ``ws_id`` already holds this source's graph (one per workspace, live rows)."""
    if not (ds.provider_id and ds.graph_name):
        return False
    return (await session.execute(
        select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.workspace_id == ws_id,
            WorkspaceDataSourceORM.provider_id == ds.provider_id,
            WorkspaceDataSourceORM.graph_name == ds.graph_name,
            WorkspaceDataSourceORM.deleted_at.is_(None),
            WorkspaceDataSourceORM.id != ds.id,
        ).limit(1)
    )).first() is not None


def _permits(raw: Optional[str], ws_id: str) -> bool:
    try:
        allowed = json.loads(raw or '["*"]')
    except (TypeError, ValueError):
        allowed = ["*"]
    if not isinstance(allowed, list):
        return True
    return "*" in allowed or ws_id in allowed


async def _permitted_list(session: AsyncSession, ds: WorkspaceDataSourceORM) -> list[Optional[str]]:
    """The ``permitted_workspaces`` lists that bind this source: its provider's and its catalog
    entry's (a source may live only where both allow it)."""
    lists: list[Optional[str]] = []
    if ds.provider_id:
        lists.append(await session.scalar(
            select(ProviderORM.permitted_workspaces).where(ProviderORM.id == ds.provider_id)))
    if ds.catalog_item_id:
        lists.append(await session.scalar(
            select(CatalogItemORM.permitted_workspaces).where(CatalogItemORM.id == ds.catalog_item_id)))
    return lists


async def _aggregation_active(session: AsyncSession, ds_id: str) -> bool:
    return (await session.execute(
        select(AggregationJobORM.id).where(
            AggregationJobORM.data_source_id == ds_id,
            AggregationJobORM.status.in_(("pending", "running")),
        ).limit(1)
    )).first() is not None


def _job_words(types: list[str]) -> str:
    words = {"bootstrap": "turning on version control", "export": "an export",
             "ingest": "an import", "publish": "a publish", "purge": "a purge",
             "projection": "a projection", "rebuild": "a rebuild",
             "package_inspect": "a package check"}
    return ", ".join(words.get(t, t) for t in types)


async def _destination_blockers(
    session: AsyncSession, ds: WorkspaceDataSourceORM, target: WorkspaceORM,
) -> tuple[list[TransferIssue], Optional[dict]]:
    """What stops this source going to ``target`` right now — the half of the preflight a move
    and an undo share — and the version store's facts about it."""
    blockers: list[TransferIssue] = []
    if not target.is_active:
        blockers.append(_issue(
            "destination_unavailable", f"{target.name} is switched off, so it can't take data sources.",
            "blocker"))
    if await _connected_in(session, ds, target.id):
        blockers.append(_issue(
            "already_connected", f"{target.name} already has this graph connected.", "blocker"))
    if not all(_permits(raw, target.id) for raw in await _permitted_list(session, ds)):
        blockers.append(_issue(
            "not_permitted",
            f"This source's provider or catalog entry isn't permitted in {target.name}.", "blocker"))
    if await _aggregation_active(session, ds.id):
        blockers.append(_issue(
            "aggregation_running",
            "An aggregation run is in progress on this source. Move it once the run finishes.",
            "blocker", transient=True))
    facts = None
    try:
        facts = await lifecycle.relocation_facts(ds.id)
    except Exception:
        logger.exception("version store unavailable while checking a move of %s", ds.id)
        blockers.append(_issue(
            "version_store_unavailable",
            "The version store isn't answering, so the version history can't be checked. "
            "Try again shortly.",
            "blocker", transient=True))
    else:
        if facts and facts.get("activeJobs"):
            blockers.append(_issue(
                "graph_busy",
                f"Version history is being written right now ({_job_words(facts['activeJobs'])}). "
                "Move it once that finishes.",
                "blocker", transient=True))
    return blockers, facts


def _token(target_id: str, views: list[_View], losers: dict, was_default: bool,
           becomes_primary: bool, pin_dest: Optional[str], identity_pin: dict) -> str:
    """A fingerprint of everything a reviewer must re-read if it changes."""
    material = json.dumps({
        "to": target_id,
        "views": sorted(v.id for v in views),
        "losers": sorted([t, i, sorted(loser.views)] for (t, i), loser in losers.items()),
        "primary": [was_default, becomes_primary, pin_dest],
        "identity": sorted(identity_pin.items()),
    }, sort_keys=True)
    return hashlib.sha256(material.encode()).hexdigest()[:16]


async def preflight(
    session: AsyncSession,
    *,
    ds: WorkspaceDataSourceORM,
    to_ws_id: str,
    claims: PermissionClaims,
    purpose: Optional[str] = None,
    transfer: Optional[DataSourceTransferORM] = None,
) -> Preflight:
    """Everything a move of ``ds`` to ``to_ws_id`` would do, and everything in its way, without
    changing anything.

    ``purpose`` is ``'move'``, ``'propose'`` or ``'accept'`` (with ``transfer``); ``None`` is a
    preview, which reads the purpose from what the caller may do.
    """
    source = await _live_workspace(session, ds.workspace_id)
    target = await _live_workspace(session, to_ws_id)
    if transfer is None and not await _can_see(session, claims, target):
        # A preview names the workspace, its sources and its people: someone who couldn't find
        # the workspace gets the answer they would for one that isn't there.
        raise HTTPException(status_code=404, detail=f"Workspace '{to_ws_id}' not found")
    if target.id == source.id:
        raise HTTPException(
            status_code=422,
            detail={"error": "same_workspace", "message": "The data source is already in this workspace."})

    defaults = await data_source_repo.default_data_source_ids(session, [source.id, target.id])
    was_default = defaults.get(source.id) == ds.id
    views = await _views_on(session, ds, was_default)
    need = _ADMIN if views else _MANAGE
    direct = (has_permission(claims, need, workspace_id=source.id)
              and has_permission(claims, need, workspace_id=target.id))
    mode = "direct" if direct else ("request" if _is_admin(claims, source.id) else None)
    effective = purpose or {"direct": "move", "request": "propose"}.get(mode or "")

    blockers, facts = await _destination_blockers(session, ds, target)
    notes: list[TransferIssue] = []

    pending = await transfer_repo.pending_for_source(session, ds.id)
    if pending is not None and (transfer is None or pending.id != transfer.id):
        if effective == "propose":
            blockers.append(_issue(
                "request_waiting",
                "A request to move it is already waiting for an answer. Cancel it to ask again.",
                "blocker"))
        else:
            notes.append(_issue(
                "request_will_cancel",
                "A request to move it elsewhere is waiting; moving it now cancels that request.",
                "warning"))

    if effective == "accept" and transfer is not None:
        if ds.workspace_id != transfer.from_workspace_id:
            blockers.append(_issue(
                "moved_since", "The data source has moved since this request was made.", "blocker"))
        proposer_admin = False
        if transfer.created_by:
            with contextlib.suppress(Exception):
                proposer_admin = _is_admin(await resolve(session, transfer.created_by), source.id)
        if not proposer_admin:
            blockers.append(_issue(
                "proposer_left",
                f"The person who asked no longer administers {source.name}, so the request "
                "can't go ahead.",
                "blocker"))
    elif purpose is None and mode is None:
        blockers.append(_issue(
            "not_allowed",
            f"Moving this source, or asking to, takes administering {source.name}.", "blocker"))

    live = [v for v in views if v.live]
    losers, counts, reach_b = await _access_plan(session, source.id, target.id, live)

    # The source's place as a default, on both sides.
    was_primary = bool(ds.is_primary)
    b_default = defaults.get(target.id)
    # Primary only where nothing else is flagged (even a paused source): two flags would break
    # every lookup that expects one.
    becomes_primary = b_default is None and not await session.scalar(
        select(func.count()).select_from(WorkspaceDataSourceORM).where(
            WorkspaceDataSourceORM.workspace_id == target.id,
            WorkspaceDataSourceORM.is_primary == True,  # noqa: E712
            WorkspaceDataSourceORM.deleted_at.is_(None),
        ))
    pin_dest = pin_label = None
    if b_default is not None and ds.is_active:
        current = (await session.execute(
            select(WorkspaceDataSourceORM).where(WorkspaceDataSourceORM.id == b_default)
        )).scalar_one_or_none()
        if current is not None and not current.is_primary and ds.created_at < current.created_at:
            # Unflagged, the older source would take over as the destination's default and
            # re-point its views with no source of their own. Flag the current one instead.
            pin_dest, pin_label = current.id, _label(current)

    # Would the destination name this source's entities differently?
    identity_pin: dict = {}
    before = await load_node_identity(session, ds)
    after = await load_node_identity(session, ds, workspace_id=target.id)
    if ds.identity_property is None and before.identity_property != after.identity_property:
        identity_pin["identity_property"] = before.identity_property
    if ds.name_property is None and before.name_property != after.name_property:
        identity_pin["name_property"] = before.name_property

    # ── notes: what the mover should know ──
    trashed = [v for v in views if v.trashed]
    if trashed:
        notes.append(_issue(
            "trash", f"{_plural(len(trashed), 'view')} in the trash "
                     f"{'moves' if len(trashed) == 1 else 'move'} too, so restoring "
                     f"{'it' if len(trashed) == 1 else 'one'} later finds it next to its source."))
    follows = [v for v in views if v.follows_default]
    if follows:
        one = len(follows) == 1
        notes.append(_issue(
            "follows_default",
            f"{_plural(len(follows), 'view')} with no source of {'its' if one else 'their'} own "
            f"{'reads' if one else 'read'} this one as {source.name}'s default. "
            f"{'It is' if one else 'They are'} pinned to it and "
            f"{'moves' if one else 'move'} with it.", "warning",
            items=[ImpactedEntity(id=v.id, name=v.name, type="view") for v in follows[:20]]))
    remaining = await session.scalar(
        select(func.count()).select_from(WorkspaceDataSourceORM).where(
            WorkspaceDataSourceORM.workspace_id == source.id,
            WorkspaceDataSourceORM.deleted_at.is_(None),
            WorkspaceDataSourceORM.id != ds.id,
        )) or 0
    if not remaining:
        notes.append(_issue(
            "last_source", f"{source.name} will have no data sources left.", "warning"))
    elif was_primary:
        notes.append(_issue(
            "primary_leaves",
            f"It's {source.name}'s primary source. {source.name} won't have one until someone "
            "picks one."))
    if facts:
        reach_ok = reach_b | {""}
        out = [d for d in facts.get("openDrafts") or [] if d.get("owner") and d["owner"] not in reach_ok]
        if out:
            named = await _person_names(session, {d["owner"] for d in out})
            one = len(out) == 1
            notes.append(_issue(
                "drafts_out_of_reach",
                f"{_plural(len(out), 'open draft')} "
                f"{'belongs to someone' if one else 'belong to people'} who can't open "
                f"{target.name}. They'll need adding there to finish {'it' if one else 'them'}.",
                "warning",
                items=[ImpactedEntity(id=d["id"], name=f"{d['name']} — {named.get(d['owner'], 'a former member')}",
                                      type="draft") for d in out[:20]]))
        reviews = facts.get("openReviews") or 0
        if reviews:
            notes.append(_issue(
                "reviews", f"{_plural(reviews, 'open review')} {'moves' if reviews == 1 else 'move'} "
                           f"with it and {'is' if reviews == 1 else 'are'} answered in {target.name}."))
        forks = facts.get("forks") or 0
        if forks:
            notes.append(_issue(
                "forks", f"{_plural(forks, 'fork')} of its version history "
                         f"{'stays' if forks == 1 else 'stay'} in {source.name}."))
    asked = [v for v in live if v.publish_requested]
    if asked:
        notes.append(_issue(
            "publish_requests",
            f"{_plural(len(asked), 'request')} to publish a view will go to {target.name}'s "
            "publishers instead.",
            items=[ImpactedEntity(id=v.id, name=v.name, type="view") for v in asked[:20]]))
    published = [v for v in live if v.visibility == "enterprise"]
    if published:
        strict = (target.publish_policy or "open") != "open"
        notes.append(_issue(
            "published_views",
            f"{_plural(len(published), 'view')} published to everyone stay"
            f"{'s' if len(published) == 1 else ''} published."
            + (f" {target.name} asks for approval to publish; "
               f"{'it was' if len(published) == 1 else 'they were'} published under "
               f"{source.name}'s rules." if strict else ""),
            "warning" if strict else "info"))
    template_ids = sorted({v.context_model_id for v in live if v.context_model_id})
    if template_ids:
        local = (await session.execute(
            select(ContextModelORM.id, ContextModelORM.name).where(
                ContextModelORM.id.in_(template_ids),
                ContextModelORM.is_template == True,  # noqa: E712
                ContextModelORM.visibility == "workspace",
                ContextModelORM.workspace_id == source.id,
                ContextModelORM.deleted_at.is_(None),
            )
        )).all()
        if local:
            notes.append(_issue(
                "templates",
                f"Some views use {_plural(len(local), 'layout template')} shared only in "
                f"{source.name}. The views keep working, but people in {target.name} can't open "
                f"{'that template' if len(local) == 1 else 'those templates'}.",
                "warning", items=[ImpactedEntity(id=i, name=n, type="template") for i, n in local]))
    if ds.ontology_id:
        others = await session.scalar(
            select(func.count()).select_from(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.ontology_id == ds.ontology_id,
                WorkspaceDataSourceORM.id != ds.id,
                WorkspaceDataSourceORM.deleted_at.is_(None),
            )) or 0
        if others:
            notes.append(_issue(
                "ontology_shared",
                f"Its semantic layer is also used by {_plural(others, 'other source')}. People who "
                f"manage semantic layers in {target.name} will be able to edit it too."))
    if identity_pin:
        notes.append(_issue(
            "identity_kept",
            f"{target.name} names entities differently, so this source keeps its current "
            "setting and its rollups stay valid."))
    if becomes_primary:
        notes.append(_issue(
            "destination_primary",
            f"{target.name} has no other data source, so this becomes its primary source."))
    elif pin_dest:
        notes.append(_issue(
            "destination_primary",
            f"{pin_label} is made {target.name}'s primary source, so views there keep reading "
            "what they read today."))

    pre = Preflight(
        ds=ds, source=source, target=target, views=views, mode=mode, blockers=blockers,
        notes=notes, losers=losers, counts=counts, was_primary=was_primary,
        was_default=was_default, becomes_primary=becomes_primary,
        pin_destination_default=pin_dest, pin_destination_label=pin_label,
        identity_pin=identity_pin, facts=facts, reach_b=reach_b,
    )
    pre.token = _token(target.id, views, losers, was_default, becomes_primary, pin_dest, identity_pin)
    return pre


async def _person_names(session: AsyncSession, user_ids: Iterable[str]) -> dict[str, str]:
    ids = sorted({u for u in user_ids if u})
    if not ids:
        return {}
    return {
        uid: " ".join(p for p in (first, last) if p).strip() or email
        for uid, first, last, email in (await session.execute(
            select(UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email)
            .where(UserORM.id.in_(ids))
        )).all()
    }


def _preview(pre: Preflight, *, keep: Optional[set] = None, mode: Optional[str] = None,
             owners: Optional[dict] = None) -> TransferPreview:
    """The preflight as the API returns it. ``keep`` marks who keeps access (None: everyone)."""
    live = [v for v in pre.views if v.live]
    owners = owners or {}
    facts = pre.facts
    return TransferPreview(
        dataSource=ImpactedEntity(id=pre.ds.id, name=_label(pre.ds), type="data_source"),
        fromWorkspace=TransferWorkspaceRef(id=pre.source.id, name=pre.source.name),
        toWorkspace=TransferWorkspaceRef(id=pre.target.id, name=pre.target.name),
        mode=mode,
        blockers=pre.blockers,
        notes=pre.notes,
        views=[
            TransferView(id=v.id, name=v.name, visibility=v.visibility, ownerId=v.created_by,
                         ownerName=owners.get(v.created_by or ""), trashed=v.trashed,
                         followsDefault=v.follows_default, publishRequested=v.publish_requested)
            for v in pre.views[:_VIEW_LIST_CAP]
        ],
        viewCounts=TransferViewCounts(
            total=len(pre.views),
            trashed=sum(1 for v in pre.views if v.trashed),
            followsDefault=sum(1 for v in pre.views if v.follows_default),
            private=sum(1 for v in live if v.visibility == "private"),
            workspace=sum(1 for v in live if v.visibility == "workspace"),
            enterprise=sum(1 for v in live if v.visibility == "enterprise"),
            publishRequested=sum(1 for v in live if v.publish_requested),
        ),
        access=TransferAccess(
            **pre.counts,
            loses=[
                TransferSubject(type=loser.type, id=loser.id, name=loser.name, email=loser.email,
                                memberCount=loser.member_count, role=loser.role,
                                views=len(loser.views),
                                keep=True if keep is None else key in keep)
                for key, loser in sorted(pre.losers.items(), key=lambda kv: (kv[0][0] != "group",
                                                                             kv[1].name.lower()))
            ],
        ),
        versioning=TransferVersioning(
            commits=facts.get("commits", 0), openDrafts=len(facts.get("openDrafts") or []),
            openReviews=facts.get("openReviews", 0), forks=facts.get("forks", 0),
        ) if facts else None,
        primary=TransferPrimary(
            wasPrimary=pre.was_primary, wasDefault=pre.was_default,
            becomesPrimary=pre.becomes_primary, pinsDestinationDefault=pre.pin_destination_label,
        ),
        identity=TransferIdentity(
            identityProperty=pre.identity_pin.get("identity_property"),
            nameProperty=pre.identity_pin.get("name_property"),
        ) if pre.identity_pin else None,
        token=pre.token,
    )


def _keep_set(refs: Optional[list[TransferSubjectRef]], losers: dict) -> set[tuple[str, str]]:
    """Who keeps access: everyone losing it when ``refs`` is None, else exactly those named
    who would lose it (naming someone who loses nothing changes nothing)."""
    if refs is None:
        return set(losers)
    return {(r.type, r.id) for r in refs} & set(losers)


# ── the move ─────────────────────────────────────────────────────────


async def _apply(session: AsyncSession, pre: Preflight, *, actor: str, keep: set,
                 graph_id: Optional[str], transfer_id: str) -> dict:
    """Every app-database write of a move, in one transaction. Returns the manifest undo replays."""
    ds, source, target = pre.ds, pre.source, pre.target
    now = _now()
    if pre.pin_destination_default:
        await session.execute(
            update(WorkspaceDataSourceORM)
            .where(WorkspaceDataSourceORM.id == pre.pin_destination_default,
                   WorkspaceDataSourceORM.is_primary == False)  # noqa: E712
            .values(is_primary=True, updated_at=now)
            .execution_options(synchronize_session=False))
    ds.workspace_id = target.id
    ds.is_primary = pre.becomes_primary
    for column, value in pre.identity_pin.items():
        setattr(ds, column, value)
    ds.updated_at = now
    await session.flush()

    pinned = [v.id for v in pre.views if v.follows_default]
    for chunk in _chunks(pinned):
        await session.execute(
            update(ViewORM)
            .where(ViewORM.id.in_(chunk), ViewORM.data_source_id.is_(None))
            # Assigning updated_at to itself keeps a move from passing for an edit.
            .values(data_source_id=ds.id, updated_at=ViewORM.updated_at)
            .execution_options(synchronize_session=False))
    await session.execute(
        update(ViewORM)
        .where(ViewORM.data_source_id == ds.id)
        .values(workspace_id=target.id, updated_at=ViewORM.updated_at)
        .execution_options(synchronize_session=False))
    moved = list((await session.execute(
        select(ViewORM.id).where(ViewORM.data_source_id == ds.id))).scalars().all())
    for chunk in _chunks(moved):
        await session.execute(
            update(ViewActivityLogORM)
            .where(ViewActivityLogORM.view_id.in_(chunk))
            .values(workspace_id=target.id)
            .execution_options(synchronize_session=False))
    summary = f"Moved from {source.name} to {target.name} with {_label(ds)}"
    for vid in moved:
        await view_activity_repo.record_view_activity(
            session, view_id=vid, workspace_id=target.id, action="moved", actor=actor,
            summary=summary, changes={"from": source.id, "to": target.id, "transferId": transfer_id})

    grant_ids = await _grant_kept(session, pre, keep, actor)
    await session.execute(
        update(AggregationDataSourceStateORM)
        .where(AggregationDataSourceStateORM.data_source_id == ds.id)
        .values(workspace_id=target.id)
        .execution_options(synchronize_session=False))

    await _ask_new_publishers(session, pre, actor)
    return {
        "graphId": graph_id,
        "viewIds": moved,
        "pinnedViewIds": pinned,
        "grantIds": grant_ids,
        "wasPrimary": pre.was_primary,
        "wasDefault": pre.was_default,
        "becamePrimary": pre.becomes_primary,
        "pinnedDestinationDefault": pre.pin_destination_default,
        "identity": pre.identity_pin or None,
        "counts": {
            "views": len(moved),
            "trashed": sum(1 for v in pre.views if v.trashed),
            "followsDefault": len(pinned),
            "grants": len(grant_ids),
            "keptSubjects": len(keep),
        },
    }


async def _grant_kept(session: AsyncSession, pre: Preflight, keep: set, actor: str) -> list[str]:
    """View-only grants for the people and teams kept, on exactly the views they'd lose."""
    wanted = {key: pre.losers[key].views for key in keep if key in pre.losers}
    view_ids = sorted({v for views in wanted.values() for v in views})
    existing: set[tuple[str, str, str]] = set()
    for chunk in _chunks(view_ids):
        existing |= set((await session.execute(
            select(ResourceGrantORM.resource_id, ResourceGrantORM.subject_type,
                   ResourceGrantORM.subject_id)
            .where(ResourceGrantORM.resource_type == "view", ResourceGrantORM.resource_id.in_(chunk))
        )).all())
    added: list[ResourceGrantORM] = []
    for (subject_type, subject_id), views in wanted.items():
        for vid in views:
            if (vid, subject_type, subject_id) in existing:
                continue
            grant = ResourceGrantORM(resource_type="view", resource_id=vid,
                                     subject_type=subject_type, subject_id=subject_id,
                                     role_name="viewer", granted_by=actor)
            session.add(grant)
            added.append(grant)
    if added:
        await session.flush()
    return [g.id for g in added]


async def _ask_new_publishers(session: AsyncSession, pre: Preflight, actor: str) -> None:
    """A request to publish was put to the old workspace's publishers; it is the new one's to
    answer now, so they hear about it."""
    asked = [v for v in pre.views if v.publish_requested and v.live]
    if not asked:
        return
    publishers = await notification_repo.users_who_can(
        session, workspace_id=pre.target.id, permission="workspace:view:publish")
    for v in asked:
        await notification_repo.notify(
            session, user_ids=publishers, kind="view.publish_requested",
            title=f'Publication requested: "{v.name}"',
            body=f"It moved here from {pre.source.name} with its data source, and asks to be "
                 "published to everyone.",
            link=f"/views/{v.id}", actor_id=actor, resource_type="view", resource_id=v.id)


async def _compensate(ds_id: str, ws_id: str) -> None:
    """Put the versioned graph back where the source still is after a failed move."""
    try:
        await lifecycle.relocate_graph(ds_id, ws_id, check_busy=False)
    except Exception:
        # The next move or undo of this source sets it right: relocation sets, never swaps.
        logger.error("could not put the versioned graph of %s back in %s after a failed move",
                     ds_id, ws_id, exc_info=True)


def _is_clash(exc: IntegrityError) -> bool:
    """The destination took the same graph between the check and the write. Postgres names the
    index; SQLite names its columns."""
    text = str(getattr(exc, "orig", exc))
    return "uq_ds_ws_prov_graph_live" in text or (
        "workspace_data_sources.workspace_id" in text and "graph_name" in text)


async def _relocate_graph_first(ds_id: str, ws_id: str) -> Optional[str]:
    try:
        return await lifecycle.relocate_graph(ds_id, ws_id)
    except lifecycle.GraphBusy as exc:
        raise _conflict(
            "graph_busy",
            f"Version history is being written right now ({_job_words([exc.job_type])}). "
            "Nothing was changed; try again once it finishes.")
    except DBAPIError as exc:
        if "lock" in str(exc).lower():
            raise _conflict(
                "graph_busy",
                "Version history is being written right now. Nothing was changed; try again shortly.")
        logger.exception("version store unavailable while moving %s", ds_id)
        raise HTTPException(status_code=503, detail={
            "error": "version_store_unavailable",
            "message": "The version store is unavailable. Nothing was changed. Try again shortly."})
    except Exception:
        logger.exception("version store unavailable while moving %s", ds_id)
        raise HTTPException(status_code=503, detail={
            "error": "version_store_unavailable",
            "message": "The version store is unavailable. Nothing was changed. Try again shortly."})


async def _execute(
    session: AsyncSession,
    pre: Preflight,
    *,
    actor: str,
    keep: set,
    transfer: Optional[DataSourceTransferORM],
    plan: dict,
) -> DataSourceTransferORM:
    """Run a move: the version store first, then everything else in this transaction, which is
    committed here so a failure can put the graph back."""
    ds, source, target = pre.ds, pre.source, pre.target
    # Read now: a rollback expires every loaded row, and nothing may lazy-load after one.
    ds_id, source_id, target_id, target_name = ds.id, source.id, target.id, target.name
    provider_id, graph_name = ds.provider_id, ds.graph_name
    transfer_id = transfer.id if transfer is not None else f"xfer_{uuid.uuid4().hex[:12]}"
    graph_id = await _relocate_graph_first(ds_id, target_id)
    try:
        manifest = await _apply(session, pre, actor=actor, keep=keep, graph_id=graph_id,
                                transfer_id=transfer_id)
        now = _now()
        if transfer is None:
            prov = current_provenance()
            row = await transfer_repo.record_move(
                session, id=transfer_id, data_source_id=ds.id, data_source_label=_label(ds),
                from_workspace_id=source.id, to_workspace_id=target.id, plan=json.dumps(plan),
                manifest=json.dumps(manifest), reason=prov.stated_reason if prov else None,
                created_by=actor, created_at=now, completed_at=now)
            await _cancel_pending(session, ds.id, actor=actor,
                                  note=f"It was moved to {target.name} directly.")
        else:
            row = transfer
            row.status = "completed"
            row.completed_at = now
            row.resolved_by = actor
            row.resolved_at = now
            row.manifest = json.dumps(manifest)
            await session.flush()
        details = _details(row, source, target, views=len(manifest["viewIds"]),
                           kept=manifest["counts"]["keptSubjects"])
        await _record_both(session, "workspace.data_source.moved", ds, source, target, details)
        await _notify_moved(session, row, ds, source, target, actor=actor, view_ids=manifest["viewIds"])
        await session.commit()
    except BaseException as exc:
        with contextlib.suppress(Exception):
            await asyncio.shield(session.rollback())
        if graph_id is not None:
            await asyncio.shield(_compensate(ds_id, source_id))
        if isinstance(exc, IntegrityError) and _is_clash(exc):
            raise _conflict("already_connected", f"{target_name} already has this graph connected.")
        raise
    await _invalidate_reads(
        ds_id=ds_id, provider_id=provider_id, graph_name=graph_name,
        workspaces=(source_id, target_id),
        defaults_changed=[ws for ws, changed in ((source_id, pre.was_default),
                                                 (target_id, pre.becomes_primary)) if changed])
    return row


async def move(session: AsyncSession, *, ds_id: str, from_ws_id: str, claims: PermissionClaims,
               user_id: str, req: DataSourceMoveRequest) -> DataSourceTransferORM:
    """Move a data source now, for someone who may in both workspaces."""
    await _expire_lapsed(session)
    try:
        ds = await source_in(session, ds_id, from_ws_id, lock=True)
    except HTTPException:
        # Not here any more. If this caller just moved it where they're asking to, this is a
        # retry whose first try went through: answer with that move, not a 404.
        latest = await transfer_repo.latest_move_for_source(session, ds_id)
        if (latest is not None and latest.kind == "move" and latest.status == "completed"
                and latest.created_by == user_id and latest.from_workspace_id == from_ws_id
                and latest.to_workspace_id == req.target_workspace_id
                and _recent(latest.completed_at)):
            return latest
        raise
    if not await advisory.claim_this_pass(session, ds.id):
        raise _conflict("aggregation_running",
                        "An aggregation run is starting on this source. Try again once it finishes.")
    pre = await preflight(session, ds=ds, to_ws_id=req.target_workspace_id, claims=claims,
                          purpose="move")
    if pre.mode != "direct":
        need = _ADMIN if pre.has_views else _MANAGE
        missing = (pre.source.id if not has_permission(claims, need, workspace_id=pre.source.id)
                   else pre.target.id)
        await _deny(
            session, user_id, need, missing,
            "Moving a data source that has views takes administering both workspaces."
            if pre.has_views else
            "Moving a data source takes managing data sources in both workspaces.")
    if pre.has_views:
        # It takes workspace:admin, so it fails closed like every route that does: a session
        # whose revocation can't be checked right now doesn't get to move other people's work.
        from backend.app.auth.dependencies import assert_session_alive_or_503
        await assert_session_alive_or_503(claims, permission=_ADMIN, user_id=user_id)
    _refuse(pre.blockers)
    if req.preview_token and req.preview_token != pre.token:
        raise _conflict("preview_stale", "Something changed since you reviewed this move. "
                                         "Here's the latest.")
    keep = _keep_set(req.keep, pre.losers)
    plan = _plan(pre, keep)
    return await _execute(session, pre, actor=user_id, keep=keep, transfer=None, plan=plan)


def _plan(pre: Preflight, keep: set) -> dict:
    return {
        "keep": [{"type": t, "id": i} for t, i in sorted(keep)],
        "viewIds": pre.view_ids,
        "losers": sorted(f"{t}:{i}" for t, i in pre.losers),
    }


# ── requests ─────────────────────────────────────────────────────────


async def propose(session: AsyncSession, *, ds_id: str, from_ws_id: str,
                  claims: PermissionClaims, user_id: str,
                  req: DataSourceMoveRequest) -> DataSourceTransferORM:
    """Ask the destination's admins to take a source. Who keeps access is decided here."""
    await _expire_lapsed(session)
    ds = await source_in(session, ds_id, from_ws_id, lock=True)
    pre = await preflight(session, ds=ds, to_ws_id=req.target_workspace_id, claims=claims,
                          purpose="propose")
    keep = _keep_set(req.keep, pre.losers)
    plan = _plan(pre, keep)
    waiting = await transfer_repo.pending_for_source(session, ds.id)
    if (waiting is not None and waiting.created_by == user_id
            and waiting.to_workspace_id == pre.target.id and _recent(waiting.created_at)
            and _load(waiting.plan) == plan):
        # The same request from the same person, just made: a retry whose first try went
        # through. Answer with it rather than "already waiting".
        return waiting
    # A run in progress will have finished by the time anyone reads the request.
    permanent = [b for b in pre.blockers if not b.transient]
    if any(b.code == "request_waiting" for b in permanent):
        raise _conflict("request_waiting", "A request to move it is already waiting for an answer.",
                        permanent)
    _refuse(permanent)
    prov = current_provenance()
    row, created = await transfer_repo.create_pending(
        session, data_source_id=ds.id, data_source_label=_label(ds),
        from_workspace_id=pre.source.id, to_workspace_id=pre.target.id,
        plan=json.dumps(plan), reason=prov.stated_reason if prov else None,
        created_by=user_id,
        expires_at=(datetime.now(timezone.utc) + timedelta(days=REQUEST_DAYS)).isoformat())
    if not created:
        raise _conflict("request_waiting",
                        "A request to move it is already waiting for an answer.")
    await _record_both(session, "workspace.data_source.transfer_requested", ds, pre.source,
                       pre.target, _details(row, pre.source, pre.target, views=len(pre.views),
                                            kept=len(keep)))
    recipients = await notification_repo.users_who_can(
        session, workspace_id=pre.target.id, permission=_ADMIN)
    if not recipients:
        recipients = await notification_repo.users_with_global_permission(session, "system:org-admin")
    await notification_repo.notify(
        session, user_ids=recipients, kind="data_source.transfer_requested",
        title=f'{pre.source.name} wants to move "{_label(ds)}" to {pre.target.name}',
        body=f"{_plural(len(pre.views), 'view')} would move with it. Review it within "
             f"{REQUEST_DAYS} days.",
        link=f"/workspaces?tab=requests&transfer={row.id}", actor_id=user_id,
        resource_type="data_source_transfer", resource_id=row.id)
    return row


async def _visible_transfer(session: AsyncSession, transfer_id: str, claims: PermissionClaims,
                            user_id: str, *, for_update: bool = False) -> DataSourceTransferORM:
    """The transfer, if the caller is a party to it: who asked, or an admin of either side."""
    row = await transfer_repo.get(session, transfer_id, for_update=for_update)
    if row is None or not (
        row.created_by == user_id
        or _is_admin(claims, row.from_workspace_id)
        or _is_admin(claims, row.to_workspace_id)
    ):
        raise HTTPException(status_code=404, detail="Transfer not found")
    return row


def _still_open(row: DataSourceTransferORM) -> None:
    if row.status == "expired":
        raise _conflict("expired", "This request expired before anyone answered it.")
    if row.status != "pending":
        raise _conflict("already_answered", "This request has already been answered.")


async def accept(session: AsyncSession, *, transfer_id: str, claims: PermissionClaims,
                 user_id: str, preview_token: str) -> DataSourceTransferORM:
    """Take the source: run the move the proposer planned, as it stands now."""
    await _expire_lapsed(session)
    row = await _visible_transfer(session, transfer_id, claims, user_id)
    if _answered_by(row, user_id, "completed"):
        return row
    _still_open(row)
    if not _is_admin(claims, row.to_workspace_id):
        await _deny(session, user_id, _ADMIN, row.to_workspace_id,
                    "Only the destination's admins can accept a transfer.")
    # Lock order: the source, then the request — the order undo and moves take them in.
    ds = await _lock_live(session, row.data_source_id)
    if ds is None:
        raise _conflict("blocked", "The data source has been deleted since this request was made.")
    row = await transfer_repo.get(session, transfer_id, for_update=True)
    if _answered_by(row, user_id, "completed"):
        return row  # a second click that queued behind the first
    _still_open(row)
    if not await advisory.claim_this_pass(session, ds.id):
        raise _conflict("aggregation_running",
                        "An aggregation run is starting on this source. Try again once it finishes.")
    pre = await preflight(session, ds=ds, to_ws_id=row.to_workspace_id, claims=claims,
                          purpose="accept", transfer=row)
    _refuse(pre.blockers)
    if preview_token != pre.token:
        raise _conflict("preview_stale", "Something changed since you reviewed this request. "
                                         "Here's the latest.")
    plan = _load(row.plan)
    keep = _keep_set([TransferSubjectRef(**k) for k in plan.get("keep") or []], pre.losers)
    moved = await _execute(session, pre, actor=user_id, keep=keep, transfer=row, plan=plan)
    return moved


async def decline(session: AsyncSession, *, transfer_id: str, claims: PermissionClaims,
                  user_id: str, note: Optional[str]) -> DataSourceTransferORM:
    await _expire_lapsed(session)
    row = await _visible_transfer(session, transfer_id, claims, user_id, for_update=True)
    if _answered_by(row, user_id, "declined"):
        return row
    _still_open(row)
    if not _is_admin(claims, row.to_workspace_id):
        await _deny(session, user_id, _ADMIN, row.to_workspace_id,
                    "Only the destination's admins can decline a transfer.")
    await transfer_repo.resolve(session, row, status="declined", resolver_id=user_id, note=note)
    await _record_resolution(session, row, "workspace.data_source.transfer_declined")
    names = await _workspace_names(session, [row.from_workspace_id, row.to_workspace_id])
    await notification_repo.notify(
        session, user_ids=[row.created_by] if row.created_by else [],
        kind="data_source.transfer_declined",
        title=f'{names.get(row.to_workspace_id, "The destination")} declined '
              f'"{row.data_source_label}"',
        body=row.resolution_note or "No reason was given.",
        link=f"/workspaces/{row.from_workspace_id}?ds={row.data_source_id}", actor_id=user_id,
        resource_type="data_source_transfer", resource_id=row.id)
    return row


async def cancel(session: AsyncSession, *, transfer_id: str, claims: PermissionClaims,
                 user_id: str, note: Optional[str]) -> DataSourceTransferORM:
    await _expire_lapsed(session)
    row = await _visible_transfer(session, transfer_id, claims, user_id, for_update=True)
    if _answered_by(row, user_id, "cancelled"):
        return row
    _still_open(row)
    if row.created_by != user_id and not _is_admin(claims, row.from_workspace_id):
        await _deny(session, user_id, _ADMIN, row.from_workspace_id,
                    "Only the person who asked, or the source workspace's admins, can cancel it.")
    await _close_request(session, row, actor=user_id, note=note)
    return row


async def _close_request(session: AsyncSession, row: DataSourceTransferORM, *, actor: Optional[str],
                         note: Optional[str]) -> None:
    """Cancel a pending request and tell the destination's admins (and the proposer, when it
    wasn't them)."""
    await transfer_repo.resolve(session, row, status="cancelled", resolver_id=actor, note=note)
    await _record_resolution(session, row, "workspace.data_source.transfer_cancelled")
    names = await _workspace_names(session, [row.to_workspace_id])
    recipients = await notification_repo.users_who_can(
        session, workspace_id=row.to_workspace_id, permission=_ADMIN)
    await notification_repo.notify(
        session, user_ids=recipients, kind="data_source.transfer_cancelled",
        title=f'The request to move "{row.data_source_label}" to '
              f'{names.get(row.to_workspace_id, "your workspace")} was cancelled',
        body=row.resolution_note, link=f"/workspaces?tab=requests&transfer={row.id}",
        actor_id=actor, resource_type="data_source_transfer", resource_id=row.id)
    if row.created_by and row.created_by != actor:
        await notification_repo.notify(
            session, user_ids=[row.created_by], kind="data_source.transfer_cancelled",
            title=f'Your request to move "{row.data_source_label}" was cancelled',
            body=row.resolution_note,
            link=f"/workspaces/{row.from_workspace_id}?ds={row.data_source_id}",
            actor_id=actor, resource_type="data_source_transfer", resource_id=row.id)


async def _cancel_pending(session: AsyncSession, ds_id: str, *, actor: Optional[str],
                          note: str) -> None:
    row = await transfer_repo.pending_for_source(session, ds_id)
    if row is not None:
        await _close_request(session, row, actor=actor, note=note)


async def cancel_open_for_source(session: AsyncSession, ds_id: str, *, actor: Optional[str],
                                 note: str) -> None:
    """The source is going away: close its open request, telling the people waiting."""
    await _cancel_pending(session, ds_id, actor=actor, note=note)


async def cancel_open_for_workspace(session: AsyncSession, ws_id: str, *, actor: Optional[str],
                                    note: str) -> None:
    """A workspace is going away: close the requests into and out of it."""
    for row in await transfer_repo.open_for_workspace(session, ws_id):
        await _close_request(session, row, actor=actor, note=note)


# ── undo ─────────────────────────────────────────────────────────────


async def undo_state(session: AsyncSession, row: DataSourceTransferORM,
                     claims: PermissionClaims) -> tuple[bool, Optional[str]]:
    """Whether the caller may undo ``row`` now, and if not, why — in a sentence."""
    if row.status != "completed":
        return False, None
    completed = _parse(row.completed_at)
    if completed is None or completed + timedelta(days=UNDO_DAYS) < datetime.now(timezone.utc):
        return False, f"The {UNDO_DAYS}-day window to undo it has passed. Move it back instead."
    latest = await transfer_repo.latest_move_for_source(session, row.data_source_id)
    if latest is None or latest.id != row.id:
        return False, "It has moved again since."
    ds = await data_source_repo.get_data_source_orm(session, row.data_source_id)
    if ds is None or ds.workspace_id != row.to_workspace_id:
        return False, "The data source has been deleted or moved since."
    known = set(_load(row.manifest).get("viewIds") or [])
    on_it = set((await session.execute(
        select(ViewORM.id).where(ViewORM.data_source_id == ds.id))).scalars().all())
    new = len(on_it - known)
    if not new:
        defaults = await data_source_repo.default_data_source_ids(session, [row.to_workspace_id])
        if defaults.get(row.to_workspace_id) == ds.id:
            new = await session.scalar(
                select(func.count()).select_from(ViewORM).where(
                    ViewORM.workspace_id == row.to_workspace_id,
                    ViewORM.data_source_id.is_(None),
                    ViewORM.created_at > row.completed_at,
                )) or 0
    if new:
        return False, (f"{_plural(new, 'view')} {'was' if new == 1 else 'were'} built on it since "
                       "it moved, so it can't be undone. Move it back instead.")
    if not _may_undo(row, claims):
        return False, _undo_refusal(row)
    return True, None


def _may_undo(row: DataSourceTransferORM, claims: PermissionClaims) -> bool:
    """A request-based move is the destination's to send back (it agreed to take the source);
    a direct move takes what it took to make: administering both workspaces."""
    if row.kind == "request":
        return _is_admin(claims, row.to_workspace_id)
    return _is_admin(claims, row.from_workspace_id) and _is_admin(claims, row.to_workspace_id)


def _undo_refusal(row: DataSourceTransferORM) -> str:
    return ("Only the destination's admins can undo this move." if row.kind == "request"
            else "Undoing it takes administering both workspaces.")


async def undo(session: AsyncSession, *, transfer_id: str, claims: PermissionClaims,
               user_id: str) -> DataSourceTransferORM:
    """Put a move back exactly as it was, from its manifest."""
    await _expire_lapsed(session)
    row = await _visible_transfer(session, transfer_id, claims, user_id)
    if _answered_by(row, user_id, "undone"):
        return row
    if not _may_undo(row, claims):
        await _deny(session, user_id, _ADMIN, row.to_workspace_id, _undo_refusal(row))
    # Lock order: the source, then the transfer — the order accept and moves take them in.
    ds = await _lock_live(session, row.data_source_id)
    row = await transfer_repo.get(session, transfer_id, for_update=True)
    if _answered_by(row, user_id, "undone"):
        return row  # a second click that queued behind the first
    ok, why = await undo_state(session, row, claims)
    if not ok or ds is None:
        raise _conflict("undo_unavailable", why or "This move can't be undone.")
    if not await advisory.claim_this_pass(session, ds.id):
        raise _conflict("aggregation_running",
                        "An aggregation run is starting on this source. Try again once it finishes.")
    source = await _live_workspace(session, row.from_workspace_id)
    target = await _live_workspace(session, row.to_workspace_id)
    blockers, _facts = await _destination_blockers(session, ds, source)
    _refuse(blockers)

    manifest = _load(row.manifest)
    # Read now: a rollback expires every loaded row, and nothing may lazy-load after one.
    ds_id, source_id, target_id, source_name = ds.id, source.id, target.id, source.name
    provider_id, graph_name = ds.provider_id, ds.graph_name
    defaults = await data_source_repo.default_data_source_ids(session, [target_id])
    was_default_there = defaults.get(target_id) == ds_id
    graph_id = await _relocate_graph_first(ds_id, source_id)
    try:
        await _apply_undo(session, row, ds, source, target, manifest, actor=user_id)
        row.status = "undone"
        row.undone_by = user_id
        row.undone_at = _now()
        await session.flush()
        await _cancel_pending(session, ds.id, actor=user_id,
                              note=f"Its move to {target.name} was undone.")
        details = _details(row, source, target, views=len(manifest.get("viewIds") or []),
                           kept=(manifest.get("counts") or {}).get("keptSubjects", 0))
        await _record_both(session, "workspace.data_source.move_undone", ds, source, target, details)
        await _notify_undone(session, row, ds, source, target, actor=user_id,
                             view_ids=manifest.get("viewIds") or [])
        await session.commit()
    except BaseException as exc:
        with contextlib.suppress(Exception):
            await asyncio.shield(session.rollback())
        if graph_id is not None:
            await asyncio.shield(_compensate(ds_id, target_id))
        if isinstance(exc, IntegrityError) and _is_clash(exc):
            raise _conflict("already_connected", f"{source_name} already has this graph connected.")
        raise
    await _invalidate_reads(
        ds_id=ds_id, provider_id=provider_id, graph_name=graph_name,
        workspaces=(source_id, target_id),
        defaults_changed=[ws for ws, changed in ((source_id, bool(manifest.get("wasDefault"))),
                                                 (target_id, was_default_there)) if changed])
    return row


async def _apply_undo(session: AsyncSession, row: DataSourceTransferORM,
                      ds: WorkspaceDataSourceORM, source: WorkspaceORM, target: WorkspaceORM,
                      manifest: dict, *, actor: str) -> None:
    now = _now()
    flagged = await session.scalar(
        select(func.count()).select_from(WorkspaceDataSourceORM).where(
            WorkspaceDataSourceORM.workspace_id == source.id,
            WorkspaceDataSourceORM.is_primary == True,  # noqa: E712
            WorkspaceDataSourceORM.deleted_at.is_(None),
            WorkspaceDataSourceORM.id != ds.id,
        )) or 0
    ds.workspace_id = source.id
    # Two flagged primaries would break every lookup that expects one.
    ds.is_primary = bool(manifest.get("wasPrimary")) and not flagged
    for column, value in (manifest.get("identity") or {}).items():
        if getattr(ds, column) == value:
            setattr(ds, column, None)
    ds.updated_at = now
    await session.flush()

    pinned_default = manifest.get("pinnedDestinationDefault")
    if pinned_default:
        await session.execute(
            update(WorkspaceDataSourceORM)
            .where(WorkspaceDataSourceORM.id == pinned_default,
                   WorkspaceDataSourceORM.workspace_id == target.id)
            .values(is_primary=False, updated_at=now)
            .execution_options(synchronize_session=False))

    view_ids = list(manifest.get("viewIds") or [])
    for chunk in _chunks(view_ids):
        await session.execute(
            update(ViewORM)
            .where(ViewORM.id.in_(chunk), ViewORM.data_source_id == ds.id)
            .values(workspace_id=source.id, updated_at=ViewORM.updated_at)
            .execution_options(synchronize_session=False))
        await session.execute(
            update(ViewActivityLogORM)
            .where(ViewActivityLogORM.view_id.in_(chunk))
            .values(workspace_id=source.id)
            .execution_options(synchronize_session=False))
    for chunk in _chunks(list(manifest.get("pinnedViewIds") or [])):
        await session.execute(
            update(ViewORM)
            .where(ViewORM.id.in_(chunk), ViewORM.data_source_id == ds.id)
            .values(data_source_id=None, updated_at=ViewORM.updated_at)
            .execution_options(synchronize_session=False))
    summary = f"Moved back to {source.name} (the move to {target.name} was undone)"
    for vid in view_ids:
        await view_activity_repo.record_view_activity(
            session, view_id=vid, workspace_id=source.id, action="moved", actor=actor,
            summary=summary, changes={"from": target.id, "to": source.id, "transferId": row.id,
                                      "undo": True})
    for chunk in _chunks(list(manifest.get("grantIds") or [])):
        await session.execute(
            delete(ResourceGrantORM)
            .where(ResourceGrantORM.id.in_(chunk), ResourceGrantORM.role_name == "viewer")
            .execution_options(synchronize_session=False))
    await session.execute(
        update(AggregationDataSourceStateORM)
        .where(AggregationDataSourceStateORM.data_source_id == ds.id)
        .values(workspace_id=source.id)
        .execution_options(synchronize_session=False))


# ── activity, notifications, caches ──────────────────────────────────


def _details(row: DataSourceTransferORM, source: WorkspaceORM, target: WorkspaceORM, *,
             views: int, kept: int) -> dict:
    details = {
        "transferId": row.id,
        "fromWorkspaceId": source.id,
        "fromWorkspaceName": source.name,
        "toWorkspaceId": target.id,
        "toWorkspaceName": target.name,
        "via": row.kind,
        "views": views,
        "keptAccess": kept,
    }
    if row.kind == "request" and row.created_by:
        details["proposedBy"] = row.created_by
    if row.resolution_note:
        details["note"] = row.resolution_note
    return details


async def _record_both(session: AsyncSession, event_type: str, ds: WorkspaceDataSourceORM,
                       source: WorkspaceORM, target: WorkspaceORM, details: dict) -> None:
    """One event in each workspace's activity: both admins see the source leave and arrive."""
    for ws_id in (source.id, target.id):
        await recorder.record_for_request(
            session, event_type, workspace_id=ws_id, data_source_id=ds.id,
            target_type="data_source", target_id=ds.id, target_label=_label(ds), details=details)


async def _record_resolution(session: AsyncSession, row: DataSourceTransferORM,
                             event_type: str, *, by_system: bool = False) -> None:
    """One event in each workspace's activity. ``by_system``: nobody did it (a request lapsing),
    so it is filed under no one rather than under whoever's request noticed."""
    names = await _workspace_names(session, [row.from_workspace_id, row.to_workspace_id])
    details = {
        "transferId": row.id,
        "fromWorkspaceId": row.from_workspace_id,
        "fromWorkspaceName": names.get(row.from_workspace_id),
        "toWorkspaceId": row.to_workspace_id,
        "toWorkspaceName": names.get(row.to_workspace_id),
        "via": row.kind,
    }
    if row.resolution_note:
        details["note"] = row.resolution_note
    for ws_id in (row.from_workspace_id, row.to_workspace_id):
        fields = dict(workspace_id=ws_id, data_source_id=row.data_source_id,
                      target_type="data_source", target_id=row.data_source_id,
                      target_label=row.data_source_label, details=details)
        if by_system:
            await recorder.record_activity(session, event_type=event_type, provenance=None, **fields)
        else:
            await recorder.record_for_request(session, event_type, **fields)


async def _expire_lapsed(session: AsyncSession) -> None:
    """Close the requests nobody answered in time — run before every transfer read and write, so
    no one acts on one that has lapsed. Each is recorded in both workspaces' activity and the
    person who asked hears about it."""
    for row in await transfer_repo.expire_lapsed(session):
        await _record_resolution(session, row, "workspace.data_source.transfer_expired",
                                 by_system=True)
        if not row.created_by:
            continue
        names = await _workspace_names(session, [row.to_workspace_id])
        await notification_repo.notify(
            session, user_ids=[row.created_by], kind="data_source.transfer_expired",
            title=f'Your request to move "{row.data_source_label}" expired',
            body=f"{names.get(row.to_workspace_id, 'The destination')}'s admins didn't answer "
                 f"within {REQUEST_DAYS} days. You can ask again.",
            link=f"/workspaces/{row.from_workspace_id}?ds={row.data_source_id}",
            resource_type="data_source_transfer", resource_id=row.id)


async def _workspace_names(session: AsyncSession, ws_ids: Iterable[str]) -> dict[str, str]:
    ids = sorted({w for w in ws_ids if w})
    if not ids:
        return {}
    return {wid: name for wid, name in (await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(ids)))).all()}


async def _creators(session: AsyncSession, view_ids: list[str]) -> dict[str, int]:
    """``{creator: live views of theirs among view_ids}``."""
    out: dict[str, int] = {}
    for chunk in _chunks(view_ids):
        for creator, n in (await session.execute(
            select(ViewORM.created_by, func.count())
            .where(ViewORM.id.in_(chunk), view_is_live(), ViewORM.created_by.isnot(None))
            .group_by(ViewORM.created_by)
        )).all():
            out[creator] = out.get(creator, 0) + n
    return out


async def _notify_moved(session: AsyncSession, row: DataSourceTransferORM,
                        ds: WorkspaceDataSourceORM, source: WorkspaceORM, target: WorkspaceORM,
                        *, actor: str, view_ids: list[str]) -> None:
    label = _label(ds)
    admins = (await notification_repo.users_who_can(session, workspace_id=source.id, permission=_ADMIN)
              | await notification_repo.users_who_can(session, workspace_id=target.id, permission=_ADMIN))
    if row.kind == "request" and row.created_by:
        await notification_repo.notify(
            session, user_ids=[row.created_by], kind="data_source.transfer_accepted",
            title=f'"{label}" moved to {target.name}',
            body=f"{target.name}'s admins accepted your request.",
            link=f"/workspaces/{target.id}?ds={ds.id}", actor_id=actor,
            resource_type="data_source_transfer", resource_id=row.id)
        admins.discard(row.created_by)
    await notification_repo.notify(
        session, user_ids=admins, kind="data_source.moved",
        title=f'"{label}" moved from {source.name} to {target.name}',
        body=f"{_plural(len(view_ids), 'view')} moved with it.",
        link=f"/workspaces/{target.id}?ds={ds.id}", actor_id=actor,
        resource_type="data_source_transfer", resource_id=row.id)
    for creator, n in (await _creators(session, view_ids)).items():
        if creator in admins or creator == row.created_by:
            continue
        await notification_repo.notify(
            session, user_ids=[creator], kind="data_source.moved",
            title=f"Your views moved to {target.name}",
            body=f'"{label}" moved to {target.name}, and {_plural(n, "view")} of yours with it. '
                 "You keep access to them.",
            link=f"/workspaces/{target.id}?tab=views", actor_id=actor,
            resource_type="data_source_transfer", resource_id=row.id)


async def _notify_undone(session: AsyncSession, row: DataSourceTransferORM,
                         ds: WorkspaceDataSourceORM, source: WorkspaceORM, target: WorkspaceORM,
                         *, actor: str, view_ids: list[str]) -> None:
    label = _label(ds)
    people = (await notification_repo.users_who_can(session, workspace_id=source.id, permission=_ADMIN)
              | await notification_repo.users_who_can(session, workspace_id=target.id, permission=_ADMIN)
              | set(await _creators(session, view_ids)))
    if row.created_by:
        people.add(row.created_by)
    await notification_repo.notify(
        session, user_ids=people, kind="data_source.move_undone",
        title=f'The move of "{label}" to {target.name} was undone',
        body=f"It's back in {source.name} with {_plural(len(view_ids), 'view')}.",
        link=f"/workspaces/{source.id}?ds={ds.id}", actor_id=actor,
        resource_type="data_source_transfer", resource_id=row.id)


async def _invalidate_reads(*, ds_id: str, provider_id: Optional[str], graph_name: Optional[str],
                            workspaces: Iterable[str], defaults_changed: Iterable[str]) -> None:
    """Drop every cached read the move made wrong. Best-effort: the move has committed."""
    from backend.app.providers.manager import provider_manager
    from backend.app.services.graph_cache import (
        CacheScope,
        get_graph_cache,
        invalidate_aggregated_reads,
        invalidate_hierarchy_reads,
    )
    from backend.app.services.resolved_ontology_cache import bump_ontology_generation

    async def _evict() -> None:
        if provider_id:
            await provider_manager.evict_data_source(provider_id, graph_name or "")

    async def _default_reads(ws_id: str) -> None:
        cache = get_graph_cache()
        scope = CacheScope(workspace_id=ws_id, data_source_id="")
        await cache.bump_generation(scope)
        await cache.bump_rollup_generation(scope)
        await cache.purge_lkg_scope(scope)

    # Both sides: entries under the old scope would otherwise come back after an undo. Reads
    # with no source named were built from a workspace's old default. Concurrently, so a cache
    # that is down costs one timeout rather than one per call.
    jobs = [_evict()]
    for ws_id in workspaces:
        jobs += [bump_ontology_generation(ws_id, ds_id), invalidate_hierarchy_reads(ws_id, ds_id),
                 invalidate_aggregated_reads(ws_id, ds_id)]
    for ws_id in defaults_changed:
        jobs += [bump_ontology_generation(ws_id, None), _default_reads(ws_id)]
    for result in await asyncio.gather(*jobs, return_exceptions=True):
        if isinstance(result, Exception):                    # pragma: no cover - cache only
            logger.warning("cache invalidation after moving %s failed: %s", ds_id, result)


# ── reads ────────────────────────────────────────────────────────────


async def preview(session: AsyncSession, *, ds: WorkspaceDataSourceORM, to_ws_id: str,
                  claims: PermissionClaims) -> TransferPreview:
    await _expire_lapsed(session)
    pre = await preflight(session, ds=ds, to_ws_id=to_ws_id, claims=claims)
    owners = await _person_names(session, {v.created_by for v in pre.views[:_VIEW_LIST_CAP]})
    return _preview(pre, mode=pre.mode, owners=owners)


async def _directory_on(session: AsyncSession) -> bool:
    return await feature_flags.is_enabled(
        _DIRECTORY_FLAG, session, default=fail_safe_default(_DIRECTORY_FLAG))


async def _can_see(session: AsyncSession, claims: PermissionClaims, ws: WorkspaceORM, *,
                   directory: Optional[bool] = None) -> bool:
    """Whether the caller may learn the workspace is there: they can open it, or it's listed in
    Find a workspace while that's on — the rule access requests follow."""
    if workspace_access.can_open(claims, ws.id):
        return True
    if not ws.directory_listed:
        return False
    return await _directory_on(session) if directory is None else directory


async def destinations(session: AsyncSession, *, ds: WorkspaceDataSourceORM,
                       claims: PermissionClaims) -> list[TransferDestination]:
    """Where the source could go, and for each, whether the caller may move it there now, ask,
    or neither — and why not. Workspaces the caller couldn't otherwise see stay unlisted."""
    source_id = ds.workspace_id
    defaults = await data_source_repo.default_data_source_ids(session, [source_id])
    has_views = (await session.scalar(
        select(func.count()).select_from(ViewORM).where(ViewORM.data_source_id == ds.id)) or 0) > 0
    if not has_views and defaults.get(source_id) == ds.id:
        has_views = (await session.scalar(
            select(func.count()).select_from(ViewORM).where(
                ViewORM.workspace_id == source_id, ViewORM.data_source_id.is_(None))) or 0) > 0
    need = _ADMIN if has_views else _MANAGE
    can_ask = _is_admin(claims, source_id)
    directory = await _directory_on(session)

    workspaces = (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.deleted_at.is_(None), WorkspaceORM.id != source_id)
        .order_by(WorkspaceORM.name)
    )).scalars().all()
    counts = {ws: n for ws, n in (await session.execute(
        select(WorkspaceDataSourceORM.workspace_id, func.count())
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        .group_by(WorkspaceDataSourceORM.workspace_id)
    )).all()}
    holding: set[str] = set()
    if ds.provider_id and ds.graph_name:
        holding = set((await session.execute(
            select(WorkspaceDataSourceORM.workspace_id).where(
                WorkspaceDataSourceORM.provider_id == ds.provider_id,
                WorkspaceDataSourceORM.graph_name == ds.graph_name,
                WorkspaceDataSourceORM.deleted_at.is_(None),
                WorkspaceDataSourceORM.id != ds.id,
            ))).scalars().all())
    permitted = await _permitted_list(session, ds)

    out: list[TransferDestination] = []
    for ws in workspaces:
        if not await _can_see(session, claims, ws, directory=directory):
            continue
        direct = (has_permission(claims, need, workspace_id=source_id)
                  and has_permission(claims, need, workspace_id=ws.id))
        mode = "direct" if direct else ("request" if can_ask else None)
        reason = None
        if not ws.is_active:
            mode, reason = None, "Switched off"
        elif ws.id in holding:
            mode, reason = None, "Already has this graph"
        elif not all(_permits(raw, ws.id) for raw in permitted):
            mode, reason = None, "Not permitted for this source"
        elif mode is None:
            reason = "You can't move it here or ask to"
        out.append(TransferDestination(
            id=ws.id, name=ws.name, description=ws.description,
            dataSourceCount=counts.get(ws.id, 0), mode=mode, reason=reason))
    rank = {"direct": 0, "request": 1, None: 2}
    out.sort(key=lambda d: (rank[d.mode], d.name.lower()))
    return out


async def to_responses(session: AsyncSession, rows: list[DataSourceTransferORM],
                       claims: PermissionClaims, *, user_id: str) -> list[DataSourceTransferResponse]:
    """Transfers as the API returns them. A workspace's name is shown to the parties to the
    transfer and to anyone who can open that workspace; otherwise it stays its own."""
    if not rows:
        return []
    names = await _workspace_names(
        session, [r.from_workspace_id for r in rows] + [r.to_workspace_id for r in rows])
    people_ids = {p for r in rows for p in (r.created_by, r.resolved_by, r.undone_by) if p}
    people = {}
    if people_ids:
        for uid, first, last, email in (await session.execute(
            select(UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email)
            .where(UserORM.id.in_(sorted(people_ids)))
        )).all():
            people[uid] = TransferPersonRef(
                id=uid, name=" ".join(p for p in (first, last) if p).strip() or email, email=email)

    def person(uid: Optional[str]) -> Optional[TransferPersonRef]:
        if not uid:
            return None
        return people.get(uid) or TransferPersonRef(id=uid, name="A former member")

    out: list[DataSourceTransferResponse] = []
    for r in rows:
        admin_from = _is_admin(claims, r.from_workspace_id)
        admin_to = _is_admin(claims, r.to_workspace_id)
        party = r.created_by == user_id or admin_from or admin_to

        def ws_ref(ws_id: str) -> TransferWorkspaceRef:
            shown = party or workspace_access.can_open(claims, ws_id)
            return TransferWorkspaceRef(id=ws_id, name=names.get(ws_id) if shown else None)

        plan, manifest = _load(r.plan), _load(r.manifest)
        counts = manifest.get("counts") or {}
        completed = _parse(r.completed_at)
        can_undo, blocked_by = False, None
        if r.status == "completed":
            can_undo, blocked_by = await undo_state(session, r, claims)
        pending = r.status == "pending"
        out.append(DataSourceTransferResponse(
            id=r.id, kind=r.kind, status=r.status,
            dataSource=ImpactedEntity(id=r.data_source_id, name=r.data_source_label or r.data_source_id,
                                      type="data_source"),
            fromWorkspace=ws_ref(r.from_workspace_id), toWorkspace=ws_ref(r.to_workspace_id),
            createdBy=person(r.created_by), createdAt=r.created_at, reason=r.reason,
            expiresAt=r.expires_at, resolvedBy=person(r.resolved_by), resolvedAt=r.resolved_at,
            resolutionNote=r.resolution_note, completedAt=r.completed_at,
            undoneBy=person(r.undone_by), undoneAt=r.undone_at,
            viewCount=counts.get("views", len(plan.get("viewIds") or [])),
            keptAccess=counts.get("keptSubjects", len(plan.get("keep") or [])),
            undoUntil=((completed + timedelta(days=UNDO_DAYS)).isoformat()
                       if completed and r.status == "completed" else None),
            canAccept=pending and admin_to,
            canDecline=pending and admin_to,
            canCancel=pending and (r.created_by == user_id or admin_from),
            canUndo=can_undo,
            undoBlockedBy=blocked_by,
        ))
    return out


async def detail(session: AsyncSession, *, transfer_id: str, claims: PermissionClaims,
                 user_id: str) -> DataSourceTransferDetail:
    """A transfer, and — while it waits — the move it would make now, with the proposer's
    choices and what changed since they asked."""
    await _expire_lapsed(session)
    row = await _visible_transfer(session, transfer_id, claims, user_id)
    response = (await to_responses(session, [row], claims, user_id=user_id))[0]
    if row.status != "pending":
        return DataSourceTransferDetail(transfer=response)
    ds = await data_source_repo.get_data_source_orm(session, row.data_source_id)
    if ds is None:
        return DataSourceTransferDetail(transfer=response)
    pre = await preflight(session, ds=ds, to_ws_id=row.to_workspace_id, claims=claims,
                          purpose="accept", transfer=row)
    plan = _load(row.plan)
    keep = {(k.get("type"), k.get("id")) for k in plan.get("keep") or []}
    owners = await _person_names(session, {v.created_by for v in pre.views[:_VIEW_LIST_CAP]})
    asked_views = set(plan.get("viewIds") or [])
    asked_losers = set(plan.get("losers") or [])
    now_views = set(pre.view_ids)
    return DataSourceTransferDetail(
        transfer=response,
        preview=_preview(pre, keep=keep, owners=owners),
        changesSinceRequest=TransferChanges(
            viewsAdded=len(now_views - asked_views),
            viewsRemoved=len(asked_views - now_views),
            newPeople=len({f"{t}:{i}" for t, i in pre.losers} - asked_losers),
        ),
    )


async def history(session: AsyncSession, *, ds: WorkspaceDataSourceORM, claims: PermissionClaims,
                  user_id: str) -> list[DataSourceTransferResponse]:
    await _expire_lapsed(session)
    rows = await transfer_repo.list_for_source(session, ds.id)
    return await to_responses(session, rows, claims, user_id=user_id)


async def for_workspace(session: AsyncSession, *, ws_id: str, status_filter: str,
                        claims: PermissionClaims, user_id: str) -> list[DataSourceTransferResponse]:
    await _expire_lapsed(session)
    rows = await transfer_repo.list_for_workspace(session, ws_id, status=status_filter)
    return await to_responses(session, rows, claims, user_id=user_id)


async def incoming(session: AsyncSession, *, status_filter: str, claims: PermissionClaims,
                   user_id: str) -> list[DataSourceTransferResponse]:
    """Requests into the workspaces the caller administers — all of them for an org admin."""
    await _expire_lapsed(session)
    ids = None if workspace_access.is_org_wide(claims) else [
        ws for ws in claims.ws_perms if _is_admin(claims, ws)]
    rows = await transfer_repo.list_incoming(session, ids, status=status_filter)
    return await to_responses(session, rows, claims, user_id=user_id)
