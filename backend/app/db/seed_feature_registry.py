"""
Seed feature_categories, feature_definitions, feature_flags, and feature_registry_meta.

Runs at startup; uses per-row savepoints so multi-worker gunicorn on PostgreSQL
doesn't cause IntegrityError cascades that roll back unrelated seed data.

The CONTENT lives in ``app/config/features_seed.py`` (prose: names, descriptions, hints,
impact copy) and the FACTS live in ``app/config/feature_wiring.py`` (where each flag is
actually enforced). This module is only the machinery that gets them into the database.

INSERT IS NOT ENOUGH — THE OLD BUG
----------------------------------
This seeder used to skip any definition whose key already existed. That is right for VALUES
(an admin's settings are theirs, and a redeploy must not reset them) and quietly wrong for
CONTENT: it meant no correction to a description — and no correction to ``implemented`` — could
ever reach a database that had been seeded once. The registry's copy was frozen at whatever the
first deploy wrote, which is much of why it drifted so far from the truth.

The rule is now explicit, per column:

  * ``implemented``  — CODE-OWNED. Always overwritten from ``FEATURE_WIRING``. It is a fact
    about the source tree, and the database's opinion of it is not interesting.
  * structure        — CODE-OWNED (type, options, category). An admin editing these could only
    break the contract between the registry and the gates.
  * prose            — CODE-OWNED too. It ships with the code and the database serves it; see
    the note on _CODE_OWNED. Nothing in the product can edit it, so freezing it at the first
    deploy would only guarantee it goes stale.
  * ``feature_flags.config`` — ADMIN-OWNED. Untouched after the first seed. These are settings.
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
from backend.app.config.feature_wiring import FEATURE_WIRING
from backend.app.config.features_seed import (  # re-exported — scripts import these from here
    DEFAULT_PREVIEW_FOOTER,
    DEFAULT_PREVIEW_LABEL,
    SEED_CATEGORIES,
    SEED_DEFINITIONS,
)
from .models import FeatureCategoryORM, FeatureDefinitionORM, FeatureFlagsORM, FeatureRegistryMetaORM

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_PREVIEW_FOOTER",
    "DEFAULT_PREVIEW_LABEL",
    "SEED_CATEGORIES",
    "SEED_DEFINITIONS",
    "SEED_FLAGS_CONFIG",
    "seed_feature_flags",
    "seed_feature_registry",
    "seed_feature_registry_meta",
]

#: Everything the code owns — reconciled on every startup.
#:
#: THE PROSE IS IN HERE, AND THAT IS A DECISION. The first cut treated names/descriptions as
#: admin-owned and only backfilled them when blank, so an admin's rewording could never be
#: clobbered by a deploy. It turns out nothing can reword them: `PATCH /features/definitions/{key}`
#: exists, but no UI calls it and nothing in the product ever has. So the rule was protecting a
#: capability nobody has, at the price of freezing the copy at whatever the FIRST deploy wrote —
#: which is the same write-once trap that let `implemented` stay wrong for months.
#:
#: The copy ships with the code, and the database serves it. If the definition-CRUD API ever grows
#: a UI, this needs provenance (a `content_edited_at`, set on PATCH and respected here) — until
#: then, tracking provenance for an editor that does not exist is machinery for its own sake.
_CODE_OWNED = (
    "name", "description", "admin_hint", "impact_when_off", "help_url",
    "category_id", "type", "options", "user_overridable", "sort_order",
)


def _row_values(definition: dict[str, Any]) -> dict[str, Any]:
    """The full column set for one definition — seed prose plus the code-derived truth."""
    wiring = FEATURE_WIRING.get(definition["key"])
    return {
        **definition,
        # DERIVED, never declared. This is the column that used to lie: it was hand-set here and
        # tickable by an admin in the UI — a claim about the source tree owned by people who
        # cannot change the source tree.
        "implemented": bool(wiring.wired) if wiring else False,
    }


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
    """Insert default categories and definitions; reconcile the ones already there.

    Uses per-row savepoints so a concurrent worker inserting the same row causes only that
    savepoint to roll back — not the entire transaction. Critical for multi-worker gunicorn
    on PostgreSQL.
    """
    existing_cats = await session.execute(select(FeatureCategoryORM))
    cats_by_id = {c.id: c for c in existing_cats.scalars()}
    cats_added = 0
    for c in SEED_CATEGORIES:
        row = cats_by_id.get(c["id"])
        if row is None:
            try:
                async with session.begin_nested():
                    session.add(FeatureCategoryORM(**c))
                cats_added += 1
            except Exception:
                pass  # Another worker inserted this row — safe to skip
            continue
        # A category's "preview" chrome ("Not yet wired") is a claim about the code, so the code
        # keeps it current: once its flags are wired the badge must go — on databases seeded long
        # ago as much as on fresh ones.
        row.preview = c["preview"]
        row.preview_label = c["preview_label"]
        row.preview_footer = c["preview_footer"]
        row.sort_order = c["sort_order"]

    existing_defs = await session.execute(select(FeatureDefinitionORM))
    defs_by_key = {d.key: d for d in existing_defs.scalars()}
    cats_synced = sum(1 for c in SEED_CATEGORIES if c["id"] in cats_by_id)
    defs_added = 0
    defs_synced = 0
    for d in SEED_DEFINITIONS:
        values = _row_values(d)
        row = defs_by_key.get(d["key"])
        if row is None:
            try:
                async with session.begin_nested():
                    session.add(FeatureDefinitionORM(**values))
                defs_added += 1
            except Exception:
                pass  # Another worker inserted this row — safe to skip
            continue

        changed = False

        if bool(row.implemented) != values["implemented"]:
            row.implemented = values["implemented"]
            changed = True
        for column in _CODE_OWNED:
            if getattr(row, column, None) != values.get(column):
                setattr(row, column, values.get(column))
                changed = True

        if changed:
            defs_synced += 1

    if cats_added or defs_added or defs_synced:
        logger.info(
            "Feature registry: +%d categories, +%d definitions, %d definitions reconciled "
            "(%d categories present).",
            cats_added, defs_added, defs_synced, cats_synced,
        )
    else:
        logger.debug("Feature registry already current; nothing to seed.")


async def seed_feature_flags(session: AsyncSession) -> None:
    """Ensure feature_flags has a single config row with defaults. Idempotent.

    Uses a savepoint so a concurrent worker race doesn't poison the session.
    Starts at version=1 so the first admin PATCH expects version=1 (not 0).

    Deliberately does NOT reconcile an existing row: these are the admin's SETTINGS, and a
    redeploy that reset them to defaults would silently undo their decisions. A flag added after
    the first seed simply has no stored value, and every read falls back to the definition's
    default until an admin saves.
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
