from fastapi import APIRouter, Depends

from backend.app.auth.dependencies import requires
from .versioning_gate import versioning_write_gate
from .endpoints import (
    graph, canvas, assignments, providers, ontologies, workspaces,
    assets, context_models, catalog, views, features,
    auth, users, announcements, aggregation, freshness, stats_admin,
    insights, me, system_status, redis_config,
    groups, workspace_members, view_grants, role_bindings,
    permissions_admin, access_requests, rbac_search,
    versioning,
    admin_idp_groups,
    admin_idp_providers,
    admin_user_identities,
    admin_users_lookup,
    admin_sso_config,
    me_identities,
    audit,
    branding,
)
from backend.auth_service.api.router import router as auth_session_router

api_router = APIRouter()

# ── Auth & user routers ───────────────────────────────────────────────
# Two routers under /auth:
#   * auth_session_router (auth_service): /login, /logout, /refresh, /me
#     — cookie-based session lifecycle, owned by the extractable auth service.
#   * auth.router (legacy): /signup, /forgot-password, /reset-password,
#     /verify-invite — flows that don't issue session cookies. Will follow
#     into the auth service in a later move.
api_router.include_router(
    auth_session_router, prefix="/auth", tags=["auth"],
)
api_router.include_router(
    auth.router, prefix="/auth", tags=["auth"],
)
api_router.include_router(
    users.router, prefix="/users", tags=["users"],
)
api_router.include_router(
    users.admin_router, prefix="/admin/users", tags=["admin:users"],
)
# RBAC Phase 1: /me/permissions for FE permission hydration.
api_router.include_router(
    me.router, prefix="/me", tags=["me"],
)

# ── Admin routers (workspace-centric) ───────────────────────────────
# Phase 18: router-level ``system:admin`` gates dropped from providers /
# catalog / ontologies. Each route now declares its own gate (read paths
# use ``workspace:*:read`` with ``workspace_any=True``; write paths
# escalate to ``workspace:*:manage`` or ``system:admin``). Handlers
# filter list results to what the caller's workspaces touch.
api_router.include_router(
    providers.router, prefix="/admin/providers", tags=["admin:providers"],
)
api_router.include_router(
    catalog.router, prefix="/admin/catalog", tags=["admin:catalog"],
)
api_router.include_router(
    ontologies.router, prefix="/admin/ontologies", tags=["admin:ontologies"],
)
api_router.include_router(
    workspaces.router, prefix="/admin/workspaces", tags=["admin:workspaces"],
)
api_router.include_router(
    context_models.template_router, prefix="/admin/context-model-templates",
    tags=["admin:context-model-templates"],
    dependencies=[Depends(requires("system:admin"))],
)
api_router.include_router(
    features.router, prefix="/admin/features", tags=["admin:features"],
    dependencies=[Depends(requires("system:admin"))],
)
# Public read-only flag values — the app shell needs them before/without a
# session (mirrors branding.public_router). Values only, never admin metadata.
api_router.include_router(
    features.public_router, prefix="/features", tags=["features"],
)
api_router.include_router(
    announcements.admin_router, prefix="/admin/announcements", tags=["admin:announcements"],
)

# ── RBAC Phase 2 admin surface ───────────────────────────────────────
# Group CRUD + membership; per-workspace member bindings; per-view
# explicit grants; and the role-binding audit endpoint. All require
# the appropriate RBAC permission via ``requires(...)``.
api_router.include_router(
    groups.router, prefix="/admin/groups", tags=["admin:rbac:groups"],
)
api_router.include_router(
    workspace_members.router,
    prefix="/admin/workspaces/{ws_id}/members",
    tags=["admin:rbac:workspace-members"],
)
api_router.include_router(
    role_bindings.router,
    prefix="/admin/role-bindings",
    tags=["admin:rbac:audit"],
)
# Permissions catalogue + role definitions + per-user access map.
# Backs the Permissions admin page (Role matrix, By-user lens).
api_router.include_router(
    permissions_admin.router,
    prefix="/admin",
    tags=["admin:rbac:permissions"],
)
api_router.include_router(
    view_grants.router,
    prefix="/views/{view_id}/grants",
    tags=["views:grants"],
)

# RBAC Phase 4.3 — self-service access requests.
# Mounted on three different prefixes so the auth gate is naturally
# scoped: any-user submit, any-user "my requests", and admin inbox.
api_router.include_router(
    access_requests.public_router,
    prefix="/access-requests",
    tags=["access-requests"],
)
api_router.include_router(
    access_requests.me_router,
    prefix="/me",
    tags=["me:access-requests"],
)
api_router.include_router(
    access_requests.admin_ws_router,
    prefix="/admin/workspaces/{ws_id}/access-requests",
    tags=["admin:access-requests:inbox"],
)
api_router.include_router(
    access_requests.admin_router,
    prefix="/admin/access-requests",
    tags=["admin:access-requests"],
)

# RBAC Phase 4.5 — unified RBAC search across users, groups,
# workspaces, roles, and permissions. Backs the search bar at the
# top of the Permissions admin surface.
api_router.include_router(
    rbac_search.router,
    prefix="/admin/rbac/search",
    tags=["admin:rbac:search"],
)

# RBAC Phase 7 — audit history lens. Reads outbox events with
# filter + cursor pagination. Backs the /admin/audit page.
api_router.include_router(
    audit.router,
    prefix="/admin/audit",
    tags=["admin:audit"],
)

# RBAC Phase 5 — IdP group -> RoleBinding / Group membership mapping.
# Admin manages the mapping table; the SSO login + refresh paths
# apply it via permission_service.reconcile_sso_targets.
api_router.include_router(
    admin_idp_groups.router,
    prefix="/admin/idp-group-mappings",
    tags=["admin:rbac:idp-groups"],
)

# SSO Phase 3 — IdP provider CRUD (multi-IdP DB-stored config).
api_router.include_router(
    admin_idp_providers.router,
    prefix="/admin/idp-providers",
    tags=["admin:sso:providers"],
)

# SSO Phase 3 — admin user-identity link/unlink.
api_router.include_router(
    admin_user_identities.router,
    prefix="/admin/users/{user_id}/identities",
    tags=["admin:sso:identities"],
)

# SSO Phase 3 — self-service identity management.
api_router.include_router(
    me_identities.router,
    prefix="/me/identities",
    tags=["me:identities"],
)

# SSO Phase 4 — admin user lookup + free-text fan-out search.
# Mounted under /admin/users so it sits next to the existing
# admin user-management endpoints.
api_router.include_router(
    admin_users_lookup.router,
    prefix="/admin/users",
    tags=["admin:users:lookup"],
)

# SSO Phase 4 — platform SSO posture (master kill-switch + local-login
# + JIT-provisioning toggles). Singleton row in app_auth_config.
api_router.include_router(
    admin_sso_config.router,
    prefix="/admin/sso/config",
    tags=["admin:sso:config"],
)

# ── Public announcements (no auth — all users see banners) ────────────
api_router.include_router(
    announcements.router, prefix="/announcements", tags=["announcements"],
)

# ── Branding (white-label app identity) ───────────────────────────────
# Public GET — the login page, tab title and favicon need branding
# before a session exists. Admin PATCH/upload is system:admin-gated.
api_router.include_router(
    branding.public_router, prefix="/branding", tags=["branding"],
)
api_router.include_router(
    branding.admin_router, prefix="/admin/branding", tags=["admin:branding"],
)
# Aggregation service: /api/v1/admin/...
# Phase 19: per-endpoint workspace-scoped gates inside the router
# (see ``aggregation.py: _require_ds_perm``). The router-level
# ``system:admin`` dependency was too coarse — workspace admins
# couldn't trigger or manage aggregation on their own data sources
# without being elevated to platform admin. Each endpoint now picks
# the right gate based on the action (manage for mutations, read for
# GETs, system:admin only for genuinely cross-workspace operations).
api_router.include_router(
    aggregation.router, prefix="/admin", tags=["admin:aggregation"],
)
# Freshness Cockpit: /api/v1/admin/freshness + /api/v1/admin/data-sources/
# {id}/freshness + .../refresh. Per-endpoint gates inside the router
# (ingestion-read for the views, _REQUIRE_DS_MANAGE for the refresh verb),
# same pattern as the aggregation router above.
api_router.include_router(
    freshness.router, prefix="/admin", tags=["admin:freshness"],
)
# Stats service: /api/v1/admin/stats-polling
api_router.include_router(
    stats_admin.router, prefix="/admin", tags=["admin:stats"],
)
# Insights service: /api/v1/admin/insights/providers/{id}/assets[/...]
# Cache-only reads for pre-registration discovery.
api_router.include_router(
    insights.router, prefix="/admin/insights", tags=["admin:insights"],
    dependencies=[Depends(requires("system:admin"))],
)
# Infrastructure status: /api/v1/admin/system/status — super-admin
# single-pane snapshot of every backing service + data-plane lag.
api_router.include_router(
    system_status.router, prefix="/admin/system", tags=["admin:system-status"],
    dependencies=[Depends(requires("system:admin"))],
)
# Redis config: /api/v1/admin/redis/config + /api/v1/admin/redis/{role}/test —
# super-admin resolved-config + connection-test surface (mirrors system_status).
api_router.include_router(
    redis_config.router, prefix="/admin/redis", tags=["admin:redis"],
    dependencies=[Depends(requires("system:admin"))],
)

# ── Top-level views (first-class, cross-workspace) ─────────────────
api_router.include_router(
    views.router, prefix="/views", tags=["views"],
)

# ── Versioned graph editing (workspace-scoped) ───────────────────────
# The ONLY path between the frontend and the graphver Postgres store; the
# browser never touches the DB directly. Authenticated + RBAC-gated on the
# data-source permissions (a graph is 1:1 with a data source), and every
# graph id is checked to belong to {ws_id} for tenant isolation.
# versioning_write_gate: every MUTATING route 403s when the admin turns the
# ``versioningEnabled`` flag off (reads stay open — see versioning_gate.py).
api_router.include_router(
    versioning.router, prefix="/{ws_id}/versioning", tags=["versioning:workspace"],
    dependencies=[Depends(versioning_write_gate)],
)

# ── Workspace-scoped data routers ───────────────────────────────────
# Graph endpoints: /api/v1/{ws_id}/graph/trace, /api/v1/{ws_id}/graph/nodes, etc.
# (api_router is already mounted at /api/v1, so prefix is just /{ws_id}/graph)
api_router.include_router(
    graph.router, prefix="/{ws_id}/graph", tags=["graph:workspace"],
    dependencies=[Depends(requires("workspace:datasource:read", workspace="ws_id"))],
)
# Assignment compute (workspace-scoped)
api_router.include_router(
    assignments.router, prefix="/{ws_id}/graph/assignments", tags=["assignments:workspace"],
    dependencies=[Depends(requires("workspace:datasource:read", workspace="ws_id"))],
)
# Batched canvas contract (open/expand) — /api/v1/{ws_id}/graph/canvas/*
api_router.include_router(
    canvas.router, prefix="/{ws_id}/graph", tags=["canvas:workspace"],
    dependencies=[Depends(requires("workspace:datasource:read", workspace="ws_id"))],
)
# Asset endpoints: /api/v1/{ws_id}/assets/rule-sets
api_router.include_router(
    assets.router, prefix="/{ws_id}/assets", tags=["assets:workspace"],
    dependencies=[Depends(requires("workspace:datasource:read", workspace="ws_id"))],
)
# Context models: /api/v1/{ws_id}/context-models
api_router.include_router(
    context_models.router, prefix="/{ws_id}/context-models", tags=["context-models"],
    dependencies=[Depends(requires("workspace:datasource:read", workspace="ws_id"))],
)
