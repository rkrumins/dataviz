#!/usr/bin/env python3
"""
Synthetic Graph Data Generator & Seeder for FalkorDB.

Rewritten to ensure:
1. Strict containment hierarchy:
   Domain -> DataPlatform -> Container (Database) -> Dataset (Table) -> SchemaField (Column)
2. Excessive scale (capable of millions of nodes).
3. Realistic lineage (TRANSFORMS edges between columns).
4. Efficient batch processing for FalkorDB.
"""

import argparse
import asyncio
import logging
import os
import random
import sys
import time
import uuid
from typing import List, Dict, Tuple

# Add project root for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphNode, GraphEdge, EntityType, EdgeType
# from backend.app.providers.falkordb_provider import FalkorDBProvider # Import loop risk if not careful, imported inside function

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ==========================================
# Constants & Config
# ==========================================

DOMAINS = ["Finance", "Marketing", "Sales", "HR", "Engineering", "Product", "Operations", "Legal"]
PLATFORMS = ["Snowflake", "Databricks", "Postgres", "S3", "Kafka", "Salesforce", "Tableau"]
ENVIRONMENTS = ["prod", "dev", "staging"]
DATA_TYPES = ["string", "int", "boolean", "float", "timestamp", "array", "struct"]

BATCH_SIZE = 5000  # Nodes/Edges per batch to FalkorDB


class SyntheticDataGenerator:
    def __init__(self, scale_factor: int = 1, density: float = 0.05):
        """
        :param scale_factor: Multiplier for data volume (1 = ~10k nodes, 100 = ~1m nodes)
        :param density: Probability of lineage connection
        """
        self.scale = scale_factor
        self.density = density
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        
        # Track counts
        self.counts = {
            "domain": 0,
            "platform": 0,
            "container": 0,
            "dataset": 0,
            "field": 0,
            "edges": 0
        }

        # Keep track of URNs for lineage generation
        self.field_urns: List[str] = []

    def _create_node(self, entity_type: EntityType, name: str, parent_urn: str = None, props: Dict = None) -> GraphNode:
        urn = f"urn:li:{entity_type.value}:{name}"
        props = props or {}
        
        node = GraphNode(
            urn=urn,
            entityType=entity_type,
            displayName=name,
            qualifiedName=name,
            properties=props,
            tags=[]
        )
        self.nodes.append(node)
        self.counts[entity_type.value if hasattr(entity_type, "value") else str(entity_type)] = \
            self.counts.get(entity_type.value if hasattr(entity_type, "value") else str(entity_type), 0) + 1
        
        if parent_urn:
            # Create CONTAINS edge from Parent -> Child
            edge_id = f"contains-{parent_urn}-{urn}"
            edge = GraphEdge(
                id=edge_id,
                sourceUrn=parent_urn,
                targetUrn=urn,
                edgeType=EdgeType.CONTAINS,
                properties={}
            )
            self.edges.append(edge)
            self.counts["edges"] += 1
            
        return node

    def generate(self):
        logger.info(f"Starting generation with scale factor {self.scale}...")
        start_time = time.time()

        # 1. Domains
        # Fixed set of top-level domains
        domain_urns = []
        for d in DOMAINS:
            node = self._create_node(EntityType.DOMAIN, d)
            domain_urns.append(node.urn)
            
        # 2. Platforms (per domain)
        # Each domain has a few platforms
        platform_urns = []
        for d_urn in domain_urns:
            # 1-3 platforms per domain
            num_platforms = random.randint(1, 3)
            for i in range(num_platforms):
                p_name = f"{d_urn.split(':')[-1]}-{random.choice(PLATFORMS)}-{i}"
                node = self._create_node(EntityType.DATA_PLATFORM, p_name, parent_urn=d_urn)
                platform_urns.append(node.urn)

        # 3. Containers (Databases) per Platform
        container_urns = []
        for p_urn in platform_urns:
            # Scale affects number of containers
            num_containers = random.randint(2, 5 * self.scale)
            for i in range(num_containers):
                c_name = f"{p_urn.split(':')[-1]}-db-{i}"
                node = self._create_node(EntityType.CONTAINER, c_name, parent_urn=p_urn)
                container_urns.append(node.urn)

        # 4. Datasets (Tables) per Container
        dataset_urns = []
        for c_urn in container_urns:
            num_tables = random.randint(5, 20) # Keeping tables per DB reasonable, scale comes from DBs
            for i in range(num_tables):
                t_name = f"{c_urn.split(':')[-1]}-table-{i}"
                node = self._create_node(EntityType.DATASET, t_name, parent_urn=c_urn)
                dataset_urns.append(node.urn)

        # 5. Schema Fields (Columns) per Dataset
        for t_urn in dataset_urns:
            num_cols = random.randint(5, 30)
            for i in range(num_cols):
                col_name = f"{t_urn.split(':')[-1]}-col-{i}"
                props = {"dataType": random.choice(DATA_TYPES)}
                node = self._create_node(EntityType.SCHEMA_FIELD, col_name, parent_urn=t_urn, props=props)
                self.field_urns.append(node.urn)

        # 6. Random Lineage (TRANSFORMS)
        # Randomly connect columns
        logger.info(f"Generated {len(self.field_urns)} columns. Generating lineage...")
        
        num_lineage_edges = int(len(self.field_urns) * self.density * self.scale)
        logger.info(f"Targeting ~{num_lineage_edges} lineage edges...")

        for _ in range(num_lineage_edges):
            src = random.choice(self.field_urns)
            tgt = random.choice(self.field_urns)
            
            if src == tgt: continue
            
            # Simple DAG-ish check: avoid obvious cycles if we want? 
            # For pure scale test, cycles are fine, but let's try to flow Left->Right based on list index
            # (Assuming list is somewhat ordered by creation, which mimics flow)
            idx_src = self.field_urns.index(src)
            idx_tgt = self.field_urns.index(tgt)
            
            if idx_src < idx_tgt:
                edge_id = f"transforms-{src}-{tgt}"
                edge = GraphEdge(
                    id=edge_id,
                    sourceUrn=src,
                    targetUrn=tgt,
                    edgeType=EdgeType.TRANSFORMS,
                    properties={"logic": "random_transform"}
                )
                self.edges.append(edge)
                self.counts["edges"] += 1

        duration = time.time() - start_time
        logger.info(f"Generation complete in {duration:.2f}s")
        logger.info(f"Stats: {self.counts}")


async def seed_falkordb(generator: SyntheticDataGenerator):
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus"),
    )
    
    await provider._ensure_connected()
    
    # Batch chunks
    total_nodes = len(generator.nodes)
    total_edges = len(generator.edges)
    
    logger.info(f"Pushing {total_nodes} nodes and {total_edges} edges to FalkorDB in batches of {BATCH_SIZE}...")
    
    # Push nodes
    for i in range(0, total_nodes, BATCH_SIZE):
        batch = generator.nodes[i : i + BATCH_SIZE]
        try:
            # We use save_custom_graph which handles both, but splitting them is fine 
            # actually save_custom_graph does efficient UNWIND
            await provider.save_custom_graph(batch, [])
            if i % (BATCH_SIZE * 5) == 0:
                logger.info(f"Pushed {i}/{total_nodes} nodes...")
        except Exception as e:
            logger.error(f"Failed to push node batch {i}: {e}")

    # Push edges
    for i in range(0, total_edges, BATCH_SIZE):
        batch = generator.edges[i : i + BATCH_SIZE]
        try:
            await provider.save_custom_graph([], batch)
            if i % (BATCH_SIZE * 5) == 0:
                logger.info(f"Pushed {i}/{total_edges} edges...")
        except Exception as e:
            logger.error(f"Failed to push edge batch {i}: {e}")

    logger.info("Seeding complete!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed FalkorDB with massive synthetic data")
    parser.add_argument("--scale", type=int, default=1, help="Scale factor (1 = ~10k nodes)")
    parser.add_argument("--density", type=float, default=0.05, help="Lineage density")
    
    args = parser.parse_args()
    
    gen = SyntheticDataGenerator(scale_factor=args.scale, density=args.density)
    gen.generate()
    
    try:
        asyncio.run(seed_falkordb(gen))
    except KeyboardInterrupt:
        logger.warn("Seeding interrupted.")
    except Exception as e:
        logger.error(f"Seeding failed: {e}")
        sys.exit(1)
