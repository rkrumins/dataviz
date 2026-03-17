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

from backend.app.config.features import (
    DEFAULT_EXPERIMENTAL_NOTICE_ENABLED,
    DEFAULT_EXPERIMENTAL_NOTICE_MESSAGE,
    DEFAULT_EXPERIMENTAL_NOTICE_TITLE,
)
from .models import FeatureCategoryORM, FeatureDefinitionORM, FeatureRegistryMetaORM

logger = logging.getLogger(__name__)

# Default per-card "preview" copy — backend-driven so UI can change without frontend deploy.
DEFAULT_PREVIEW_LABEL = "Not yet wired"
DEFAULT_PREVIEW_FOOTER = "Your settings here are saved. Full behaviour for this section will be enabled in a future update."

# Seed data: categories first, then definitions (referencing category ids).
SEED_CATEGORIES: list[dict[str, Any]] = [
    {"id": "editing", "label": "Editing", "icon": "Pencil", "color": "indigo", "sort_order": 0, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "views", "label": "View Modes", "icon": "LayoutTemplate", "color": "violet", "sort_order": 1, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "auth", "label": "Authentication", "icon": "UserPlus", "color": "emerald", "sort_order": 2, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "lineage", "label": "Lineage", "icon": "GitBranch", "color": "amber", "sort_order": 3, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "display", "label": "Display & UI", "icon": "Palette", "color": "blue", "sort_order": 4, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "security", "label": "Security", "icon": "Shield", "color": "rose", "sort_order": 5, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "integrations", "label": "Integrations", "icon": "Plug", "color": "sky", "sort_order": 6, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "analytics", "label": "Analytics", "icon": "BarChart3", "color": "teal", "sort_order": 7, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "experimental", "label": "Experimental", "icon": "FlaskConical", "color": "fuchsia", "sort_order": 8, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "performance", "label": "Performance", "icon": "Zap", "color": "orange", "sort_order": 9, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "notifications", "label": "Notifications", "icon": "Bell", "color": "slate", "sort_order": 10, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
    {"id": "other", "label": "Other", "icon": "LayoutTemplate", "color": "slate", "sort_order": 99, "preview": True, "preview_label": DEFAULT_PREVIEW_LABEL, "preview_footer": DEFAULT_PREVIEW_FOOTER},
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
        "implemented": False,
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
        "implemented": False,
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
        "implemented": False,
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
        "implemented": False,
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


async def seed_feature_registry_meta(session: AsyncSession) -> None:
    """Ensure feature_registry_meta has one row with defaults. Idempotent."""
    r = await session.execute(select(FeatureRegistryMetaORM).limit(1))
    if r.scalar_one_or_none() is not None:
        logger.debug("Feature registry meta already seeded; skipping.")
        return
    session.add(
        FeatureRegistryMetaORM(
            id=1,
            experimental_notice_enabled=DEFAULT_EXPERIMENTAL_NOTICE_ENABLED,
            experimental_notice_title=DEFAULT_EXPERIMENTAL_NOTICE_TITLE,
            experimental_notice_message=DEFAULT_EXPERIMENTAL_NOTICE_MESSAGE,
        )
    )
    logger.info("Seeded feature_registry_meta.")