"""
Seed Quick Start Context Model Templates.

Called once during application startup. Skips if templates already exist.
"""
import logging
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ContextModelORM
from backend.common.models.management import ContextModelCreateRequest
from .repositories import context_model_repo

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# Template Definitions                                                 #
# ------------------------------------------------------------------ #

TEMPLATES = [
    ContextModelCreateRequest(
        name="Data Engineering Flow",
        description="Classic data engineering pipeline: Source → Staging → Transform → Warehouse → Report",
        is_template=True,
        category="data-engineering",
        layers_config=[
            {
                "id": "source",
                "name": "Source",
                "description": "Raw data sources — databases, APIs, files",
                "icon": "Database",
                "color": "#6366f1",
                "entityTypes": ["source", "database", "api", "file"],
                "order": 0,
                "sequence": 0,
                "logicalNodes": [
                    {"id": "databases", "name": "Databases", "icon": "Database"},
                    {"id": "apis", "name": "APIs", "icon": "Globe"},
                    {"id": "files", "name": "Files", "icon": "FileText"},
                ],
                "showUnassigned": True,
            },
            {
                "id": "staging",
                "name": "Staging",
                "description": "Raw data landing zone — minimal transformation",
                "icon": "Inbox",
                "color": "#f59e0b",
                "entityTypes": ["staging", "raw", "landing"],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "transform",
                "name": "Transform",
                "description": "Business logic, joins, aggregations",
                "icon": "Workflow",
                "color": "#10b981",
                "entityTypes": ["transform", "model", "intermediate"],
                "order": 2,
                "sequence": 2,
                "logicalNodes": [
                    {"id": "cleansing", "name": "Cleansing", "icon": "Filter"},
                    {"id": "enrichment", "name": "Enrichment", "icon": "Sparkles"},
                    {"id": "aggregation", "name": "Aggregation", "icon": "Layers"},
                ],
                "showUnassigned": True,
            },
            {
                "id": "warehouse",
                "name": "Warehouse",
                "description": "Curated, business-ready data",
                "icon": "Building2",
                "color": "#3b82f6",
                "entityTypes": ["warehouse", "mart", "curated", "dimension", "fact"],
                "order": 3,
                "sequence": 3,
                "showUnassigned": True,
            },
            {
                "id": "report",
                "name": "Report",
                "description": "Dashboards, reports, and analytics outputs",
                "icon": "BarChart3",
                "color": "#ec4899",
                "entityTypes": ["report", "dashboard", "metric", "kpi"],
                "order": 4,
                "sequence": 4,
                "showUnassigned": True,
            },
        ],
    ),
    ContextModelCreateRequest(
        name="Analytics Pipeline",
        description="Analytics data flow: Raw → Curated → Aggregated → Dashboard",
        is_template=True,
        category="analytics",
        layers_config=[
            {
                "id": "raw",
                "name": "Raw",
                "description": "Unprocessed data from source systems",
                "icon": "HardDrive",
                "color": "#8b5cf6",
                "entityTypes": ["raw", "source", "extract"],
                "order": 0,
                "sequence": 0,
                "showUnassigned": True,
            },
            {
                "id": "curated",
                "name": "Curated",
                "description": "Cleaned, validated, and standardized data",
                "icon": "CheckCircle",
                "color": "#06b6d4",
                "entityTypes": ["curated", "clean", "validated"],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "aggregated",
                "name": "Aggregated",
                "description": "Pre-computed metrics and summaries",
                "icon": "Sigma",
                "color": "#f97316",
                "entityTypes": ["aggregated", "summary", "metric"],
                "order": 2,
                "sequence": 2,
                "showUnassigned": True,
            },
            {
                "id": "dashboard",
                "name": "Dashboard",
                "description": "Visualization and reporting layer",
                "icon": "LayoutDashboard",
                "color": "#ef4444",
                "entityTypes": ["dashboard", "report", "visualization"],
                "order": 3,
                "sequence": 3,
                "showUnassigned": True,
            },
        ],
    ),
    ContextModelCreateRequest(
        name="Data Mesh",
        description="Domain-oriented data product architecture",
        is_template=True,
        category="data-mesh",
        layers_config=[
            {
                "id": "domain",
                "name": "Domain",
                "description": "Business domain boundaries and ownership",
                "icon": "Boxes",
                "color": "#7c3aed",
                "entityTypes": ["domain", "bounded-context"],
                "order": 0,
                "sequence": 0,
                "logicalNodes": [
                    {"id": "sales", "name": "Sales", "icon": "ShoppingCart"},
                    {"id": "finance", "name": "Finance", "icon": "DollarSign"},
                    {"id": "operations", "name": "Operations", "icon": "Settings"},
                ],
                "showUnassigned": True,
            },
            {
                "id": "data-product",
                "name": "Data Product",
                "description": "Self-serve, discoverable data products",
                "icon": "Package",
                "color": "#2563eb",
                "entityTypes": ["data-product", "dataset", "table"],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "consumer",
                "name": "Consumer",
                "description": "Data consumers — teams, applications, dashboards",
                "icon": "Users",
                "color": "#059669",
                "entityTypes": ["consumer", "application", "team"],
                "order": 2,
                "sequence": 2,
                "showUnassigned": True,
            },
        ],
    ),
    ContextModelCreateRequest(
        name="ETL Classic",
        description="Traditional Extract → Transform → Load pattern",
        is_template=True,
        category="data-engineering",
        layers_config=[
            {
                "id": "extract",
                "name": "Extract",
                "description": "Data extraction from source systems",
                "icon": "Download",
                "color": "#6366f1",
                "entityTypes": ["extract", "source", "connector"],
                "order": 0,
                "sequence": 0,
                "showUnassigned": True,
            },
            {
                "id": "transform",
                "name": "Transform",
                "description": "Data cleansing, mapping, and business rules",
                "icon": "Workflow",
                "color": "#f59e0b",
                "entityTypes": ["transform", "mapping", "rule"],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "load",
                "name": "Load",
                "description": "Target systems and destinations",
                "icon": "Upload",
                "color": "#10b981",
                "entityTypes": ["load", "target", "destination", "warehouse"],
                "order": 2,
                "sequence": 2,
                "showUnassigned": True,
            },
        ],
    ),
]


# ------------------------------------------------------------------ #
# Seeder                                                               #
# ------------------------------------------------------------------ #

async def seed_templates(session: AsyncSession) -> None:
    """Insert Quick Start Templates if none exist yet."""
    result = await session.execute(
        select(func.count()).where(ContextModelORM.is_template == True)
    )
    count = result.scalar() or 0

    if count > 0:
        logger.debug("Skipping template seeding — %d templates already exist", count)
        return

    logger.info("Seeding %d Quick Start Context Model templates...", len(TEMPLATES))
    for tmpl in TEMPLATES:
        await context_model_repo.create_context_model(session, tmpl)

    logger.info("Quick Start templates seeded successfully")
