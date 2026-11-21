"""Who can open a view or a data source, worked out for people who are not here.

A request's own access is decided from its caller's claims (``access``). Who to
mention, who a question reaches and which watchers hear about it are questions
about OTHER people, so they are answered here from what claims are made of: role
bindings (expired ones count for nothing), groups, a view's grants and its creator.
The rules mirror ``view_access.can_read_view`` and ``has_permission`` —
``tests/test_discussions_access.py`` holds them together across every seeded role,
grant and visibility tier:

  view, ``enterprise``  → every active person
  view, ``workspace``   → the creator, grantees, the workspace's admins, and
                          ``workspace:view:read`` holders there
  view, ``private``     → the creator, grantees and the workspace's admins
  data source           → ``workspace:datasource:read`` holders in its workspace

``system:admin`` reads everything; ``system:org-admin`` holds every workspace
permission everywhere and ``system:org-viewer`` every ``…:read``. Service accounts
and inactive or deleted people never count. With ``RBAC_ENFORCE_VIEWS`` off the
routes read views unchecked while this still applies the rules: stricter, never
wider.

Repositories only — the control plane imports this for its housekeeping and must
start without the web tier or a signing secret.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import or_, and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DataRequestORM,
    GroupMemberORM,
    RoleBindingORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    view_is_live,
)
from backend.app.db.repositories import (
    binding_repo,
    data_request_repo,
    data_source_contact_repo,
    grant_repo,
    permission_repo,
)
from backend.common.service_accounts import is_person, is_service_account

VIEW_READ = "workspace:view:read"
SOURCE_READ = "workspace:datasource:read"
WORKSPACE_ADMIN = "workspace:admin"
ORG_ADMIN = "system:org-admin"


# ── Subjects ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Subject:
    """A live view or data source, as conversations need it."""
    type: str                       # 'view' | 'data_source'
    id: str
    name: str
    workspace_id: str
    created_by: Optional[str]
    #: A view's tier; ``None`` for a data source.
    visibility: Optional[str] = None
    #: The data source whose contacts answer for it: a view's source, or the source itself.
    data_source_id: Optional[str] = None


def view_subject(view: ViewORM) -> Subject:
    return Subject(type="view", id=view.id, name=view.name, workspace_id=view.workspace_id,
                   created_by=view.created_by, visibility=view.visibility or "private",
                   data_source_id=view.data_source_id)


def source_subject(ds: WorkspaceDataSourceORM) -> Subject:
    return Subject(type="data_source", id=ds.id, name=ds.label or ds.graph_name or ds.id,
                   workspace_id=ds.workspace_id, created_by=ds.created_by, data_source_id=ds.id)


def subject_link(subject: Subject) -> str:
    """Where the subject's conversations are: the view, or the source's Questions tab."""
    if subject.type == "view":
        return f"/views/{subject.id}"
    return f"/workspaces/{subject.workspace_id}?tab=data&section=sources&ds={subject.id}&dstab=questions"


def thread_link(subject: Subject, thread_id: str, message_id: Optional[str] = None) -> str:
    base = subject_link(subject)
    link = f"{base}{'&' if '?' in base else '?'}discussion={thread_id}"
    return f"{link}&message={message_id}" if message_id else link


async def load_subject(session: AsyncSession, subject_type: str, subject_id: str) -> Optional[Subject]:
    """The live subject, or ``None`` when it is unknown, deleted or still waiting in a
    draft to go live (conversations are about what people can find)."""
    if subject_type == "view":
        view = (await session.execute(
            select(ViewORM).where(ViewORM.id == subject_id, view_is_live())
        )).scalar_one_or_none()
        return view_subject(view) if view is not None else None
    if subject_type == "data_source":
        ds = (await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id == subject_id, WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        return source_subject(ds) if ds is not None else None
    return None


async def load_subjects(
    session: AsyncSession, refs: Iterable[tuple[str, str]],
) -> dict[tuple[str, str], Subject]:
    """Many live subjects in two id-correlated reads (views, sources), keyed by ``(type, id)``."""
    wanted = set(refs)
    view_ids = sorted(i for t, i in wanted if t == "view")
    ds_ids = sorted(i for t, i in wanted if t == "data_source")
    out: dict[tuple[str, str], Subject] = {}
    if view_ids:
        for v in (await session.execute(
            select(ViewORM).where(ViewORM.id.in_(view_ids), view_is_live())
        )).scalars().all():
            out[("view", v.id)] = view_subject(v)
    if ds_ids:
        for d in (await session.execute(
            select(WorkspaceDataSourceORM).where(
                WorkspaceDataSourceORM.id.in_(ds_ids), WorkspaceDataSourceORM.deleted_at.is_(None),
            )
        )).scalars().all():
            out[("data_source", d.id)] = source_subject(d)
    return out


async def workspace_names(session: AsyncSession, ids: Iterable[str]) -> dict[str, str]:
    wanted = sorted({i for i in ids if i})
    if not wanted:
        return {}
    return dict((await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(WorkspaceORM.id.in_(wanted))
    )).all())


# ── Who holds a permission ───────────────────────────────────────────


def _confers(scope_type: str, perms: frozenset[str], permission: str) -> bool:
    """Whether one binding's permissions grant ``permission`` — ``has_permission``'s
    rules for a single binding. ``workspace:admin`` implies every workspace permission
    asked about here (all are leaves ``permission_service`` expands it to)."""
    if scope_type == "global":
        if "system:admin" in perms:
            return True
        if permission.startswith("workspace:"):
            return ORG_ADMIN in perms or (permission.endswith(":read") and "system:org-viewer" in perms)
        return permission in perms
    if permission in perms or WORKSPACE_ADMIN in perms:
        return True
    return any(p.endswith(":*") and permission.startswith(p[:-2] + ":") for p in perms)


async def _bindings(session: AsyncSession, workspace_id: Optional[str], *, global_too: bool = True):
    """Unexpired bindings in the workspace (and globally), each with the permissions it
    carries after the resolver's category × scope filter."""
    scopes = []
    if workspace_id:
        scopes.append(and_(RoleBindingORM.scope_type == "workspace", RoleBindingORM.scope_id == workspace_id))
    if global_too:
        scopes.append(RoleBindingORM.scope_type == "global")
    if not scopes:
        return []
    now = datetime.now(timezone.utc)
    rows = [
        b for b in (await session.execute(select(RoleBindingORM).where(or_(*scopes)))).scalars().all()
        if not binding_repo._is_expired(b.expires_at, now=now)
    ]
    role_perms = await permission_repo.get_role_permissions_for_roles(session, sorted({b.role_name for b in rows}))
    categories = await permission_repo.get_permission_categories(session)
    want = {"global": "system", "workspace": "workspace"}
    return [
        (b, frozenset(p for p in role_perms.get(b.role_name, ()) if categories.get(p, "system") == want[b.scope_type]))
        for b in rows
    ]


async def group_members(session: AsyncSession, group_ids: Iterable[str]) -> dict[str, list[str]]:
    """``{group_id: [user_id, ...]}`` in the order they were added, in one read."""
    ids = sorted(set(group_ids))
    if not ids:
        return {}
    out: dict[str, list[str]] = {g: [] for g in ids}
    for gid, uid in (await session.execute(
        select(GroupMemberORM.group_id, GroupMemberORM.user_id)
        .where(GroupMemberORM.group_id.in_(ids)).order_by(GroupMemberORM.added_at, GroupMemberORM.user_id)
    )).all():
        out[gid].append(uid)
    return out


async def _subjects_to_users(session: AsyncSession, subjects: Iterable[tuple[str, str]]) -> set[str]:
    users = {sid for kind, sid in subjects if kind == "user"}
    for members in (await group_members(session, [sid for kind, sid in subjects if kind == "group"])).values():
        users.update(members)
    return users


async def holders(
    session: AsyncSession, workspace_id: Optional[str], permission: str, *, global_too: bool = True,
) -> set[str]:
    """Everyone holding ``permission`` in ``workspace_id`` (``None``: a global permission)
    through an unexpired binding, direct or through a group. ``global_too=False`` leaves out
    what a global role gives everywhere (a workspace's own admins, not every Org Admin)."""
    bound = await _bindings(session, workspace_id, global_too=global_too)
    return await _subjects_to_users(session, [
        (b.subject_type, b.subject_id) for b, perms in bound if _confers(b.scope_type, perms, permission)
    ])


async def workspaces_run_by(session: AsyncSession, user_id: str) -> set[str]:
    """The workspaces someone administers through a binding there (directly or through a
    group; unexpired) — not the everywhere of an Org Admin."""
    groups = (await session.execute(
        select(GroupMemberORM.group_id).where(GroupMemberORM.user_id == user_id)
    )).scalars().all()
    rows = [b for b in await binding_repo.list_for_user_with_groups(session, user_id=user_id, group_ids=list(groups))
            if b.scope_type == "workspace" and b.scope_id]
    role_perms = await permission_repo.get_role_permissions_for_roles(session, sorted({b.role_name for b in rows}))
    categories = await permission_repo.get_permission_categories(session)
    return {
        b.scope_id for b in rows
        if _confers("workspace", frozenset(p for p in role_perms.get(b.role_name, ())
                                           if categories.get(p, "system") == "workspace"), WORKSPACE_ADMIN)
    }


async def workspace_admins(session: AsyncSession, workspace_id: str) -> set[str]:
    """The workspace's own admins (bound there), active people only."""
    return await active_people(session, await holders(session, workspace_id, WORKSPACE_ADMIN, global_too=False))


async def org_admins(session: AsyncSession) -> set[str]:
    """Everyone bound globally to a role carrying ``system:org-admin``, active people only."""
    return await active_people(session, await holders(session, None, ORG_ADMIN))


async def active_people(session: AsyncSession, ids: Iterable[str]) -> set[str]:
    """The active, undeleted people among ``ids`` — never a service account."""
    wanted = sorted({i for i in ids if i and not is_service_account(i)})
    if not wanted:
        return set()
    return set((await session.execute(
        select(UserORM.id).where(
            UserORM.id.in_(wanted), UserORM.status == "active", UserORM.deleted_at.is_(None),
            is_person(UserORM.id),
        )
    )).scalars().all())


# ── Readers ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Readers:
    """Who can open a subject. ``everyone`` for a view published to every signed-in
    person; otherwise ``ids`` — before the active-person filter, which :meth:`among`
    applies to the (bounded) candidates a caller actually asks about."""
    everyone: bool
    ids: frozenset[str] = frozenset()

    def may(self, user_id: str) -> bool:
        return self.everyone or user_id in self.ids

    async def among(self, session: AsyncSession, candidates: Iterable[str]) -> set[str]:
        """The active people among ``candidates`` who can open the subject."""
        return await active_people(session, [c for c in candidates if self.may(c)])


NOBODY = Readers(everyone=False)


async def grantees(session: AsyncSession, view_id: str, *, role: Optional[str] = None) -> list[tuple[str, str]]:
    """A view's grants as ``(subject_type, subject_id)``, oldest first; ``role`` narrows them."""
    grants = sorted(await grant_repo.list_grants_for_resource(session, resource_type="view", resource_id=view_id),
                    key=lambda g: (g.granted_at or "", g.id))
    return [(g.subject_type, g.subject_id) for g in grants if role is None or g.role_name == role]


async def readers_of(session: AsyncSession, subject: Optional[Subject]) -> Readers:
    """Who can open ``subject`` (``None`` — gone — is nobody)."""
    if subject is None:
        return NOBODY
    if subject.type == "data_source":
        return Readers(everyone=False, ids=frozenset(await holders(session, subject.workspace_id, SOURCE_READ)))
    tier = subject.visibility or "private"
    if tier == "enterprise":
        return Readers(everyone=True)
    if tier not in ("private", "workspace"):
        return Readers(everyone=False, ids=frozenset(await holders(session, None, "system:admin")))
    ids = await holders(session, subject.workspace_id, VIEW_READ if tier == "workspace" else WORKSPACE_ADMIN)
    if subject.created_by:
        ids.add(subject.created_by)
    ids |= await _subjects_to_users(session, await grantees(session, subject.id))
    return Readers(everyone=False, ids=frozenset(ids))


# ── Maintainers ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Maintainers:
    """Who answers for a subject: a view's creator and editor grantees; a source's named
    contacts, else its derived ones (who created it, and the people named on the data
    requests it was connected for). Groups are kept as groups."""
    user_ids: frozenset[str]
    group_ids: frozenset[str]

    def includes(self, user_id: str, user_group_ids: Iterable[str]) -> bool:
        return user_id in self.user_ids or bool(self.group_ids & set(user_group_ids))


async def derived_contacts(session: AsyncSession, ds: Subject) -> tuple[Optional[str], list[str]]:
    """A source naming nobody: ``(who created it, [the people who know it])`` — the
    contacts on the data requests connected as this source."""
    known: list[str] = []
    for raw in (await session.execute(
        select(DataRequestORM.contact_ids).where(
            DataRequestORM.data_source_id == ds.id, DataRequestORM.status == "connected",
        ).order_by(DataRequestORM.created_at)
    )).scalars().all():
        known.extend(data_request_repo.ids_of(raw))
    owner = ds.created_by if ds.created_by and not is_service_account(ds.created_by) else None
    return owner, [u for u in dict.fromkeys(known) if u != owner and not is_service_account(u)]


async def maintainers_of(session: AsyncSession, subject: Subject) -> Maintainers:
    if subject.type == "view":
        named = await grantees(session, subject.id, role="editor")
        users = {sid for kind, sid in named if kind == "user"} | ({subject.created_by} if subject.created_by else set())
        return Maintainers(frozenset(users), frozenset(sid for kind, sid in named if kind == "group"))
    rows = await data_source_contact_repo.list_for_source(session, subject.id)
    if rows:
        return Maintainers(frozenset(r.subject_id for r in rows if r.subject_type == "user"),
                           frozenset(r.subject_id for r in rows if r.subject_type == "group"))
    owner, known = await derived_contacts(session, subject)
    return Maintainers(frozenset(([owner] if owner else []) + known), frozenset())


async def expand(session: AsyncSession, maint: Maintainers) -> set[str]:
    """Every person a :class:`Maintainers` names, groups expanded."""
    return set(maint.user_ids) | await _subjects_to_users(session, [("group", g) for g in maint.group_ids])
