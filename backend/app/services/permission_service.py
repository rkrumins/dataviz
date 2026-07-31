"""PermissionService — resolve a user's effective permissions.

The resolver runs once per login and produces a compact claim payload.
Every subsequent request authorizes against those claims instead of
going back to the DB.

It travels in two halves, because only one of them is bounded. The
access JWT carries::

    {"sid": "<session id>", "global": ["workspaces:create", ...]}

and the session store, keyed by ``sid``, carries the per-workspace
grants — deduplicated, since every workspace a user holds the same role
on resolves to the same permission list::

    {"ws": {"ws_finance": 0, "ws_marketing": 1}, "psets": [[...], [...]]}

The store half is unbounded in workspace count and a cookie stops at
4096 bytes, which is the whole reason for the split; see
``PermissionClaims``.

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
    IdpProviderORM,
    RoleBindingORM,
)
from backend.app.db.repositories import (
    binding_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
    permission_repo,
    user_repo,
)
from backend.app.db.repositories.idp_group_mapping_repo import (
    FORBIDDEN_AUTO_ROLES,
)
from backend.auth_service.providers.assurance import (
    UNVERIFIED,
    VERIFIED,
    assurance_for,
    at_least as assurance_at_least,
)
from backend.common.roles import PLATFORM_ADMIN_ROLES

logger = logging.getLogger(__name__)


# Permission ids that the wildcard collapser knows about. Any permission
# whose id starts with one of these prefixes is a candidate for ``*``
# expansion when every leaf under the prefix is granted.
_WILDCARD_PREFIXES = (
    "workspace:view",
    "workspace:datasource",
)


#: Key under which the per-workspace grants travel.
#:
#: Owned here because this module is now the only producer and the only
#: consumer: the grants go to the session store, and ``auth_service`` — the
#: layer that mints the token — has no say in the matter and no reason to
#: know the name. It briefly did, when the mint chose per token whether to
#: embed them, and the constant lived on the boundary for that reason.
#:
#: Its **presence** in a token payload remains load-bearing: absent means
#: "read the grants from the session store". A token minted before the
#: split carries its own and has no store entry, which is what keeps an
#: already-open tab working across the deploy.
WS_CLAIM = "ws"

#: Companion table that ``WS_CLAIM``'s values index into.
#:
#: The grants used to be written out in full once per workspace, and in
#: practice they are the *same* list every time — a user bound as
#: workspace_admin on 150 workspaces produced 150 verbatim copies of one
#: 8-permission array, 29 KB of JSON of which about 99% was repetition.
#: Storing each distinct set once and pointing at it by index is a ~9x
#: reduction with no loss and no lookup: everything needed to expand it
#: travels in the same payload.
WS_SETS_CLAIM = "psets"


@dataclass(frozen=True)
class PermissionClaims:
    """The resolved permission set for one session.

    Frozen so the resolver caller cannot accidentally mutate the
    structure between resolution and serialization.

    This splits across two carriers, and the split is the whole point.
    ``sid`` and the global grants are bounded — global permissions are a
    fixed vocabulary — so they ride in the access JWT. The per-workspace
    grants are **not** bounded: they grow ~200 bytes per workspace a user
    is bound to, and past roughly 18 workspaces the access cookie crosses
    the 4096-byte limit and the browser discards it *silently*. Login
    answers 200, the next request is anonymous, and nothing logs a thing.

    So the workspace half lives in the session store keyed by ``sid`` —
    read on every request already, for revocation — and never in the
    token. See ``to_jwt_dict`` and ``to_session_dict``.
    """
    sid: str                                 # session id (random, used for revocation)
    global_perms: tuple[str, ...] = ()
    ws_perms: dict[str, tuple[str, ...]] = field(default_factory=dict)

    #: Whether ``ws_perms`` is an *answer*. ``False`` means no source could
    #: be reached, so the empty map above says nothing about the user.
    #:
    #: Without this the two states are indistinguishable, and the one that
    #: gets reported is the wrong one: "we could not find out" is rendered
    #: as "you have no workspace access" — a 403 asserting a fact the
    #: server never established, which is precisely the "you don't have
    #: permissions" flash this design set out to remove. Consumers that
    #: read ``ws_perms`` must decide what to do when this is ``False``;
    #: ``requires`` answers 503 and ``GET /me/permissions`` does the same
    #: rather than handing the SPA an authoritative-looking empty map.
    #:
    #: Defaults to ``True`` so a claim set built from a resolution or a
    #: token is trustworthy unless the read path says otherwise. Never
    #: serialized: it is a fact about this request, not about the session.
    ws_available: bool = True

    def to_jwt_dict(self) -> dict:
        """Serialize the half that travels in the access JWT.

        Field names must stay stable — they are a wire contract with the
        FastAPI dependency.

        **Per-workspace grants are deliberately not here, and there is no
        option to include them.** They are unbounded in tenant size, and a
        cookie over 4096 bytes is discarded by the browser with no error at
        all — login answers 200, the next request is anonymous, nothing is
        logged. Anything that grows with customer data has no business in a
        cookie.

        This started as a flag (embed while it fits, shed above a budget).
        That was worse than it looked: a user with 99 workspaces and one
        with 101 exercised different authorization machinery, and the store
        path serving the largest tenants was the one nothing routinely
        tested. Removing the parameter rather than defaulting it is the
        point — there is no call site left that can get it wrong, and the
        invariant is enforced by the signature instead of by review.

        The grants live in ``to_session_dict``. Reading old tokens that
        embedded them still works; see ``_decode_ws``.
        """
        return {
            "sid": self.sid,
            "global": list(self.global_perms),
        }

    def to_session_dict(self) -> dict:
        """The half held in the session store, always written in full.

        Written unconditionally even when the token also carries it, so
        the store never has to be reconciled with a decision made later
        at mint time — and so a token that omits it always has somewhere
        to read it from.
        """
        return self._encode_ws()

    def _encode_ws(self) -> dict:
        """Workspace grants, deduplicated by permission set.

        Every workspace a user holds the same role on resolves to the
        *same* permission list, and the old layout wrote that list out in
        full for each one: 150 workspaces as workspace_admin came to 150
        verbatim copies of one 8-permission array — 29 KB of JSON, about
        99% of it repetition, inflated another third by base64url on the
        way into the token.

        Here each distinct set is stored once in ``psets`` and each
        workspace maps to its index, which is roughly a 9x reduction. The
        table travels with the map, so expansion needs no lookup and no
        knowledge of the role catalogue — deliberately, because a read
        path that had to consult the database to interpret a token would
        put a query on every authenticated request.

        Ordering is by first appearance rather than sorted: it keeps the
        common single-set case at index 0 and makes the payload stable
        for a given resolution, which matters when diffing two tokens.
        """
        sets: list[list[str]] = []
        index_of: dict[tuple[str, ...], int] = {}
        mapping: dict[str, int] = {}
        for ws, perms in self.ws_perms.items():
            key = tuple(perms)
            if key not in index_of:
                index_of[key] = len(sets)
                sets.append(list(perms))
            mapping[ws] = index_of[key]
        return {WS_CLAIM: mapping, WS_SETS_CLAIM: sets}

    @classmethod
    def from_jwt_dict(cls, payload: dict) -> "PermissionClaims":
        sid = payload.get("sid", "")
        global_perms = tuple(payload.get("global", ()) or ())
        return cls(
            sid=sid,
            global_perms=global_perms,
            ws_perms=cls._decode_ws(payload),
        )

    @staticmethod
    def _decode_ws(payload: dict) -> dict[str, tuple[str, ...]]:
        """Expand workspace grants from either layout.

        Both are accepted on purpose and the check is per value, not per
        payload. A token minted before the dedup carries inline lists; one
        minted after carries indices into ``psets``. A tab that was
        already open when this deployed is holding the former, and it has
        to keep working without a reload — so the reader cannot assume a
        layout, only recognise one.

        Self-draining: after one access TTL every live token has rotated
        through the new encoder, and after one refresh TTL no inline token
        can exist. The list branch is removable then.

        An index with no matching entry in ``psets`` yields no grants for
        that workspace rather than raising. A malformed token should cost
        access to what it cannot describe, not 500 the request.
        """
        raw_ws = payload.get(WS_CLAIM, {}) or {}
        sets = payload.get(WS_SETS_CLAIM) or []
        out: dict[str, tuple[str, ...]] = {}
        for ws, value in raw_ws.items():
            if isinstance(value, int) and not isinstance(value, bool):
                if 0 <= value < len(sets):
                    out[ws] = tuple(sets[value])
                else:
                    logger.warning(
                        "Workspace %s references permission set %d but only "
                        "%d were published; treating as no grants.",
                        ws, value, len(sets),
                    )
                    out[ws] = ()
            else:
                # Pre-dedup inline list. See the note above.
                out[ws] = tuple(value)
        return out

    @staticmethod
    def token_carries_ws(payload: dict) -> bool:
        """Whether this token embeds its own workspace grants.

        The read path's entire compatibility story turns on this. A token
        minted before the split carries ``ws`` and has no store entry at
        all, so a tab that was already open when the split deployed must
        be answered from the token. Absence — not emptiness — is what
        means "ask the store": a user with genuinely no workspace grants
        still gets an embedded empty map.
        """
        return WS_CLAIM in payload

    def with_ws(
        self,
        ws_perms: dict[str, tuple[str, ...]] | None,
    ) -> "PermissionClaims":
        """Copy carrying workspace grants from elsewhere (the store).

        ``None`` means no source could answer, and produces a claim set
        that says so — an empty map flagged unavailable — rather than one
        that quietly claims the user holds nothing.
        """
        return PermissionClaims(
            sid=self.sid,
            global_perms=self.global_perms,
            ws_perms=ws_perms if ws_perms is not None else {},
            ws_available=ws_perms is not None,
        )


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

    Phase 5 invariants:

      * **Category × scope filter** — only ``system``-category perms
        land in ``global_perms``; only ``workspace``-category perms
        land in ``ws_perms``. A global ``super_admin`` binding (whose
        role bundles every permission across categories) therefore
        does NOT leak ``workspace:*`` perms into ``global_perms``,
        and a workspace ``admin`` binding does NOT leak ``system:*``
        perms into ``ws_perms``. Without this filter the JWT bloats
        and a malformed cross-scope binding could silently grant the
        wrong tier.
      * **``workspace:admin`` auto-implication** — once we've folded
        bindings, any workspace bucket that contains
        ``workspace:admin`` is unioned with every other known
        ``workspace:*`` leaf in the catalogue. Matches operator
        intuition: "I'm admin in this workspace, so I can read its
        data sources / edit its views / etc." Lets custom roles
        bundle just ``workspace:admin`` rather than enumerating every
        workspace permission.
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
    # Phase 5: pull the {permission_id: category} map once so the
    # category × scope filter has no per-permission DB cost.
    perm_categories = await permission_repo.get_permission_categories(session)

    # Aggregate into per-scope permission sets.
    global_set: set[str] = set()
    ws_sets: dict[str, set[str]] = {}

    for b in bindings:
        perms_for_role = role_perms.get(b.role_name, [])
        for perm in perms_for_role:
            cat = perm_categories.get(perm, "system")
            if b.scope_type == "global" and cat == "system":
                global_set.add(perm)
            elif b.scope_type == "workspace" and cat == "workspace":
                ws_id = b.scope_id or ""
                if ws_id:
                    ws_sets.setdefault(ws_id, set()).add(perm)
            # Other category × scope combinations are silently dropped.
            # See Phase 5 invariants in the docstring above.

    # Phase 5: ``workspace:admin`` auto-implies every other workspace
    # permission in the same bucket. Computed against the seed leaves
    # so a future operator can add a new workspace:* permission to
    # the catalogue and have it pick up automatically.
    for ws_id, perms in ws_sets.items():
        if "workspace:admin" in perms:
            perms.update(_WORKSPACE_CATEGORY_LEAVES)

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
    # NB: ``workspace:view:publish`` MUST live in this set. If it were
    # missing, a role holding the four legacy leaves would still
    # collapse to ``workspace:view:*``, and the wildcard expansion in
    # ``has_permission`` would silently satisfy publish checks for
    # every workspace_member.
    "workspace:view": frozenset({
        "workspace:view:create",
        "workspace:view:edit",
        "workspace:view:delete",
        "workspace:view:publish",
        "workspace:view:read",
    }),
    "workspace:datasource": frozenset({
        "workspace:datasource:manage",
        "workspace:datasource:read",
    }),
    # Phase 18: read+manage split for ontology / catalog; provider
    # stays read-only here (manage is platform-admin-only because
    # provider rows carry credentials).
    "workspace:ontology": frozenset({
        "workspace:ontology:read",
        "workspace:ontology:manage",
    }),
    "workspace:catalog": frozenset({
        "workspace:catalog:read",
        "workspace:catalog:manage",
    }),
    "workspace:provider": frozenset({
        "workspace:provider:read",
    }),
}

# Phase 5 — every ``workspace:*`` leaf known to the seed catalogue.
# Used by ``resolve()`` to auto-imply the full workspace permission
# set whenever a binding grants ``workspace:admin`` in some workspace.
# ``workspace:admin`` itself is the "I can manage settings, members,
# and deletion" perm; bundling it auto-implies "and everything else
# you can do in this workspace as a side effect" — matches operator
# intuition (Phase 5 user decision).
#
# Phase 18 additions: workspace_admin implies workspace:ontology:* and
# workspace:catalog:* (read + manage). Provider manage is deliberately
# omitted — provider credentials remain platform-admin-only — but
# workspace:provider:read is included so a workspace_admin can see the
# providers their workspace touches.
_WORKSPACE_CATEGORY_LEAVES: frozenset[str] = frozenset({
    "workspace:admin",
    "workspace:datasource:manage",
    "workspace:datasource:read",
    "workspace:view:create",
    "workspace:view:edit",
    "workspace:view:delete",
    "workspace:view:publish",
    "workspace:view:read",
    "workspace:ontology:read",
    "workspace:ontology:manage",
    "workspace:catalog:read",
    "workspace:catalog:manage",
    "workspace:provider:read",
})


def _known_leaves_for_prefix(prefix: str) -> frozenset[str]:
    return _SEED_LEAVES.get(prefix, frozenset())


def compute_implied_by(perm_id: str, category: str) -> list[str]:
    """Return the roles/perms whose grant auto-implies ``perm_id``
    in the same scope. Pure projection of ``has_permission``'s
    shortcuts — used by ``GET /admin/permissions`` so the FE's
    Feature Access tab can compute role satisfaction without a
    duplicate ``WORKSPACE_LEAVES`` constant of its own.

    Order is documentation-stable (most-privileged first) so the FE
    can render chips in a predictable order.
    """
    out: list[str] = []
    if perm_id != "system:admin":
        out.append("system:admin")          # implies every perm, every scope.
    if category == "workspace":
        if perm_id != "system:org-admin":
            out.append("system:org-admin")  # implies every workspace:* in any workspace.
        # Phase 6: system:org-viewer is the read-only sibling of
        # system:org-admin. It short-circuits workspace:*:read but
        # NOT manage/write — exactly what the org_auditor role needs
        # to inspect every workspace without being able to mutate.
        if perm_id.endswith(":read"):
            out.append("system:org-viewer")
        if (
            perm_id != "workspace:admin"
            and perm_id in _WORKSPACE_CATEGORY_LEAVES
        ):
            out.append("workspace:admin")   # implies every leaf in the same workspace.
    return out


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

    Two short-circuits at the top:

      * ``system:admin`` (carried by the ``super_admin`` role) implies
        every permission, every scope. The platform owner.
      * ``system:org-admin`` (Phase 5; carried by ``super_admin`` and
        ``org_admin``) implies every **workspace-scoped** permission
        in any workspace. The cross-workspace operator. Does NOT
        imply system-category permissions (users:manage etc.) — those
        stay tied to ``super_admin``.
    """
    # 1. System admin shortcut: implies all permissions, every scope.
    if "system:admin" in claims.global_perms:
        return True

    # 2. Phase 5: org-admin shortcut for workspace-scoped checks. An
    #    org_admin has every workspace power in every workspace
    #    without per-ws bindings; ``MyAccessPage`` surfaces this as
    #    "Organisation admin" and the FE topbar shows the same tier
    #    in every workspace they visit.
    if (
        workspace_id is not None
        and "system:org-admin" in claims.global_perms
    ):
        return True

    # 3. Phase 6: org-viewer — the read-only cousin of org-admin.
    #    Short-circuits every workspace:*:read across every workspace
    #    but NOT manage/write. Drives the ``org_auditor`` role.
    if (
        workspace_id is not None
        and permission.endswith(":read")
        and "system:org-viewer" in claims.global_perms
    ):
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


def has_permission_any_workspace(
    claims: PermissionClaims,
    permission: str,
) -> bool:
    """True if ``claims`` grants ``permission`` in **any** workspace.

    Phase 18 introduced workspace-scoped reads on otherwise-global
    resources (ontologies, providers, catalog items). The list/get
    endpoints don't have a workspace id on the URL — the user just
    needs the perm *somewhere* to read the catalogue (handler then
    filters results to their visible workspaces). This helper drives
    the ``workspace_any=True`` mode of ``requires(...)``.

    Honours the standard short-circuits:
      * ``system:admin`` implies every permission.
      * ``system:org-admin`` implies every workspace-scoped permission
        in every workspace.
    """
    if "system:admin" in claims.global_perms:
        return True
    if "system:org-admin" in claims.global_perms:
        return True
    # Phase 6: org-viewer covers the workspace_any flow for any
    # ``*:read`` permission so the auditor sees every workspace's
    # provider / ontology / catalog listings without needing a
    # per-workspace binding. Mirrors the same-named shortcut in
    # ``has_permission``.
    if (
        permission.endswith(":read")
        and "system:org-viewer" in claims.global_perms
    ):
        return True
    for ws_id in claims.ws_perms.keys():
        if has_permission(claims, permission, workspace_id=ws_id):
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


async def _provider_assurance(
    session: AsyncSession, provider_id: Optional[str],
) -> str:
    """Assurance level for a provider row, failing closed.

    A missing provider_id, a missing row, or an unreadable settings blob all
    resolve to ``unverified`` — the reconciler only uses this to decide
    whether to WITHHOLD a platform-admin grant, so "we don't know" must
    behave the same as "we know it's weak".
    """
    if not provider_id:
        return UNVERIFIED
    from sqlalchemy import select as sa_select

    provider = (await session.execute(
        sa_select(IdpProviderORM).where(IdpProviderORM.id == provider_id)
    )).scalar_one_or_none()
    if provider is None:
        return UNVERIFIED
    return assurance_for(
        provider.kind, idp_provider_repo.decrypt_settings(provider.settings),
    )


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
      * Mappings pointing at a never-auto-granted role
        (``FORBIDDEN_AUTO_ROLES`` — ``super_admin``, plus the legacy
        ``system:admin`` literal) are skipped + warned. This half matters
        independently: a mapping created before the write-time guard was
        corrected, or inserted out of band, must still be refused here
        rather than silently granting platform admin on the next login.
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

    # Resolved once, not per mapping. A provider whose assurance was
    # downgraded after its mappings were written (an operator flipping
    # trust_unsigned on) must stop granting platform admin from the very
    # next login — the write-time check cannot see that happen.
    provider_assurance = await _provider_assurance(session, provider_id)

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
            if m.role_name in FORBIDDEN_AUTO_ROLES:
                logger.warning(
                    "Refusing to auto-grant %s from IdP group %s (mapping id=%s)",
                    m.role_name, m.idp_group, m.id,
                )
                continue
            if (
                m.role_name in PLATFORM_ADMIN_ROLES
                and not assurance_at_least(provider_assurance, VERIFIED)
            ):
                logger.warning(
                    "Refusing to auto-grant platform admin role %s from IdP "
                    "group %s: provider %s has assurance '%s' (mapping id=%s)",
                    m.role_name, m.idp_group, provider_id,
                    provider_assurance, m.id,
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
