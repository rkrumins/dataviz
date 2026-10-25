"""Service accounts: principals that never sign in, for integrations to run as.

``/admin/service-accounts`` is where super and org admins
(``system:service-accounts:manage``) create them, appoint the people or teams
who answer for them, give them workspace roles, and hand a leaver's accounts
over to a successor. ``/me/service-accounts`` is where a manager finds the
accounts they answer for; their keys are made under
``/me/service-accounts/{id}/api-keys``.

An account's keys work while it has a manager in good standing, and for a
grace period after its last one goes (``service_account_standing``): every
route here that changes who manages an account brings that up to date at once.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import RoleBindingORM, WorkspaceORM
from backend.app.db.repositories import (
    api_key_repo,
    binding_repo,
    group_repo,
    notification_repo,
    outbox_event_repo,
    role_repo,
    service_account_repo,
    user_repo,
)
from backend.app.services import service_account_standing, workspace_access
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User
from backend.common.display_name import resolve_display_name
from backend.common.service_accounts import is_service_account

logger = logging.getLogger(__name__)

admin_router = APIRouter()
me_router = APIRouter()

MANAGE = "system:service-accounts:manage"
#: Who may make an account's keys without managing it.
MINT_ANY = "system:users:manage"


def people_only(request: Request) -> None:
    """For the routes about a person: a service account is not one, and is
    looked after under ``/admin/service-accounts``."""
    if is_service_account(request.path_params.get("user_id")):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")


# ── Shapes ──────────────────────────────────────────────────────────


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class ManagerRef(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    type: Literal["user", "group"]
    id: str = Field(..., min_length=1, max_length=64)


class ManagerOut(_Model):
    type: Literal["user", "group"]
    id: str
    name: str
    email: Optional[str] = None
    #: A person who could sign in now; a team with such a person in it.
    in_good_standing: bool = Field(alias="inGoodStanding")
    members_in_good_standing: Optional[int] = Field(None, alias="membersInGoodStanding")
    added_at: str = Field(alias="addedAt")
    added_by: Optional[str] = Field(None, alias="addedBy")


class KeyBrief(_Model):
    id: str
    name: str
    prefix: str
    last_used_at: Optional[str] = Field(None, alias="lastUsedAt")


class HandOverFacts(_Model):
    """For a person about to leave: the seat they hold on the account
    themselves, which a hand-over moves; the teams through which they manage
    it, which keep theirs; whether anyone answers for it without them; and the
    keys they made that still work, which they may have kept."""
    seat: bool
    teams: List[str]
    last_manager: bool = Field(alias="lastManager")
    keys_created_by: List[KeyBrief] = Field(alias="keysCreatedBy")


class RoleOut(_Model):
    binding_id: str = Field(alias="bindingId")
    workspace_id: str = Field(alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    role: str
    granted_at: Optional[str] = Field(None, alias="grantedAt")


class ServiceAccountOut(_Model):
    id: str
    name: str
    description: Optional[str] = None
    status: Literal["active", "disabled"]
    created_at: str = Field(alias="createdAt")
    created_by: Optional[str] = Field(None, alias="createdBy")
    managers: List[ManagerOut]
    #: Someone answers for it now.
    managed: bool
    #: Exactly one person answers for it — it stops when they go.
    single_manager: bool = Field(alias="singleManager")
    #: When it was found with no manager; its keys pause at ``pausesAt``.
    unmanaged_since: Optional[str] = Field(None, alias="unmanagedSince")
    pauses_at: Optional[str] = Field(None, alias="pausesAt")
    #: With ``managedBy``: what that person's leaving involves.
    hand_over: Optional[HandOverFacts] = Field(None, alias="handOver")


class ServiceAccountDetail(ServiceAccountOut):
    roles: List[RoleOut]
    live_keys: int = Field(alias="liveKeys")


class ServiceAccountList(_Model):
    items: List[ServiceAccountOut]
    total: int
    #: How long keys keep working after an account's last manager goes.
    grace_days: int = Field(alias="graceDays")


class CreateServiceAccountRequest(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: str = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    managers: List[ManagerRef] = Field(..., min_length=1, max_length=20)


class UpdateServiceAccountRequest(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)


class RoleRequest(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    workspace_id: str = Field(..., alias="workspaceId", min_length=1, max_length=64)
    role: str = Field(..., min_length=1, max_length=64)


class HandOverRequest(_Model):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    from_user_id: str = Field(..., alias="fromUserId", min_length=1, max_length=64)
    to: ManagerRef
    #: Only these of their accounts; every one they manage when left out.
    account_ids: Optional[List[str]] = Field(None, alias="accountIds", max_length=200)


class HandOverResult(_Model):
    handed_over: List[str] = Field(alias="handedOver")


# ── Building answers ────────────────────────────────────────────────


def _pauses_at(unmanaged_since: Optional[str], grace_days: int) -> Optional[str]:
    if not unmanaged_since:
        return None
    since = datetime.fromisoformat(unmanaged_since)
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    return (since + timedelta(days=grace_days)).isoformat()


async def _accounts_out(
    session: AsyncSession, rows, *, managed_by: Optional[str] = None,
) -> tuple[list[ServiceAccountOut], int]:
    rules = await service_account_standing.policy(session)
    standing = dict(
        now=datetime.now(timezone.utc), window_days=rules.window_days,
        passwords_allowed=rules.passwords_allowed,
    )
    ids = [user.id for user, _account in rows]
    managers = await service_account_repo.managers(session, ids, **standing)
    made = (
        await service_account_repo.live_keys_created_by(session, ids, managed_by)
        if managed_by else {}
    )
    teams = await service_account_repo.teams_through(session, ids, managed_by) if managed_by else {}
    out = []
    for user, account in rows:
        # Who can act for it — at most two through each team, which tells
        # nobody, one person and more than one apart.
        people = set().union(*(m.acting for m in managers[user.id]))
        hand_over = None
        if managed_by:
            seat = any(m.type == "user" and m.id == managed_by for m in managers[user.id])
            hand_over = HandOverFacts(
                seat=seat, teams=teams[user.id],
                last_manager=(seat or bool(teams[user.id])) and not (people - {managed_by}),
                keys_created_by=[
                    KeyBrief(id=k.id, name=k.name, prefix=k.token_prefix, last_used_at=k.last_used_at)
                    for k in made.get(user.id, [])
                ],
            )
        out.append(ServiceAccountOut(
            id=user.id, name=user.first_name, description=account.description,
            status="active" if user.status == "active" else "disabled",
            created_at=user.created_at, created_by=account.created_by,
            managers=[ManagerOut(**m.__dict__) for m in managers[user.id]],
            managed=bool(people), single_manager=len(people) == 1,
            unmanaged_since=account.unmanaged_since,
            pauses_at=_pauses_at(account.unmanaged_since, rules.grace_days),
            hand_over=hand_over,
        ))
    return out, rules.grace_days


async def _account_or_404(session: AsyncSession, account_id: str):
    found = await service_account_repo.get(session, account_id)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service account not found")
    return found


async def _roles(session: AsyncSession, account_id: str) -> list[RoleBindingORM]:
    bindings = await binding_repo.list_for_user_with_groups(
        session, user_id=account_id, group_ids=[],
    )
    return [b for b in bindings if b.scope_type == "workspace" and b.subject_type == "user"]


async def _detail(session: AsyncSession, account_id: str) -> ServiceAccountDetail:
    found = await _account_or_404(session, account_id)
    [base], _ = await _accounts_out(session, [found])
    bindings = await _roles(session, account_id)
    names = await user_repo.get_workspace_names_by_ids(
        session, sorted({b.scope_id for b in bindings if b.scope_id}),
    )
    return ServiceAccountDetail(
        **base.model_dump(),
        roles=[
            RoleOut(
                binding_id=b.id, workspace_id=b.scope_id, workspace_name=names.get(b.scope_id),
                role=b.role_name, granted_at=b.granted_at,
            )
            for b in sorted(bindings, key=lambda b: ((names.get(b.scope_id) or "").lower(), b.role_name))
        ],
        live_keys=await api_key_repo.count_active_for_user(session, account_id),
    )


async def _may_delegate(
    session: AsyncSession, claims: PermissionClaims, account_ids: Iterable[str],
) -> None:
    """Making someone a manager hands them everything the account can do:
    only someone who could grant each of its roles themselves may."""
    wanted = sorted(set(account_ids))
    if not wanted:
        return
    bindings = [
        b for b in (await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.subject_type == "user", RoleBindingORM.subject_id.in_(wanted),
                RoleBindingORM.scope_type == "workspace",
            )
        )).scalars().all()
    ]
    perms = await role_repo.role_names_with_permissions(session, sorted({b.role_name for b in bindings}))
    for b in bindings:
        if not workspace_access.can_grant(claims, b.scope_id, b.role_name, perms.get(b.role_name, [])):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "A manager can do whatever the service account can, so only someone who could "
                    f"grant its roles may appoint one — and you couldn't grant "
                    f"{workspace_access.role_label(b.role_name)} in that workspace"
                ),
            )


async def _record(session: AsyncSession, verb: str, account_id: str, name: str, **payload) -> None:
    await outbox_event_repo.emit(
        session,
        event_type=f"identity.service_account.{verb}",
        aggregate_type="user",
        aggregate_id=account_id,
        payload={"user_id": account_id, "name": name, **payload},
    )


async def _manager_subject(session: AsyncSession, ref: ManagerRef) -> tuple[Optional[str], Optional[str], str]:
    """``(user_id, group_id, name)`` for a person or a team that may manage an
    account: an active person who is not a break-glass account, or a team."""
    if ref.type == "group":
        group = await group_repo.get_group_by_id(session, ref.id)
        if group is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found")
        return None, group.id, group.name
    if is_service_account(ref.id):
        raise HTTPException(
            status_code=422,
            detail="A service account cannot manage a service account",
        )
    person = await user_repo.get_user_by_id(session, ref.id)
    if person is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if person.status != "active" or person.is_system_account:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only an active person who is not a break-glass account can manage a service account",
        )
    return person.id, None, resolve_display_name(person.display_name, person.first_name, person.last_name)


async def _appoint(
    session: AsyncSession, account_id: str, account_name: str, *, user_id: Optional[str],
    group_id: Optional[str], manager_name: str, actor_id: str, via: Optional[str] = None,
) -> bool:
    added = await service_account_repo.add_manager(
        session, account_id, user_id=user_id, group_id=group_id, added_by=actor_id,
    )
    if not added:
        return False
    await _record(
        session, "manager_added", account_id, account_name, changed_by=actor_id,
        manager_type="user" if user_id else "group", manager_id=user_id or group_id,
        manager_name=manager_name, via=via,
    )
    if user_id:
        await notification_repo.notify(
            session, user_ids=[user_id], kind="service_account_manager_added",
            title=f"You now manage {account_name}",
            body="You answer for this service account, and can make, rotate and revoke its API keys.",
            link=f"/me/service-accounts/{account_id}", actor_id=actor_id,
            resource_type="service_account", resource_id=account_id,
        )
    return True


async def _dismiss(
    session: AsyncSession, account_id: str, account_name: str, *, user_id: Optional[str],
    group_id: Optional[str], manager_name: str, actor_id: str, via: Optional[str] = None,
) -> bool:
    removed = await service_account_repo.remove_manager(
        session, account_id, user_id=user_id, group_id=group_id,
    )
    if removed:
        await _record(
            session, "manager_removed", account_id, account_name, changed_by=actor_id,
            manager_type="user" if user_id else "group", manager_id=user_id or group_id,
            manager_name=manager_name, via=via,
        )
        await service_account_standing.tell_keys_outlive(
            session, [account_id], person=user_id, team=group_id, actor_id=actor_id,
        )
    return removed


# ── Administrators ──────────────────────────────────────────────────


@admin_router.get("", response_model=ServiceAccountList, dependencies=[Depends(requires(MANAGE))])
async def list_service_accounts(
    q: Optional[str] = Query(None, max_length=200),
    status_filter: Optional[Literal["active", "disabled"]] = Query(None, alias="status"),
    managed_by: Optional[str] = Query(None, alias="managedBy", max_length=64),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100_000),
    session: AsyncSession = Depends(get_db_session),
):
    """Every service account, with who answers for each and whether its keys
    are about to pause. ``managedBy`` lists the accounts a person's leaving
    touches — those they manage, themselves or through a team, and those they
    made a key for that still works — with what it involves."""
    rows, total = await service_account_repo.list_page(
        session, q=q, status=status_filter, leaving=managed_by, limit=limit, offset=offset,
    )
    items, grace = await _accounts_out(session, rows, managed_by=managed_by)
    return ServiceAccountList(items=items, total=total, grace_days=grace)


@admin_router.post(
    "", response_model=ServiceAccountDetail, status_code=status.HTTP_201_CREATED,
)
async def create_service_account(
    body: CreateServiceAccountRequest,
    admin: User = Depends(requires(MANAGE)),
    session: AsyncSession = Depends(get_db_session),
):
    """A new, enabled service account, managed by the people or teams named.
    It holds no roles until it is given some."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="A service account needs a name")
    subjects = [await _manager_subject(session, ref) for ref in body.managers]
    account_id = await service_account_repo.create(
        session, name=name, description=(body.description or "").strip() or None,
        created_by=admin.id,
    )
    await _record(
        session, "created", account_id, name, created_by=admin.id,
        description=(body.description or "").strip() or None,
    )
    for user_id, group_id, manager_name in subjects:
        await _appoint(
            session, account_id, name, user_id=user_id, group_id=group_id,
            manager_name=manager_name, actor_id=admin.id,
        )
    await service_account_standing.refresh(session, [account_id])
    logger.info("Service account %s created by %s", account_id, admin.id)
    return await _detail(session, account_id)


@admin_router.post("/hand-over", response_model=HandOverResult)
async def hand_over(
    body: HandOverRequest,
    admin: User = Depends(requires(MANAGE)),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Move the service accounts a person manages to a successor — before
    they leave. Each account keeps its keys; the successor is told."""
    if is_service_account(body.from_user_id):
        raise HTTPException(status_code=422, detail="Not a person")
    if body.to.type == "user" and body.to.id == body.from_user_id:
        raise HTTPException(
            status_code=422, detail="Hand over to someone else",
        )
    to_user, to_group, to_name = await _manager_subject(session, body.to)
    leaving = await user_repo.get_identities_by_ids(session, [body.from_user_id])
    from_name = (leaving.get(body.from_user_id) or {}).get("name") or body.from_user_id
    names = await service_account_repo.seats_of(session, body.from_user_id)
    wanted = set(names) if body.account_ids is None else set(names) & set(body.account_ids)
    await _may_delegate(session, claims, wanted)
    for account_id in sorted(wanted):
        await _appoint(
            session, account_id, names[account_id], user_id=to_user, group_id=to_group,
            manager_name=to_name, actor_id=admin.id, via="hand_over",
        )
        await _dismiss(
            session, account_id, names[account_id], user_id=body.from_user_id, group_id=None,
            manager_name=from_name, actor_id=admin.id, via="hand_over",
        )
    await service_account_standing.refresh(session, wanted)
    return HandOverResult(handed_over=sorted(wanted))


@admin_router.get(
    "/{account_id}", response_model=ServiceAccountDetail, dependencies=[Depends(requires(MANAGE))],
)
async def get_service_account(
    account_id: str = Path(..., max_length=64),
    session: AsyncSession = Depends(get_db_session),
):
    return await _detail(session, account_id)


@admin_router.patch("/{account_id}", response_model=ServiceAccountDetail)
async def update_service_account(
    body: UpdateServiceAccountRequest,
    account_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    session: AsyncSession = Depends(get_db_session),
):
    """Rename an account, or say what it is for."""
    user, account = await _account_or_404(session, account_id)
    fields = body.model_fields_set
    name = body.name.strip() if "name" in fields and body.name else None
    if "name" in fields and not name:
        raise HTTPException(status_code=422, detail="A service account needs a name")
    description = (body.description or "").strip() or None
    changes = {}
    if name is not None and name != user.first_name:
        changes["name"] = {"from": user.first_name, "to": name}
    if "description" in fields and description != account.description:
        changes["description"] = {"from": account.description, "to": description}
    if changes:
        await service_account_repo.update_details(
            session, account_id, name=name, description=description,
            set_description="description" in changes,
        )
        await _record(
            session, "updated", account_id, name or user.first_name,
            updated_by=admin.id, changes=changes,
        )
    return await _detail(session, account_id)


@admin_router.post("/{account_id}/disable", response_model=ServiceAccountDetail)
async def disable_service_account(
    account_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    session: AsyncSession = Depends(get_db_session),
):
    """Stop every key the account holds, at once. Nothing is revoked:
    enabling it brings them back."""
    user, _account = await _account_or_404(session, account_id)
    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already disabled")
    await user_repo.update_user_status(session, account_id, "suspended")
    await _record(session, "disabled", account_id, user.first_name, changed_by=admin.id)
    await notification_repo.notify(
        session, user_ids=[account_id], kind="service_account_disabled",
        title="An administrator disabled it, and its keys have stopped",
        body="No key it holds works, and none can be made, until it is enabled. Nothing was revoked.",
        actor_id=admin.id, resource_type="service_account", resource_id=account_id,
    )
    return await _detail(session, account_id)


@admin_router.post("/{account_id}/enable", response_model=ServiceAccountDetail)
async def enable_service_account(
    account_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    session: AsyncSession = Depends(get_db_session),
):
    user, _account = await _account_or_404(session, account_id)
    if user.status == "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already enabled")
    await user_repo.update_user_status(session, account_id, "active")
    await _record(session, "enabled", account_id, user.first_name, changed_by=admin.id)
    await service_account_standing.refresh(session, [account_id])
    await notification_repo.notify(
        session, user_ids=[account_id], kind="service_account_enabled",
        title="An administrator enabled it again",
        body="Its keys work as they did before it was disabled.",
        actor_id=admin.id, resource_type="service_account", resource_id=account_id,
    )
    return await _detail(session, account_id)


@admin_router.put("/{account_id}/managers/{kind}/{subject_id}", response_model=ServiceAccountDetail)
async def appoint_manager(
    account_id: str = Path(..., max_length=64),
    kind: Literal["users", "groups"] = Path(...),
    subject_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Make a person, or a team, a manager of the account. A team's members
    — now and later — may then make keys that act as it."""
    user, _account = await _account_or_404(session, account_id)
    await _may_delegate(session, claims, [account_id])
    ref = ManagerRef(type="user" if kind == "users" else "group", id=subject_id)
    user_id, group_id, manager_name = await _manager_subject(session, ref)
    await _appoint(
        session, account_id, user.first_name, user_id=user_id, group_id=group_id,
        manager_name=manager_name, actor_id=admin.id,
    )
    await service_account_standing.refresh(session, [account_id])
    return await _detail(session, account_id)


@admin_router.delete("/{account_id}/managers/{kind}/{subject_id}", response_model=ServiceAccountDetail)
async def remove_manager(
    account_id: str = Path(..., max_length=64),
    kind: Literal["users", "groups"] = Path(...),
    subject_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    session: AsyncSession = Depends(get_db_session),
):
    """Stop a person, or a team, managing the account. Removing the last one
    starts the grace period after which its keys pause."""
    user, _account = await _account_or_404(session, account_id)
    if kind == "users":
        found = await user_repo.get_identities_by_ids(session, [subject_id])
        name = (found.get(subject_id) or {}).get("name") or subject_id
        user_id, group_id = subject_id, None
    else:
        group = await group_repo.get_group_by_id(session, subject_id)
        name = group.name if group else subject_id
        user_id, group_id = None, subject_id
    if not await _dismiss(
        session, account_id, user.first_name, user_id=user_id, group_id=group_id,
        manager_name=name, actor_id=admin.id,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a manager of this account")
    await service_account_standing.refresh(session, [account_id])
    return await _detail(session, account_id)


@admin_router.post("/{account_id}/roles", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
async def grant_role(
    body: RoleRequest,
    account_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Give the account a role in a workspace: one that neither administers
    the workspace nor lets people in, and that you could grant there. Its
    keys pick it up within half a minute."""
    await _account_or_404(session, account_id)
    workspace = await session.get(WorkspaceORM, body.workspace_id)
    if workspace is None or workspace.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    roles = {role.name: perms for role, perms in await workspace_access.workspace_roles(session, workspace.id)}
    perms = roles.get(body.role)
    if perms is None or not workspace_access.is_requestable(perms):
        raise HTTPException(
            status_code=422,
            detail=(
                "A service account can hold a workspace role that neither administers the "
                "workspace nor lets people in"
            ),
        )
    if not workspace_access.can_grant(claims, workspace.id, body.role, perms):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=workspace_access.ceiling_refusal(claims, workspace.id, body.role),
        )
    binding, outcome = await workspace_access.grant_role(
        session, subject_type="user", subject_id=account_id, role=body.role,
        ws_id=workspace.id, granted_by=admin.id,
    )
    if outcome == "existing":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The service account already has this role in the workspace",
        )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_bound",
        payload={
            "workspace_id": workspace.id,
            "binding_id": binding.id,
            "subject_type": "user",
            "subject_id": account_id,
            "role": body.role,
            "actor_id": admin.id,
            "expires_at": None,
            "sessions_revoked": 0,
            "idp_exception": False,
            "reactivated": outcome == "reactivated",
        },
    )
    return RoleOut(
        binding_id=binding.id, workspace_id=workspace.id, workspace_name=workspace.name,
        role=binding.role_name, granted_at=binding.granted_at,
    )


@admin_router.delete("/{account_id}/roles/{binding_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_role(
    account_id: str = Path(..., max_length=64),
    binding_id: str = Path(..., max_length=64),
    admin: User = Depends(requires(MANAGE)),
    session: AsyncSession = Depends(get_db_session),
):
    await _account_or_404(session, account_id)
    binding = await binding_repo.get_binding(session, binding_id)
    if (
        binding is None or binding.subject_type != "user" or binding.subject_id != account_id
        or binding.scope_type != "workspace"
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    await binding_repo.delete_binding(session, binding_id)
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_revoked",
        payload={
            "workspace_id": binding.scope_id,
            "binding_id": binding_id,
            "subject_type": "user",
            "subject_id": account_id,
            "role": binding.role_name,
            "actor_id": admin.id,
            "sessions_revoked": 0,
        },
    )


# ── Managers ────────────────────────────────────────────────────────


@me_router.get("", response_model=ServiceAccountList)
async def list_my_service_accounts(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100_000),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """The service accounts you answer for, yourself or through a team, a
    page at a time."""
    rows, total = await service_account_repo.list_page(
        session, managed_by=user.id, limit=limit, offset=offset,
    )
    items, grace = await _accounts_out(session, rows)
    return ServiceAccountList(items=items, total=total, grace_days=grace)


@me_router.get("/{account_id}", response_model=ServiceAccountDetail)
async def get_my_service_account(
    account_id: str = Path(..., max_length=64),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """An account you manage — or, holding ``system:users:manage``, any."""
    if not (
        await service_account_repo.is_manager(session, account_id, user.id)
        or has_permission(claims, MINT_ANY)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service account not found")
    return await _detail(session, account_id)
