"""What the caller of a request may see and do in conversations.

**Reading a subject.** A view: ``view_guards.readable_view`` (404 when it can't be
read, so its existence stays private). A data source: a live row and
``workspace:datasource:read`` in its workspace. Many subjects at once
(:func:`readable_subject_ids`): one id-correlated read per kind — views through
``readable_views_clause`` — never a JOIN.

**Seeing a thread** (:func:`thread_visible`): the caller reads the subject, and the
thread is open to everyone who does — or it is private and the caller is in it (asked
it, was asked, mentioned, replied or followed), maintains the subject (a view's creator
or editor grantees; a source's data contacts), or administers its workspace. Counts and
summaries apply the same rule (:func:`private_clause`), so a private thread never shows
through a number. Losing access hides a thread; the participant row stays, so it comes
back with the access.

Who can read a subject on behalf of OTHER people — mentions, recipients, watchers —
is ``readers.readers_of``, re-exported here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import rbac_flag
from backend.app.db.models import DiscussionORM, DiscussionParticipantORM, ViewORM, WorkspaceDataSourceORM
from backend.app.db.repositories import user_repo
from backend.app.services import view_access
from backend.app.services.discussions.readers import (  # noqa: F401 — re-exported
    Maintainers,
    Readers,
    Subject,
    load_subject,
    maintainers_of,
    readers_of,
    source_subject,
    view_subject,
)
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User
from backend.common.service_accounts import is_service_account


def refuse(code: int, kind: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message, **extra})


def not_found(what: str = "conversation") -> HTTPException:
    return refuse(404, "not_found", f"That {what} doesn't exist, or you can't open it.")


def require_person(user: User) -> None:
    """Conversations are between people: a service account never writes one."""
    if is_service_account(user.id):
        raise refuse(403, "person_required", "Only a person can take part in a conversation.")


@dataclass
class Caller:
    """The request's caller, with what the checks below need, looked up once."""
    user: User
    claims: PermissionClaims
    _groups: Optional[frozenset[str]] = None

    @property
    def id(self) -> str:
        return self.user.id

    async def group_ids(self, session: AsyncSession) -> frozenset[str]:
        if self._groups is None:
            self._groups = frozenset(await user_repo.get_groups_for_user(session, self.user.id))
        return self._groups

    def is_admin_of(self, subject: Subject) -> bool:
        """Administers the subject's workspace (``system:admin`` and Org Admins too)."""
        return has_permission(self.claims, "workspace:admin", workspace_id=subject.workspace_id)


async def readable_subject(session: AsyncSession, caller: Caller, subject_type: str, subject_id: str) -> Subject:
    """The subject, or 404 ``not_found`` when it is unknown, deleted or unreadable."""
    if subject_type == "view":
        # Imported here: the guard lives beside the views routes, which import a great deal.
        from backend.app.api.v1.endpoints.view_guards import readable_view

        try:
            view = await readable_view(session, subject_id, caller.user, caller.claims)
        except HTTPException as exc:
            if exc.status_code == 404:
                raise not_found("view") from exc
            raise
        return view_subject(view)
    if subject_type == "data_source":
        ds = (await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id == subject_id, WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if ds is None or not has_permission(caller.claims, "workspace:datasource:read", workspace_id=ds.workspace_id):
            raise not_found("data source")
        return source_subject(ds)
    raise not_found("subject")


async def sees_every_private_thread(session: AsyncSession, caller: Caller, subject: Subject,
                                    maint: Optional[Maintainers] = None) -> bool:
    """The subject's maintainers and its workspace's admins see all its private threads."""
    if caller.is_admin_of(subject):
        return True
    maint = maint or await maintainers_of(session, subject)
    return maint.includes(caller.id, await caller.group_ids(session))


def private_clause(user_id: str):
    """SQL: a thread the caller may see on a subject they read but do not maintain — open,
    or private with them in it. Id-correlated, inside the collaboration domain."""
    return or_(
        DiscussionORM.visibility == "open",
        exists().where(
            DiscussionParticipantORM.discussion_id == DiscussionORM.id,
            DiscussionParticipantORM.user_id == user_id,
        ),
    )


async def thread_visible(
    session: AsyncSession, caller: Caller, thread: DiscussionORM, subject: Subject, *,
    participant: Optional[DiscussionParticipantORM],
) -> bool:
    """Whether the caller — who reads ``subject`` — may see ``thread``."""
    if thread.deleted_at is not None or thread.archived_at is not None:
        return False
    if thread.visibility == "open" or participant is not None:
        return True
    return await sees_every_private_thread(session, caller, subject)


async def readable_subject_ids(
    session: AsyncSession, caller: Caller, refs: Iterable[tuple[str, str]],
) -> set[tuple[str, str]]:
    """Which of ``refs`` (``(type, id)``) the caller can open: one read for the views,
    one for the sources, however many there are."""
    wanted = set(refs)
    out: set[tuple[str, str]] = set()
    view_ids = sorted(i for t, i in wanted if t == "view")
    if view_ids:
        stmt = select(ViewORM.id).where(ViewORM.id.in_(view_ids), ViewORM.deleted_at.is_(None))
        if rbac_flag("RBAC_ENFORCE_VIEWS"):
            ctx = await view_access.ViewerContext.build(session, user=caller.user, claims=caller.claims)
            stmt = stmt.where(view_access.readable_views_clause(await view_access.build_read_scope(session, ctx)))
        out |= {("view", i) for i in (await session.execute(stmt)).scalars().all()}
    ds_ids = sorted(i for t, i in wanted if t == "data_source")
    if ds_ids:
        rows = (await session.execute(
            select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.workspace_id).where(
                WorkspaceDataSourceORM.id.in_(ds_ids), WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).all()
        out |= {("data_source", i) for i, ws in rows
                if has_permission(caller.claims, "workspace:datasource:read", workspace_id=ws)}
    return out
