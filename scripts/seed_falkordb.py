#!/usr/bin/env python3
"""
Enterprise Data Lineage Seeder for FalkorDB.

Generates a single, unified enterprise data platform graph with realistic
column-level lineage flowing LEFT → RIGHT across multiple internal systems:

  ┌─────────────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐    ┌───────────┐    ┌────────────┐
  │ Source Systems   │ →  │ Staging  │ →  │ Silver  │ →  │  Gold    │ →  │ Reporting │ →  │ Dashboards │
  │ (Operational)    │    │ (Raw 1:1)│    │ (Clean) │    │ (Joined) │    │ (Marts)   │    │ (BI)       │
  └─────────────────┘    └──────────┘    └─────────┘    └──────────┘    └───────────┘    └────────────┘
  SAP S/4HANA (ERP)       Snowflake       Snowflake      Snowflake       Snowflake        Tableau
  Salesforce (CRM)        RAW schema      CLEAN schema   ANALYTICS       MARTS schema     Looker
  Shopify (Commerce)                                     schema
  Stripe (Payments)
  Workday (HCM)
  Zendesk (Support)
  Segment (Product)

Cross-domain lineage in Gold layer:
  - dim_customer  ← Shopify customers ⊕ Salesforce contacts ⊕ Zendesk users (email hash)
  - fact_orders   ← Shopify orders ⊕ Stripe charges ⊕ dim_customer ⊕ dim_product
  - fact_revenue  ← SAP GL ⊕ Shopify orders ⊕ Salesforce opportunities (reconciliation)
  - rpt_customer_360 ← dim_customer ⊕ fact_orders ⊕ fact_support ⊕ fact_pipeline

AGGREGATED edge materialization is optional (--materialize).

Usage:
  python backend/scripts/seed_falkordb.py --graph nexus_lineage
  python backend/scripts/seed_falkordb.py --graph nexus_lineage --breadth 2 --depth 3 --scale 5
  python backend/scripts/seed_falkordb.py --graph nexus_lineage --materialize
  python backend/scripts/seed_falkordb.py --graph nexus_lineage --dry-run
"""

import argparse
import asyncio
import logging
import os
import sys
import uuid
from typing import Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphNode, GraphEdge, EntityType, EdgeType

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("seed_falkordb")


# ═══════════════════════════════════════════════════════════════════════════
# SOURCE SYSTEMS  (leftmost in lineage — operational databases)
# ═══════════════════════════════════════════════════════════════════════════
# Each column: (name, data_type, nullable, is_pii, description)

SOURCES: Dict[str, dict] = {
    # ── SAP S/4HANA  (ERP — Finance) ──────────────────────────────────
    "sap": {
        "platform": "SAP S/4HANA",
        "domain": "Finance",
        "container": "S4H_PROD",
        "tables": {
            "BKPF_Journal_Headers": [
                ("doc_number", "varchar(10)", False, False, "Accounting document number"),
                ("company_code", "varchar(4)", False, False, "Company code"),
                ("fiscal_year", "int", False, False, "Fiscal year"),
                ("period", "int", False, False, "Fiscal period 1-16"),
                ("posting_date", "date", False, False, "Posting date"),
                ("doc_type", "varchar(2)", False, False, "Document type (SA/RE/KR/etc.)"),
                ("reference", "varchar(16)", True, False, "Reference/invoice number"),
                ("total_amount", "decimal(15,2)", False, False, "Total document amount"),
                ("currency", "varchar(5)", False, False, "Document currency"),
                ("user_name", "varchar(12)", True, True, "Posting user"),
            ],
            "BSEG_Journal_Lines": [
                ("doc_number", "varchar(10)", False, False, "Accounting document FK"),
                ("company_code", "varchar(4)", False, False, "Company code FK"),
                ("fiscal_year", "int", False, False, "Fiscal year FK"),
                ("line_item", "int", False, False, "Line item number"),
                ("gl_account", "varchar(10)", False, False, "G/L account number"),
                ("cost_center", "varchar(10)", True, False, "Cost center"),
                ("profit_center", "varchar(10)", True, False, "Profit center"),
                ("debit_amount", "decimal(15,2)", True, False, "Debit in local currency"),
                ("credit_amount", "decimal(15,2)", True, False, "Credit in local currency"),
                ("tax_code", "varchar(2)", True, False, "Tax code"),
            ],
            "KNA1_Customer_Master": [
                ("customer_number", "varchar(10)", False, False, "Customer account number"),
                ("name1", "varchar(35)", False, True, "Customer name line 1"),
                ("name2", "varchar(35)", True, True, "Customer name line 2"),
                ("country", "varchar(3)", False, False, "Country key"),
                ("region", "varchar(3)", True, False, "Region/state"),
                ("postal_code", "varchar(10)", True, True, "Postal code"),
                ("industry", "varchar(4)", True, False, "Industry key"),
                ("created_date", "date", False, False, "Master record creation date"),
            ],
            "VBAP_Sales_Items": [
                ("sales_doc", "varchar(10)", False, False, "Sales document number"),
                ("item_number", "int", False, False, "Line item number"),
                ("material", "varchar(40)", False, False, "Material/product number"),
                ("quantity", "decimal(13,3)", False, False, "Order quantity"),
                ("net_value", "decimal(15,2)", False, False, "Net value in document currency"),
                ("currency", "varchar(5)", False, False, "Document currency"),
                ("plant", "varchar(4)", False, False, "Delivering plant"),
                ("sales_org", "varchar(4)", False, False, "Sales organization"),
                ("created_date", "timestamp", False, False, "Document creation date"),
            ],
        },
    },

    # ── Salesforce  (CRM — Sales) ─────────────────────────────────────
    "sfdc": {
        "platform": "Salesforce",
        "domain": "Sales",
        "container": "SFDC_PROD",
        "tables": {
            "SF_Accounts": [
                ("account_id", "varchar(18)", False, False, "Account ID (18-char)"),
                ("account_name", "varchar(255)", False, False, "Company name"),
                ("industry", "varchar(100)", True, False, "Industry classification"),
                ("annual_revenue", "decimal(15,2)", True, False, "Annual revenue"),
                ("employee_count", "int", True, False, "Number of employees"),
                ("billing_country", "varchar(80)", True, False, "Billing country"),
                ("account_type", "varchar(50)", True, False, "Customer/Prospect/Partner"),
                ("owner_id", "varchar(18)", True, False, "Account owner user ID"),
                ("created_date", "timestamp", False, False, "Record creation timestamp"),
            ],
            "SF_Contacts": [
                ("contact_id", "varchar(18)", False, False, "Contact ID"),
                ("account_id", "varchar(18)", True, False, "Parent account FK"),
                ("first_name", "varchar(100)", True, True, "First name"),
                ("last_name", "varchar(100)", False, True, "Last name"),
                ("email", "varchar(255)", True, True, "Email address"),
                ("title", "varchar(128)", True, False, "Job title"),
                ("department", "varchar(100)", True, False, "Department"),
                ("lead_source", "varchar(100)", True, False, "Original lead source"),
                ("created_date", "timestamp", False, False, "Record creation timestamp"),
            ],
            "SF_Opportunities": [
                ("opportunity_id", "varchar(18)", False, False, "Opportunity ID"),
                ("account_id", "varchar(18)", True, False, "Account FK"),
                ("name", "varchar(255)", False, False, "Opportunity name"),
                ("stage", "varchar(50)", False, False, "Pipeline stage"),
                ("amount", "decimal(15,2)", True, False, "Deal amount"),
                ("probability", "decimal(5,2)", True, False, "Close probability %"),
                ("close_date", "date", True, False, "Expected close date"),
                ("type", "varchar(50)", True, False, "New Business/Renewal/Upsell"),
                ("owner_id", "varchar(18)", True, False, "Opportunity owner"),
                ("created_date", "timestamp", False, False, "Record creation timestamp"),
            ],
        },
    },

    # ── Shopify  (E-Commerce — Commerce) ──────────────────────────────
    "shopify": {
        "platform": "Shopify",
        "domain": "Commerce",
        "container": "SHOPIFY_PROD",
        "tables": {
            "SH_Orders": [
                ("order_id", "bigint", False, False, "Order ID"),
                ("order_number", "varchar(20)", False, False, "Human-readable order number"),
                ("customer_id", "bigint", False, False, "Customer FK"),
                ("email", "varchar(255)", True, True, "Customer email at order time"),
                ("order_date", "timestamp", False, False, "Order placement timestamp"),
                ("financial_status", "varchar(30)", False, False, "pending/paid/refunded"),
                ("fulfillment_status", "varchar(30)", True, False, "fulfilled/partial/null"),
                ("subtotal", "decimal(12,2)", False, False, "Subtotal before tax/shipping"),
                ("total_tax", "decimal(12,2)", False, False, "Total tax"),
                ("total_shipping", "decimal(12,2)", False, False, "Shipping cost"),
                ("total_discounts", "decimal(12,2)", False, False, "Discounts applied"),
                ("total_price", "decimal(12,2)", False, False, "Final order total"),
                ("currency", "varchar(3)", False, False, "Order currency"),
                ("channel", "varchar(30)", False, False, "web/pos/mobile/marketplace"),
            ],
            "SH_Line_Items": [
                ("line_item_id", "bigint", False, False, "Line item ID"),
                ("order_id", "bigint", False, False, "Order FK"),
                ("product_id", "bigint", False, False, "Product FK"),
                ("variant_id", "bigint", True, False, "Variant FK"),
                ("sku", "varchar(50)", False, False, "Stock keeping unit"),
                ("title", "varchar(255)", False, False, "Product title at sale time"),
                ("quantity", "int", False, False, "Units ordered"),
                ("unit_price", "decimal(10,2)", False, False, "Price per unit"),
                ("total_discount", "decimal(10,2)", False, False, "Line-level discount"),
            ],
            "SH_Products": [
                ("product_id", "bigint", False, False, "Product ID"),
                ("title", "varchar(255)", False, False, "Product title"),
                ("vendor", "varchar(100)", True, False, "Vendor/brand name"),
                ("product_type", "varchar(100)", True, False, "Product category"),
                ("status", "varchar(20)", False, False, "active/draft/archived"),
                ("cost_price", "decimal(10,2)", True, False, "Cost/COGS per unit"),
                ("list_price", "decimal(10,2)", True, False, "MSRP/list price"),
                ("inventory_quantity", "int", True, False, "Stock on hand"),
            ],
            "SH_Customers": [
                ("customer_id", "bigint", False, False, "Customer ID"),
                ("email", "varchar(255)", True, True, "Customer email"),
                ("first_name", "varchar(100)", True, True, "First name"),
                ("last_name", "varchar(100)", True, True, "Last name"),
                ("orders_count", "int", False, False, "Lifetime order count"),
                ("total_spent", "decimal(12,2)", False, False, "Lifetime spend"),
                ("country", "varchar(3)", True, False, "Country code"),
                ("created_date", "timestamp", False, False, "Registration timestamp"),
            ],
        },
    },

    # ── Stripe  (Payments — Finance) ──────────────────────────────────
    "stripe": {
        "platform": "Stripe",
        "domain": "Finance",
        "container": "STRIPE_PROD",
        "tables": {
            "ST_Charges": [
                ("charge_id", "varchar(30)", False, False, "Stripe charge ID (ch_xxx)"),
                ("amount", "bigint", False, False, "Charge amount in cents"),
                ("currency", "varchar(3)", False, False, "ISO currency"),
                ("status", "varchar(20)", False, False, "succeeded/pending/failed"),
                ("customer_id", "varchar(30)", True, False, "Stripe customer ID"),
                ("payment_method", "varchar(30)", True, False, "card/bank_transfer/etc."),
                ("created", "timestamp", False, False, "Charge timestamp"),
                ("metadata_order_id", "varchar(50)", True, False, "Shopify order ID (metadata)"),
            ],
            "ST_Refunds": [
                ("refund_id", "varchar(30)", False, False, "Stripe refund ID (re_xxx)"),
                ("charge_id", "varchar(30)", False, False, "Parent charge FK"),
                ("amount", "bigint", False, False, "Refund amount in cents"),
                ("reason", "varchar(50)", True, False, "duplicate/fraudulent/requested"),
                ("status", "varchar(20)", False, False, "succeeded/pending/failed"),
                ("created", "timestamp", False, False, "Refund timestamp"),
            ],
        },
    },

    # ── Workday  (HCM — People) ───────────────────────────────────────
    "workday": {
        "platform": "Workday",
        "domain": "People",
        "container": "WD_HCM_PROD",
        "tables": {
            "WD_Workers": [
                ("worker_id", "varchar(36)", False, False, "Worker WID (UUID)"),
                ("employee_id", "varchar(20)", False, False, "Employee ID"),
                ("first_name", "varchar(100)", False, True, "Legal first name"),
                ("last_name", "varchar(100)", False, True, "Legal last name"),
                ("email", "varchar(255)", False, True, "Work email"),
                ("hire_date", "date", False, False, "Original hire date"),
                ("termination_date", "date", True, False, "Termination date"),
                ("department_name", "varchar(100)", False, False, "Supervisory org name"),
                ("job_title", "varchar(200)", False, False, "Business title"),
                ("location", "varchar(100)", False, False, "Work location"),
                ("manager_id", "varchar(36)", True, False, "Manager worker ID"),
                ("worker_type", "varchar(20)", False, False, "Employee/Contingent"),
            ],
            "WD_Compensation": [
                ("worker_id", "varchar(36)", False, False, "Worker WID FK"),
                ("base_pay", "decimal(12,2)", False, False, "Annual base pay"),
                ("bonus_target_pct", "decimal(5,2)", True, False, "Target bonus %"),
                ("currency", "varchar(3)", False, False, "Pay currency"),
                ("effective_date", "date", False, False, "Effective date"),
                ("pay_grade", "varchar(10)", True, False, "Pay grade/band"),
                ("compa_ratio", "decimal(5,2)", True, False, "Compa-ratio to midpoint"),
            ],
        },
    },

    # ── Zendesk  (Support — Customer Success) ─────────────────────────
    "zendesk": {
        "platform": "Zendesk",
        "domain": "Support",
        "container": "ZD_PROD",
        "tables": {
            "ZD_Tickets": [
                ("ticket_id", "bigint", False, False, "Ticket ID"),
                ("requester_email", "varchar(255)", True, True, "Requester email"),
                ("subject", "varchar(255)", False, False, "Ticket subject"),
                ("status", "varchar(20)", False, False, "new/open/pending/solved/closed"),
                ("priority", "varchar(10)", True, False, "low/normal/high/urgent"),
                ("channel", "varchar(20)", False, False, "email/chat/phone/web"),
                ("assignee_id", "bigint", True, False, "Assigned agent ID"),
                ("group_name", "varchar(100)", True, False, "Support group"),
                ("created_at", "timestamp", False, False, "Ticket creation timestamp"),
                ("solved_at", "timestamp", True, False, "Resolution timestamp"),
                ("satisfaction_rating", "varchar(10)", True, False, "good/bad/offered/unoffered"),
            ],
        },
    },

    # ── Segment  (Product Analytics — Product) ────────────────────────
    "segment": {
        "platform": "Segment",
        "domain": "Product",
        "container": "SEGMENT_PROD",
        "tables": {
            "SEG_Tracks": [
                ("event_id", "varchar(36)", False, False, "Event UUID"),
                ("user_id", "varchar(50)", True, False, "Application user ID"),
                ("anonymous_id", "varchar(50)", True, False, "Anonymous visitor ID"),
                ("event_name", "varchar(100)", False, False, "Event name (page_viewed, etc.)"),
                ("timestamp", "timestamp", False, False, "Event timestamp"),
                ("context_page_url", "varchar(2048)", True, False, "Page URL"),
                ("context_device_type", "varchar(20)", True, False, "desktop/mobile/tablet"),
                ("properties_plan", "varchar(30)", True, False, "User subscription plan"),
                ("properties_feature", "varchar(100)", True, False, "Feature interacted with"),
            ],
            "SEG_Identifies": [
                ("user_id", "varchar(50)", False, False, "Application user ID"),
                ("email", "varchar(255)", True, True, "User email"),
                ("name", "varchar(200)", True, True, "User display name"),
                ("company_name", "varchar(200)", True, False, "Company/org name"),
                ("plan", "varchar(30)", True, False, "Subscription plan"),
                ("created_at", "timestamp", True, False, "User signup timestamp"),
            ],
        },
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# SILVER LAYER  (cleaned, typed, deduplicated)
# ═══════════════════════════════════════════════════════════════════════════
# Column format: (name, type, [(upstream_table, upstream_col), ...], logic, desc)

SILVER = {
    # ── Finance (SAP) ─────────────────────────────────────────────────
    "clean_gl_postings": {
        "sources": ["sap.BKPF_Journal_Headers", "sap.BSEG_Journal_Lines"],
        "columns": [
            ("doc_number", "varchar(10)", [("sap.BKPF_Journal_Headers", "doc_number")], "pass-through", "Document key"),
            ("company_code", "varchar(4)", [("sap.BKPF_Journal_Headers", "company_code")], "pass-through", "Company code"),
            ("fiscal_year", "int", [("sap.BKPF_Journal_Headers", "fiscal_year")], "pass-through", "Fiscal year"),
            ("period", "int", [("sap.BKPF_Journal_Headers", "period")], "pass-through", "Period"),
            ("posting_date", "date", [("sap.BKPF_Journal_Headers", "posting_date")], "pass-through", "Posting date"),
            ("doc_type", "varchar(2)", [("sap.BKPF_Journal_Headers", "doc_type")], "pass-through", "Doc type"),
            ("reference", "varchar(16)", [("sap.BKPF_Journal_Headers", "reference")], "TRIM(reference)", "Reference"),
            ("gl_account", "varchar(10)", [("sap.BSEG_Journal_Lines", "gl_account")], "pass-through", "G/L account"),
            ("cost_center", "varchar(10)", [("sap.BSEG_Journal_Lines", "cost_center")], "COALESCE(cost_center, '0000000000')", "Cost center"),
            ("profit_center", "varchar(10)", [("sap.BSEG_Journal_Lines", "profit_center")], "COALESCE(profit_center, '0000000000')", "Profit center"),
            ("net_amount", "decimal(15,2)", [("sap.BSEG_Journal_Lines", "debit_amount"), ("sap.BSEG_Journal_Lines", "credit_amount")], "COALESCE(debit,0) - COALESCE(credit,0)", "Net amount"),
            ("currency", "varchar(3)", [("sap.BKPF_Journal_Headers", "currency")], "UPPER(LEFT(currency,3))", "ISO currency"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_sap_customers": {
        "sources": ["sap.KNA1_Customer_Master"],
        "columns": [
            ("customer_number", "varchar(10)", [("sap.KNA1_Customer_Master", "customer_number")], "pass-through", "Customer key"),
            ("customer_name", "varchar(70)", [("sap.KNA1_Customer_Master", "name1"), ("sap.KNA1_Customer_Master", "name2")], "CONCAT(TRIM(name1), ' ', COALESCE(TRIM(name2),''))", "Full name"),
            ("country", "varchar(3)", [("sap.KNA1_Customer_Master", "country")], "UPPER(country)", "Country code"),
            ("region", "varchar(3)", [("sap.KNA1_Customer_Master", "region")], "COALESCE(region, 'N/A')", "Region"),
            ("industry_code", "varchar(4)", [("sap.KNA1_Customer_Master", "industry")], "COALESCE(industry, '0000')", "Industry"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_sales_items": {
        "sources": ["sap.VBAP_Sales_Items"],
        "columns": [
            ("sales_doc", "varchar(10)", [("sap.VBAP_Sales_Items", "sales_doc")], "pass-through", "Sales document"),
            ("item_number", "int", [("sap.VBAP_Sales_Items", "item_number")], "pass-through", "Line item"),
            ("material", "varchar(40)", [("sap.VBAP_Sales_Items", "material")], "UPPER(TRIM(material))", "Material key"),
            ("quantity", "decimal(13,3)", [("sap.VBAP_Sales_Items", "quantity")], "ABS(quantity)", "Quantity"),
            ("net_value", "decimal(15,2)", [("sap.VBAP_Sales_Items", "net_value")], "pass-through", "Net value"),
            ("net_value_usd", "decimal(15,2)", [("sap.VBAP_Sales_Items", "net_value"), ("sap.VBAP_Sales_Items", "currency")], "net_value * fx_rate_to_usd(currency)", "USD value"),
            ("currency", "varchar(3)", [("sap.VBAP_Sales_Items", "currency")], "UPPER(LEFT(currency,3))", "Currency"),
            ("plant", "varchar(4)", [("sap.VBAP_Sales_Items", "plant")], "pass-through", "Plant"),
            ("sales_org", "varchar(4)", [("sap.VBAP_Sales_Items", "sales_org")], "pass-through", "Sales org"),
            ("created_date", "date", [("sap.VBAP_Sales_Items", "created_date")], "CAST AS DATE", "Created"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── CRM (Salesforce) ──────────────────────────────────────────────
    "clean_accounts": {
        "sources": ["sfdc.SF_Accounts"],
        "columns": [
            ("account_id", "varchar(18)", [("sfdc.SF_Accounts", "account_id")], "pass-through", "Account PK"),
            ("account_name", "varchar(255)", [("sfdc.SF_Accounts", "account_name")], "TRIM(account_name)", "Name"),
            ("industry", "varchar(100)", [("sfdc.SF_Accounts", "industry")], "COALESCE(industry, 'Unknown')", "Industry"),
            ("annual_revenue", "decimal(15,2)", [("sfdc.SF_Accounts", "annual_revenue")], "COALESCE(annual_revenue, 0)", "Revenue"),
            ("employee_count", "int", [("sfdc.SF_Accounts", "employee_count")], "COALESCE(employee_count, 0)", "Employees"),
            ("country", "varchar(80)", [("sfdc.SF_Accounts", "billing_country")], "UPPER(TRIM(billing_country))", "Country"),
            ("account_type", "varchar(50)", [("sfdc.SF_Accounts", "account_type")], "LOWER(account_type)", "Type"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_contacts": {
        "sources": ["sfdc.SF_Contacts"],
        "columns": [
            ("contact_id", "varchar(18)", [("sfdc.SF_Contacts", "contact_id")], "pass-through", "Contact PK"),
            ("account_id", "varchar(18)", [("sfdc.SF_Contacts", "account_id")], "pass-through", "Account FK"),
            ("full_name", "varchar(200)", [("sfdc.SF_Contacts", "first_name"), ("sfdc.SF_Contacts", "last_name")], "CONCAT(first_name, ' ', last_name)", "Full name"),
            ("email_hash", "varchar(64)", [("sfdc.SF_Contacts", "email")], "SHA256(LOWER(TRIM(email)))", "Email hash"),
            ("title", "varchar(128)", [("sfdc.SF_Contacts", "title")], "COALESCE(title, 'N/A')", "Title"),
            ("department", "varchar(100)", [("sfdc.SF_Contacts", "department")], "COALESCE(department, 'N/A')", "Department"),
            ("lead_source", "varchar(100)", [("sfdc.SF_Contacts", "lead_source")], "COALESCE(LOWER(lead_source), 'unknown')", "Source"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_opportunities": {
        "sources": ["sfdc.SF_Opportunities"],
        "columns": [
            ("opportunity_id", "varchar(18)", [("sfdc.SF_Opportunities", "opportunity_id")], "pass-through", "Opp PK"),
            ("account_id", "varchar(18)", [("sfdc.SF_Opportunities", "account_id")], "pass-through", "Account FK"),
            ("name", "varchar(255)", [("sfdc.SF_Opportunities", "name")], "TRIM(name)", "Deal name"),
            ("stage", "varchar(50)", [("sfdc.SF_Opportunities", "stage")], "pass-through", "Stage"),
            ("amount", "decimal(15,2)", [("sfdc.SF_Opportunities", "amount")], "COALESCE(amount, 0)", "Amount"),
            ("probability", "decimal(5,2)", [("sfdc.SF_Opportunities", "probability")], "COALESCE(probability, 0)", "Probability"),
            ("weighted_amount", "decimal(15,2)", [("sfdc.SF_Opportunities", "amount"), ("sfdc.SF_Opportunities", "probability")], "amount * probability / 100", "Weighted pipeline"),
            ("close_date", "date", [("sfdc.SF_Opportunities", "close_date")], "pass-through", "Close date"),
            ("type", "varchar(50)", [("sfdc.SF_Opportunities", "type")], "COALESCE(type, 'New Business')", "Type"),
            ("is_closed_won", "boolean", [("sfdc.SF_Opportunities", "stage")], "stage = 'Closed Won'", "Win flag"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── Commerce (Shopify) ────────────────────────────────────────────
    "clean_orders": {
        "sources": ["shopify.SH_Orders"],
        "columns": [
            ("order_id", "bigint", [("shopify.SH_Orders", "order_id")], "pass-through", "Order PK"),
            ("customer_id", "bigint", [("shopify.SH_Orders", "customer_id")], "pass-through", "Customer FK"),
            ("email_hash", "varchar(64)", [("shopify.SH_Orders", "email")], "SHA256(LOWER(TRIM(email)))", "Email hash (join key)"),
            ("order_date", "date", [("shopify.SH_Orders", "order_date")], "CAST AS DATE", "Order date"),
            ("status", "varchar(30)", [("shopify.SH_Orders", "financial_status")], "LOWER(financial_status)", "Financial status"),
            ("subtotal", "decimal(12,2)", [("shopify.SH_Orders", "subtotal")], "pass-through", "Subtotal"),
            ("tax_amount", "decimal(12,2)", [("shopify.SH_Orders", "total_tax")], "COALESCE(total_tax, 0)", "Tax"),
            ("shipping_amount", "decimal(12,2)", [("shopify.SH_Orders", "total_shipping")], "COALESCE(total_shipping, 0)", "Shipping"),
            ("discount_amount", "decimal(12,2)", [("shopify.SH_Orders", "total_discounts")], "COALESCE(total_discounts, 0)", "Discount"),
            ("total_amount", "decimal(12,2)", [("shopify.SH_Orders", "total_price")], "pass-through", "Total"),
            ("net_revenue", "decimal(12,2)", [("shopify.SH_Orders", "total_price"), ("shopify.SH_Orders", "total_discounts")], "total_price - COALESCE(total_discounts, 0)", "Net revenue"),
            ("channel", "varchar(30)", [("shopify.SH_Orders", "channel")], "LOWER(channel)", "Channel"),
            ("currency", "varchar(3)", [("shopify.SH_Orders", "currency")], "UPPER(currency)", "Currency"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_order_items": {
        "sources": ["shopify.SH_Line_Items"],
        "columns": [
            ("line_item_id", "bigint", [("shopify.SH_Line_Items", "line_item_id")], "pass-through", "PK"),
            ("order_id", "bigint", [("shopify.SH_Line_Items", "order_id")], "pass-through", "Order FK"),
            ("product_id", "bigint", [("shopify.SH_Line_Items", "product_id")], "pass-through", "Product FK"),
            ("sku", "varchar(50)", [("shopify.SH_Line_Items", "sku")], "UPPER(TRIM(sku))", "SKU"),
            ("quantity", "int", [("shopify.SH_Line_Items", "quantity")], "pass-through", "Quantity"),
            ("unit_price", "decimal(10,2)", [("shopify.SH_Line_Items", "unit_price")], "pass-through", "Unit price"),
            ("line_total", "decimal(12,2)", [("shopify.SH_Line_Items", "quantity"), ("shopify.SH_Line_Items", "unit_price")], "quantity * unit_price", "Line total"),
            ("line_discount", "decimal(10,2)", [("shopify.SH_Line_Items", "total_discount")], "COALESCE(total_discount, 0)", "Discount"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_products": {
        "sources": ["shopify.SH_Products"],
        "columns": [
            ("product_id", "bigint", [("shopify.SH_Products", "product_id")], "pass-through", "Product PK"),
            ("title", "varchar(255)", [("shopify.SH_Products", "title")], "TRIM(title)", "Title"),
            ("vendor", "varchar(100)", [("shopify.SH_Products", "vendor")], "COALESCE(vendor, 'Unbranded')", "Vendor"),
            ("product_type", "varchar(100)", [("shopify.SH_Products", "product_type")], "COALESCE(INITCAP(product_type), 'Uncategorized')", "Category"),
            ("cost_price", "decimal(10,2)", [("shopify.SH_Products", "cost_price")], "COALESCE(cost_price, 0)", "COGS"),
            ("list_price", "decimal(10,2)", [("shopify.SH_Products", "list_price")], "COALESCE(list_price, 0)", "MSRP"),
            ("margin_pct", "decimal(5,2)", [("shopify.SH_Products", "list_price"), ("shopify.SH_Products", "cost_price")], "(list_price - cost_price) / NULLIF(list_price, 0) * 100", "Margin %"),
            ("is_active", "boolean", [("shopify.SH_Products", "status")], "status = 'active'", "Active"),
            ("inventory_quantity", "int", [("shopify.SH_Products", "inventory_quantity")], "COALESCE(inventory_quantity, 0)", "Inventory"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_ecomm_customers": {
        "sources": ["shopify.SH_Customers"],
        "columns": [
            ("customer_id", "bigint", [("shopify.SH_Customers", "customer_id")], "pass-through", "Customer PK"),
            ("email_hash", "varchar(64)", [("shopify.SH_Customers", "email")], "SHA256(LOWER(TRIM(email)))", "Email hash"),
            ("full_name", "varchar(200)", [("shopify.SH_Customers", "first_name"), ("shopify.SH_Customers", "last_name")], "CONCAT(first_name, ' ', last_name)", "Full name"),
            ("orders_count", "int", [("shopify.SH_Customers", "orders_count")], "pass-through", "Orders"),
            ("total_spent", "decimal(12,2)", [("shopify.SH_Customers", "total_spent")], "pass-through", "Lifetime spend"),
            ("country", "varchar(3)", [("shopify.SH_Customers", "country")], "UPPER(COALESCE(country, 'N/A'))", "Country"),
            ("signup_date", "date", [("shopify.SH_Customers", "created_date")], "CAST AS DATE", "Signup date"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── Payments (Stripe) ─────────────────────────────────────────────
    "clean_charges": {
        "sources": ["stripe.ST_Charges", "stripe.ST_Refunds"],
        "columns": [
            ("charge_id", "varchar(30)", [("stripe.ST_Charges", "charge_id")], "pass-through", "Charge PK"),
            ("order_id", "varchar(50)", [("stripe.ST_Charges", "metadata_order_id")], "COALESCE(metadata_order_id, 'unlinked')", "Shopify order ID"),
            ("gross_amount", "decimal(12,2)", [("stripe.ST_Charges", "amount")], "amount / 100.0", "Gross charge ($)"),
            ("refund_amount", "decimal(12,2)", [("stripe.ST_Refunds", "amount")], "COALESCE(SUM(amount), 0) / 100.0", "Total refunds ($)"),
            ("net_amount", "decimal(12,2)", [("stripe.ST_Charges", "amount"), ("stripe.ST_Refunds", "amount")], "(charge - refund) / 100.0", "Net settled ($)"),
            ("currency", "varchar(3)", [("stripe.ST_Charges", "currency")], "UPPER(currency)", "Currency"),
            ("charge_status", "varchar(20)", [("stripe.ST_Charges", "status")], "LOWER(status)", "Status"),
            ("payment_method", "varchar(30)", [("stripe.ST_Charges", "payment_method")], "COALESCE(payment_method, 'unknown')", "Method"),
            ("charge_date", "timestamp", [("stripe.ST_Charges", "created")], "pass-through", "Charge timestamp"),
            ("refund_reason", "varchar(50)", [("stripe.ST_Refunds", "reason")], "COALESCE(reason, 'none')", "Refund reason"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── People (Workday) ──────────────────────────────────────────────
    "clean_employees": {
        "sources": ["workday.WD_Workers", "workday.WD_Compensation"],
        "columns": [
            ("worker_id", "varchar(36)", [("workday.WD_Workers", "worker_id")], "pass-through", "Worker PK"),
            ("employee_id", "varchar(20)", [("workday.WD_Workers", "employee_id")], "pass-through", "Employee ID"),
            ("full_name", "varchar(200)", [("workday.WD_Workers", "first_name"), ("workday.WD_Workers", "last_name")], "CONCAT(first_name, ' ', last_name)", "Full name"),
            ("email", "varchar(255)", [("workday.WD_Workers", "email")], "LOWER(TRIM(email))", "Email"),
            ("hire_date", "date", [("workday.WD_Workers", "hire_date")], "pass-through", "Hire date"),
            ("is_active", "boolean", [("workday.WD_Workers", "termination_date")], "termination_date IS NULL", "Active flag"),
            ("department", "varchar(100)", [("workday.WD_Workers", "department_name")], "TRIM(department_name)", "Department"),
            ("job_title", "varchar(200)", [("workday.WD_Workers", "job_title")], "TRIM(job_title)", "Title"),
            ("location", "varchar(100)", [("workday.WD_Workers", "location")], "pass-through", "Location"),
            ("worker_type", "varchar(20)", [("workday.WD_Workers", "worker_type")], "LOWER(worker_type)", "Type"),
            ("tenure_days", "int", [("workday.WD_Workers", "hire_date")], "DATEDIFF(CURRENT_DATE, hire_date)", "Tenure"),
            ("base_pay", "decimal(12,2)", [("workday.WD_Compensation", "base_pay")], "LATEST by effective_date", "Base pay"),
            ("total_comp", "decimal(12,2)", [("workday.WD_Compensation", "base_pay"), ("workday.WD_Compensation", "bonus_target_pct")], "base_pay * (1 + COALESCE(bonus_target_pct,0)/100)", "Total comp"),
            ("pay_grade", "varchar(10)", [("workday.WD_Compensation", "pay_grade")], "COALESCE(pay_grade, 'UNGRADED')", "Grade"),
            ("compa_ratio", "decimal(5,2)", [("workday.WD_Compensation", "compa_ratio")], "COALESCE(compa_ratio, 1.00)", "Compa-ratio"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── Support (Zendesk) ─────────────────────────────────────────────
    "clean_tickets": {
        "sources": ["zendesk.ZD_Tickets"],
        "columns": [
            ("ticket_id", "bigint", [("zendesk.ZD_Tickets", "ticket_id")], "pass-through", "Ticket PK"),
            ("requester_email_hash", "varchar(64)", [("zendesk.ZD_Tickets", "requester_email")], "SHA256(LOWER(TRIM(requester_email)))", "Email hash (join key)"),
            ("subject", "varchar(255)", [("zendesk.ZD_Tickets", "subject")], "TRIM(subject)", "Subject"),
            ("status", "varchar(20)", [("zendesk.ZD_Tickets", "status")], "LOWER(status)", "Status"),
            ("priority", "varchar(10)", [("zendesk.ZD_Tickets", "priority")], "COALESCE(LOWER(priority), 'normal')", "Priority"),
            ("channel", "varchar(20)", [("zendesk.ZD_Tickets", "channel")], "LOWER(channel)", "Channel"),
            ("group_name", "varchar(100)", [("zendesk.ZD_Tickets", "group_name")], "COALESCE(group_name, 'Unassigned')", "Group"),
            ("created_at", "timestamp", [("zendesk.ZD_Tickets", "created_at")], "pass-through", "Created"),
            ("solved_at", "timestamp", [("zendesk.ZD_Tickets", "solved_at")], "pass-through", "Solved"),
            ("resolution_hours", "decimal(8,1)", [("zendesk.ZD_Tickets", "created_at"), ("zendesk.ZD_Tickets", "solved_at")], "DATEDIFF(HOUR, created_at, solved_at)", "Hours to resolve"),
            ("csat", "varchar(10)", [("zendesk.ZD_Tickets", "satisfaction_rating")], "COALESCE(satisfaction_rating, 'unoffered')", "CSAT"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── Product (Segment) ─────────────────────────────────────────────
    "clean_product_events": {
        "sources": ["segment.SEG_Tracks", "segment.SEG_Identifies"],
        "columns": [
            ("event_id", "varchar(36)", [("segment.SEG_Tracks", "event_id")], "pass-through", "Event PK"),
            ("user_id", "varchar(50)", [("segment.SEG_Tracks", "user_id")], "COALESCE(user_id, anonymous_id)", "User ID"),
            ("email_hash", "varchar(64)", [("segment.SEG_Identifies", "email")], "SHA256(LOWER(TRIM(email)))", "Email hash (join key)"),
            ("event_name", "varchar(100)", [("segment.SEG_Tracks", "event_name")], "LOWER(TRIM(event_name))", "Event"),
            ("timestamp", "timestamp", [("segment.SEG_Tracks", "timestamp")], "pass-through", "Timestamp"),
            ("page_url", "varchar(2048)", [("segment.SEG_Tracks", "context_page_url")], "pass-through", "Page URL"),
            ("device_type", "varchar(20)", [("segment.SEG_Tracks", "context_device_type")], "LOWER(context_device_type)", "Device"),
            ("plan", "varchar(30)", [("segment.SEG_Identifies", "plan")], "COALESCE(plan, 'free')", "Plan"),
            ("feature", "varchar(100)", [("segment.SEG_Tracks", "properties_feature")], "COALESCE(properties_feature, 'general')", "Feature"),
            ("company_name", "varchar(200)", [("segment.SEG_Identifies", "company_name")], "TRIM(company_name)", "Company"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# GOLD LAYER  (dimensional model — CROSS-DOMAIN joins happen here)
# ═══════════════════════════════════════════════════════════════════════════

GOLD = {
    # ── Conformed Dimensions ──────────────────────────────────────────
    "dim_customer": {
        "description": "Unified customer — Shopify ⊕ Salesforce ⊕ Zendesk via email_hash",
        "columns": [
            ("customer_key", "bigint", [("clean_ecomm_customers", "customer_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("ecomm_customer_id", "bigint", [("clean_ecomm_customers", "customer_id")], "pass-through", "Shopify ID"),
            ("sfdc_contact_id", "varchar(18)", [("clean_contacts", "contact_id")], "LEFT JOIN on email_hash", "Salesforce contact ID"),
            ("sfdc_account_id", "varchar(18)", [("clean_contacts", "account_id")], "via contact", "Salesforce account ID"),
            ("full_name", "varchar(200)", [("clean_ecomm_customers", "full_name"), ("clean_contacts", "full_name")], "COALESCE(ecomm.full_name, sfdc.full_name)", "Best-known name"),
            ("email_hash", "varchar(64)", [("clean_ecomm_customers", "email_hash"), ("clean_contacts", "email_hash")], "COALESCE — identity key", "Email hash"),
            ("country", "varchar(80)", [("clean_ecomm_customers", "country"), ("clean_accounts", "country")], "COALESCE(ecomm.country, sfdc.country)", "Country"),
            ("industry", "varchar(100)", [("clean_accounts", "industry")], "via account", "CRM industry"),
            ("account_type", "varchar(50)", [("clean_accounts", "account_type")], "via account", "CRM account type"),
            ("lifetime_orders", "int", [("clean_ecomm_customers", "orders_count")], "pass-through", "Lifetime orders"),
            ("lifetime_spend", "decimal(12,2)", [("clean_ecomm_customers", "total_spent")], "pass-through", "Lifetime spend"),
            ("signup_date", "date", [("clean_ecomm_customers", "signup_date")], "pass-through", "First registration"),
            ("lead_source", "varchar(100)", [("clean_contacts", "lead_source")], "pass-through", "Original lead source"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "dim_product": {
        "description": "Product dimension from Shopify catalog",
        "columns": [
            ("product_key", "bigint", [("clean_products", "product_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("product_id", "bigint", [("clean_products", "product_id")], "pass-through", "Shopify product ID"),
            ("title", "varchar(255)", [("clean_products", "title")], "pass-through", "Title"),
            ("vendor", "varchar(100)", [("clean_products", "vendor")], "pass-through", "Vendor"),
            ("product_type", "varchar(100)", [("clean_products", "product_type")], "pass-through", "Category"),
            ("cost_price", "decimal(10,2)", [("clean_products", "cost_price")], "pass-through", "COGS"),
            ("list_price", "decimal(10,2)", [("clean_products", "list_price")], "pass-through", "MSRP"),
            ("margin_pct", "decimal(5,2)", [("clean_products", "margin_pct")], "pass-through", "Margin %"),
            ("is_active", "boolean", [("clean_products", "is_active")], "pass-through", "Active"),
            ("inventory_quantity", "int", [("clean_products", "inventory_quantity")], "pass-through", "Inventory"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "dim_employee": {
        "description": "Employee dimension from Workday",
        "columns": [
            ("employee_key", "bigint", [("clean_employees", "worker_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("worker_id", "varchar(36)", [("clean_employees", "worker_id")], "pass-through", "Worker WID"),
            ("full_name", "varchar(200)", [("clean_employees", "full_name")], "pass-through", "Name"),
            ("department", "varchar(100)", [("clean_employees", "department")], "pass-through", "Department"),
            ("job_title", "varchar(200)", [("clean_employees", "job_title")], "pass-through", "Title"),
            ("is_active", "boolean", [("clean_employees", "is_active")], "pass-through", "Active"),
            ("tenure_days", "int", [("clean_employees", "tenure_days")], "pass-through", "Tenure"),
            ("base_pay", "decimal(12,2)", [("clean_employees", "base_pay")], "pass-through", "Base pay"),
            ("total_comp", "decimal(12,2)", [("clean_employees", "total_comp")], "pass-through", "Total comp"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },

    # ── Facts (cross-domain joins) ────────────────────────────────────
    "fact_orders": {
        "description": "Order fact — Shopify orders ⊕ line items ⊕ Stripe payments ⊕ dims",
        "columns": [
            ("order_key", "bigint", [("clean_orders", "order_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN on email_hash", "Customer FK"),
            ("product_key", "bigint", [("dim_product", "product_key")], "JOIN via line_items.product_id", "Product FK"),
            ("order_id", "bigint", [("clean_orders", "order_id")], "pass-through", "Shopify order ID"),
            ("order_date", "date", [("clean_orders", "order_date")], "pass-through", "Order date"),
            ("channel", "varchar(30)", [("clean_orders", "channel")], "pass-through", "Channel"),
            ("quantity", "int", [("clean_order_items", "quantity")], "SUM per order", "Total units"),
            ("subtotal", "decimal(12,2)", [("clean_orders", "subtotal")], "pass-through", "Subtotal"),
            ("discount_amount", "decimal(12,2)", [("clean_orders", "discount_amount")], "pass-through", "Discount"),
            ("total_amount", "decimal(12,2)", [("clean_orders", "total_amount")], "pass-through", "Total"),
            ("net_revenue", "decimal(12,2)", [("clean_orders", "net_revenue")], "pass-through", "Net revenue"),
            ("cogs", "decimal(12,2)", [("clean_order_items", "quantity"), ("clean_products", "cost_price")], "SUM(qty * cost_price)", "COGS"),
            ("gross_profit", "decimal(12,2)", [("clean_orders", "net_revenue"), ("clean_order_items", "quantity"), ("clean_products", "cost_price")], "net_revenue - cogs", "Gross profit"),
            ("payment_gross", "decimal(12,2)", [("clean_charges", "gross_amount")], "JOIN on order_id", "Payment captured"),
            ("payment_refund", "decimal(12,2)", [("clean_charges", "refund_amount")], "JOIN on order_id", "Refunds"),
            ("payment_net", "decimal(12,2)", [("clean_charges", "net_amount")], "JOIN on order_id", "Net settled"),
            ("payment_method", "varchar(30)", [("clean_charges", "payment_method")], "JOIN on order_id", "Payment method"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "fact_revenue": {
        "description": "Revenue reconciliation — SAP GL ⊕ Shopify orders ⊕ SFDC pipeline",
        "columns": [
            ("revenue_key", "bigint", [("clean_sales_items", "sales_doc"), ("clean_sales_items", "item_number")], "SURROGATE_KEY()", "Surrogate key"),
            ("posting_date", "date", [("clean_gl_postings", "posting_date")], "pass-through", "GL posting date"),
            ("cost_center", "varchar(10)", [("clean_gl_postings", "cost_center")], "pass-through", "Cost center"),
            ("profit_center", "varchar(10)", [("clean_gl_postings", "profit_center")], "pass-through", "Profit center"),
            ("gl_amount", "decimal(15,2)", [("clean_gl_postings", "net_amount")], "SUM WHERE revenue accounts", "GL-booked amount"),
            ("ecomm_revenue", "decimal(15,2)", [("clean_orders", "net_revenue")], "SUM for period", "E-commerce revenue"),
            ("sap_sales_revenue", "decimal(15,2)", [("clean_sales_items", "net_value_usd")], "SUM for period", "SAP sales revenue"),
            ("sfdc_closed_won", "decimal(15,2)", [("clean_opportunities", "amount")], "SUM WHERE is_closed_won", "CRM closed-won"),
            ("recon_variance", "decimal(15,2)", [("clean_gl_postings", "net_amount"), ("clean_orders", "net_revenue"), ("clean_sales_items", "net_value_usd")], "gl - (ecomm + sap_sales)", "Reconciliation variance"),
            ("currency", "varchar(3)", [("clean_sales_items", "currency")], "pass-through", "Currency"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "fact_pipeline": {
        "description": "Sales pipeline — Salesforce opportunities ⊕ accounts",
        "columns": [
            ("pipeline_key", "bigint", [("clean_opportunities", "opportunity_id")], "pass-through", "Pipeline key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN via account_id → email_hash", "Customer FK"),
            ("account_name", "varchar(255)", [("clean_accounts", "account_name")], "JOIN on account_id", "Account"),
            ("account_industry", "varchar(100)", [("clean_accounts", "industry")], "JOIN on account_id", "Industry"),
            ("stage", "varchar(50)", [("clean_opportunities", "stage")], "pass-through", "Stage"),
            ("amount", "decimal(15,2)", [("clean_opportunities", "amount")], "pass-through", "Deal value"),
            ("weighted_amount", "decimal(15,2)", [("clean_opportunities", "weighted_amount")], "pass-through", "Weighted pipeline"),
            ("close_date", "date", [("clean_opportunities", "close_date")], "pass-through", "Close date"),
            ("type", "varchar(50)", [("clean_opportunities", "type")], "pass-through", "Type"),
            ("is_closed_won", "boolean", [("clean_opportunities", "is_closed_won")], "pass-through", "Won"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "fact_support": {
        "description": "Support tickets — Zendesk ⊕ unified customer",
        "columns": [
            ("ticket_key", "bigint", [("clean_tickets", "ticket_id")], "pass-through", "Ticket key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN on email_hash", "Customer FK"),
            ("status", "varchar(20)", [("clean_tickets", "status")], "pass-through", "Status"),
            ("priority", "varchar(10)", [("clean_tickets", "priority")], "pass-through", "Priority"),
            ("channel", "varchar(20)", [("clean_tickets", "channel")], "pass-through", "Channel"),
            ("group_name", "varchar(100)", [("clean_tickets", "group_name")], "pass-through", "Group"),
            ("created_at", "timestamp", [("clean_tickets", "created_at")], "pass-through", "Created"),
            ("resolution_hours", "decimal(8,1)", [("clean_tickets", "resolution_hours")], "pass-through", "Hours to resolve"),
            ("csat", "varchar(10)", [("clean_tickets", "csat")], "pass-through", "CSAT"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "fact_product_usage": {
        "description": "Product analytics — Segment events ⊕ unified customer",
        "columns": [
            ("event_key", "varchar(36)", [("clean_product_events", "event_id")], "pass-through", "Event key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN on email_hash", "Customer FK"),
            ("event_name", "varchar(100)", [("clean_product_events", "event_name")], "pass-through", "Event"),
            ("timestamp", "timestamp", [("clean_product_events", "timestamp")], "pass-through", "Timestamp"),
            ("device_type", "varchar(20)", [("clean_product_events", "device_type")], "pass-through", "Device"),
            ("plan", "varchar(30)", [("clean_product_events", "plan")], "pass-through", "Plan"),
            ("feature", "varchar(100)", [("clean_product_events", "feature")], "pass-through", "Feature"),
            ("company_name", "varchar(200)", [("clean_product_events", "company_name")], "pass-through", "Company"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# REPORTING LAYER  (aggregated marts — pull from gold facts + dims)
# ═══════════════════════════════════════════════════════════════════════════

REPORTING = {
    "rpt_customer_360": {
        "description": "Unified customer profile — orders ⊕ support ⊕ pipeline ⊕ product usage",
        "columns": [
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "pass-through", "Customer key"),
            ("full_name", "varchar(200)", [("dim_customer", "full_name")], "pass-through", "Name"),
            ("country", "varchar(80)", [("dim_customer", "country")], "pass-through", "Country"),
            ("industry", "varchar(100)", [("dim_customer", "industry")], "pass-through", "Industry"),
            ("lifetime_orders", "int", [("dim_customer", "lifetime_orders")], "pass-through", "Lifetime orders"),
            ("lifetime_revenue", "decimal(15,2)", [("fact_orders", "net_revenue")], "SUM(net_revenue)", "Lifetime revenue"),
            ("lifetime_profit", "decimal(15,2)", [("fact_orders", "gross_profit")], "SUM(gross_profit)", "Lifetime profit"),
            ("avg_order_value", "decimal(10,2)", [("fact_orders", "total_amount"), ("fact_orders", "order_key")], "SUM(total)/COUNT(DISTINCT order)", "AOV"),
            ("open_pipeline", "decimal(15,2)", [("fact_pipeline", "amount"), ("fact_pipeline", "is_closed_won")], "SUM WHERE NOT is_closed_won", "Open pipeline"),
            ("total_tickets", "int", [("fact_support", "ticket_key")], "COUNT(*)", "Support tickets"),
            ("avg_resolution_hrs", "decimal(8,1)", [("fact_support", "resolution_hours")], "AVG(resolution_hours)", "Avg resolution (hrs)"),
            ("csat_good_pct", "decimal(5,2)", [("fact_support", "csat")], "COUNT(good)/COUNT(*)*100", "CSAT good %"),
            ("product_events_30d", "int", [("fact_product_usage", "event_key")], "COUNT LAST 30 DAYS", "Product events 30d"),
            ("last_active_date", "date", [("fact_product_usage", "timestamp")], "MAX(timestamp)::DATE", "Last active"),
        ],
    },
    "rpt_executive_kpis": {
        "description": "C-suite KPIs — revenue, pipeline, support, product in one view",
        "columns": [
            ("period", "varchar(7)", [("fact_orders", "order_date")], "TO_CHAR(order_date, 'YYYY-MM')", "Period"),
            ("gross_revenue", "decimal(15,2)", [("fact_orders", "total_amount")], "SUM(total_amount)", "Gross revenue"),
            ("net_revenue", "decimal(15,2)", [("fact_orders", "net_revenue")], "SUM(net_revenue)", "Net revenue"),
            ("cogs", "decimal(15,2)", [("fact_orders", "cogs")], "SUM(cogs)", "COGS"),
            ("gross_margin_pct", "decimal(5,2)", [("fact_orders", "gross_profit"), ("fact_orders", "net_revenue")], "SUM(profit)/SUM(revenue)*100", "Gross margin %"),
            ("order_count", "int", [("fact_orders", "order_key")], "COUNT(DISTINCT)", "Orders"),
            ("gl_booked", "decimal(15,2)", [("fact_revenue", "gl_amount")], "SUM(gl_amount)", "GL booked revenue"),
            ("recon_variance", "decimal(15,2)", [("fact_revenue", "recon_variance")], "SUM(ABS(recon_variance))", "Recon variance"),
            ("pipeline_value", "decimal(15,2)", [("fact_pipeline", "amount")], "SUM(amount)", "Total pipeline"),
            ("weighted_pipeline", "decimal(15,2)", [("fact_pipeline", "weighted_amount")], "SUM(weighted_amount)", "Weighted pipeline"),
            ("win_rate", "decimal(5,2)", [("fact_pipeline", "is_closed_won"), ("fact_pipeline", "pipeline_key")], "COUNT(won)/COUNT(*)*100", "Win rate %"),
            ("open_tickets", "int", [("fact_support", "status")], "COUNT WHERE status IN ('new','open')", "Open tickets"),
            ("avg_csat", "decimal(5,2)", [("fact_support", "csat")], "CSAT good %", "Avg CSAT"),
            ("mau", "int", [("fact_product_usage", "customer_key")], "COUNT(DISTINCT) LAST 30 DAYS", "Monthly active users"),
        ],
    },
    "rpt_monthly_revenue": {
        "description": "Monthly revenue breakdown by channel, customer segment, cost center",
        "columns": [
            ("month_key", "int", [("fact_orders", "order_date")], "YEAR*100 + MONTH", "Year-month"),
            ("channel", "varchar(30)", [("fact_orders", "channel")], "GROUP BY", "Channel"),
            ("total_revenue", "decimal(15,2)", [("fact_orders", "net_revenue")], "SUM(net_revenue)", "Revenue"),
            ("total_cogs", "decimal(15,2)", [("fact_orders", "cogs")], "SUM(cogs)", "COGS"),
            ("gross_profit", "decimal(15,2)", [("fact_orders", "gross_profit")], "SUM(gross_profit)", "Gross profit"),
            ("order_count", "int", [("fact_orders", "order_key")], "COUNT(DISTINCT)", "Orders"),
            ("unique_customers", "int", [("fact_orders", "customer_key")], "COUNT(DISTINCT)", "Unique buyers"),
            ("avg_order_value", "decimal(10,2)", [("fact_orders", "total_amount"), ("fact_orders", "order_key")], "SUM/COUNT", "AOV"),
            ("refund_amount", "decimal(15,2)", [("fact_orders", "payment_refund")], "SUM(payment_refund)", "Refunds"),
        ],
    },
    "rpt_sales_performance": {
        "description": "Sales rep/team pipeline performance",
        "columns": [
            ("account_industry", "varchar(100)", [("fact_pipeline", "account_industry")], "GROUP BY", "Industry"),
            ("total_pipeline", "decimal(15,2)", [("fact_pipeline", "amount")], "SUM(amount)", "Pipeline"),
            ("weighted_pipeline", "decimal(15,2)", [("fact_pipeline", "weighted_amount")], "SUM(weighted_amount)", "Weighted"),
            ("deals_open", "int", [("fact_pipeline", "pipeline_key"), ("fact_pipeline", "is_closed_won")], "COUNT WHERE NOT won", "Open deals"),
            ("deals_won", "int", [("fact_pipeline", "is_closed_won")], "COUNT WHERE won", "Won deals"),
            ("win_rate", "decimal(5,2)", [("fact_pipeline", "is_closed_won"), ("fact_pipeline", "pipeline_key")], "won/total*100", "Win rate"),
            ("avg_deal_size", "decimal(15,2)", [("fact_pipeline", "amount"), ("fact_pipeline", "pipeline_key")], "SUM/COUNT", "Avg deal"),
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# DASHBOARDS  (rightmost — Tableau / Looker)
# ═══════════════════════════════════════════════════════════════════════════

DASHBOARDS = {
    "Executive Board Dashboard": {
        "description": "C-suite quarterly business performance overview",
        "charts": [
            ("Revenue & Margin Trend", "rpt_executive_kpis", ["net_revenue", "cogs", "gross_margin_pct", "period"]),
            ("Pipeline Funnel", "rpt_executive_kpis", ["pipeline_value", "weighted_pipeline", "win_rate"]),
            ("Revenue vs GL Recon", "rpt_executive_kpis", ["net_revenue", "gl_booked", "recon_variance"]),
            ("Support Health", "rpt_executive_kpis", ["open_tickets", "avg_csat"]),
            ("Product Adoption", "rpt_executive_kpis", ["mau", "period"]),
        ],
    },
    "CFO Revenue Dashboard": {
        "description": "Revenue monitoring with drill-down by channel and product",
        "charts": [
            ("Revenue by Channel", "rpt_monthly_revenue", ["channel", "total_revenue", "order_count"]),
            ("Margin Analysis", "rpt_monthly_revenue", ["total_revenue", "total_cogs", "gross_profit"]),
            ("Refund Trend", "rpt_monthly_revenue", ["month_key", "refund_amount"]),
            ("AOV by Channel", "rpt_monthly_revenue", ["channel", "avg_order_value"]),
        ],
    },
    "Customer 360 Dashboard": {
        "description": "Unified customer view across commerce, CRM, support, and product",
        "charts": [
            ("Lifetime Value Distribution", "rpt_customer_360", ["full_name", "lifetime_revenue", "lifetime_profit"]),
            ("Support Burden", "rpt_customer_360", ["full_name", "total_tickets", "avg_resolution_hrs"]),
            ("Pipeline by Customer", "rpt_customer_360", ["full_name", "open_pipeline", "industry"]),
            ("Product Engagement", "rpt_customer_360", ["full_name", "product_events_30d", "last_active_date"]),
            ("CSAT by Customer", "rpt_customer_360", ["full_name", "csat_good_pct"]),
        ],
    },
    "Sales Performance Dashboard": {
        "description": "Pipeline visibility and forecasting for sales leadership",
        "charts": [
            ("Pipeline by Industry", "rpt_sales_performance", ["account_industry", "total_pipeline", "weighted_pipeline"]),
            ("Win Rate Trend", "rpt_sales_performance", ["account_industry", "win_rate", "deals_won"]),
            ("Deal Size Analysis", "rpt_sales_performance", ["account_industry", "avg_deal_size", "deals_open"]),
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# GRAPH BUILDER
# ═══════════════════════════════════════════════════════════════════════════

class EnterpriseGraphBuilder:
    """Builds a unified enterprise data lineage graph with cross-domain column-level lineage."""

    def __init__(self, scale: int = 1, breadth: int = 1, depth: int = 1):
        """
        :param scale: Volume filler multiplier (1 = base graph only, >1 adds archive nodes)
        :param breadth: Duplicates each source system (simulates multi-region / DR replicas)
        :param depth: Extra intermediate tiers between silver and gold
        """
        self.scale = scale
        self.breadth = breadth
        self.depth = depth
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        self.column_urn: Dict[str, str] = {}
        self.dataset_urn: Dict[str, str] = {}

    def _urn(self, entity_type: EntityType, name: str) -> str:
        clean = name.lower().replace(" ", "_").replace("/", "_").replace(".", "_")
        return f"urn:li:{entity_type.value}:{clean}_{uuid.uuid4().hex[:8]}"

    def add_node(self, entity_type: EntityType, name: str, parent_urn: str = None,
                 props: Dict = None) -> str:
        urn = self._urn(entity_type, name)
        self.nodes.append(GraphNode(
            urn=urn, entityType=entity_type, displayName=name,
            qualifiedName=name, properties=props or {}, tags=[],
        ))
        if parent_urn:
            self.edges.append(GraphEdge(
                id=f"contains-{parent_urn}-{urn}", sourceUrn=parent_urn,
                targetUrn=urn, edgeType=EdgeType.CONTAINS, properties={},
            ))
        return urn

    def add_lineage(self, source_urn: str, target_urn: str, logic: str):
        self.edges.append(GraphEdge(
            id=f"transforms-{source_urn}-{target_urn}", sourceUrn=source_urn,
            targetUrn=target_urn, edgeType=EdgeType.TRANSFORMS,
            properties={"logic": logic},
        ))

    def build(self):
        logger.info(f"Building enterprise graph (scale={self.scale}, breadth={self.breadth}, depth={self.depth})")

        # ── Domains ──────────────────────────────────────────────────
        domains: Dict[str, str] = {}
        for sys_cfg in SOURCES.values():
            d = sys_cfg["domain"]
            if d not in domains:
                domains[d] = self.add_node(EntityType.DOMAIN, d)

        # Snowflake = shared DWH/Lake platform
        snowflake = self.add_node(EntityType.DATA_PLATFORM, "Snowflake",
                                   props={"type": "cloud_data_warehouse"})

        # ── 1. Source Systems (× breadth) ────────────────────────────
        for b_idx in range(self.breadth):
            suffix = f"_r{b_idx}" if self.breadth > 1 else ""
            for sys_key, sys_cfg in SOURCES.items():
                domain_urn = domains[sys_cfg["domain"]]
                plat = self.add_node(EntityType.DATA_PLATFORM,
                                      f"{sys_cfg['platform']}{suffix}",
                                      parent_urn=domain_urn,
                                      props={"type": "source_system"})
                cont = self.add_node(EntityType.CONTAINER,
                                      f"{sys_cfg['container']}{suffix}",
                                      parent_urn=plat)

                for tbl_name, columns in sys_cfg["tables"].items():
                    ds = self.add_node(EntityType.DATASET, f"{tbl_name}{suffix}",
                                        parent_urn=cont,
                                        props={"layer": "source", "system": sys_key})
                    self.dataset_urn[f"{sys_key}.{tbl_name}{suffix}"] = ds

                    for col_name, col_type, nullable, is_pii, desc in columns:
                        col = self.add_node(EntityType.SCHEMA_FIELD, col_name,
                                             parent_urn=ds,
                                             props={"dataType": col_type, "nullable": nullable,
                                                    "isPii": is_pii, "description": desc})
                        key = f"{sys_key}.{tbl_name}.{col_name}"
                        if not suffix:
                            self.column_urn[key] = col
                        else:
                            self.column_urn[f"{key}{suffix}"] = col

        # ── 2. Silver (in Snowflake) ─────────────────────────────────
        silver_cont = self.add_node(EntityType.CONTAINER, "SILVER",
                                     parent_urn=snowflake,
                                     props={"layer": "silver", "schema": "clean"})
        self._build_transform_layer(SILVER, silver_cont)

        # ── 3. Intermediate tiers (× depth) ──────────────────────────
        if self.depth > 1:
            self._build_intermediate_tiers(SILVER, snowflake)

        # ── 4. Gold (in Snowflake) ───────────────────────────────────
        gold_cont = self.add_node(EntityType.CONTAINER, "GOLD",
                                    parent_urn=snowflake,
                                    props={"layer": "gold", "schema": "analytics"})
        self._build_transform_layer(GOLD, gold_cont)

        # ── 5. Reporting (in Snowflake) ──────────────────────────────
        rpt_cont = self.add_node(EntityType.CONTAINER, "REPORTING",
                                   parent_urn=snowflake,
                                   props={"layer": "reporting", "schema": "marts"})
        self._build_transform_layer(REPORTING, rpt_cont)

        # ── 6. Dashboards ────────────────────────────────────────────
        self._build_dashboards()

        # ── 7. Scale filler ──────────────────────────────────────────
        if self.scale > 1:
            self._build_scale_filler()

        lineage_n = sum(1 for e in self.edges if e.edge_type == EdgeType.TRANSFORMS)
        contain_n = sum(1 for e in self.edges if e.edge_type == EdgeType.CONTAINS)
        logger.info(f"Build complete: {len(self.nodes)} nodes, {len(self.edges)} edges "
                     f"(CONTAINS: {contain_n}, TRANSFORMS: {lineage_n})")

    def _build_transform_layer(self, transforms: Dict, container_urn: str):
        for table_name, spec in transforms.items():
            ds = self.add_node(EntityType.DATASET, table_name, parent_urn=container_urn,
                                props={"description": spec.get("description", "")})
            self.dataset_urn[table_name] = ds

            for col_def in spec["columns"]:
                col_name, col_type, upstream_refs, logic, desc = col_def
                col = self.add_node(EntityType.SCHEMA_FIELD, col_name, parent_urn=ds,
                                     props={"dataType": col_type, "description": desc,
                                            "transformLogic": logic})
                self.column_urn[f"{table_name}.{col_name}"] = col

                for upstream_table, upstream_col in upstream_refs:
                    src = self.column_urn.get(f"{upstream_table}.{upstream_col}")
                    if src:
                        self.add_lineage(src, col, logic)

    def _build_intermediate_tiers(self, silver_transforms: Dict, snowflake_urn: str):
        for tier in range(1, self.depth):
            cont = self.add_node(EntityType.CONTAINER, f"INTERMEDIATE_T{tier}",
                                  parent_urn=snowflake_urn,
                                  props={"layer": f"intermediate_t{tier}"})

            for table_name, spec in silver_transforms.items():
                int_table = f"int_{table_name}_t{tier}"
                ds = self.add_node(EntityType.DATASET, int_table, parent_urn=cont,
                                    props={"description": f"Tier {tier} of {table_name}"})
                self.dataset_urn[int_table] = ds

                for col_def in spec["columns"]:
                    col_name, col_type = col_def[0], col_def[1]
                    desc = col_def[4]

                    prev_table = table_name if tier == 1 else f"int_{table_name}_t{tier - 1}"
                    src_key = f"{prev_table}.{col_name}"

                    col = self.add_node(EntityType.SCHEMA_FIELD, col_name, parent_urn=ds,
                                         props={"dataType": col_type, "description": desc})
                    new_key = f"{int_table}.{col_name}"
                    self.column_urn[new_key] = col

                    src = self.column_urn.get(src_key)
                    if src:
                        self.add_lineage(src, col, f"quality_check_t{tier}")

                    if tier == self.depth - 1:
                        self.column_urn[f"{table_name}.{col_name}"] = col

    def _build_dashboards(self):
        bi_plat = self.add_node(EntityType.DATA_PLATFORM, "Tableau",
                                 props={"type": "bi_platform"})

        for dash_name, dash_cfg in DASHBOARDS.items():
            dash = self.add_node(EntityType.DASHBOARD, dash_name, parent_urn=bi_plat,
                                  props={"description": dash_cfg["description"]})

            for chart_name, source_table, chart_cols in dash_cfg["charts"]:
                chart = self.add_node(EntityType.CHART, chart_name, parent_urn=dash)

                for col_name in chart_cols:
                    field = self.add_node(EntityType.SCHEMA_FIELD, col_name,
                                           parent_urn=chart,
                                           props={"dataType": "metric", "layer": "dashboard"})
                    src = self.column_urn.get(f"{source_table}.{col_name}")
                    if src:
                        self.add_lineage(src, field, "Direct Query")

    def _build_scale_filler(self):
        target = self.scale * 1000
        current = len(self.nodes)
        if current >= target:
            return
        logger.info(f"Adding scale filler: {current} → {target} nodes")
        plat = self.add_node(EntityType.DATA_PLATFORM, "Legacy_Archive")
        remaining = target - current
        n_cont = max(1, remaining // 110)
        for ci in range(n_cont):
            cont = self.add_node(EntityType.CONTAINER, f"Archive_DB_{ci}", parent_urn=plat)
            for di in range(10):
                ds = self.add_node(EntityType.DATASET, f"Archive_Table_{ci}_{di}", parent_urn=cont)
                for fi in range(10):
                    self.add_node(EntityType.SCHEMA_FIELD, f"col_{fi}", parent_urn=ds)


# ═══════════════════════════════════════════════════════════════════════════
# FALKORDB PUSH + MATERIALIZATION
# ═══════════════════════════════════════════════════════════════════════════

async def push_to_falkordb(builder: EnterpriseGraphBuilder, graph_name: str):
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=graph_name,
    )
    await provider._ensure_connected()

    CHUNK = 10000
    logger.info(f"Pushing {len(builder.nodes)} nodes to graph '{graph_name}'...")
    for i in range(0, len(builder.nodes), CHUNK):
        await provider.save_custom_graph(builder.nodes[i:i + CHUNK], [])
        logger.info(f"  Nodes: {min(i + CHUNK, len(builder.nodes))}/{len(builder.nodes)}")

    logger.info(f"Pushing {len(builder.edges)} edges...")
    for i in range(0, len(builder.edges), CHUNK):
        await provider.save_custom_graph([], builder.edges[i:i + CHUNK])
        logger.info(f"  Edges: {min(i + CHUNK, len(builder.edges))}/{len(builder.edges)}")

    await provider.ensure_indices()
    logger.info("Push complete!")


async def materialize_aggregated(graph_name: str):
    """Optionally materialize AGGREGATED edges (virtual cross-product lineage)."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=graph_name,
    )
    await provider._ensure_connected()
    logger.info("Materializing AGGREGATED edges...")
    result = await provider.materialize_aggregated_edges_batch(batch_size=1000)
    logger.info(f"Materialization result: {result}")


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Enterprise data lineage seeder — unified cross-domain column-level lineage",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python backend/scripts/seed_falkordb.py --graph nexus_lineage
  python backend/scripts/seed_falkordb.py --graph nexus_lineage --breadth 2 --depth 3 --scale 5
  python backend/scripts/seed_falkordb.py --graph nexus_lineage --materialize
  python backend/scripts/seed_falkordb.py --graph nexus_lineage --dry-run
        """,
    )
    parser.add_argument("--graph", type=str, required=True,
                        help="FalkorDB graph name (e.g. nexus_lineage)")
    parser.add_argument("--scale", type=int, default=1,
                        help="Volume filler (1=base only, N=adds N×1000 archive nodes)")
    parser.add_argument("--breadth", type=int, default=1,
                        help="Source system replicas (multi-region / DR)")
    parser.add_argument("--depth", type=int, default=1,
                        help="Extra intermediate tiers between silver and gold")
    parser.add_argument("--dry-run", action="store_true",
                        help="Generate only, print stats, don't push")
    parser.add_argument("--materialize", action="store_true",
                        help="Materialize AGGREGATED edges (optional virtual lineage)")

    args = parser.parse_args()

    builder = EnterpriseGraphBuilder(scale=args.scale, breadth=args.breadth, depth=args.depth)
    builder.build()

    if args.dry_run:
        logger.info("Dry run — not pushing.")
        sys.exit(0)

    try:
        asyncio.run(push_to_falkordb(builder, graph_name=args.graph))
        if args.materialize:
            asyncio.run(materialize_aggregated(graph_name=args.graph))
    except KeyboardInterrupt:
        logger.warning("Interrupted.")
    except Exception as e:
        logger.error(f"Failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
