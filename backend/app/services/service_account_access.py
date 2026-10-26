"""Who may do what with a service account.

A service account is looked after like a person who never signs in: its
managers run it, each workspace decides what it may do there, and the
administrators of service accounts (``system:service-accounts:manage``) keep
the guardrails. Every route about one account asks :func:`require` once, and
answers with :func:`decide`'s outcome as ``can``, so the app offers only what
the caller may do.

Whoever can act as an account — a manager, or anyone in a team that manages
it — reaches everything it reaches. So making someone able to must not give
them anything the person doing it couldn't have given them directly: for each
of the account's roles, either they hold it already or the appointer could
grant it there (:func:`appointment_refusal`).

Who may create one for themselves is a policy the administrators set
(:func:`creation_policy`): nobody but them, as it ships; anyone who lets
people into a workspace; or anyone. Creating one gives it no access.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import PlatformSettingsORM, RoleBindingORM, ServiceAccountORM, UserORM
from backend.app.db.repositories import role_repo, service_account_repo, user_repo
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.services import permission_service, workspace_access
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.common.roles import role_label

MANAGE = "system:service-accounts:manage"
#: Who may make an account's keys without managing it.
MINT_ANY = "system:users:manage"
#: Who may create a service account for themselves: the administrators of
#: service accounts alone, anyone who lets people into a workspace, or anyone.
WHO_MAY_CREATE = ("central", "granters", "everyone")
#: How many live service accounts a person may have created for themselves
#: when the policy names no number.
DEFAULT_PER_PERSON_LIMIT = 10


@dataclass(frozen=True)
class Can:
    """What the caller may do with one account."""
    view: bool = False
    #: Rename it, or say what it is for.
    edit: bool = False
    disable: bool = False
    #: Its managers can't while an administrator holds it disabled.
    enable: bool = False
    #: Appoint and remove its managers.
    managers: bool = False
    #: Make, rotate and revoke its keys.
    keys: bool = False
    #: Give it workspace roles from its own page.
    grant: bool = False
    #: Take its roles away.
    revoke: bool = False
    #: Ask a workspace for access for it, or to keep access that is ending.
    request: bool = False
    #: Its keys stop at once; it can be restored for 30 days.
    delete: bool = False
    #: Its managers can't while an administrator holds it.
    restore: bool = False


def _can(
    *, central: bool, manager: bool, mint_any: bool, held: bool, deleted: bool = False,
    in_my_workspace: bool = False,
) -> Can:
    if not (central or manager or mint_any):
        # The admins and stewards of a workspace it holds a role in see it,
        # to know whose integration it is.
        return Can(view=in_my_workspace)
    if deleted:
        # Nothing about a deleted account changes but its coming back.
        return Can(view=True, restore=central or (manager and not held))
    runs = central or manager
    return Can(
        view=True, edit=runs, disable=runs, enable=central or (manager and not held),
        managers=runs, keys=manager or mint_any, grant=central, revoke=runs, request=runs,
        delete=runs,
    )


async def _in_my_workspace(session: AsyncSession, claims: PermissionClaims, account_id: str) -> bool:
    """Whether the account holds a role in a workspace whose people the
    caller lets in."""
    return any(workspace_access.tier(claims, b.scope_id) for b in await _roles_of(session, [account_id]))


async def decide(
    session: AsyncSession, user_id: str, claims: PermissionClaims,
    account: tuple[UserORM, ServiceAccountORM],
) -> Can:
    """Its managers — themselves or through a team — run it; the
    administrators of service accounts can do all they can, and give it roles;
    someone who may make any account's keys (``system:users:manage``) sees it
    for that; and the admins and stewards of a workspace it holds a role in
    see it."""
    user, row = account
    facts = dict(
        central=has_permission(claims, MANAGE),
        manager=await service_account_repo.is_manager(session, user.id, user_id),
        mint_any=has_permission(claims, MINT_ANY), held=row.admin_hold,
        deleted=user.deleted_at is not None,
    )
    if not any((facts["central"], facts["manager"], facts["mint_any"])):
        facts["in_my_workspace"] = await _in_my_workspace(session, claims, user.id)
    return _can(**facts)


_REFUSED = {
    "enable": (
        "An administrator disabled this service account, so only an administrator of service "
        "accounts can enable it"
    ),
    "grant": "Only an administrator of service accounts can give it a role here",
    "restore": (
        "An administrator holds this service account, so only an administrator of service "
        "accounts can restore it"
    ),
}


async def require(
    session: AsyncSession, user_id: str, claims: PermissionClaims, account_id: str, action: str,
) -> tuple[UserORM, ServiceAccountORM]:
    """The account, when the caller may take ``action`` on it. Anyone who
    can't see it is told it doesn't exist; anyone who can, but not this, why.
    A deleted account, until it is purged, can be seen and restored, and
    nothing else."""
    found = await service_account_repo.get(session, account_id, deleted=True)
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service account not found")
    facts = dict(
        manager=await service_account_repo.is_manager(session, account_id, user_id),
        mint_any=has_permission(claims, MINT_ANY), held=found[1].admin_hold,
        deleted=found[0].deleted_at is not None,
    )
    central = has_permission(claims, MANAGE)
    if not (central or facts["manager"] or facts["mint_any"]):
        facts["in_my_workspace"] = await _in_my_workspace(session, claims, account_id)
    can = _can(central=central, **facts)
    if not can.view:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service account not found")
    if facts["deleted"] and action not in ("view", "restore"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This service account is deleted: restore it first",
        )
    if action == "restore" and not facts["deleted"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This service account isn't deleted")
    if not getattr(can, action):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=_REFUSED.get(action, "Only its managers, or an administrator of service accounts, can do that"),
        )
    if central and not getattr(_can(central=False, **facts), action):
        # Allowed only as an administrator of service accounts: as
        # ``requires`` does for that, only while the session is known alive.
        from backend.app.auth.dependencies import assert_session_alive_or_503

        await assert_session_alive_or_503(claims, permission=MANAGE, user_id=user_id)
    return found


# ── Who may create one ──────────────────────────────────────────────


@dataclass(frozen=True)
class CreationPolicy:
    who: str = "central"
    per_person_limit: int = DEFAULT_PER_PERSON_LIMIT
    #: An account someone creates for themselves is managed by a team they
    #: are in, so it outlives any one of them.
    require_team: bool = False


async def creation_policy(session: AsyncSession) -> CreationPolicy:
    """Who may create a service account for themselves, as the
    administrators of service accounts set it. Unset, only they may."""
    row = await session.get(PlatformSettingsORM, 1)
    if row is None:
        return CreationPolicy()
    return CreationPolicy(
        who=row.sa_who_may_create if row.sa_who_may_create in WHO_MAY_CREATE else "central",
        per_person_limit=row.sa_per_person_limit or DEFAULT_PER_PERSON_LIMIT,
        require_team=bool(row.sa_require_team_manager),
    )


def creation_refusal(policy: CreationPolicy, claims: PermissionClaims) -> Optional[str]:
    """Why the caller may not create a service account for themselves, or
    ``None`` when they may. The administrators of service accounts always
    may."""
    if policy.who == "everyone" or has_permission(claims, MANAGE):
        return None
    if policy.who == "granters":
        if any(workspace_access.tier(claims, ws) for ws in claims.ws_perms):
            return None
        return (
            "Only someone who lets people into a workspace — one of its admins or stewards — "
            "can create a service account"
        )
    return "Only an administrator of service accounts can create a service account"


# ── Who may come to act as an account ───────────────────────────────


def _gets(perms: Iterable[str]) -> list[str]:
    """What a service account holding a role gets from it: its workspace
    permissions, never one that administers the workspace or lets people in
    (as ``permission_service.resolve`` folds them)."""
    return [p for p in perms if p.startswith("workspace:") and workspace_access.is_requestable((p,))]


async def _roles_of(session: AsyncSession, account_ids: Iterable[str]) -> list[RoleBindingORM]:
    wanted = sorted(set(account_ids))
    if not wanted:
        return []
    now = datetime.now(timezone.utc)
    rows = (await session.execute(
        select(RoleBindingORM).where(
            RoleBindingORM.subject_type == "user", RoleBindingORM.subject_id.in_(wanted),
            RoleBindingORM.scope_type == "workspace",
        )
    )).scalars().all()
    return [b for b in rows if not _is_expired(b.expires_at, now=now)]


async def reach_gaps(
    session: AsyncSession, account_ids: Iterable[str], holders: list[PermissionClaims],
) -> list[tuple[RoleBindingORM, list[str]]]:
    """The accounts' roles that ``holders`` don't already give, each with
    what the account gets from it: what someone with those claims would gain
    by acting as the accounts. A role counts as held when every permission it
    gives the account is held, by any of ``holders``, in that workspace —
    through a platform role's shortcut too."""
    bindings = await _roles_of(session, account_ids)
    perms = await role_repo.role_names_with_permissions(session, sorted({b.role_name for b in bindings}))
    gaps = []
    for b in bindings:
        gets = _gets(perms.get(b.role_name, []))
        if not all(any(has_permission(h, p, workspace_id=b.scope_id) for h in holders) for p in gets):
            gaps.append((b, gets))
    return gaps


async def appointment_refusal(
    session: AsyncSession, claims: PermissionClaims, account_ids: Iterable[str],
    holders: list[PermissionClaims], who: str,
) -> Optional[str]:
    """Why the caller can't make ``who`` — with ``holders``' claims — able to
    act as these accounts, or ``None`` when they can: each role ``who`` would
    gain is one the caller could grant there."""
    blocked = [
        b for b, gets in await reach_gaps(session, account_ids, holders)
        if not workspace_access.can_grant(claims, b.scope_id, b.role_name, gets)
    ]
    if not blocked:
        return None
    names = await user_repo.get_workspace_names_by_ids(session, sorted({b.scope_id for b in blocked}))
    gained = list(dict.fromkeys(
        f"{role_label(b.role_name)} in {names.get(b.scope_id) or b.scope_id}" for b in blocked
    ))
    return (
        f"Whoever manages a service account can do whatever it can, and {who} would gain "
        f"{_listed(gained)}, which you can't grant"
    )


def _listed(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


async def holder_claims(
    session: AsyncSession, *, user_id: Optional[str] = None, group_id: Optional[str] = None,
) -> PermissionClaims:
    """What a person holds, or what a team's own roles give each member."""
    if user_id:
        return await permission_service.resolve(session, user_id)
    return await permission_service.resolve_group(session, group_id)


async def may_join_managing_team(
    session: AsyncSession, claims: PermissionClaims, group_id: str, user_id: str, who: str,
) -> list[str]:
    """The accounts a team manages, when the caller may add ``who`` to it;
    refused otherwise. Joining makes them able to act as every one of them,
    with the team's own roles besides."""
    managed = await service_account_repo.accounts_managed_by_team(session, group_id)
    if not managed:
        return managed
    holders = [
        await holder_claims(session, user_id=user_id), await holder_claims(session, group_id=group_id),
    ]
    refusal = await appointment_refusal(session, claims, managed, holders, who)
    if refusal:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"This team manages service accounts, so whoever joins it can act as them. {refusal}",
        )
    return managed
