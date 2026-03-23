"""
Seed feature_categories, feature_definitions, feature_flags, and feature_registry_meta.

Runs at startup; uses per-row savepoints so multi-worker gunicorn on PostgreSQL
doesn't cause IntegrityError cascades that roll back unrelated seed data.

Single source of truth: SEED_DEFINITIONS drives both the schema and the default
flag values (via _build_seed_flags_config). No separate hand-maintained dict.
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
from .models import FeatureCategoryORM, FeatureDefinitionORM, FeatureFlagsORM, FeatureRegistryMetaORM

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
    {"id": "semantic_layers", "label": "Semantic Layers", "icon": "Layers", "color": "indigo", "sort_order": 11, "preview": False, "preview_label": None, "preview_footer": None},
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
    {
        "key": "semanticLayerNonAdminEditing",
        "name": "Non-admin editing",
        "description": "Allow non-admin users to create, edit, and publish semantic layers. When disabled, only admins can manage semantic layer definitions.",
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(False),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": "Enable this to let team members define their own semantic layers without admin intervention. They can still only edit draft layers they created.",
        "sort_order": 0,
        "deprecated": False,
        "implemented": False,
    },
    {
        "key": "semanticLayerExportEnabled",
        "name": "Export",
        "description": "Allow users to export semantic layer definitions as JSON files for backup, migration, or sharing between environments.",
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": None,
        "sort_order": 1,
        "deprecated": False,
        "implemented": False,
    },
    {
        "key": "semanticLayerAutoSuggest",
        "name": "Auto-suggest from graph",
        "description": "Enable the 'Suggest from Graph' feature that automatically generates semantic layer definitions by analyzing the entity and relationship types in the connected data source.",
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": None,
        "sort_order": 2,
        "deprecated": False,
        "implemented": False,
    },
    {
        "key": "semanticLayerVersionHistory",
        "name": "Version history & audit trail",
        "description": "Show the full version history and audit trail for each semantic layer, including who made changes, when, and what was modified.",
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": None,
        "sort_order": 3,
        "deprecated": False,
        "implemented": False,
    },
    {
        "key": "semanticLayerEditMode",
        "name": "Edit mode",
        "description": "Allow users to enter edit mode on semantic layer definitions to modify entity types, relationships, hierarchy, and other structural settings.",
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": "When disabled, semantic layers are read-only for all users. Admins can still publish, clone, and export.",
        "sort_order": 4,
        "deprecated": False,
        "implemented": False,
    },
    {
        "key": "semanticLayerImportEnabled",
        "name": "Import",
        "description": "Allow users to import semantic layer definitions from exported JSON files. Supports creating new layers or updating existing ones with change detection and version management.",
        "category_id": "semantic_layers",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": "Disable if you want to restrict semantic layer changes to the UI editor only, preventing bulk imports.",
        "sort_order": 5,
        "deprecated": False,
        "implemented": False,
    },
    {
        "key": "announcementsEnabled",
        "name": "Announcements",
        "description": "Show global announcement banners to all users. When disabled, banners are hidden even if active announcements exist.",
        "category_id": "notifications",
        "type": "boolean",
        "default_value": json.dumps(True),
        "user_overridable": False,
        "options": None,
        "help_url": None,
        "admin_hint": "Toggle off to instantly hide all announcement banners without deactivating individual announcements.",
        "sort_order": 0,
        "deprecated": False,
        "implemented": True,
    },
]


# ---------------------------------------------------------------------------
# Derived defaults — single source of truth from SEED_DEFINITIONS
# ---------------------------------------------------------------------------

def _build_seed_flags_config() -> dict[str, Any]:
    """Derive default flag values from SEED_DEFINITIONS — no separate hand-maintained dict."""
    return {d["key"]: json.loads(d["default_value"]) for d in SEED_DEFINITIONS}


SEED_FLAGS_CONFIG: dict[str, Any] = _build_seed_flags_config()


# ---------------------------------------------------------------------------
# Seed functions — all use begin_nested() savepoints for multi-worker safety
# ---------------------------------------------------------------------------

async def seed_feature_registry(session: AsyncSession) -> None:
    """Insert default categories and definitions, skipping any that already exist.

    Uses per-row savepoints so a concurrent worker inserting the same row
    causes only that savepoint to roll back — not the entire transaction.
    This is critical for multi-worker gunicorn on PostgreSQL.
    """
    existing_cats = await session.execute(select(FeatureCategoryORM.id))
    existing_cat_ids = {row[0] for row in existing_cats}
    cats_added = 0
    for c in SEED_CATEGORIES:
        if c["id"] in existing_cat_ids:
            continue
        try:
            async with session.begin_nested():
                session.add(FeatureCategoryORM(**c))
            cats_added += 1
        except Exception:
            pass  # Another worker inserted this row — safe to skip

    existing_defs = await session.execute(select(FeatureDefinitionORM.key))
    existing_def_keys = {row[0] for row in existing_defs}
    defs_added = 0
    for d in SEED_DEFINITIONS:
        if d["key"] in existing_def_keys:
            continue
        try:
            async with session.begin_nested():
                session.add(FeatureDefinitionORM(**d))
            defs_added += 1
        except Exception:
            pass  # Another worker inserted this row — safe to skip

    if cats_added or defs_added:
        logger.info("Seeded feature registry: %d categories, %d definitions added.", cats_added, defs_added)
    else:
        logger.debug("Feature registry already fully seeded; skipping.")


async def seed_feature_flags(session: AsyncSession) -> None:
    """Ensure feature_flags has a single config row with defaults. Idempotent.

    Uses a savepoint so a concurrent worker race doesn't poison the session.
    Starts at version=1 so the first admin PATCH expects version=1 (not 0).
    """
    r = await session.execute(select(FeatureFlagsORM).limit(1))
    if r.scalar_one_or_none() is not None:
        logger.debug("Feature flags already seeded; skipping.")
        return
    try:
        async with session.begin_nested():
            session.add(
                FeatureFlagsORM(
                    id=1,
                    config=json.dumps(SEED_FLAGS_CONFIG),
                    version=1,
                )
            )
        logger.info("Seeded feature_flags with default config.")
    except Exception:
        logger.debug("Feature flags already seeded by another worker; skipping.")


async def seed_feature_registry_meta(session: AsyncSession) -> None:
    """Ensure feature_registry_meta has one row with defaults. Idempotent.

    Uses a savepoint so a concurrent worker race doesn't poison the session.
    """
    r = await session.execute(select(FeatureRegistryMetaORM).limit(1))
    if r.scalar_one_or_none() is not None:
        logger.debug("Feature registry meta already seeded; skipping.")
        return
    try:
        async with session.begin_nested():
            session.add(
                FeatureRegistryMetaORM(
                    id=1,
                    experimental_notice_enabled=DEFAULT_EXPERIMENTAL_NOTICE_ENABLED,
                    experimental_notice_title=DEFAULT_EXPERIMENTAL_NOTICE_TITLE,
                    experimental_notice_message=DEFAULT_EXPERIMENTAL_NOTICE_MESSAGE,
                )
            )
        logger.info("Seeded feature_registry_meta.")
    except Exception:
        logger.debug("Feature registry meta already seeded by another worker; skipping.")
