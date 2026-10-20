"""Access reviews: a workspace admin goes through who holds access, and
keeps or removes each grant.

Mounted at ``/api/v1/admin/workspaces/{ws_id}/access-reviews``; every route
needs ``workspace:admin`` there (Org Admins and Super Admins hold it
everywhere).

  GET    ""                              the workspace's reviews, newest first
  POST   ""                              start one — {dueInDays: 7 | 14 | 30}
  GET    "/{review_id}"                  one review, with its items
  POST   "/{review_id}/items/{item_id}"  keep or remove a grant
  POST   "/{review_id}/complete"         every grant decided: done
  POST   "/{review_id}/cancel"           stop it; decisions taken stand

A review covers the grants made here — people's and teams' — as they stood
when it began. People whose identity provider or an organization-wide role
let them in are counted, not reviewed: removing them here wouldn't hold.
Removing a grant takes effect at once, ends the person's sessions and tells
them. Nothing is removed unless a reviewer removes it, and a review past its
due date is only flagged (``access_housekeeping``).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import AccessReviewORM, RoleBindingORM, UserORM, WorkspaceORM
from backend.app.db.repositories import access_review_repo, binding_repo, user_repo
from backend.app.db.repositories.binding_repo import _is_expired
from backend.app.api.v1.endpoints.workspace_members import _hydrate_subjects
from backend.app.services import workspace_access
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    AccessReviewCounts,
    AccessReviewDecision,
    AccessReviewItemResponse,
    AccessReviewResponse,
    AccessReviewStart,
    WorkspaceMemberSubject,
)

router = APIRouter()

#: Exceptions and grants made directly first: the ones a reviewer most
#: needs to look at.
_ORIGIN_ORDER = ("exception", "direct", "request", "joined", "team")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _live_workspace(session: AsyncSession, ws_id: str) -> WorkspaceORM:
    ws = (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == ws_id, WorkspaceORM.deleted_at.is_(None))
    )).scalar_one_or_none()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


async def _review_in(session: AsyncSession, ws_id: str, review_id: str, *, for_update: bool = False):
    review = await access_review_repo.get(session, review_id, for_update=for_update)
    if review is None or review.workspace_id != ws_id:
        raise HTTPException(status_code=404, detail="Access review not found")
    return review


def _require_open(review: AccessReviewORM) -> None:
    if review.status != "open":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"This access review is {review.status}",
        )


async def _not_reviewed(session: AsyncSession, ws_id: str) -> dict[str, int]:
    """People with access a review here can't take away: through their
    identity provider, or an organization-wide role."""
    now = _now()
    idp = {
        b.subject_id for b in await binding_repo.list_for_scope(session, scope_type="workspace", scope_id=ws_id)
        if b.source == "sso" and b.subject_type == "user" and not _is_expired(b.expires_at, now=now)
    }
    org_wide = {uid for uid, *_rest in await workspace_access.org_wide_grants(session)}
    return {"identityProvider": len(idp), "organizationWide": len(org_wide)}


async def _response(
    session: AsyncSession, review: AccessReviewORM, *, with_items: bool,
) -> AccessReviewResponse:
    counts = (await access_review_repo.counts(session, [review.id]))[review.id]
    out = AccessReviewResponse(
        id=review.id,
        workspace_id=review.workspace_id,
        status=review.status,
        started_by=review.started_by,
        started_at=review.started_at,
        due_at=review.due_at,
        completed_at=review.completed_at,
        completed_by=review.completed_by,
        counts=AccessReviewCounts(**counts),
    )
    if not with_items:
        return out
    items = await access_review_repo.list_items(session, review.id)
    subjects = await _hydrate_subjects(session, sorted({(i.subject_type, i.subject_id) for i in items}))
    user_ids = sorted({i.subject_id for i in items if i.subject_type == "user"})
    last_login = dict((await session.execute(
        select(UserORM.id, UserORM.last_login_at).where(UserORM.id.in_(user_ids))
    )).all()) if user_ids else {}
    binding_ids = sorted({i.binding_id for i in items if i.binding_id})
    now = _now()
    current = {
        b.id for b in (await session.execute(
            select(RoleBindingORM).where(RoleBindingORM.id.in_(binding_ids))
        )).scalars().all()
        if not _is_expired(b.expires_at, now=now)
    } if binding_ids else set()
    rows = [
        AccessReviewItemResponse(
            id=i.id,
            subject=subjects.get((i.subject_type, i.subject_id))
            or WorkspaceMemberSubject(type=i.subject_type, id=i.subject_id),
            role=i.role_name,
            binding_id=i.binding_id,
            origin=i.origin,
            granted_at=i.granted_at,
            expires_at=i.expires_at,
            last_login_at=last_login.get(i.subject_id) if i.subject_type == "user" else None,
            current=i.binding_id in current,
            decision=i.decision,
            decided_by=i.decided_by,
            decided_at=i.decided_at,
            note=i.note,
        )
        for i in items
    ]
    rank = {o: n for n, o in enumerate(_ORIGIN_ORDER)}
    rows.sort(key=lambda r: (
        rank.get(r.origin or "", len(rank)), (r.subject.display_name or r.subject.id).lower(), r.role,
    ))
    out.items = rows
    out.not_reviewed = await _not_reviewed(session, review.workspace_id)
    return out


@router.get("", response_model=list[AccessReviewResponse], response_model_by_alias=True)
async def list_access_reviews(
    ws_id: str,
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """The workspace's reviews, newest first, with how far each got."""
    await _live_workspace(session, ws_id)
    reviews = await access_review_repo.list_for_workspace(session, ws_id)
    counts = await access_review_repo.counts(session, [r.id for r in reviews])
    return [
        AccessReviewResponse(
            id=r.id, workspace_id=r.workspace_id, status=r.status, started_by=r.started_by,
            started_at=r.started_at, due_at=r.due_at, completed_at=r.completed_at,
            completed_by=r.completed_by, counts=AccessReviewCounts(**counts[r.id]),
        )
        for r in reviews
    ]


@router.post(
    "", response_model=AccessReviewResponse, response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def start_access_review(
    ws_id: str,
    body: AccessReviewStart | None = None,
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Start a review of every grant made here — people's and teams' — as
    they stand now, due in 7, 14 or 30 days. One open review at a time."""
    body = body or AccessReviewStart()
    await _live_workspace(session, ws_id)
    now = _now()
    bindings = [
        b for b in await binding_repo.list_for_scope(session, scope_type="workspace", scope_id=ws_id)
        if b.source == "local" and not _is_expired(b.expires_at, now=now)
    ]
    reader = await workspace_access.provenance_reader(
        session, [b.subject_id for b in bindings if b.subject_type == "user"],
    )
    review = await access_review_repo.create(
        session,
        workspace_id=ws_id,
        started_by=admin.id,
        started_at=now.isoformat(),
        due_at=(now + timedelta(days=body.due_in_days)).isoformat(),
        items=[
            {
                "subject_type": b.subject_type,
                "subject_id": b.subject_id,
                "role_name": b.role_name,
                "binding_id": b.id,
                "origin": reader.binding(b, b.subject_id)["origin"] if b.subject_type == "user" else "team",
                "granted_at": b.granted_at,
                "expires_at": b.expires_at,
            }
            for b in bindings
        ],
    )
    if review is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An access review of this workspace is already open",
        )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.access_review_started",
        payload={
            "workspace_id": ws_id,
            "review_id": review.id,
            "actor_id": admin.id,
            "grants": len(bindings),
            "due_at": review.due_at,
        },
    )
    return await _response(session, review, with_items=True)


@router.get("/{review_id}", response_model=AccessReviewResponse, response_model_by_alias=True)
async def get_access_review(
    ws_id: str,
    review_id: str = Path(...),
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    await _live_workspace(session, ws_id)
    return await _response(session, await _review_in(session, ws_id, review_id), with_items=True)


@router.post(
    "/{review_id}/items/{item_id}",
    response_model=AccessReviewResponse,
    response_model_by_alias=True,
)
async def decide_access_review_item(
    ws_id: str,
    body: AccessReviewDecision,
    review_id: str = Path(...),
    item_id: str = Path(...),
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Keep a grant, or remove it — at once: the person's sessions end and
    they hear why. A kept grant can still be removed while the review is
    open; a removed one is gone."""
    ws = await _live_workspace(session, ws_id)
    review = await _review_in(session, ws_id, review_id, for_update=True)
    _require_open(review)
    item = await access_review_repo.get_item(session, review_id, item_id, for_update=True)
    if item is None:
        raise HTTPException(status_code=404, detail="Not part of this review")
    if item.decision == "remove":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already removed")
    if body.decision == "remove":
        binding = await binding_repo.get_binding(session, item.binding_id) if item.binding_id else None
        # The very grant reviewed: a binding re-made since is another grant.
        if binding is not None and (
            binding.scope_id, binding.subject_id, binding.role_name
        ) == (ws_id, item.subject_id, item.role_name):
            await binding_repo.delete_binding(session, binding.id)
            revoked = await revoke_subject_sessions(
                binding.subject_type, binding.subject_id,
                session=session, reason="workspace_binding_revoked",
            )
            await user_repo.create_outbox_event(
                session,
                event_type="rbac.workspace.member_revoked",
                payload={
                    "workspace_id": ws_id,
                    "binding_id": binding.id,
                    "subject_type": binding.subject_type,
                    "subject_id": binding.subject_id,
                    "role": binding.role_name,
                    "actor_id": admin.id,
                    "sessions_revoked": revoked,
                    "via": "access_review",
                    "review_id": review.id,
                },
            )
            if binding.subject_type == "user":
                await workspace_access.notify_removed(
                    session, ws, binding, actor_id=admin.id,
                    why="It was removed in an access review of the workspace.",
                )
    item.decision = body.decision
    item.decided_by = admin.id
    item.decided_at = _now().isoformat()
    item.note = (body.note or "").strip() or None
    await session.flush()
    return await _response(session, review, with_items=True)


@router.post(
    "/{review_id}/complete",
    response_model=AccessReviewResponse,
    response_model_by_alias=True,
)
async def complete_access_review(
    ws_id: str,
    review_id: str = Path(...),
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Close the review once every grant in it is decided."""
    await _live_workspace(session, ws_id)
    review = await _review_in(session, ws_id, review_id, for_update=True)
    _require_open(review)
    counts = (await access_review_repo.counts(session, [review.id]))[review.id]
    if counts["undecided"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{counts['undecided']} grant(s) still need a decision",
        )
    review.status = "completed"
    review.completed_at = _now().isoformat()
    review.completed_by = admin.id
    await session.flush()
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.access_review_completed",
        payload={
            "workspace_id": ws_id,
            "review_id": review.id,
            "actor_id": admin.id,
            "kept": counts["kept"],
            "removed": counts["removed"],
        },
    )
    return await _response(session, review, with_items=True)


@router.post(
    "/{review_id}/cancel",
    response_model=AccessReviewResponse,
    response_model_by_alias=True,
)
async def cancel_access_review(
    ws_id: str,
    review_id: str = Path(...),
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    """Stop an open review. Grants already removed stay removed."""
    await _live_workspace(session, ws_id)
    review = await _review_in(session, ws_id, review_id, for_update=True)
    _require_open(review)
    review.status = "cancelled"
    review.completed_at = _now().isoformat()
    review.completed_by = admin.id
    await session.flush()
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.access_review_cancelled",
        payload={"workspace_id": ws_id, "review_id": review.id, "actor_id": admin.id},
    )
    return await _response(session, review, with_items=True)
