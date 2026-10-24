"""Access-request endpoints: asking to join a workspace, and answering.

Anyone signed in can ask to join a workspace at a role that may be asked
for there (``workspace_access.is_requestable``) — Viewer, Member, Data
engineer and custom workspace roles, never authority over the workspace.
The people who let others in — its admins and stewards, and Org and Super
Admins everywhere — see one list across their workspaces and answer:

* **approve** — grant a role, optionally until a date, or add the person to
  a team bound in the workspace. Where the identity provider decides who is
  in the workspace (``access_mode='idp'``), only as a labelled exception.
* **route** — point the person to the identity-provider group that grants
  the access (``awaiting_idp``). The SSO reconciler closes the request when
  that access arrives (``workspace_access.fulfil_idp_routed_requests``).
* **deny** — with a reason the person sees.

A workspace takes requests one of three ways (``request_policy``): its
approvers decide; it is open — anyone joins as a Viewer at once, and more
still needs approval; or it is closed to requests. Someone whose
time-limited access is ending asks to keep it: a request like any other,
tied to the grant, that extends it when approved.

The requester can withdraw an open request, and everyone involved hears
through the Inbox. A requester sees a workspace's name only if they could
see it anyway: they can open it, or it is listed in Find a workspace while
that is switched on.

Routes (mounted from ``api.py``):

  GET    /api/v1/access-requests/requestable-roles?workspaceId=
  POST   /api/v1/access-requests
  POST   /api/v1/access-requests/extend
  POST   /api/v1/access-requests/join
  GET    /api/v1/me/access-requests?status=
  POST   /api/v1/me/access-requests/{id}/withdraw
  GET    /api/v1/admin/access-requests?status=open&workspaceId=
  GET    /api/v1/admin/workspaces/{ws_id}/access-requests?status=open
  POST   /api/v1/admin/access-requests/{id}/approve
  POST   /api/v1/admin/access-requests/{id}/route
  POST   /api/v1/admin/access-requests/{id}/deny

Outbox events fire on every state transition — ``rbac.access_request.``
``created``, ``approved``, ``denied``, ``withdrawn`` and ``routed`` here,
``fulfilled`` from the reconciler — alongside ``rbac.workspace.member_bound``
or ``rbac.group.member_added`` for the access an approval grants.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, requires
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db.engine import get_db_session
from backend.app.db.models import (
    AccessRequestORM,
    GroupMemberORM,
    GroupORM,
    IdpGroupRoleMappingORM,
    IdpProviderORM,
    RoleBindingORM,
    UserIdentityORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    access_request_repo,
    binding_repo,
    group_repo,
    notification_repo,
    role_repo,
    user_repo,
)
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.services import workspace_access
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims, has_permission, resolve
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    AccessExtensionCreate,
    AccessJoinCreate,
    AccessRequestApprove,
    AccessRequestCreate,
    AccessRequestGroupRef,
    AccessRequestRequester,
    AccessRequestResolve,
    AccessRequestResponse,
    AccessRequestRoute,
    AccessRequestTarget,
    RequestableRole,
    RequestOptions,
)


logger = logging.getLogger(__name__)

_DIRECTORY_FLAG = "workspaceDirectoryEnabled"
#: What joining a workspace open to everyone grants.
_JOIN_ROLE = "workspace_viewer"

# Three routers — each mounts on a different prefix in api.py so the
# auth gate is naturally scoped.
public_router = APIRouter()    # /access-requests              (any auth user)
me_router = APIRouter()        # /me/access-requests           (any auth user)
admin_ws_router = APIRouter()  # /admin/workspaces/{ws_id}/... (workspace:members:add)
admin_router = APIRouter()     # /admin/access-requests/*      (answerers; checked per request)


# ── Helpers ──────────────────────────────────────────────────────────


def _idp_managed(message: str) -> HTTPException:
    """The typed refusal for a workspace whose access its identity provider
    decides, so the client can offer the identity-provider route instead."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"type": "idp_managed", "message": message},
    )


def _closed() -> HTTPException:
    """The typed refusal for a workspace that takes no requests."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "type": "closed",
            "message": "This workspace isn't taking requests. Ask its admins to add you.",
        },
    )


async def _live_workspace(session: AsyncSession, ws_id: str) -> WorkspaceORM:
    ws = (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == ws_id, WorkspaceORM.deleted_at.is_(None))
    )).scalar_one_or_none()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


async def _directory_on(session: AsyncSession) -> bool:
    return await feature_flags.is_enabled(
        _DIRECTORY_FLAG, session, default=fail_safe_default(_DIRECTORY_FLAG),
    )


async def _to_responses(
    session: AsyncSession,
    rows: list[AccessRequestORM],
    *,
    reader: Optional[PermissionClaims] = None,
) -> list[AccessRequestResponse]:
    """Requests as the API returns them, hydrated in a handful of queries
    however many there are.

    ``reader`` is the requester's claims when the requester is reading:
    a workspace they could not otherwise see keeps its name and access mode
    to itself. Answerers (``reader=None``) see everything about the
    workspaces they answer.
    """
    if not rows:
        return []
    user_ids = sorted({r.requester_id for r in rows})
    identities = await user_repo.get_identities_by_ids(session, user_ids)
    linked = set((await session.execute(
        select(UserIdentityORM.user_id).where(UserIdentityORM.user_id.in_(user_ids))
    )).scalars().all())
    ws_ids = sorted({r.target_id for r in rows if r.target_type == "workspace"})
    workspaces = {
        w.id: w for w in (await session.execute(
            select(WorkspaceORM).where(WorkspaceORM.id.in_(ws_ids))
        )).scalars().all()
    }
    group_ids = sorted({r.granted_group_id for r in rows if r.granted_group_id})
    group_names = dict((await session.execute(
        select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(group_ids))
    )).all()) if group_ids else {}
    providers = await _providers_by_idp_group(session, {r.idp_group for r in rows if r.idp_group})
    directory_on = await _directory_on(session) if reader is not None else False
    binding_ids = sorted({r.binding_id for r in rows if r.binding_id})
    bindings = {
        b.id: b for b in (await session.execute(
            select(RoleBindingORM).where(RoleBindingORM.id.in_(binding_ids))
        )).scalars().all()
    } if binding_ids else {}

    out = []
    for r in rows:
        ident = identities.get(r.requester_id)
        ws = workspaces.get(r.target_id) if r.target_type == "workspace" else None
        visible = ws is not None and (
            reader is None
            or workspace_access.can_open(reader, ws.id)
            or (directory_on and ws.directory_listed and ws.deleted_at is None)
        )
        out.append(AccessRequestResponse(
            id=r.id,
            requester=AccessRequestRequester(
                id=r.requester_id,
                email=ident["email"] if ident else None,
                display_name=(ident["name"] or ident["email"]) if ident else None,
                sso_linked=r.requester_id in linked,
            ),
            target=AccessRequestTarget(
                type=r.target_type,
                id=r.target_id,
                label=ws.name if visible else None,
                access_mode=(ws.access_mode or "app") if visible else None,
            ),
            requested_role=r.requested_role,
            justification=r.justification,
            status=r.status,
            created_at=r.created_at,
            resolved_at=r.resolved_at,
            resolved_by=r.resolved_by,
            resolution_note=r.resolution_note,
            granted_role=r.granted_role,
            granted_group=(
                AccessRequestGroupRef(id=r.granted_group_id, name=group_names.get(r.granted_group_id))
                if r.granted_group_id else None
            ),
            idp_group=r.idp_group,
            idp_provider=providers.get(r.idp_group) if r.idp_group else None,
            # A request to keep an exception is about one, answered or not.
            idp_exception=bool(r.idp_exception or (
                r.binding_id in bindings and bindings[r.binding_id].idp_exception
            )),
            access_expires_at=r.access_expires_at,
            fulfilled_at=r.fulfilled_at,
            binding_id=r.binding_id,
            current_expires_at=bindings[r.binding_id].expires_at if r.binding_id in bindings else None,
            reminded_at=r.reminded_at,
            escalated_at=r.escalated_at,
        ))
    return out


async def _providers_by_idp_group(session: AsyncSession, idp_groups: set[str]) -> dict[str, str]:
    """The identity provider each group name belongs to — when its mappings
    name exactly one."""
    if not idp_groups:
        return {}
    rows = (await session.execute(
        select(IdpGroupRoleMappingORM.idp_group, IdpProviderORM.display_name)
        .join(IdpProviderORM, IdpProviderORM.id == IdpGroupRoleMappingORM.provider_id)
        .where(IdpGroupRoleMappingORM.idp_group.in_(sorted(idp_groups)))
    )).all()
    seen: dict[str, set[str]] = {}
    for group, provider in rows:
        seen.setdefault(group, set()).add(provider)
    return {group: names.pop() for group, names in seen.items() if len(names) == 1}


async def _requester_name(session: AsyncSession, user_id: str) -> str:
    ident = (await user_repo.get_identities_by_ids(session, [user_id])).get(user_id)
    return (ident["name"] or ident["email"]) if ident else "Someone"


async def _load_open_for_answer(
    session: AsyncSession,
    request_id: str,
    answerer: User,
    *,
    statuses: tuple[str, ...] = access_request_repo.OPEN_STATUSES,
) -> tuple[AccessRequestORM, PermissionClaims, WorkspaceORM]:
    """Lock the request and confirm the caller may answer it.

    Authorization is keyed off the *target* — only someone who may let
    people into the request's workspace may answer it. Implemented in a
    helper rather than as a FastAPI dep because the workspace id we need to
    gate against is in the row, not the URL. Claims are resolved from the
    database rather than the JWT, so a freshly granted role takes effect
    immediately. The row lock makes two approvers answering at once decide
    one after the other.
    """
    row = await access_request_repo.get(session, request_id, for_update=True)
    if row is None:
        raise HTTPException(status_code=404, detail="Access request not found")
    if row.target_type != "workspace":
        raise HTTPException(status_code=400, detail="Only workspace requests are answerable")
    claims = await resolve(session, answerer.id)
    if workspace_access.tier(claims, row.target_id) is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the workspace's admins and stewards answer its access requests",
        )
    if row.status not in statuses:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Access request already {row.status}",
        )
    if row.requester_id == answerer.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can't answer your own request",
        )
    ws = (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == row.target_id)
    )).scalar_one_or_none()
    if ws is None or ws.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The workspace was deleted")
    return row, claims, ws


async def _grantable_role(
    session: AsyncSession, claims: PermissionClaims, ws_id: str, role: str,
) -> list[str]:
    """The role's permissions — refused when it isn't a workspace role here,
    or the caller couldn't grant it themselves."""
    perms = dict(
        (r.name, p) for r, p in await workspace_access.workspace_roles(session, ws_id)
    ).get(role)
    if perms is None:
        raise HTTPException(status_code=400, detail=f"Role '{role}' can't be granted in this workspace")
    if not workspace_access.can_grant(claims, ws_id, role, perms):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=workspace_access.ceiling_refusal(claims, ws_id, role),
        )
    return perms


async def _name_for(session: AsyncSession, ws: WorkspaceORM, user_id: str) -> str:
    """The workspace's name as this person may see it — the same rule as
    :func:`_to_responses`, for the Inbox."""
    claims = await resolve(session, user_id)
    if workspace_access.can_open(claims, ws.id) or (ws.directory_listed and await _directory_on(session)):
        return ws.name
    return "the workspace"


# ── Ask ──────────────────────────────────────────────────────────────


@public_router.get(
    "/requestable-roles",
    response_model=RequestOptions,
    response_model_by_alias=True,
)
async def list_requestable_roles(
    workspace_id: str = Query(..., alias="workspaceId"),
    _user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """The roles anyone may ask for in a workspace, and how it takes
    requests — never its name, so a shared link works without telling a
    stranger what the workspace is."""
    ws = await _live_workspace(session, workspace_id)
    roles = [
        RequestableRole(name=r.name, description=r.description, is_system=r.is_system)
        for r, perms in await workspace_access.workspace_roles(session, workspace_id)
        if workspace_access.is_requestable(perms)
    ]
    policy = ws.request_policy or "approval"
    return RequestOptions(
        roles=roles,
        request_policy=policy,
        join_role=_JOIN_ROLE if policy == "open" and any(r.name == _JOIN_ROLE for r in roles) else None,
    )


@public_router.post(
    "",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def submit_access_request(
    body: AccessRequestCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Any authenticated user can ask to join a workspace.

    The role must be one that may be asked for there, and one they don't
    already have. A person has one open request per workspace: asking again
    returns it (200) instead of opening another (201). The workspace's
    admins and stewards hear through the Inbox — Org Admins when it has
    none.
    """
    if body.target_type != "workspace":
        raise HTTPException(status_code=400, detail="Only target_type='workspace' is supported")
    ws = await _live_workspace(session, body.target_id)
    if (ws.request_policy or "approval") == "closed":
        raise _closed()

    perms = dict(
        (r.name, p) for r, p in await workspace_access.workspace_roles(session, ws.id)
    ).get(body.requested_role)
    if perms is None or not workspace_access.is_requestable(perms):
        raise HTTPException(
            status_code=400,
            detail=f"Role '{body.requested_role}' can't be asked for in this workspace",
        )
    claims = await resolve(session, user.id)
    held = (await workspace_access.roles_held(session, user.id, [ws.id])).get(ws.id, set())
    if body.requested_role in held or all(
        has_permission(claims, p, workspace_id=ws.id) for p in perms
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have this access",
        )

    # One open request per person per workspace: a second ask returns the
    # first, so approvers triage one row rather than a stack of repeats.
    row, created = await access_request_repo.create(
        session,
        requester_id=user.id,
        target_type=body.target_type,
        target_id=body.target_id,
        requested_role=body.requested_role,
        justification=body.justification,
    )
    if not created:
        if row.binding_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You've asked to keep your access to this workspace. Ask for more once that's answered.",
            )
        response.status_code = status.HTTP_200_OK
        return (await _to_responses(session, [row], reader=claims))[0]

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.created",
        payload={
            "request_id": row.id,
            "requester_id": user.id,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "workspace_id": row.target_id,
            "requested_role": row.requested_role,
        },
    )
    _people, approvers = (await workspace_access.audience(session, [ws.id]))[ws.id]
    recipients = approvers or await notification_repo.users_with_global_permission(
        session, "system:org-admin",
    )
    who = await _requester_name(session, user.id)
    await notification_repo.notify(
        session,
        user_ids=recipients,
        kind="access_request.submitted",
        title=f"{who} asked to join {ws.name}",
        body=(
            f"As {workspace_access.role_label(row.requested_role)}"
            + (f": “{row.justification}”" if row.justification else ".")
        ),
        link="/workspaces?tab=requests",
        actor_id=user.id,
        resource_type="access_request",
        resource_id=row.id,
    )
    return (await _to_responses(session, [row], reader=claims))[0]


@public_router.post(
    "/extend",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def ask_to_keep_access(
    body: AccessExtensionCreate,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask to keep time-limited access before it ends — a request the
    workspace's approvers answer like any other, and that extends the grant
    when approved. Only your own grant made here, with an end still ahead;
    the identity provider's grants don't end this way. A workspace closed to
    requests still takes these: its people are asking to stay."""
    binding = await binding_repo.get_binding(session, body.binding_id)
    if (
        binding is None or binding.subject_type != "user" or binding.subject_id != user.id
        or binding.scope_type != "workspace"
    ):
        raise HTTPException(status_code=404, detail="Access not found")
    if binding.source != "local" or not binding.expires_at or _is_expired(
        binding.expires_at, now=datetime.now(timezone.utc),
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only access granted here with an end date still ahead can be kept",
        )
    ws = await _live_workspace(session, binding.scope_id)
    claims = await resolve(session, user.id)
    row, created = await access_request_repo.create(
        session,
        requester_id=user.id,
        target_type="workspace",
        target_id=ws.id,
        requested_role=binding.role_name,
        justification=body.justification,
        binding_id=binding.id,
    )
    if not created:
        # The one open request per workspace may be another one.
        if row.binding_id != binding.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You already have an open request for this workspace. Withdraw it, or wait for "
                       "its answer, to ask to keep this access.",
            )
        response.status_code = status.HTTP_200_OK
        return (await _to_responses(session, [row], reader=claims))[0]

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.created",
        payload={
            "request_id": row.id,
            "requester_id": user.id,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "workspace_id": row.target_id,
            "requested_role": row.requested_role,
            "binding_id": binding.id,
        },
    )
    if binding.idp_exception:
        # Only admins keep an exception going.
        approvers = await notification_repo.users_who_can(
            session, workspace_id=ws.id, permission="workspace:admin",
        )
    else:
        _people, approvers = (await workspace_access.audience(session, [ws.id]))[ws.id]
    recipients = approvers or await notification_repo.users_with_global_permission(
        session, "system:org-admin",
    )
    who = await _requester_name(session, user.id)
    await notification_repo.notify(
        session,
        user_ids=recipients,
        kind="access_request.submitted",
        title=f"{who} asks to keep their access to {ws.name}",
        body=(
            f"{workspace_access.role_label(binding.role_name)} access ends on {binding.expires_at[:10]}"
            + (f": “{row.justification}”" if row.justification else ".")
        ),
        link="/workspaces?tab=requests",
        actor_id=user.id,
        resource_type="access_request",
        resource_id=row.id,
    )
    return (await _to_responses(session, [row], reader=claims))[0]


@public_router.post(
    "/join",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def join_open_workspace(
    body: AccessJoinCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Join a workspace open to everyone, as a Viewer, at once. Recorded as
    a request answered as it was made, so the workspace's request history
    shows who joined, and the grant reads as joined. Anything more than
    Viewer is asked for as usual."""
    ws = await _live_workspace(session, body.workspace_id)
    if (ws.request_policy or "approval") != "open" or (ws.access_mode or "app") != "app":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"type": "not_open", "message": "This workspace isn't open to join. Ask for access instead."},
        )
    claims = await resolve(session, user.id)
    if workspace_access.can_open(claims, ws.id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You can already open this workspace")
    if _JOIN_ROLE not in {r.name for r, _p in await workspace_access.workspace_roles(session, ws.id)}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This workspace has no Viewer role to join as")

    row = await access_request_repo.record_join(
        session, requester_id=user.id, target_id=ws.id, role=_JOIN_ROLE,
        note="Joined — the workspace is open to everyone.",
    )
    binding, _outcome = await workspace_access.grant_role(
        session, subject_type="user", subject_id=user.id, role=_JOIN_ROLE, ws_id=ws.id,
        granted_by=user.id, request_id=row.id,
    )
    revoked = await revoke_subject_sessions(
        "user", user.id, session=session, reason="workspace_binding_added",
    )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_joined",
        payload={
            "workspace_id": ws.id,
            "binding_id": binding.id,
            "user_id": user.id,
            "actor_id": user.id,
            "role": _JOIN_ROLE,
            "access_request_id": row.id,
            "sessions_revoked": revoked,
        },
    )
    return (await _to_responses(session, [row]))[0]


# ── Self-service: my requests ────────────────────────────────────────


@me_router.get(
    "/access-requests",
    response_model=list[AccessRequestResponse],
    response_model_by_alias=True,
)
async def list_my_access_requests(
    status_filter: str | None = Query(default=None, alias="status"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Caller's own requests, newest first. ``?status=open`` (or ``all``,
    or one status) for the My Access page's filter."""
    try:
        rows = await access_request_repo.list_for_requester(
            session, requester_id=user.id, status=status_filter,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await _to_responses(session, rows, reader=await resolve(session, user.id))


@me_router.post(
    "/access-requests/{request_id}/withdraw",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
)
async def withdraw_my_access_request(
    request_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Take back an open request — no longer needed, or asked by mistake."""
    row = await access_request_repo.get(session, request_id, for_update=True)
    if row is None or row.requester_id != user.id:
        raise HTTPException(status_code=404, detail="Access request not found")
    try:
        await access_request_repo.resolve(
            session, request_id=request_id, new_status="withdrawn", resolver_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Access request already {row.status}",
        ) from exc
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.withdrawn",
        payload={
            "request_id": row.id,
            "requester_id": row.requester_id,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "workspace_id": row.target_id,
            "requested_role": row.requested_role,
            "actor_id": user.id,
        },
    )
    return (await _to_responses(session, [row], reader=await resolve(session, user.id)))[0]


# ── Answerers: requests to review ────────────────────────────────────


@admin_router.get(
    "",
    response_model=list[AccessRequestResponse],
    response_model_by_alias=True,
)
async def list_requests_to_answer(
    status_filter: str | None = Query(default="open", alias="status"),
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """One list across every workspace the caller lets people into — open
    requests by default, ``?status=all`` for the history. Empty for someone
    who answers none."""
    claims = await resolve(session, user.id)
    ws_ids = workspace_access.answerable_workspace_ids(claims)
    if workspace_id is not None:
        if ws_ids is not None and workspace_id not in ws_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't answer this workspace's access requests",
            )
        ws_ids = [workspace_id]
    try:
        rows = await access_request_repo.list_for_targets(
            session, target_ids=ws_ids, status=status_filter,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await _to_responses(session, rows)


@admin_ws_router.get(
    "",
    response_model=list[AccessRequestResponse],
    response_model_by_alias=True,
)
async def list_workspace_access_requests(
    ws_id: str,
    status_filter: str | None = Query(default="open", alias="status"),
    _answerer: User = Depends(requires(workspace_access.MEMBERS_ADD, workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """One workspace's requests. Defaults to the open ones so the workflow
    lands on what needs an answer."""
    try:
        rows = await access_request_repo.list_for_target(
            session,
            target_type="workspace",
            target_id=ws_id,
            status=status_filter,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await _to_responses(session, rows)


# ── Answer: approve / route / deny ───────────────────────────────────


@admin_router.post(
    "/{request_id}/approve",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
)
async def approve_access_request(
    request_id: str = Path(...),
    body: AccessRequestApprove | None = None,
    answerer: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Approve, granting the access in the same transaction.

    * ``role`` (the one asked for when neither ``role`` nor ``groupId`` is
      given), optionally until ``expiresAt`` / ``expiresIn`` — within what
      the answerer could grant themselves. A grant that lapsed is made
      current again; one they already hold is left as it is.
    * ``groupId`` — add them to a team bound in the workspace, one whose
      every role the answerer could grant (``workspace_access.addable_groups``).

    For a workspace whose access its identity provider decides, a role is
    granted only with ``exception: true`` and is marked as one; teams are
    not offered, and routing to the provider's group is the usual answer.
    The requester's sessions end so their next request carries the access.
    """
    body = body or AccessRequestApprove()
    row, claims, ws = await _load_open_for_answer(session, request_id, answerer)
    if row.binding_id:
        return await _approve_extension(session, row, claims, ws, answerer, body)
    idp_mode = (ws.access_mode or "app") == "idp"

    granted_role: Optional[str] = None
    granted_group_id: Optional[str] = None
    expires_at: Optional[str] = None
    exception = False
    if body.group_id:
        if idp_mode:
            raise _idp_managed(
                "Its identity provider decides who is in this workspace, so teams aren't "
                "offered here. Point the request to the provider's group, or grant a role "
                "as an exception."
            )
        if body.group_id not in {
            g["id"] for g in await workspace_access.addable_groups(session, claims, ws.id)
        }:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can't add people to that team",
            )
        granted_group_id = body.group_id
        if await session.get(GroupMemberORM, (body.group_id, row.requester_id)) is None:
            await group_repo.add_member(
                session, body.group_id, row.requester_id,
                added_by=answerer.id, access_request_id=row.id,
            )
            revoked = await revoke_subject_sessions(
                "user", row.requester_id, session=session, reason="group_membership_added",
            )
            await user_repo.create_outbox_event(
                session,
                event_type="rbac.group.member_added",
                payload={
                    "group_id": body.group_id,
                    "user_id": row.requester_id,
                    "actor_id": answerer.id,
                    "sessions_revoked": revoked,
                    "via": "access_request",
                    "access_request_id": row.id,
                },
            )
    else:
        granted_role = body.role or row.requested_role
        perms = await _grantable_role(session, claims, ws.id, granted_role)
        if not body.role and not workspace_access.is_requestable(perms):
            # Approving as asked grants what may be asked for — a request
            # from before that rule, for authority over the workspace,
            # needs the answerer to choose the role deliberately.
            raise HTTPException(
                status_code=400,
                detail=f"'{granted_role}' administers the workspace; choose the role to grant",
            )
        if idp_mode and not body.exception:
            raise _idp_managed(
                "Its identity provider decides who is in this workspace. Point the request to "
                "the provider's group, or confirm granting the role here as an exception."
            )
        if idp_mode:
            refusal = workspace_access.exception_refusal(claims, ws.id, body.expires_at)
            if refusal:
                raise HTTPException(status_code=refusal[0], detail=refusal[1])
        binding, outcome = await workspace_access.grant_role(
            session,
            subject_type="user",
            subject_id=row.requester_id,
            role=granted_role,
            ws_id=ws.id,
            granted_by=answerer.id,
            expires_at=body.expires_at,
            request_id=row.id,
            idp_exception=idp_mode,
        )
        expires_at = binding.expires_at
        exception = idp_mode and outcome != "existing"
        if outcome != "existing":
            revoked = await revoke_subject_sessions(
                "user", row.requester_id, session=session, reason="workspace_binding_added",
            )
            await user_repo.create_outbox_event(
                session,
                event_type="rbac.workspace.member_bound",
                payload={
                    "workspace_id": ws.id,
                    "binding_id": binding.id,
                    "subject_type": "user",
                    "subject_id": row.requester_id,
                    "role": granted_role,
                    "actor_id": answerer.id,
                    "expires_at": binding.expires_at,
                    "sessions_revoked": revoked,
                    "access_request_id": row.id,
                    "idp_exception": exception,
                    "reactivated": outcome == "reactivated",
                },
            )

    resolved = await access_request_repo.resolve(
        session,
        request_id=row.id,
        new_status="approved",
        resolver_id=answerer.id,
        note=body.note,
        granted_role=granted_role,
        granted_group_id=granted_group_id,
        access_expires_at=expires_at,
        idp_exception=exception,
    )
    assert resolved is not None  # locked above
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.approved",
        payload={
            "request_id": resolved.id,
            "requester_id": resolved.requester_id,
            "target_type": resolved.target_type,
            "target_id": resolved.target_id,
            "workspace_id": resolved.target_id,
            "requested_role": resolved.requested_role,
            "granted_role": granted_role,
            "granted_group_id": granted_group_id,
            "expires_at": expires_at,
            "idp_exception": exception,
            "actor_id": answerer.id,
        },
    )
    if granted_group_id:
        group = await group_repo.get_group_by_id(session, granted_group_id)
        how = f"You were added to the team “{group.name if group else granted_group_id}”."
    else:
        how = f"You were granted {workspace_access.role_label(granted_role)}" + (
            f" until {expires_at[:10]}." if expires_at else "."
        )
    await notification_repo.notify(
        session,
        user_ids=[resolved.requester_id],
        kind="access_request.approved",
        title=f"You can now open {ws.name}",
        body=" ".join(filter(None, [how, resolved.resolution_note])),
        link=f"/workspaces/{ws.id}",
        actor_id=answerer.id,
        resource_type="access_request",
        resource_id=resolved.id,
    )
    logger.info(
        "Access request %s approved by %s (workspace=%s, role=%s, group=%s, exception=%s)",
        resolved.id, answerer.id, ws.id, granted_role, granted_group_id, exception,
    )
    return (await _to_responses(session, [resolved]))[0]


async def _approve_extension(
    session: AsyncSession,
    row: AccessRequestORM,
    claims: PermissionClaims,
    ws: WorkspaceORM,
    answerer: User,
    body: AccessRequestApprove,
) -> AccessRequestResponse:
    """Approve a request to keep access: the grant gets the end chosen
    (``expiresIn`` / ``expiresAt``; neither means no end), within what the
    answerer could grant. An exception stays one — so keeping it is the
    admins' decision, confirmed as an exception again, with a new end."""
    binding = await binding_repo.get_binding(session, row.binding_id)
    if binding is None or binding.scope_id != ws.id or binding.subject_id != row.requester_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That access has been removed; they can ask to join again",
        )
    await _grantable_role(session, claims, ws.id, binding.role_name)
    if binding.idp_exception:
        if not body.exception:
            raise _idp_managed(
                "This access is an exception to the identity provider. Confirm keeping it as "
                "an exception, or point them to the provider's group."
            )
        refusal = workspace_access.exception_refusal(claims, ws.id, body.expires_at)
        if refusal:
            raise HTTPException(status_code=refusal[0], detail=refusal[1])
    lapsed = _is_expired(binding.expires_at, now=datetime.now(timezone.utc))
    binding.expires_at = body.expires_at
    binding.expiry_reminded_at = None
    await session.flush()
    revoked = 0
    if lapsed:
        # It ended while the request waited: the person's sessions carry
        # claims without it.
        revoked = await revoke_subject_sessions(
            "user", row.requester_id, session=session, reason="workspace_binding_added",
        )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_expiry_updated",
        payload={
            "workspace_id": ws.id,
            "binding_id": binding.id,
            "subject_type": "user",
            "subject_id": row.requester_id,
            "role": binding.role_name,
            "new_expires_at": binding.expires_at,
            "actor_id": answerer.id,
            "access_request_id": row.id,
            "sessions_revoked": revoked,
        },
    )
    resolved = await access_request_repo.resolve(
        session,
        request_id=row.id,
        new_status="approved",
        resolver_id=answerer.id,
        note=body.note,
        granted_role=binding.role_name,
        access_expires_at=binding.expires_at,
        idp_exception=bool(binding.idp_exception),
    )
    assert resolved is not None  # locked by the caller
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.approved",
        payload={
            "request_id": resolved.id,
            "requester_id": resolved.requester_id,
            "target_type": resolved.target_type,
            "target_id": resolved.target_id,
            "workspace_id": resolved.target_id,
            "requested_role": resolved.requested_role,
            "granted_role": binding.role_name,
            "binding_id": binding.id,
            "expires_at": binding.expires_at,
            "actor_id": answerer.id,
        },
    )
    ends = f"now ends on {binding.expires_at[:10]}" if binding.expires_at else "no longer ends"
    await notification_repo.notify(
        session,
        user_ids=[resolved.requester_id],
        kind="access_request.approved",
        title=f"You can keep your access to {ws.name}",
        body=" ".join(filter(None, [
            f"Your {workspace_access.role_label(binding.role_name)} access {ends}.",
            resolved.resolution_note,
        ])),
        link=f"/workspaces/{ws.id}",
        actor_id=answerer.id,
        resource_type="access_request",
        resource_id=resolved.id,
    )
    return (await _to_responses(session, [resolved]))[0]


@admin_router.post(
    "/{request_id}/route",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
)
async def route_access_request(
    body: AccessRequestRoute,
    request_id: str = Path(...),
    answerer: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Point the person to the identity-provider group that grants the
    access, for a workspace whose access its identity provider decides.

    The group must be one whose members reach this workspace — a mapping
    binds a role here, or fills a team bound here — and every role it leads
    to one the answerer could grant. The request waits (``awaiting_idp``)
    and closes itself when the access arrives at their next sign-in.
    """
    row, claims, ws = await _load_open_for_answer(
        session, request_id, answerer, statuses=("pending",),
    )
    if (ws.access_mode or "app") != "idp":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This workspace's access is decided here: approve or deny the request instead",
        )
    routes = [
        r for r in await workspace_access.idp_routes(session, ws.id)
        if r["idp_group"] == body.idp_group
    ]
    if not routes:
        raise HTTPException(
            status_code=400,
            detail=f"No identity-provider group called '{body.idp_group}' grants access to this workspace",
        )
    perms = await role_repo.role_names_with_permissions(session, sorted({r["role"] for r in routes}))
    if not all(workspace_access.can_grant(claims, ws.id, r["role"], perms.get(r["role"], [])) for r in routes):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="That group grants more than you could grant yourself",
        )

    resolved = await access_request_repo.resolve(
        session,
        request_id=row.id,
        new_status="awaiting_idp",
        resolver_id=answerer.id,
        note=body.note,
        idp_group=body.idp_group,
    )
    assert resolved is not None  # locked above
    providers = {r["provider"] for r in routes if r["provider"]}
    provider = providers.pop() if len(providers) == 1 else None
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.routed",
        payload={
            "request_id": resolved.id,
            "requester_id": resolved.requester_id,
            "target_type": resolved.target_type,
            "target_id": resolved.target_id,
            "workspace_id": resolved.target_id,
            "requested_role": resolved.requested_role,
            "idp_group": body.idp_group,
            "actor_id": answerer.id,
        },
    )
    where = f"“{body.idp_group}”" + (f" in {provider}" if provider else "")
    await notification_repo.notify(
        session,
        user_ids=[resolved.requester_id],
        kind="access_request.routed",
        title=f"One more step to join {await _name_for(session, ws, resolved.requester_id)}",
        body=" ".join(filter(None, [
            f"Ask your IT team to add you to {where}. "
            "Your access arrives the next time you sign in after that.",
            resolved.resolution_note,
        ])),
        link="/my/access",
        actor_id=answerer.id,
        resource_type="access_request",
        resource_id=resolved.id,
    )
    return (await _to_responses(session, [resolved]))[0]


@admin_router.post(
    "/{request_id}/deny",
    response_model=AccessRequestResponse,
    response_model_by_alias=True,
)
async def deny_access_request(
    request_id: str = Path(...),
    body: AccessRequestResolve | None = None,
    answerer: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Deny an open request — waiting on the identity provider included —
    with an optional reason the requester sees. Nothing is granted."""
    row, _claims, ws = await _load_open_for_answer(session, request_id, answerer)
    resolved = await access_request_repo.resolve(
        session,
        request_id=row.id,
        new_status="denied",
        resolver_id=answerer.id,
        note=body.note if body is not None else None,
    )
    assert resolved is not None  # locked above
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.access_request.denied",
        payload={
            "request_id": resolved.id,
            "requester_id": resolved.requester_id,
            "target_type": resolved.target_type,
            "target_id": resolved.target_id,
            "workspace_id": resolved.target_id,
            "requested_role": resolved.requested_role,
            "actor_id": answerer.id,
            "note": resolved.resolution_note,
        },
    )
    asked = "keep your access to" if resolved.binding_id else "join"
    await notification_repo.notify(
        session,
        user_ids=[resolved.requester_id],
        kind="access_request.denied",
        title=f"Your request to {asked} {await _name_for(session, ws, resolved.requester_id)} was declined",
        body=resolved.resolution_note or "No reason was given.",
        link="/my/access",
        actor_id=answerer.id,
        resource_type="access_request",
        resource_id=resolved.id,
    )
    logger.info(
        "Access request %s denied by %s (workspace=%s, role=%s)",
        resolved.id, answerer.id, resolved.target_id, resolved.requested_role,
    )
    return (await _to_responses(session, [resolved]))[0]
