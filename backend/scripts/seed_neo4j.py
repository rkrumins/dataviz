#!/usr/bin/env python3
"""
Synthetic Graph Data Generator & Seeder for Neo4j.

Generates a realistic enterprise data lineage graph and seeds it into Neo4j via
the Neo4jProvider, exercising the full write path including:
  1. Nodes with proper containment hierarchy
  2. CONTAINS edges (parent → child)
  3. TRANSFORMS lineage edges (column-level)
  4. AGGREGATED edge materialization via on_lineage_edge_written()
  5. Optional indexes via ensure_projections()

Hierarchy:
  Domain → DataPlatform → Container (Database) → Dataset (Table) → SchemaField (Column)

Lineage flows:
  Source columns → Staging columns → Mart columns → Dashboard charts

Usage:
  python backend/scripts/seed_neo4j.py --scenarios finance,hr --scale 2 --depth 2
  python backend/scripts/seed_neo4j.py --scenarios all --scale 5 --breadth 2 --depth 3
  python backend/scripts/seed_neo4j.py --wipe          # wipe and re-seed defaults

Environment variables:
  NEO4J_URI            bolt://localhost:7687
  NEO4J_USERNAME       neo4j
  NEO4J_PASSWORD       password
  NEO4J_DATABASE       neo4j
"""

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
import uuid
from typing import Dict, List, Set, Tuple

# Add project root for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.common.models.graph import GraphNode, GraphEdge

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ==========================================
# Industry-Realistic Scenarios
# ==========================================

SCENARIOS = {
    "finance": {
        "domain": "Finance",
        "sources": [
            {"platform": "SAP ERP", "container": "ECC_PROD", "datasets": [
                ("VBAP_Sales_Items", ["order_id", "material", "net_value", "currency", "created_at"]),
                ("BKPF_Accounting_Docs", ["doc_number", "company_code", "fiscal_year", "posting_date", "amount"]),
                ("MARA_Materials", ["material_id", "description", "material_type", "weight", "uom"]),
            ]},
            {"platform": "NetSuite", "container": "NS_ANALYTICS", "datasets": [
                ("Transactions", ["txn_id", "entity_id", "amount", "txn_date", "status"]),
                ("Customers", ["customer_id", "name", "email", "segment", "lifetime_value"]),
                ("Vendors", ["vendor_id", "name", "payment_terms", "rating", "country"]),
            ]},
        ],
        "staging_tables": [
            ("stg_orders", ["order_key", "material_key", "amount_usd", "order_date", "source_system"]),
            ("stg_financials", ["txn_key", "account_code", "debit", "credit", "period"]),
        ],
        "mart_tables": [
            ("fct_revenue", ["revenue_id", "customer_key", "product_key", "amount", "recognized_date"]),
            ("dim_customer", ["customer_key", "name", "segment", "region", "is_active"]),
        ],
        "consumption": [
            ("CFO Dashboard", ["Revenue Trend", "Margin Analysis", "Cash Flow"]),
            ("Monthly Variance Report", ["Budget vs Actual", "Department Breakdown"]),
            ("Tax Audit Log", ["Transaction Trail", "Compliance Score"]),
        ],
    },
    "hr": {
        "domain": "Human Resources",
        "sources": [
            {"platform": "Workday", "container": "WD_PROD", "datasets": [
                ("Workers", ["worker_id", "name", "hire_date", "department", "manager_id"]),
                ("Compensation", ["comp_id", "worker_id", "salary", "bonus", "effective_date"]),
                ("Org_Hierarchy", ["org_id", "parent_org_id", "name", "level", "cost_center"]),
            ]},
            {"platform": "Greenhouse", "container": "GH_RECRUIT", "datasets": [
                ("Applications", ["app_id", "candidate_name", "role", "stage", "submitted_at"]),
                ("Requisitions", ["req_id", "title", "department", "headcount", "priority"]),
            ]},
        ],
        "staging_tables": [
            ("stg_employees", ["employee_key", "full_name", "department_key", "start_date", "status"]),
            ("stg_recruiting", ["candidate_key", "role", "pipeline_stage", "days_in_stage", "source"]),
        ],
        "mart_tables": [
            ("fct_headcount", ["snapshot_date", "department_key", "active_count", "attrition_rate", "open_reqs"]),
            ("dim_department", ["department_key", "name", "vp", "cost_center", "location"]),
        ],
        "consumption": [
            ("Headcount Overview", ["Department Heatmap", "Growth Timeline"]),
            ("Recruitment Funnel", ["Pipeline Stage", "Time to Hire"]),
            ("Attrition Predictor", ["Risk Score", "Flight Risk Factors"]),
        ],
    },
    "marketing": {
        "domain": "Marketing",
        "sources": [
            {"platform": "Google Ads", "container": "AD_WORDS_LOGS", "datasets": [
                ("Campaigns", ["campaign_id", "name", "budget", "status", "start_date"]),
                ("Keywords", ["keyword_id", "campaign_id", "keyword_text", "match_type", "bid"]),
                ("Clicks", ["click_id", "keyword_id", "timestamp", "device", "cost"]),
            ]},
            {"platform": "HubSpot", "container": "HS_CRM", "datasets": [
                ("Contacts", ["contact_id", "email", "first_name", "last_name", "lifecycle_stage"]),
                ("Leads", ["lead_id", "contact_id", "source", "score", "created_at"]),
                ("Deals", ["deal_id", "name", "amount", "stage", "close_date"]),
            ]},
        ],
        "staging_tables": [
            ("stg_ad_performance", ["campaign_key", "date", "impressions", "clicks", "spend"]),
            ("stg_lead_activity", ["lead_key", "source", "score", "first_touch", "last_touch"]),
        ],
        "mart_tables": [
            ("fct_attribution", ["attribution_id", "channel", "touchpoint", "weight", "conversion_value"]),
            ("fct_campaign_roi", ["campaign_key", "spend", "revenue", "roas", "period"]),
        ],
        "consumption": [
            ("Marketing ROI", ["Channel Performance", "Spend Allocation"]),
            ("Lead Attribution", ["Multi-Touch Model", "First/Last Touch"]),
            ("Campaign Performance", ["A/B Results", "Keyword Cloud"]),
        ],
    },
    "ecommerce": {
        "domain": "eCommerce",
        "sources": [
            {"platform": "Shopify", "container": "SHOPIFY_STORE", "datasets": [
                ("Orders", ["order_id", "customer_id", "total", "status", "created_at"]),
                ("Products", ["product_id", "title", "price", "category", "inventory_qty"]),
                ("Collections", ["collection_id", "title", "product_count", "published_at", "sort_order"]),
            ]},
            {"platform": "Stripe", "container": "STRIPE_PAYMENTS", "datasets": [
                ("Charges", ["charge_id", "amount", "currency", "customer", "status"]),
                ("Payouts", ["payout_id", "amount", "arrival_date", "status", "method"]),
                ("Refunds", ["refund_id", "charge_id", "amount", "reason", "created"]),
            ]},
        ],
        "staging_tables": [
            ("stg_orders", ["order_key", "customer_key", "gross_total", "net_total", "order_date"]),
            ("stg_payments", ["payment_key", "order_key", "amount", "method", "settled_at"]),
        ],
        "mart_tables": [
            ("fct_sales", ["sale_id", "product_key", "customer_key", "quantity", "revenue"]),
            ("dim_product", ["product_key", "title", "category", "price_tier", "is_active"]),
        ],
        "consumption": [
            ("Sales Dashboard", ["Daily Revenue", "Top Products", "Conversion Funnel"]),
            ("Inventory Health", ["Stock Levels", "Reorder Alerts"]),
            ("Payment Reconciliation", ["Settlement Status", "Refund Rate"]),
        ],
    },
}

TAGS_POOL = [
    "pii", "gdpr", "soc2", "financial", "sensitive", "public", "internal",
    "deprecated", "certified", "draft", "production", "staging",
    "tier-1", "tier-2", "tier-3", "ml-feature", "realtime",
]


class EnterpriseDataGenerator:
    """Generates a realistic enterprise graph with containment + lineage."""

    def __init__(
        self,
        scenarios: List[str],
        scale: int = 1,
        breadth: int = 1,
        depth: int = 1,
    ):
        self.scenarios = scenarios
        self.scale = scale
        self.breadth = breadth
        self.depth = depth

        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        self.lineage_edges: List[GraphEdge] = []  # tracked separately for aggregation

    def _make_urn(self, entity_type: str, name: str) -> str:
        slug = name.lower().replace(" ", "_").replace("/", "_")
        return f"urn:li:{entity_type}:{slug}_{uuid.uuid4().hex[:8]}"

    def _add_node(
        self,
        entity_type: str,
        name: str,
        parent_urn: str = None,
        tags: List[str] = None,
        props: Dict = None,
    ) -> GraphNode:
        urn = self._make_urn(entity_type, name)
        node = GraphNode(
            urn=urn,
            entityType=entity_type,
            displayName=name,
            qualifiedName=name,
            description=f"Auto-generated {entity_type}: {name}",
            properties=props or {},
            tags=tags or random.sample(TAGS_POOL, random.randint(0, 3)),
        )
        self.nodes.append(node)

        if parent_urn:
            edge = GraphEdge(
                id=f"contains-{parent_urn}-{urn}",
                sourceUrn=parent_urn,
                targetUrn=urn,
                edgeType="CONTAINS",
                properties={},
            )
            self.edges.append(edge)

        return node

    def _add_lineage(
        self, source_urn: str, target_urn: str, logic: str = "Transformation"
    ) -> GraphEdge:
        edge = GraphEdge(
            id=f"transforms-{uuid.uuid4().hex[:12]}",
            sourceUrn=source_urn,
            targetUrn=target_urn,
            edgeType="TRANSFORMS",
            properties={"logic": logic},
        )
        self.edges.append(edge)
        self.lineage_edges.append(edge)
        return edge

    def generate(self):
        logger.info(
            "Generating scenarios=%s (B:%d, D:%d, S:%d)",
            self.scenarios, self.breadth, self.depth, self.scale,
        )

        # Shared analytics platform
        snowflake = self._add_node("dataPlatform", "Snowflake")

        for s_key in self.scenarios:
            config = SCENARIOS.get(s_key)
            if not config:
                logger.warning("Unknown scenario: %s", s_key)
                continue

            domain = self._add_node("domain", config["domain"])

            for b_idx in range(self.breadth):
                suffix = f"_v{b_idx}" if self.breadth > 1 else ""
                self._generate_scenario(config, domain, snowflake, suffix)

        # Scale filler
        self._generate_scale_filler()

        logger.info(
            "Generation complete: %d nodes, %d edges (%d lineage)",
            len(self.nodes), len(self.edges), len(self.lineage_edges),
        )

    def _generate_scenario(self, config, domain, snowflake, suffix):
        # ── Source layer ──────────────────────────────────────────
        source_columns = []
        for src_cfg in config["sources"]:
            platform = self._add_node(
                "dataPlatform", f"{src_cfg['platform']}{suffix}", parent_urn=domain.urn,
            )
            container = self._add_node(
                "container", f"{src_cfg['container']}{suffix}", parent_urn=platform.urn,
            )
            for ds_name, col_names in src_cfg["datasets"]:
                dataset = self._add_node(
                    "dataset", f"{ds_name}{suffix}", parent_urn=container.urn,
                    props={"row_count": random.randint(1_000, 10_000_000)},
                )
                for col_name in col_names:
                    col = self._add_node(
                        "schemaField", f"{ds_name}.{col_name}", parent_urn=dataset.urn,
                        props={"data_type": random.choice(["string", "int", "float", "timestamp", "boolean"])},
                    )
                    source_columns.append(col)

        # ── Staging layer (fixed from config) ─────────────────────
        staging_container = self._add_node(
            "container", f"STG_{config['domain'].upper()}{suffix}", parent_urn=snowflake.urn,
        )
        staging_columns = []
        for stg_name, stg_cols in config.get("staging_tables", []):
            stg_ds = self._add_node(
                "dataset", f"{stg_name}{suffix}", parent_urn=staging_container.urn,
                props={"layer": "staging"},
            )
            for col_name in stg_cols:
                col = self._add_node(
                    "schemaField", f"{stg_name}.{col_name}", parent_urn=stg_ds.urn,
                    props={"data_type": random.choice(["string", "int", "float", "timestamp"])},
                )
                staging_columns.append(col)
                # Each staging column sourced from 1-3 source columns
                for src in random.sample(source_columns, min(random.randint(1, 3), len(source_columns))):
                    self._add_lineage(src.urn, col.urn, "ETL Extract → Stage")

        # ── Additional transformation depth layers ────────────────
        prev_layer = staging_columns
        for d_idx in range(self.depth - 1):
            int_container = self._add_node(
                "container", f"INT_{config['domain'].upper()}_L{d_idx}{suffix}",
                parent_urn=snowflake.urn,
            )
            next_layer = []
            num_tables = max(2, len(prev_layer) // 8)
            for t_idx in range(num_tables):
                ds = self._add_node(
                    "dataset", f"int_{config['domain'].lower()}_t{d_idx}_{t_idx}{suffix}",
                    parent_urn=int_container.urn,
                    props={"layer": f"intermediate_{d_idx}"},
                )
                for ci in range(random.randint(3, 6)):
                    col = self._add_node(
                        "schemaField", f"int_{d_idx}_{t_idx}.field_{ci}",
                        parent_urn=ds.urn,
                    )
                    next_layer.append(col)
                    for src in random.sample(prev_layer, min(random.randint(1, 4), len(prev_layer))):
                        self._add_lineage(src.urn, col.urn, f"dbt Tier-{d_idx}")
            prev_layer = next_layer

        # ── Mart layer ────────────────────────────────────────────
        mart_container = self._add_node(
            "container", f"MART_{config['domain'].upper()}{suffix}", parent_urn=snowflake.urn,
        )
        mart_columns = []
        for mart_name, mart_cols in config.get("mart_tables", []):
            mart_ds = self._add_node(
                "dataset", f"{mart_name}{suffix}", parent_urn=mart_container.urn,
                props={"layer": "mart"},
            )
            for col_name in mart_cols:
                col = self._add_node(
                    "schemaField", f"{mart_name}.{col_name}", parent_urn=mart_ds.urn,
                )
                mart_columns.append(col)
                for src in random.sample(prev_layer, min(random.randint(1, 3), len(prev_layer))):
                    self._add_lineage(src.urn, col.urn, "Mart Aggregation")

        # ── Consumption layer (dashboards + charts) ───────────────
        tableau = self._add_node(
            "dataPlatform", f"Tableau_{config['domain']}{suffix}", parent_urn=domain.urn,
        )
        for dash_name, chart_names in config.get("consumption", []):
            dashboard = self._add_node(
                "dashboard", f"{dash_name}{suffix}", parent_urn=tableau.urn,
            )
            for chart_name in chart_names:
                chart = self._add_node(
                    "chart", f"{chart_name}", parent_urn=dashboard.urn,
                )
                # Charts consume from mart columns
                for src in random.sample(mart_columns, min(random.randint(2, 5), len(mart_columns))):
                    self._add_lineage(src.urn, chart.urn, "Direct Query")

    def _generate_scale_filler(self):
        """Add extra nodes to reach target scale."""
        current = len(self.nodes)
        target = self.scale * 1000
        if current >= target:
            return

        remaining = target - current
        logger.info("Adding scale filler: %d → %d nodes", current, target)

        archive = self._add_node("dataPlatform", "Legacy_Archive")
        containers_needed = max(1, remaining // 110)  # ~110 nodes per container (1 + 10 ds * 10 cols + 10 ds)

        for ci in range(containers_needed):
            cont = self._add_node("container", f"Archive_DB_{ci}", parent_urn=archive.urn)
            for di in range(10):
                ds = self._add_node("dataset", f"archive_tbl_{ci}_{di}", parent_urn=cont.urn)
                for fi in range(10):
                    self._add_node("schemaField", f"archive_{ci}_{di}_col_{fi}", parent_urn=ds.urn)


# ==========================================
# Neo4j Seeder
# ==========================================

async def seed_neo4j(
    generator: EnterpriseDataGenerator,
    uri: str,
    username: str,
    password: str,
    database: str,
    wipe: bool = False,
    materialize_aggregated: bool = True,
):
    from backend.graph.adapters.neo4j_provider import Neo4jProvider

    provider = Neo4jProvider(
        uri=uri,
        username=username,
        password=password,
        database=database,
    )

    if wipe:
        logger.info("Wiping database...")
        t0 = time.monotonic()
        await provider._run_write("MATCH (n) DETACH DELETE n")
        logger.info("  Wipe complete in %.1fs", time.monotonic() - t0)

    total_nodes = len(generator.nodes)
    total_edges = len(generator.edges)

    # ── Phase 1: Write nodes ──────────────────────────────────
    logger.info("Phase 1: Pushing %d nodes...", total_nodes)
    t0 = time.monotonic()
    CHUNK = 5000
    for i in range(0, total_nodes, CHUNK):
        batch = generator.nodes[i:i + CHUNK]
        await provider.save_custom_graph(batch, [])
        pct = min(100, int((i + len(batch)) / total_nodes * 100))
        logger.info("  Nodes: %d/%d (%d%%)", i + len(batch), total_nodes, pct)
    logger.info("  Nodes complete in %.1fs", time.monotonic() - t0)

    # ── Phase 2: Write edges (CONTAINS + TRANSFORMS) ─────────
    logger.info("Phase 2: Pushing %d edges...", total_edges)
    t0 = time.monotonic()
    for i in range(0, total_edges, CHUNK):
        batch = generator.edges[i:i + CHUNK]
        await provider.save_custom_graph([], batch)
        pct = min(100, int((i + len(batch)) / total_edges * 100))
        logger.info("  Edges: %d/%d (%d%%)", i + len(batch), total_edges, pct)
    logger.info("  Edges complete in %.1fs", time.monotonic() - t0)

    # ── Phase 3: Ensure indexes ───────────────────────────────
    logger.info("Phase 3: Ensuring indexes & projections...")
    await provider.ensure_projections()

    # Create additional useful indexes
    ip = provider._id_prop()
    for label in ["domain", "dataPlatform", "container", "dataset", "schemaField", "dashboard", "chart"]:
        try:
            await provider._run_write(
                f"CREATE INDEX idx_{label}_urn IF NOT EXISTS FOR (n:`{label}`) ON (n.{ip})"
            )
        except Exception:
            pass  # Index may already exist
    logger.info("  Indexes created.")

    # ── Phase 4: Materialize AGGREGATED edges ─────────────────
    if materialize_aggregated:
        lineage_count = len(generator.lineage_edges)
        logger.info("Phase 4: Materializing AGGREGATED edges from %d lineage edges...", lineage_count)
        t0 = time.monotonic()

        for idx, edge in enumerate(generator.lineage_edges):
            await provider.on_lineage_edge_written(
                source_urn=edge.source_urn,
                target_urn=edge.target_urn,
                edge_id=edge.id,
                edge_type=str(edge.edge_type),
            )
            if (idx + 1) % 50 == 0 or idx == lineage_count - 1:
                pct = int((idx + 1) / lineage_count * 100)
                logger.info("  AGGREGATED: %d/%d (%d%%)", idx + 1, lineage_count, pct)

        elapsed = time.monotonic() - t0
        logger.info("  AGGREGATED materialization complete in %.1fs", elapsed)

        # Count the results
        try:
            result = await provider._run_read(
                "MATCH ()-[r:AGGREGATED]->() RETURN count(r) AS cnt"
            )
            agg_count = result[0]["cnt"] if result else 0
            logger.info("  Total AGGREGATED edges in graph: %d", agg_count)
        except Exception:
            pass

    # ── Summary ───────────────────────────────────────────────
    try:
        stats = await provider.get_stats()
        logger.info(
            "Seeding complete! Graph has %s nodes and %s edges.",
            stats.get("node_count", stats.get("nodeCount", "?")),
            stats.get("edge_count", stats.get("edgeCount", "?")),
        )
    except Exception as e:
        logger.info("Seeding complete! (stats unavailable: %s)", e)

    await provider.close()


# ==========================================
# CLI
# ==========================================

def main():
    parser = argparse.ArgumentParser(
        description="Seed Neo4j with realistic enterprise data lineage graph",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Default: finance scenario, ~1K nodes
  python backend/scripts/seed_neo4j.py

  # Multiple scenarios, larger graph
  python backend/scripts/seed_neo4j.py --scenarios finance,hr,marketing --scale 3

  # Wipe and rebuild with max complexity
  python backend/scripts/seed_neo4j.py --wipe --scenarios all --scale 5 --breadth 2 --depth 3

  # Skip AGGREGATED materialization (faster seeding)
  python backend/scripts/seed_neo4j.py --no-aggregate
        """,
    )
    parser.add_argument(
        "--scenarios", type=str, default="finance",
        help="Comma-separated scenarios: finance, hr, marketing, ecommerce, all (default: finance)",
    )
    parser.add_argument("--scale", type=int, default=1, help="Scale factor for total nodes (1 = ~1K)")
    parser.add_argument("--breadth", type=int, default=1, help="Parallel system chains per scenario")
    parser.add_argument("--depth", type=int, default=1, help="Transformation layers between source and mart")
    parser.add_argument("--wipe", action="store_true", help="Wipe the target database before seeding")
    parser.add_argument("--no-aggregate", action="store_true", help="Skip AGGREGATED edge materialization")

    # Connection overrides
    parser.add_argument("--uri", type=str, default=None, help="Neo4j URI (default: env NEO4J_URI or bolt://localhost:7687)")
    parser.add_argument("--username", type=str, default=None, help="Neo4j username (default: env NEO4J_USERNAME or neo4j)")
    parser.add_argument("--password", type=str, default=None, help="Neo4j password (default: env NEO4J_PASSWORD or password)")
    parser.add_argument("--database", type=str, default=None, help="Neo4j database (default: env NEO4J_DATABASE or neo4j)")

    args = parser.parse_args()

    scenario_list = args.scenarios.split(",")
    if "all" in scenario_list:
        scenario_list = list(SCENARIOS.keys())

    uri = args.uri or os.getenv("NEO4J_URI", "bolt://localhost:7687")
    username = args.username or os.getenv("NEO4J_USERNAME", "neo4j")
    password = args.password or os.getenv("NEO4J_PASSWORD", "password")
    database = args.database or os.getenv("NEO4J_DATABASE", "neo4j")

    logger.info("Target: %s (db=%s, user=%s)", uri, database, username)
    logger.info("Config: scenarios=%s, scale=%d, breadth=%d, depth=%d", scenario_list, args.scale, args.breadth, args.depth)

    gen = EnterpriseDataGenerator(
        scenarios=scenario_list,
        scale=args.scale,
        breadth=args.breadth,
        depth=args.depth,
    )
    gen.generate()

    try:
        asyncio.run(seed_neo4j(
            gen,
            uri=uri,
            username=username,
            password=password,
            database=database,
            wipe=args.wipe,
            materialize_aggregated=not args.no_aggregate,
        ))
    except KeyboardInterrupt:
        logger.warning("Interrupted.")
    except Exception as e:
        logger.error("Failed: %s", e)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
