from fastapi import APIRouter
from .endpoints import (
    graph, assignments, connections, ontology, views, views_v2,
    providers, blueprints, workspaces, assets, context_models,
)

api_router = APIRouter()

# ── Admin routers (workspace-centric) ───────────────────────────────
api_router.include_router(
    providers.router, prefix="/admin/providers", tags=["admin:providers"],
)
api_router.include_router(
    blueprints.router, prefix="/admin/blueprints", tags=["admin:blueprints"],
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
    views_v2.router, prefix="/views", tags=["views"],
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
# Asset endpoints: /api/v1/{ws_id}/assets/views, /api/v1/{ws_id}/assets/rule-sets
api_router.include_router(
    assets.router, prefix="/{ws_id}/assets", tags=["assets:workspace"],
)
# Context models: /api/v1/{ws_id}/context-models
api_router.include_router(
    context_models.router, prefix="/{ws_id}/context-models", tags=["context-models"],
)

# # ── Legacy routers (backward compat, kept during migration) ─────────
# # Core graph data endpoints (accept optional ?connectionId=)
# api_router.include_router(graph.router, tags=["graph"])

# # Assignment compute (stateless per-request)
# api_router.include_router(
#     assignments.router, prefix="/assignments", tags=["assignments"],
# )

# # Connection management (legacy)
# api_router.include_router(
#     connections.router, prefix="/connections", tags=["connections"],
# )

# # Per-connection ontology overrides (legacy)
# api_router.include_router(
#     ontology.router,
#     prefix="/connections/{connection_id}/ontology",
#     tags=["ontology"],
# )

# # Per-connection saved views and rule sets (legacy)
# api_router.include_router(
#     views.router,
#     prefix="/connections/{connection_id}",
#     tags=["views"],
# )
