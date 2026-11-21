"""The Review Center across workspaces: every review the reader may see, in the
queues they work by, from all the workspaces they can read — or the ones they name.

The per-workspace inbox (``/{ws_id}/versioning/review-inbox``) answers for one
workspace, so the sidebar's Reviews used to open whichever workspace the browser
happened to hold active. This answers for the reader's whole estate. Nothing about
who may see what changes: each workspace is read exactly as its own inbox reads
it — with the reader's permissions IN THAT WORKSPACE (``viewer_ctx``'s rule) — and
the pages are merged afterwards. A workspace the reader cannot read is never asked.

Reads only, like every GET on the versioning router: they stay open while the
``versioningEnabled`` switch is off (the frontend hides the surface).
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.versioning import (
    InboxQueue, PrResponse, ReviewInboxCountsResponse, _ApiModel, _MANAGE, _READ,
    _attach_user_names, _drafts_policy_of, _inbox, _review_out, _you, _your_groups,
    get_versioning_service,
)
from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import workspace_repo
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.versioning.service import GraphVersioningService, Viewer
from backend.auth_service.interface import User

router = APIRouter()


class ReviewCenterItem(PrResponse):
    #: Which workspace the review lives in — a review opens at /workspaces/{id}/reviews/{prId}.
    workspace_id: str = Field(alias="workspaceId")
    workspace_name: str = Field(alias="workspaceName")


class ReviewCenterCountsResponse(ReviewInboxCountsResponse):
    #: Each workspace's own counts, for the workspace picker's badges.
    by_workspace: Dict[str, ReviewInboxCountsResponse] = Field(default_factory=dict, alias="byWorkspace")


class ReviewCenterResponse(ReviewCenterCountsResponse):
    queue: str
    items: List[ReviewCenterItem]
    total: int


async def _readable_workspaces(session: AsyncSession, claims: PermissionClaims,
                               only: Optional[List[str]]) -> list:
    """The workspaces whose reviews the reader may read (the per-workspace inbox's own gate),
    narrowed to ``only`` when given. A named workspace they cannot read is simply not there."""
    wanted = set(only or ())
    return [w for w in await workspace_repo.list_workspaces(session)
            if (not wanted or w.id in wanted) and has_permission(claims, _READ, workspace_id=w.id)]


def _viewer(user: User, claims: PermissionClaims, ws_id: str) -> Viewer:
    """The reader as one workspace's inbox sees them — exactly ``viewer_ctx``."""
    return Viewer(actor=user.id, can_manage=has_permission(claims, _MANAGE, workspace_id=ws_id),
                  can_read=has_permission(claims, _READ, workspace_id=ws_id))


def _sum_counts(parts: List[Dict[str, Any]]) -> Dict[str, Any]:
    counts: Dict[str, int] = {}
    unread: Dict[str, int] = {}
    for p in parts:
        for k, v in (p.get("counts") or {}).items():
            counts[k] = counts.get(k, 0) + v
        for k, v in (p.get("unread") or {}).items():
            unread[k] = unread.get(k, 0) + v
    return {"counts": counts, "unread": unread, "capped": any(p.get("capped") for p in parts)}


def _only_counts(out: Dict[str, Any]) -> Dict[str, Any]:
    return {"counts": out.get("counts") or {}, "unread": out.get("unread") or {}, "capped": bool(out.get("capped"))}


@router.get("", response_model=ReviewCenterResponse)
async def review_center_inbox(
    queue: InboxQueue = Query("needs_review"),
    q: Optional[str] = Query(None, max_length=200),
    author: Optional[str] = Query(None, max_length=200),
    sort: Literal["activity", "created"] = Query("activity"),
    workspace_ids: Optional[List[str]] = Query(None, alias="workspaceId"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """The reader's reviews across the workspaces they can read (or the ``workspaceId``s named),
    in one queue — merged by last activity or by when each was opened, then paged."""
    workspaces = await _readable_workspaces(session, claims, workspace_ids)
    rules: Dict[Optional[str], Any] = {}
    parts: List[Dict[str, Any]] = []
    by_workspace: Dict[str, Dict[str, Any]] = {}
    merged: List[dict] = []
    total = 0
    for ws in workspaces:
        # Each workspace's first offset+limit rows: enough for any page of the merge.
        out = await _inbox(svc, session, ws.id, _viewer(user, claims, ws.id), rules, queue=queue, q=q,
                           author=author, sort=sort, limit=offset + limit, offset=0)
        parts.append(out)
        by_workspace[ws.id] = _only_counts(out)
        total += out.get("total") or 0
        for it in out.get("items") or []:
            it["workspace_id"] = ws.id
            it["workspace_name"] = ws.name
            merged.append(it)

    key = "last_activity_at" if sort == "activity" else "created_at"
    # Newest first, as each workspace's own inbox orders them; the id keeps ties stable.
    merged.sort(key=lambda it: (str(it.get(key) or it.get("created_at") or ""), str(it.get("pr_id") or "")), reverse=True)
    items = merged[offset:offset + limit]

    mine = await _your_groups(user.id, items)
    for it in items:
        ds = it.get("target_data_source_id")
        if ds not in rules:
            rules[ds] = (await _drafts_policy_of(session, ds)).rule
        await _review_out(svc, session, [it], rules[ds])
        _you(it, user.id, mine)
    await _attach_user_names(session, items)
    return {**_sum_counts(parts), "by_workspace": by_workspace, "queue": queue, "items": items, "total": total}


@router.get("/counts", response_model=ReviewCenterCountsResponse)
async def review_center_counts(
    workspace_ids: Optional[List[str]] = Query(None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Each queue's count and unread count across the reader's workspaces, and each workspace's
    own: what the sidebar's Reviews badge and the workspace picker show."""
    parts: List[Dict[str, Any]] = []
    by_workspace: Dict[str, Dict[str, Any]] = {}
    for ws in await _readable_workspaces(session, claims, workspace_ids):
        out = await _inbox(svc, session, ws.id, _viewer(user, claims, ws.id), {}, limit=0)
        parts.append(out)
        by_workspace[ws.id] = _only_counts(out)
    return {**_sum_counts(parts), "by_workspace": by_workspace}
