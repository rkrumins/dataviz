from fastapi import APIRouter
from .endpoints import (
    graph, assignments, providers, ontologies, workspaces,
    assets, context_models, catalog, views,
)

api_router = APIRouter()

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
