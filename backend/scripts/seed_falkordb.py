#!/usr/bin/env python3
"""
Seed FalkorDB with graph data from a JSON file.
Run once before using the FalkorDB provider.

Usage:
  python -m backend.scripts.seed_falkordb [path_to_graph.json]
  
  Default path: backend/data/demo_graph_with_lineage.json
  Or set FALKORDB_SEED_FILE env var.

Env vars:
  FALKORDB_HOST      - FalkorDB host (default: localhost)
  FALKORDB_PORT      - FalkorDB port (default: 6379)
  FALKORDB_GRAPH_NAME - Graph name (default: nexus)
  FALKORDB_SEED_FILE - JSON file path (overrides CLI arg)
  SEED_MAX_NODES    - Max nodes to load (default: 10000, use 0 for no limit)
  SEED_MAX_EDGES    - Max edges to load (default: 50000, use 0 for no limit)
"""

import argparse
import asyncio
import json
import os
import sys

# Add project root for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphNode, GraphEdge
from backend.app.providers.falkordb_provider import FalkorDBProvider


async def main():
    parser = argparse.ArgumentParser(description="Seed FalkorDB with graph data")
    parser.add_argument(
        "input_file",
        nargs="?",
        default=None,
        help="Path to JSON file with nodes and edges",
    )
    parser.add_argument("--max-nodes", type=int, default=None, help="Max nodes (0=no limit)")
    parser.add_argument("--max-edges", type=int, default=None, help="Max edges (0=no limit)")
    args = parser.parse_args()

    path = (
        os.getenv("FALKORDB_SEED_FILE")
        or args.input_file
        or os.path.join(os.path.dirname(__file__), "..", "data", "demo_graph_with_lineage.json")
    )

    max_nodes = args.max_nodes if args.max_nodes is not None else int(os.getenv("SEED_MAX_NODES", "10000"))
    max_edges = args.max_edges if args.max_edges is not None else int(os.getenv("SEED_MAX_EDGES", "50000"))

    if not os.path.exists(path):
        print(f"File not found: {path}")
        sys.exit(1)

    print(f"Loading from {path} (max nodes={max_nodes or 'all'}, max edges={max_edges or 'all'})")
    with open(path, "r") as f:
        data = json.load(f)

    nodes = [GraphNode(**n) for n in data.get("nodes", [])]
    edges = [GraphEdge(**e) for e in data.get("edges", [])]
    print(f"Parsed {len(nodes)} nodes and {len(edges)} edges")

    if max_nodes and len(nodes) > max_nodes:
        nodes = nodes[:max_nodes]
        print(f"Truncated to {len(nodes)} nodes")
    if max_edges and len(edges) > max_edges:
        edges = edges[:max_edges]
        print(f"Truncated to {len(edges)} edges")

    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )

    print("Connecting to FalkorDB and seeding...")
    await provider._ensure_connected()
    success = await provider.save_custom_graph(nodes, edges)
    if success:
        print("Seed completed successfully.")
    else:
        print("Seed may have partially failed - check logs.")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
