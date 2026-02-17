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


SCENARIOS = {
    "finance": {
        "domain": "Finance",
        "sources": [
            {"platform": "SAP ERP", "container": "ECC_PROD", "datasets": ["VBAP_Sales", "BKPF_Accounting", "MARA_Materials"]},
            {"platform": "NetSuite", "container": "NS_ANALYTICS", "datasets": ["Transactions", "Customers", "Vendors"]}
        ],
        "consumption": ["CFO Dashboard", "Monthly Variance Report", "Tax Audit Log"]
    },
    "hr": {
        "domain": "Human Resources",
        "sources": [
            {"platform": "Workday", "container": "WD_PROD", "datasets": ["Workers", "Compensation", "Org_Hierarchy"]},
            {"platform": "Greenhouse", "container": "GH_RECROOT", "datasets": ["Applications", "Requisitions"]}
        ],
        "consumption": ["Headcount Overview", "Recruitment Funnel", "Attrition Predictor"]
    },
    "marketing": {
        "domain": "Marketing",
        "sources": [
            {"platform": "Google Ads", "container": "AD_WORDS_LOGS", "datasets": ["Campaigns", "Keywords", "Clicks"]},
            {"platform": "HubSpot", "container": "HS_CRM", "datasets": ["Contacts", "Leads", "Deals"]}
        ],
        "consumption": ["Marketing ROI", "Lead Attribution", "Campaign Performance"]
    },
    "ecommerce": {
        "domain": "eCommerce",
        "sources": [
            {"platform": "Shopify", "container": "SHOPIFY_STORE", "datasets": ["Orders", "Products", "Collections"]},
            {"platform": "Stripe", "container": "STRIPE_PAYMENTS", "datasets": ["Charges", "Payouts", "Refunds"]}
        ],
        "consumption": ["Sales Dashboard", "Inventory Health", "Payment Reconciliation"]
    }
}

class EnterpriseDataGenerator:
    def __init__(self, scenarios: List[str] = ["finance"], scale: int = 1, breadth: int = 1, depth: int = 1):
        """
        :param scenarios: List of scenario keys to generate
        :param scale: Overall multiplier for number of nodes
        :param breadth: Multiplier for parallel systems within a scenario
        :param depth: Multiplier for transformation layers
        """
        self.scenarios = scenarios
        self.scale = scale
        self.breadth = breadth
        self.depth = depth
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []

    def _create_node(self, entity_type: EntityType, name: str, parent_urn: str = None, props: Dict = None) -> GraphNode:
        urn = f"urn:li:{entity_type.value}:{name.lower().replace(' ', '_')}_{uuid.uuid4().hex[:8]}"
        node = GraphNode(
            urn=urn,
            entityType=entity_type,
            displayName=name,
            qualifiedName=name,
            properties=props or {},
            tags=[]
        )
        self.nodes.append(node)
        
        if parent_urn:
            edge = GraphEdge(
                id=f"contains-{parent_urn}-{urn}",
                sourceUrn=parent_urn,
                targetUrn=urn,
                edgeType=EdgeType.CONTAINS,
                properties={}
            )
            self.edges.append(edge)
        return node

    def _create_lineage(self, source_urn: str, target_urn: str, logic: str = "Transformation"):
        edge = GraphEdge(
            id=f"transforms-{source_urn}-{target_urn}",
            sourceUrn=source_urn,
            targetUrn=target_urn,
            edgeType=EdgeType.TRANSFORMS,
            properties={"logic": logic}
        )
        self.edges.append(edge)

    def generate(self):
        logger.info(f"Generating scenarios: {self.scenarios} (B:{self.breadth}, D:{self.depth}, S:{self.scale})")
        
        # Shared Platforms
        snowflake = self._create_node(EntityType.DATA_PLATFORM, "Snowflake")
        
        for s_key in self.scenarios:
            if s_key not in SCENARIOS: continue
            config = SCENARIOS[s_key]
            domain = self._create_node(EntityType.DOMAIN, config["domain"])
            
            # For each domain, we can have multiple parallel "chains" (Breadth)
            for b_idx in range(self.breadth):
                chain_suffix = f"_{b_idx}" if self.breadth > 1 else ""
                
                # 1. Source Platforms & Containers
                src_fields_layer = [] # Track the latest fields to link forward
                
                for src_cfg in config["sources"]:
                    plat = self._create_node(EntityType.DATA_PLATFORM, f"{src_cfg['platform']}{chain_suffix}", parent_urn=domain.urn)
                    cont = self._create_node(EntityType.CONTAINER, f"{src_cfg['container']}{chain_suffix}", parent_urn=plat.urn)
                    
                    for ds_name in src_cfg["datasets"]:
                        ds = self._create_node(EntityType.DATASET, f"{ds_name}{chain_suffix}", parent_urn=cont.urn)
                        # Add columns
                        cols = []
                        for i in range(5):
                            c = self._create_node(EntityType.SCHEMA_FIELD, f"{ds_name}_col_{i}", parent_urn=ds.urn)
                            cols.append(c)
                        src_fields_layer.extend(cols)

                # 2. Transformation Layers (Depth)
                prev_layer_fields = src_fields_layer
                
                # Intermediate Staging/Integration
                for d_idx in range(self.depth):
                    stg_db = self._create_node(EntityType.CONTAINER, f"STAGING_{s_key.upper()}_{d_idx}{chain_suffix}", parent_urn=snowflake.urn)
                    next_layer_fields = []
                    
                    # Create datasets that consume from previous layer
                    num_datasets = max(1, len(prev_layer_fields) // 10)
                    for ds_idx in range(num_datasets):
                        ds = self._create_node(EntityType.DATASET, f"TRANSFORMED_{s_key.upper()}_{d_idx}_{ds_idx}{chain_suffix}", parent_urn=stg_db.urn)
                        for i in range(5):
                            c = self._create_node(EntityType.SCHEMA_FIELD, f"field_{i}", parent_urn=ds.urn)
                            next_layer_fields.append(c)
                            
                            # Randomly link to a few source fields from previous layer
                            sources = random.sample(prev_layer_fields, min(3, len(prev_layer_fields)))
                            for src in sources:
                                self._create_lineage(src.urn, c.urn, f"dbt Tier {d_idx}")
                    
                    prev_layer_fields = next_layer_fields

                # 3. Consumption Layer
                tableau = self._create_node(EntityType.DATA_PLATFORM, f"Tableau_{s_key}{chain_suffix}", parent_urn=domain.urn)
                for dash_name in config["consumption"]:
                    dash = self._create_node(EntityType.DASHBOARD, f"{dash_name}{chain_suffix}", parent_urn=tableau.urn)
                    chart = self._create_node(EntityType.CHART, f"{dash_name}_Summary_Chart", parent_urn=dash.urn)
                    
                    # Link chart to some final layer fields
                    sample_sources = random.sample(prev_layer_fields, min(5, len(prev_layer_fields)))
                    for src in sample_sources:
                        self._create_lineage(src.urn, chart.urn, "Direct Query")

        # 4. Pure Scale (Total Volume Filler)
        current_node_count = len(self.nodes)
        target_node_count = self.scale * 1000
        if current_node_count < target_node_count:
            logger.info(f"Filling scale gap: {current_node_count} -> {target_node_count}")
            raw_plat = self._create_node(EntityType.DATA_PLATFORM, "Legacy_Archive")
            remaining = target_node_count - current_node_count
            num_containers = (remaining // 100) + 1
            for ci in range(num_containers):
                cont = self._create_node(EntityType.CONTAINER, f"Archive_DB_{ci}", parent_urn=raw_plat.urn)
                for di in range(10):
                    ds = self._create_node(EntityType.DATASET, f"Archive_Table_{ci}_{di}", parent_urn=cont.urn)
                    for fi in range(10):
                        self._create_node(EntityType.SCHEMA_FIELD, f"col_{fi}", parent_urn=ds.urn)

        logger.info(f"Generation complete: {len(self.nodes)} nodes, {len(self.edges)} edges.")


async def seed_falkordb(generator: EnterpriseDataGenerator):
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus_lineage"),
    )
    await provider._ensure_connected()
    
    # Large scale push in chunks to avoid memory issues
    CHUNK = 10000
    total_nodes = len(generator.nodes)
    total_edges = len(generator.edges)
    
    logger.info(f"Pushing {total_nodes} nodes...")
    for i in range(0, total_nodes, CHUNK):
        batch = generator.nodes[i:i+CHUNK]
        await provider.save_custom_graph(batch, [])
        if i % (CHUNK*2) == 0: logger.info(f"  Progress: {i}/{total_nodes}")

    logger.info(f"Pushing {total_edges} edges...")
    for i in range(0, total_edges, CHUNK):
        batch = generator.edges[i:i+CHUNK]
        await provider.save_custom_graph([], batch)
        if i % (CHUNK*2) == 0: logger.info(f"  Progress: {i}/{total_edges}")

    await provider.ensure_indices()
    logger.info("Seeding complete!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scalable Enterprise Seeding")
    parser.add_argument("--scenarios", type=str, default="finance", help="Comma-separated scenarios (finance, hr, marketing, ecommerce, all)")
    parser.add_argument("--scale", type=int, default=1, help="Scale factor (1 = ~1k nodes)")
    parser.add_argument("--breadth", type=int, default=1, help="Parallel system factor")
    parser.add_argument("--depth", type=int, default=1, help="Transformation depth")
    
    args = parser.parse_args()
    
    scenario_list = args.scenarios.split(",")
    if "all" in scenario_list:
        scenario_list = list(SCENARIOS.keys())
    
    gen = EnterpriseDataGenerator(scenarios=scenario_list, scale=args.scale, breadth=args.breadth, depth=args.depth)
    gen.generate()
    
    try:
        asyncio.run(seed_falkordb(gen))
    except KeyboardInterrupt:
        logger.warning("Interrupted.")
    except Exception as e:
        logger.error(f"Failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
