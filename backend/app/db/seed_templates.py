"""
Seed the built-in layout templates.

Built-ins are the product's own starting points: context_models rows with a
``system_key``. They are upserted by that key on every start, so an upgrade
refreshes their content; an administrator can hide one for everyone
(``is_active = False``), and that choice — like a soft delete — survives the
refresh. Built-ins are read-only in the app: people duplicate one to change it.

This used to insert four templates only when NO template rows existed, so
deleting every template brought them all back on the next boot and a change
here never reached an existing database.
"""
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ContextModelORM
from .repositories import layout_template_repo

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# Template Definitions                                                 #
# ------------------------------------------------------------------ #
# Entity types are suggestions written for SOME ontology: applying a template
# keeps only the types the target data source's ontology declares.

BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {
        "system_key": "data-engineering-flow",
        "name": "Data Engineering Flow",
        "description": "Classic data engineering pipeline: Source → Staging → Transform → Warehouse → Report",
        "category": "data-engineering",
        "layers": [
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
                    {"id": "databases", "name": "Databases", "type": "group", "icon": "Database"},
                    {"id": "apis", "name": "APIs", "type": "group", "icon": "Globe"},
                    {"id": "files", "name": "Files", "type": "group", "icon": "FileText"},
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
                    {"id": "cleansing", "name": "Cleansing", "type": "group", "icon": "Filter"},
                    {"id": "enrichment", "name": "Enrichment", "type": "group", "icon": "Sparkles"},
                    {"id": "aggregation", "name": "Aggregation", "type": "group", "icon": "Layers"},
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
    },
    {
        "system_key": "analytics-pipeline",
        "name": "Analytics Pipeline",
        "description": "Analytics data flow: Raw → Curated → Aggregated → Dashboard",
        "category": "analytics",
        "layers": [
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
    },
    {
        "system_key": "data-mesh",
        "name": "Data Mesh",
        "description": "Domain-oriented data product architecture",
        "category": "data-mesh",
        "layers": [
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
                    {"id": "sales", "name": "Sales", "type": "group", "icon": "ShoppingCart"},
                    {"id": "finance", "name": "Finance", "type": "group", "icon": "DollarSign"},
                    {"id": "operations", "name": "Operations", "type": "group", "icon": "Settings"},
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
    },
    {
        "system_key": "etl-classic",
        "name": "ETL Classic",
        "description": "Traditional Extract → Transform → Load pattern",
        "category": "data-engineering",
        "layers": [
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
    },
    {
        "system_key": "medallion",
        "name": "Medallion",
        "category": "data-engineering",
        "description": "The lakehouse refinement pattern: raw data lands in Bronze and is progressively refined to business-ready Gold.",
        "layers": [
            {
                "id": "medallion-0",
                "name": "Bronze",
                "description": "Raw data as it arrives",
                "icon": "Inbox",
                "color": "#CD7F32",
                "entityTypes": [],
                "order": 0,
                "sequence": 0,
                "showUnassigned": True,
            },
            {
                "id": "medallion-1",
                "name": "Silver",
                "description": "Cleansed and conformed",
                "icon": "Filter",
                "color": "#94a3b8",
                "entityTypes": [],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "medallion-2",
                "name": "Gold",
                "description": "Business-ready data products",
                "icon": "Award",
                "color": "#eab308",
                "entityTypes": [],
                "order": 2,
                "sequence": 2,
                "showUnassigned": True,
            },
        ],
    },
    {
        "system_key": "source-to-target",
        "name": "Source to target",
        "category": "data-engineering",
        "description": "Trace where data comes from, how it changes, and where it ends up.",
        "layers": [
            {
                "id": "source-to-target-0",
                "name": "Sources",
                "description": "Where the data originates",
                "icon": "Database",
                "color": "#8b5cf6",
                "entityTypes": [],
                "order": 0,
                "sequence": 0,
                "showUnassigned": True,
            },
            {
                "id": "source-to-target-1",
                "name": "Transformations",
                "description": "How the data is shaped along the way",
                "icon": "Workflow",
                "color": "#f59e0b",
                "entityTypes": [],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "source-to-target-2",
                "name": "Targets",
                "description": "Where the data lands",
                "icon": "Target",
                "color": "#22c55e",
                "entityTypes": [],
                "order": 2,
                "sequence": 2,
                "showUnassigned": True,
            },
        ],
    },
    {
        "system_key": "data-flow",
        "name": "Data flow",
        "category": "analytics",
        "description": "Map which systems produce data, the pipelines that move it, and who consumes it.",
        "layers": [
            {
                "id": "data-flow-0",
                "name": "Producers",
                "description": "Systems that create data",
                "icon": "Server",
                "color": "#06b6d4",
                "entityTypes": [],
                "order": 0,
                "sequence": 0,
                "showUnassigned": True,
            },
            {
                "id": "data-flow-1",
                "name": "Pipelines",
                "description": "Jobs that move and process it",
                "icon": "Workflow",
                "color": "#6366f1",
                "entityTypes": [],
                "order": 1,
                "sequence": 1,
                "showUnassigned": True,
            },
            {
                "id": "data-flow-2",
                "name": "Consumers",
                "description": "Reports, apps and teams using it",
                "icon": "Users",
                "color": "#ec4899",
                "entityTypes": [],
                "order": 2,
                "sequence": 2,
                "showUnassigned": True,
            },
        ],
    },
]


# ------------------------------------------------------------------ #
# Seeder                                                               #
# ------------------------------------------------------------------ #

async def seed_templates(session: AsyncSession) -> None:
    """Insert missing built-ins and refresh the content of existing ones.

    Never touches ``is_active`` (an administrator hid it) or ``deleted_at``.
    New layers are a new version, so views built from a built-in are offered
    the change like any other template's. Each insert and each new version gets
    its own savepoint: two workers starting together race on the unique
    ``system_key`` (or version), and the loser finds the work already done.
    """
    existing = {
        row.system_key: row
        for row in (await session.execute(
            select(ContextModelORM).where(ContextModelORM.system_key.isnot(None))
        )).scalars()
    }
    inserted = refreshed = 0
    for tmpl in BUILTIN_TEMPLATES:
        layers = json.dumps(tmpl["layers"])
        row = existing.get(tmpl["system_key"])
        if row is None:
            try:
                async with session.begin_nested():
                    row = ContextModelORM(
                        system_key=tmpl["system_key"],
                        name=tmpl["name"],
                        description=tmpl["description"],
                        category=tmpl["category"],
                        layers_config=layers,
                        is_template=True,
                        visibility="enterprise",
                    )
                    session.add(row)
                    await session.flush()
                    await layout_template_repo.add_version(session, row, created_by=None)
                inserted += 1
            except IntegrityError:
                logger.debug("Built-in template %s was seeded concurrently", tmpl["system_key"])
            continue
        stale = (row.name, row.description, row.category, row.layers_config) != (
            tmpl["name"], tmpl["description"], tmpl["category"], layers,
        )
        row.name = tmpl["name"]
        row.description = tmpl["description"]
        row.category = tmpl["category"]
        if row.layers_config != layers:
            try:
                async with session.begin_nested():
                    row.layers_config = layers
                    row.version += 1
                    await layout_template_repo.add_version(
                        session, row, created_by=None, change_note="Updated with this release.",
                    )
            except IntegrityError:
                logger.debug("Built-in template %s was refreshed concurrently", tmpl["system_key"])
        refreshed += 1 if stale else 0
    if inserted or refreshed:
        logger.info("Built-in layout templates: %d added, %d refreshed", inserted, refreshed)
