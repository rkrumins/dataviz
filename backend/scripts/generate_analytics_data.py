#!/usr/bin/env python3
"""
Generic Analytics Data Generator for FalkorDB.
Generates Raw, Curated, Aggregated, and Dashboard layers with realistic lineage.
"""

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import uuid
from typing import List, Dict, Optional, Tuple, Any
from dataclasses import dataclass, field

# Add project root for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphNode, GraphEdge, EntityType, EdgeType
from backend.app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ==========================================
# Configuration Defaults
# ==========================================

FLOW_SECTIONS = ["raw", "curated", "aggregated", "reporting"]

DEFAULT_BREAKDOWN = {
    "raw": 0.4,       # 40% of nodes
    "curated": 0.3,   # 30% of nodes
    "aggregated": 0.2, # 20% of nodes
    "reporting": 0.1  # 10% of nodes
}

# ==========================================
# Constants & Scenarios for Realism
# ==========================================

SOURCE_SYSTEMS = [
    {"name": "Salesforce CRM", "type": "SaaS", "dbs": ["CRM_PROD", "SALES_OPPS"]},
    {"name": "SAP ERP", "type": "ERP", "dbs": ["ECC_GLOBAL", "FINANCE_PROD"]},
    {"name": "Shopify Store", "type": "eCommerce", "dbs": ["STOREFRONT_V3", "PAYMENTS_GATEWAY"]},
    {"name": "Zendesk Support", "type": "SaaS", "dbs": ["SUPPORT_TICKETS"]}
]

SCHEMA_TEMPLATES = {
    "customers": ["customer_id", "email", "full_name", "signup_date", "segment", "country"],
    "transactions": ["tx_id", "order_id", "amount", "currency", "timestamp", "status"],
    "products": ["product_id", "name", "category", "base_price", "sku"],
    "tickets": ["ticket_id", "user_id", "subject", "priority", "created_at"]
}

# ==========================================
# Generator Class
# ==========================================

class AnalyticsDataGenerator:
    def __init__(self, 
                 total_nodes: int = 1000, 
                 edge_ratio: float = 1.8, 
                 breakdown: Dict[str, float] = None):
        self.total_nodes = total_nodes
        self.edge_ratio = edge_ratio
        self.breakdown = breakdown or DEFAULT_BREAKDOWN
        
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        
        # Track items by flow and type for lineage creation
        self.assets_by_flow: Dict[str, Dict[str, List[str]]] = {
            flow: {"datasets": [], "columns": [], "dashboards": [], "charts": []} 
            for flow in FLOW_SECTIONS
        }
        
        self.urn_to_node: Dict[str, GraphNode] = {}
        self.children_by_urn: Dict[str, List[str]] = {}
        self.node_count = 0
        self.edge_count = 0

    def _get_urn(self, entity_type: EntityType, name: str, flow: str) -> str:
        # Technical URN with meaningful parts
        h = uuid.uuid4().hex[:6]
        return f"urn:li:{entity_type.value}:{flow}:{name.lower().replace(' ', '_')}_{h}"

    def add_node(self, 
                 entity_type: EntityType, 
                 name: str, 
                 flow: str, 
                 parent_urn: str = None, 
                 props: Dict = None) -> str:
        urn = self._get_urn(entity_type, name, flow)
        
        # Use the provided name as the display name (readable)
        display_name = name
        
        # Build hierarchical qualified name using readable display names
        if parent_urn and parent_urn in self.urn_to_node:
            p_node = self.urn_to_node[parent_urn]
            q_name = f"{p_node.qualified_name}.{display_name}".replace(" ", "_").lower()
        else:
            q_name = f"{flow}.{display_name}".replace(" ", "_").lower()

        node = GraphNode(
            urn=urn,
            entityType=entity_type,
            displayName=display_name,
            qualifiedName=q_name,
            properties=props or {},
            tags=[flow]
        )
        self.nodes.append(node)
        self.urn_to_node[urn] = node
        self.node_count += 1
        
        if parent_urn:
            self.add_edge(parent_urn, urn, EdgeType.CONTAINS, flow)
            if parent_urn not in self.children_by_urn:
                self.children_by_urn[parent_urn] = []
            self.children_by_urn[parent_urn].append(urn)
        
        return urn

    def add_edge(self, source: str, target: str, edge_type: EdgeType, flow: str, props: Dict = None):
        edge_id = f"{edge_type.value.lower()}-{source}-{target}-{uuid.uuid4().hex[:4]}"
        edge = GraphEdge(
            id=edge_id,
            sourceUrn=source,
            targetUrn=target,
            edgeType=edge_type,
            properties=props or {}
        )
        self.edges.append(edge)
        self.edge_count += 1

    def generate(self):
        logger.info(f"Starting ontology-aligned generation: Target Nodes={self.total_nodes}, Edge Ratio={self.edge_ratio}")
        
        # Calculate node targets per flow
        targets = {flow: int(self.total_nodes * weight) for flow, weight in self.breakdown.items()}
        
        # 1. Generate RAW Layer (Physical Sources)
        self._generate_raw(targets["raw"])
        
        # 2. Generate CURATED Layer (Cleansing & Joins)
        self._generate_curated(targets["curated"])
        
        # 3. Generate AGGREGATED Layer (Data Products)
        self._generate_aggregated(targets["aggregated"])
        
        # 4. Generate REPORTING Layer (Reporting & Metrics)
        self._generate_reporting(targets["reporting"])
        
        # 5. Add random cross-flow lineage to meet edge ratio if needed
        self._top_up_edges()
        
        logger.info(f"Generation complete: {len(self.nodes)} nodes, {len(self.edges)} edges")

    def _generate_raw(self, target: int):
        logger.info(f"Generating RAW layer (Multiple Operational Sources)")
        flow_node_count = 0
        
        # Multiple independent operational source systems
        for sys_cfg in SOURCE_SYSTEMS:
            if flow_node_count >= target: break
            sys_urn = self.add_node(EntityType.SYSTEM, sys_cfg["name"], "raw", props={"source_type": sys_cfg["type"]})
            flow_node_count += 1
            
            # Each system has its own databases
            for db_name in sys_cfg["dbs"]:
                if flow_node_count >= target: break
                db_urn = self.add_node(EntityType.CONTAINER, db_name, "raw", parent_urn=sys_urn)
                flow_node_count += 1
                
                # Tables within each database
                num_tables = random.randint(3, 8)
                for _ in range(num_tables):
                    if flow_node_count >= target: break
                    blueprint = random.choice(list(SCHEMA_TEMPLATES.keys()))
                    tbl_urn = self.add_node(EntityType.DATASET, blueprint.upper(), "raw", parent_urn=db_urn)
                    self.assets_by_flow["raw"]["datasets"].append(tbl_urn)
                    flow_node_count += 1
                    
                    # Columns per table
                    cols = SCHEMA_TEMPLATES[blueprint]
                    for col_name in cols:
                        if flow_node_count >= target: break
                        col_urn = self.add_node(EntityType.SCHEMA_FIELD, col_name, "raw", parent_urn=tbl_urn)
                        self.assets_by_flow["raw"]["columns"].append(col_urn)
                        flow_node_count += 1

    def _generate_curated(self, target: int):
        logger.info(f"Generating CURATED layer (Central Data Warehouse)")
        if not self.assets_by_flow["raw"]["datasets"]: return
        flow_node_count = 0

        # Central Data Warehouse System (e.g., Snowflake)
        dwh_urn = self.add_node(EntityType.SYSTEM, "Enterprise_Data_Warehouse", "curated", props={"platform": "Snowflake"})
        flow_node_count += 1
        
        # Standardized ODS / Staging area
        ods_urn = self.add_node(EntityType.CONTAINER, "ODS_Staging_DB", "curated", parent_urn=dwh_urn)
        flow_node_count += 1
        
        while flow_node_count < target:
            # Map Raw datasets to DWH tables
            raw_ds = random.choice(self.assets_by_flow["raw"]["datasets"])
            raw_node = self.urn_to_node[raw_ds]
            
            # Create a "cleansed" version in DWH
            dwh_tbl_name = f"stg_{raw_node.display_name}"
            dwh_tbl_urn = self.add_node(EntityType.DATASET, dwh_tbl_name, "curated", parent_urn=ods_urn)
            self.assets_by_flow["curated"]["datasets"].append(dwh_tbl_urn)
            flow_node_count += 1
            
            self.add_edge(raw_ds, dwh_tbl_urn, EdgeType.TRANSFORMS, "curated", {"logic": "SCD Type 1 Ingestion"})
            
            # Map columns and create schema lineage
            raw_cols = self.children_by_urn.get(raw_ds, [])
            for r_col in raw_cols:
                if flow_node_count >= target: break
                r_node = self.urn_to_node[r_col]
                dwh_col_urn = self.add_node(EntityType.SCHEMA_FIELD, r_node.display_name, "curated", parent_urn=dwh_tbl_urn)
                self.assets_by_flow["curated"]["columns"].append(dwh_col_urn)
                flow_node_count += 1
                
                self.add_edge(r_col, dwh_col_urn, EdgeType.PRODUCES, "curated")

    def _generate_aggregated(self, target: int):
        logger.info(f"Generating AGGREGATED layer (Data Products - Cross Source Joins)")
        if not self.assets_by_flow["curated"]["datasets"]: return
        flow_node_count = 0

        # Semantic Layer / Data Product Engine
        product_sys_urn = self.add_node(EntityType.SYSTEM, "Data_Product_Platform", "aggregated")
        flow_node_count += 1
        
        prod_db_urn = self.add_node(EntityType.CONTAINER, "Analytical_Products_DB", "aggregated", parent_urn=product_sys_urn)
        flow_node_count += 1
        
        DATA_PRODUCTS = [
            {"name": "Customer_360", "sources": ["customers", "transactions"]},
            {"name": "Sales_Ops_Insight", "sources": ["transactions", "products"]},
            {"name": "Supply_Chain_Risk", "sources": ["products", "tickets"]}
        ]
        
        while flow_node_count < target:
            dp_cfg = random.choice(DATA_PRODUCTS)
            asset_urn = self.add_node(EntityType.DATASET, dp_cfg["name"], "aggregated", parent_urn=prod_db_urn)
            self.assets_by_flow["aggregated"]["datasets"].append(asset_urn)
            flow_node_count += 1
            
            # Find relevant curated sources for this product
            found_sources = []
            for src_key in dp_cfg["sources"]:
                for c_ds_urn in self.assets_by_flow["curated"]["datasets"]:
                    if src_key in c_ds_urn.lower():
                        found_sources.append(c_ds_urn)
                        self.add_edge(c_ds_urn, asset_urn, EdgeType.TRANSFORMS, "aggregated", {"join_type": "LEFT_OUTER"})
            
            # Create metrics (columns) that combine these sources
            metrics = ["total_revenue", "avg_engagement", "risk_score", "last_event"]
            for m_name in metrics:
                if flow_node_count >= target: break
                m_urn = self.add_node(EntityType.SCHEMA_FIELD, m_name, "aggregated", parent_urn=asset_urn)
                self.assets_by_flow["aggregated"]["columns"].append(m_urn)
                flow_node_count += 1
                
                if found_sources:
                    # Lineage from a random source column
                    src_ds = random.choice(found_sources)
                    src_cols = self.children_by_urn.get(src_ds, [])
                    if src_cols:
                        self.add_edge(random.choice(src_cols), m_urn, EdgeType.PRODUCES, "aggregated")

    def _generate_reporting(self, target: int):
        logger.info(f"Generating REPORTING layer (Dashboards & Metrics)")
        if not self.assets_by_flow["aggregated"]["datasets"]: return
        flow_node_count = 0

        # BI Tool Instance
        bi_urn = self.add_node(EntityType.SYSTEM, "Tableau_Server", "reporting")
        flow_node_count += 1
        
        folder_urn = self.add_node(EntityType.CONTAINER, "Executive_Reports", "reporting", parent_urn=bi_urn)
        flow_node_count += 1
        
        DASHBOARD_NAMES = ["CEO_Overview", "Marketing_Dashboard", "Operational_Health", "Financial_KPIs"]
        
        while flow_node_count < target:
            d_name = random.choice(DASHBOARD_NAMES)
            dash_urn = self.add_node(EntityType.DASHBOARD, d_name, "reporting", parent_urn=folder_urn)
            self.assets_by_flow["reporting"]["dashboards"].append(dash_urn)
            flow_node_count += 1
            
            num_charts = random.randint(2, 5)
            for c_idx in range(num_charts):
                if flow_node_count >= target: break
                chart_urn = self.add_node(EntityType.CHART, f"Kpi_Chart_{c_idx}", "reporting", parent_urn=dash_urn)
                self.assets_by_flow["reporting"]["charts"].append(chart_urn)
                flow_node_count += 1
                
                # Consume from a Data Product
                dp_urn = random.choice(self.assets_by_flow["aggregated"]["datasets"])
                self.add_edge(dp_urn, chart_urn, EdgeType.CONSUMES, "reporting")
                
                # Column-level lineage from metric to chart
                metrics = self.children_by_urn.get(dp_urn, [])
                if metrics:
                    self.add_edge(random.choice(metrics), chart_urn, EdgeType.PRODUCES, "reporting")

    def _top_up_edges(self):
        target_edges = int(len(self.nodes) * self.edge_ratio)
        current_edges = len(self.edges)
        if current_edges >= target_edges:
            return
            
        logger.info(f"Topping up edges: {current_edges} -> {target_edges}")
        # Add random lineage edges between random nodes of appropriate types
        potential_lineage = [
            (EntityType.DATASET, EntityType.DATASET, EdgeType.TRANSFORMS),
            (EntityType.SCHEMA_FIELD, EntityType.SCHEMA_FIELD, EdgeType.PRODUCES),
            (EntityType.DATASET, EntityType.CHART, EdgeType.CONSUMES)
        ]
        
        nodes_by_type = {}
        for node in self.nodes:
            etype = node.entity_type
            if etype not in nodes_by_type:
                nodes_by_type[etype] = []
            nodes_by_type[etype].append(node.urn)
            
        while len(self.edges) < target_edges:
            src_type, tgt_type, etype = random.choice(potential_lineage)
            if src_type in nodes_by_type and tgt_type in nodes_by_type:
                s = random.choice(nodes_by_type[src_type])
                t = random.choice(nodes_by_type[tgt_type])
                if s != t:
                    self.add_edge(s, t, etype, "random")

async def push_to_falkordb(generator: AnalyticsDataGenerator, graph_name: str):
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=graph_name,
    )
    await provider._ensure_connected()
    
    CHUNK = 5000
    total_nodes = len(generator.nodes)
    total_edges = len(generator.edges)
    
    logger.info(f"Pushing {total_nodes} nodes to {graph_name}...")
    for i in range(0, total_nodes, CHUNK):
        batch = generator.nodes[i:i+CHUNK]
        await provider.save_custom_graph(batch, [])
        logger.info(f"  Nodes: {min(i+CHUNK, total_nodes)}/{total_nodes}")

    logger.info(f"Pushing {total_edges} edges...")
    for i in range(0, total_edges, CHUNK):
        batch = generator.edges[i:i+CHUNK]
        # FalkorDBProvider.save_custom_graph expects GraphEdge models
        await provider.save_custom_graph([], batch)
        logger.info(f"  Edges: {min(i+CHUNK, total_edges)}/{total_edges}")

    await provider.ensure_indices()
    logger.info("Seeding complete!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generic Analytics Data Generator")
    parser.add_argument("--nodes", type=int, default=1000, help="Total target nodes")
    parser.add_argument("--edge-ratio", type=float, default=1.5, help="Target edge/node ratio")
    parser.add_argument("--graph", type=str, default="analytics_flow", help="FalkorDB graph name")
    parser.add_argument("--breakdown", type=str, help="JSON breakdown e.g. '{\"raw\": 0.5, \"curated\": 0.2, ...}'")
    
    args = parser.parse_args()
    
    breakdown = None
    if args.breakdown:
        breakdown = json.loads(args.breakdown)
        
    gen = AnalyticsDataGenerator(total_nodes=args.nodes, edge_ratio=args.edge_ratio, breakdown=breakdown)
    gen.generate()
    
    try:
        asyncio.run(push_to_falkordb(gen, args.graph))
    except Exception as e:
        logger.error(f"Failed to push to FalkorDB: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
