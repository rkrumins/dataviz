"""Who may let whom into a workspace.

Joining a workspace is decided here, for every path that does it — answering
an access request, the Members tab, the reconciler that closes a request once
the identity provider grants it:

* **Ceilings.** A workspace admin (Org Admin and Super Admin through their
  shortcuts) may grant any workspace role whose permissions they hold
  themselves. Someone who may only add people (``workspace:members:add`` —
  the Workspace steward) grants Viewer or Member, nothing more.
* **What may be asked for.** Workspace roles that don't administer the
  workspace or let people in: asking is for access, not for authority.
* **Teams.** Adding someone to an app-managed group bound in the workspace is
  granting everything that group carries, everywhere it is bound — so a team
  qualifies only if every one of its bindings is one the approver could make.
* **The identity provider.** A workspace whose access its IdP decides is
  reached through the IdP groups its mappings route into it. Only its admins
  let someone in around the IdP — an exception — and never for good: every
  exception ends within :data:`EXCEPTION_MAX` (:func:`exception_refusal`).
* **Provenance.** Every grant says how it came about: added directly, an
  approved request, an exception, joining an open workspace, the identity
  provider's groups, a team, or an organization-wide role
  (:class:`ProvenanceReader`).
* **Exceptions end** once the identity provider grants what they did
  (:func:`retire_covered_exceptions`).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AccessRequestORM,
    GroupMemberORM,
    GroupORM,
    IdpGroupRoleMappingORM,
    IdpProviderORM,
    RoleBindingORM,
    RoleORM,
    RolePermissionORM,
    ServiceAccountManagerORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    binding_repo,
    group_repo,
    notification_repo,
    role_repo,
    user_repo,
)
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.common.roles import role_label  # noqa: F401 — read as workspace_access.role_label
from backend.common.service_accounts import is_service_account

logger = logging.getLogger(__name__)

MEMBERS_ADD = "workspace:members:add"
#: All a steward may grant: the people who know a team let colleagues in,
#: they don't make administrators.
STEWARD_GRANTABLE_ROLES = frozenset({"workspace_viewer", "workspace_member"})
#: Platform roles reach every workspace without a binding in any.
ORG_WIDE_PERMISSIONS = ("system:admin", "system:org-admin", "system:org-viewer")
#: The order requestable roles are offered in; custom roles follow by name.
_ROLE_ORDER = ("workspace_viewer", "workspace_member", "workspace_data_engineer")
#: The longest an exception runs before someone decides on it again.
EXCEPTION_MAX = timedelta(days=90)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_org_wide(claims: PermissionClaims) -> bool:
    """Answers requests in every workspace: Super Admin and Org Admin."""
    return any(p in claims.global_perms for p in ("system:admin", "system:org-admin"))


def can_open(claims: PermissionClaims, ws_id: str) -> bool:
    """Any grant in the workspace, or a platform role that reaches every
    workspace — the rule the workspace list reads by."""
    return any(p in claims.global_perms for p in ORG_WIDE_PERMISSIONS) or bool(claims.ws_perms.get(ws_id))


def tier(claims: PermissionClaims, ws_id: str) -> Optional[str]:
    """``'admin'``, ``'steward'``, or ``None`` when they may not let anyone in."""
    if has_permission(claims, "workspace:admin", workspace_id=ws_id):
        return "admin"
    if has_permission(claims, MEMBERS_ADD, workspace_id=ws_id):
        return "steward"
    return None


def can_grant(claims: PermissionClaims, ws_id: str, role_name: str, perms: Iterable[str]) -> bool:
    """Whether the caller may grant ``role_name`` in the workspace. Only its
    workspace permissions count: a binding in a workspace confers no other."""
    level = tier(claims, ws_id)
    if level == "admin":
        return all(
            has_permission(claims, p, workspace_id=ws_id) for p in perms if p.startswith("workspace:")
        )
    if level == "steward":
        return role_name in STEWARD_GRANTABLE_ROLES
    return False


def exception_refusal(
    claims: PermissionClaims, ws_id: str, expires_at: Optional[str],
) -> Optional[tuple[int, str]]:
    """Why the caller can't grant, or extend, an exception ending at
    ``expires_at`` — ``(status, message)`` — or ``None`` when they can.
    Stepping around the identity provider is the workspace admins' call,
    and it always ends: within :data:`EXCEPTION_MAX`."""
    if tier(claims, ws_id) != "admin":
        return 403, (
            "Only the workspace's admins can let someone in as an exception. "
            "Point them to the identity provider's group instead."
        )
    if not expires_at:
        return 422, "An exception needs an end date: 90 days at most"
    try:
        ends = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return 422, "An exception needs an end date: 90 days at most"
    if ends.tzinfo is None:
        ends = ends.replace(tzinfo=timezone.utc)
    # A minute's grace: "90d" is turned into a date before this runs.
    if ends - _now() > EXCEPTION_MAX + timedelta(minutes=1):
        return 422, "An exception can last 90 days at most"
    return None


def ceiling_refusal(claims: PermissionClaims, ws_id: str, role_name: str) -> str:
    """Why :func:`can_grant` said no, in a sentence for the person refused."""
    if tier(claims, ws_id) == "steward":
        return "Stewards can grant Viewer or Member; ask a workspace admin for anything more"
    return f"You can only grant roles whose permissions you hold yourself — not '{role_name}'"


def is_requestable(perms: Iterable[str]) -> bool:
    perms = set(perms)
    return "workspace:admin" not in perms and MEMBERS_ADD not in perms


def answerable_workspace_ids(claims: PermissionClaims) -> Optional[list[str]]:
    """Workspaces whose requests the caller answers; ``None`` means all."""
    if is_org_wide(claims):
        return None
    return [ws for ws in claims.ws_perms if has_permission(claims, MEMBERS_ADD, workspace_id=ws)]


async def workspace_roles(session: AsyncSession, ws_id: str) -> list[tuple[RoleORM, list[str]]]:
    """Roles that can be bound in the workspace and are about it: at least
    one workspace permission, no platform one. Viewer, Member and Data
    engineer first, then the rest by name."""
    roles = await role_repo.list_roles(session, scope_type="workspace", scope_id=ws_id)
    perms = await role_repo.role_names_with_permissions(session, [r.name for r in roles])
    kept = [
        (r, perms.get(r.name, [])) for r in roles
        if any(p.startswith("workspace:") for p in perms.get(r.name, []))
        and not any(p.startswith("system:") for p in perms.get(r.name, []))
    ]
    rank = {name: i for i, name in enumerate(_ROLE_ORDER)}
    return sorted(kept, key=lambda rp: (rank.get(rp[0].name, len(rank)), rp[0].name))


async def addable_groups(
    session: AsyncSession, claims: PermissionClaims, ws_id: str,
) -> list[dict]:
    """App-managed teams bound in the workspace that the caller may add
    someone to: not protected, not filled by the identity provider, and
    every binding they carry — in any workspace — one the caller could
    make there. A group bound globally never qualifies, and nor does one that
    manages a service account: joining it would let someone act as the
    account, wherever the account reaches."""
    bound = [
        b for b in await binding_repo.list_for_scope(session, scope_type="workspace", scope_id=ws_id)
        if b.subject_type == "group"
    ]
    group_ids = sorted({b.subject_id for b in bound})
    if not group_ids:
        return []
    groups = (await session.execute(
        select(GroupORM).where(
            GroupORM.id.in_(group_ids),
            GroupORM.deleted_at.is_(None),
            GroupORM.source == "local",
            GroupORM.is_protected.is_(False),
        )
    )).scalars().all()
    managing = set((await session.execute(
        select(ServiceAccountManagerORM.group_id)
        .where(ServiceAccountManagerORM.group_id.in_([g.id for g in groups]))
    )).scalars())
    groups = [g for g in groups if g.id not in managing]
    if not groups:
        return []
    carried = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.subject_type == "group",
            RoleBindingORM.subject_id.in_([g.id for g in groups]),
        )
    )).scalars().all()
    perms = await role_repo.role_names_with_permissions(
        session, sorted({b.role_name for b in carried}),
    )
    counts = await group_repo.count_members_batch(session, [g.id for g in groups])
    out = []
    for group in sorted(groups, key=lambda g: g.name.lower()):
        mine = [b for b in carried if b.subject_id == group.id]
        if all(
            b.scope_type == "workspace"
            and can_grant(claims, b.scope_id, b.role_name, perms.get(b.role_name, []))
            for b in mine
        ):
            out.append({
                "id": group.id,
                "name": group.name,
                "member_count": counts.get(group.id, 0),
                "roles": sorted({b.role_name for b in mine if b.scope_id == ws_id}),
            })
    return out


async def grant_role(
    session: AsyncSession,
    *,
    subject_type: str,
    subject_id: str,
    role: str,
    ws_id: str,
    granted_by: str,
    expires_at: Optional[str] = None,
    request_id: Optional[str] = None,
    idp_exception: bool = False,
) -> tuple[RoleBindingORM, str]:
    """Grant ``role`` in the workspace. Returns the binding and
    ``'created'``, ``'reactivated'`` (a lapsed grant, made current and the
    app's own), or ``'existing'`` (they already hold it; left untouched)."""
    existing = await binding_repo.find_binding(
        session, subject_type=subject_type, subject_id=subject_id, role_name=role,
        scope_type="workspace", scope_id=ws_id,
    )
    if existing is None:
        binding = await binding_repo.create_binding(
            session, subject_type=subject_type, subject_id=subject_id, role_name=role,
            scope_type="workspace", scope_id=ws_id, granted_by=granted_by,
            expires_at=expires_at, access_request_id=request_id, idp_exception=idp_exception,
        )
        return binding, "created"
    if _is_expired(existing.expires_at, now=_now()):
        existing.expires_at = expires_at
        existing.granted_by = granted_by
        existing.granted_at = _now().isoformat()
        existing.source = "local"
        existing.access_request_id = request_id
        existing.idp_exception = idp_exception
        await session.flush()
        return existing, "reactivated"
    return existing, "existing"


async def audience(session: AsyncSession, ws_ids: Iterable[str]) -> dict[str, tuple[set[str], set[str]]]:
    """``{workspace: (people, approvers)}``: who holds a current grant in
    each workspace — directly or through a group — and which of them may
    let people in. A service account's grant counts as neither."""
    ids = list(dict.fromkeys(ws_ids))
    out: dict[str, tuple[set[str], set[str]]] = {ws: (set(), set()) for ws in ids}
    if not ids:
        return out
    now = _now()
    bindings = [
        b for b in (await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.scope_type == "workspace", RoleBindingORM.scope_id.in_(ids),
            )
        )).scalars().all()
        if not _is_expired(b.expires_at, now=now)
    ]
    perms = await role_repo.role_names_with_permissions(session, sorted({b.role_name for b in bindings}))
    group_ids = sorted({b.subject_id for b in bindings if b.subject_type == "group"})
    members: dict[str, set[str]] = {}
    if group_ids:
        rows = (await session.execute(
            select(GroupMemberORM.group_id, GroupMemberORM.user_id)
            .join(GroupORM, GroupORM.id == GroupMemberORM.group_id)
            .where(GroupMemberORM.group_id.in_(group_ids), GroupORM.deleted_at.is_(None))
        )).all()
        for gid, uid in rows:
            members.setdefault(gid, set()).add(uid)
    for b in bindings:
        if is_service_account(b.subject_id):
            continue
        people, approvers = out[b.scope_id]
        users = {b.subject_id} if b.subject_type == "user" else members.get(b.subject_id, set())
        people |= users
        if {"workspace:admin", MEMBERS_ADD} & set(perms.get(b.role_name, [])):
            approvers |= users
    return out


async def roles_held(session: AsyncSession, user_id: str, ws_ids: Iterable[str]) -> dict[str, set[str]]:
    """The roles a person holds now in each of ``ws_ids``, by any route."""
    wanted = set(ws_ids)
    group_ids = await group_repo.get_user_groups(session, user_id)
    out: dict[str, set[str]] = {}
    for b in await binding_repo.list_for_user_with_groups(session, user_id=user_id, group_ids=group_ids):
        if b.scope_type == "workspace" and b.scope_id in wanted:
            out.setdefault(b.scope_id, set()).add(b.role_name)
    return out


async def provider_names(session: AsyncSession) -> dict[str, str]:
    rows = (await session.execute(select(IdpProviderORM.id, IdpProviderORM.display_name))).all()
    return {pid: name for pid, name in rows}


async def idp_routes(session: AsyncSession, ws_id: str) -> list[dict]:
    """IdP groups whose members reach the workspace: mappings that bind a
    role in it, and mappings that fill a group bound in it."""
    bound_groups: dict[str, list[str]] = {}
    for b in await binding_repo.list_for_scope(session, scope_type="workspace", scope_id=ws_id):
        if b.subject_type == "group":
            bound_groups.setdefault(b.subject_id, []).append(b.role_name)
    mappings = (await session.execute(select(IdpGroupRoleMappingORM))).scalars().all()
    providers = await provider_names(session)
    group_names = {}
    if bound_groups:
        group_names = dict((await session.execute(
            select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(list(bound_groups)))
        )).all())
    routes = []
    for m in mappings:
        provider = providers.get(m.provider_id) if m.provider_id else None
        if m.target_type == "role_binding" and m.scope_type == "workspace" and m.scope_id == ws_id:
            routes.append({"idp_group": m.idp_group, "provider": provider, "role": m.role_name})
        elif m.target_type == "group_membership" and m.target_group_id in bound_groups:
            for role in sorted(bound_groups[m.target_group_id]):
                routes.append({
                    "idp_group": m.idp_group, "provider": provider, "role": role,
                    "via_group_id": m.target_group_id,
                    "via_group_name": group_names.get(m.target_group_id),
                })
    return sorted(routes, key=lambda r: (r["idp_group"].lower(), r.get("role") or ""))


async def org_wide_grants(
    session: AsyncSession,
) -> list[tuple[str, RoleBindingORM, Optional[GroupORM], Optional[GroupMemberORM]]]:
    """``(user, binding, group, membership)`` for everyone who reaches every
    workspace through an organization-wide role: current global bindings of
    the roles carrying :data:`ORG_WIDE_PERMISSIONS`, groups expanded."""
    roles = sorted(set((await session.execute(
        select(RolePermissionORM.role_name)
        .where(RolePermissionORM.permission_id.in_(ORG_WIDE_PERMISSIONS))
    )).scalars().all()))
    if not roles:
        return []
    now = _now()
    bindings = [
        b for b in (await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.scope_type == "global", RoleBindingORM.role_name.in_(roles),
            )
        )).scalars().all()
        if not _is_expired(b.expires_at, now=now)
    ]
    group_ids = sorted({b.subject_id for b in bindings if b.subject_type == "group"})
    groups: dict[str, GroupORM] = {}
    members: dict[str, list[GroupMemberORM]] = {}
    if group_ids:
        groups = {g.id: g for g in (await session.execute(
            select(GroupORM).where(GroupORM.id.in_(group_ids), GroupORM.deleted_at.is_(None))
        )).scalars().all()}
        for m in (await session.execute(
            select(GroupMemberORM).where(GroupMemberORM.group_id.in_(list(groups)))
        )).scalars().all():
            members.setdefault(m.group_id, []).append(m)
    out = []
    for b in bindings:
        if b.subject_type == "user":
            out.append((b.subject_id, b, None, None))
        else:
            out.extend((m.user_id, b, groups[b.subject_id], m) for m in members.get(b.subject_id, []))
    return out


class ProvenanceReader:
    """Says how each grant came about, as ``AccessProvenance`` fields.

    Built once per page (:func:`provenance_reader`) from the identity
    provider mappings, provider names, and the groups each person's
    provider asserted at their last sign-in — so an IdP grant names the
    group that actually let them in, not every group that could have.
    """

    def __init__(self, mappings, providers: dict[str, str], asserted: dict[str, set[str]]):
        self._mappings = list(mappings)
        self._providers = providers
        self._asserted = asserted

    def binding(self, b: RoleBindingORM, user_id: str) -> dict:
        """A role binding held by the person themselves."""
        if b.source == "sso":
            return self._idp(user_id, [
                m for m in self._mappings
                if m.target_type == "role_binding"
                and (m.scope_type, m.scope_id, m.role_name) == (b.scope_type, b.scope_id, b.role_name)
            ], at=b.granted_at)
        if b.idp_exception:
            origin = "exception"
        elif b.access_request_id:
            # Nobody answers their own request: one "approved" by its asker
            # is a workspace open to everyone, joined.
            origin = "joined" if b.granted_by == user_id else "request"
        else:
            origin = "direct"
        return {"origin": origin, "by": b.granted_by, "at": b.granted_at, "request_id": b.access_request_id}

    def membership(self, m: Optional[GroupMemberORM], group: Optional[GroupORM], user_id: str) -> dict:
        """A grant through a group: its identity provider filled it, or
        someone added them to the team."""
        at = m.added_at if m else None
        if m is not None and m.source == "sso":
            return self._idp(user_id, [
                x for x in self._mappings
                if x.target_type == "group_membership" and x.target_group_id == m.group_id
            ], at=at)
        if group is not None and group.source == "scim":
            return {"origin": "idp", "at": at, "idp_groups": [group.name]}
        return {
            "origin": "team",
            "source": group.name if group else None,
            "by": m.added_by if m else None,
            "at": at,
            "request_id": m.access_request_id if m else None,
        }

    def org_role(self, b: RoleBindingORM, user_id: str, m: Optional[GroupMemberORM] = None,
                 group: Optional[GroupORM] = None) -> dict:
        """An organization-wide role: named, with how they came to hold it."""
        how = self.binding(b, user_id) if group is None else self.membership(m, group, user_id)
        return {**how, "origin": "org_role", "source": b.role_name}

    def _idp(self, user_id: str, mappings: list, *, at: Optional[str]) -> dict:
        groups = {m.idp_group for m in mappings}
        asserted = self._asserted.get(user_id)
        if asserted and groups & asserted:
            groups &= asserted
        providers = {
            self._providers.get(m.provider_id) for m in mappings
            if m.idp_group in groups and m.provider_id
        } - {None}
        return {
            "origin": "idp",
            "at": at,
            "idp_groups": sorted(groups),
            "idp_provider": providers.pop() if len(providers) == 1 else None,
        }


async def provenance_reader(session: AsyncSession, user_ids: Iterable[str]) -> ProvenanceReader:
    ids = sorted(set(user_ids))
    asserted: dict[str, set[str]] = {}
    if ids:
        for uid, meta in (await session.execute(
            select(UserORM.id, UserORM.metadata_).where(UserORM.id.in_(ids))
        )).all():
            try:
                groups = json.loads(meta or "{}").get("idp_groups")
            except (ValueError, TypeError, AttributeError):
                groups = None
            if isinstance(groups, list):
                asserted[uid] = {str(g) for g in groups}
    mappings = (await session.execute(select(IdpGroupRoleMappingORM))).scalars().all()
    return ProvenanceReader(mappings, await provider_names(session), asserted)


async def _idp_grants(
    session: AsyncSession, user_id: str, ws_ids: list[str], now: datetime,
) -> list[RoleBindingORM]:
    """The person's current grants in ``ws_ids`` that their identity provider
    gave them: their own SSO bindings, and the bindings of groups it made
    them a member of."""
    sso_groups = list((await session.execute(
        select(GroupMemberORM.group_id).where(
            GroupMemberORM.user_id == user_id, GroupMemberORM.source == "sso",
        )
    )).scalars().all())
    granted = [and_(
        RoleBindingORM.subject_type == "user",
        RoleBindingORM.subject_id == user_id,
        RoleBindingORM.source == "sso",
    )]
    if sso_groups:
        granted.append(and_(
            RoleBindingORM.subject_type == "group",
            RoleBindingORM.subject_id.in_(sso_groups),
        ))
    candidates = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.scope_id.in_(ws_ids),
            or_(*granted),
        )
    )).scalars().all()
    return [b for b in candidates if not _is_expired(b.expires_at, now=now)]


async def fulfil_idp_routed_requests(session: AsyncSession, *, user_id: str) -> int:
    """Close the person's requests that wait on their identity provider in
    workspaces it now grants them — called by the SSO reconciler, the
    moment that access arrives. Returns how many it closed."""
    waiting = (await session.execute(
        select(AccessRequestORM).where(
            AccessRequestORM.requester_id == user_id,
            AccessRequestORM.status == "awaiting_idp",
        )
    )).scalars().all()
    if not waiting:
        return 0
    ws_ids = sorted({r.target_id for r in waiting})
    now = _now()
    reached = {b.scope_id for b in await _idp_grants(session, user_id, ws_ids, now)}
    names = dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(ws_ids))
    )).all())
    closed = 0
    for row in waiting:
        if row.target_id not in reached:
            continue
        row.status = "approved"
        row.fulfilled_at = now.isoformat()
        closed += 1
        name = names.get(row.target_id) or "the workspace"
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.access_request.fulfilled",
            payload={
                "request_id": row.id,
                "requester_id": row.requester_id,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "workspace_id": row.target_id,
                "idp_group": row.idp_group,
            },
        )
        await notification_repo.notify(
            session,
            user_ids=[row.requester_id],
            kind="access_request.fulfilled",
            title=f"You can now open {name}",
            body=f'Your access arrived through "{row.idp_group}".',
            link=f"/workspaces/{row.target_id}",
            resource_type="access_request",
            resource_id=row.id,
        )
        if row.resolved_by and row.resolved_by != row.requester_id:
            await notification_repo.notify(
                session,
                user_ids=[row.resolved_by],
                kind="access_request.fulfilled",
                title=f"Access to {name} arrived",
                body=f'The person you pointed to "{row.idp_group}" can now open it.',
                link="/workspaces?tab=requests",
                resource_type="access_request",
                resource_id=row.id,
            )
    if closed:
        await session.flush()
    return closed


async def settle_extension_requests(
    session: AsyncSession,
    *,
    binding_id: str,
    note: str,
    resolver_id: Optional[str] = None,
    expires_at: Optional[str] = None,
) -> int:
    """Close the open requests to keep a grant once its end has been decided
    another way — an admin moved it, or the identity provider took over.
    They read as answered. Returns how many it closed."""
    rows = (await session.execute(
        select(AccessRequestORM).where(
            AccessRequestORM.binding_id == binding_id,
            AccessRequestORM.status.in_(("pending", "awaiting_idp")),
        )
    )).scalars().all()
    now = _now().isoformat()
    for row in rows:
        row.status = "approved"
        row.resolved_at = now
        row.resolved_by = resolver_id
        row.resolution_note = note
        row.granted_role = row.requested_role
        row.access_expires_at = expires_at
    if rows:
        await session.flush()
    return len(rows)


async def retire_covered_exceptions(
    session: AsyncSession,
    *,
    user_id: str,
    asserted: Iterable[tuple[str, Optional[str], str]] = (),
) -> int:
    """End the person's exceptions that their identity provider now covers —
    called by the SSO reconciler once it has applied their groups, with the
    ``(scope_type, scope_id, role_name)`` grants their provider asserted.

    An exception (a grant made in the app for a workspace whose access its
    identity provider decides) is covered two ways:

    * **The provider grants the same role.** The exception holds the only
      binding that role can have, so the reconciler couldn't add its own:
      the exception *becomes* the provider's grant — no end, no gap — even
      one that has already lapsed, which would otherwise keep the provider's
      grant out for good.
    * **The provider's other grants in the workspace** carry every workspace
      permission it did: the exception ends.

    The person and whoever granted it hear about it; a request to keep it
    closes, answered. Returns how many ended."""
    now = _now()
    asserted = set(asserted)
    exceptions = list((await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.subject_type == "user",
            RoleBindingORM.subject_id == user_id,
            RoleBindingORM.scope_type == "workspace",
            RoleBindingORM.idp_exception.is_(True),
        )
    )).scalars().all())
    taken_over = [b for b in exceptions if (b.scope_type, b.scope_id, b.role_name) in asserted]
    live = [b for b in exceptions if b not in taken_over and not _is_expired(b.expires_at, now=now)]
    ended: list[RoleBindingORM] = []
    if live:
        from_idp: dict[str, set[str]] = {}
        for b in await _idp_grants(session, user_id, sorted({b.scope_id for b in live}), now):
            from_idp.setdefault(b.scope_id, set()).add(b.role_name)
        perms = await role_repo.role_names_with_permissions(
            session, sorted({b.role_name for b in live} | {r for roles in from_idp.values() for r in roles}),
        )

        def workspace_perms(roles) -> set[str]:
            return {p for r in roles for p in perms.get(r, []) if p.startswith("workspace:")}

        ended = [
            b for b in live
            if workspace_perms([b.role_name])
            and workspace_perms([b.role_name]) <= workspace_perms(from_idp.get(b.scope_id, ()))
        ]
    retired = taken_over + ended
    if not retired:
        return 0
    names = dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(
            WorkspaceORM.id.in_(sorted({b.scope_id for b in retired}))
        )
    )).all())
    person = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    who = (person["name"] or person["email"]) if person else "Someone"
    for b in retired:
        granter = b.granted_by
        if b in taken_over:
            # Exactly what the reconciler would have written.
            b.source, b.idp_exception, b.access_request_id = "sso", False, None
            b.granted_by, b.granted_at = None, now.isoformat()
            b.expires_at = b.expiry_reminded_at = None
        else:
            b.expires_at = now.isoformat()
        name = names.get(b.scope_id) or "the workspace"
        await settle_extension_requests(
            session, binding_id=b.id, note="Your identity provider now grants this access.",
        )
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.workspace.exception_retired",
            payload={
                "workspace_id": b.scope_id,
                "binding_id": b.id,
                "user_id": user_id,
                "role": b.role_name,
            },
        )
        await notification_repo.notify(
            session,
            user_ids=[user_id],
            kind="access.exception_retired",
            title=f"Your access to {name} now comes from your identity provider",
            body=(
                f"Your {role_label(b.role_name)} access was an exception. Your identity "
                "provider's groups grant it now, so the exception has ended."
            ),
            link=f"/workspaces/{b.scope_id}",
            resource_type="role_binding",
            resource_id=b.id,
        )
        if granter and granter != user_id:
            await notification_repo.notify(
                session,
                user_ids=[granter],
                kind="access.exception_retired",
                title=f"{who}'s exception in {name} has ended",
                body="Their identity provider now grants the same access.",
                link=f"/workspaces/{b.scope_id}?tab=members",
                resource_type="role_binding",
                resource_id=b.id,
            )
    await session.flush()
    return len(retired)


async def notify_removed(
    session: AsyncSession, ws: WorkspaceORM, binding: RoleBindingORM, *, actor_id: str, why: str = "",
) -> None:
    """Tell a person their grant was removed — and whether that leaves them
    any way in."""
    left = (await roles_held(session, binding.subject_id, [ws.id])).get(ws.id)
    role = role_label(binding.role_name)
    await notification_repo.notify(
        session,
        user_ids=[binding.subject_id],
        kind="workspace.member_removed",
        title=(
            f"Your {role} access to {ws.name} was removed" if left
            else f"You no longer have access to {ws.name}"
        ),
        body=(why or "A workspace admin removed it.") + " If you think it's a mistake, ask its admins.",
        link="/my/access",
        actor_id=actor_id,
        resource_type="workspace",
        resource_id=ws.id,
    )
