#!/usr/bin/env python3
"""
Add realistic column-level lineage between schemaField nodes.

Creates PRODUCES/TRANSFORMS edges following data pipeline patterns:
- raw -> staging -> analytics/mart (within same domain)
- Same table name across layers (e.g. invoice_0 in staging -> invoice_0 in analytics)
- Semantic column matching: id->id, timestamp->timestamp, amount->amount, etc.
- Type casts and transform expressions in edge properties

Usage:
  python -m backend.scripts.add_column_lineage [--input path.json] [--output path.json] [--max-edges N] [--push-falkordb]

Env: FALKORDB_HOST, FALKORDB_PORT, FALKORDB_GRAPH_NAME for --push-falkordb
"""

import argparse
import json
import os
import random
import re
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Tuple, Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphNode, GraphEdge


# Layer ordering for lineage direction (upstream -> downstream)
LAYER_ORDER = ["raw", "staging", "core", "analytics", "mart", "report"]
LAYER_PATTERNS = {
    "raw": ["raw", "ingest", "landing"],
    "staging": ["staging", "stg", "temp"],
    "core": ["core", "curated", "base"],
    "analytics": ["analytics", "dwh", "warehouse"],
    "mart": ["mart", "dm", "datamart"],
    "report": ["report", "bi", "dashboard"],
}


def _infer_layer(schema_name: str) -> str:
    """Infer data layer from schema/container name."""
    name = schema_name.lower()
    for layer, patterns in LAYER_PATTERNS.items():
        if any(p in name for p in patterns):
            return layer
    return "unknown"


def _parse_schema_field_urn(urn: str) -> Tuple[str, str, str]:
    """
    Parse urn:li:schemaField:platform.domain.schema.asset.column
    Returns (platform_domain_schema, asset_name, column_name)
    """
    if "schemaField:" not in urn:
        return "", "", ""
    path = urn.split("schemaField:")[-1]
    parts = path.split(".")
    if len(parts) < 5:
        return "", "", ""
    # platform.domain.schema.asset.column
    schema_path = ".".join(parts[:3])  # e.g. mysql.finance.staging_0
    asset = parts[3]  # e.g. invoice_0
    column = parts[4]  # e.g. id, col_5
    return schema_path, asset, column


def _match_columns_for_lineage(
    source_col: GraphNode,
    target_col: GraphNode,
) -> Tuple[bool, float, str]:
    """
    Determine if two columns have realistic lineage and return (match, confidence, transform).
    """
    source_name = source_col.display_name.lower()
    target_name = target_col.display_name.lower()
    source_type = str(source_col.properties.get("dataType", ""))
    target_type = str(target_col.properties.get("dataType", ""))

    # Exact name match
    if source_name == target_name:
        if source_type == target_type:
            return True, 0.95, "direct_copy"
        return True, 0.85, f"type_cast({source_type} -> {target_type})"

    # ID columns (id, *_id, *_pk)
    id_pattern = lambda n: "id" in n or n.endswith("_id") or "pk" in n
    if id_pattern(source_name) and id_pattern(target_name):
        if source_type == target_type:
            return True, 0.82, "direct_copy"
        return True, 0.72, f"type_cast({source_type} -> {target_type})"

    # Timestamp / date columns
    time_terms = ["timestamp", "date", "created_at", "updated_at", "time", "at"]
    if any(t in source_name for t in time_terms) and any(t in target_name for t in time_terms):
        if source_type == target_type:
            return True, 0.78, "direct_copy"
        return True, 0.68, f"type_cast({source_type} -> {target_type})"

    # Amount / revenue / metric columns
    metric_terms = ["amount", "revenue", "price", "cost", "value", "total", "sum", "qty", "quantity"]
    if any(t in source_name for t in metric_terms) and any(t in target_name for t in metric_terms):
        if source_name == target_name or source_type == target_type:
            return True, 0.80, "direct_copy"
        # Aggregation: amount -> total_amount
        if "total" in target_name or "sum" in target_name:
            return True, 0.75, "sum(aggregation)"
        return True, 0.70, f"type_cast({source_type} -> {target_type})"

    # Status / enum
    if "status" in source_name and "status" in target_name:
        return True, 0.72, "direct_copy" if source_type == target_type else f"type_cast({source_type} -> {target_type})"

    # Generic col_N -> col_N (same index)
    if source_name.startswith("col_") and target_name.startswith("col_"):
        try:
            if source_name == target_name:
                return True, 0.70, "direct_copy"
            si = int(source_name.replace("col_", ""))
            ti = int(target_name.replace("col_", ""))
            if si == ti:
                return True, 0.68, "direct_copy"
        except ValueError:
            pass

    return False, 0.0, ""


def build_column_lineage(
    nodes: List[Dict],
    max_edges: int = 50000,
    density: float = 0.25,
) -> List[Dict]:
    """
    Build realistic column lineage edges from nodes.
    Returns list of edge dicts (compatible with GraphEdge).
    """
    # Collect schemaField nodes and parse paths
    schema_fields: List[GraphNode] = []
    for n in nodes:
        if n.get("entityType") == "schemaField":
            schema_fields.append(GraphNode(**n))

    if len(schema_fields) < 2:
        return []

    # Group by (domain, schema_layer, asset_name) for cross-schema lineage
    # Format: domain.schema -> [(layer, asset, col_node), ...]
    by_schema_asset: Dict[str, List[Tuple[str, str, GraphNode]]] = defaultdict(list)
    schema_layer_map: Dict[str, str] = {}

    for col in schema_fields:
        schema_path, asset, col_name = _parse_schema_field_urn(col.urn)
        if not schema_path or not asset:
            continue
        # Extract domain from path (e.g. mysql.finance.staging_0 -> finance)
        parts = schema_path.split(".")
        domain = parts[1] if len(parts) >= 2 else "default"
        schema_name = parts[2] if len(parts) >= 3 else schema_path
        layer = _infer_layer(schema_name)
        schema_layer_map[schema_path] = layer
        key = f"{domain}:{schema_path}"
        by_schema_asset[key].append((layer, asset, col))

    edges: List[Dict] = []
    edge_ids: set = set()

    # Build lineage: for each domain, connect columns across schemas
    domains_seen: Dict[str, List[str]] = defaultdict(list)
    for key in by_schema_asset:
        domain = key.split(":")[0]
        schema_path = key.split(":", 1)[1]
        domains_seen[domain].append(schema_path)

    for domain, schema_paths in domains_seen.items():
        if len(schema_paths) < 2:
            continue

        # Sort schemas by layer order (raw first, mart last)
        def layer_sort(sp: str) -> int:
            layer = schema_layer_map.get(sp, "unknown")
            return LAYER_ORDER.index(layer) if layer in LAYER_ORDER else 99

        sorted_schemas = sorted(schema_paths, key=layer_sort)

        # Create lineage: upstream -> downstream (raw->staging->analytics)
        for i, source_schema in enumerate(sorted_schemas):
            for target_schema in sorted_schemas[i + 1 :]:
                source_layer = schema_layer_map.get(source_schema, "")
                target_layer = schema_layer_map.get(target_schema, "")
                if source_layer == target_layer:
                    continue

                skey = f"{domain}:{source_schema}"
                tkey = f"{domain}:{target_schema}"
                source_cols = by_schema_asset.get(skey, [])
                target_cols = by_schema_asset.get(tkey, [])

                # Match by same asset name first (staging.invoice_0 -> analytics.invoice_0)
                assets_source = defaultdict(list)
                assets_target = defaultdict(list)
                for layer, asset, col in source_cols:
                    assets_source[asset].append(col)
                for layer, asset, col in target_cols:
                    assets_target[asset].append(col)

                for asset_name, s_cols in assets_source.items():
                    t_cols = assets_target.get(asset_name, [])
                    if not t_cols:
                        continue

                    for source_col in s_cols:
                        if len(edges) >= max_edges:
                            break
                        if density < 1.0 and random.random() > density:
                            continue
                        for target_col in t_cols:
                            is_match, confidence, transform = _match_columns_for_lineage(
                                source_col, target_col
                            )
                            if is_match:
                                edge_id = f"col-lineage-{source_col.urn}|{target_col.urn}"
                                if edge_id not in edge_ids:
                                    edge_ids.add(edge_id)
                                    # Use TRANSFORMS when there's an actual transform, else PRODUCES
                                    edge_type = "TRANSFORMS" if transform and transform not in ("direct_copy", "key_mapping") else "PRODUCES"
                                    edges.append({
                                        "id": edge_id.replace("|", "-")[:200],
                                        "sourceUrn": source_col.urn,
                                        "targetUrn": target_col.urn,
                                        "edgeType": edge_type,
                                        "confidence": confidence,
                                        "properties": {
                                            "transformExpression": transform,
                                            "lineageType": "column",
                                            "sourceLayer": source_layer,
                                            "targetLayer": target_layer,
                                            "description": f"Column lineage {source_layer} -> {target_layer}",
                                        },
                                    })
                                break

    return edges


def main():
    parser = argparse.ArgumentParser(description="Add realistic column lineage to graph")
    parser.add_argument(
        "--input",
        default=os.path.join(os.path.dirname(__file__), "..", "data", "demo_graph_with_lineage.json"),
        help="Input JSON file with nodes and edges",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output JSON file (default: overwrite input)",
    )
    parser.add_argument("--max-edges", type=int, default=50000, help="Max new lineage edges to add")
    parser.add_argument("--density", type=float, default=1.0, help="Fraction of column pairs to connect (0-1, default: all matches)")
    parser.add_argument(
        "--push-falkordb",
        action="store_true",
        help="Push new edges to FalkorDB (requires running FalkorDB)",
    )
    args = parser.parse_args()

    input_path = args.input
    output_path = args.output or input_path

    if not os.path.exists(input_path):
        print(f"Input file not found: {input_path}")
        sys.exit(1)

    print(f"Loading from {input_path}")
    with open(input_path) as f:
        data = json.load(f)

    nodes = data.get("nodes", [])
    existing_edges = data.get("edges", [])

    # Build new column lineage
    new_edges = build_column_lineage(
        nodes,
        max_edges=args.max_edges,
        density=args.density,
    )
    print(f"Generated {len(new_edges)} new column lineage edges")

    def is_column_lineage(e: dict) -> bool:
        return (
            e.get("edgeType") in ("PRODUCES", "CONSUMES", "TRANSFORMS")
            and "schemaField" in str(e.get("sourceUrn", "") + e.get("targetUrn", ""))
        )

    # Replace column lineage: keep non-lineage edges, add our new lineage
    other_edges = [e for e in existing_edges if not is_column_lineage(e)]
    final_edges = other_edges + new_edges

    data["edges"] = final_edges
    print(f"Total edges: {len(final_edges)} (was {len(existing_edges)})")

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"Saved to {output_path}")

    if args.push_falkordb:
        print("Pushing to FalkorDB...")
        try:
            from backend.app.providers.falkordb_provider import FalkorDBProvider

            provider = FalkorDBProvider(
                host=os.getenv("FALKORDB_HOST", "localhost"),
                port=int(os.getenv("FALKORDB_PORT", "6379")),
                graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
            )
            import asyncio
            asyncio.run(provider._ensure_connected())
            edge_models = [GraphEdge(**e) for e in new_edges]
            asyncio.run(provider.save_custom_graph([], edge_models))
            print(f"Pushed {len(edge_models)} edges to FalkorDB")
        except Exception as e:
            print(f"FalkorDB push failed: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
