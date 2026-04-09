#!/usr/bin/env python3
"""
Realistic Enterprise Data Lake Seeder for FalkorDB.

Generates a complete medallion-architecture data lake with full column-level
lineage, governance tagging, and AGGREGATED edge materialization.

Architecture:
  Source (Transactional/Operational DBs)
    → Staging (raw landing zone)
      → Bronze (immutable 1:1 copies + metadata)
        → Silver (cleaned, typed, deduplicated)
          → Gold (dimensional model: dims + facts)
            → Reporting (aggregated marts, dashboards, KPIs)

Source Systems:
  1. E-Commerce PostgreSQL  — customers, orders, order_items, products, payments, shipping
  2. CRM (Salesforce)       — accounts, contacts, opportunities, activities
  3. Financial ERP (SAP)    — general_ledger, accounts_payable, accounts_receivable, cost_centers

Graph: "data_lake" (separate from nexus_lineage)

Usage:
  # Dry run (generate only, print stats)
  python backend/scripts/seed_data_lake.py --dry-run

  # Push to FalkorDB
  python backend/scripts/seed_data_lake.py --push

  # Push + materialize AGGREGATED edges via provider
  python backend/scripts/seed_data_lake.py --push --materialize
"""

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.models.graph import GraphEdge, GraphNode

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("seed_data_lake")

# ═══════════════════════════════════════════════════════════════════════
# Source System Schemas
# ═══════════════════════════════════════════════════════════════════════
# Each column: (name, data_type, nullable, is_pii, description)

ECOMMERCE_TABLES = {
    "customers": [
        ("customer_id", "bigint", False, False, "Primary key"),
        ("email", "varchar(255)", False, True, "Customer email address"),
        ("first_name", "varchar(100)", False, True, "Legal first name"),
        ("last_name", "varchar(100)", False, True, "Legal last name"),
        ("phone", "varchar(20)", True, True, "Contact phone number"),
        ("address_line1", "varchar(255)", True, True, "Street address"),
        ("city", "varchar(100)", True, True, "City"),
        ("state", "varchar(50)", True, False, "State/province code"),
        ("country", "varchar(3)", True, False, "ISO 3166 country code"),
        ("postal_code", "varchar(20)", True, True, "Postal/ZIP code"),
        ("segment", "varchar(50)", True, False, "Customer tier: bronze/silver/gold/platinum"),
        ("signup_date", "timestamp", False, False, "Account creation timestamp"),
        ("is_active", "boolean", False, False, "Soft-delete flag"),
        ("updated_at", "timestamp", False, False, "Last modification timestamp"),
    ],
    "orders": [
        ("order_id", "bigint", False, False, "Primary key"),
        ("customer_id", "bigint", False, False, "FK to customers"),
        ("order_date", "timestamp", False, False, "When the order was placed"),
        ("status", "varchar(20)", False, False, "pending/confirmed/shipped/delivered/cancelled/returned"),
        ("currency", "varchar(3)", False, False, "ISO 4217 currency code"),
        ("subtotal", "decimal(12,2)", False, False, "Sum of line items before tax/shipping"),
        ("tax_amount", "decimal(12,2)", False, False, "Tax charged"),
        ("shipping_amount", "decimal(12,2)", False, False, "Shipping fee"),
        ("discount_amount", "decimal(12,2)", True, False, "Coupon/promo discount applied"),
        ("total_amount", "decimal(12,2)", False, False, "Final charged amount"),
        ("shipping_address_id", "bigint", True, False, "FK to addresses"),
        ("promo_code", "varchar(50)", True, False, "Applied promotion code"),
        ("channel", "varchar(20)", False, False, "web/mobile/pos/marketplace"),
        ("created_at", "timestamp", False, False, "Row creation timestamp"),
    ],
    "order_items": [
        ("item_id", "bigint", False, False, "Primary key"),
        ("order_id", "bigint", False, False, "FK to orders"),
        ("product_id", "bigint", False, False, "FK to products"),
        ("sku", "varchar(50)", False, False, "Stock keeping unit"),
        ("quantity", "int", False, False, "Units ordered"),
        ("unit_price", "decimal(10,2)", False, False, "Price per unit at time of order"),
        ("line_total", "decimal(12,2)", False, False, "quantity * unit_price"),
        ("discount_pct", "decimal(5,2)", True, False, "Line-level discount percentage"),
    ],
    "products": [
        ("product_id", "bigint", False, False, "Primary key"),
        ("name", "varchar(255)", False, False, "Product display name"),
        ("category", "varchar(100)", False, False, "Top-level category"),
        ("subcategory", "varchar(100)", True, False, "Sub-category"),
        ("brand", "varchar(100)", True, False, "Brand name"),
        ("cost_price", "decimal(10,2)", False, False, "COGS per unit"),
        ("list_price", "decimal(10,2)", False, False, "MSRP"),
        ("weight_kg", "decimal(6,2)", True, False, "Shipping weight"),
        ("is_active", "boolean", False, False, "Available for sale"),
        ("created_at", "timestamp", False, False, "Catalog entry date"),
    ],
    "payments": [
        ("payment_id", "bigint", False, False, "Primary key"),
        ("order_id", "bigint", False, False, "FK to orders"),
        ("method", "varchar(30)", False, False, "credit_card/debit/paypal/apple_pay/bank_transfer"),
        ("provider", "varchar(30)", False, False, "stripe/adyen/paypal"),
        ("amount", "decimal(12,2)", False, False, "Payment amount"),
        ("currency", "varchar(3)", False, False, "ISO 4217 currency"),
        ("status", "varchar(20)", False, False, "authorized/captured/refunded/failed"),
        ("card_last4", "varchar(4)", True, True, "Last 4 digits of card"),
        ("transaction_id", "varchar(100)", False, False, "Payment gateway transaction ID"),
        ("paid_at", "timestamp", True, False, "When payment was captured"),
    ],
    "shipping": [
        ("shipment_id", "bigint", False, False, "Primary key"),
        ("order_id", "bigint", False, False, "FK to orders"),
        ("carrier", "varchar(50)", False, False, "ups/fedex/usps/dhl"),
        ("tracking_number", "varchar(100)", True, False, "Carrier tracking ID"),
        ("shipped_at", "timestamp", True, False, "Ship date"),
        ("delivered_at", "timestamp", True, False, "Delivery confirmation date"),
        ("status", "varchar(20)", False, False, "pending/in_transit/delivered/exception"),
    ],
}

CRM_TABLES = {
    "accounts": [
        ("account_id", "varchar(18)", False, False, "Salesforce Account ID"),
        ("name", "varchar(255)", False, False, "Company name"),
        ("industry", "varchar(100)", True, False, "Industry classification"),
        ("annual_revenue", "decimal(15,2)", True, False, "Reported annual revenue"),
        ("employee_count", "int", True, False, "Number of employees"),
        ("billing_city", "varchar(100)", True, True, "Billing city"),
        ("billing_country", "varchar(100)", True, False, "Billing country"),
        ("account_type", "varchar(50)", False, False, "prospect/customer/partner/competitor"),
        ("owner_id", "varchar(18)", False, False, "FK to users (account owner)"),
        ("created_date", "timestamp", False, False, "Account creation date"),
        ("last_activity_date", "timestamp", True, False, "Most recent activity"),
    ],
    "contacts": [
        ("contact_id", "varchar(18)", False, False, "Salesforce Contact ID"),
        ("account_id", "varchar(18)", False, False, "FK to accounts"),
        ("first_name", "varchar(100)", False, True, "Contact first name"),
        ("last_name", "varchar(100)", False, True, "Contact last name"),
        ("email", "varchar(255)", True, True, "Contact email"),
        ("phone", "varchar(20)", True, True, "Contact phone"),
        ("title", "varchar(100)", True, False, "Job title"),
        ("department", "varchar(100)", True, False, "Department"),
        ("lead_source", "varchar(50)", True, False, "How the contact was acquired"),
        ("created_date", "timestamp", False, False, "Record creation date"),
    ],
    "opportunities": [
        ("opportunity_id", "varchar(18)", False, False, "Salesforce Opportunity ID"),
        ("account_id", "varchar(18)", False, False, "FK to accounts"),
        ("name", "varchar(255)", False, False, "Deal name"),
        ("stage", "varchar(50)", False, False, "Qualification/Proposal/Negotiation/Closed Won/Closed Lost"),
        ("amount", "decimal(15,2)", True, False, "Deal value"),
        ("probability", "decimal(5,2)", True, False, "Close probability percentage"),
        ("close_date", "date", True, False, "Expected close date"),
        ("type", "varchar(50)", True, False, "New Business/Renewal/Upsell"),
        ("owner_id", "varchar(18)", False, False, "Sales rep ID"),
        ("created_date", "timestamp", False, False, "Pipeline entry date"),
        ("last_modified", "timestamp", False, False, "Last update"),
    ],
    "activities": [
        ("activity_id", "varchar(18)", False, False, "Activity ID"),
        ("account_id", "varchar(18)", True, False, "Related account"),
        ("contact_id", "varchar(18)", True, False, "Related contact"),
        ("opportunity_id", "varchar(18)", True, False, "Related opportunity"),
        ("type", "varchar(50)", False, False, "call/email/meeting/task"),
        ("subject", "varchar(255)", False, False, "Activity subject line"),
        ("status", "varchar(50)", False, False, "open/completed/deferred"),
        ("due_date", "date", True, False, "Due or scheduled date"),
        ("completed_date", "timestamp", True, False, "Completion timestamp"),
    ],
}

ERP_TABLES = {
    "general_ledger": [
        ("entry_id", "bigint", False, False, "Journal entry line ID"),
        ("journal_id", "varchar(20)", False, False, "Parent journal number"),
        ("posting_date", "date", False, False, "Accounting period posting date"),
        ("account_number", "varchar(20)", False, False, "GL account number"),
        ("account_name", "varchar(100)", False, False, "GL account description"),
        ("cost_center", "varchar(20)", True, False, "FK to cost_centers"),
        ("debit_amount", "decimal(15,2)", False, False, "Debit amount (0 if credit)"),
        ("credit_amount", "decimal(15,2)", False, False, "Credit amount (0 if debit)"),
        ("currency", "varchar(3)", False, False, "ISO 4217 currency"),
        ("description", "varchar(500)", True, False, "Line description"),
        ("source_module", "varchar(20)", False, False, "AP/AR/FA/GL/MM"),
        ("created_by", "varchar(50)", False, False, "User who posted"),
        ("created_at", "timestamp", False, False, "Posting timestamp"),
    ],
    "accounts_payable": [
        ("invoice_id", "bigint", False, False, "AP invoice ID"),
        ("vendor_id", "bigint", False, False, "FK to vendors"),
        ("vendor_name", "varchar(255)", False, False, "Vendor legal name"),
        ("invoice_number", "varchar(50)", False, False, "Vendor invoice reference"),
        ("invoice_date", "date", False, False, "Invoice date"),
        ("due_date", "date", False, False, "Payment due date"),
        ("amount", "decimal(15,2)", False, False, "Invoice total"),
        ("currency", "varchar(3)", False, False, "ISO 4217 currency"),
        ("status", "varchar(20)", False, False, "open/partial/paid/void"),
        ("gl_account", "varchar(20)", False, False, "Expense GL account"),
        ("cost_center", "varchar(20)", True, False, "Charged cost center"),
        ("paid_date", "date", True, False, "Actual payment date"),
        ("payment_method", "varchar(20)", True, False, "wire/check/ach"),
    ],
    "accounts_receivable": [
        ("invoice_id", "bigint", False, False, "AR invoice ID"),
        ("customer_id", "bigint", False, False, "FK to customers"),
        ("customer_name", "varchar(255)", False, False, "Customer legal name"),
        ("invoice_number", "varchar(50)", False, False, "Invoice number"),
        ("invoice_date", "date", False, False, "Invoice issue date"),
        ("due_date", "date", False, False, "Payment due date"),
        ("amount", "decimal(15,2)", False, False, "Invoice total"),
        ("currency", "varchar(3)", False, False, "ISO 4217 currency"),
        ("status", "varchar(20)", False, False, "open/partial/paid/written_off"),
        ("gl_account", "varchar(20)", False, False, "Revenue GL account"),
        ("days_outstanding", "int", True, False, "Current aging in days"),
        ("collected_amount", "decimal(15,2)", True, False, "Amount collected so far"),
    ],
    "cost_centers": [
        ("cost_center_id", "varchar(20)", False, False, "Cost center code"),
        ("name", "varchar(100)", False, False, "Cost center name"),
        ("department", "varchar(100)", False, False, "Parent department"),
        ("manager", "varchar(100)", True, True, "Responsible manager name"),
        ("budget_annual", "decimal(15,2)", True, False, "Annual budget allocation"),
        ("is_active", "boolean", False, False, "Active flag"),
    ],
}

# ═══════════════════════════════════════════════════════════════════════
# Silver-layer transformation rules
# Maps (source_system, source_table) -> silver_table with column mappings
# ═══════════════════════════════════════════════════════════════════════

SILVER_TRANSFORMS = {
    # E-Commerce clean tables
    "clean_customers": {
        "sources": [("ecommerce", "customers")],
        "columns": [
            ("customer_id", "bigint", [("ecommerce.customers", "customer_id")], "CAST + dedup", "Deduplicated customer key"),
            ("email_hash", "varchar(64)", [("ecommerce.customers", "email")], "SHA256(LOWER(TRIM(email)))", "Hashed email for matching"),
            ("full_name", "varchar(200)", [("ecommerce.customers", "first_name"), ("ecommerce.customers", "last_name")], "CONCAT(first_name, ' ', last_name)", "Combined full name"),
            ("phone_normalized", "varchar(20)", [("ecommerce.customers", "phone")], "REGEXP_REPLACE(phone, '[^0-9+]', '')", "Normalized phone number"),
            ("country_code", "varchar(3)", [("ecommerce.customers", "country")], "UPPER(TRIM(country))", "Standardized ISO country"),
            ("segment", "varchar(50)", [("ecommerce.customers", "segment")], "COALESCE(segment, 'unknown')", "Customer tier with default"),
            ("signup_date", "date", [("ecommerce.customers", "signup_date")], "CAST(signup_date AS DATE)", "Date only"),
            ("is_active", "boolean", [("ecommerce.customers", "is_active")], "pass-through", "Active flag"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL load timestamp"),
            ("_source_system", "varchar(20)", [], "'ecommerce'", "Source system tag"),
        ],
    },
    "clean_orders": {
        "sources": [("ecommerce", "orders")],
        "columns": [
            ("order_id", "bigint", [("ecommerce.orders", "order_id")], "pass-through", "Order PK"),
            ("customer_id", "bigint", [("ecommerce.orders", "customer_id")], "pass-through", "Customer FK"),
            ("order_date", "date", [("ecommerce.orders", "order_date")], "CAST AS DATE", "Order date (no time)"),
            ("order_timestamp", "timestamp", [("ecommerce.orders", "order_date")], "pass-through", "Full timestamp"),
            ("status", "varchar(20)", [("ecommerce.orders", "status")], "LOWER(TRIM(status))", "Normalized status"),
            ("currency", "varchar(3)", [("ecommerce.orders", "currency")], "UPPER(currency)", "ISO currency"),
            ("subtotal", "decimal(12,2)", [("ecommerce.orders", "subtotal")], "pass-through", "Pre-tax subtotal"),
            ("tax_amount", "decimal(12,2)", [("ecommerce.orders", "tax_amount")], "COALESCE(tax, 0)", "Tax with default"),
            ("shipping_amount", "decimal(12,2)", [("ecommerce.orders", "shipping_amount")], "COALESCE(shipping, 0)", "Shipping with default"),
            ("discount_amount", "decimal(12,2)", [("ecommerce.orders", "discount_amount")], "COALESCE(discount, 0)", "Discount with default"),
            ("total_amount", "decimal(12,2)", [("ecommerce.orders", "total_amount")], "pass-through", "Final amount"),
            ("net_revenue", "decimal(12,2)", [("ecommerce.orders", "total_amount"), ("ecommerce.orders", "discount_amount")], "total_amount - COALESCE(discount_amount, 0)", "Revenue net of discounts"),
            ("channel", "varchar(20)", [("ecommerce.orders", "channel")], "LOWER(channel)", "Normalized channel"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_order_items": {
        "sources": [("ecommerce", "order_items")],
        "columns": [
            ("item_id", "bigint", [("ecommerce.order_items", "item_id")], "pass-through", "Line item PK"),
            ("order_id", "bigint", [("ecommerce.order_items", "order_id")], "pass-through", "Order FK"),
            ("product_id", "bigint", [("ecommerce.order_items", "product_id")], "pass-through", "Product FK"),
            ("sku", "varchar(50)", [("ecommerce.order_items", "sku")], "UPPER(TRIM(sku))", "Normalized SKU"),
            ("quantity", "int", [("ecommerce.order_items", "quantity")], "pass-through", "Units"),
            ("unit_price", "decimal(10,2)", [("ecommerce.order_items", "unit_price")], "pass-through", "Unit price"),
            ("line_total", "decimal(12,2)", [("ecommerce.order_items", "line_total")], "pass-through", "Line total"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_products": {
        "sources": [("ecommerce", "products")],
        "columns": [
            ("product_id", "bigint", [("ecommerce.products", "product_id")], "pass-through", "Product PK"),
            ("name", "varchar(255)", [("ecommerce.products", "name")], "TRIM(name)", "Product name"),
            ("category", "varchar(100)", [("ecommerce.products", "category")], "INITCAP(category)", "Standardized category"),
            ("subcategory", "varchar(100)", [("ecommerce.products", "subcategory")], "INITCAP(subcategory)", "Standardized subcategory"),
            ("brand", "varchar(100)", [("ecommerce.products", "brand")], "COALESCE(brand, 'Unbranded')", "Brand with default"),
            ("cost_price", "decimal(10,2)", [("ecommerce.products", "cost_price")], "pass-through", "COGS"),
            ("list_price", "decimal(10,2)", [("ecommerce.products", "list_price")], "pass-through", "MSRP"),
            ("margin_pct", "decimal(5,2)", [("ecommerce.products", "list_price"), ("ecommerce.products", "cost_price")], "(list_price - cost_price) / NULLIF(list_price, 0) * 100", "Gross margin %"),
            ("is_active", "boolean", [("ecommerce.products", "is_active")], "pass-through", "Active flag"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_payments": {
        "sources": [("ecommerce", "payments")],
        "columns": [
            ("payment_id", "bigint", [("ecommerce.payments", "payment_id")], "pass-through", "Payment PK"),
            ("order_id", "bigint", [("ecommerce.payments", "order_id")], "pass-through", "Order FK"),
            ("method", "varchar(30)", [("ecommerce.payments", "method")], "LOWER(method)", "Normalized method"),
            ("provider", "varchar(30)", [("ecommerce.payments", "provider")], "LOWER(provider)", "Payment provider"),
            ("amount", "decimal(12,2)", [("ecommerce.payments", "amount")], "pass-through", "Amount"),
            ("currency", "varchar(3)", [("ecommerce.payments", "currency")], "UPPER(currency)", "ISO currency"),
            ("status", "varchar(20)", [("ecommerce.payments", "status")], "LOWER(status)", "Payment status"),
            ("paid_at", "timestamp", [("ecommerce.payments", "paid_at")], "pass-through", "Capture time"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    # CRM clean tables
    "clean_accounts": {
        "sources": [("crm", "accounts")],
        "columns": [
            ("account_id", "varchar(18)", [("crm.accounts", "account_id")], "pass-through", "Account PK"),
            ("name", "varchar(255)", [("crm.accounts", "name")], "TRIM(name)", "Company name"),
            ("industry", "varchar(100)", [("crm.accounts", "industry")], "COALESCE(industry, 'Unknown')", "Industry"),
            ("annual_revenue", "decimal(15,2)", [("crm.accounts", "annual_revenue")], "COALESCE(annual_revenue, 0)", "Revenue with default"),
            ("employee_count", "int", [("crm.accounts", "employee_count")], "pass-through", "Employees"),
            ("country", "varchar(100)", [("crm.accounts", "billing_country")], "UPPER(billing_country)", "Normalized country"),
            ("account_type", "varchar(50)", [("crm.accounts", "account_type")], "LOWER(account_type)", "Type"),
            ("created_date", "date", [("crm.accounts", "created_date")], "CAST AS DATE", "Creation date"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_contacts": {
        "sources": [("crm", "contacts")],
        "columns": [
            ("contact_id", "varchar(18)", [("crm.contacts", "contact_id")], "pass-through", "Contact PK"),
            ("account_id", "varchar(18)", [("crm.contacts", "account_id")], "pass-through", "Account FK"),
            ("full_name", "varchar(200)", [("crm.contacts", "first_name"), ("crm.contacts", "last_name")], "CONCAT(first_name, ' ', last_name)", "Full name"),
            ("email_hash", "varchar(64)", [("crm.contacts", "email")], "SHA256(LOWER(TRIM(email)))", "Hashed email"),
            ("title", "varchar(100)", [("crm.contacts", "title")], "COALESCE(title, 'N/A')", "Job title"),
            ("department", "varchar(100)", [("crm.contacts", "department")], "COALESCE(department, 'N/A')", "Department"),
            ("lead_source", "varchar(50)", [("crm.contacts", "lead_source")], "COALESCE(lead_source, 'unknown')", "Acquisition source"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_opportunities": {
        "sources": [("crm", "opportunities")],
        "columns": [
            ("opportunity_id", "varchar(18)", [("crm.opportunities", "opportunity_id")], "pass-through", "Opp PK"),
            ("account_id", "varchar(18)", [("crm.opportunities", "account_id")], "pass-through", "Account FK"),
            ("name", "varchar(255)", [("crm.opportunities", "name")], "TRIM(name)", "Deal name"),
            ("stage", "varchar(50)", [("crm.opportunities", "stage")], "pass-through", "Pipeline stage"),
            ("amount", "decimal(15,2)", [("crm.opportunities", "amount")], "COALESCE(amount, 0)", "Deal value"),
            ("probability", "decimal(5,2)", [("crm.opportunities", "probability")], "COALESCE(probability, 0)", "Close probability"),
            ("weighted_amount", "decimal(15,2)", [("crm.opportunities", "amount"), ("crm.opportunities", "probability")], "amount * probability / 100", "Probability-weighted value"),
            ("close_date", "date", [("crm.opportunities", "close_date")], "pass-through", "Expected close"),
            ("type", "varchar(50)", [("crm.opportunities", "type")], "COALESCE(type, 'New Business')", "Deal type"),
            ("is_closed_won", "boolean", [("crm.opportunities", "stage")], "stage = 'Closed Won'", "Win flag"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    # Financial clean tables
    "clean_gl_entries": {
        "sources": [("erp", "general_ledger")],
        "columns": [
            ("entry_id", "bigint", [("erp.general_ledger", "entry_id")], "pass-through", "GL entry PK"),
            ("journal_id", "varchar(20)", [("erp.general_ledger", "journal_id")], "pass-through", "Journal ID"),
            ("posting_date", "date", [("erp.general_ledger", "posting_date")], "pass-through", "Posting date"),
            ("account_number", "varchar(20)", [("erp.general_ledger", "account_number")], "pass-through", "GL account"),
            ("account_name", "varchar(100)", [("erp.general_ledger", "account_name")], "TRIM(account_name)", "Account name"),
            ("cost_center", "varchar(20)", [("erp.general_ledger", "cost_center")], "COALESCE(cost_center, '0000')", "Cost center"),
            ("net_amount", "decimal(15,2)", [("erp.general_ledger", "debit_amount"), ("erp.general_ledger", "credit_amount")], "debit_amount - credit_amount", "Net debit amount"),
            ("currency", "varchar(3)", [("erp.general_ledger", "currency")], "UPPER(currency)", "ISO currency"),
            ("source_module", "varchar(20)", [("erp.general_ledger", "source_module")], "pass-through", "Originating module"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_ap_invoices": {
        "sources": [("erp", "accounts_payable")],
        "columns": [
            ("invoice_id", "bigint", [("erp.accounts_payable", "invoice_id")], "pass-through", "AP invoice PK"),
            ("vendor_id", "bigint", [("erp.accounts_payable", "vendor_id")], "pass-through", "Vendor FK"),
            ("vendor_name", "varchar(255)", [("erp.accounts_payable", "vendor_name")], "TRIM(vendor_name)", "Vendor name"),
            ("invoice_date", "date", [("erp.accounts_payable", "invoice_date")], "pass-through", "Invoice date"),
            ("due_date", "date", [("erp.accounts_payable", "due_date")], "pass-through", "Due date"),
            ("amount", "decimal(15,2)", [("erp.accounts_payable", "amount")], "pass-through", "Invoice amount"),
            ("status", "varchar(20)", [("erp.accounts_payable", "status")], "LOWER(status)", "Payment status"),
            ("cost_center", "varchar(20)", [("erp.accounts_payable", "cost_center")], "COALESCE(cost_center, '0000')", "Charged cost center"),
            ("days_to_pay", "int", [("erp.accounts_payable", "invoice_date"), ("erp.accounts_payable", "paid_date")], "DATEDIFF(paid_date, invoice_date)", "Days to payment"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "clean_ar_invoices": {
        "sources": [("erp", "accounts_receivable")],
        "columns": [
            ("invoice_id", "bigint", [("erp.accounts_receivable", "invoice_id")], "pass-through", "AR invoice PK"),
            ("customer_id", "bigint", [("erp.accounts_receivable", "customer_id")], "pass-through", "Customer FK"),
            ("customer_name", "varchar(255)", [("erp.accounts_receivable", "customer_name")], "TRIM(customer_name)", "Customer name"),
            ("invoice_date", "date", [("erp.accounts_receivable", "invoice_date")], "pass-through", "Invoice date"),
            ("due_date", "date", [("erp.accounts_receivable", "due_date")], "pass-through", "Due date"),
            ("amount", "decimal(15,2)", [("erp.accounts_receivable", "amount")], "pass-through", "Invoice amount"),
            ("status", "varchar(20)", [("erp.accounts_receivable", "status")], "LOWER(status)", "Invoice status"),
            ("days_outstanding", "int", [("erp.accounts_receivable", "days_outstanding")], "COALESCE(days_outstanding, 0)", "Aging days"),
            ("collection_rate", "decimal(5,2)", [("erp.accounts_receivable", "collected_amount"), ("erp.accounts_receivable", "amount")], "collected_amount / NULLIF(amount, 0) * 100", "Collected %"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
}

# ═══════════════════════════════════════════════════════════════════════
# Gold-layer dimensional model
# ═══════════════════════════════════════════════════════════════════════

GOLD_DIMENSIONS = {
    "dim_customer": {
        "description": "Conformed customer dimension joining e-commerce and CRM data",
        "sources": ["clean_customers", "clean_contacts", "clean_accounts", "clean_orders"],
        "columns": [
            ("customer_key", "bigint", [("clean_customers", "customer_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("ecomm_customer_id", "bigint", [("clean_customers", "customer_id")], "pass-through", "E-commerce customer ID"),
            ("crm_contact_id", "varchar(18)", [("clean_contacts", "contact_id")], "LEFT JOIN on email_hash", "CRM contact ID"),
            ("crm_account_id", "varchar(18)", [("clean_contacts", "account_id")], "pass-through via contact", "CRM account ID"),
            ("full_name", "varchar(200)", [("clean_customers", "full_name"), ("clean_contacts", "full_name")], "COALESCE(ecomm.full_name, crm.full_name)", "Unified name"),
            ("email_hash", "varchar(64)", [("clean_customers", "email_hash"), ("clean_contacts", "email_hash")], "COALESCE for matching", "Identity hash"),
            ("country_code", "varchar(3)", [("clean_customers", "country_code"), ("clean_accounts", "country")], "COALESCE(ecomm.country, crm.country)", "Best-known country"),
            ("segment", "varchar(50)", [("clean_customers", "segment")], "pass-through", "E-commerce segment"),
            ("industry", "varchar(100)", [("clean_accounts", "industry")], "pass-through", "CRM industry"),
            ("account_type", "varchar(50)", [("clean_accounts", "account_type")], "pass-through", "CRM account type"),
            ("first_order_date", "date", [("clean_orders", "order_date")], "MIN(order_date) per customer", "First purchase date"),
            ("signup_date", "date", [("clean_customers", "signup_date")], "pass-through", "Registration date"),
            ("is_active", "boolean", [("clean_customers", "is_active")], "pass-through", "Active flag"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "dim_product": {
        "description": "Product dimension with margin calculation",
        "sources": ["clean_products"],
        "columns": [
            ("product_key", "bigint", [("clean_products", "product_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("product_id", "bigint", [("clean_products", "product_id")], "pass-through", "Natural key"),
            ("name", "varchar(255)", [("clean_products", "name")], "pass-through", "Product name"),
            ("category", "varchar(100)", [("clean_products", "category")], "pass-through", "Category"),
            ("subcategory", "varchar(100)", [("clean_products", "subcategory")], "pass-through", "Subcategory"),
            ("brand", "varchar(100)", [("clean_products", "brand")], "pass-through", "Brand"),
            ("cost_price", "decimal(10,2)", [("clean_products", "cost_price")], "pass-through", "COGS"),
            ("list_price", "decimal(10,2)", [("clean_products", "list_price")], "pass-through", "MSRP"),
            ("margin_pct", "decimal(5,2)", [("clean_products", "margin_pct")], "pass-through", "Margin %"),
            ("is_active", "boolean", [("clean_products", "is_active")], "pass-through", "Active flag"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "dim_date": {
        "description": "Date dimension (generated, no upstream source)",
        "sources": [],
        "columns": [
            ("date_key", "int", [], "CAST(YYYYMMDD AS INT)", "Surrogate key"),
            ("full_date", "date", [], "generated", "Calendar date"),
            ("year", "int", [], "EXTRACT(YEAR)", "Calendar year"),
            ("quarter", "int", [], "EXTRACT(QUARTER)", "Quarter 1-4"),
            ("month", "int", [], "EXTRACT(MONTH)", "Month 1-12"),
            ("month_name", "varchar(10)", [], "TO_CHAR(date, 'Month')", "Month name"),
            ("week_of_year", "int", [], "EXTRACT(WEEK)", "ISO week number"),
            ("day_of_week", "int", [], "EXTRACT(DOW)", "Day of week 1-7"),
            ("is_weekend", "boolean", [], "dow IN (6,7)", "Weekend flag"),
            ("fiscal_year", "int", [], "CASE WHEN month >= 2 THEN year ELSE year-1 END", "Fiscal year (Feb start)"),
            ("fiscal_quarter", "int", [], "custom logic", "Fiscal quarter"),
        ],
    },
}

GOLD_FACTS = {
    "fact_orders": {
        "description": "Order-grain fact table with all monetary fields and dimension keys",
        "sources": ["clean_orders", "clean_order_items", "clean_payments", "dim_customer", "dim_product", "dim_date"],
        "columns": [
            ("order_key", "bigint", [("clean_orders", "order_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN on customer_id", "Customer dim FK"),
            ("product_key", "bigint", [("dim_product", "product_key")], "JOIN via order_items", "Product dim FK"),
            ("order_date_key", "int", [("dim_date", "date_key"), ("clean_orders", "order_date")], "JOIN on order_date = full_date", "Date dim FK"),
            ("order_id", "bigint", [("clean_orders", "order_id")], "pass-through", "Natural order ID"),
            ("customer_id", "bigint", [("clean_orders", "customer_id")], "pass-through", "Natural customer ID"),
            ("status", "varchar(20)", [("clean_orders", "status")], "pass-through", "Order status"),
            ("channel", "varchar(20)", [("clean_orders", "channel")], "pass-through", "Sales channel"),
            ("quantity", "int", [("clean_order_items", "quantity")], "SUM per order", "Total units"),
            ("subtotal", "decimal(12,2)", [("clean_orders", "subtotal")], "pass-through", "Pre-tax total"),
            ("tax_amount", "decimal(12,2)", [("clean_orders", "tax_amount")], "pass-through", "Tax"),
            ("shipping_amount", "decimal(12,2)", [("clean_orders", "shipping_amount")], "pass-through", "Shipping"),
            ("discount_amount", "decimal(12,2)", [("clean_orders", "discount_amount")], "pass-through", "Discount"),
            ("total_amount", "decimal(12,2)", [("clean_orders", "total_amount")], "pass-through", "Gross total"),
            ("net_revenue", "decimal(12,2)", [("clean_orders", "net_revenue")], "pass-through", "Net revenue"),
            ("cogs", "decimal(12,2)", [("clean_order_items", "quantity"), ("clean_products", "cost_price")], "SUM(quantity * cost_price)", "Cost of goods sold"),
            ("gross_profit", "decimal(12,2)", [("clean_orders", "net_revenue"), ("clean_order_items", "quantity"), ("clean_products", "cost_price")], "net_revenue - cogs", "Gross profit"),
            ("payment_method", "varchar(30)", [("clean_payments", "method")], "pass-through", "Payment method"),
            ("payment_status", "varchar(20)", [("clean_payments", "status")], "pass-through", "Payment status"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "fact_revenue": {
        "description": "Revenue fact combining e-commerce orders with GL postings for reconciliation",
        "sources": ["clean_orders", "clean_gl_entries", "clean_ar_invoices", "dim_customer", "dim_date"],
        "columns": [
            ("revenue_key", "bigint", [("clean_orders", "order_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN on customer_id", "Customer dim FK"),
            ("date_key", "int", [("dim_date", "date_key"), ("clean_orders", "order_date")], "JOIN on order_date", "Date dim FK"),
            ("order_id", "bigint", [("clean_orders", "order_id")], "pass-through", "E-commerce order ID"),
            ("gl_account", "varchar(20)", [("clean_gl_entries", "account_number")], "JOIN on revenue accounts", "GL account"),
            ("ar_invoice_id", "bigint", [("clean_ar_invoices", "invoice_id")], "LEFT JOIN on customer+date", "AR invoice reference"),
            ("order_revenue", "decimal(15,2)", [("clean_orders", "net_revenue")], "pass-through", "E-commerce net revenue"),
            ("gl_revenue", "decimal(15,2)", [("clean_gl_entries", "net_amount")], "SUM WHERE source_module='AR'", "GL-booked revenue"),
            ("ar_amount", "decimal(15,2)", [("clean_ar_invoices", "amount")], "pass-through", "AR invoice amount"),
            ("variance", "decimal(15,2)", [("clean_orders", "net_revenue"), ("clean_gl_entries", "net_amount")], "order_revenue - gl_revenue", "Recon variance"),
            ("currency", "varchar(3)", [("clean_orders", "currency")], "pass-through", "Currency"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
    "fact_pipeline": {
        "description": "Sales pipeline fact for forecasting and rep performance",
        "sources": ["clean_opportunities", "clean_accounts", "dim_customer", "dim_date"],
        "columns": [
            ("pipeline_key", "bigint", [("clean_opportunities", "opportunity_id")], "SURROGATE_KEY()", "Surrogate key"),
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "JOIN via account_id", "Customer dim FK"),
            ("close_date_key", "int", [("dim_date", "date_key"), ("clean_opportunities", "close_date")], "JOIN on close_date", "Expected close date FK"),
            ("opportunity_id", "varchar(18)", [("clean_opportunities", "opportunity_id")], "pass-through", "CRM opportunity ID"),
            ("account_id", "varchar(18)", [("clean_opportunities", "account_id")], "pass-through", "CRM account ID"),
            ("stage", "varchar(50)", [("clean_opportunities", "stage")], "pass-through", "Pipeline stage"),
            ("amount", "decimal(15,2)", [("clean_opportunities", "amount")], "pass-through", "Deal value"),
            ("weighted_amount", "decimal(15,2)", [("clean_opportunities", "weighted_amount")], "pass-through", "Weighted pipeline"),
            ("probability", "decimal(5,2)", [("clean_opportunities", "probability")], "pass-through", "Close probability"),
            ("type", "varchar(50)", [("clean_opportunities", "type")], "pass-through", "Deal type"),
            ("is_closed_won", "boolean", [("clean_opportunities", "is_closed_won")], "pass-through", "Win flag"),
            ("account_industry", "varchar(100)", [("clean_accounts", "industry")], "JOIN on account_id", "Account industry"),
            ("account_revenue", "decimal(15,2)", [("clean_accounts", "annual_revenue")], "JOIN on account_id", "Account annual revenue"),
            ("_loaded_at", "timestamp", [], "CURRENT_TIMESTAMP", "ETL timestamp"),
        ],
    },
}

# ═══════════════════════════════════════════════════════════════════════
# Reporting / Mart layer
# ═══════════════════════════════════════════════════════════════════════

REPORTING_TABLES = {
    "rpt_monthly_revenue": {
        "description": "Monthly revenue aggregation by customer segment and channel",
        "sources": ["fact_orders", "dim_customer", "dim_date"],
        "columns": [
            ("month_key", "int", [("dim_date", "date_key")], "fiscal_year * 100 + month", "Year-month key"),
            ("year", "int", [("dim_date", "year")], "pass-through", "Calendar year"),
            ("month", "int", [("dim_date", "month")], "pass-through", "Calendar month"),
            ("fiscal_quarter", "int", [("dim_date", "fiscal_quarter")], "pass-through", "Fiscal quarter"),
            ("segment", "varchar(50)", [("dim_customer", "segment")], "GROUP BY segment", "Customer segment"),
            ("channel", "varchar(20)", [("fact_orders", "channel")], "GROUP BY channel", "Sales channel"),
            ("order_count", "int", [("fact_orders", "order_key")], "COUNT(DISTINCT order_key)", "Number of orders"),
            ("total_revenue", "decimal(15,2)", [("fact_orders", "net_revenue")], "SUM(net_revenue)", "Total net revenue"),
            ("total_cogs", "decimal(15,2)", [("fact_orders", "cogs")], "SUM(cogs)", "Total COGS"),
            ("gross_profit", "decimal(15,2)", [("fact_orders", "gross_profit")], "SUM(gross_profit)", "Total gross profit"),
            ("avg_order_value", "decimal(10,2)", [("fact_orders", "total_amount"), ("fact_orders", "order_key")], "SUM(total_amount) / COUNT(order_key)", "Average order value"),
            ("unique_customers", "int", [("fact_orders", "customer_key")], "COUNT(DISTINCT customer_key)", "Unique buyers"),
        ],
    },
    "rpt_customer_360": {
        "description": "Wide customer profile combining purchase history, CRM engagement, and financials",
        "sources": ["dim_customer", "fact_orders", "fact_pipeline", "fact_revenue"],
        "columns": [
            ("customer_key", "bigint", [("dim_customer", "customer_key")], "pass-through", "Customer key"),
            ("full_name", "varchar(200)", [("dim_customer", "full_name")], "pass-through", "Name"),
            ("segment", "varchar(50)", [("dim_customer", "segment")], "pass-through", "Segment"),
            ("country_code", "varchar(3)", [("dim_customer", "country_code")], "pass-through", "Country"),
            ("industry", "varchar(100)", [("dim_customer", "industry")], "pass-through", "Industry"),
            ("lifetime_orders", "int", [("fact_orders", "order_key")], "COUNT(DISTINCT order_key)", "Total orders ever"),
            ("lifetime_revenue", "decimal(15,2)", [("fact_orders", "net_revenue")], "SUM(net_revenue)", "Lifetime revenue"),
            ("lifetime_profit", "decimal(15,2)", [("fact_orders", "gross_profit")], "SUM(gross_profit)", "Lifetime profit"),
            ("avg_order_value", "decimal(10,2)", [("fact_orders", "total_amount"), ("fact_orders", "order_key")], "SUM/COUNT", "AOV"),
            ("first_order_date", "date", [("dim_customer", "first_order_date")], "pass-through", "First purchase"),
            ("last_order_date", "date", [("fact_orders", "order_date_key"), ("dim_date", "full_date")], "MAX(full_date)", "Last purchase"),
            ("days_since_last_order", "int", [("fact_orders", "order_date_key"), ("dim_date", "full_date")], "DATEDIFF(NOW(), MAX(full_date))", "Recency"),
            ("open_pipeline_value", "decimal(15,2)", [("fact_pipeline", "amount"), ("fact_pipeline", "is_closed_won")], "SUM WHERE NOT is_closed_won", "Open CRM pipeline"),
            ("total_ar_outstanding", "decimal(15,2)", [("fact_revenue", "ar_amount")], "SUM of open invoices", "AR balance"),
        ],
    },
    "rpt_executive_kpis": {
        "description": "C-suite KPI summary aggregating across all business domains",
        "sources": ["fact_orders", "fact_revenue", "fact_pipeline", "dim_date"],
        "columns": [
            ("period_key", "int", [("dim_date", "date_key")], "fiscal_year * 100 + fiscal_quarter", "Fiscal period"),
            ("fiscal_year", "int", [("dim_date", "fiscal_year")], "pass-through", "Fiscal year"),
            ("fiscal_quarter", "int", [("dim_date", "fiscal_quarter")], "pass-through", "Fiscal quarter"),
            ("gross_revenue", "decimal(15,2)", [("fact_orders", "total_amount")], "SUM(total_amount)", "Gross revenue"),
            ("net_revenue", "decimal(15,2)", [("fact_orders", "net_revenue")], "SUM(net_revenue)", "Net revenue"),
            ("cogs", "decimal(15,2)", [("fact_orders", "cogs")], "SUM(cogs)", "Total COGS"),
            ("gross_margin_pct", "decimal(5,2)", [("fact_orders", "gross_profit"), ("fact_orders", "net_revenue")], "SUM(gross_profit)/SUM(net_revenue)*100", "Gross margin %"),
            ("order_count", "int", [("fact_orders", "order_key")], "COUNT(DISTINCT)", "Total orders"),
            ("new_customers", "int", [("fact_orders", "customer_key"), ("dim_date", "full_date")], "COUNT WHERE first_order in period", "New customers acquired"),
            ("pipeline_value", "decimal(15,2)", [("fact_pipeline", "amount")], "SUM(amount)", "Total pipeline"),
            ("weighted_pipeline", "decimal(15,2)", [("fact_pipeline", "weighted_amount")], "SUM(weighted_amount)", "Weighted pipeline"),
            ("win_rate", "decimal(5,2)", [("fact_pipeline", "is_closed_won"), ("fact_pipeline", "pipeline_key")], "COUNT(won)/COUNT(all)*100", "Win rate %"),
            ("gl_booked_revenue", "decimal(15,2)", [("fact_revenue", "gl_revenue")], "SUM(gl_revenue)", "GL revenue"),
            ("recon_variance", "decimal(15,2)", [("fact_revenue", "variance")], "SUM(ABS(variance))", "Reconciliation variance"),
            ("ar_outstanding", "decimal(15,2)", [("fact_revenue", "ar_amount")], "SUM of open", "AR outstanding"),
        ],
    },
}

# Dashboards and charts
DASHBOARDS = {
    "Revenue & Orders Dashboard": {
        "description": "Real-time revenue monitoring with drill-down by segment, channel, and product",
        "charts": [
            ("Revenue Trend", "rpt_monthly_revenue", ["total_revenue", "gross_profit", "month"]),
            ("Orders by Channel", "rpt_monthly_revenue", ["order_count", "channel"]),
            ("AOV by Segment", "rpt_monthly_revenue", ["avg_order_value", "segment"]),
            ("Revenue vs Target", "rpt_executive_kpis", ["net_revenue", "fiscal_quarter"]),
        ],
    },
    "Customer 360 Dashboard": {
        "description": "Unified customer view combining e-commerce, CRM, and financial data",
        "charts": [
            ("Customer Lifetime Value", "rpt_customer_360", ["lifetime_revenue", "segment"]),
            ("Recency Distribution", "rpt_customer_360", ["days_since_last_order", "segment"]),
            ("Pipeline by Industry", "rpt_customer_360", ["open_pipeline_value", "industry"]),
            ("AR Aging", "rpt_customer_360", ["total_ar_outstanding", "segment"]),
        ],
    },
    "Executive KPI Dashboard": {
        "description": "C-suite quarterly business performance overview",
        "charts": [
            ("Quarterly P&L", "rpt_executive_kpis", ["gross_revenue", "cogs", "net_revenue", "fiscal_quarter"]),
            ("Gross Margin Trend", "rpt_executive_kpis", ["gross_margin_pct", "fiscal_quarter"]),
            ("Pipeline Funnel", "rpt_executive_kpis", ["pipeline_value", "weighted_pipeline", "win_rate"]),
            ("Revenue Reconciliation", "rpt_executive_kpis", ["net_revenue", "gl_booked_revenue", "recon_variance"]),
        ],
    },
    "Sales Pipeline Dashboard": {
        "description": "Sales team pipeline visibility and forecasting",
        "charts": [
            ("Pipeline by Stage", "fact_pipeline", ["amount", "stage"]),
            ("Win Rate Trend", "rpt_executive_kpis", ["win_rate", "fiscal_quarter"]),
            ("Deals by Type", "fact_pipeline", ["amount", "type"]),
        ],
    },
}

# Governance
GOVERNANCE_TAGS = [
    ("PII", "Contains Personally Identifiable Information — subject to data masking"),
    ("PHI", "Protected Health Information (reserved, not used in current sources)"),
    ("Certified", "Data quality validated — approved for executive reporting"),
    ("SLA-Critical", "Must refresh within SLA window (daily 06:00 UTC)"),
    ("GDPR-Regulated", "Subject to GDPR right-to-erasure and consent requirements"),
    ("SOX-Auditable", "Required for Sarbanes-Oxley financial audit trail"),
    ("Deprecated", "Scheduled for removal — do not build new dependencies"),
    ("Experimental", "Under development — schema may change without notice"),
]

GLOSSARY_TERMS = [
    ("Revenue", "Total income from sales of goods and services", "Finance"),
    ("Net Revenue", "Revenue after discounts, returns, and allowances", "Finance"),
    ("COGS", "Cost of Goods Sold — direct cost of producing items sold", "Finance"),
    ("Gross Margin", "Net Revenue minus COGS, expressed as a percentage of revenue", "Finance"),
    ("AOV", "Average Order Value — mean transaction value per order", "eCommerce"),
    ("Customer Lifetime Value", "Total predicted revenue from a customer relationship", "eCommerce"),
    ("Pipeline", "Total value of active sales opportunities not yet closed", "Sales"),
    ("Win Rate", "Percentage of opportunities resulting in closed-won deals", "Sales"),
    ("Weighted Pipeline", "Pipeline value adjusted by close probability", "Sales"),
    ("Days Sales Outstanding", "Average days to collect payment after invoicing", "Finance"),
    ("AR Aging", "Categorization of accounts receivable by days outstanding", "Finance"),
    ("Reconciliation Variance", "Difference between e-commerce and GL-booked revenue", "Finance"),
]

# PII column names (matched case-insensitively)
PII_COLUMN_NAMES = {
    "email", "first_name", "last_name", "phone", "address_line1", "city",
    "postal_code", "card_last4", "billing_city", "manager",
    "email_hash", "full_name", "phone_normalized", "customer_name", "vendor_name",
}


# ═══════════════════════════════════════════════════════════════════════
# Graph Builder
# ═══════════════════════════════════════════════════════════════════════

class DataLakeBuilder:
    """Builds the full data lake graph in memory, then optionally pushes to FalkorDB.

    Supports target node counts from ~1k to 1M+ via --nodes flag.
    Structure is built realistically across global subsidiaries, regions, and
    source systems. Lineage coverage is configurable via --lineage-pct.

    Architecture for scaling:
      Domain (Enterprise)
        └── Subsidiary (business unit, e.g. "ACME North America")
              └── Region (e.g. us-east-1)
                    └── Source Platforms (PostgreSQL, Salesforce, SAP, ...)
                          └── Databases / Orgs / Systems
                                └── Schemas / Modules
                                      └── Tables (dataset)
                                            └── Columns (schemaField)
      + Shared infrastructure: Staging (S3), Bronze/Silver (Databricks), Gold/Reporting (Snowflake)
      + Consumption: Tableau dashboards, reports, apps per subsidiary
    """

    # ── Global-scale configuration ─────────────────────────────────

    SUBSIDIARIES = [
        ("ACME North America", "NA", ["us-east-1", "us-west-2", "ca-central-1"]),
        ("ACME Europe", "EU", ["eu-west-1", "eu-central-1", "eu-north-1"]),
        ("ACME Asia Pacific", "APAC", ["ap-southeast-1", "ap-northeast-1", "ap-south-1"]),
        ("ACME Latin America", "LATAM", ["sa-east-1", "us-east-1"]),
        ("ACME Middle East & Africa", "MEA", ["me-south-1", "af-south-1"]),
    ]

    # Source system platform types with typical table schemas
    SOURCE_PLATFORM_TYPES = [
        ("PostgreSQL", "postgresql", "oltp"),
        ("Salesforce", "salesforce", "crm"),
        ("SAP ERP", "sap", "erp"),
        ("MongoDB", "mongodb", "nosql"),
        ("Oracle DB", "oracle", "oltp"),
        ("MySQL", "mysql", "oltp"),
        ("Dynamics 365", "dynamics", "crm"),
        ("Workday", "workday", "hcm"),
        ("ServiceNow", "servicenow", "itsm"),
        ("Stripe", "stripe", "payments"),
        ("Snowflake", "snowflake", "analytics"),
        ("BigQuery", "bigquery", "analytics"),
    ]

    # Realistic table templates for procedural generation
    TABLE_TEMPLATES = {
        "oltp": [
            ("customers", 12), ("orders", 14), ("order_items", 8), ("products", 10),
            ("payments", 10), ("shipping", 7), ("addresses", 8), ("inventory", 8),
            ("returns", 8), ("reviews", 8), ("categories", 5), ("promotions", 7),
            ("wishlists", 5), ("cart_items", 6), ("subscriptions", 9), ("invoices", 10),
        ],
        "crm": [
            ("accounts", 11), ("contacts", 10), ("opportunities", 11), ("activities", 9),
            ("campaigns", 10), ("leads", 10), ("cases", 9), ("tasks", 7),
            ("notes", 5), ("email_messages", 8), ("call_logs", 7), ("quotes", 9),
        ],
        "erp": [
            ("general_ledger", 13), ("accounts_payable", 12), ("accounts_receivable", 12),
            ("cost_centers", 6), ("fixed_assets", 10), ("purchase_orders", 10),
            ("vendors", 8), ("budgets", 9), ("journal_entries", 10), ("tax_codes", 6),
            ("bank_accounts", 7), ("payment_runs", 8),
        ],
        "nosql": [
            ("user_profiles", 15), ("sessions", 8), ("events", 10), ("preferences", 6),
            ("notifications", 7), ("audit_log", 9), ("feature_flags", 5),
        ],
        "hcm": [
            ("employees", 14), ("positions", 8), ("departments", 6), ("compensation", 10),
            ("benefits", 8), ("time_off", 7), ("performance_reviews", 9), ("payroll", 11),
        ],
        "itsm": [
            ("incidents", 12), ("changes", 10), ("problems", 9), ("assets", 11),
            ("cmdb_items", 8), ("service_requests", 9), ("knowledge_articles", 6),
        ],
        "payments": [
            ("charges", 10), ("refunds", 8), ("disputes", 9), ("payouts", 7),
            ("customers", 8), ("subscriptions", 10), ("invoices", 9),
        ],
        "analytics": [
            ("dim_customer", 12), ("dim_product", 10), ("dim_date", 11),
            ("fact_sales", 14), ("fact_inventory", 10), ("fact_web_traffic", 12),
            ("agg_daily_sales", 8), ("agg_monthly_kpis", 10),
        ],
    }

    # Realistic column type distribution for procedural columns
    COLUMN_TYPES = [
        ("bigint", False), ("varchar(255)", False), ("varchar(100)", False),
        ("varchar(50)", False), ("decimal(12,2)", False), ("decimal(15,2)", False),
        ("timestamp", False), ("date", False), ("boolean", False), ("int", False),
        ("text", False), ("varchar(20)", False), ("varchar(3)", False),
        ("varchar(18)", False), ("varchar(64)", True),  # potential PII hash
    ]

    # Column name pools for realistic naming
    COLUMN_NAMES = {
        "id": ["id", "key", "pk", "uuid", "code", "number"],
        "name": ["name", "title", "label", "display_name", "description"],
        "amount": ["amount", "total", "subtotal", "balance", "revenue", "cost", "price", "fee"],
        "date": ["date", "created_at", "updated_at", "timestamp", "due_date", "start_date", "end_date"],
        "status": ["status", "state", "phase", "stage", "type", "category", "priority"],
        "fk": ["customer_id", "order_id", "product_id", "account_id", "user_id", "vendor_id"],
        "flag": ["is_active", "is_deleted", "is_verified", "is_primary", "is_default"],
        "text": ["notes", "comment", "reason", "source", "channel", "method", "provider"],
        "pii": ["email", "phone", "first_name", "last_name", "address", "postal_code"],
    }

    def __init__(self, nodes: int = 0, lineage_pct: int = 100, scale: int = 1):
        """
        :param nodes: Target node count (0 = use scale-based default)
        :param lineage_pct: Percentage of datasets that get column-level lineage (0-100)
        :param scale: Legacy scale multiplier (used if nodes=0; 1=~1k, 2=~3k, etc.)
        """
        self.scale = max(1, scale)
        self.target_nodes = nodes
        self.lineage_pct = max(0, min(100, lineage_pct))
        self._urn_counter = 0  # monotonic counter for collision-free URNs
        self.nodes: List[GraphNode] = []
        self.edges: List[GraphEdge] = []
        self.urn_index: Dict[str, GraphNode] = {}  # urn -> node
        self.urn_to_label: Dict[str, str] = {}  # urn -> entity_type string
        # Track column URNs by qualified path for lineage wiring
        # key = "layer.table.column" e.g. "ecommerce.customers.email"
        self.column_urn: Dict[str, str] = {}
        self.dataset_urn: Dict[str, str] = {}  # "layer.table" -> urn
        self.tag_urns: Dict[str, str] = {}  # tag_name -> urn
        self.glossary_urns: Dict[str, str] = {}
        self.now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Shared platform/container URNs (set during build, avoid fragile name lookups)
        self.domain_urn: Optional[str] = None
        self.airflow_system: Optional[str] = None
        self.dbt_system: Optional[str] = None
        self.databricks_urn: Optional[str] = None  # SYSTEM (hosts dataFlows + data)
        self.snowflake_urn: Optional[str] = None
        self.tableau_system: Optional[str] = None

    def _lineage_edge_type(self) -> str:
        """TRANSFORMS for all column-level lineage."""
        return "TRANSFORMS"

    def _urn(self, entity_type: str, name: str) -> str:
        self._urn_counter += 1
        clean = name.lower().replace(" ", "_").replace("/", "_").replace(".", "_")[:60]
        return f"urn:li:{entity_type}:{clean}_{self._urn_counter:08x}"

    def add_node(
        self, entity_type: str, name: str, parent_urn: str = None,
        description: str = None, layer: str = None, source_system: str = None,
        tags: List[str] = None, props: Dict[str, Any] = None,
    ) -> str:
        urn = self._urn(entity_type, name)
        # Inherit layer from parent if not explicitly set
        if not layer and parent_urn and parent_urn in self.urn_index:
            layer = self.urn_index[parent_urn].layer_assignment

        node = GraphNode(
            urn=urn,
            entityType=entity_type,
            displayName=name,
            qualifiedName=f"{parent_urn}.{name}" if parent_urn else name,
            description=description,
            properties=props or {},
            tags=tags or [],
            layerAssignment=layer,
            sourceSystem=source_system,
            lastSyncedAt=self.now,
        )
        self.nodes.append(node)
        self.urn_index[urn] = node
        self.urn_to_label[urn] = entity_type

        if parent_urn:
            self.add_edge(parent_urn, urn, "CONTAINS")

        return urn

    def add_edge(
        self, source: str, target: str, edge_type: str,
        props: Dict[str, Any] = None, confidence: float = None,
    ):
        self._urn_counter += 1
        edge_id = f"e-{self._urn_counter:08x}"
        edge = GraphEdge(
            id=edge_id,
            sourceUrn=source,
            targetUrn=target,
            edgeType=edge_type,
            confidence=confidence,
            properties=props or {},
        )
        self.edges.append(edge)

    # ── Layer builders ──────────────────────────────────────────────

    def _add_table_columns(
        self, sys_key: str, table_name: str, columns: List[tuple],
        ds_urn: str, layer: str, col_prefix: str,
    ):
        """Add SchemaField nodes to a dataset and register in column_urn index.
        Returns True if any column is PII."""
        has_pii = False
        for col_name, dtype, nullable, is_pii, col_desc in columns:
            col_urn = self.add_node(
                "schemaField", col_name,
                parent_urn=ds_urn,
                description=col_desc,
                props={"dataType": dtype, "nullable": nullable},
                tags=["pii"] if is_pii else [],
            )
            self.column_urn[f"{col_prefix}.{col_name}"] = col_urn
            if is_pii:
                has_pii = True
                if "PII" in self.tag_urns:
                    self.add_edge(col_urn, self.tag_urns["PII"], "TAGGED_WITH")
        return has_pii

    def build_governance(self):
        """Create Tag and GlossaryTerm nodes."""
        logger.info("Building governance layer (tags + glossary)...")

        for tag_name, tag_desc in GOVERNANCE_TAGS:
            urn = self.add_node(
                "tag", tag_name,
                description=tag_desc,
                props={"category": "governance"},
            )
            self.tag_urns[tag_name] = urn

        for term_name, term_desc, domain in GLOSSARY_TERMS:
            urn = self.add_node(
                "glossaryTerm", term_name,
                description=term_desc,
                props={"domain": domain},
            )
            self.glossary_urns[term_name] = urn

    # ── 1. Source Systems ───────────────────────────────────────────
    # Each source uses the real platform hierarchy:
    #   PostgreSQL:  Platform → Server → Database → Schema → Table → Column
    #   Salesforce:  Platform → Org Instance → Object → Field
    #   SAP ERP:     Platform → System → Module → Table → Column

    def build_source_postgres(self):
        """E-Commerce PostgreSQL: Platform → Container (db.schema) → Tables."""
        logger.info("  Source: E-Commerce PostgreSQL")
        platform = self.add_node(
            "dataPlatform", "PostgreSQL",
            parent_urn=self.domain_urn,
            description="Open-source relational database",
            source_system="postgresql",
        )
        # Flatten server/database/schema into one container under dataPlatform
        schema_container = self.add_node(
            "container", "ecomm_prod.public",
            parent_urn=platform,
            description="E-commerce transactional database — ecomm-prod-01.internal (AWS RDS, PostgreSQL 16)",
            layer="source", source_system="postgresql",
            props={
                "type": "schema", "server": "ecomm-prod-01.internal",
                "database": "ecomm_prod", "schema": "public",
                "engine": "PostgreSQL 16.2", "region": "us-east-1",
            },
        )

        for table_name, columns in ECOMMERCE_TABLES.items():
            ds_urn = self.add_node(
                "dataset", table_name,
                parent_urn=schema_container,
                description=f"ecomm_prod.public.{table_name}",
                layer="source", source_system="postgresql",
                tags=["source", "oltp"],
            )
            self.dataset_urn[f"ecommerce.{table_name}"] = ds_urn
            col_prefix = f"ecommerce.{table_name}"
            has_pii = self._add_table_columns("ecommerce", table_name, columns, ds_urn, "source", col_prefix)
            if has_pii and "GDPR-Regulated" in self.tag_urns:
                self.add_edge(ds_urn, self.tag_urns["GDPR-Regulated"], "TAGGED_WITH")

    def build_source_salesforce(self):
        """Salesforce CRM: Platform → Org → Objects."""
        logger.info("  Source: Salesforce CRM")
        platform = self.add_node(
            "dataPlatform", "Salesforce",
            parent_urn=self.domain_urn,
            description="CRM platform (Sales Cloud)",
            source_system="salesforce",
        )
        org = self.add_node(
            "container", "acme-corp.my.salesforce.com",
            parent_urn=platform,
            description="Production Salesforce org (Enterprise edition)",
            layer="source", source_system="salesforce",
            props={"type": "org", "edition": "Enterprise", "org_id": "00D5f000006XXXX"},
        )

        for table_name, columns in CRM_TABLES.items():
            ds_urn = self.add_node(
                "dataset", table_name,
                parent_urn=org,
                description=f"Salesforce standard object: {table_name}",
                layer="source", source_system="salesforce",
                tags=["source", "crm"],
            )
            self.dataset_urn[f"crm.{table_name}"] = ds_urn
            col_prefix = f"crm.{table_name}"
            has_pii = self._add_table_columns("crm", table_name, columns, ds_urn, "source", col_prefix)
            if has_pii and "GDPR-Regulated" in self.tag_urns:
                self.add_edge(ds_urn, self.tag_urns["GDPR-Regulated"], "TAGGED_WITH")

    def build_source_sap(self):
        """SAP ERP: Platform → Container (system:module) → Tables."""
        logger.info("  Source: SAP ERP")
        platform = self.add_node(
            "dataPlatform", "SAP ERP",
            parent_urn=self.domain_urn,
            description="SAP ECC 6.0 on HANA",
            source_system="sap",
        )
        # Flatten system+module into one container per module directly under dataPlatform
        module_map = {
            "general_ledger": ("FI-GL", "Financial Accounting — General Ledger"),
            "accounts_payable": ("FI-AP", "Financial Accounting — Accounts Payable"),
            "accounts_receivable": ("FI-AR", "Financial Accounting — Accounts Receivable"),
            "cost_centers": ("CO-CCA", "Controlling — Cost Center Accounting"),
        }
        module_urns: Dict[str, str] = {}
        for table_name, columns in ERP_TABLES.items():
            mod_code, mod_desc = module_map[table_name]
            if mod_code not in module_urns:
                module_urns[mod_code] = self.add_node(
                    "container", f"PRD-800:{mod_code}",
                    parent_urn=platform,
                    description=f"{mod_desc} — PRD-800 (client 800, SAP_BASIS 756, HANA 2.0)",
                    layer="source", source_system="sap",
                    props={"type": "sap_module", "sap_system": "PRD-800", "module": mod_code},
                )
            ds_urn = self.add_node(
                "dataset", table_name,
                parent_urn=module_urns[mod_code],
                description=f"SAP table: {table_name}",
                layer="source", source_system="sap",
                tags=["source", "erp"],
            )
            self.dataset_urn[f"erp.{table_name}"] = ds_urn
            col_prefix = f"erp.{table_name}"
            has_pii = self._add_table_columns("erp", table_name, columns, ds_urn, "source", col_prefix)
            if has_pii and "GDPR-Regulated" in self.tag_urns:
                self.add_edge(ds_urn, self.tag_urns["GDPR-Regulated"], "TAGGED_WITH")

    # ── 2. Staging ──────────────────────────────────────────────────
    # AWS S3: Platform → Bucket → Prefix per source → Datasets

    def build_staging(self):
        """Staging layer: S3 → bucket → source-partitioned prefixes → raw Parquet tables."""
        logger.info("  Staging layer (raw landing zone)...")

        s3_platform = self.add_node(
            "dataPlatform", "AWS S3",
            parent_urn=self.domain_urn,
            description="Amazon S3 object storage",
            source_system="aws_s3",
        )

        # Airflow DAG for ingestion
        ingest_flow = self.add_node(
            "dataFlow", "Airflow: raw_ingestion_dag",
            parent_urn=self.airflow_system,
            description="Airflow DAG: daily extract from all source systems → S3 staging",
            source_system="airflow",
            props={"schedule_interval": "0 4 * * *", "owner": "data-platform-team"},
        )

        for sys_key, sys_label, tables in [
            ("ecommerce", "ecommerce", ECOMMERCE_TABLES),
            ("crm", "crm", CRM_TABLES),
            ("erp", "erp", ERP_TABLES),
        ]:
            # One container per source prefix directly under S3 dataPlatform (no nesting)
            source_prefix = self.add_node(
                "container", f"acme-data-lake/staging/{sys_key}",
                parent_urn=s3_platform,
                description=f"Raw data from {sys_label} source system (Parquet, date-partitioned)",
                layer="staging", source_system="aws_s3",
                props={"type": "s3_prefix", "bucket": "acme-data-lake", "retention_days": 90},
            )

            for table_name, columns in tables.items():
                job = self.add_node(
                    "dataJob", f"extract_{sys_key}_{table_name}",
                    parent_urn=ingest_flow,
                    description=f"Full extract: {sys_key}.{table_name} → S3 Parquet",
                    source_system="airflow",
                    props={"schedule": "daily", "sla_minutes": 30, "retry_count": 3},
                )
                src_ds = self.dataset_urn.get(f"{sys_key}.{table_name}")
                if src_ds:
                    self.add_edge(job, src_ds, "CONSUMES", confidence=1.0)

                stg_ds = self.add_node(
                    "dataset", f"raw_{table_name}",
                    parent_urn=source_prefix,
                    description=f"Raw Parquet: {sys_key}.{table_name} with ingestion metadata",
                    layer="staging", source_system="airflow",
                    tags=["staging", "raw", "parquet"],
                )
                self.dataset_urn[f"staging.{sys_key}.{table_name}"] = stg_ds
                self.add_edge(job, stg_ds, "PRODUCES", confidence=1.0)

                if "SLA-Critical" in self.tag_urns:
                    self.add_edge(stg_ds, self.tag_urns["SLA-Critical"], "TAGGED_WITH")

                # 1:1 column copy + lineage
                for col_name, dtype, nullable, is_pii, col_desc in columns:
                    stg_col = self.add_node(
                        "schemaField", col_name,
                        parent_urn=stg_ds,
                        description=f"Raw copy: {col_desc}",
                        props={"dataType": dtype, "nullable": nullable},
                    )
                    self.column_urn[f"staging.{sys_key}.{table_name}.{col_name}"] = stg_col
                    src_col = self.column_urn.get(f"{sys_key}.{table_name}.{col_name}")
                    if src_col:
                        self.add_edge(src_col, stg_col, "TRANSFORMS", {"logic": "Parquet COPY (full extract)"}, confidence=1.0)

                # Metadata columns (no upstream lineage — generated by Airflow)
                for meta_col, meta_type, meta_desc in [
                    ("_ingestion_ts", "timestamp", "When this row was extracted"),
                    ("_source_file", "varchar(500)", "S3 key of the source Parquet file"),
                    ("_batch_id", "varchar(36)", "Airflow DAG run ID"),
                ]:
                    self.add_node(
                        "schemaField", meta_col,
                        parent_urn=stg_ds,
                        description=meta_desc,
                        props={"dataType": meta_type, "nullable": False},
                        tags=["metadata"],
                    )

    # ── 3. Bronze ───────────────────────────────────────────────────
    # Databricks: Platform → Workspace → Unity Catalog → bronze schema → tables

    def build_bronze(self):
        """Bronze layer: immutable Delta Lake tables in Databricks Unity Catalog."""
        logger.info("  Bronze layer (immutable history)...")

        self.databricks_urn = self.add_node(
            "system", "Databricks",
            parent_urn=self.domain_urn,
            description="Databricks Lakehouse platform (Unity Catalog + Spark processing)",
            source_system="databricks",
            props={"workspace": "acme-analytics-prod", "cloud": "AWS", "region": "us-east-1", "sku": "Premium"},
        )
        # Flatten workspace/catalog/schema into one container per schema under system
        bronze_schema = self.add_node(
            "container", "data_lake.bronze",
            parent_urn=self.databricks_urn,
            description="Unity Catalog: data_lake.bronze — immutable, append-only raw data (Delta Lake)",
            layer="bronze", source_system="databricks",
            props={"type": "schema", "catalog": "data_lake", "schema": "bronze", "format": "delta"},
        )

        bronze_flow = self.add_node(
            "dataFlow", "Spark: bronze_autoloader",
            parent_urn=self.databricks_urn,
            description="Databricks Auto Loader: S3 staging → Delta bronze (CloudFiles trigger)",
            source_system="databricks",
            props={"trigger": "availableNow", "checkpoint_location": "s3://acme-data-lake/_checkpoints/bronze/"},
        )

        for sys_key, tables in [("ecommerce", ECOMMERCE_TABLES), ("crm", CRM_TABLES), ("erp", ERP_TABLES)]:
            for table_name, columns in tables.items():
                job = self.add_node(
                    "dataJob", f"bronze_{sys_key}_{table_name}",
                    parent_urn=bronze_flow,
                    description=f"Auto Loader: append raw_{table_name} → bronze_{table_name} (Delta)",
                    source_system="databricks",
                    props={"mode": "append", "format": "delta", "partition_by": "_ingestion_date",
                           "schema_evolution": "addNewColumns"},
                )
                stg_ds = self.dataset_urn.get(f"staging.{sys_key}.{table_name}")
                if stg_ds:
                    self.add_edge(job, stg_ds, "CONSUMES", confidence=1.0)

                brz_ds = self.add_node(
                    "dataset", f"bronze_{table_name}",
                    parent_urn=bronze_schema,
                    description=f"data_lake.bronze.bronze_{table_name} — immutable history of {sys_key}.{table_name}",
                    layer="bronze", source_system="databricks",
                    tags=["bronze", "delta", "append-only"],
                )
                self.dataset_urn[f"bronze.{sys_key}.{table_name}"] = brz_ds
                self.add_edge(job, brz_ds, "PRODUCES", confidence=1.0)

                # 1:1 column lineage staging → bronze
                for col_name, dtype, nullable, is_pii, col_desc in columns:
                    brz_col = self.add_node(
                        "schemaField", col_name,
                        parent_urn=brz_ds,
                        description=col_desc,
                        props={"dataType": dtype, "nullable": nullable},
                    )
                    self.column_urn[f"bronze.{sys_key}.{table_name}.{col_name}"] = brz_col
                    stg_col = self.column_urn.get(f"staging.{sys_key}.{table_name}.{col_name}")
                    if stg_col:
                        self.add_edge(stg_col, brz_col, "TRANSFORMS", {"logic": "Delta APPEND (schema on read)"}, confidence=1.0)

                # Bronze-specific metadata columns
                for meta_col, meta_type, meta_desc in [
                    ("_ingestion_date", "date", "Partition key: date of ingestion"),
                    ("_file_name", "varchar(500)", "Source S3 Parquet file path"),
                    ("_row_hash", "varchar(64)", "SHA256 of business key columns (dedup reference)"),
                ]:
                    self.add_node(
                        "schemaField", meta_col,
                        parent_urn=brz_ds,
                        description=meta_desc,
                        props={"dataType": meta_type, "nullable": False},
                        tags=["metadata"],
                    )

    # ── 4. Silver ───────────────────────────────────────────────────
    # Silver schema lives under the same Unity Catalog as bronze

    def build_silver(self):
        """Silver layer: cleaned/typed/deduped tables via dbt on Databricks."""
        logger.info("  Silver layer (cleaned + transformed)...")

        silver_schema = self.add_node(
            "container", "data_lake.silver",
            parent_urn=self.databricks_urn,
            description="Unity Catalog: data_lake.silver — cleaned, typed, deduplicated (Delta, MERGE upserts)",
            layer="silver", source_system="databricks",
            props={"type": "schema", "catalog": "data_lake", "schema": "silver",
                   "format": "delta", "merge_strategy": "SCD Type 1"},
        )

        dbt_silver_flow = self.add_node(
            "dataFlow", "dbt: silver_transforms",
            parent_urn=self.dbt_system,
            description="dbt project: bronze → silver (cleaning, dedup, type casting, business rules)",
            source_system="dbt",
            props={"dbt_project": "acme_data_lake", "target": "databricks", "threads": 8},
        )

        for silver_table, spec in SILVER_TRANSFORMS.items():
            job = self.add_node(
                "dataJob", f"dbt_model_{silver_table}",
                parent_urn=dbt_silver_flow,
                description=f"dbt incremental model: {silver_table}",
                source_system="dbt",
                props={"materialization": "incremental", "unique_key": spec["columns"][0][0],
                       "strategy": "merge", "on_schema_change": "sync_all_columns"},
            )
            for sys_key, src_table in spec["sources"]:
                brz_ds = self.dataset_urn.get(f"bronze.{sys_key}.{src_table}")
                if brz_ds:
                    self.add_edge(job, brz_ds, "CONSUMES", confidence=0.95)

            silver_ds = self.add_node(
                "dataset", silver_table,
                parent_urn=silver_schema,
                description=f"data_lake.silver.{silver_table} — cleaned and deduplicated",
                layer="silver", source_system="dbt",
                tags=["silver", "cleaned", "dbt"],
            )
            self.dataset_urn[f"silver.{silver_table}"] = silver_ds
            self.add_edge(job, silver_ds, "PRODUCES", confidence=0.95)

            if "SLA-Critical" in self.tag_urns:
                self.add_edge(silver_ds, self.tag_urns["SLA-Critical"], "TAGGED_WITH")

            for col_name, dtype, source_refs, logic, col_desc in spec["columns"]:
                is_pii = col_name.lower() in PII_COLUMN_NAMES
                silver_col = self.add_node(
                    "schemaField", col_name,
                    parent_urn=silver_ds,
                    description=col_desc,
                    props={"dataType": dtype, "transformLogic": logic},
                    tags=["pii"] if is_pii else [],
                )
                self.column_urn[f"silver.{silver_table}.{col_name}"] = silver_col
                if is_pii and "PII" in self.tag_urns:
                    self.add_edge(silver_col, self.tag_urns["PII"], "TAGGED_WITH")

                for src_ref in source_refs:
                    src_table, src_col_name = src_ref
                    src_col = self.column_urn.get(f"bronze.{src_table}.{src_col_name}")
                    if src_col:
                        conf = 1.0 if logic == "pass-through" else round(random.uniform(0.85, 0.98), 2)
                        self.add_edge(src_col, silver_col, self._lineage_edge_type(), {"logic": logic}, confidence=conf)

    # ── 4b. dbt Quality Tests ───────────────────────────────────────

    def build_dbt_tests(self):
        """dbt test jobs that validate silver/gold tables (quality gates)."""
        logger.info("  Data quality tests (dbt test)...")

        test_flow = self.add_node(
            "dataFlow", "dbt: data_quality_tests",
            parent_urn=self.dbt_system,
            description="dbt test suite: schema tests, data tests, freshness checks",
            source_system="dbt",
            props={"run_after": "dbt run", "fail_action": "warn + alert"},
        )

        # Silver tests
        silver_tests = [
            ("clean_customers", "customer_id", "not_null", "Customer PK must never be null"),
            ("clean_customers", "customer_id", "unique", "Customer PK must be unique (post-dedup)"),
            ("clean_customers", "email_hash", "not_null", "Email hash required for identity resolution"),
            ("clean_orders", "order_id", "unique", "Order PK must be unique"),
            ("clean_orders", "total_amount", "positive_value", "Total amount must be > 0"),
            ("clean_orders", "status", "accepted_values", "Status must be in allowed enum values"),
            ("clean_opportunities", "probability", "range_0_100", "Probability must be 0-100"),
            ("clean_gl_entries", "net_amount", "not_null", "GL net amount required for balancing"),
        ]
        for table, column, test_type, desc in silver_tests:
            test_job = self.add_node(
                "dataJob", f"test_{table}_{column}_{test_type}",
                parent_urn=test_flow,
                description=desc,
                source_system="dbt",
                props={"test_type": test_type, "severity": "error", "column": column},
            )
            ds = self.dataset_urn.get(f"silver.{table}")
            if ds:
                self.add_edge(test_job, ds, "CONSUMES", confidence=1.0)

        # Gold tests
        gold_tests = [
            ("dim_customer", "customer_key", "unique", "Surrogate key must be unique"),
            ("dim_customer", "customer_key", "not_null", "Surrogate key must not be null"),
            ("dim_product", "product_key", "unique", "Surrogate key must be unique"),
            ("fact_orders", "customer_key", "relationships_dim_customer", "FK must reference dim_customer"),
            ("fact_orders", "product_key", "relationships_dim_product", "FK must reference dim_product"),
            ("fact_orders", "net_revenue", "not_null", "Revenue must not be null"),
            ("fact_revenue", "variance", "tolerance_check", "Recon variance must be < 1% of order_revenue"),
            ("fact_pipeline", "amount", "positive_value", "Pipeline amount must be positive"),
        ]
        for table, column, test_type, desc in gold_tests:
            test_job = self.add_node(
                "dataJob", f"test_{table}_{column}_{test_type}",
                parent_urn=test_flow,
                description=desc,
                source_system="dbt",
                props={"test_type": test_type, "severity": "error", "column": column},
            )
            ds = self.dataset_urn.get(f"gold.{table}")
            if ds:
                self.add_edge(test_job, ds, "CONSUMES", confidence=1.0)

        # Freshness tests (source freshness)
        freshness_tests = [
            ("staging.ecommerce.orders", "_ingestion_ts", 6, "E-commerce orders must refresh within 6 hours"),
            ("staging.crm.opportunities", "_ingestion_ts", 12, "CRM opportunities must refresh within 12 hours"),
            ("staging.erp.general_ledger", "_ingestion_ts", 24, "GL must refresh within 24 hours"),
        ]
        for ds_key, col, max_hours, desc in freshness_tests:
            test_job = self.add_node(
                "dataJob", f"freshness_{ds_key.replace('.', '_')}",
                parent_urn=test_flow,
                description=desc,
                source_system="dbt",
                props={"test_type": "freshness", "max_hours": max_hours, "column": col},
            )
            ds = self.dataset_urn.get(ds_key)
            if ds:
                self.add_edge(test_job, ds, "CONSUMES", confidence=1.0)

    # ── 5. Gold ─────────────────────────────────────────────────────
    # Snowflake: Platform → Account → Database → Schema → Tables

    def build_gold(self):
        """Gold layer: star schema in Snowflake (Account → Database → Schema → Tables)."""
        logger.info("  Gold layer (dimensional model)...")

        self.snowflake_urn = self.add_node(
            "dataPlatform", "Snowflake",
            parent_urn=self.domain_urn,
            description="Snowflake enterprise data warehouse",
            source_system="snowflake",
            props={"account": "ACME_CORP", "edition": "Business Critical", "region": "AWS us-east-1"},
        )
        # Flatten account/database/schema into one container per schema under dataPlatform
        gold_schema = self.add_node(
            "container", "ANALYTICS.GOLD",
            parent_urn=self.snowflake_urn,
            description="Gold schema: conformed dimensional model (star schema) — ACME_CORP.ANALYTICS.GOLD",
            layer="gold", source_system="snowflake",
            props={"type": "schema", "account": "ACME_CORP", "database": "ANALYTICS", "schema": "GOLD"},
        )

        dbt_gold_flow = self.add_node(
            "dataFlow", "dbt: gold_dimensional_model",
            parent_urn=self.dbt_system,
            description="dbt project: silver → gold star schema (dims + facts)",
            source_system="dbt",
            props={"dbt_project": "acme_data_lake", "target": "snowflake", "threads": 16},
        )

        for dim_name, spec in GOLD_DIMENSIONS.items():
            self._build_gold_table(dim_name, spec, gold_schema, dbt_gold_flow, "dimension")
        for fact_name, spec in GOLD_FACTS.items():
            self._build_gold_table(fact_name, spec, gold_schema, dbt_gold_flow, "fact")

        # Tag gold datasets as Certified
        for key, urn in self.dataset_urn.items():
            if key.startswith("gold.") and "Certified" in self.tag_urns:
                self.add_edge(urn, self.tag_urns["Certified"], "TAGGED_WITH")

        # Wire glossary terms to domain
        for _, urn in self.glossary_urns.items():
            self.add_edge(urn, self.domain_urn, "BELONGS_TO")

        # RELATED_TO between dims and their facts (star schema joins)
        for fact_name in GOLD_FACTS:
            fact_urn = self.dataset_urn.get(f"gold.{fact_name}")
            if not fact_urn:
                continue
            for dim_name in GOLD_DIMENSIONS:
                dim_urn = self.dataset_urn.get(f"gold.{dim_name}")
                if dim_urn:
                    self.add_edge(fact_urn, dim_urn, "DEPENDS_ON", {"reason": "star schema FK join"})

    def _build_gold_table(self, table_name, spec, parent_urn, flow_urn, table_type):
        """Build a single gold dim/fact with full column lineage."""
        job = self.add_node(
            "dataJob", f"dbt_model_{table_name}",
            parent_urn=flow_urn,
            description=f"dbt table model: ANALYTICS.GOLD.{table_name}",
            source_system="dbt",
            props={"materialization": "table", "table_type": table_type,
                   "grain": table_name.replace("dim_", "").replace("fact_", "")},
        )
        for src_table in spec["sources"]:
            src_ds = self.dataset_urn.get(f"silver.{src_table}") or self.dataset_urn.get(f"gold.{src_table}")
            if src_ds:
                self.add_edge(job, src_ds, "CONSUMES", confidence=0.9)

        ds_urn = self.add_node(
            "dataset", table_name,
            parent_urn=parent_urn,
            description=spec["description"],
            layer="gold", source_system="dbt",
            tags=["gold", table_type, "dbt", "certified"],
        )
        self.dataset_urn[f"gold.{table_name}"] = ds_urn
        self.add_edge(job, ds_urn, "PRODUCES", confidence=0.9)

        if "SOX-Auditable" in self.tag_urns and table_type == "fact":
            self.add_edge(ds_urn, self.tag_urns["SOX-Auditable"], "TAGGED_WITH")

        for col_name, dtype, source_refs, logic, col_desc in spec["columns"]:
            col_urn = self.add_node(
                "schemaField", col_name,
                parent_urn=ds_urn,
                description=col_desc,
                props={"dataType": dtype, "transformLogic": logic},
            )
            self.column_urn[f"gold.{table_name}.{col_name}"] = col_urn
            for src_table, src_col in source_refs:
                src_col_urn = (
                    self.column_urn.get(f"silver.{src_table}.{src_col}")
                    or self.column_urn.get(f"gold.{src_table}.{src_col}")
                )
                if src_col_urn:
                    conf = 1.0 if logic == "pass-through" else round(random.uniform(0.8, 0.95), 2)
                    self.add_edge(src_col_urn, col_urn, "TRANSFORMS", {"logic": logic}, confidence=conf)

    # ── 6. Reporting / Marts ────────────────────────────────────────
    # Reporting schema in same Snowflake database; Tableau with site/project nesting

    def build_reporting(self):
        """Reporting mart tables + Tableau dashboards + scheduled reports + apps."""
        logger.info("  Reporting layer (marts + dashboards)...")

        # ── Snowflake REPORTING schema (sibling of GOLD) ────────────
        rpt_schema = self.add_node(
            "container", "ANALYTICS.REPORTING",
            parent_urn=self.snowflake_urn,
            description="Reporting schema: pre-aggregated mart tables for BI consumption — ACME_CORP.ANALYTICS.REPORTING",
            layer="mart", source_system="snowflake",
            props={"type": "schema", "account": "ACME_CORP", "database": "ANALYTICS", "schema": "REPORTING"},
        )

        dbt_rpt_flow = self.add_node(
            "dataFlow", "dbt: reporting_marts",
            parent_urn=self.dbt_system,
            description="dbt project: gold → reporting aggregated mart tables",
            source_system="dbt",
            props={"dbt_project": "acme_data_lake", "target": "snowflake"},
        )

        for rpt_name, spec in REPORTING_TABLES.items():
            job = self.add_node(
                "dataJob", f"dbt_model_{rpt_name}",
                parent_urn=dbt_rpt_flow,
                description=f"dbt table model: ANALYTICS.REPORTING.{rpt_name}",
                source_system="dbt",
                props={"materialization": "table", "table_type": "aggregate"},
            )
            for src_table in spec["sources"]:
                src_ds = self.dataset_urn.get(f"gold.{src_table}")
                if src_ds:
                    self.add_edge(job, src_ds, "CONSUMES", confidence=0.95)

            rpt_ds = self.add_node(
                "dataset", rpt_name,
                parent_urn=rpt_schema,
                description=spec["description"],
                layer="mart", source_system="dbt",
                tags=["mart", "aggregated", "dbt"],
            )
            self.dataset_urn[f"mart.{rpt_name}"] = rpt_ds
            self.add_edge(job, rpt_ds, "PRODUCES", confidence=0.95)

            if "Certified" in self.tag_urns:
                self.add_edge(rpt_ds, self.tag_urns["Certified"], "TAGGED_WITH")

            for col_name, dtype, source_refs, logic, col_desc in spec["columns"]:
                rpt_col = self.add_node(
                    "schemaField", col_name,
                    parent_urn=rpt_ds,
                    description=col_desc,
                    props={"dataType": dtype, "aggregationLogic": logic},
                )
                self.column_urn[f"mart.{rpt_name}.{col_name}"] = rpt_col
                for src_table, src_col in source_refs:
                    src_col_urn = self.column_urn.get(f"gold.{src_table}.{src_col}")
                    if src_col_urn:
                        self.add_edge(src_col_urn, rpt_col, "TRANSFORMS", {"logic": logic}, confidence=0.9)

        # ── Tableau: System → Container (site/project flattened), System → Dashboard → Chart ──
        self.tableau_system = self.add_node(
            "system", "Tableau Cloud",
            parent_urn=self.domain_urn,
            description="Tableau Cloud BI platform",
            source_system="tableau",
        )
        self.add_node(
            "container", "acme-analytics / Enterprise Analytics",
            parent_urn=self.tableau_system,
            description="Production Tableau site and project for executive and operational dashboards",
            layer="consumption", source_system="tableau",
            props={"type": "project", "site": "acme-analytics",
                   "url": "https://acme-analytics.online.tableau.com"},
        )

        for dash_name, dash_spec in DASHBOARDS.items():
            dash_urn = self.add_node(
                "dashboard", dash_name,
                parent_urn=self.tableau_system,
                description=dash_spec["description"],
                layer="consumption", source_system="tableau",
                tags=["consumption", "executive"],
            )
            for chart_name, source_table, source_cols in dash_spec["charts"]:
                chart_urn = self.add_node(
                    "chart", chart_name,
                    parent_urn=dash_urn,
                    description=f"Tableau worksheet: {chart_name}",
                    layer="consumption", source_system="tableau",
                )
                ds_urn = self.dataset_urn.get(f"mart.{source_table}") or self.dataset_urn.get(f"gold.{source_table}")
                if ds_urn:
                    self.add_edge(chart_urn, ds_urn, "CONSUMES", confidence=1.0)
                for src_col in source_cols:
                    col_key = f"mart.{source_table}.{src_col}" if self.column_urn.get(f"mart.{source_table}.{src_col}") else f"gold.{source_table}.{src_col}"
                    src_col_urn = self.column_urn.get(col_key)
                    if src_col_urn:
                        self.add_edge(chart_urn, src_col_urn, "CONSUMES", {"logic": "Tableau Live Connection"}, confidence=1.0)

        # ── Scheduled Reports ───────────────────────────────────────
        report_defs = [
            ("Weekly Revenue Report", "Automated weekly revenue summary emailed to leadership", "rpt_monthly_revenue", "weekly"),
            ("Monthly P&L Report", "Monthly profit & loss statement for Finance", "rpt_executive_kpis", "monthly"),
            ("Quarterly Business Review", "QBR deck data export for board meetings", "rpt_executive_kpis", "quarterly"),
            ("Customer Health Report", "Weekly customer engagement and risk scoring", "rpt_customer_360", "weekly"),
            ("AR Aging Report", "Daily accounts receivable aging for Collections team", "rpt_customer_360", "daily"),
        ]
        for rpt_name, rpt_desc, source_table, schedule in report_defs:
            rpt_urn = self.add_node(
                "report", rpt_name,
                parent_urn=self.domain_urn,
                description=rpt_desc,
                layer="consumption",
                props={"schedule": schedule, "format": "pdf/excel", "distribution": "email"},
            )
            ds_urn = self.dataset_urn.get(f"mart.{source_table}")
            if ds_urn:
                self.add_edge(rpt_urn, ds_urn, "CONSUMES", confidence=1.0)
            # Column-level CONSUMES for end-to-end traceability
            mart_prefix = f"mart.{source_table}."
            for col_key, col_urn in self.column_urn.items():
                if col_key.startswith(mart_prefix):
                    self.add_edge(rpt_urn, col_urn, "CONSUMES", confidence=0.9)
            if "SLA-Critical" in self.tag_urns and schedule in ("daily", "weekly"):
                self.add_edge(rpt_urn, self.tag_urns["SLA-Critical"], "TAGGED_WITH")

        # ── Internal Applications ───────────────────────────────────
        for app_name, app_desc, sources in [
            ("Customer Portal", "Self-service customer dashboard (React + GraphQL)", ["gold.dim_customer", "mart.rpt_customer_360"]),
            ("Sales Console", "Internal sales rep CRM tool", ["gold.fact_pipeline", "gold.dim_customer"]),
            ("Finance Workbench", "Accounting reconciliation and close tool", ["gold.fact_revenue", "mart.rpt_executive_kpis"]),
        ]:
            app_urn = self.add_node(
                "app", app_name,
                parent_urn=self.domain_urn,
                description=app_desc,
                props={"team": app_name.split()[0].lower() + "-eng"},
            )
            for src_key in sources:
                ds_urn = self.dataset_urn.get(src_key)
                if ds_urn:
                    self.add_edge(app_urn, ds_urn, "CONSUMES")
                    # Column-level CONSUMES for end-to-end traceability
                    col_prefix = f"{src_key}."
                    for col_key, col_urn in self.column_urn.items():
                        if col_key.startswith(col_prefix):
                            self.add_edge(app_urn, col_urn, "CONSUMES", confidence=0.8)

    # ── Glossary Wiring ────────────────────────────────────────────

    def build_glossary_wiring(self):
        """Link business-critical columns to their glossary term definitions via DEFINED_BY."""
        logger.info("  Wiring glossary terms (DEFINED_BY)...")

        GLOSSARY_COLUMN_MAP = {
            "Revenue": [
                "gold.fact_orders.net_revenue",
                "mart.rpt_monthly_revenue.total_revenue",
                "mart.rpt_executive_kpis.net_revenue",
                "mart.rpt_executive_kpis.gross_revenue",
            ],
            "Net Revenue": [
                "gold.fact_orders.net_revenue",
                "gold.fact_revenue.order_revenue",
                "mart.rpt_executive_kpis.net_revenue",
            ],
            "COGS": [
                "gold.fact_orders.cogs",
                "mart.rpt_monthly_revenue.total_cogs",
                "mart.rpt_executive_kpis.cogs",
            ],
            "Gross Margin": [
                "mart.rpt_executive_kpis.gross_margin_pct",
                "mart.rpt_monthly_revenue.gross_profit",
            ],
            "AOV": [
                "mart.rpt_monthly_revenue.avg_order_value",
                "mart.rpt_customer_360.avg_order_value",
            ],
            "Customer Lifetime Value": [
                "mart.rpt_customer_360.lifetime_revenue",
            ],
            "Pipeline": [
                "gold.fact_pipeline.amount",
                "mart.rpt_executive_kpis.pipeline_value",
            ],
            "Win Rate": [
                "mart.rpt_executive_kpis.win_rate",
            ],
            "Weighted Pipeline": [
                "gold.fact_pipeline.weighted_amount",
                "mart.rpt_executive_kpis.weighted_pipeline",
            ],
            "AR Aging": [
                "mart.rpt_customer_360.total_ar_outstanding",
                "mart.rpt_executive_kpis.ar_outstanding",
            ],
            "Reconciliation Variance": [
                "gold.fact_revenue.variance",
                "mart.rpt_executive_kpis.recon_variance",
            ],
        }

        wired = 0
        for term_name, col_keys in GLOSSARY_COLUMN_MAP.items():
            term_urn = self.glossary_urns.get(term_name)
            if not term_urn:
                continue
            for col_key in col_keys:
                col_urn = self.column_urn.get(col_key)
                if col_urn:
                    self.add_edge(col_urn, term_urn, "DEFINED_BY")
                    wired += 1
        logger.info(f"    Wired {wired} DEFINED_BY edges")

    # ── Global-scale generator ──────────────────────────────────────

    def _generate_columns(self, table_name: str, num_cols: int, rng: random.Random) -> List[tuple]:
        """Generate realistic column definitions for a procedurally-generated table."""
        cols = []
        # Always start with a PK
        pk_name = f"{table_name.rstrip('s')}_id" if not table_name.endswith("_log") else "log_id"
        cols.append((pk_name, "bigint", False, False, "Primary key"))

        col_pools = list(self.COLUMN_NAMES.items())
        used_names = {pk_name}
        for i in range(1, num_cols):
            category, names = rng.choice(col_pools)
            base = rng.choice(names)
            col_name = base
            attempt = 0
            while col_name in used_names:
                attempt += 1
                col_name = f"{base}_{attempt}"
            used_names.add(col_name)

            is_pii = category == "pii"
            dtype, _ = rng.choice(self.COLUMN_TYPES)
            # Pick type appropriate to category
            if category == "id" or category == "fk":
                dtype = rng.choice(["bigint", "varchar(18)", "varchar(36)"])
            elif category == "amount":
                dtype = rng.choice(["decimal(12,2)", "decimal(15,2)"])
            elif category == "date":
                dtype = rng.choice(["timestamp", "date"])
            elif category == "flag":
                dtype = "boolean"
            elif category == "status":
                dtype = "varchar(50)"

            nullable = rng.random() > 0.6
            cols.append((col_name, dtype, nullable, is_pii, f"{table_name}.{col_name}"))
        return cols

    def _build_subsidiary(self, sub_name: str, sub_code: str, regions: List[str],
                          platforms_per_region: int, tables_per_platform: int,
                          with_lineage: bool, domain_urn: str = None):
        """Build a full subsidiary with regional source systems and optional lineage."""
        sub_urn = domain_urn
        if sub_urn is None:
            sub_urn = self.add_node(
                "domain", sub_name,
                parent_urn=self.domain_urn,
                description=f"Business unit: {sub_name} ({sub_code})",
                props={"subsidiary_code": sub_code},
            )

        rng = random.Random(f"{sub_code}_seed")  # deterministic per subsidiary

        # Create a regional ingestion system under the subsidiary domain
        # (system can contain dataFlow; dataPlatform cannot)
        regional_ingest_system = self.add_node(
            "system", f"Data Ingestion ({sub_code})",
            parent_urn=sub_urn,
            description=f"Ingestion orchestration for {sub_name}",
            source_system="airflow",
        )

        # S3 staging platform for this subsidiary
        staging_platform = self.add_node(
            "dataPlatform", f"S3 Staging ({sub_code})",
            parent_urn=sub_urn,
            description=f"S3 staging landing zone for {sub_name}",
            source_system="aws_s3",
        )

        for region in regions:
            if len(self.nodes) >= self.target_nodes:
                return

            # Pick a subset of platform types for this region
            available_platforms = list(self.SOURCE_PLATFORM_TYPES)
            rng.shuffle(available_platforms)
            selected_platforms = available_platforms[:platforms_per_region]

            for plat_name, plat_source, plat_category in selected_platforms:
                if len(self.nodes) >= self.target_nodes:
                    return

                # dataPlatform directly under subsidiary domain (ontology: domain → dataPlatform)
                platform_urn = self.add_node(
                    "dataPlatform", f"{plat_name} ({sub_code}-{region})",
                    parent_urn=sub_urn,
                    description=f"{plat_name} instance for {sub_name} in {region}",
                    source_system=plat_source,
                )

                server_urn = self.add_node(
                    "container", f"{plat_source}-{sub_code.lower()}-{region}",
                    parent_urn=platform_urn,
                    description=f"{plat_name} server/org ({region})",
                    layer="source", source_system=plat_source,
                    props={"type": "server", "region": region},
                )

                # Get table templates for this platform category
                templates = self.TABLE_TEMPLATES.get(plat_category,
                                                     self.TABLE_TEMPLATES["oltp"])
                rng.shuffle(templates)
                selected_tables = templates[:tables_per_platform]

                # Build ingestion flow if lineage is enabled
                ingest_flow_urn = None
                staging_container_urn = None
                if with_lineage:
                    # dataFlow under system (ontology: system → dataFlow)
                    ingest_flow_urn = self.add_node(
                        "dataFlow",
                        f"Airflow: ingest_{sub_code}_{region}_{plat_source}",
                        parent_urn=regional_ingest_system,
                        description=f"Ingestion pipeline: {plat_name} ({sub_code}/{region})",
                        source_system="airflow",
                        props={"schedule": "daily", "region": region},
                    )
                    # container under dataPlatform (ontology: dataPlatform → container)
                    staging_container_urn = self.add_node(
                        "container",
                        f"staging_{sub_code}_{region}_{plat_source}",
                        parent_urn=staging_platform,
                        description=f"Staging zone for {plat_name} ({region})",
                        layer="staging", source_system="aws_s3",
                        props={"type": "s3_prefix"},
                    )

                for tbl_name, default_cols in selected_tables:
                    if len(self.nodes) >= self.target_nodes:
                        return

                    num_cols = min(default_cols, rng.randint(5, 15))
                    columns = self._generate_columns(tbl_name, num_cols, rng)
                    ns = f"{sub_code}.{region}.{plat_source}"

                    ds_urn = self.add_node(
                        "dataset", tbl_name,
                        parent_urn=server_urn,
                        description=f"{plat_source}.{tbl_name} ({sub_code}/{region})",
                        layer="source", source_system=plat_source,
                        tags=["source", plat_category],
                    )
                    ds_key = f"{ns}.{tbl_name}"
                    self.dataset_urn[ds_key] = ds_urn

                    col_urns = []
                    for col_name, dtype, nullable, is_pii, col_desc in columns:
                        col_urn = self.add_node(
                            "schemaField", col_name,
                            parent_urn=ds_urn,
                            description=col_desc,
                            props={"dataType": dtype, "nullable": nullable},
                            tags=["pii"] if is_pii else [],
                        )
                        self.column_urn[f"{ds_key}.{col_name}"] = col_urn
                        col_urns.append((col_name, col_urn, dtype, nullable, col_desc))
                        if is_pii and "PII" in self.tag_urns:
                            self.add_edge(col_urn, self.tag_urns["PII"], "TAGGED_WITH")

                    # Build lineage chain: source → staging → bronze (with column lineage)
                    if with_lineage and ingest_flow_urn and staging_container_urn:
                        job_urn = self.add_node(
                            "dataJob",
                            f"extract_{ns}_{tbl_name}",
                            parent_urn=ingest_flow_urn,
                            description=f"Extract {tbl_name} from {plat_source}",
                            source_system="airflow",
                        )
                        self.add_edge(job_urn, ds_urn, "CONSUMES", confidence=1.0)

                        stg_ds = self.add_node(
                            "dataset", f"raw_{tbl_name}",
                            parent_urn=staging_container_urn,
                            description=f"Raw staging: {tbl_name}",
                            layer="staging", source_system="airflow",
                            tags=["staging", "raw"],
                        )
                        self.add_edge(job_urn, stg_ds, "PRODUCES", confidence=1.0)

                        for col_name, src_col_urn, dtype, nullable, col_desc in col_urns:
                            stg_col = self.add_node(
                                "schemaField", col_name,
                                parent_urn=stg_ds,
                                description=f"Raw copy: {col_desc}",
                                props={"dataType": dtype, "nullable": nullable},
                            )
                            self.add_edge(src_col_urn, stg_col, "TRANSFORMS",
                                          {"logic": "Parquet COPY"}, confidence=1.0)

    def _build_global_scale(self):
        """Build subsidiaries and regions to reach target node count."""
        remaining = self.target_nodes - len(self.nodes)
        if remaining <= 0:
            return

        # Calculate how many subsidiaries/regions/platforms we need
        # Each table+columns = ~8 nodes avg, each with lineage = ~18 nodes avg
        # A platform with 8 tables = ~64-144 nodes
        # A region with 3 platforms = ~200-430 nodes
        # A subsidiary with 2 regions = ~400-860 nodes

        avg_nodes_per_table_with_lineage = 18
        avg_nodes_per_table_without_lineage = 9
        lineage_fraction = self.lineage_pct / 100.0
        avg_per_table = (avg_nodes_per_table_with_lineage * lineage_fraction +
                         avg_nodes_per_table_without_lineage * (1 - lineage_fraction))

        # Determine how many subsidiaries and how deep to go
        total_tables_needed = int(remaining / max(avg_per_table, 1))

        # Scale up structure dimensions based on target
        if total_tables_needed < 50:
            num_subs = 1
            regions_per_sub = 1
            platforms_per_region = 2
        elif total_tables_needed < 200:
            num_subs = 2
            regions_per_sub = 2
            platforms_per_region = 3
        elif total_tables_needed < 1000:
            num_subs = 3
            regions_per_sub = 2
            platforms_per_region = 4
        elif total_tables_needed < 5000:
            num_subs = 4
            regions_per_sub = 3
            platforms_per_region = 5
        else:
            num_subs = 5
            regions_per_sub = 3
            platforms_per_region = 6

        tables_per_platform = max(4, total_tables_needed // max(
            num_subs * regions_per_sub * platforms_per_region, 1))
        tables_per_platform = min(tables_per_platform, 16)  # cap at template size

        selected_subs = self.SUBSIDIARIES[:num_subs]

        logger.info(f"  Global scale: {num_subs} subsidiaries × {regions_per_sub} regions "
                     f"× {platforms_per_region} platforms × ~{tables_per_platform} tables "
                     f"(lineage: {self.lineage_pct}%)")

        # Create subsidiary domain nodes once, reuse across expansion rounds
        sub_domain_urns: Dict[str, str] = {}
        for sub_name, sub_code, all_regions in selected_subs:
            sub_domain_urns[sub_code] = self.add_node(
                "domain", sub_name,
                parent_urn=self.domain_urn,
                description=f"Business unit: {sub_name} ({sub_code})",
                props={"subsidiary_code": sub_code},
            )

        for sub_name, sub_code, all_regions in selected_subs:
            if len(self.nodes) >= self.target_nodes:
                break
            regions = all_regions[:regions_per_sub]
            with_lineage = random.random() * 100 < self.lineage_pct
            self._build_subsidiary(
                sub_name, sub_code, regions,
                platforms_per_region, tables_per_platform,
                with_lineage,
                domain_urn=sub_domain_urns[sub_code],
            )

        # If still short, add more rounds under existing subsidiary domains
        round_num = 0
        while len(self.nodes) < self.target_nodes:
            round_num += 1
            if round_num > 20:  # safety valve
                break
            for sub_name, sub_code, all_regions in selected_subs:
                if len(self.nodes) >= self.target_nodes:
                    break
                ext_code = f"{sub_code}_R{round_num}"
                with_lineage = random.random() * 100 < self.lineage_pct
                self._build_subsidiary(
                    f"{sub_name} (Expansion {round_num})", ext_code,
                    all_regions[:regions_per_sub],
                    platforms_per_region, tables_per_platform,
                    with_lineage,
                    domain_urn=sub_domain_urns[sub_code],
                )

    # ── Orchestrator ────────────────────────────────────────────────

    def build(self):
        """Build the entire data lake graph."""
        start = time.time()

        # Resolve target node count
        if self.target_nodes <= 0:
            # Legacy scale mode: ~1k per scale unit
            self.target_nodes = self.scale * 1000

        logger.info("=" * 60)
        logger.info(f"Building Enterprise Data Lake graph "
                     f"(target={self.target_nodes:,} nodes, lineage={self.lineage_pct}%)...")
        logger.info("=" * 60)

        self.domain_urn = self.add_node(
            "domain", "Enterprise Data Lake",
            description="Central enterprise data lake spanning e-commerce, CRM, and financial systems",
        )

        # Orchestration / processing systems (must be SYSTEM to contain dataFlow)
        self.airflow_system = self.add_node(
            "system", "Apache Airflow",
            parent_urn=self.domain_urn,
            description="Apache Airflow orchestration — schedules and monitors data pipelines",
            source_system="airflow",
        )
        self.dbt_system = self.add_node(
            "system", "dbt Cloud",
            parent_urn=self.domain_urn,
            description="dbt Cloud — SQL-based data transformation and testing platform",
            source_system="dbt",
        )

        # 0. Governance (tags + glossary)
        self.build_governance()

        # 1. Core source systems (always built — the realistic medallion backbone)
        logger.info("Building core source systems...")
        self.build_source_postgres()
        self.build_source_salesforce()
        self.build_source_sap()

        # 2. Staging (S3 bucket → prefix → tables)
        self.build_staging()

        # 3. Bronze (Databricks → workspace → catalog → schema → tables)
        self.build_bronze()

        # 4. Silver (same catalog, silver schema → tables)
        self.build_silver()

        # 4b. dbt quality tests (after silver, before gold)
        self.build_dbt_tests()

        # 5. Gold (Snowflake → account → database → schema → tables)
        self.build_gold()

        # 6. Reporting + Consumption
        self.build_reporting()

        # 7. Glossary wiring (DEFINED_BY edges from columns to glossary terms)
        self.build_glossary_wiring()

        # 8. Global scale expansion (if target not yet reached)
        if len(self.nodes) < self.target_nodes:
            logger.info(f"Core graph: {len(self.nodes):,} nodes — "
                         f"expanding to {self.target_nodes:,}...")
            self._build_global_scale()

        elapsed = time.time() - start
        logger.info("=" * 60)
        logger.info(
            f"Build complete in {elapsed:.2f}s: "
            f"{len(self.nodes):,} nodes, {len(self.edges):,} edges"
        )
        self._print_stats()

    def _print_stats(self):
        """Print breakdown by entity type and edge type."""
        from collections import Counter

        node_counts = Counter()
        for n in self.nodes:
            node_counts[n.entity_type] += 1

        edge_counts = Counter()
        for e in self.edges:
            edge_counts[e.edge_type] += 1

        logger.info("  Node breakdown:")
        for label, count in sorted(node_counts.items(), key=lambda x: -x[1]):
            logger.info(f"    {label:20s} {count:5d}")

        logger.info("  Edge breakdown:")
        for etype, count in sorted(edge_counts.items(), key=lambda x: -x[1]):
            logger.info(f"    {etype:20s} {count:5d}")

        layer_counts = Counter()
        for n in self.nodes:
            la = n.layer_assignment or "(none)"
            layer_counts[la] += 1
        logger.info("  Layer breakdown:")
        for la, count in sorted(layer_counts.items(), key=lambda x: -x[1]):
            logger.info(f"    {la:20s} {count:5d}")


# ═══════════════════════════════════════════════════════════════════════
# FalkorDB Push (label-grouped bulk Cypher)
# ═══════════════════════════════════════════════════════════════════════

async def push_to_falkordb(builder: DataLakeBuilder, graph_name: str = "data_lake"):
    """Push the built graph to FalkorDB using optimized label-grouped bulk Cypher."""
    from falkordb.asyncio import FalkorDB

    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))

    db = FalkorDB(host=host, port=port)
    graph = db.select_graph(graph_name)

    logger.info(f"Connected to FalkorDB {host}:{port} — graph: {graph_name}")

    CHUNK = 5000

    # ── 1. Group nodes by label ─────────────────────────────────────
    nodes_by_label: Dict[str, List[Dict]] = {}
    for node in builder.nodes:
        label = node.entity_type
        if label not in nodes_by_label:
            nodes_by_label[label] = []
        nodes_by_label[label].append({
            "urn": node.urn,
            "displayName": node.display_name or "",
            "qualifiedName": node.qualified_name or "",
            "description": node.description or "",
            "properties": json.dumps(node.properties),
            "tags": json.dumps(node.tags or []),
            "layerAssignment": node.layer_assignment or "",
            "sourceSystem": node.source_system or "",
            "lastSyncedAt": node.last_synced_at or "",
            "childCount": node.child_count or 0,
        })

    # ── 2. Push nodes ───────────────────────────────────────────────
    for label, nodes in nodes_by_label.items():
        logger.info(f"  Pushing {len(nodes):>5d} {label} nodes...")
        for i in range(0, len(nodes), CHUNK):
            batch = nodes[i:i + CHUNK]
            cypher = f"""
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
            """
            await graph.query(cypher, params={"batch": batch})

    # ── 3. Group edges by (src_label, tgt_label, edge_type) ─────────
    edges_grouped: Dict[Tuple[str, str, str], List[Dict]] = {}
    for edge in builder.edges:
        etype = edge.edge_type
        src_label = builder.urn_to_label.get(edge.source_urn)
        tgt_label = builder.urn_to_label.get(edge.target_urn)
        if not src_label or not tgt_label:
            continue

        key = (src_label, tgt_label, etype)
        if key not in edges_grouped:
            edges_grouped[key] = []
        edges_grouped[key].append({
            "src": edge.source_urn,
            "tgt": edge.target_urn,
            "id": edge.id,
            "confidence": edge.confidence if edge.confidence is not None else 1.0,
            "props": json.dumps(edge.properties),
        })

    # ── 4. Push edges with label-specific MATCH ─────────────────────
    for (slbl, tlbl, etype), edges in edges_grouped.items():
        logger.info(f"  Pushing {len(edges):>5d} ({slbl})-[:{etype}]->({tlbl})...")
        for i in range(0, len(edges), CHUNK):
            batch = edges[i:i + CHUNK]
            cypher = f"""
            UNWIND $batch AS map
            MATCH (a:{slbl} {{urn: map.src}})
            MATCH (b:{tlbl} {{urn: map.tgt}})
            MERGE (a)-[r:{etype}]->(b)
            SET r.id = map.id, r.confidence = map.confidence, r.properties = map.props
            """
            await graph.query(cypher, params={"batch": batch})

    # ── 5. Create indices ───────────────────────────────────────────
    labels_to_index = list(nodes_by_label.keys())
    for label in labels_to_index:
        for prop in ("urn", "displayName", "qualifiedName"):
            try:
                await graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.{prop})")
            except Exception:
                pass  # Index may already exist

    logger.info("FalkorDB push complete!")


async def materialize_aggregated(graph_name: str = "data_lake"):
    """Run the provider's AGGREGATED edge materialization over the pushed graph."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))

    provider = FalkorDBProvider(host=host, port=port, graph_name=graph_name)
    await provider._ensure_connected()

    logger.info("Materializing AGGREGATED edges via provider...")
    result = await provider.materialize_aggregated_edges_batch(batch_size=1000)
    logger.info(f"Materialization result: {result}")


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Enterprise Data Lake seeder for FalkorDB",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python backend/scripts/seed_data_lake.py --dry-run                          # base graph (~1k nodes)
  python backend/scripts/seed_data_lake.py --dry-run --nodes 10000            # 10k nodes
  python backend/scripts/seed_data_lake.py --dry-run --nodes 100000 --lineage-pct 30  # 100k, 30% lineage
  python backend/scripts/seed_data_lake.py --dry-run --scale 5                # legacy: ~5k nodes
  python backend/scripts/seed_data_lake.py --push --graph my_lake             # custom graph name
  python backend/scripts/seed_data_lake.py --push --nodes 50000 --materialize # 50k + aggregate
        """,
    )
    parser.add_argument("--dry-run", action="store_true", help="Generate only, don't push")
    parser.add_argument("--push", action="store_true", help="Push to FalkorDB")
    parser.add_argument("--materialize", action="store_true", help="Materialize AGGREGATED edges after push")
    parser.add_argument("--graph", type=str, default="data_lake", help="FalkorDB graph name (default: data_lake)")
    parser.add_argument("--nodes", type=int, default=0,
                        help="Target node count (e.g. 10000, 100000, 1000000). Overrides --scale.")
    parser.add_argument("--scale", type=int, default=1,
                        help="Legacy size multiplier (~1k nodes per unit). Ignored if --nodes is set.")
    parser.add_argument("--lineage-pct", type=int, default=100,
                        help="Percentage of expanded datasets that get column-level lineage (0-100, default: 100)")
    parser.add_argument("--dump-json", type=str, default=None, help="Dump generated graph to JSON file")
    args = parser.parse_args()

    if not args.push and not args.dry_run and not args.dump_json:
        parser.print_help()
        print("\nSpecify --push or --dry-run")
        sys.exit(1)

    builder = DataLakeBuilder(nodes=args.nodes, lineage_pct=args.lineage_pct, scale=args.scale)
    builder.build()

    if args.dump_json:
        data = {
            "nodes": [n.model_dump(by_alias=True) for n in builder.nodes],
            "edges": [e.model_dump(by_alias=True) for e in builder.edges],
        }
        with open(args.dump_json, "w") as f:
            json.dump(data, f, indent=2, default=str)
        logger.info(f"Dumped graph to {args.dump_json}")

    if args.push:
        try:
            asyncio.run(push_to_falkordb(builder, graph_name=args.graph))
        except KeyboardInterrupt:
            logger.warning("Interrupted.")
            sys.exit(1)
        except Exception as e:
            logger.error(f"Push failed: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)

        if args.materialize:
            try:
                asyncio.run(materialize_aggregated(graph_name=args.graph))
            except Exception as e:
                logger.error(f"Materialization failed: {e}")
                import traceback
                traceback.print_exc()
