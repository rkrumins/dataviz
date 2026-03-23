#!/usr/bin/env python3
"""
End-to-end Data Platform Lineage Seeder.

Creates a realistic enterprise data platform graph with full column-level lineage
from transactional sources through to reporting — the way DataHub, Collibra, or
Atlan would represent it.

Hierarchy (CONTAINS edges — structural nesting):
  domain
    ├── dataPlatform (source DBs, S3, Snowflake)
    │     └── container (db.schema / bucket/prefix)
    │           └── dataset (table)
    │                 └── schemaField (column)
    ├── system (Airflow, dbt, Databricks, Tableau)
    │     ├── dataFlow (pipeline)
    │     │     └── dataJob (task)
    │     ├── dashboard
    │     │     └── chart
    │     └── container (catalog.schema)
    │           └── dataset → schemaField
    └── app (downstream consumers)

Lineage (flow edges — data movement):
  Source columns ──TRANSFORMS──► Staging columns
    ──TRANSFORMS──► Bronze columns
      ──TRANSFORMS──► Silver columns
        ──TRANSFORMS──► Gold columns
          ──TRANSFORMS──► Reporting columns

  dataJob ──CONSUMES──► input dataset
  dataJob ──PRODUCES──► output dataset
  dashboard/chart ──CONSUMES──► dataset/schemaField
  fact ──DEPENDS_ON──► dimension

Usage:
  python backend/scripts/seed_platform_lineage.py --dry-run
  python backend/scripts/seed_platform_lineage.py --push --graph my_platform
  python backend/scripts/seed_platform_lineage.py --push --materialize
  python backend/scripts/seed_platform_lineage.py --dump-json graph.json
  python backend/scripts/seed_platform_lineage.py --dry-run --scale 10   # ~6k nodes
  python backend/scripts/seed_platform_lineage.py --dry-run --scale 100  # ~60k nodes
"""

import argparse
import asyncio
import json
import logging
import math
import os
import sys
import time
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import EntityType, EdgeType, GraphEdge, GraphNode

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("seed_platform_lineage")


# ═══════════════════════════════════════════════════════════════════════════
# Source System Definitions
# ═══════════════════════════════════════════════════════════════════════════
# Each column: (name, data_type, is_pii, description)

SOURCES = {
    # ── PostgreSQL: E-Commerce ──────────────────────────────────────────
    "postgresql": {
        "platform_name": "PostgreSQL",
        "instances": [
            {
                "id": "pg_us",
                "name": "PostgreSQL (US)",
                "description": "E-Commerce US — ecomm-us-prod.internal (AWS RDS, us-east-1)",
                "container_name": "ecomm_us.public",
                "region": "us-east-1",
            },
            {
                "id": "pg_eu",
                "name": "PostgreSQL (EU)",
                "description": "E-Commerce EU — ecomm-eu-prod.internal (AWS RDS, eu-west-1)",
                "container_name": "ecomm_eu.public",
                "region": "eu-west-1",
            },
        ],
        "tables": {
            "customers": [
                ("customer_id", "bigint", False, "Primary key"),
                ("email", "varchar(255)", True, "Customer email"),
                ("first_name", "varchar(100)", True, "First name"),
                ("last_name", "varchar(100)", True, "Last name"),
                ("phone", "varchar(20)", True, "Phone number"),
                ("country", "varchar(3)", False, "ISO country code"),
                ("segment", "varchar(50)", False, "Customer tier: bronze/silver/gold"),
                ("signup_date", "timestamp", False, "Account creation date"),
                ("is_active", "boolean", False, "Active flag"),
            ],
            "orders": [
                ("order_id", "bigint", False, "Primary key"),
                ("customer_id", "bigint", False, "FK to customers"),
                ("order_date", "timestamp", False, "Order placement date"),
                ("status", "varchar(20)", False, "Order status"),
                ("subtotal", "decimal(12,2)", False, "Line items total"),
                ("tax", "decimal(12,2)", False, "Tax amount"),
                ("shipping", "decimal(12,2)", False, "Shipping cost"),
                ("total_amount", "decimal(12,2)", False, "Grand total"),
                ("currency", "varchar(3)", False, "ISO currency code"),
            ],
            "order_items": [
                ("item_id", "bigint", False, "Primary key"),
                ("order_id", "bigint", False, "FK to orders"),
                ("product_id", "bigint", False, "FK to products"),
                ("quantity", "int", False, "Quantity ordered"),
                ("unit_price", "decimal(12,2)", False, "Price per unit"),
                ("line_total", "decimal(12,2)", False, "quantity * unit_price"),
            ],
            "products": [
                ("product_id", "bigint", False, "Primary key"),
                ("sku", "varchar(50)", False, "Stock keeping unit"),
                ("name", "varchar(255)", False, "Product name"),
                ("category", "varchar(100)", False, "Product category"),
                ("brand", "varchar(100)", False, "Brand name"),
                ("cost_price", "decimal(12,2)", False, "Unit cost"),
                ("list_price", "decimal(12,2)", False, "List price"),
            ],
        },
    },

    # ── MySQL: Inventory & Fulfillment ──────────────────────────────────
    "mysql": {
        "platform_name": "MySQL",
        "instances": [
            {
                "id": "mysql_us",
                "name": "MySQL (US)",
                "description": "Fulfillment US — mysql-fulfillment-us.internal (on-prem, us-east)",
                "container_name": "fulfillment_us.inventory",
                "region": "us-east",
            },
            {
                "id": "mysql_eu",
                "name": "MySQL (EU)",
                "description": "Fulfillment EU — mysql-fulfillment-eu.internal (on-prem, eu-west)",
                "container_name": "fulfillment_eu.inventory",
                "region": "eu-west",
            },
        ],
        "tables": {
            "warehouses": [
                ("warehouse_id", "int", False, "Primary key"),
                ("name", "varchar(100)", False, "Warehouse name"),
                ("region", "varchar(50)", False, "Geographic region"),
                ("capacity", "int", False, "Max storage units"),
            ],
            "inventory": [
                ("inventory_id", "bigint", False, "Primary key"),
                ("product_id", "bigint", False, "FK to products"),
                ("warehouse_id", "int", False, "FK to warehouses"),
                ("quantity_on_hand", "int", False, "Current stock"),
                ("reorder_point", "int", False, "Min stock threshold"),
                ("last_counted", "timestamp", False, "Last physical count"),
            ],
            "shipments": [
                ("shipment_id", "bigint", False, "Primary key"),
                ("order_id", "bigint", False, "FK to orders"),
                ("warehouse_id", "int", False, "Source warehouse"),
                ("carrier", "varchar(50)", False, "Shipping carrier"),
                ("tracking_number", "varchar(100)", False, "Tracking ID"),
                ("shipped_date", "timestamp", False, "Date shipped"),
                ("delivered_date", "timestamp", True, "Date delivered"),
                ("status", "varchar(20)", False, "Shipment status"),
            ],
        },
    },

    # ── MongoDB: User Behavior ──────────────────────────────────────────
    "mongodb": {
        "platform_name": "MongoDB",
        "instances": [
            {
                "id": "mongo_global",
                "name": "MongoDB Atlas",
                "description": "User behavior tracking — MongoDB Atlas (global cluster)",
                "container_name": "analytics.events",
                "region": "global",
            },
        ],
        "tables": {
            "page_views": [
                ("event_id", "varchar(36)", False, "UUID event key"),
                ("user_id", "bigint", False, "FK to customers"),
                ("session_id", "varchar(36)", False, "Session identifier"),
                ("page_url", "varchar(500)", False, "Page URL"),
                ("referrer", "varchar(500)", True, "Referral source"),
                ("device_type", "varchar(20)", False, "desktop/mobile/tablet"),
                ("event_timestamp", "timestamp", False, "Event time"),
            ],
            "cart_events": [
                ("event_id", "varchar(36)", False, "UUID event key"),
                ("user_id", "bigint", False, "FK to customers"),
                ("product_id", "bigint", False, "Product involved"),
                ("action", "varchar(20)", False, "add/remove/checkout"),
                ("quantity", "int", False, "Quantity changed"),
                ("event_timestamp", "timestamp", False, "Event time"),
            ],
        },
    },
}

# ═══════════════════════════════════════════════════════════════════════════
# Silver Layer Transforms
# ═══════════════════════════════════════════════════════════════════════════
# source_key → silver table name, with column mappings
# Each column: (name, type, [(source_table, source_col), ...], transform_logic, desc)

SILVER_TABLES = {
    "clean_customers": {
        "sources": ["customers"],
        "description": "Cleaned and standardized customer records",
        "columns": [
            ("customer_key", "bigint", [("customers", "customer_id")], "pass-through", "Surrogate key"),
            ("email", "varchar(255)", [("customers", "email")], "LOWER(TRIM(email))", "Normalized email"),
            ("full_name", "varchar(200)", [("customers", "first_name"), ("customers", "last_name")],
             "CONCAT(first_name, ' ', last_name)", "Full name"),
            ("country", "varchar(3)", [("customers", "country")], "UPPER(country)", "Country code"),
            ("segment", "varchar(50)", [("customers", "segment")], "pass-through", "Customer tier"),
            ("signup_date", "date", [("customers", "signup_date")], "CAST(signup_date AS DATE)", "Signup date"),
            ("is_active", "boolean", [("customers", "is_active")], "pass-through", "Active flag"),
        ],
    },
    "clean_orders": {
        "sources": ["orders", "order_items"],
        "description": "Enriched order records with line-item aggregation",
        "columns": [
            ("order_key", "bigint", [("orders", "order_id")], "pass-through", "Surrogate key"),
            ("customer_key", "bigint", [("orders", "customer_id")], "pass-through", "FK to customer"),
            ("order_date", "date", [("orders", "order_date")], "CAST(order_date AS DATE)", "Order date"),
            ("status", "varchar(20)", [("orders", "status")], "pass-through", "Order status"),
            ("item_count", "int", [("order_items", "quantity")], "SUM(quantity)", "Total items"),
            ("subtotal", "decimal(12,2)", [("orders", "subtotal")], "pass-through", "Subtotal"),
            ("tax", "decimal(12,2)", [("orders", "tax")], "pass-through", "Tax amount"),
            ("total_amount", "decimal(12,2)", [("orders", "total_amount")], "pass-through", "Grand total"),
            ("currency", "varchar(3)", [("orders", "currency")], "pass-through", "Currency"),
        ],
    },
    "clean_products": {
        "sources": ["products"],
        "description": "Standardized product catalog",
        "columns": [
            ("product_key", "bigint", [("products", "product_id")], "pass-through", "Surrogate key"),
            ("sku", "varchar(50)", [("products", "sku")], "pass-through", "SKU"),
            ("name", "varchar(255)", [("products", "name")], "TRIM(name)", "Product name"),
            ("category", "varchar(100)", [("products", "category")], "pass-through", "Category"),
            ("brand", "varchar(100)", [("products", "brand")], "COALESCE(brand, 'Unknown')", "Brand"),
            ("cost_price", "decimal(12,2)", [("products", "cost_price")], "pass-through", "Unit cost"),
            ("list_price", "decimal(12,2)", [("products", "list_price")], "pass-through", "List price"),
            ("margin_pct", "decimal(5,2)", [("products", "list_price"), ("products", "cost_price")],
             "(list_price - cost_price) / NULLIF(list_price, 0) * 100", "Gross margin %"),
        ],
    },
    "clean_inventory": {
        "sources": ["inventory", "warehouses"],
        "description": "Inventory positions with warehouse details",
        "columns": [
            ("inventory_key", "bigint", [("inventory", "inventory_id")], "pass-through", "Surrogate key"),
            ("product_key", "bigint", [("inventory", "product_id")], "pass-through", "FK to product"),
            ("warehouse_name", "varchar(100)", [("warehouses", "name")], "pass-through", "Warehouse"),
            ("region", "varchar(50)", [("warehouses", "region")], "pass-through", "Region"),
            ("quantity_on_hand", "int", [("inventory", "quantity_on_hand")], "pass-through", "Stock level"),
            ("below_reorder", "boolean", [("inventory", "quantity_on_hand"), ("inventory", "reorder_point")],
             "quantity_on_hand < reorder_point", "Reorder flag"),
            ("last_counted", "date", [("inventory", "last_counted")], "CAST AS DATE", "Last count date"),
        ],
    },
    "clean_shipments": {
        "sources": ["shipments"],
        "description": "Shipment events with delivery metrics",
        "columns": [
            ("shipment_key", "bigint", [("shipments", "shipment_id")], "pass-through", "Surrogate key"),
            ("order_key", "bigint", [("shipments", "order_id")], "pass-through", "FK to order"),
            ("warehouse_name", "varchar(100)", [("shipments", "warehouse_id")], "JOIN warehouses", "Source warehouse"),
            ("carrier", "varchar(50)", [("shipments", "carrier")], "pass-through", "Carrier"),
            ("shipped_date", "date", [("shipments", "shipped_date")], "CAST AS DATE", "Ship date"),
            ("delivered_date", "date", [("shipments", "delivered_date")], "CAST AS DATE", "Delivery date"),
            ("transit_days", "int", [("shipments", "shipped_date"), ("shipments", "delivered_date")],
             "DATEDIFF(delivered_date, shipped_date)", "Transit time in days"),
            ("status", "varchar(20)", [("shipments", "status")], "pass-through", "Status"),
        ],
    },
}

# ═══════════════════════════════════════════════════════════════════════════
# Gold Layer — Dimensional Model (Star Schema)
# ═══════════════════════════════════════════════════════════════════════════

GOLD_DIMS = {
    "dim_customer": {
        "description": "Customer dimension (SCD Type 2)",
        "sources": ["clean_customers"],
        "columns": [
            ("customer_key", "bigint", [("clean_customers", "customer_key")], "pass-through", "Business key"),
            ("email", "varchar(255)", [("clean_customers", "email")], "pass-through", "Email"),
            ("full_name", "varchar(200)", [("clean_customers", "full_name")], "pass-through", "Full name"),
            ("country", "varchar(3)", [("clean_customers", "country")], "pass-through", "Country"),
            ("segment", "varchar(50)", [("clean_customers", "segment")], "pass-through", "Customer tier"),
            ("signup_date", "date", [("clean_customers", "signup_date")], "pass-through", "Signup date"),
            ("is_active", "boolean", [("clean_customers", "is_active")], "pass-through", "Active flag"),
        ],
    },
    "dim_product": {
        "description": "Product dimension with cost and margin",
        "sources": ["clean_products"],
        "columns": [
            ("product_key", "bigint", [("clean_products", "product_key")], "pass-through", "Business key"),
            ("sku", "varchar(50)", [("clean_products", "sku")], "pass-through", "SKU"),
            ("name", "varchar(255)", [("clean_products", "name")], "pass-through", "Product name"),
            ("category", "varchar(100)", [("clean_products", "category")], "pass-through", "Category"),
            ("brand", "varchar(100)", [("clean_products", "brand")], "pass-through", "Brand"),
            ("cost_price", "decimal(12,2)", [("clean_products", "cost_price")], "pass-through", "Unit cost"),
            ("list_price", "decimal(12,2)", [("clean_products", "list_price")], "pass-through", "List price"),
            ("margin_pct", "decimal(5,2)", [("clean_products", "margin_pct")], "pass-through", "Gross margin %"),
        ],
    },
    "dim_date": {
        "description": "Date dimension (generated, not sourced)",
        "sources": [],
        "columns": [
            ("date_key", "int", [], "YYYYMMDD", "Surrogate key"),
            ("full_date", "date", [], "calendar", "Calendar date"),
            ("year", "int", [], "YEAR(full_date)", "Year"),
            ("quarter", "int", [], "QUARTER(full_date)", "Quarter"),
            ("month", "int", [], "MONTH(full_date)", "Month"),
            ("month_name", "varchar(10)", [], "MONTHNAME(full_date)", "Month name"),
            ("day_of_week", "varchar(10)", [], "DAYNAME(full_date)", "Day of week"),
            ("is_weekend", "boolean", [], "day_of_week IN ('Saturday','Sunday')", "Weekend flag"),
        ],
    },
}

GOLD_FACTS = {
    "fact_orders": {
        "description": "Order fact table (grain: one row per order)",
        "sources": ["clean_orders", "clean_customers"],
        "dims": ["dim_customer", "dim_product", "dim_date"],
        "columns": [
            ("order_key", "bigint", [("clean_orders", "order_key")], "pass-through", "Degenerate dimension"),
            ("customer_key", "bigint", [("clean_orders", "customer_key")], "pass-through", "FK to dim_customer"),
            ("order_date_key", "int", [("clean_orders", "order_date")], "CAST(order_date AS YYYYMMDD)", "FK to dim_date"),
            ("item_count", "int", [("clean_orders", "item_count")], "pass-through", "Total items"),
            ("subtotal", "decimal(12,2)", [("clean_orders", "subtotal")], "pass-through", "Subtotal"),
            ("tax", "decimal(12,2)", [("clean_orders", "tax")], "pass-through", "Tax"),
            ("total_amount", "decimal(12,2)", [("clean_orders", "total_amount")], "pass-through", "Grand total"),
            ("gross_profit", "decimal(12,2)", [("clean_orders", "subtotal")],
             "subtotal - SUM(cost_price * quantity)", "Gross profit"),
        ],
    },
    "fact_inventory": {
        "description": "Daily inventory snapshot (grain: product × warehouse × day)",
        "sources": ["clean_inventory"],
        "dims": ["dim_product", "dim_date"],
        "columns": [
            ("product_key", "bigint", [("clean_inventory", "product_key")], "pass-through", "FK to dim_product"),
            ("snapshot_date_key", "int", [], "CURRENT_DATE as YYYYMMDD", "FK to dim_date"),
            ("warehouse_name", "varchar(100)", [("clean_inventory", "warehouse_name")], "pass-through", "Warehouse"),
            ("region", "varchar(50)", [("clean_inventory", "region")], "pass-through", "Region"),
            ("quantity_on_hand", "int", [("clean_inventory", "quantity_on_hand")], "pass-through", "Stock"),
            ("below_reorder", "boolean", [("clean_inventory", "below_reorder")], "pass-through", "Reorder flag"),
        ],
    },
    "fact_shipments": {
        "description": "Shipment performance (grain: one row per shipment)",
        "sources": ["clean_shipments"],
        "dims": ["dim_customer", "dim_date"],
        "columns": [
            ("shipment_key", "bigint", [("clean_shipments", "shipment_key")], "pass-through", "PK"),
            ("order_key", "bigint", [("clean_shipments", "order_key")], "pass-through", "FK to fact_orders"),
            ("shipped_date_key", "int", [("clean_shipments", "shipped_date")], "YYYYMMDD", "FK to dim_date"),
            ("carrier", "varchar(50)", [("clean_shipments", "carrier")], "pass-through", "Carrier"),
            ("transit_days", "int", [("clean_shipments", "transit_days")], "pass-through", "Transit days"),
            ("on_time", "boolean", [("clean_shipments", "transit_days")], "transit_days <= 5", "SLA met flag"),
        ],
    },
}

# ═══════════════════════════════════════════════════════════════════════════
# Reporting Layer
# ═══════════════════════════════════════════════════════════════════════════

REPORTING_TABLES = {
    "rpt_daily_revenue": {
        "description": "Daily revenue and order summary",
        "sources": ["fact_orders", "dim_date", "dim_customer"],
        "columns": [
            ("report_date", "date", [("dim_date", "full_date")], "pass-through", "Report date"),
            ("order_count", "int", [("fact_orders", "order_key")], "COUNT(DISTINCT)", "Orders placed"),
            ("total_revenue", "decimal(15,2)", [("fact_orders", "total_amount")], "SUM(total_amount)", "Revenue"),
            ("total_profit", "decimal(15,2)", [("fact_orders", "gross_profit")], "SUM(gross_profit)", "Gross profit"),
            ("avg_order_value", "decimal(12,2)", [("fact_orders", "total_amount"), ("fact_orders", "order_key")],
             "SUM(total_amount) / COUNT(DISTINCT order_key)", "AOV"),
            ("unique_customers", "int", [("fact_orders", "customer_key")], "COUNT(DISTINCT)", "Unique buyers"),
        ],
    },
    "rpt_product_performance": {
        "description": "Product sales and inventory health",
        "sources": ["fact_orders", "fact_inventory", "dim_product"],
        "columns": [
            ("product_key", "bigint", [("dim_product", "product_key")], "pass-through", "Product key"),
            ("product_name", "varchar(255)", [("dim_product", "name")], "pass-through", "Product name"),
            ("category", "varchar(100)", [("dim_product", "category")], "pass-through", "Category"),
            ("units_sold", "int", [("fact_orders", "item_count")], "SUM(item_count)", "Units sold"),
            ("revenue", "decimal(15,2)", [("fact_orders", "total_amount")], "SUM(total_amount)", "Revenue"),
            ("margin_pct", "decimal(5,2)", [("dim_product", "margin_pct")], "AVG(margin_pct)", "Avg margin"),
            ("stock_on_hand", "int", [("fact_inventory", "quantity_on_hand")], "SUM(quantity_on_hand)", "Total stock"),
            ("pct_below_reorder", "decimal(5,2)", [("fact_inventory", "below_reorder")],
             "AVG(CAST(below_reorder AS INT)) * 100", "% below reorder"),
        ],
    },
    "rpt_fulfillment": {
        "description": "Shipping SLA and carrier performance",
        "sources": ["fact_shipments", "dim_date"],
        "columns": [
            ("report_date", "date", [("dim_date", "full_date")], "pass-through", "Report date"),
            ("shipments_count", "int", [("fact_shipments", "shipment_key")], "COUNT", "Shipments"),
            ("avg_transit_days", "decimal(5,2)", [("fact_shipments", "transit_days")], "AVG", "Avg transit days"),
            ("on_time_pct", "decimal(5,2)", [("fact_shipments", "on_time")],
             "AVG(CAST(on_time AS INT)) * 100", "SLA compliance %"),
            ("carrier", "varchar(50)", [("fact_shipments", "carrier")], "pass-through", "Carrier"),
        ],
    },
}

# ═══════════════════════════════════════════════════════════════════════════
# Dashboards & Charts
# ═══════════════════════════════════════════════════════════════════════════

DASHBOARDS = {
    "Revenue Dashboard": {
        "description": "Daily revenue monitoring with trend analysis",
        "charts": [
            ("Revenue Trend", "rpt_daily_revenue", ["report_date", "total_revenue"]),
            ("Order Volume", "rpt_daily_revenue", ["report_date", "order_count"]),
            ("AOV Trend", "rpt_daily_revenue", ["report_date", "avg_order_value"]),
            ("Profit vs Revenue", "rpt_daily_revenue", ["total_revenue", "total_profit"]),
        ],
    },
    "Product Performance Dashboard": {
        "description": "Product sales, margins, and inventory health",
        "charts": [
            ("Revenue by Category", "rpt_product_performance", ["category", "revenue"]),
            ("Margin Analysis", "rpt_product_performance", ["product_name", "margin_pct"]),
            ("Stock Alerts", "rpt_product_performance", ["product_name", "pct_below_reorder"]),
        ],
    },
    "Fulfillment Dashboard": {
        "description": "Shipping performance and SLA monitoring",
        "charts": [
            ("SLA Compliance", "rpt_fulfillment", ["report_date", "on_time_pct"]),
            ("Transit Time by Carrier", "rpt_fulfillment", ["carrier", "avg_transit_days"]),
        ],
    },
}

# Governance
TAGS = [
    ("PII", "Contains Personally Identifiable Information"),
    ("Certified", "Data quality validated for reporting"),
    ("SLA-Critical", "Must refresh within SLA window"),
]

GLOSSARY_TERMS = [
    ("Revenue", "Total monetary value of completed orders", "finance"),
    ("Gross Profit", "Revenue minus cost of goods sold", "finance"),
    ("AOV", "Average Order Value — revenue / order count", "commerce"),
    ("Customer Lifetime Value", "Total revenue attributed to a customer", "commerce"),
    ("Inventory Turnover", "Rate at which inventory is sold and replaced", "operations"),
    ("SLA Compliance", "Percentage of shipments delivered within SLA", "operations"),
]


# ═══════════════════════════════════════════════════════════════════════════
# Scale Expansion
# ═══════════════════════════════════════════════════════════════════════════
# When --scale N is used (N > 1), we dynamically generate additional source
# tables, instances, silver/gold/reporting tables, and dashboards to reach
# approximately N × base node count (~600 × N).

# Additional regions to add at scale (beyond base us/eu)
EXTRA_REGIONS = [
    ("apac", "ap-southeast-1", "Asia-Pacific"),
    ("latam", "sa-east-1", "Latin America"),
    ("mena", "me-south-1", "Middle East & North Africa"),
    ("india", "ap-south-1", "India"),
    ("canada", "ca-central-1", "Canada"),
    ("anz", "ap-southeast-2", "Australia & New Zealand"),
    ("japan", "ap-northeast-1", "Japan"),
    ("korea", "ap-northeast-2", "South Korea"),
    ("nordics", "eu-north-1", "Nordics"),
    ("uk", "eu-west-2", "United Kingdom"),
    ("dach", "eu-central-1", "Germany/Austria/Switzerland"),
    ("france", "eu-west-3", "France"),
    ("iberia", "eu-south-1", "Spain/Portugal"),
    ("brazil", "sa-east-1", "Brazil"),
    ("mexico", "us-west-1", "Mexico"),
    ("africa", "af-south-1", "Africa"),
]

# Template for generating additional source tables at scale.
# Each entry: (table_name, description, columns)
# where columns: [(name, type, is_pii, description), ...]
EXTRA_SOURCE_TABLES = [
    ("returns", "Product returns and refunds", [
        ("return_id", "bigint", False, "Primary key"),
        ("order_id", "bigint", False, "FK to orders"),
        ("product_id", "bigint", False, "FK to products"),
        ("return_date", "timestamp", False, "Return date"),
        ("reason", "varchar(200)", False, "Return reason"),
        ("refund_amount", "decimal(12,2)", False, "Refund amount"),
        ("status", "varchar(20)", False, "Return status"),
    ]),
    ("reviews", "Product reviews and ratings", [
        ("review_id", "bigint", False, "Primary key"),
        ("customer_id", "bigint", False, "FK to customers"),
        ("product_id", "bigint", False, "FK to products"),
        ("rating", "int", False, "Star rating 1-5"),
        ("title", "varchar(200)", False, "Review title"),
        ("body", "text", False, "Review text"),
        ("review_date", "timestamp", False, "Review date"),
        ("is_verified", "boolean", False, "Verified purchase"),
    ]),
    ("support_tickets", "Customer support tickets", [
        ("ticket_id", "bigint", False, "Primary key"),
        ("customer_id", "bigint", False, "FK to customers"),
        ("order_id", "bigint", False, "FK to orders"),
        ("channel", "varchar(20)", False, "Contact channel"),
        ("priority", "varchar(10)", False, "Ticket priority"),
        ("status", "varchar(20)", False, "Ticket status"),
        ("created_at", "timestamp", False, "Ticket creation time"),
        ("resolved_at", "timestamp", False, "Resolution time"),
        ("category", "varchar(50)", False, "Issue category"),
    ]),
    ("promotions", "Promotional campaigns", [
        ("promo_id", "bigint", False, "Primary key"),
        ("code", "varchar(50)", False, "Promo code"),
        ("discount_pct", "decimal(5,2)", False, "Discount percentage"),
        ("start_date", "timestamp", False, "Start date"),
        ("end_date", "timestamp", False, "End date"),
        ("min_order", "decimal(12,2)", False, "Minimum order value"),
        ("max_uses", "int", False, "Max usage count"),
        ("current_uses", "int", False, "Current usage count"),
    ]),
    ("suppliers", "Supplier directory", [
        ("supplier_id", "bigint", False, "Primary key"),
        ("name", "varchar(200)", False, "Supplier name"),
        ("country", "varchar(3)", False, "Country code"),
        ("contact_email", "varchar(255)", True, "Contact email"),
        ("lead_time_days", "int", False, "Avg lead time"),
        ("rating", "decimal(3,2)", False, "Supplier rating"),
        ("is_active", "boolean", False, "Active flag"),
    ]),
    ("purchase_orders", "Purchase orders to suppliers", [
        ("po_id", "bigint", False, "Primary key"),
        ("supplier_id", "bigint", False, "FK to suppliers"),
        ("product_id", "bigint", False, "FK to products"),
        ("quantity", "int", False, "Quantity ordered"),
        ("unit_cost", "decimal(12,2)", False, "Unit cost"),
        ("order_date", "timestamp", False, "PO date"),
        ("expected_date", "timestamp", False, "Expected delivery"),
        ("received_date", "timestamp", False, "Actual delivery"),
        ("status", "varchar(20)", False, "PO status"),
    ]),
    ("subscriptions", "Customer subscriptions", [
        ("subscription_id", "bigint", False, "Primary key"),
        ("customer_id", "bigint", False, "FK to customers"),
        ("plan", "varchar(50)", False, "Subscription plan"),
        ("mrr", "decimal(12,2)", False, "Monthly recurring revenue"),
        ("start_date", "timestamp", False, "Subscription start"),
        ("end_date", "timestamp", False, "Subscription end"),
        ("status", "varchar(20)", False, "Active/cancelled/paused"),
        ("billing_cycle", "varchar(20)", False, "Monthly/annual"),
    ]),
    ("payments", "Payment transactions", [
        ("payment_id", "bigint", False, "Primary key"),
        ("order_id", "bigint", False, "FK to orders"),
        ("amount", "decimal(12,2)", False, "Payment amount"),
        ("method", "varchar(20)", False, "Payment method"),
        ("processor", "varchar(50)", False, "Payment processor"),
        ("status", "varchar(20)", False, "Payment status"),
        ("processed_at", "timestamp", False, "Processing time"),
        ("currency", "varchar(3)", False, "Currency code"),
    ]),
    ("loyalty_points", "Customer loyalty program", [
        ("transaction_id", "bigint", False, "Primary key"),
        ("customer_id", "bigint", False, "FK to customers"),
        ("points", "int", False, "Points earned/redeemed"),
        ("type", "varchar(20)", False, "earn/redeem"),
        ("source", "varchar(50)", False, "Points source"),
        ("balance", "int", False, "Running balance"),
        ("created_at", "timestamp", False, "Transaction time"),
    ]),
    ("ab_experiments", "A/B test experiment results", [
        ("experiment_id", "bigint", False, "Primary key"),
        ("user_id", "bigint", False, "FK to customers"),
        ("experiment_name", "varchar(100)", False, "Experiment name"),
        ("variant", "varchar(20)", False, "Control/treatment"),
        ("conversion", "boolean", False, "Converted flag"),
        ("revenue", "decimal(12,2)", False, "Revenue in session"),
        ("session_id", "varchar(36)", False, "Session ID"),
        ("created_at", "timestamp", False, "Assignment time"),
    ]),
]


def apply_scale(scale: int):
    """Mutate the module-level data dicts in-place to add scale-appropriate
    extra instances, source tables, and downstream layers."""
    if scale <= 1:
        return

    import copy

    # ── 1. Add more regional instances ──────────────────────────────────
    # Each doubling of scale adds ~2 more regions per source (postgres, mysql).
    # MongoDB stays global with fewer instances.
    extra_region_count = min(len(EXTRA_REGIONS), max(1, int(math.log2(scale)) + 1))
    regions_to_add = EXTRA_REGIONS[:extra_region_count]

    for src_key in ("postgresql", "mysql"):
        src = SOURCES[src_key]
        base_name = src["platform_name"]
        base_container_prefix = src["instances"][0]["container_name"].rsplit(".", 1)[0]
        for region_id, aws_region, region_label in regions_to_add:
            inst_id = f"{src_key[:2]}_{region_id}"  # pg_apac, my_latam, etc.
            # Skip if already exists
            if any(i["id"] == inst_id for i in src["instances"]):
                continue
            src["instances"].append({
                "id": inst_id,
                "name": f"{base_name} ({region_label})",
                "description": f"{base_name} — {region_label} ({aws_region})",
                "container_name": f"{base_container_prefix}_{region_id}.public",
                "region": aws_region,
            })

    # Also add MongoDB regional clusters at higher scales
    if extra_region_count >= 3:
        mongo = SOURCES["mongodb"]
        for region_id, aws_region, region_label in regions_to_add[:extra_region_count // 2]:
            inst_id = f"mongo_{region_id}"
            if any(i["id"] == inst_id for i in mongo["instances"]):
                continue
            mongo["instances"].append({
                "id": inst_id,
                "name": f"MongoDB ({region_label})",
                "description": f"MongoDB Atlas — {region_label} ({aws_region})",
                "container_name": f"analytics_{region_id}.events",
                "region": aws_region,
            })

    # ── 2. Add more source tables ───────────────────────────────────────
    # Each scale level adds more tables. At scale 10 → ~3 extra tables,
    # scale 100 → ~7, scale 1000 → all 10.
    extra_table_count = min(len(EXTRA_SOURCE_TABLES), max(1, int(math.log2(scale)) + 1))
    tables_to_add = EXTRA_SOURCE_TABLES[:extra_table_count]

    # Distribute extra tables across source systems
    source_keys = list(SOURCES.keys())
    for i, (tbl_name, tbl_desc, tbl_cols) in enumerate(tables_to_add):
        target_src = source_keys[i % len(source_keys)]
        if tbl_name not in SOURCES[target_src]["tables"]:
            SOURCES[target_src]["tables"][tbl_name] = tbl_cols

    # ── 3. Generate corresponding silver tables for new source tables ───
    for tbl_name, tbl_desc, tbl_cols in tables_to_add:
        silver_name = f"clean_{tbl_name}"
        if silver_name in SILVER_TABLES:
            continue
        SILVER_TABLES[silver_name] = {
            "sources": [tbl_name],
            "description": f"Cleaned and standardized {tbl_name.replace('_', ' ')}",
            "columns": [
                (
                    f"{col[0]}_key" if col[0].endswith("_id") and col[0] == tbl_cols[0][0] else col[0],
                    col[1],
                    [(tbl_name, col[0])],
                    "pass-through",
                    col[3],
                )
                for col in tbl_cols
            ],
        }

    # ── 4. Generate gold fact tables for new source tables ──────────────
    for tbl_name, tbl_desc, tbl_cols in tables_to_add:
        silver_name = f"clean_{tbl_name}"
        fact_name = f"fact_{tbl_name}"
        if fact_name in GOLD_FACTS:
            continue
        silver_spec = SILVER_TABLES.get(silver_name, {})
        silver_cols = silver_spec.get("columns", [])
        # Pick relevant dims based on FK columns
        dims = ["dim_date"]
        for col in tbl_cols:
            if "customer" in col[0]:
                dims.append("dim_customer")
            if "product" in col[0]:
                dims.append("dim_product")
        GOLD_FACTS[fact_name] = {
            "description": f"{tbl_desc} fact table",
            "sources": [silver_name],
            "dims": list(dict.fromkeys(dims)),  # deduplicate, preserve order
            "columns": [
                (sc[0], sc[1], [(silver_name, sc[0])], sc[3], sc[4])
                for sc in silver_cols
            ],
        }

    # ── 5. Generate reporting tables for groups of new facts ────────────
    # Create one reporting table per 2-3 new fact tables
    new_fact_names = [
        f"fact_{tbl_name}" for tbl_name, _, _ in tables_to_add
        if f"fact_{tbl_name}" in GOLD_FACTS
    ]
    for i in range(0, len(new_fact_names), 2):
        group = new_fact_names[i:i + 2]
        base_name = group[0].replace("fact_", "")
        rpt_name = f"rpt_{base_name}_summary"
        if rpt_name in REPORTING_TABLES:
            continue
        # Gather columns from the facts in this group
        rpt_cols = []
        sources = list(group) + ["dim_date"]
        rpt_cols.append(("report_date", "date", [("dim_date", "full_date")], "pass-through", "Report date"))
        for fact_name in group:
            fact_spec = GOLD_FACTS.get(fact_name, {})
            for col in fact_spec.get("columns", [])[:3]:  # top 3 cols per fact
                col_name = col[0]
                if col_name == "report_date":
                    continue
                rpt_cols.append((
                    col_name, col[1],
                    [(fact_name, col_name)],
                    f"SUM({col_name})" if "decimal" in col[1] or "int" in col[1] else "pass-through",
                    col[4],
                ))
        REPORTING_TABLES[rpt_name] = {
            "description": f"Summary report for {', '.join(g.replace('fact_', '') for g in group)}",
            "sources": sources,
            "columns": rpt_cols,
        }

    # ── 6. Generate dashboards for new reporting tables ─────────────────
    new_rpt_names = [
        f"rpt_{tbl_name}_summary" for tbl_name, _, _ in tables_to_add[::2]
        if f"rpt_{tbl_name}_summary" in REPORTING_TABLES
    ]
    for rpt_name in new_rpt_names:
        dash_name = rpt_name.replace("rpt_", "").replace("_summary", "").replace("_", " ").title() + " Dashboard"
        if dash_name in DASHBOARDS:
            continue
        rpt_spec = REPORTING_TABLES.get(rpt_name, {})
        charts = []
        cols = rpt_spec.get("columns", [])
        if len(cols) >= 2:
            charts.append((f"{dash_name} Trend", rpt_name, [cols[0][0], cols[1][0]]))
        if len(cols) >= 3:
            charts.append((f"{dash_name} Breakdown", rpt_name, [cols[0][0], cols[2][0]]))
        if charts:
            DASHBOARDS[dash_name] = {
                "description": f"Dashboard for {rpt_name}",
                "charts": charts,
            }

    # ── 7. Generate additional column variants at very high scale ──────
    # At scale >= 50, add audit/metadata columns to every source table to
    # increase column (and thus schemaField node) count.
    if scale >= 50:
        audit_cols = [
            ("created_at", "timestamp", False, "Row creation timestamp"),
            ("updated_at", "timestamp", False, "Last update timestamp"),
            ("created_by", "varchar(100)", False, "Creator user ID"),
            ("etl_batch_id", "bigint", False, "ETL batch identifier"),
            ("row_hash", "varchar(64)", False, "SHA-256 row hash for CDC"),
        ]
        extra_audit = audit_cols[:min(len(audit_cols), 1 + int(math.log2(scale // 50)))]
        for src_key, src_def in SOURCES.items():
            for tbl_name, tbl_cols in src_def["tables"].items():
                existing_names = {c[0] for c in tbl_cols}
                for ac in extra_audit:
                    if ac[0] not in existing_names:
                        tbl_cols.append(ac)

    logger.info(f"  Scale expansion applied (scale={scale}):")
    total_instances = sum(len(s["instances"]) for s in SOURCES.values())
    total_tables = sum(len(s["tables"]) for s in SOURCES.values())
    logger.info(f"    Source instances: {total_instances}")
    logger.info(f"    Source tables: {total_tables}")
    logger.info(f"    Silver tables: {len(SILVER_TABLES)}")
    logger.info(f"    Gold facts: {len(GOLD_FACTS)}")
    logger.info(f"    Reporting tables: {len(REPORTING_TABLES)}")
    logger.info(f"    Dashboards: {len(DASHBOARDS)}")


# Business unit names used when scale > 1 BU
_BU_NAMES = [
    "Retail & E-Commerce", "Financial Services", "Healthcare",
    "Manufacturing", "Supply Chain & Logistics", "Media & Entertainment",
    "Telecommunications", "Energy & Utilities", "Insurance",
    "Real Estate", "Education", "Government & Public Sector",
    "Travel & Hospitality", "Automotive", "Agriculture & Food",
    "Pharmaceuticals", "Professional Services", "Cybersecurity",
    "Fintech", "SaaS Platform",
]


# ═══════════════════════════════════════════════════════════════════════════
# Graph Builder
# ═══════════════════════════════════════════════════════════════════════════

class PlatformLineageBuilder:
    """Builds a complete end-to-end data platform graph with column-level lineage."""

    def __init__(self):
        self._counter = 0
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        self.urn_index: Dict[str, GraphNode] = {}
        self.urn_to_label: Dict[str, str] = {}
        self.col: Dict[str, str] = {}   # "layer.table.column" → urn
        self.ds: Dict[str, str] = {}    # "layer.table" → urn
        self.tag_urns: Dict[str, str] = {}
        self.glossary_urns: Dict[str, str] = {}
        self.now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # ── Helpers ──────────────────────────────────────────────────────

    def _urn(self, etype: EntityType, name: str) -> str:
        self._counter += 1
        clean = name.lower().replace(" ", "_").replace("/", "_").replace(".", "_")[:60]
        return f"urn:li:{etype.value}:{clean}_{self._counter:08x}"

    def node(self, etype: EntityType, name: str, parent: str = None,
             desc: str = None, layer: str = None, source: str = None,
             tags: List[str] = None, props: Dict[str, Any] = None) -> str:
        urn = self._urn(etype, name)
        if not layer and parent and parent in self.urn_index:
            layer = self.urn_index[parent].layer_assignment
        n = GraphNode(
            urn=urn, entityType=etype, displayName=name,
            qualifiedName=f"{parent}.{name}" if parent else name,
            description=desc, properties=props or {},
            tags=tags or [], layerAssignment=layer,
            sourceSystem=source, lastSyncedAt=self.now,
        )
        self.nodes.append(n)
        self.urn_index[urn] = n
        self.urn_to_label[urn] = etype.value if hasattr(etype, "value") else str(etype)
        if parent:
            self.edge(parent, urn, EdgeType.CONTAINS)
        return urn

    def edge(self, src: str, tgt: str, etype: EdgeType,
             props: Dict[str, Any] = None, confidence: float = None):
        self._counter += 1
        e = GraphEdge(
            id=f"e-{self._counter:08x}", sourceUrn=src, targetUrn=tgt,
            edgeType=etype, confidence=confidence, properties=props or {},
        )
        self.edges.append(e)

    def add_columns(self, table_key: str, ds_urn: str, columns: list,
                    layer: str, source: str = None) -> List[Tuple[str, str]]:
        """Add schemaField nodes under a dataset. Returns [(col_name, col_urn), ...]"""
        result = []
        for col_def in columns:
            col_name, dtype = col_def[0], col_def[1]
            is_pii = col_def[2] if len(col_def) > 2 else False
            col_desc = col_def[3] if len(col_def) > 3 else col_name
            col_urn = self.node(
                EntityType.SCHEMA_FIELD, col_name, parent=ds_urn,
                desc=col_desc, props={"dataType": dtype},
                tags=["pii"] if is_pii else [],
            )
            self.col[f"{table_key}.{col_name}"] = col_urn
            result.append((col_name, col_urn))
            if is_pii and "PII" in self.tag_urns:
                self.edge(col_urn, self.tag_urns["PII"], EdgeType.TAGGED_WITH)
        return result

    # ── Build Steps ──────────────────────────────────────────────────

    def build_governance(self, domain: str):
        logger.info("  Governance (tags + glossary)...")
        for tag_name, tag_desc in TAGS:
            self.tag_urns[tag_name] = self.node(
                EntityType.TAG, tag_name, desc=tag_desc,
                props={"category": "governance"},
            )
        for term, desc, domain_area in GLOSSARY_TERMS:
            self.glossary_urns[term] = self.node(
                EntityType.GLOSSARY_TERM, term, desc=desc,
                props={"domain": domain_area},
            )

    def build_sources(self, domain: str):
        """Create source systems: dataPlatform (per instance) → container → dataset → schemaField."""
        logger.info("  Source systems...")
        for src_key, src_def in SOURCES.items():
            for inst in src_def["instances"]:
                inst_id = inst["id"]
                platform = self.node(
                    EntityType.DATA_PLATFORM, inst["name"], parent=domain,
                    desc=inst["description"], source=src_key,
                    props={"region": inst.get("region", "")},
                )
                container = self.node(
                    EntityType.CONTAINER, inst["container_name"], parent=platform,
                    desc=inst["description"], layer="source", source=src_key,
                )
                for table_name, columns in src_def["tables"].items():
                    ds_urn = self.node(
                        EntityType.DATASET, table_name, parent=container,
                        desc=f"{inst_id}.{table_name}", layer="source", source=src_key,
                        tags=["source"],
                    )
                    # Register under instance-qualified key for per-instance lineage
                    self.ds[f"source.{inst_id}.{table_name}"] = ds_urn
                    self.add_columns(f"source.{inst_id}.{table_name}", ds_urn, columns, "source", src_key)

    def build_staging(self, domain: str):
        """S3 staging + Airflow ingestion — one prefix and DAG per source instance."""
        logger.info("  Staging layer (S3 + Airflow)...")

        s3 = self.node(
            EntityType.DATA_PLATFORM, "AWS S3", parent=domain,
            desc="Amazon S3 — data lake staging zone", source="aws_s3",
        )

        airflow = self.node(
            EntityType.SYSTEM, "Apache Airflow", parent=domain,
            desc="Airflow orchestration — schedules daily ingestion DAGs",
            source="airflow",
        )

        # One staging prefix + one Airflow DAG per source instance
        for src_key, src_def in SOURCES.items():
            for inst in src_def["instances"]:
                inst_id = inst["id"]
                region = inst.get("region", "")

                staging_container = self.node(
                    EntityType.CONTAINER, f"acme-data-lake/staging/{inst_id}",
                    parent=s3,
                    desc=f"Raw landing zone for {inst['name']} ({region})",
                    layer="staging", source="aws_s3",
                    props={"region": region},
                )

                ingest_flow = self.node(
                    EntityType.DATA_FLOW, f"ingest_{inst_id}", parent=airflow,
                    desc=f"Daily extract: {inst['name']} → S3 staging",
                    source="airflow",
                    props={"schedule": "0 4 * * *", "region": region},
                )

                for table_name, columns in src_def["tables"].items():
                    job = self.node(
                        EntityType.DATA_JOB, f"extract_{inst_id}_{table_name}",
                        parent=ingest_flow,
                        desc=f"Extract {inst_id}.{table_name} → S3 Parquet",
                        source="airflow",
                    )
                    src_ds = self.ds.get(f"source.{inst_id}.{table_name}")
                    if src_ds:
                        self.edge(job, src_ds, EdgeType.CONSUMES)

                    stg_ds = self.node(
                        EntityType.DATASET, f"raw_{table_name}", parent=staging_container,
                        desc=f"Raw copy of {inst_id}.{table_name}",
                        layer="staging", source="aws_s3",
                        tags=["staging", "raw"],
                    )
                    self.ds[f"staging.{inst_id}.{table_name}"] = stg_ds
                    self.edge(job, stg_ds, EdgeType.PRODUCES)

                    # Column-level: source → staging (1:1 pass-through)
                    for col_name, dtype, is_pii, col_desc in columns:
                        stg_col = self.node(
                            EntityType.SCHEMA_FIELD, col_name, parent=stg_ds,
                            desc=f"Raw copy: {col_desc}",
                            props={"dataType": dtype},
                            tags=["pii"] if is_pii else [],
                        )
                        self.col[f"staging.{inst_id}.{table_name}.{col_name}"] = stg_col
                        src_col = self.col.get(f"source.{inst_id}.{table_name}.{col_name}")
                        if src_col:
                            self.edge(src_col, stg_col, EdgeType.TRANSFORMS,
                                      {"logic": "raw pass-through"})

    def build_bronze(self, databricks: str):
        """Bronze layer: per-instance Delta copies from staging."""
        logger.info("  Bronze layer (Databricks Delta)...")

        bronze_flow = self.node(
            EntityType.DATA_FLOW, "bronze_autoloader", parent=databricks,
            desc="Databricks Auto Loader: S3 staging → Delta bronze",
            source="databricks",
        )

        # One bronze container per source instance (keeps provenance separate)
        for src_key, src_def in SOURCES.items():
            for inst in src_def["instances"]:
                inst_id = inst["id"]

                bronze_container = self.node(
                    EntityType.CONTAINER, f"data_lake.bronze.{inst_id}",
                    parent=databricks,
                    desc=f"Bronze schema for {inst['name']} — immutable Delta Lake",
                    layer="bronze", source="databricks",
                )

                for table_name, columns in src_def["tables"].items():
                    job = self.node(
                        EntityType.DATA_JOB, f"bronze_{inst_id}_{table_name}",
                        parent=bronze_flow,
                        desc=f"Auto Loader: {inst_id}.raw_{table_name} → bronze_{table_name}",
                        source="databricks",
                    )
                    stg_ds = self.ds.get(f"staging.{inst_id}.{table_name}")
                    if stg_ds:
                        self.edge(job, stg_ds, EdgeType.CONSUMES)

                    brz_ds = self.node(
                        EntityType.DATASET, f"bronze_{table_name}", parent=bronze_container,
                        desc=f"Immutable history of {inst_id}.{table_name}",
                        layer="bronze", source="databricks",
                        tags=["bronze", "delta"],
                    )
                    self.ds[f"bronze.{inst_id}.{table_name}"] = brz_ds
                    self.edge(job, brz_ds, EdgeType.PRODUCES)

                    for col_name, dtype, is_pii, col_desc in columns:
                        brz_col = self.node(
                            EntityType.SCHEMA_FIELD, col_name, parent=brz_ds,
                            desc=col_desc, props={"dataType": dtype},
                            tags=["pii"] if is_pii else [],
                        )
                        self.col[f"bronze.{inst_id}.{table_name}.{col_name}"] = brz_col
                        stg_col = self.col.get(f"staging.{inst_id}.{table_name}.{col_name}")
                        if stg_col:
                            self.edge(stg_col, brz_col, EdgeType.TRANSFORMS,
                                      {"logic": "append-only copy"})

    def build_silver(self, databricks: str, dbt: str):
        """Silver layer: consolidated from all bronze instances via dbt."""
        logger.info("  Silver layer (dbt transforms — consolidation point)...")

        silver_container = self.node(
            EntityType.CONTAINER, "data_lake.silver", parent=databricks,
            desc="Silver schema — cleaned, typed, deduplicated (Delta, MERGE upserts). "
                 "Consolidation point: all regional instances merge here.",
            layer="silver", source="databricks",
        )
        silver_flow = self.node(
            EntityType.DATA_FLOW, "silver_transforms", parent=dbt,
            desc="dbt project: bronze → silver (cleaning, dedup, type casting, regional merge)",
            source="dbt",
        )

        # Collect all instance IDs for bronze lookups
        all_instance_ids = []
        for src_def in SOURCES.values():
            for inst in src_def["instances"]:
                all_instance_ids.append(inst["id"])

        for silver_table, spec in SILVER_TABLES.items():
            job = self.node(
                EntityType.DATA_JOB, f"dbt_{silver_table}", parent=silver_flow,
                desc=f"dbt model: {silver_table} (UNION ALL across regions + dedup)",
                source="dbt",
            )
            # CONSUMES from every bronze instance that has matching source tables
            for src_table in spec["sources"]:
                for inst_id in all_instance_ids:
                    brz_ds = self.ds.get(f"bronze.{inst_id}.{src_table}")
                    if brz_ds:
                        self.edge(job, brz_ds, EdgeType.CONSUMES)

            silver_ds = self.node(
                EntityType.DATASET, silver_table, parent=silver_container,
                desc=spec["description"], layer="silver", source="dbt",
                tags=["silver", "cleaned", "consolidated"],
            )
            self.ds[f"silver.{silver_table}"] = silver_ds
            self.edge(job, silver_ds, EdgeType.PRODUCES)

            for col_name, dtype, src_refs, logic, col_desc in spec["columns"]:
                col_urn = self.node(
                    EntityType.SCHEMA_FIELD, col_name, parent=silver_ds,
                    desc=col_desc, props={"dataType": dtype, "transformLogic": logic},
                )
                self.col[f"silver.{silver_table}.{col_name}"] = col_urn
                # TRANSFORMS from ALL bronze instances that have the source column
                for src_table, src_col in src_refs:
                    for inst_id in all_instance_ids:
                        brz_col = self.col.get(f"bronze.{inst_id}.{src_table}.{src_col}")
                        if brz_col:
                            self.edge(brz_col, col_urn, EdgeType.TRANSFORMS, {"logic": logic})

    def build_gold(self, snowflake: str, dbt: str):
        """Gold layer: star schema dims + facts in Snowflake."""
        logger.info("  Gold layer (Snowflake star schema)...")

        gold_container = self.node(
            EntityType.CONTAINER, "ANALYTICS.GOLD", parent=snowflake,
            desc="Gold schema — conformed dimensional model (star schema)",
            layer="gold", source="snowflake",
        )
        gold_flow = self.node(
            EntityType.DATA_FLOW, "gold_dimensional_model", parent=dbt,
            desc="dbt project: silver → gold star schema", source="dbt",
        )

        # Dimensions
        for dim_name, spec in GOLD_DIMS.items():
            self._build_gold_table(dim_name, spec, gold_container, gold_flow, "silver")

        # Facts
        for fact_name, spec in GOLD_FACTS.items():
            self._build_gold_table(fact_name, spec, gold_container, gold_flow, "silver")
            # fact DEPENDS_ON each dimension
            for dim_name in spec.get("dims", []):
                fact_urn = self.ds.get(f"gold.{fact_name}")
                dim_urn = self.ds.get(f"gold.{dim_name}")
                if fact_urn and dim_urn:
                    self.edge(fact_urn, dim_urn, EdgeType.DEPENDS_ON,
                              {"reason": "star schema FK join"})

    def _build_gold_table(self, table_name, spec, container, flow, src_layer):
        job = self.node(
            EntityType.DATA_JOB, f"dbt_{table_name}", parent=flow,
            desc=f"dbt model: {table_name}", source="dbt",
        )
        for src_table in spec["sources"]:
            src_ds = self.ds.get(f"{src_layer}.{src_table}")
            if src_ds:
                self.edge(job, src_ds, EdgeType.CONSUMES)

        ds_urn = self.node(
            EntityType.DATASET, table_name, parent=container,
            desc=spec["description"], layer="gold", source="snowflake",
            tags=["gold", "dimensional"],
        )
        self.ds[f"gold.{table_name}"] = ds_urn
        self.edge(job, ds_urn, EdgeType.PRODUCES)

        if "Certified" in self.tag_urns:
            self.edge(ds_urn, self.tag_urns["Certified"], EdgeType.TAGGED_WITH)

        for col_name, dtype, src_refs, logic, col_desc in spec["columns"]:
            col_urn = self.node(
                EntityType.SCHEMA_FIELD, col_name, parent=ds_urn,
                desc=col_desc, props={"dataType": dtype, "transformLogic": logic},
            )
            self.col[f"gold.{table_name}.{col_name}"] = col_urn
            for src_table, src_col in src_refs:
                src_col_urn = self.col.get(f"{src_layer}.{src_table}.{src_col}")
                if src_col_urn:
                    self.edge(src_col_urn, col_urn, EdgeType.TRANSFORMS, {"logic": logic})

    def build_reporting(self, snowflake: str, dbt: str):
        """Reporting mart tables + Tableau dashboards."""
        logger.info("  Reporting layer (marts + dashboards)...")

        rpt_container = self.node(
            EntityType.CONTAINER, "ANALYTICS.REPORTING", parent=snowflake,
            desc="Reporting schema — pre-aggregated mart tables for BI",
            layer="mart", source="snowflake",
        )
        rpt_flow = self.node(
            EntityType.DATA_FLOW, "reporting_marts", parent=dbt,
            desc="dbt project: gold → reporting marts", source="dbt",
        )

        for rpt_name, spec in REPORTING_TABLES.items():
            job = self.node(
                EntityType.DATA_JOB, f"dbt_{rpt_name}", parent=rpt_flow,
                desc=f"dbt model: {rpt_name}", source="dbt",
            )
            for src_table in spec["sources"]:
                src_ds = self.ds.get(f"gold.{src_table}")
                if src_ds:
                    self.edge(job, src_ds, EdgeType.CONSUMES)

            rpt_ds = self.node(
                EntityType.DATASET, rpt_name, parent=rpt_container,
                desc=spec["description"], layer="mart", source="snowflake",
                tags=["mart", "reporting"],
            )
            self.ds[f"mart.{rpt_name}"] = rpt_ds
            self.edge(job, rpt_ds, EdgeType.PRODUCES)
            if "Certified" in self.tag_urns:
                self.edge(rpt_ds, self.tag_urns["Certified"], EdgeType.TAGGED_WITH)

            for col_name, dtype, src_refs, logic, col_desc in spec["columns"]:
                col_urn = self.node(
                    EntityType.SCHEMA_FIELD, col_name, parent=rpt_ds,
                    desc=col_desc,
                    props={"dataType": dtype, "aggregationLogic": logic},
                )
                self.col[f"mart.{rpt_name}.{col_name}"] = col_urn
                for src_table, src_col in src_refs:
                    src_col_urn = self.col.get(f"gold.{src_table}.{src_col}")
                    if src_col_urn:
                        self.edge(src_col_urn, col_urn, EdgeType.TRANSFORMS,
                                  {"logic": logic})

    def build_dashboards(self, domain: str):
        """Tableau dashboards that CONSUME reporting datasets."""
        logger.info("  Dashboards (Tableau)...")

        tableau = self.node(
            EntityType.SYSTEM, "Tableau Cloud", parent=domain,
            desc="Tableau Cloud BI platform", source="tableau",
        )
        self.node(
            EntityType.CONTAINER, "acme-analytics / Enterprise Analytics",
            parent=tableau, desc="Production Tableau site and project",
            layer="consumption", source="tableau",
        )

        for dash_name, dash_spec in DASHBOARDS.items():
            dash = self.node(
                EntityType.DASHBOARD, dash_name, parent=tableau,
                desc=dash_spec["description"], layer="consumption",
                source="tableau",
            )
            for chart_name, source_table, source_cols in dash_spec["charts"]:
                chart = self.node(
                    EntityType.CHART, chart_name, parent=dash,
                    desc=f"Tableau worksheet: {chart_name}",
                    source="tableau",
                )
                # chart CONSUMES the reporting dataset
                rpt_ds = self.ds.get(f"mart.{source_table}")
                if rpt_ds:
                    self.edge(chart, rpt_ds, EdgeType.CONSUMES)
                # chart CONSUMES each referenced column
                for col_name in source_cols:
                    col_urn = self.col.get(f"mart.{source_table}.{col_name}")
                    if col_urn:
                        self.edge(chart, col_urn, EdgeType.CONSUMES)

    def build_glossary_wiring(self):
        """Wire glossary terms to relevant columns via DEFINED_BY."""
        logger.info("  Glossary wiring (DEFINED_BY)...")
        wiring = {
            "Revenue": ["gold.fact_orders.total_amount", "mart.rpt_daily_revenue.total_revenue"],
            "Gross Profit": ["gold.fact_orders.gross_profit", "mart.rpt_daily_revenue.total_profit"],
            "AOV": ["mart.rpt_daily_revenue.avg_order_value"],
            "SLA Compliance": ["mart.rpt_fulfillment.on_time_pct"],
        }
        count = 0
        for term, col_paths in wiring.items():
            term_urn = self.glossary_urns.get(term)
            if not term_urn:
                continue
            for path in col_paths:
                col_urn = self.col.get(path)
                if col_urn:
                    self.edge(col_urn, term_urn, EdgeType.DEFINED_BY)
                    count += 1
        logger.info(f"    Wired {count} DEFINED_BY edges")

    # ── Orchestrator ─────────────────────────────────────────────────

    def build(self, business_units: int = 1):
        """Build the graph. If business_units > 1, replicate the full pipeline
        for each business unit under a shared enterprise domain."""
        start = time.time()
        logger.info("=" * 60)
        logger.info("Building end-to-end Data Platform lineage graph...")
        if business_units > 1:
            logger.info(f"  Business units: {business_units}")
        logger.info("=" * 60)

        # Root domain
        enterprise = self.node(
            EntityType.DOMAIN, "Enterprise Data Platform",
            desc="End-to-end data platform: sources → warehouse → reporting",
        )

        self.build_governance(enterprise)

        for bu_idx in range(business_units):
            if business_units > 1:
                bu_name = _BU_NAMES[bu_idx % len(_BU_NAMES)]
                if bu_idx >= len(_BU_NAMES):
                    bu_name = f"{bu_name} {bu_idx // len(_BU_NAMES) + 1}"
                logger.info(f"  ── Business Unit: {bu_name} ──")
                domain = self.node(
                    EntityType.DOMAIN, bu_name,
                    desc=f"Business unit: {bu_name}",
                )
                # BU domain is peer to enterprise (both are root domains)
                # Link via RELATED_TO is not ontology-valid; keep flat domains
            else:
                domain = enterprise

            # Shared systems (per BU so containment is correct)
            dbt = self.node(
                EntityType.SYSTEM, "dbt Cloud" if business_units == 1 else f"dbt Cloud ({bu_name})",
                parent=domain,
                desc="dbt Cloud — SQL-based transformation platform", source="dbt",
            )
            databricks = self.node(
                EntityType.SYSTEM, "Databricks" if business_units == 1 else f"Databricks ({bu_name})",
                parent=domain,
                desc="Databricks Lakehouse — Unity Catalog + Spark processing",
                source="databricks",
            )
            snowflake = self.node(
                EntityType.DATA_PLATFORM, "Snowflake" if business_units == 1 else f"Snowflake ({bu_name})",
                parent=domain,
                desc="Snowflake enterprise data warehouse", source="snowflake",
            )

            self.build_sources(domain)
            self.build_staging(domain)
            self.build_bronze(databricks)
            self.build_silver(databricks, dbt)
            self.build_gold(snowflake, dbt)
            self.build_reporting(snowflake, dbt)
            self.build_dashboards(domain)

        self.build_glossary_wiring()

        elapsed = time.time() - start
        logger.info("=" * 60)
        logger.info(f"Complete in {elapsed:.2f}s: {len(self.nodes):,} nodes, {len(self.edges):,} edges")
        self._print_stats()

    def _print_stats(self):
        from collections import Counter
        nc = Counter()
        for n in self.nodes:
            nc[n.entity_type.value if hasattr(n.entity_type, "value") else str(n.entity_type)] += 1
        ec = Counter()
        for e in self.edges:
            ec[e.edge_type.value if hasattr(e.edge_type, "value") else str(e.edge_type)] += 1
        lc = Counter()
        for n in self.nodes:
            lc[n.layer_assignment or "(none)"] += 1
        logger.info("  Nodes:")
        for k, v in sorted(nc.items(), key=lambda x: -x[1]):
            logger.info(f"    {k:20s} {v:5d}")
        logger.info("  Edges:")
        for k, v in sorted(ec.items(), key=lambda x: -x[1]):
            logger.info(f"    {k:20s} {v:5d}")
        logger.info("  Layers:")
        for k, v in sorted(lc.items(), key=lambda x: -x[1]):
            logger.info(f"    {k:20s} {v:5d}")


# ═══════════════════════════════════════════════════════════════════════════
# FalkorDB Push
# ═══════════════════════════════════════════════════════════════════════════

async def push_to_falkordb(builder: PlatformLineageBuilder, graph_name: str):
    from falkordb.asyncio import FalkorDB

    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))
    db = FalkorDB(host=host, port=port)
    graph = db.select_graph(graph_name)
    logger.info(f"Connected to FalkorDB {host}:{port} — graph: {graph_name}")

    CHUNK = 5000

    nodes_by_label: Dict[str, List[Dict]] = {}
    for n in builder.nodes:
        label = n.entity_type.value if hasattr(n.entity_type, "value") else str(n.entity_type)
        nodes_by_label.setdefault(label, []).append({
            "urn": n.urn, "displayName": n.display_name or "",
            "qualifiedName": n.qualified_name or "",
            "description": n.description or "",
            "properties": json.dumps(n.properties),
            "tags": json.dumps(n.tags or []),
            "layerAssignment": n.layer_assignment or "",
            "sourceSystem": n.source_system or "",
            "lastSyncedAt": n.last_synced_at or "",
            "childCount": n.child_count or 0,
        })

    for label, batch_nodes in nodes_by_label.items():
        logger.info(f"  Pushing {len(batch_nodes):>5d} {label} nodes...")
        for i in range(0, len(batch_nodes), CHUNK):
            batch = batch_nodes[i:i + CHUNK]
            await graph.query(f"""
                UNWIND $batch AS map
                MERGE (n:{label} {{urn: map.urn}})
                SET n.displayName = map.displayName,
                    n.qualifiedName = map.qualifiedName,
                    n.description = map.description,
                    n.properties = map.properties,
                    n.tags = map.tags,
                    n.layerAssignment = map.layerAssignment,
                    n.sourceSystem = map.sourceSystem,
                    n.lastSyncedAt = map.lastSyncedAt,
                    n.childCount = map.childCount
            """, params={"batch": batch})

    edges_grouped: Dict[Tuple[str, str, str], List[Dict]] = {}
    for e in builder.edges:
        etype = e.edge_type.value if hasattr(e.edge_type, "value") else str(e.edge_type)
        sl = builder.urn_to_label.get(e.source_urn)
        tl = builder.urn_to_label.get(e.target_urn)
        if not sl or not tl:
            continue
        edges_grouped.setdefault((sl, tl, etype), []).append({
            "src": e.source_urn, "tgt": e.target_urn, "id": e.id,
            "confidence": e.confidence if e.confidence is not None else 1.0,
            "props": json.dumps(e.properties),
        })

    for (sl, tl, etype), batch_edges in edges_grouped.items():
        logger.info(f"  Pushing {len(batch_edges):>5d} ({sl})-[:{etype}]->({tl})...")
        for i in range(0, len(batch_edges), CHUNK):
            batch = batch_edges[i:i + CHUNK]
            await graph.query(f"""
                UNWIND $batch AS map
                MATCH (a:{sl} {{urn: map.src}})
                MATCH (b:{tl} {{urn: map.tgt}})
                MERGE (a)-[r:{etype}]->(b)
                SET r.id = map.id, r.confidence = map.confidence, r.properties = map.props
            """, params={"batch": batch})

    for label in nodes_by_label:
        for prop in ("urn", "displayName"):
            try:
                await graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
            except Exception:
                pass

    logger.info("FalkorDB push complete!")


async def materialize_aggregated(graph_name: str):
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))
    provider = FalkorDBProvider(host=host, port=port, graph_name=graph_name)
    await provider._ensure_connected()
    logger.info("Materializing AGGREGATED edges...")
    result = await provider.materialize_aggregated_edges_batch(batch_size=1000)
    logger.info(f"Materialization result: {result}")


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="End-to-end Data Platform Lineage Seeder",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python backend/scripts/seed_platform_lineage.py --dry-run
  python backend/scripts/seed_platform_lineage.py --push --graph my_platform
  python backend/scripts/seed_platform_lineage.py --push --materialize
  python backend/scripts/seed_platform_lineage.py --dump-json platform.json
        """,
    )
    parser.add_argument("--dry-run", action="store_true", help="Build graph and print stats only")
    parser.add_argument("--push", action="store_true", help="Push to FalkorDB")
    parser.add_argument("--materialize", action="store_true", help="Materialize AGGREGATED edges after push")
    parser.add_argument("--graph", type=str, default="data_platform", help="FalkorDB graph name")
    parser.add_argument("--dump-json", type=str, default=None, help="Dump graph to JSON file")
    parser.add_argument("--scale", type=int, default=1,
                        help="Scale multiplier (1=base ~600 nodes, 10=~6k, 100=~60k, 1000=~500k)")
    args = parser.parse_args()

    if not args.push and not args.dry_run and not args.dump_json:
        parser.print_help()
        print("\nSpecify --push or --dry-run")
        sys.exit(1)

    apply_scale(args.scale)

    # Determine how many business units to create based on scale.
    # Each BU replicates the full pipeline. The data expansion from
    # apply_scale (more instances, tables, columns) is the fine-grained
    # knob; BU replication is the coarse-grained multiplier.
    if args.scale <= 1:
        bu_count = 1
    elif args.scale <= 5:
        bu_count = 1  # just more instances/tables
    elif args.scale <= 20:
        bu_count = 2
    elif args.scale <= 50:
        bu_count = 3
    else:
        # At scale 100+, use BU replication as the main multiplier.
        # Each BU produces ~3-4k nodes (after apply_scale), so
        # scale 100 → ~8 BUs → ~30k nodes, scale 1000 → ~60 BUs → ~240k
        base_per_bu = 4000  # approx nodes per BU after expansion
        target = args.scale * 600  # target total nodes
        bu_count = max(4, min(len(_BU_NAMES) * 3, target // base_per_bu))

    builder = PlatformLineageBuilder()
    builder.build(business_units=bu_count)

    if args.dump_json:
        data = {
            "nodes": [n.model_dump(by_alias=True) for n in builder.nodes],
            "edges": [e.model_dump(by_alias=True) for e in builder.edges],
        }
        with open(args.dump_json, "w") as f:
            json.dump(data, f, indent=2, default=str)
        logger.info(f"Dumped to {args.dump_json}")

    if args.push:
        try:
            asyncio.run(push_to_falkordb(builder, graph_name=args.graph))
        except KeyboardInterrupt:
            logger.warning("Interrupted.")
            sys.exit(1)
        except Exception as e:
            logger.error(f"Push failed: {e}")
            import traceback; traceback.print_exc()
            sys.exit(1)

        if args.materialize:
            try:
                asyncio.run(materialize_aggregated(graph_name=args.graph))
            except Exception as e:
                logger.error(f"Materialization failed: {e}")
                import traceback; traceback.print_exc()
