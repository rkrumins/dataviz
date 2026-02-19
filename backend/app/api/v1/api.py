from fastapi import APIRouter
from .endpoints import (
    graph, assignments, connections, ontology, views,
    providers, blueprints, workspaces, assets,
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

# ── Workspace-scoped data routers ───────────────────────────────────
# Graph endpoints: /v1/{ws_id}/graph/trace, /v1/{ws_id}/graph/nodes, etc.
api_router.include_router(
    graph.router, prefix="/v1/{ws_id}/graph", tags=["graph:workspace"],
)
# Asset endpoints: /v1/{ws_id}/assets/views, /v1/{ws_id}/assets/rule-sets
api_router.include_router(
    assets.router, prefix="/v1/{ws_id}/assets", tags=["assets:workspace"],
)

# ── Legacy routers (backward compat, kept during migration) ─────────
# Core graph data endpoints (accept optional ?connectionId=)
api_router.include_router(graph.router, tags=["graph"])

# Assignment compute (stateless per-request)
api_router.include_router(
    assignments.router, prefix="/assignments", tags=["assignments"],
)

# Connection management (legacy)
api_router.include_router(
    connections.router, prefix="/connections", tags=["connections"],
)

# Per-connection ontology overrides (legacy)
api_router.include_router(
    ontology.router,
    prefix="/connections/{connection_id}/ontology",
    tags=["ontology"],
)

# Per-connection saved views and rule sets (legacy)
api_router.include_router(
    views.router,
    prefix="/connections/{connection_id}",
    tags=["views"],
)
