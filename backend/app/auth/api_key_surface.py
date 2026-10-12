"""Which endpoints an API key may call, and how each one is fenced.

Deny by default: a key may call exactly the handlers named here, and every
other route answers ``403 api_key_not_allowed``. Keys are the data plane —
reading and changing views and the data behind them, proposing and
publishing changes, and following what changed — so administration, sharing,
people and platform settings are not here, and a route joins only by being
added to this file in a reviewed change (``test_api_key_surface`` holds a
snapshot of the resulting surface, so the diff shows every route it opens).

Handlers are named by module and function rather than by path. FastAPI
includes routers lazily, so the route a request carries knows only its
router-local path (``/{view_id}``, ``""``), while the endpoint function is
the same object however the router is mounted.

Every entry has a LEVEL, which says how a key limited to particular
workspaces, views or data sources is kept to them:

``RESOURCE``
    Acts on views or data sources the request names — in its path
    (``view_id``, ``ds_id``, ``data_source_id``), its query (``viewId``,
    ``dataSourceId``), or a graph or pull request that resolves to one.
    Each named one must be covered by the key, and must live in the path's
    workspace when there is one: checked at the request boundary, and by the
    dependencies that resolve the rest (the data-plane capability gate,
    ``graph_in_workspace``, ``pr_in_workspace``, ``view_in_workspace``).
``DATA_SOURCE``
    Acts on one data source of the path workspace — the one named by
    ``dataSourceId``, or the workspace's primary when none is named. A key
    that does not cover the whole workspace must name one it covers.
``WORKSPACE``
    A workspace-wide operation — creating something in it, or reading
    across all of it. The key must cover the whole workspace.
``FILTERED``
    Reads across many things, or names views in its body, and the handler
    narrows what it touches with the same checks a browser session goes
    through — the caller's claims, ``readable_views_clause``,
    ``can_read_view`` — all of which honour the key's selection.

``SELF``
    The key inspecting or revoking itself. Allowed to a key that is paused,
    expired or presented from an address it does not allow — whoever holds
    a leaked key must always be able to end it — and to nothing else.

``reads_only`` marks a POST that changes nothing (a search, a trace, an
export): a key whose permissions are all read-only may call it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Optional

from fastapi import Request
from fastapi.routing import APIRoute

RESOURCE = "resource"
DATA_SOURCE = "data_source"
WORKSPACE = "workspace"
FILTERED = "filtered"
SELF = "self"
LEVELS = (RESOURCE, DATA_SOURCE, WORKSPACE, FILTERED, SELF)

#: Methods that read. Anything else must be a ``reads_only`` POST to be
#: reachable with a read-only key.
READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class Rule:
    level: str
    reads_only: bool = False


_ENDPOINTS = "backend.app.api.v1.endpoints."


def _entries(module: str, level: str, *names: str, reads_only: bool = False):
    return {
        (_ENDPOINTS + module, name): Rule(level, reads_only) for name in names
    }


SURFACE: dict[tuple[str, str], Rule] = {
    # ── Views ───────────────────────────────────────────────────────
    # Not here: who a workspace's views can be shared with (people), a
    # reviewer approving or denying someone else's publication (governance),
    # and favourites and visits (a person's own browsing, which automation
    # would only pollute).
    **_entries(
        "views", FILTERED,
        "list_views", "get_view_stats", "get_view_facets", "list_popular_views",
        "list_my_recent_views", "list_my_activity_feed", "list_my_drafts",
    ),
    # ``create_view`` names its workspace in the body;
    # ``authorize_view_create`` holds a key to the workspaces it covers.
    **_entries("views", WORKSPACE, "create_view", "get_workspace_view_activity"),
    **_entries(
        "views", RESOURCE,
        "get_view", "update_view", "delete_view", "restore_view",
        "get_view_activity", "update_view_layout", "update_view_visibility",
        "request_publication", "withdraw_publication_request",
        "get_view_library", "export_view_library", "import_view_library",
        "order_view_queries", "put_view_query", "delete_view_query",
        "order_view_rules", "put_view_rule", "delete_view_rule",
    ),
    **_entries(
        "view_versions", RESOURCE,
        "list_versions", "save_version", "compare_versions", "version_status",
        "get_version", "restore_version",
    ),
    # Exporting view definitions to a file. Not the import side, nor view
    # packages: those write into graphs and data sources named only in the
    # body, which nothing here could hold to the key's selection.
    **_entries(
        "view_transfer", FILTERED,
        "export_view_file", "preview_view_export", reads_only=True,
    ),

    # ── Graph data ──────────────────────────────────────────────────
    # Every route is behind the data-plane capability gate. Not here: the
    # one-time versioning bootstrap and resync, and materialising aggregated
    # edges — operations on a graph's lifecycle, not on its data.
    **_entries(
        "graph", RESOURCE,
        "get_nodes", "get_node", "get_top_level_nodes", "get_node_children",
        "get_children_with_edges", "get_node_parent", "get_node_ancestors",
        "get_node_descendants", "get_allowed_children", "get_allowed_edges",
        "delete_impact", "get_nodes_by_layer_endpoint", "get_nodes_by_tag_endpoint",
        "get_neighborhood_map", "get_edges", "get_entity_types", "get_tags",
        "get_distinct_values", "get_ontology_metadata", "get_graph_schema",
        "get_graph_introspection", "get_refresh_status", "get_graph_stats",
        "get_sync_status", "get_alignment_analysis", "get_vocab_alignment",
        "bootstrap_status_endpoint", "bootstrap_duplicates_endpoint",
        "search_discover", "search_schema", "search_values",
        "search_export_download",
        "create_node", "create_edge", "update_edge", "delete_edge",
        "batch_commands", "apply_graph_changes", "save_graph",
        "refresh_introspection", "confirm_vocab_variant",
    ),
    **_entries(
        "graph", RESOURCE,
        "query_nodes", "query_nodes_page", "get_node_degrees",
        "get_node_ancestor_chains", "query_edges", "get_edges_between",
        "get_edges_beneath", "get_aggregated_edges",
        "search_nodes", "search_advanced", "search_counts", "search_catalog",
        "search_explain", "search_membership", "search_ancestor_counts",
        "search_export",
        "get_lineage_trace_deprecated", "trace_v2", "trace_closure",
        "trace_expand", "trace_expand_batch",
        reads_only=True,
    ),
    **_entries("canvas", RESOURCE, "canvas_bootstrap", "canvas_expand", reads_only=True),
    **_entries("assignments", RESOURCE, "compute_assignments", reads_only=True),
    **_entries("graph_export", DATA_SOURCE, "plan_live_export", "stream_live_export"),
    # Workspace metadata read through the capability gate; changing it is
    # workspace-wide.
    **_entries("assets", RESOURCE, "list_rule_sets", "get_rule_set"),
    **_entries("assets", WORKSPACE, "create_rule_set", "delete_rule_set"),
    **_entries(
        "context_models", RESOURCE,
        "list_workspace_templates", "get_workspace_template",
    ),

    # ── Versioning: drafts, proposals, publishing, history ──────────
    # Not here: creating graphs (blank or forked) and opening a draft by
    # data source, which name their target in the body; rebuilding or
    # reconciling a projection (operations); and adding or removing a
    # draft's members (sharing).
    **_entries(
        "versioning", RESOURCE,
        "resolve_graph_get", "get_graph", "get_watermark", "graph_neighbors",
        "list_branches", "open_draft", "update_branch", "abandon_draft",
        "stage_changes", "checkpoint", "rebase_draft", "publish",
        "get_state", "get_diff", "get_diff_vs_main", "get_diff_vs_main_summary",
        "get_diff_vs_main_children", "get_diff_window", "get_branch_freshness",
        "list_branch_members", "merge_preview", "branch_view_changes",
        "get_commit_log", "get_commit_state", "get_commit_diff_summary",
        "get_commit_diff_children", "get_squashed_commits",
        "get_restore_preview", "restore_to_commit", "revert_commit",
        "get_entity_history", "get_entity_summary",
        "bulk_ingest", "sync_ingest", "get_publish_job",
        "list_imports", "import_template", "create_import", "get_import",
        "get_import_preview", "create_import_upload", "get_import_upload",
        "put_import_upload_part", "complete_import_upload",
        "list_exports", "plan_export", "stream_export", "get_export",
        "download_export", "cancel_export",
        "open_merge_request", "list_merge_requests", "get_merge_request",
        "update_merge_request", "approve_merge_request", "close_merge_request",
        "merge_merge_request", "diff_merge_request", "diff_merge_request_summary",
        "diff_merge_request_children", "preview_merge_request_endpoint",
        "open_pull_request", "list_pull_requests", "get_pull_request",
        "update_pull_request", "approve_pull_request", "close_pull_request",
        "merge_pull_request", "diff_pull_request", "diff_pull_request_summary",
        "diff_pull_request_children", "preview_pull_request",
        "list_data_source_pull_requests", "list_view_pull_requests",
        "count_view_pull_requests",
    ),
    **_entries("versioning", RESOURCE, "create_export", reads_only=True),

    # ── Data sources: their state, their jobs, and change signals ────
    # Not here: anything on the Ingestion cockpit's any-workspace gate
    # (fleet freshness, capacity, settings), and purging, skipping,
    # scheduling or re-limiting aggregation.
    **_entries(
        "aggregation", RESOURCE,
        "get_readiness", "get_projection_health", "get_ontology_resolution",
        "check_drift", "list_jobs", "get_job", "stream_job_events",
        "trigger_aggregation", "resume_job", "cancel_job", "source_changed",
    ),
    **_entries("freshness", RESOURCE, "refresh_data_source"),

    # ── Workspaces, semantic layers, catalog: what the data means ────
    **_entries("workspaces", FILTERED, "list_workspaces", "get_workspace"),
    **_entries("workspaces", WORKSPACE, "list_data_sources"),
    **_entries(
        "workspaces", RESOURCE,
        "get_cached_stats", "get_cached_schema", "get_cached_ontology",
    ),
    **_entries(
        "ontologies", FILTERED,
        "list_ontologies", "get_ontology", "export_ontology",
        "get_ontology_adoption", "get_ontology_coverage_ranking",
        "get_ontology_impact", "get_ontology_source_mappings",
        "get_ontology_assignments",
    ),
    **_entries(
        "catalog", FILTERED,
        "list_catalog_items", "list_catalog_bindings", "get_catalog_item",
        "get_catalog_item_impact",
    ),

    # ── The key itself ──────────────────────────────────────────────
    **_entries("api_keys", SELF, "describe_this_key", "revoke_this_key"),
}


def endpoint_of(request: Request):
    """The handler this request was routed to, or ``None`` before routing."""
    route = request.scope.get("route")
    return getattr(route, "endpoint", None) or request.scope.get("endpoint")


def rule_for(request: Request) -> Optional[Rule]:
    endpoint = endpoint_of(request)
    if endpoint is None:
        return None
    return SURFACE.get(
        (getattr(endpoint, "__module__", ""), getattr(endpoint, "__name__", ""))
    )


def is_read(request: Request, rule: Optional[Rule]) -> bool:
    """Whether this request only reads: a read method, or a POST registered
    as changing nothing."""
    return request.method.upper() in READ_METHODS or bool(rule and rule.reads_only)


def routes(app) -> Iterator[tuple[str, str, APIRoute, object]]:
    """``(method, full path, route, dependant)`` for every route ``app``
    mounts, on both router shapes FastAPI has had: routers included lazily
    (``_IncludedRouter``, whose absolute paths and merged dependants exist
    only through ``effective_candidates``) and routers flattened into
    ``app.routes``."""
    import fastapi.routing as _fr

    included = getattr(_fr, "_IncludedRouter", None)

    def _emit(ctx):
        original = getattr(ctx, "original_route", None)
        if isinstance(original, APIRoute):
            yield (
                getattr(ctx, "path", "") or "", original,
                getattr(ctx, "dependant", None) or original.dependant,
            )

    def _walk(items):
        for route in items:
            if included is not None and isinstance(route, included):
                for cand in route.effective_candidates():
                    if isinstance(cand, included):
                        yield from _walk([cand])
                    else:
                        yield from _emit(cand)
                for cand in route.effective_low_priority_routes():
                    yield from _emit(cand)
            elif isinstance(route, APIRoute):
                yield route.path, route, route.dependant

    for path, route, dependant in _walk(app.routes):
        for method in sorted(route.methods or ()):
            yield method, path, route, dependant


def rule_of(route: APIRoute) -> Optional[Rule]:
    return SURFACE.get((route.endpoint.__module__, route.endpoint.__name__))


def eligible(app) -> Iterator[tuple[str, str, Rule]]:
    """``(method, full path, rule)`` for every route an API key may call."""
    for method, path, route, _dependant in routes(app):
        rule = rule_of(route)
        if rule is not None:
            yield method, path, rule


SECURITY_SCHEME = "apiKey"


def document(schema: dict, app) -> dict:
    """Mark the OpenAPI ``schema`` with what keys may call: a bearer scheme,
    and on exactly the operations a key may call, that scheme plus the
    route's level (``x-api-key``)."""
    schema.setdefault("components", {}).setdefault("securitySchemes", {})[SECURITY_SCHEME] = {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "nxpat_…",
        "description": (
            "An API key created under Account → API keys, sent as "
            "`Authorization: Bearer nxpat_…`. It acts as the person who created "
            "it, limited to what the key allows. Only the operations marked "
            "with this scheme accept one."
        ),
    }
    paths = schema.get("paths", {})
    for method, path, rule in eligible(app):
        operation = paths.get(path, {}).get(method.lower())
        if operation is None:
            continue
        operation["security"] = [{SECURITY_SCHEME: []}]
        operation["x-api-key"] = {"level": rule.level, "readsOnly": rule.reads_only}
    return schema


__all__ = [
    "RESOURCE", "DATA_SOURCE", "WORKSPACE", "FILTERED", "SELF", "LEVELS",
    "Rule", "SURFACE", "SECURITY_SCHEME", "endpoint_of", "rule_for",
    "rule_of", "is_read", "routes", "eligible", "document",
]
