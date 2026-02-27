#!/usr/bin/env python3
"""
Large-scale Enterprise Data Lineage Seeder for FalkorDB.

Scenarios:
1. CRM (Salesforce) -> S3 (Bronze) -> Spark (Silver) -> Snowflake (Gold)
2. ERP (SAP) -> Kafka -> Beam (Silver) -> Snowflake (Gold)
3. E-Commerce -> Airflow -> S3 (Bronze) -> dbt (Gold)

Hierarchy:
Domain -> DataPlatform -> Container -> Dataset -> SchemaField

Lineage:
Dataset -> DataJob -> Dataset
SchemaField -> SchemaField (TRANSFORMS/PRODUCES)
"""

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import uuid
import time
from falkordb.asyncio import FalkorDB
from typing import List, Dict, Tuple, Any
from dataclasses import dataclass, field

# Add project root for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphNode, GraphEdge, EntityType, EdgeType
from backend.app.providers.falkordb_provider import FalkorDBProvider

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ==========================================
# Schema Definitions
# ==========================================

SCHEMAS = {
    "salesforce": {
        "Account": ["id", "name", "type", "industry", "billing_city", "created_at"],
        "Contact": ["id", "account_id", "first_name", "last_name", "email", "phone"],
        "Opportunity": ["id", "account_id", "amount", "stage", "probability", "close_date"],
        "Lead": ["id", "name", "company", "status", "source", "converted_date"]
    },
    "sap": {
        "VBAK": ["vbeln", "erdat", "erzet", "ernam", "kunnr", "waerk"], # Sales Header
        "VBAP": ["vbeln", "posnr", "matnr", "matkl", "arktx", "netwr"], # Sales Item
        "KNA1": ["kunnr", "land1", "name1", "ort01", "pstlz", "telf1"], # Customer
        "MARA": ["matnr", "ersda", "ernam", "mtart", "matkl", "meins"]  # Material
    },
    "ecommerce": {
        "Orders": ["order_id", "customer_id", "order_date", "status", "total_amount"],
        "OrderItems": ["item_id", "order_id", "product_id", "quantity", "price"],
        "Payments": ["payment_id", "order_id", "method", "amount", "tx_id"],
        "Customers": ["customer_id", "email", "signup_date", "segment"]
    }
}

# ==========================================
# Generator Class
# ==========================================

class LargeSeeder:
    def __init__(self, scale: float = 1.0, dry_run: bool = False):
        self.scale = scale
        self.dry_run = dry_run
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        self.node_count = 0
        self.edge_count = 0
        self.urn_to_label: Dict[str, str] = {}
        
        # Track URNs for lineage linking
        self.datasets_by_layer: Dict[str, List[str]] = {
            "source": [],
            "bronze": [],
            "silver": [],
            "gold": [],
            "mart": []
        }
        self.fields_by_dataset: Dict[str, List[str]] = {}

    def _get_urn(self, entity_type: EntityType, name: str, extra: str = "") -> str:
        clean_name = name.lower().replace(" ", "_").replace(".", "_")
        suffix = f"_{extra}" if extra else f"_{uuid.uuid4().hex[:8]}"
        return f"urn:li:{entity_type.value}:{clean_name}{suffix}"

    def add_node(self, entity_type: EntityType, name: str, parent_urn: str = None, props: Dict = None, extra_urn: str = "") -> str:
        urn = self._get_urn(entity_type, name, extra_urn)
        node = GraphNode(
            urn=urn,
            entityType=entity_type,
            displayName=name,
            qualifiedName=f"{parent_urn}.{name}" if parent_urn else name,
            properties=props or {},
            tags=[]
        )
        self.nodes.append(node)
        self.node_count += 1
        label = entity_type.value if hasattr(entity_type, "value") else str(entity_type)
        self.urn_to_label[urn] = label
        
        if parent_urn:
            self.add_edge(parent_urn, urn, EdgeType.CONTAINS)
        
        return urn

    def add_edge(self, source: str, target: str, edge_type: EdgeType, props: Dict = None):
        edge_id = f"{edge_type.value.lower()}-{source}-{target}"
        # Truncate extremely long IDs
        if len(edge_id) > 240:
            edge_id = edge_id[:200] + "_" + uuid.uuid4().hex[:8]
            
        edge = GraphEdge(
            id=edge_id,
            sourceUrn=source,
            targetUrn=target,
            edgeType=edge_type,
            properties=props or {}
        )
        self.edges.append(edge)
        self.edge_count += 1

    def generate_domain(self, domain_name: str, scenario: str):
        logger.info(f"Generating domain: {domain_name} ({scenario})")
        domain_urn = self.add_node(EntityType.DOMAIN, domain_name)
        
        # 1. Source System
        platform_name = scenario.capitalize()
        platform_urn = self.add_node(EntityType.DATA_PLATFORM, platform_name, domain_urn)
        db_name = f"{scenario.upper()}_PROD"
        db_urn = self.add_node(EntityType.CONTAINER, db_name, platform_urn)
        
        tables = SCHEMAS.get(scenario, {})
        for table_name, cols in tables.items():
            table_urn = self.add_node(EntityType.DATASET, table_name, db_urn)
            self.datasets_by_layer["source"].append(table_urn)
            self.fields_by_dataset[table_urn] = []
            for col in cols:
                col_urn = self.add_node(EntityType.SCHEMA_FIELD, col, table_urn)
                self.fields_by_dataset[table_urn].append(col_urn)

        # 2. Airflow Ingestion -> S3 Bronze
        s3_urn = self.add_node(EntityType.DATA_PLATFORM, "AWS_S3", domain_urn)
        bronze_bucket = self.add_node(EntityType.CONTAINER, f"{domain_name.lower()}-bronze", s3_urn)
        airflow_urn = self.add_node(EntityType.DATA_FLOW, f"Ingest_{scenario.capitalize()}", domain_urn)
        
        for table_urn in self.datasets_by_layer["source"]:
            table_name = table_urn.split(":")[-1].split("_")[0]
            job_urn = self.add_node(EntityType.DATA_JOB, f"Load_{table_name}", airflow_urn)
            
            # Bronze Dataset
            bronze_ds_urn = self.add_node(EntityType.DATASET, f"raw_{table_name}", bronze_bucket)
            self.datasets_by_layer["bronze"].append(bronze_ds_urn)
            self.fields_by_dataset[bronze_ds_urn] = []
            
            # Lineage: Source -> Job -> Bronze
            self.add_edge(table_urn, job_urn, EdgeType.CONSUMES)
            self.add_edge(job_urn, bronze_ds_urn, EdgeType.PRODUCES)
            
            # Column Lineage
            for i, src_col in enumerate(self.fields_by_dataset[table_urn]):
                col_name = src_col.split(":")[-1].split("_")[0]
                dst_col = self.add_node(EntityType.SCHEMA_FIELD, col_name, bronze_ds_urn)
                self.fields_by_dataset[bronze_ds_urn].append(dst_col)
                self.add_edge(src_col, dst_col, EdgeType.PRODUCES, {"logic": "S3 Copy"})

        # 3. Spark Processing -> S3 Silver
        silver_bucket = self.add_node(EntityType.CONTAINER, f"{domain_name.lower()}-silver", s3_urn)
        spark_urn = self.add_node(EntityType.SYSTEM, "Spark_Cluster", domain_urn)
        
        # Scale up Bronze -> Silver (Refinement)
        for ds_urn in self.datasets_by_layer["bronze"]:
            ds_name = ds_urn.split(":")[-1].split("_")[1] # e.g. raw_Account -> Account
            spark_job = self.add_node(EntityType.DATA_JOB, f"Clean_{ds_name}", spark_urn)
            
            silver_ds_urn = self.add_node(EntityType.DATASET, f"clean_{ds_name}", silver_bucket)
            self.datasets_by_layer["silver"].append(silver_ds_urn)
            self.fields_by_dataset[silver_ds_urn] = []
            
            self.add_edge(ds_urn, spark_job, EdgeType.CONSUMES)
            self.add_edge(spark_job, silver_ds_urn, EdgeType.PRODUCES)
            
            for src_col in self.fields_by_dataset[ds_urn]:
                col_name = src_col.split(":")[-1].split("_")[0]
                dst_col = self.add_node(EntityType.SCHEMA_FIELD, col_name, silver_ds_urn)
                self.fields_by_dataset[silver_ds_urn].append(dst_col)
                self.add_edge(src_col, dst_col, EdgeType.TRANSFORMS, {"logic": "Data Cleansing"})

        # 4. Snowflake Mart (Cross-system Joins)
        snowflake_urn = self.add_node(EntityType.DATA_PLATFORM, "Snowflake", domain_urn)
        dw_urn = self.add_node(EntityType.CONTAINER, "ANALYTICS_DW", snowflake_urn)
        dbt_urn = self.add_node(EntityType.DATA_FLOW, "dbt_Transforms", domain_urn)
        
        # Example Cross-Join: dim_customer (SFDC + ERP)
        dim_cust_job = self.add_node(EntityType.DATA_JOB, "Build_Dim_Customer", dbt_urn)
        dim_cust_ds = self.add_node(EntityType.DATASET, "dim_customer", dw_urn)
        self.datasets_by_layer["mart"].append(dim_cust_ds)
        
        # Link to some silver datasets
        sources = random.sample(self.datasets_by_layer["silver"], min(3, len(self.datasets_by_layer["silver"])))
        for s in sources:
            self.add_edge(s, dim_cust_job, EdgeType.CONSUMES)
        self.add_edge(dim_cust_job, dim_cust_ds, EdgeType.PRODUCES)
        
        # Columns for dim_customer
        cust_cols = ["customer_key", "name", "segment", "lifetime_value", "last_order_date"]
        for col in cust_cols:
            c_urn = self.add_node(EntityType.SCHEMA_FIELD, col, dim_cust_ds)
            # Find matching silver column
            for s in sources:
                matching_cols = [fc for fc in self.fields_by_dataset[s] if col in fc.lower()]
                if matching_cols:
                    self.add_edge(matching_cols[0], c_urn, EdgeType.TRANSFORMS, {"logic": "Join Logic"})

    def scale_filler(self, target: int):
        """Fill up to target count with random objects."""
        current = self.node_count
        if current >= target: return
        
        logger.info(f"Scaling filler: {current} -> {target}")
        scale_dom = self.add_node(EntityType.DOMAIN, "Scale_Legacy")
        scale_plat = self.add_node(EntityType.DATA_PLATFORM, "Archive_Storage", scale_dom)
        
        while self.node_count < target:
            c_idx = self.node_count // 1000
            cont = self.add_node(EntityType.CONTAINER, f"arc_db_{c_idx}", scale_plat)
            for d in range(10):
                if self.node_count >= target: break
                ds = self.add_node(EntityType.DATASET, f"table_{d}", cont)
                for f in range(10):
                    if self.node_count >= target: break
                    self.add_node(EntityType.SCHEMA_FIELD, f"col_{f}", ds)

    def generate(self):
        start = time.time()
        # Generate Core Scenarios
        self.generate_domain("Finance", "sap")
        self.generate_domain("Sales", "salesforce")
        self.generate_domain("Marketing", "ecommerce")
        
        # Scale Fill
        target_nodes = int(self.scale * 100000) # 1.0 scale = 100k nodes, 10.0 scale = 1M nodes
        self.scale_filler(target_nodes)
        
        elapsed = time.time() - start
        logger.info(f"Generation Complete in {elapsed:.2f}s: {self.node_count} nodes, {self.edge_count} edges")

async def push_to_falkordb(seeder: LargeSeeder):
    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))
    graph_name = os.getenv("FALKORDB_GRAPH_NAME", "nexus_lineage")

    db = FalkorDB(host=host, port=port)
    graph = db.select_graph(graph_name)
    
    logger.info(f"Connected to FalkorDB {host}:{port} - Graph: {graph_name}")
    
    # 1. Group nodes by label
    nodes_by_label: Dict[str, List[Dict]] = {}
    for node in seeder.nodes:
        label = node.entity_type.value if hasattr(node.entity_type, "value") else str(node.entity_type)
        if label not in nodes_by_label:
            nodes_by_label[label] = []
        nodes_by_label[label].append({
            "urn": node.urn,
            "displayName": node.display_name or "",
            "qualifiedName": node.qualified_name or "",
            "properties": json.dumps(node.properties),
            "tags": json.dumps(node.tags or []),
            "childCount": node.child_count or 0
        })

    # 2. Bulk Push Nodes
    CHUNK = 5000
    for label, nodes in nodes_by_label.items():
        logger.info(f"Pushing {len(nodes)} nodes of type {label}...")
        for i in range(0, len(nodes), CHUNK):
            batch = nodes[i:i+CHUNK]
            cypher = f"""
            UNWIND $batch AS map
            MERGE (n:{label} {{urn: map.urn}})
            SET n.displayName = map.displayName, n.qualifiedName = map.qualifiedName,
                n.properties = map.properties, n.tags = map.tags, n.childCount = map.childCount
            """
            await graph.query(cypher, params={"batch": batch})
            logger.info(f"  {label}: {i+len(batch)}/{len(nodes)}")

    # 3. Group edges by (SrcLabel, TgtLabel, Type)
    edges_grouped: Dict[Tuple[str, str, str], List[Dict]] = {}
    for edge in seeder.edges:
        etype = edge.edge_type.value if hasattr(edge.edge_type, "value") else str(edge.edge_type)
        src_label = seeder.urn_to_label.get(edge.source_urn)
        tgt_label = seeder.urn_to_label.get(edge.target_urn)
        
        if not src_label or not tgt_label: continue
        
        key = (src_label, tgt_label, etype)
        if key not in edges_grouped:
            edges_grouped[key] = []
        edges_grouped[key].append({
            "src": edge.source_urn,
            "tgt": edge.target_urn,
            "id": edge.id,
            "props": json.dumps(edge.properties)
        })

    # 4. Bulk Push Edges with Label-Specific Match
    for (slbl, tlbl, etype), edges in edges_grouped.items():
        logger.info(f"Pushing {len(edges)} edges: ({slbl})-[:{etype}]->({tlbl})...")
        for i in range(0, len(edges), CHUNK):
            batch = edges[i:i+CHUNK]
            # USING LABEL-SPECIFIC MATCH IS CRITICAL FOR PERFORMANCE
            cypher = f"""
            UNWIND $batch AS map
            MATCH (a:{slbl} {{urn: map.src}})
            MATCH (b:{tlbl} {{urn: map.tgt}})
            MERGE (a)-[r:{etype}]->(b)
            SET r.id = map.id, r.properties = map.props
            """
            await graph.query(cypher, params={"batch": batch})
            logger.info(f"  ({slbl})-[:{etype}]->({tlbl}): {i+len(batch)}/{len(edges)}")

    # await graph.query("CREATE INDEX FOR ...") # Handled by provider usually
    logger.info("FalkorDB Seeding Complete!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scale", type=float, default=1.0, help="Scale factor (100k nodes per 1.0)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--push-falkordb", action="store_true")
    args = parser.parse_args()
    
    seeder = LargeSeeder(scale=args.scale, dry_run=args.dry_run)
    seeder.generate()
    
    if args.push_falkordb and not args.dry_run:
        asyncio.run(push_to_falkordb(seeder))
