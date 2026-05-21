"""PermissionService — resolve a user's effective permissions.

The resolver runs once per login and produces a compact claim payload
that is embedded in the access JWT. Every subsequent request
authorizes against those claims instead of going back to the DB.

The shape returned matches the JWT claim schema agreed in the design:

    {
        "sid": "<session id>",
        "global": ["workspaces:create", "users:manage", ...],
        "ws": {
            "ws_finance":   ["workspace:admin", "workspace:view:*", ...],
            "ws_marketing": ["workspace:view:read", ...]
        }
    }

Wildcards (e.g. ``workspace:view:*``) are expanded by the resolver
when every action under a domain is granted, keeping the token small
for users in many workspaces.

This module deliberately exposes a single function — ``resolve`` — so
the call site (``LocalIdentityService.login``) is one line. Internal
helpers stay private.

Phase 1: this module is imported by the auth service to populate the
JWT claim. The ``requires(...)`` dependency reads the claim back. The
actual three-layer view evaluator lives in
``view_access.py`` and is wired into endpoints in Phase 2.
"""
from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    GroupMemberORM,
    GroupORM,
    RoleBindingORM,
)
from backend.app.db.repositories import (
    binding_repo,
    idp_group_mapping_repo,
    permission_repo,
    user_repo,
)
from backend.app.db.repositories.idp_group_mapping_repo import (
    FORBIDDEN_AUTO_ROLE,
)

logger = logging.getLogger(__name__)


# Permission ids that the wildcard collapser knows about. Any permission
# whose id starts with one of these prefixes is a candidate for ``*``
# expansion when every leaf under the prefix is granted.
_WILDCARD_PREFIXES = (
    "workspace:view",
    "workspace:datasource",
)


@dataclass(frozen=True)
class PermissionClaims:
    """The permission claim shape embedded in the access JWT.

    Frozen so the resolver caller cannot accidentally mutate the
    structure between resolution and serialization.
    """
    sid: str                                 # session id (random, used for revocation)
    global_perms: tuple[str, ...] = ()
    ws_perms: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def to_jwt_dict(self) -> dict:
        """Serialize to the JWT claim layout. Field names must stay
        stable — they are a wire contract with the FastAPI dependency."""
        return {
            "sid": self.sid,
            "global": list(self.global_perms),
            "ws": {ws: list(perms) for ws, perms in self.ws_perms.items()},
        }

    @classmethod
    def from_jwt_dict(cls, payload: dict) -> "PermissionClaims":
        sid = payload.get("sid", "")
        global_perms = tuple(payload.get("global", ()) or ())
        raw_ws = payload.get("ws", {}) or {}
        ws_perms = {ws: tuple(perms) for ws, perms in raw_ws.items()}
        return cls(sid=sid, global_perms=global_perms, ws_perms=ws_perms)


def new_session_id() -> str:
    """Random per-login session id used as the revocation key."""
    return f"sess_{secrets.token_urlsafe(16)}"


# ── Resolution ────────────────────────────────────────────────────────

async def resolve(
    session: AsyncSession,
    user_id: str,
    *,
    sid: str | None = None,
) -> PermissionClaims:
    """Compute the user's effective permissions across all scopes.

    One call gathers:
      1. the user's group ids
      2. every direct + group binding affecting them
      3. the permission set for every distinct role they are bound to

    Then folds those into a (global, ws_id → permissions) map, with
    wildcard collapsing for compactness.
    """
    sid = sid or new_session_id()

    group_ids = await user_repo.get_groups_for_user(session, user_id)
    bindings = await binding_repo.list_for_user_with_groups(
        session, user_id=user_id, group_ids=group_ids
    )

    # Collect distinct role names so we can fetch role_permissions in
    # one query. This keeps resolve() O(1) DB calls regardless of how
    # many bindings the user has.
    role_names = sorted({b.role_name for b in bindings})
    role_perms = await permission_repo.get_role_permissions_for_roles(
        session, role_names
    )

    # Aggregate into per-scope permission sets.
    global_set: set[str] = set()
    ws_sets: dict[str, set[str]] = {}

    for b in bindings:
        perms_for_role = role_perms.get(b.role_name, [])
        if b.scope_type == "global":
            global_set.update(perms_for_role)
        else:
            ws_id = b.scope_id or ""
            if not ws_id:
                continue
            ws_sets.setdefault(ws_id, set()).update(perms_for_role)

    # Admin shortcut: a global admin binding implies every workspace
    # permission in every workspace, but the workspace bindings already
    # carry that for the membership-backfilled rows. We DO NOT
    # synthesize implicit ws scopes here — the JWT must list workspaces
    # explicitly so the FE knows which workspaces to display. The
    # admin's actual access in a given workspace falls back to the
    # global "system:admin" implicit-allow check inside ``requires()``.

    return PermissionClaims(
        sid=sid,
        global_perms=tuple(sorted(global_set)),
        ws_perms={
            ws: _collapse_wildcards(perms) for ws, perms in ws_sets.items()
        },
    )


# ── Wildcard collapsing ───────────────────────────────────────────────

def _collapse_wildcards(perms: set[str]) -> tuple[str, ...]:
    """If every permission under a known prefix is present, collapse
    them into ``prefix:*``. Reduces token size for users in many
    workspaces. The ``requires()`` dependency expands the wildcard back.
    """
    out: set[str] = set(perms)
    for prefix in _WILDCARD_PREFIXES:
        leaves = {p for p in out if p.startswith(prefix + ":")}
        # We only collapse if there are >= 2 leaves under the prefix
        # AND all of them are present in our seed catalogue. Otherwise
        # the wildcard is misleading.
        all_known_leaves = _known_leaves_for_prefix(prefix)
        if all_known_leaves and leaves >= all_known_leaves:
            out -= leaves
            out.add(prefix + ":*")
    return tuple(sorted(out))


# Built once at import time from the seed catalogue. Hard-coded here
# rather than fetched from the DB because the catalogue is part of the
# code: it's defined in the migration and the Phase 1 plan, and any
# change to it ships in the same commit as a code update.
_SEED_LEAVES: dict[str, frozenset[str]] = {
    "workspace:view": frozenset({
        "workspace:view:create",
        "workspace:view:edit",
        "workspace:view:delete",
        "workspace:view:read",
    }),
    "workspace:datasource": frozenset({
        "workspace:datasource:manage",
        "workspace:datasource:read",
    }),
}


def _known_leaves_for_prefix(prefix: str) -> frozenset[str]:
    return _SEED_LEAVES.get(prefix, frozenset())


# ── Claim-side helpers (used by ``requires(...)``) ────────────────────

def has_permission(
    claims: PermissionClaims,
    permission: str,
    *,
    workspace_id: str | None = None,
) -> bool:
    """Check whether the resolved claims grant ``permission`` in the
    given scope. ``workspace_id`` is required for workspace-scoped
    permissions; pass ``None`` for global ones.

    Wildcard expansion: a claim of ``workspace:view:*`` matches any
    ``workspace:view:<leaf>`` lookup.

    Global-admin shortcut: a global ``system:admin`` claim implies
    every other permission, in every workspace, full stop.
    """
    # System admin shortcut: implies all.
    if "system:admin" in claims.global_perms:
        return True

    if workspace_id is None:
        return permission in claims.global_perms

    bucket = claims.ws_perms.get(workspace_id, ())
    if permission in bucket:
        return True
    # Wildcard match: e.g. permission='workspace:view:edit' against
    # claim 'workspace:view:*'.
    for granted in bucket:
        if granted.endswith(":*"):
            prefix = granted[:-2]
            if permission.startswith(prefix + ":"):
                return True
    return False


async def simulate_for_user(
    session: AsyncSession,
    user_id: str,
    *,
    role_perm_override: dict[str, list[str]] | None = None,
    excluded_binding_id: str | None = None,
    excluded_role_name: str | None = None,
) -> tuple[set[str], dict[str, set[str]]]:
    """Compute hypothetical effective permissions for a user.

    Used by the Phase 4.4 impact-preview endpoints to answer
    questions like "if I drop ``workspace:view:edit`` from the User
    role, what does Alice lose?" without writing to the DB.

    Hooks:

    * ``role_perm_override`` — temporarily replace the permission set
      for one or more roles. Useful for ``preview-update``.
    * ``excluded_binding_id`` — pretend the named binding doesn't
      exist. Used by ``preview-revoke``.
    * ``excluded_role_name`` — pretend every binding to this role
      doesn't exist. Used by ``preview-delete``.

    Returns the same ``(global_perms, ws_perms)`` shape as
    ``resolve`` but as raw sets (no wildcard collapse) so callers can
    diff cleanly.
    """
    group_ids = await user_repo.get_groups_for_user(session, user_id)
    bindings = await binding_repo.list_for_user_with_groups(
        session, user_id=user_id, group_ids=group_ids
    )

    if excluded_binding_id is not None:
        bindings = [b for b in bindings if b.id != excluded_binding_id]
    if excluded_role_name is not None:
        bindings = [b for b in bindings if b.role_name != excluded_role_name]

    role_names = sorted({b.role_name for b in bindings})
    role_perms = await permission_repo.get_role_permissions_for_roles(
        session, role_names
    )
    if role_perm_override:
        for name, perms in role_perm_override.items():
            role_perms[name] = list(perms)

    global_set: set[str] = set()
    ws_sets: dict[str, set[str]] = {}
    for b in bindings:
        perms_for_role = role_perms.get(b.role_name, [])
        if b.scope_type == "global":
            global_set.update(perms_for_role)
        else:
            ws_id = b.scope_id or ""
            if not ws_id:
                continue
            ws_sets.setdefault(ws_id, set()).update(perms_for_role)
    return global_set, ws_sets


# ── SSO group -> target reconciliation (Phase 3 — both targets) ──────


async def reconcile_sso_targets(
    session: AsyncSession,
    *,
    user_id: str,
    idp_groups: list[str],
    provider_id: Optional[str] = None,
) -> dict:
    """Reconcile the user's ``source='sso'`` RoleBindings AND Group
    memberships to match what the IdP currently asserts.

    Each mapping row's ``target_type`` determines the branch:

      * ``role_binding`` (Phase-2 default): a ``RoleBindingORM`` row
        with ``source='sso'`` in the configured ``(scope_type,
        scope_id, role_name)``.
      * ``group_membership`` (Phase 3 new): a ``GroupMemberORM`` row
        with ``source='sso'`` in the configured internal Group.

    Algorithm (idempotent; called on every SSO login AND on every
    /refresh):

      1. Pull mappings whose ``idp_group`` is in ``idp_groups`` AND
         whose ``provider_id`` matches the user's logging-in IdP OR
         is NULL (the Phase 2 wildcard semantics).
      2. Bucket the target set into two key spaces:
            - role_keys: ``(scope_type, scope_id, role_name)``
            - group_ids: ``{group_id, …}``
      3. For each branch:
            - missing in target -> soft-revoke (``expires_at=now()``
              for bindings; delete row for memberships).
            - present in target -> reactivate (clear ``expires_at``;
              no-op for memberships).
            - target without an existing row -> insert.

    Hard guardrails (mirroring the write-time validation):
      * Mappings pointing at ``system:admin`` are skipped + warned.
      * Mappings whose target_group is ``is_protected=true`` are
        skipped + warned. (Operator can't normally create these; the
        check defends against out-of-band inserts.)

    Returns a small dict of counts for observability / audit.
    """
    from sqlalchemy import update, delete as sa_delete, select as sa_select

    now_iso = datetime.now(timezone.utc).isoformat()

    mappings = await idp_group_mapping_repo.list_active_for_groups(
        session, provider_id=provider_id, idp_groups=idp_groups,
    )

    role_target_keys: set[tuple[str, str | None, str]] = set()
    group_target_ids: set[str] = set()
    for m in mappings:
        if m.target_type == "group_membership":
            if not m.target_group_id:
                continue
            target_group = (await session.execute(
                sa_select(GroupORM).where(GroupORM.id == m.target_group_id)
            )).scalar_one_or_none()
            if target_group is None or target_group.deleted_at is not None:
                continue
            if getattr(target_group, "is_protected", False):
                logger.warning(
                    "Refusing to auto-add %s to protected group %s (mapping=%s)",
                    user_id, m.target_group_id, m.id,
                )
                continue
            group_target_ids.add(m.target_group_id)
        else:
            if m.role_name == FORBIDDEN_AUTO_ROLE:
                logger.warning(
                    "Refusing to auto-grant %s from IdP group %s (mapping id=%s)",
                    FORBIDDEN_AUTO_ROLE, m.idp_group, m.id,
                )
                continue
            if not m.role_name or not m.scope_type:
                continue
            role_target_keys.add((m.scope_type, m.scope_id, m.role_name))

    # ── role_binding branch ───────────────────────────────────────────
    existing = await binding_repo.list_for_subject(
        session, subject_type="user", subject_id=user_id,
    )
    # Snapshot keys of existing sso-sourced bindings.
    existing_sso = {
        (b.scope_type, b.scope_id, b.role_name): b
        for b in existing if getattr(b, "source", "local") == "sso"
    }

    revoked = 0
    reactivated = 0
    created = 0

    # 3a. Soft-revoke bindings the IdP no longer asserts.
    to_expire = [
        b for k, b in existing_sso.items()
        if k not in role_target_keys and b.expires_at is None
    ]
    if to_expire:
        ids = [b.id for b in to_expire]
        await session.execute(
            update(RoleBindingORM)
            .where(RoleBindingORM.id.in_(ids))
            .values(expires_at=now_iso)
        )
        revoked = len(to_expire)

    # 3b. Reactivate bindings the IdP asserts again.
    to_reactivate = [
        b for k, b in existing_sso.items()
        if k in role_target_keys and b.expires_at is not None
    ]
    if to_reactivate:
        ids = [b.id for b in to_reactivate]
        await session.execute(
            update(RoleBindingORM)
            .where(RoleBindingORM.id.in_(ids))
            .values(expires_at=None)
        )
        reactivated = len(to_reactivate)

    # 4. Create missing target bindings.
    for scope_type, scope_id, role_name in role_target_keys:
        if (scope_type, scope_id, role_name) in existing_sso:
            continue
        # Skip when an admin-granted (source='local') binding already
        # exists for the same (scope, role) — no need for a duplicate,
        # and the unique constraint would reject it anyway.
        already = any(
            b.scope_type == scope_type
            and b.scope_id == scope_id
            and b.role_name == role_name
            for b in existing
        )
        if already:
            continue
        new_binding = RoleBindingORM(
            subject_type="user",
            subject_id=user_id,
            role_name=role_name,
            scope_type=scope_type,
            scope_id=scope_id,
            granted_by=None,
            source="sso",
        )
        session.add(new_binding)
        created += 1

    # ── group_membership branch ───────────────────────────────────────
    # Query the user's existing sso-sourced memberships once. The repo
    # would do this for us but we read it directly here to keep this
    # service self-contained (Phase 2 pattern).
    members_q = await session.execute(
        sa_select(GroupMemberORM).where(GroupMemberORM.user_id == user_id)
    )
    members = list(members_q.scalars().all())
    existing_sso_groups = {
        m.group_id for m in members
        if getattr(m, "source", "local") == "sso"
    }
    existing_any_groups = {m.group_id for m in members}

    memberships_removed = 0
    memberships_added = 0

    # 5a. Remove sso memberships that are no longer asserted.
    to_remove = existing_sso_groups - group_target_ids
    if to_remove:
        await session.execute(
            sa_delete(GroupMemberORM).where(
                GroupMemberORM.user_id == user_id,
                GroupMemberORM.group_id.in_(list(to_remove)),
                GroupMemberORM.source == "sso",
            )
        )
        memberships_removed = len(to_remove)

    # 5b. Add memberships the IdP asserts. Skip groups the user is
    # already a member of via a local route (we never overwrite admin-
    # set memberships).
    to_add = group_target_ids - existing_any_groups
    for group_id in to_add:
        session.add(GroupMemberORM(
            group_id=group_id,
            user_id=user_id,
            added_by=None,
            source="sso",
        ))
        memberships_added += 1

    if created or revoked or reactivated or memberships_added or memberships_removed:
        await session.flush()

    return {
        "user_id": user_id,
        "groups": list(idp_groups),
        "mappings_matched": len(mappings),
        "created": created,
        "revoked": revoked,
        "reactivated": reactivated,
        "memberships_added": memberships_added,
        "memberships_removed": memberships_removed,
    }


# Backwards-compatible alias for Phase 2 callers that still import the
# old name. Routes the call to the Phase 3 reconciler with the new
# kwargs. New code should import ``reconcile_sso_targets``.
async def reconcile_sso_role_bindings(
    session: AsyncSession,
    *,
    user_id: str,
    idp_groups: list[str],
    provider_id: Optional[str] = None,
) -> dict:
    return await reconcile_sso_targets(
        session, user_id=user_id, idp_groups=idp_groups, provider_id=provider_id,
    )


__all__ = [
    "PermissionClaims",
    "resolve",
    "new_session_id",
    "has_permission",
    "simulate_for_user",
    "reconcile_sso_role_bindings",
    "reconcile_sso_targets",
]
