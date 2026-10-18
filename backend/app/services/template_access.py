"""Who may use and change a layout template.

Templates follow views' audiences (``view_access.py``) with one deliberate
difference: a Personal template is visible only to its owner and the people and
groups it is shared with — not to administrators. A template is a layout, not
data: there is nothing behind it to audit, and a library holding everyone's
drafts would be useless to everyone.

  built-in      ``system_key`` set → everyone; a hidden one only to managers.
                Read-only: people duplicate one to change it; managers hide it.
  organization  ``visibility='enterprise'`` → every signed-in user. Managers
                (``system:templates:manage``) create, edit and delete it.
  workspace     ``visibility='workspace'`` + ``workspace_id`` → its owner,
                ``workspace:view:read`` holders there, and grantees. Edit:
                owner, ``workspace:view:edit``, editor grant. Delete: owner,
                ``workspace:view:delete``. Share or move: owner, ``workspace:admin``.
  personal      ``visibility='private'`` → its owner and grantees. Edit: owner,
                editor grant. Delete, share, move: owner.

Grants — to a person or a group — are how a team gets its own templates. API
keys never reach these routes (deny-by-default surface). ``readable_templates_clause``
renders the read rule as SQL for the list; ``tests/test_layout_templates.py``
holds the two renderings together.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import sqlalchemy as sa
from sqlalchemy import and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from backend.app.db.models import ContextModelORM
from backend.app.db.repositories import grant_repo, user_repo
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User

MANAGE = "system:templates:manage"
RESOURCE = "layout_template"
#: Global permissions that read the workspace tier in every workspace — the
#: same reach ``has_permission`` gives them for ``workspace:view:read``.
_READS_EVERY_WORKSPACE = ("system:admin", "system:org-admin", "system:org-viewer")


@dataclass(frozen=True)
class TemplateViewer:
    """Everything the rules need about the caller, built once per request."""
    user_id: str
    claims: PermissionClaims
    #: template id → grant roles, direct or through one of the caller's groups.
    grants: dict[str, tuple[str, ...]]

    @classmethod
    async def build(
        cls, session: AsyncSession, *, user: User, claims: PermissionClaims,
    ) -> "TemplateViewer":
        groups = await user_repo.get_groups_for_user(session, user.id)
        rows = await grant_repo.list_grants_for_user_with_groups(
            session, user_id=user.id, group_ids=list(groups), resource_type=RESOURCE,
        )
        grants: dict[str, list[str]] = {}
        for g in rows:
            grants.setdefault(g.resource_id, []).append(g.role_name)
        return cls(
            user_id=user.id, claims=claims,
            grants={k: tuple(v) for k, v in grants.items()},
        )

    @property
    def is_manager(self) -> bool:
        return has_permission(self.claims, MANAGE)


def _builtin(t: ContextModelORM) -> bool:
    return t.system_key is not None


def _owner(ctx: TemplateViewer, t: ContextModelORM) -> bool:
    return bool(t.created_by) and t.created_by == ctx.user_id


def _in_workspace(ctx: TemplateViewer, t: ContextModelORM, permission: str) -> bool:
    return t.workspace_id is not None and has_permission(
        ctx.claims, permission, workspace_id=t.workspace_id,
    )


# ── One predicate per action ─────────────────────────────────────────

def can_read(ctx: TemplateViewer, t: ContextModelORM) -> bool:
    if not t.is_template or t.deleted_at is not None:
        return False
    if _builtin(t):
        return bool(t.is_active) or ctx.is_manager
    if _owner(ctx, t) or t.id in ctx.grants or t.visibility == "enterprise":
        return True
    return t.visibility == "workspace" and _in_workspace(ctx, t, "workspace:view:read")


def can_edit(ctx: TemplateViewer, t: ContextModelORM) -> bool:
    if not can_read(ctx, t) or _builtin(t):
        return False
    if t.visibility == "enterprise":
        return ctx.is_manager
    if _owner(ctx, t) or "editor" in ctx.grants.get(t.id, ()):
        return True
    return t.visibility == "workspace" and _in_workspace(ctx, t, "workspace:view:edit")


def can_delete(ctx: TemplateViewer, t: ContextModelORM) -> bool:
    """Also the rule for restoring one, so whoever deleted it can Undo."""
    if not t.is_template or _builtin(t):
        return False
    if t.visibility == "enterprise":
        return ctx.is_manager
    if _owner(ctx, t):
        return True
    return t.visibility == "workspace" and _in_workspace(ctx, t, "workspace:view:delete")


def can_share(ctx: TemplateViewer, t: ContextModelORM) -> bool:
    """Built-in and organization templates are everyone's already."""
    if _builtin(t) or t.visibility == "enterprise":
        return False
    if _owner(ctx, t):
        return True
    return t.visibility == "workspace" and _in_workspace(ctx, t, "workspace:admin")


def can_hide(ctx: TemplateViewer, t: ContextModelORM) -> bool:
    return _builtin(t) and ctx.is_manager


def audience_problem(visibility: str, workspace_id: Optional[str]) -> Optional[str]:
    """Why this pair names no audience at all (a 422), or None."""
    if visibility == "workspace" and not workspace_id:
        return "Choose the workspace this template is for."
    if visibility != "workspace" and workspace_id:
        return "Only a workspace template belongs to a workspace."
    return None


def creation_refusal(
    ctx: TemplateViewer, visibility: str, workspace_id: Optional[str],
) -> Optional[str]:
    """Why the caller may not keep a template for this audience (a 403), or None."""
    if visibility == "enterprise" and not ctx.is_manager:
        return (
            "Offering a template to the whole organization needs the "
            "Manage templates permission."
        )
    if visibility == "workspace" and not has_permission(
        ctx.claims, "workspace:view:create", workspace_id=workspace_id,
    ):
        return "You can't add templates to this workspace."
    return None


def move_refusal(
    ctx: TemplateViewer, t: ContextModelORM, visibility: str, workspace_id: Optional[str],
) -> Optional[str]:
    """Why the caller may not change who can use ``t``, or None. Needs rights
    over the audience it has now AND the right to keep one in the new one."""
    if _builtin(t):
        return "A built-in template is everyone's. Duplicate it to make one of your own."
    if t.visibility == "enterprise":
        if not ctx.is_manager:
            return "Only a template manager can change who can use an organization template."
    elif not can_share(ctx, t):
        return "Only its owner or a workspace admin can change who can use this template."
    if visibility == "private" and not _owner(ctx, t):
        return "Only its owner can make this template personal."
    return creation_refusal(ctx, visibility, workspace_id)


def access_envelope(ctx: TemplateViewer, t: ContextModelORM) -> dict:
    """camelCase, ready for ``LayoutTemplateAccess``."""
    if _builtin(t):
        via = "builtin"
    elif _owner(ctx, t):
        via = "owner"
    elif t.id in ctx.grants:
        via = "grant"
    elif t.visibility == "workspace":
        via = "workspace"
    else:
        via = "organization"
    return {
        "via": via,
        "canEdit": can_edit(ctx, t),
        "canDelete": can_delete(ctx, t),
        "canShare": can_share(ctx, t),
        "canHide": can_hide(ctx, t),
    }


def readable_templates_clause(ctx: TemplateViewer) -> ColumnElement[bool]:
    """``can_read`` as SQL, so the list filters in the database."""
    T = ContextModelORM
    claims = ctx.claims
    workspace_tier: ColumnElement[bool] = T.visibility == "workspace"
    if not any(p in claims.global_perms for p in _READS_EVERY_WORKSPACE):
        readable_ws = [
            ws for ws in claims.ws_perms
            if has_permission(claims, "workspace:view:read", workspace_id=ws)
        ]
        workspace_tier = and_(workspace_tier, T.workspace_id.in_(readable_ws))
    people_made = and_(T.system_key.is_(None), or_(
        and_(T.created_by.isnot(None), T.created_by == ctx.user_id),
        T.id.in_(list(ctx.grants)),
        T.visibility == "enterprise",
        workspace_tier,
    ))
    builtin = and_(T.system_key.isnot(None), sa.true() if ctx.is_manager else T.is_active.is_(True))
    return and_(T.is_template.is_(True), T.deleted_at.is_(None), or_(builtin, people_made))


async def usable_template_id(
    session: AsyncSession, *, user: Optional[User], claims: PermissionClaims,
    template_id: str,
) -> Optional[str]:
    """``template_id`` when the caller can use that template, else None — what
    a new view records as the template it was built from."""
    row = await session.get(ContextModelORM, template_id)
    if row is None or user is None:
        return None
    ctx = await TemplateViewer.build(session, user=user, claims=claims)
    return template_id if can_read(ctx, row) else None
