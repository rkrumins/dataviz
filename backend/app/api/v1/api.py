from fastapi import APIRouter
from .endpoints import (
    graph, assignments, providers, ontologies, workspaces,
    assets, context_models, catalog, views, features,
    auth, users, announcements, aggregation,
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

# ── Admin routers (workspace-centric) ───────────────────────────────
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
)
api_router.include_router(
    features.router, prefix="/admin/features", tags=["admin:features"],
)
api_router.include_router(
    announcements.admin_router, prefix="/admin/announcements", tags=["admin:announcements"],
)

# ── Public announcements (no auth — all users see banners) ────────────
api_router.include_router(
    announcements.router, prefix="/announcements", tags=["announcements"],
)
# Aggregation service: /api/v1/admin/...
api_router.include_router(
    aggregation.router, prefix="/admin", tags=["admin:aggregation"],
)

# ── Top-level views (first-class, cross-workspace) ─────────────────
api_router.include_router(
    views.router, prefix="/views", tags=["views"],
)

# ── Workspace-scoped data routers ───────────────────────────────────
# Graph endpoints: /api/v1/{ws_id}/graph/trace, /api/v1/{ws_id}/graph/nodes, etc.
# (api_router is already mounted at /api/v1, so prefix is just /{ws_id}/graph)
api_router.include_router(
    graph.router, prefix="/{ws_id}/graph", tags=["graph:workspace"],
)
# Assignment compute (workspace-scoped)
api_router.include_router(
    assignments.router, prefix="/{ws_id}/graph/assignments", tags=["assignments:workspace"],
)
# Asset endpoints: /api/v1/{ws_id}/assets/rule-sets
api_router.include_router(
    assets.router, prefix="/{ws_id}/assets", tags=["assets:workspace"],
)
# Context models: /api/v1/{ws_id}/context-models
api_router.include_router(
    context_models.router, prefix="/{ws_id}/context-models", tags=["context-models"],
)
