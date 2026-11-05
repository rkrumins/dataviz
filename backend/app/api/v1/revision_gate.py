"""Reading a data source's graph as it was at a past revision: ``?asOfSeq=`` on ``/{ws_id}/graph``.

A past revision is ``main`` as it was then: its store at the head, with the patch set of everything
changed since put back over it (``ContextEngine.for_workspace`` with ``as_of_seq``). Only the routes
in :data:`REVISION_READS` read through it: they ask for nodes, edges, children and rollups, which
that reader answers as of the revision. Every other graph route refuses a revision rather than
answer from the graph as it is now: a write, or a read that plans one, with 409
``revision_read_only`` (:data:`REVISION_WRITES`); any other read (search, traces, metadata, stats)
with 501 ``revision_unsupported``. A route nobody has listed refuses, so a new route reads the past
only once someone has checked that it can.

Every ``/{ws_id}/graph`` router is mounted with :func:`revision_gate` (``api.py``). It asks, only
when a request names a revision, for the preview switch (``revisionViewerEnabled``: off, and a flag
that can't be read means off), version control, and read access to the data source itself: a
view's share link reaches the graph as it is now, never its history.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Query, Request

from backend.app.api.v1.feature_gate import feature_disabled
from backend.app.api.v1.versioning_gate import require_versioning_enabled
from backend.app.auth.dependencies import get_permission_claims
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.versioning.errors import RevisionReadOnly, RevisionUnsupported

FLAG = "revisionViewerEnabled"
_READ = "workspace:datasource:read"

_GRAPH = "backend.app.api.v1.endpoints.graph"
_CANVAS = "backend.app.api.v1.endpoints.canvas"
_ASSIGNMENTS = "backend.app.api.v1.endpoints.assignments"

#: The routes that answer as the graph was at a revision, as ``(module, handler)``: each reads only
#: nodes, edges, children, ancestors, degrees and rollups through the engine's provider.
REVISION_READS = frozenset({
    (_GRAPH, "get_node"),
    (_GRAPH, "get_nodes"),
    (_GRAPH, "query_nodes"),
    (_GRAPH, "query_nodes_page"),
    (_GRAPH, "get_top_level_nodes"),
    (_GRAPH, "get_node_children"),
    (_GRAPH, "get_children_with_edges"),
    (_GRAPH, "get_node_ancestors"),
    (_GRAPH, "get_node_ancestor_chains"),
    (_GRAPH, "get_node_degrees"),
    (_GRAPH, "get_neighborhood_map"),
    (_GRAPH, "get_edges"),
    (_GRAPH, "query_edges"),
    (_GRAPH, "get_edges_between"),
    (_GRAPH, "get_edges_beneath"),
    (_GRAPH, "get_aggregated_edges"),
    (_CANVAS, "canvas_bootstrap"),
    (_CANVAS, "canvas_expand"),
    (_ASSIGNMENTS, "compute_assignments"),
})

#: The writes, and the reads that only plan one: 409, a past revision is read-only.
REVISION_WRITES = frozenset({
    (_GRAPH, "save_graph"),
    (_GRAPH, "create_node"),
    (_GRAPH, "create_edge"),
    (_GRAPH, "update_edge"),
    (_GRAPH, "delete_edge"),
    (_GRAPH, "batch_commands"),
    (_GRAPH, "apply_graph_changes"),
    (_GRAPH, "materialize_aggregated_edges"),
    (_GRAPH, "resync_versioned_graph_endpoint"),
    (_GRAPH, "delete_impact"),
    (_GRAPH, "get_allowed_children"),
    (_GRAPH, "get_allowed_edges"),
    (_GRAPH, "bootstrap_versioned_graph_endpoint"),
    (_GRAPH, "bootstrap_decision_endpoint"),
    (_GRAPH, "bootstrap_retry_endpoint"),
    (_GRAPH, "bootstrap_abandon_endpoint"),
    (_GRAPH, "refresh_introspection"),
    (_GRAPH, "confirm_vocab_variant"),
})


def route_key(request: Request) -> tuple:
    """The ``(module, handler)`` of the route a request matched."""
    endpoint = getattr(request.scope.get("route"), "endpoint", None)
    return getattr(endpoint, "__module__", None), getattr(endpoint, "__name__", None)


async def revision_gate(
    request: Request,
    asOfSeq: Optional[int] = Query(
        None, ge=0,
        description="Read the published graph as it was at this revision of main (its commit "
                    "seq), read-only. Preview: revisionViewerEnabled."),
    claims: PermissionClaims = Depends(get_permission_claims),
) -> Optional[int]:
    """The revision a graph request reads at, or None for the graph as it is now; refuses a
    revision the route can't answer as it was (see the module docstring)."""
    if asOfSeq is None:
        return None
    if not await feature_flags.is_enabled_self_session(FLAG, default=False):
        raise feature_disabled(FLAG)
    await require_versioning_enabled()
    ws_id = request.path_params.get("ws_id")
    if not has_permission(claims, _READ, workspace_id=ws_id):
        if not claims.ws_available:
            raise HTTPException(status_code=503, detail="Authorization temporarily unavailable")
        raise HTTPException(status_code=403, detail={
            "error": "missing_permission", "permission": _READ,
            "scope": {"type": "workspace", "id": ws_id},
            "message": "Past revisions are open to people who can read the data source, "
                       "not through a view's link",
        })
    key = route_key(request)
    if key in REVISION_WRITES:
        raise RevisionReadOnly()
    if key not in REVISION_READS:
        raise RevisionUnsupported(
            "route", "This reads the published graph as it is now, not as it was at a past "
                     "revision: go back to Published to use it")
    return asOfSeq
