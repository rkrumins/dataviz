"""DDL bootstrap and INFORMATION_SCHEMA introspection for Spanner Graph.

The provider auto-creates a managed schema on first connect when none
exists: two unified tables (``SynodicNodes`` / ``SynodicEdges``), the
matching indexes, and a PROPERTY GRAPH that exposes them. This is what
makes onboarding "just work" against a fresh Spanner database or the
emulator. When the user wants to point Synodic at an existing Spanner
Graph schema, ``auto_bootstrap=False`` skips this step and the provider
queries whatever the user pre-provisioned.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from backend.common.interfaces.provider import ProviderConfigurationError

from .connection import DEFAULT_DDL_TIMEOUT_S, SpannerConnection
from .mapping import sanitize_identifier

logger = logging.getLogger(__name__)


def managed_schema_ddl(graph_name: str) -> List[str]:
    """Return the idempotent DDL statements for the managed schema.

    The schema is intentionally simple: one table for nodes, one for
    edges, with ``entity_type`` and ``edge_type`` columns providing label
    dispatch. The PROPERTY GRAPH wraps both tables so GQL queries see a
    uniform ``Node`` / ``Edge`` label space; per-type filtering happens
    in the WHERE clause via the ``entity_type`` / ``edge_type`` columns.
    """
    g = sanitize_identifier(graph_name)
    return [
        # Nodes
        (
            "CREATE TABLE IF NOT EXISTS SynodicNodes ("
            " urn STRING(MAX) NOT NULL,"
            " entity_type STRING(256) NOT NULL,"
            " display_name STRING(MAX),"
            " qualified_name STRING(MAX),"
            " description STRING(MAX),"
            " properties JSON,"
            " tags ARRAY<STRING(256)>,"
            " layer_assignment STRING(256),"
            " source_system STRING(256),"
            " last_synced_at TIMESTAMP OPTIONS (allow_commit_timestamp=true)"
            ") PRIMARY KEY (urn)"
        ),
        "CREATE INDEX IF NOT EXISTS idx_synodic_nodes_entity_type ON SynodicNodes(entity_type)",
        "CREATE INDEX IF NOT EXISTS idx_synodic_nodes_display_name ON SynodicNodes(display_name)",
        # Edges
        (
            "CREATE TABLE IF NOT EXISTS SynodicEdges ("
            " edge_id STRING(MAX) NOT NULL,"
            " source_urn STRING(MAX) NOT NULL,"
            " target_urn STRING(MAX) NOT NULL,"
            " edge_type STRING(256) NOT NULL,"
            " confidence FLOAT64,"
            " properties JSON,"
            " last_synced_at TIMESTAMP OPTIONS (allow_commit_timestamp=true)"
            ") PRIMARY KEY (edge_id)"
        ),
        "CREATE INDEX IF NOT EXISTS idx_synodic_edges_source ON SynodicEdges(source_urn, edge_type)",
        "CREATE INDEX IF NOT EXISTS idx_synodic_edges_target ON SynodicEdges(target_urn, edge_type)",
        "CREATE INDEX IF NOT EXISTS idx_synodic_edges_type ON SynodicEdges(edge_type)",
        # Property graph — uses a single Node label and a single Edge label;
        # type dispatch is via the entity_type / edge_type columns.
        # ``CREATE OR REPLACE`` keeps the DDL idempotent when the schema
        # itself evolves between releases.
        (
            f"CREATE OR REPLACE PROPERTY GRAPH {g}"
            " NODE TABLES ("
            "  SynodicNodes"
            "   KEY (urn)"
            "   LABEL Node PROPERTIES ("
            "    urn, entity_type, display_name, qualified_name, description,"
            "    properties, tags, layer_assignment, source_system, last_synced_at"
            "   )"
            " )"
            " EDGE TABLES ("
            "  SynodicEdges"
            "   KEY (edge_id)"
            "   SOURCE KEY (source_urn) REFERENCES SynodicNodes (urn)"
            "   DESTINATION KEY (target_urn) REFERENCES SynodicNodes (urn)"
            "   LABEL Edge PROPERTIES (edge_id, edge_type, confidence, properties)"
            " )"
        ),
    ]


def aggregation_sidecar_ddl(graph_name: str) -> List[str]:
    """Idempotent DDL for the aggregation sidecar + watermark state."""
    g = sanitize_identifier(graph_name)
    sidecar = f"Synodic_AggregatedEdges_{g}"
    state = f"Synodic_AggregationState_{g}"
    idx_target = sanitize_identifier(f"idx_{sidecar}_target")[:127]
    return [
        (
            f"CREATE TABLE IF NOT EXISTS `{sidecar}` ("
            " source_urn STRING(MAX) NOT NULL,"
            " target_urn STRING(MAX) NOT NULL,"
            " weight INT64 NOT NULL,"
            " source_edge_types ARRAY<STRING(256)>,"
            " latest_update TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true)"
            ") PRIMARY KEY (source_urn, target_urn)"
        ),
        f"CREATE INDEX IF NOT EXISTS `{idx_target}` ON `{sidecar}`(target_urn)",
        (
            f"CREATE TABLE IF NOT EXISTS `{state}` ("
            " scope STRING(256) NOT NULL,"
            " last_aggregation_commit_ts TIMESTAMP,"
            " last_full_run_at TIMESTAMP,"
            " notes STRING(MAX)"
            ") PRIMARY KEY (scope)"
        ),
    ]


def sidecar_table_name(graph_name: str) -> str:
    return f"Synodic_AggregatedEdges_{sanitize_identifier(graph_name)}"


def aggregation_state_table_name(graph_name: str) -> str:
    return f"Synodic_AggregationState_{sanitize_identifier(graph_name)}"


async def run_ddl(
    conn: SpannerConnection,
    statements: List[str],
    *,
    label: str,
    timeout_s: float = DEFAULT_DDL_TIMEOUT_S,
) -> None:
    """Submit a DDL batch with helpful error reporting for IAM failures.

    The Spanner DDL pipeline batches statements into a single update;
    each statement runs in its own transaction. We surface permission
    errors as ``ProviderConfigurationError`` so the operator sees the
    exact missing role rather than a generic 403 mid-flight.
    """
    if not statements:
        return

    def _ddl() -> None:
        op = conn.database.update_ddl(statements)
        op.result(timeout=timeout_s)

    try:
        await conn.run_in_executor(_ddl, timeout=timeout_s + 5)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "permission" in msg or "forbidden" in msg or "iam" in msg:
            raise ProviderConfigurationError(
                f"spanner_graph: DDL for {label} requires "
                f"`spanner.databases.updateDdl` on database "
                f"`{conn.project_id}/{conn.instance_id}/{conn.database_id}`. "
                f"Grant `roles/spanner.databaseAdmin` (or a custom role with "
                f"that permission) to the principal running Synodic. "
                f"Underlying error: {exc}"
            ) from exc
        raise


async def schema_exists(conn: SpannerConnection, graph_name: str) -> bool:
    """True when the managed schema (table + property graph) already exists.

    Cheaper than running CREATE-IF-NOT-EXISTS on every connect; lets us
    skip the DDL round-trip on warm starts.
    """

    def _check() -> bool:
        with conn.database.snapshot() as snap:
            # Tables present?
            rows = list(snap.execute_sql(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
                "WHERE table_name IN ('SynodicNodes', 'SynodicEdges')"
            ))
            if not rows or int(rows[0][0]) < 2:
                return False
            # Property graph present?
            try:
                rows = list(snap.execute_sql(
                    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS "
                    "WHERE property_graph_name = @g",
                    params={"g": graph_name},
                    param_types=None,
                ))
                return bool(rows and int(rows[0][0]) > 0)
            except Exception:
                # Older emulator builds may not expose PROPERTY_GRAPHS
                # before any have been created. Treat absence as "needs
                # bootstrap" so the CREATE OR REPLACE statement runs.
                return False

    return bool(await conn.run_in_executor(_check, timeout=10.0))


async def bootstrap(conn: SpannerConnection, graph_name: str) -> None:
    """Create the managed schema if missing. Idempotent."""
    if not graph_name:
        raise ProviderConfigurationError(
            "spanner_graph: property_graph_name is required to bootstrap schema."
        )
    if await schema_exists(conn, graph_name):
        return
    logger.info(
        "spanner_graph: bootstrapping managed schema graph=%s on database=%s/%s",
        graph_name, conn.instance_id, conn.database_id,
    )
    await run_ddl(conn, managed_schema_ddl(graph_name), label="bootstrap_managed_schema")


async def ensure_aggregation_tables(conn: SpannerConnection, graph_name: str) -> None:
    """Idempotent DDL for the aggregation sidecar."""
    await run_ddl(conn, aggregation_sidecar_ddl(graph_name), label="ensure_aggregation_sidecar")


# ----------------------------------------------------------------------
# Introspection
# ----------------------------------------------------------------------


async def list_property_graphs(conn: SpannerConnection) -> List[str]:
    """Return every property graph name on the connected database."""

    def _q() -> List[str]:
        with conn.database.snapshot() as snap:
            rs = snap.execute_sql(
                "SELECT property_graph_name FROM INFORMATION_SCHEMA.PROPERTY_GRAPHS"
            )
            return [str(r[0]) for r in rs if r and r[0]]

    try:
        return await conn.run_in_executor(_q, timeout=5.0)
    except Exception as exc:  # noqa: BLE001
        logger.info("spanner_graph: list_property_graphs failed: %s", exc)
        return []


async def list_databases(conn: SpannerConnection) -> List[str]:
    """List database IDs on the connected instance."""

    def _q() -> List[str]:
        return [db.database_id for db in conn.instance.list_databases()]

    try:
        return await conn.run_in_executor(_q, timeout=5.0)
    except Exception as exc:  # noqa: BLE001
        logger.info("spanner_graph: list_databases failed: %s", exc)
        return [conn.database_id] if conn.database_id else []


async def detect_dialect(conn: SpannerConnection) -> str:
    """Return the database dialect (GoogleSQL / PostgreSQL).

    Spanner Graph requires GoogleSQL — preflight uses this to fail fast
    on a misconfigured database.
    """

    def _q() -> str:
        with conn.database.snapshot() as snap:
            try:
                rows = list(snap.execute_sql(
                    "SELECT option_value FROM INFORMATION_SCHEMA.DATABASE_OPTIONS "
                    "WHERE option_name = 'database_dialect'"
                ))
            except Exception:
                return "GOOGLE_STANDARD_SQL"
            if rows and rows[0][0]:
                return str(rows[0][0])
            return "GOOGLE_STANDARD_SQL"

    try:
        return await conn.run_in_executor(_q, timeout=3.0)
    except Exception:  # noqa: BLE001
        return "GOOGLE_STANDARD_SQL"


async def discover_property_graph(
    conn: SpannerConnection, graph_name: str
) -> Dict[str, Any]:
    """Return labels / relationship types / property keys for a graph.

    Output shape mirrors the Neo4j adapter so the UI's schema-mapping
    wizard works unchanged.
    """

    def _node_labels() -> List[str]:
        with conn.database.snapshot() as snap:
            rs = snap.execute_sql(
                "SELECT DISTINCT label_name FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_NODE_LABELS "
                "WHERE property_graph_name = @g",
                params={"g": graph_name},
                param_types=None,
            )
            return sorted({str(r[0]) for r in rs if r and r[0]})

    def _edge_labels() -> List[str]:
        with conn.database.snapshot() as snap:
            rs = snap.execute_sql(
                "SELECT DISTINCT label_name FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_EDGE_LABELS "
                "WHERE property_graph_name = @g",
                params={"g": graph_name},
                param_types=None,
            )
            return sorted({str(r[0]) for r in rs if r and r[0]})

    def _props() -> List[Tuple[str, str, str]]:
        with conn.database.snapshot() as snap:
            try:
                rs = snap.execute_sql(
                    "SELECT label_name, property_name, property_data_type "
                    "FROM INFORMATION_SCHEMA.PROPERTY_GRAPH_PROPERTY_DEFINITIONS "
                    "WHERE property_graph_name = @g",
                    params={"g": graph_name},
                    param_types=None,
                )
                return [(str(r[0]), str(r[1]), str(r[2])) for r in rs if r and r[0]]
            except Exception:
                return []

    try:
        labels = await conn.run_in_executor(_node_labels, timeout=5.0)
        rels = await conn.run_in_executor(_edge_labels, timeout=5.0)
        prop_rows = await conn.run_in_executor(_props, timeout=5.0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("spanner_graph: discover_property_graph failed: %s", exc)
        return {}

    label_details: Dict[str, Dict[str, Any]] = {}
    for lbl, pname, ptype in prop_rows:
        entry = label_details.setdefault(lbl, {"properties": {}, "count": 0, "sample": {}})
        entry["properties"][pname] = ptype

    return {
        "labels": labels,
        "relationshipTypes": rels,
        "labelDetails": label_details,
        "suggestedMapping": _suggest_mapping({p for det in label_details.values() for p in det["properties"]}),
    }


def _suggest_mapping(props: set) -> Dict[str, str]:
    lc = {p.lower(): p for p in props}

    def pick(*candidates: str) -> Optional[str]:
        for cand in candidates:
            if cand in lc:
                return lc[cand]
        return None

    return {
        "identity_field": pick("urn", "uuid", "id", "guid") or "urn",
        "display_name_field": pick("displayname", "display_name", "name", "title", "label") or "displayName",
        "qualified_name_field": pick("qualifiedname", "qualified_name", "fullname", "full_name", "path") or "qualifiedName",
        "description_field": pick("description", "summary", "comment") or "description",
        "tags_field": pick("tags", "labels_list", "categories") or "tags",
        "entity_type_strategy": "label",
        "entity_type_field": "entityType",
    }
