"""
Seed feature_categories and feature_definitions from a single source of truth.
Runs once at startup; only inserts when tables are empty (idempotent).
No hardcoded registry in config — this is the one-time seed; after that, data lives in DB.
"""
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import FeatureCategoryORM, FeatureDefinitionORM

logger = logging.getLogger(__name__)

# Seed data: categories first, then definitions (referencing category ids).
SEED_CATEGORIES: list[dict[str, Any]] = [
    {"id": "editing", "label": "Editing", "icon": "Pencil", "color": "indigo", "sort_order": 0},
    {"id": "views", "label": "View Modes", "icon": "LayoutTemplate", "color": "violet", "sort_order": 1},
    {"id": "auth", "label": "Authentication", "icon": "UserPlus", "color": "emerald", "sort_order": 2},
    {"id": "lineage", "label": "Lineage", "icon": "GitBranch", "color": "amber", "sort_order": 3},
    {"id": "display", "label": "Display & UI", "icon": "Palette", "color": "blue", "sort_order": 4},
    {"id": "security", "label": "Security", "icon": "Shield", "color": "rose", "sort_order": 5},
    {"id": "integrations", "label": "Integrations", "icon": "Plug", "color": "sky", "sort_order": 6},
    {"id": "analytics", "label": "Analytics", "icon": "BarChart3", "color": "teal", "sort_order": 7},
    {"id": "experimental", "label": "Experimental", "icon": "FlaskConical", "color": "fuchsia", "sort_order": 8},
    {"id": "performance", "label": "Performance", "icon": "Zap", "color": "orange", "sort_order": 9},
    {"id": "notifications", "label": "Notifications", "icon": "Bell", "color": "slate", "sort_order": 10},
    {"id": "other", "label": "Other", "icon": "LayoutTemplate", "color": "slate", "sort_order": 99},
]

SEED_DEFINITIONS: list[dict[str, Any]] = [
    {
        "key": "editModeEnabled",
        "name": "Edit mode",
        "description": "Allow users to edit node properties from views and persist changes to the underlying data.",
        "category_id": "editing",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": True,
        "options": None,
        "help_url": None,
        "admin_hint": None,
        "sort_order": 0,
        "deprecated": False,
    },
    {
        "key": "allowedViewModes",
        "name": "View modes",
        "description": "Choose which layout types can be created when building views (Graph, Hierarchy, Reference Model, Layered Lineage).",
        "category_id": "views",
        "type": "string[]",
        "default_value": json.dumps(["graph", "hierarchy", "reference", "layered-lineage"]),
        "user_overridable": False,
        "options": json.dumps([
            {"id": "graph", "label": "Graph"},
            {"id": "hierarchy", "label": "Hierarchy"},
            {"id": "reference", "label": "Reference Model"},
            {"id": "layered-lineage", "label": "Layered Lineage"},
        ]),
        "help_url": None,
        "admin_hint": None,
        "sort_order": 1,
        "deprecated": False,
    },
    {
        "key": "signupEnabled",
        "name": "Signup",
        "description": "Allow new users to create an account from the login page (self-registration).",
        "category_id": "auth",
        "type": "boolean",
        "default_value": json.dumps(False),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": None,
        "sort_order": 2,
        "deprecated": False,
    },
    {
        "key": "traceEnabled",
        "name": "Trace",
        "description": "Enable lineage trace in graph and context views (trace upstream/downstream from a node).",
        "category_id": "lineage",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": True,
        "options": None,
        "help_url": None,
        "admin_hint": None,
        "sort_order": 3,
        "deprecated": False,
    },
]


async def seed_feature_registry(session: AsyncSession) -> None:
    """Insert default categories and definitions if tables are empty. Idempotent."""
    r = await session.execute(select(FeatureCategoryORM).limit(1))
    if r.scalar_one_or_none() is not None:
        logger.debug("Feature categories already seeded; skipping.")
        return

    for c in SEED_CATEGORIES:
        session.add(FeatureCategoryORM(**c))
    for d in SEED_DEFINITIONS:
        session.add(FeatureDefinitionORM(**d))
    logger.info("Seeded feature_categories and feature_definitions.")