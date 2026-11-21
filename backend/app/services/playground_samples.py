"""The Playground's samples: a meaningful graph, with a view on it, in one click.

A business user opening the Playground faces a blank canvas, and a blank canvas asks them to
know already what a graph is for. A sample answers that: a small, realistic graph — a retail
data pipeline, a customer 360, an ML feature pipeline — that they can explore, then change.

Each sample is everything the platform needs to make one, defined here and nowhere else:

* its **data model** — the entity and relationship types it uses. It is an ordinary published
  data model with a stable id (``bp_sample_<id>``), made the first time anyone starts the sample
  (:func:`ensure_ontology`) and shared by every graph made from it afterwards. Not marked
  ``is_system``: the platform finds *the* system default data model as the ``is_system`` one with
  the highest version (``ontology_definition_repo.get_system_default_ontology``), so a second one
  would be mistaken for it. A data source on it keeps it from being deleted, like any data model
  in use;
* its **things and connections** — the rows of a day-0 import (:func:`rows`), loaded into a new
  blank graph as its first version, the way ``POST …/bulk-ingest`` loads one;
* its **view** — a ready-made one, configured as the View wizard configures one (:func:`view_config`).

Owners are teams and platforms are products: no sample names a person.

What the Playground allows a sample is what it allows a blank graph: on the sandbox provider,
within the person's quota (``playground_policy``). The route that makes one is
``POST /playground/samples/{sample_id}`` (``endpoints/playground.py``).
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OntologyORM
from backend.app.ontology.resolver import (
    derive_flat_lists, parse_entity_definitions, parse_relationship_definitions,
)


@dataclass(frozen=True)
class EntityType:
    name: str
    plural: str
    description: str
    icon: str
    color: str


@dataclass(frozen=True)
class RelationshipType:
    name: str
    description: str
    color: str


#: A thing: (key, entity type, name, description, owner, platform, tags).
Node = Tuple[str, str, str, str, str, str, Tuple[str, ...]]
#: A connection: (from key, relationship type, to key).
Edge = Tuple[str, str, str]


@dataclass(frozen=True)
class Sample:
    id: str
    title: str
    description: str
    #: A lucide icon name and a colour name, for the gallery card (the icon is its view's too).
    icon: str
    color: str
    view_type: str
    view_name: str
    entity_types: Dict[str, EntityType]
    relationship_types: Dict[str, RelationshipType]
    nodes: Tuple[Node, ...]
    edges: Tuple[Edge, ...]

    @property
    def ontology_id(self) -> str:
        return "bp_sample_" + self.id.replace("-", "_")

    def urn(self, key: str) -> str:
        return f"urn:sample:{self.id}:{key}"


# ── Retail data pipeline ──────────────────────────────────────────────────

_RETAIL = Sample(
    id="retail-pipeline",
    title="Retail data pipeline",
    description="Sales from the store, tills and payments, through the warehouse to the dashboards.",
    icon="ShoppingCart", color="amber", view_type="graph",
    view_name="Retail pipeline: from store to dashboard",
    entity_types={
        "sourceSystem": EntityType("Source system", "Source systems",
                                   "Where the business's data starts: the online store, the tills, payments.",
                                   "Store", "#f59e0b"),
        "ingestionJob": EntityType("Ingestion job", "Ingestion jobs",
                                   "A scheduled sync that copies a source system's data into the warehouse.",
                                   "CloudDownload", "#0ea5e9"),
        "warehouseTable": EntityType("Warehouse table", "Warehouse tables",
                                     "Data as it landed in the warehouse, before anyone cleaned it.",
                                     "Table", "#6366f1"),
        "transformation": EntityType("Transformation", "Transformations",
                                     "A model that cleans, joins or sums tables into something the business can use.",
                                     "Workflow", "#8b5cf6"),
        "dashboard": EntityType("Dashboard", "Dashboards",
                                "What people read to run the business.",
                                "LayoutDashboard", "#10b981"),
    },
    relationship_types={
        "FEEDS": RelationshipType("Feeds", "A source system's data is picked up by a sync.", "#f59e0b"),
        "LOADS": RelationshipType("Loads into", "A sync writes what it picked up into a table.", "#0ea5e9"),
        "TRANSFORMS_INTO": RelationshipType("Transforms into", "Data is reshaped into the next model.", "#8b5cf6"),
        "POWERS": RelationshipType("Powers", "A model is what a dashboard shows.", "#10b981"),
    },
    nodes=(
        ("shopify", "sourceSystem", "Shopify store", "Online orders, customers and the product catalogue.", "E-commerce", "Shopify", ()),
        ("square", "sourceSystem", "Square POS", "Sales rung up on the tills in every store.", "Store operations", "Square", ()),
        ("stripe", "sourceSystem", "Stripe payments", "Card payments and refunds.", "Finance", "Stripe", ()),
        ("ga4", "sourceSystem", "Google Analytics 4", "Visits, page views and conversions on the website.", "Marketing", "Google Analytics", ()),
        ("netsuite", "sourceSystem", "NetSuite ERP", "Stock levels, items and their costs.", "Finance", "NetSuite", ()),
        ("klaviyo", "sourceSystem", "Klaviyo", "Email campaigns and who opened them.", "Marketing", "Klaviyo", ()),
        ("sync_shopify", "ingestionJob", "Shopify sync", "Copies orders and customers every 15 minutes.", "Data platform", "Fivetran", ()),
        ("sync_square", "ingestionJob", "Square sync", "Copies till transactions every hour.", "Data platform", "Fivetran", ()),
        ("sync_stripe", "ingestionJob", "Stripe sync", "Copies charges and refunds every hour.", "Data platform", "Fivetran", ()),
        ("sync_ga4", "ingestionJob", "GA4 export", "Exports yesterday's web events each night.", "Data platform", "Airbyte", ()),
        ("sync_netsuite", "ingestionJob", "NetSuite sync", "Copies inventory and items every 6 hours.", "Data platform", "Fivetran", ()),
        ("sync_klaviyo", "ingestionJob", "Klaviyo sync", "Copies campaigns and email events each night.", "Data platform", "Airbyte", ()),
        ("raw_orders", "warehouseTable", "raw.shopify_orders", "One row per online order, as Shopify sent it.", "Data platform", "Snowflake", ()),
        ("raw_order_lines", "warehouseTable", "raw.shopify_order_lines", "One row per item on an online order.", "Data platform", "Snowflake", ()),
        ("raw_customers", "warehouseTable", "raw.shopify_customers", "Online customers and their contact details.", "Data platform", "Snowflake", ("pii",)),
        ("raw_transactions", "warehouseTable", "raw.square_transactions", "Every sale rung up in a store.", "Data platform", "Snowflake", ()),
        ("raw_locations", "warehouseTable", "raw.square_locations", "The stores, with their regions and opening hours.", "Data platform", "Snowflake", ()),
        ("raw_charges", "warehouseTable", "raw.stripe_charges", "Every card payment taken.", "Data platform", "Snowflake", ()),
        ("raw_refunds", "warehouseTable", "raw.stripe_refunds", "Every refund given.", "Data platform", "Snowflake", ()),
        ("raw_events", "warehouseTable", "raw.ga4_events", "Website events: visits, views, add-to-baskets.", "Data platform", "Snowflake", ()),
        ("raw_inventory", "warehouseTable", "raw.netsuite_inventory", "Stock on hand, per item and warehouse.", "Data platform", "Snowflake", ()),
        ("raw_items", "warehouseTable", "raw.netsuite_items", "Items with their cost and supplier.", "Data platform", "Snowflake", ()),
        ("raw_campaigns", "warehouseTable", "raw.klaviyo_campaigns", "Email campaigns and when they went out.", "Data platform", "Snowflake", ()),
        ("raw_email_events", "warehouseTable", "raw.klaviyo_events", "Opens, clicks and unsubscribes.", "Data platform", "Snowflake", ("pii",)),
        ("stg_orders", "transformation", "stg_orders", "Online and in-store orders in one shape.", "Analytics engineering", "dbt", ()),
        ("stg_order_lines", "transformation", "stg_order_lines", "Order items, with prices and discounts cleaned.", "Analytics engineering", "dbt", ()),
        ("stg_customers", "transformation", "stg_customers", "Customers, de-duplicated by email.", "Analytics engineering", "dbt", ("pii",)),
        ("stg_payments", "transformation", "stg_payments", "Payments net of refunds.", "Analytics engineering", "dbt", ()),
        ("stg_web_sessions", "transformation", "stg_web_sessions", "Web events grouped into visits.", "Analytics engineering", "dbt", ()),
        ("stg_inventory", "transformation", "stg_inventory", "Stock levels, one row per item per day.", "Analytics engineering", "dbt", ()),
        ("stg_products", "transformation", "stg_products", "The product catalogue, with costs.", "Analytics engineering", "dbt", ()),
        ("stg_stores", "transformation", "stg_stores", "Stores and their regions.", "Analytics engineering", "dbt", ()),
        ("stg_email", "transformation", "stg_email_engagement", "Who received, opened and clicked each campaign.", "Analytics engineering", "dbt", ()),
        ("fct_orders", "transformation", "fct_orders", "Every order, paid and placed in a store or online.", "Analytics engineering", "dbt", ("certified",)),
        ("fct_order_items", "transformation", "fct_order_items", "Every item sold, with its margin.", "Analytics engineering", "dbt", ("certified",)),
        ("dim_customers", "transformation", "dim_customers", "One row per customer, with their first and last order.", "Analytics engineering", "dbt", ("certified", "pii")),
        ("dim_products", "transformation", "dim_products", "One row per product, with stock and cost.", "Analytics engineering", "dbt", ("certified",)),
        ("fct_inventory", "transformation", "fct_inventory_daily", "Stock, sell-through and days of cover per day.", "Analytics engineering", "dbt", ()),
        ("fct_attribution", "transformation", "fct_marketing_attribution", "Which visit or email led to each order.", "Analytics engineering", "dbt", ()),
        ("customer_ltv", "transformation", "customer_lifetime_value", "What each customer has spent, and is likely to.", "Analytics engineering", "dbt", ()),
        ("dash_exec", "dashboard", "Executive sales overview", "Revenue, orders and margin, today against last year.", "Leadership", "Looker", ()),
        ("dash_stores", "dashboard", "Store performance", "Sales per store and region.", "Store operations", "Looker", ()),
        ("dash_inventory", "dashboard", "Inventory health", "What's running low, and what isn't selling.", "Merchandising", "Looker", ()),
        ("dash_marketing", "dashboard", "Marketing ROI", "What each channel and campaign brought in.", "Marketing", "Looker", ()),
        ("dash_cohorts", "dashboard", "Customer cohorts", "How customers who joined each month go on spending.", "Marketing", "Looker", ()),
        ("dash_products", "dashboard", "Product performance", "Best and worst sellers, by margin.", "Merchandising", "Looker", ()),
    ),
    edges=(
        ("shopify", "FEEDS", "sync_shopify"), ("square", "FEEDS", "sync_square"),
        ("stripe", "FEEDS", "sync_stripe"), ("ga4", "FEEDS", "sync_ga4"),
        ("netsuite", "FEEDS", "sync_netsuite"), ("klaviyo", "FEEDS", "sync_klaviyo"),
        ("sync_shopify", "LOADS", "raw_orders"), ("sync_shopify", "LOADS", "raw_order_lines"),
        ("sync_shopify", "LOADS", "raw_customers"), ("sync_square", "LOADS", "raw_transactions"),
        ("sync_square", "LOADS", "raw_locations"), ("sync_stripe", "LOADS", "raw_charges"),
        ("sync_stripe", "LOADS", "raw_refunds"), ("sync_ga4", "LOADS", "raw_events"),
        ("sync_netsuite", "LOADS", "raw_inventory"), ("sync_netsuite", "LOADS", "raw_items"),
        ("sync_klaviyo", "LOADS", "raw_campaigns"), ("sync_klaviyo", "LOADS", "raw_email_events"),
        ("raw_orders", "TRANSFORMS_INTO", "stg_orders"), ("raw_transactions", "TRANSFORMS_INTO", "stg_orders"),
        ("raw_order_lines", "TRANSFORMS_INTO", "stg_order_lines"), ("raw_customers", "TRANSFORMS_INTO", "stg_customers"),
        ("raw_charges", "TRANSFORMS_INTO", "stg_payments"), ("raw_refunds", "TRANSFORMS_INTO", "stg_payments"),
        ("raw_events", "TRANSFORMS_INTO", "stg_web_sessions"), ("raw_inventory", "TRANSFORMS_INTO", "stg_inventory"),
        ("raw_items", "TRANSFORMS_INTO", "stg_products"), ("raw_locations", "TRANSFORMS_INTO", "stg_stores"),
        ("raw_campaigns", "TRANSFORMS_INTO", "stg_email"), ("raw_email_events", "TRANSFORMS_INTO", "stg_email"),
        ("stg_orders", "TRANSFORMS_INTO", "fct_orders"), ("stg_payments", "TRANSFORMS_INTO", "fct_orders"),
        ("stg_stores", "TRANSFORMS_INTO", "fct_orders"), ("stg_order_lines", "TRANSFORMS_INTO", "fct_order_items"),
        ("stg_products", "TRANSFORMS_INTO", "fct_order_items"), ("stg_customers", "TRANSFORMS_INTO", "dim_customers"),
        ("stg_orders", "TRANSFORMS_INTO", "dim_customers"), ("stg_products", "TRANSFORMS_INTO", "dim_products"),
        ("stg_inventory", "TRANSFORMS_INTO", "dim_products"), ("stg_inventory", "TRANSFORMS_INTO", "fct_inventory"),
        ("stg_products", "TRANSFORMS_INTO", "fct_inventory"), ("stg_web_sessions", "TRANSFORMS_INTO", "fct_attribution"),
        ("stg_email", "TRANSFORMS_INTO", "fct_attribution"), ("stg_orders", "TRANSFORMS_INTO", "fct_attribution"),
        ("dim_customers", "TRANSFORMS_INTO", "customer_ltv"), ("fct_orders", "TRANSFORMS_INTO", "customer_ltv"),
        ("fct_orders", "POWERS", "dash_exec"), ("fct_order_items", "POWERS", "dash_exec"),
        ("customer_ltv", "POWERS", "dash_exec"), ("fct_orders", "POWERS", "dash_stores"),
        ("fct_inventory", "POWERS", "dash_inventory"), ("dim_products", "POWERS", "dash_inventory"),
        ("fct_attribution", "POWERS", "dash_marketing"), ("dim_customers", "POWERS", "dash_marketing"),
        ("dim_customers", "POWERS", "dash_cohorts"), ("customer_ltv", "POWERS", "dash_cohorts"),
        ("fct_order_items", "POWERS", "dash_products"), ("dim_products", "POWERS", "dash_products"),
    ),
)


# ── Customer 360 ──────────────────────────────────────────────────────────

_CUSTOMER_360 = Sample(
    id="customer-360",
    title="Customer 360",
    description="CRM, support and billing records matched into one view of each customer.",
    icon="Users", color="sky", view_type="graph",
    view_name="Customer 360: every system behind one customer",
    entity_types={
        "businessSystem": EntityType("Business system", "Business systems",
                                     "A system teams work in every day: the CRM, the help desk, billing.",
                                     "Building2", "#0ea5e9"),
        "sourceRecord": EntityType("Source record", "Source records",
                                   "A kind of record a system keeps: an account, a ticket, an invoice.",
                                   "FileText", "#64748b"),
        "unifiedEntity": EntityType("Unified entity", "Unified entities",
                                    "One thing — a customer, a subscription — matched across every system that knows it.",
                                    "Fingerprint", "#8b5cf6"),
        "customerProfile": EntityType("Profile", "Profiles",
                                      "Everything known about a customer or an account, in one place.",
                                      "CircleUser", "#ec4899"),
        "report": EntityType("Report", "Reports",
                             "What sales, support and finance read to act on it.",
                             "ChartColumn", "#10b981"),
    },
    relationship_types={
        "SYNCS": RelationshipType("Syncs", "A system's records are brought in.", "#0ea5e9"),
        "MATCHES_INTO": RelationshipType("Matches into", "Records from different systems are matched as one.", "#8b5cf6"),
        "BUILDS": RelationshipType("Builds", "A unified entity adds to a profile.", "#ec4899"),
        "INFORMS": RelationshipType("Informs", "A report is drawn from it.", "#10b981"),
    },
    nodes=(
        ("salesforce", "businessSystem", "Salesforce CRM", "Accounts, contacts and the sales pipeline.", "Sales operations", "Salesforce", ()),
        ("hubspot", "businessSystem", "HubSpot Marketing", "Leads, forms and email engagement.", "Marketing", "HubSpot", ()),
        ("zendesk", "businessSystem", "Zendesk Support", "Support tickets and satisfaction ratings.", "Customer support", "Zendesk", ()),
        ("intercom", "businessSystem", "Intercom Chat", "Live chat conversations.", "Customer support", "Intercom", ()),
        ("stripe", "businessSystem", "Stripe Billing", "Customers, subscriptions and invoices.", "Finance", "Stripe", ()),
        ("netsuite", "businessSystem", "NetSuite Finance", "The ledger: what each customer owes and paid.", "Finance", "NetSuite", ()),
        ("segment", "businessSystem", "Product analytics", "What customers do in the product.", "Product", "Segment", ()),
        ("sf_account", "sourceRecord", "Salesforce Account", "A company we sell to.", "Sales operations", "Salesforce", ()),
        ("sf_contact", "sourceRecord", "Salesforce Contact", "A person at an account.", "Sales operations", "Salesforce", ("pii",)),
        ("sf_opportunity", "sourceRecord", "Salesforce Opportunity", "A deal in the pipeline.", "Sales operations", "Salesforce", ()),
        ("sf_case", "sourceRecord", "Salesforce Case", "An issue raised through an account manager.", "Sales operations", "Salesforce", ()),
        ("hs_contact", "sourceRecord", "HubSpot Contact", "A lead or subscriber.", "Marketing", "HubSpot", ("pii",)),
        ("hs_email", "sourceRecord", "HubSpot Email engagement", "Opens and clicks on marketing email.", "Marketing", "HubSpot", ()),
        ("hs_form", "sourceRecord", "HubSpot Form submission", "A demo request or newsletter sign-up.", "Marketing", "HubSpot", ("pii",)),
        ("zd_ticket", "sourceRecord", "Zendesk Ticket", "A support request.", "Customer support", "Zendesk", ()),
        ("zd_rating", "sourceRecord", "Zendesk Satisfaction rating", "How the customer rated the help they got.", "Customer support", "Zendesk", ()),
        ("ic_conversation", "sourceRecord", "Intercom Conversation", "A chat with the support team.", "Customer support", "Intercom", ()),
        ("st_customer", "sourceRecord", "Stripe Customer", "Who is billed.", "Finance", "Stripe", ("pii",)),
        ("st_subscription", "sourceRecord", "Stripe Subscription", "The plan a customer is on.", "Finance", "Stripe", ()),
        ("st_invoice", "sourceRecord", "Stripe Invoice", "What was billed, and whether it was paid.", "Finance", "Stripe", ()),
        ("ns_ledger", "sourceRecord", "NetSuite Customer ledger", "Balances and payment history.", "Finance", "NetSuite", ()),
        ("sg_event", "sourceRecord", "Product event", "A click, a feature used, a session.", "Product", "Segment", ()),
        ("customer", "unifiedEntity", "Customer", "A person, matched across CRM, marketing and billing.", "Data team", "Warehouse", ("pii", "certified")),
        ("account", "unifiedEntity", "Account", "A company, matched across CRM and finance.", "Data team", "Warehouse", ("certified",)),
        ("subscription", "unifiedEntity", "Subscription", "What a customer pays for, and since when.", "Data team", "Warehouse", ("certified",)),
        ("support_case", "unifiedEntity", "Support case", "Every request for help, whichever channel it came in on.", "Data team", "Warehouse", ()),
        ("engagement", "unifiedEntity", "Marketing engagement", "Every email, form and campaign a customer touched.", "Data team", "Warehouse", ()),
        ("usage", "unifiedEntity", "Product usage", "How much, and how, a customer uses the product.", "Data team", "Warehouse", ()),
        ("profile_customer", "customerProfile", "Customer 360 profile", "One page per person: who they are, what they pay, how they're doing.", "Data team", "Warehouse", ("pii", "certified")),
        ("profile_account", "customerProfile", "Account 360 profile", "One page per company: revenue, health, open issues.", "Data team", "Warehouse", ("certified",)),
        ("rpt_churn", "report", "Churn risk", "Which customers are likely to leave, and why.", "Customer success", "Tableau", ()),
        ("rpt_health", "report", "Customer health score", "A score per customer from usage, support and billing.", "Customer success", "Tableau", ()),
        ("rpt_revenue", "report", "Revenue by segment", "Recurring revenue by plan, region and size.", "Finance", "Tableau", ()),
        ("rpt_sla", "report", "Support SLA & satisfaction", "Response times and ratings, per channel.", "Customer support", "Tableau", ()),
        ("rpt_upsell", "report", "Upsell opportunities", "Accounts outgrowing their plan.", "Sales operations", "Tableau", ()),
        ("rpt_nps", "report", "NPS trends", "How likely customers are to recommend us, over time.", "Customer success", "Tableau", ()),
    ),
    edges=(
        ("salesforce", "SYNCS", "sf_account"), ("salesforce", "SYNCS", "sf_contact"),
        ("salesforce", "SYNCS", "sf_opportunity"), ("salesforce", "SYNCS", "sf_case"),
        ("hubspot", "SYNCS", "hs_contact"), ("hubspot", "SYNCS", "hs_email"), ("hubspot", "SYNCS", "hs_form"),
        ("zendesk", "SYNCS", "zd_ticket"), ("zendesk", "SYNCS", "zd_rating"),
        ("intercom", "SYNCS", "ic_conversation"), ("stripe", "SYNCS", "st_customer"),
        ("stripe", "SYNCS", "st_subscription"), ("stripe", "SYNCS", "st_invoice"),
        ("netsuite", "SYNCS", "ns_ledger"), ("segment", "SYNCS", "sg_event"),
        ("sf_account", "MATCHES_INTO", "account"), ("sf_contact", "MATCHES_INTO", "customer"),
        ("sf_opportunity", "MATCHES_INTO", "account"), ("sf_case", "MATCHES_INTO", "support_case"),
        ("hs_contact", "MATCHES_INTO", "customer"), ("hs_email", "MATCHES_INTO", "engagement"),
        ("hs_form", "MATCHES_INTO", "engagement"), ("zd_ticket", "MATCHES_INTO", "support_case"),
        ("zd_rating", "MATCHES_INTO", "support_case"), ("ic_conversation", "MATCHES_INTO", "support_case"),
        ("st_customer", "MATCHES_INTO", "customer"), ("st_customer", "MATCHES_INTO", "account"),
        ("st_subscription", "MATCHES_INTO", "subscription"), ("st_invoice", "MATCHES_INTO", "subscription"),
        ("ns_ledger", "MATCHES_INTO", "account"), ("sg_event", "MATCHES_INTO", "usage"),
        ("customer", "BUILDS", "profile_customer"), ("engagement", "BUILDS", "profile_customer"),
        ("support_case", "BUILDS", "profile_customer"), ("usage", "BUILDS", "profile_customer"),
        ("subscription", "BUILDS", "profile_customer"), ("account", "BUILDS", "profile_account"),
        ("subscription", "BUILDS", "profile_account"), ("support_case", "BUILDS", "profile_account"),
        ("usage", "BUILDS", "profile_account"),
        ("profile_customer", "INFORMS", "rpt_churn"), ("profile_account", "INFORMS", "rpt_churn"),
        ("profile_customer", "INFORMS", "rpt_health"), ("profile_account", "INFORMS", "rpt_revenue"),
        ("subscription", "INFORMS", "rpt_revenue"), ("support_case", "INFORMS", "rpt_sla"),
        ("profile_account", "INFORMS", "rpt_upsell"), ("usage", "INFORMS", "rpt_upsell"),
        ("profile_customer", "INFORMS", "rpt_nps"), ("support_case", "INFORMS", "rpt_nps"),
    ),
)


# ── ML feature pipeline ───────────────────────────────────────────────────

_ML_FEATURES = Sample(
    id="ml-features",
    title="ML feature pipeline",
    description="Raw events becoming features, the models they train, and where predictions go.",
    icon="BrainCircuit", color="emerald", view_type="graph",
    view_name="ML features: from raw events to predictions",
    entity_types={
        "dataSource": EntityType("Data source", "Data sources",
                                 "Where raw data comes from: an event stream, a database.",
                                 "Database", "#0ea5e9"),
        "dataset": EntityType("Dataset", "Datasets",
                              "A table prepared for analysis or training.",
                              "Table", "#6366f1"),
        "featureSet": EntityType("Feature set", "Feature sets",
                                 "Signals computed for models to learn from, kept in the feature store.",
                                 "Layers", "#f59e0b"),
        "mlModel": EntityType("Model", "Models",
                              "A trained model that makes predictions.",
                              "BrainCircuit", "#ec4899"),
        "application": EntityType("Application", "Applications",
                                  "A service that acts on a model's predictions.",
                                  "Rocket", "#10b981"),
    },
    relationship_types={
        "FEEDS": RelationshipType("Feeds", "Raw data lands in a dataset.", "#0ea5e9"),
        "DERIVES": RelationshipType("Derives", "A dataset or feature set is computed from it.", "#6366f1"),
        "TRAINS": RelationshipType("Trains", "A model learns from it.", "#f59e0b"),
        "DEPLOYED_TO": RelationshipType("Deployed to", "A model's predictions are used here.", "#ec4899"),
    },
    nodes=(
        ("clickstream", "dataSource", "Clickstream", "Every page view and click, as it happens.", "Data platform", "Kafka", ()),
        ("orders_db", "dataSource", "Orders database", "Orders and the product catalogue.", "Engineering", "PostgreSQL", ()),
        ("payments", "dataSource", "Payments", "Card payments and chargebacks.", "Finance", "Stripe", ()),
        ("support", "dataSource", "Customer support", "Tickets and chat transcripts.", "Customer support", "Zendesk", ()),
        ("raw_events", "dataset", "Raw click events", "Clickstream events, one row each.", "Data platform", "Databricks", ()),
        ("sessions", "dataset", "Sessionized events", "Events grouped into visits.", "Data platform", "Databricks", ()),
        ("orders", "dataset", "Orders", "Every order with its items.", "Data platform", "Databricks", ()),
        ("catalogue", "dataset", "Product catalogue", "Products with their categories and prices.", "Data platform", "Databricks", ()),
        ("payment_events", "dataset", "Payment events", "Payments, refunds and chargebacks.", "Data platform", "Databricks", ()),
        ("tickets", "dataset", "Support tickets", "Tickets with their text and outcome.", "Data platform", "Databricks", ("pii",)),
        ("customer_daily", "dataset", "Customer daily snapshot", "One row per customer per day.", "Data science", "Databricks", ()),
        ("churn_training", "dataset", "Churn training set", "Customers labelled with whether they left.", "Data science", "Databricks", ()),
        ("fs_browsing", "featureSet", "Browsing behaviour", "Visits, dwell time, categories viewed.", "Data science", "Feature store", ()),
        ("fs_purchases", "featureSet", "Purchase history", "Order frequency, basket size, recency.", "Data science", "Feature store", ()),
        ("fs_payment_risk", "featureSet", "Payment risk signals", "Card velocity, mismatched addresses, past chargebacks.", "Risk", "Feature store", ()),
        ("fs_sentiment", "featureSet", "Support sentiment", "How the customer's last tickets read.", "Data science", "Feature store", ()),
        ("fs_profile", "featureSet", "Customer profile features", "Tenure, plan, region.", "Data science", "Feature store", ()),
        ("fs_embeddings", "featureSet", "Product embeddings", "Which products are bought or viewed together.", "Data science", "Feature store", ()),
        ("model_churn", "mlModel", "Churn prediction", "How likely each customer is to leave this month.", "Data science", "MLflow", ()),
        ("model_recs", "mlModel", "Product recommendations", "What each visitor is likely to want next.", "Data science", "MLflow", ()),
        ("model_fraud", "mlModel", "Fraud detection", "Whether a payment is likely fraudulent.", "Risk", "MLflow", ()),
        ("model_ltv", "mlModel", "Lifetime value forecast", "What each customer will spend over a year.", "Data science", "MLflow", ()),
        ("app_retention", "application", "Retention campaigns", "Sends offers to customers at risk of leaving.", "Marketing", "Braze", ()),
        ("app_recs_api", "application", "Website recommendations", "The 'you may also like' row on the website.", "Engineering", "API", ()),
        ("app_checkout", "application", "Checkout fraud check", "Holds risky payments for review.", "Risk", "API", ()),
        ("app_forecast", "application", "Finance forecasting", "Revenue forecasts for planning.", "Finance", "Tableau", ()),
    ),
    edges=(
        ("clickstream", "FEEDS", "raw_events"), ("orders_db", "FEEDS", "orders"),
        ("orders_db", "FEEDS", "catalogue"), ("payments", "FEEDS", "payment_events"),
        ("support", "FEEDS", "tickets"),
        ("raw_events", "DERIVES", "sessions"), ("orders", "DERIVES", "customer_daily"),
        ("payment_events", "DERIVES", "customer_daily"), ("tickets", "DERIVES", "customer_daily"),
        ("customer_daily", "DERIVES", "churn_training"), ("sessions", "DERIVES", "fs_browsing"),
        ("orders", "DERIVES", "fs_purchases"), ("payment_events", "DERIVES", "fs_payment_risk"),
        ("tickets", "DERIVES", "fs_sentiment"), ("customer_daily", "DERIVES", "fs_profile"),
        ("catalogue", "DERIVES", "fs_embeddings"), ("sessions", "DERIVES", "fs_embeddings"),
        ("churn_training", "TRAINS", "model_churn"), ("fs_browsing", "TRAINS", "model_churn"),
        ("fs_purchases", "TRAINS", "model_churn"), ("fs_sentiment", "TRAINS", "model_churn"),
        ("fs_profile", "TRAINS", "model_churn"), ("fs_browsing", "TRAINS", "model_recs"),
        ("fs_purchases", "TRAINS", "model_recs"), ("fs_embeddings", "TRAINS", "model_recs"),
        ("fs_payment_risk", "TRAINS", "model_fraud"), ("fs_browsing", "TRAINS", "model_fraud"),
        ("fs_purchases", "TRAINS", "model_ltv"), ("fs_profile", "TRAINS", "model_ltv"),
        ("model_churn", "DEPLOYED_TO", "app_retention"), ("model_recs", "DEPLOYED_TO", "app_recs_api"),
        ("model_fraud", "DEPLOYED_TO", "app_checkout"), ("model_ltv", "DEPLOYED_TO", "app_forecast"),
    ),
)


SAMPLES: Tuple[Sample, ...] = (_RETAIL, _CUSTOMER_360, _ML_FEATURES)
_BY_ID = {s.id: s for s in SAMPLES}


def get(sample_id: str) -> Optional[Sample]:
    return _BY_ID.get(sample_id)


# ── What a sample is made of ──────────────────────────────────────────────

def rows(sample: Sample) -> List[dict]:
    """Its things and connections as a day-0 import's rows (``bulk_ingest``): nodes named by urn,
    edges by the urns at their ends."""
    return [
        {"kind": "node", "urn": sample.urn(key), "entityType": etype, "displayName": name,
         "description": description, "properties": {"owner": owner, "platform": platform},
         "tags": list(tags)}
        for key, etype, name, description, owner, platform, tags in sample.nodes
    ] + [
        {"kind": "edge", "edgeType": rtype, "source": sample.urn(source), "target": sample.urn(target)}
        for source, rtype, target in sample.edges
    ]


_FIELDS = [
    {"id": "name", "name": "Name", "type": "string", "show_in_tooltip": True, "display_order": 1},
    {"id": "description", "name": "Description", "type": "markdown", "show_in_node": False, "display_order": 2},
    {"id": "owner", "name": "Owner", "type": "string", "show_in_node": False, "display_order": 3},
    {"id": "platform", "name": "Platform", "type": "string", "show_in_node": False, "display_order": 4},
]


async def ensure_ontology(session: AsyncSession, sample: Sample) -> str:
    """The sample's data model, published, made the first time anyone starts the sample and the
    same one every time after. Returns its id. Whatever is at its id is used as it is: an
    administrator who withdrew it (unpublished, deleted) is answered as a blank graph on it would
    be. Every type is a traceable root (a sample's graph is lineage, not containment), and each
    relationship joins the types the sample joins with it.

    Commits — and, when someone else made it a moment ago, rolls back: the caller reads nothing
    from ORM rows it loaded before."""
    if await session.get(OntologyORM, sample.ontology_id) is not None:
        return sample.ontology_id
    type_of = {key: etype for key, etype, *_ in sample.nodes}
    entities = parse_entity_definitions({
        tid: {"name": t.name, "plural_name": t.plural, "description": t.description,
              "visual": {"icon": t.icon, "color": t.color}, "fields": _FIELDS}
        for tid, t in sample.entity_types.items()
    })
    relationships = parse_relationship_definitions({
        rid: {"name": r.name, "description": r.description, "category": "flow", "is_lineage": True,
              "visual": {"stroke_color": r.color},
              "source_types": sorted({type_of[s] for s, kind, _ in sample.edges if kind == rid}),
              "target_types": sorted({type_of[t] for _, kind, t in sample.edges if kind == rid})}
        for rid, r in sample.relationship_types.items()
    })
    flat = derive_flat_lists(entities, relationships)
    session.add(OntologyORM(
        id=sample.ontology_id, schema_id=sample.ontology_id, version=1,
        name=f"{sample.title} (sample)",
        description=f"The data model of the Playground's “{sample.title}” sample.",
        entity_type_definitions=json.dumps({k: asdict(v) for k, v in entities.items()}),
        relationship_type_definitions=json.dumps({k: asdict(v) for k, v in relationships.items()}),
        containment_edge_types=json.dumps(flat.containment_edge_types),
        lineage_edge_types=json.dumps(flat.lineage_edge_types),
        edge_type_metadata=json.dumps(flat.edge_type_metadata),
        entity_type_hierarchy=json.dumps(flat.entity_type_hierarchy),
        root_entity_types=json.dumps(flat.root_entity_types),
        is_published=True, published_at=datetime.now(timezone.utc).isoformat(),
        scope="universal",
    ))
    try:
        await session.commit()
    except IntegrityError:
        # Someone else started it first, a moment ago: theirs is the one.
        await session.rollback()
    return sample.ontology_id


def view_config(sample: Sample) -> dict:
    """The ready-made view's config, as the View wizard writes one for its layout
    (``buildViewConfig`` in ``frontend/src/services/viewService.ts``)."""
    return {
        "icon": sample.icon,
        "content": {"visibleEntityTypes": list(sample.entity_types),
                    "visibleRelationshipTypes": list(sample.relationship_types),
                    "defaultDepth": 5, "maxDepth": 10},
        "layout": {"type": sample.view_type,
                   "graphLayout": {"algorithm": "dagre", "direction": "LR",
                                   "nodeSpacing": 60, "levelSpacing": 120},
                   "lod": {"enabled": False, "levels": []}},
        "filters": {"entityTypeFilters": [], "fieldFilters": [], "searchableFields": [],
                    "quickFilters": []},
        "entityOverrides": {},
    }
