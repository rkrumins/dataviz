"""Fold context-model instance layer state into view configs (canonical shape).

One-time, idempotent data migration (Task 6 of the view-config consolidation).
After Tasks 1-5 the view config is the single source of truth; this makes the
EXISTING data conform:

* Every view whose config has a referenceLayout (nested ``layout.referenceLayout``
  or legacy top-level ``referenceLayout``) gets the canonical
  ``{layers, assignments}`` shape with an explicit ``content.entityScope``:
  legacy per-layer ``entityAssignments`` are stripped and up-converted to the
  top-level ``assignments`` map; exact-urn ``rules`` are converted to
  assignments and removed (glob rules kept). Views with no referenceLayout are
  left untouched.
* Where a view points at an INSTANCE context-model (``is_template = false``),
  that model's ``layers_config`` / ``instance_assignments`` are merged in and
  WIN on conflict (cm held the canvas's latest edits — user decision), then the
  view's ``context_model_id`` is set NULL.
* All instance context_models rows are deleted (templates kept). Templates with
  non-empty ``instance_assignments`` are reset to ``{}`` (templates are
  assignment-free blueprints — user decision).

The pure merge logic lives in
``backend.app.db.migrations_support.view_layout_merge`` (unit-tested in
backend/tests/test_view_layout_merge.py). Importing that pure helper from a
revision follows the established pattern (``20260704_1400_import_export``
imports ``backend.app.services.versioning``). This revision itself uses only
plain SQLAlchemy Core over ``op.get_bind()``.

Idempotent: re-running is a no-op — no instance rows remain, and the normalize/
strip/merge steps are no-ops on already-canonical configs (each row is only
UPDATEd when its config actually changes). ``downgrade`` is a documented no-op:
the fold-in is a one-way, user-approved breaking change (deleted instance rows
and stripped legacy fields are not reconstructable).

Postgres-only (alembic env is Postgres-only; ``config`` columns are TEXT JSON,
read/written as text via json.loads/json.dumps — dialect-neutral).
"""
from __future__ import annotations

import json
import logging
from typing import Union

from alembic import op
import sqlalchemy as sa

from backend.app.db.migrations_support.view_layout_merge import merge_view_layout

revision: str = "20260707_1200_view_layout_merge"
down_revision: Union[str, None] = "20260706_1200_top_level_cache"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")


def _loads(text: Union[str, None], default):
    if not text:
        return default
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return default


def upgrade() -> None:
    bind = op.get_bind()

    view_rows = bind.execute(
        sa.text("SELECT id, config, context_model_id FROM views")
    ).fetchall()

    # Preload the context-models referenced by views (instance rows carry the
    # layer state to fold in; templates are left as normalize-only).
    cm_ids = {r.context_model_id for r in view_rows if r.context_model_id}
    cm_by_id: dict = {}
    if cm_ids:
        cm_rows = bind.execute(
            sa.text(
                "SELECT id, is_template, layers_config, instance_assignments "
                "FROM context_models WHERE id = ANY(:ids)"
            ),
            {"ids": list(cm_ids)},
        ).fetchall()
        cm_by_id = {r.id: r for r in cm_rows}

    configs_updated = 0
    pointers_nulled = 0

    for row in view_rows:
        config = _loads(row.config, {})
        cm = cm_by_id.get(row.context_model_id)
        is_instance = cm is not None and not cm.is_template

        if is_instance:
            cm_layers = _loads(cm.layers_config, [])
            cm_assignments = _loads(cm.instance_assignments, {})
        else:
            cm_layers = None
            cm_assignments = None

        new_config = merge_view_layout(config, cm_layers, cm_assignments)

        if new_config != config:
            bind.execute(
                sa.text("UPDATE views SET config = :config WHERE id = :id"),
                {"config": json.dumps(new_config), "id": row.id},
            )
            configs_updated += 1

        # Sever the pointer to any instance context-model (it is about to be
        # deleted; the view config now owns the layer state).
        if is_instance:
            bind.execute(
                sa.text("UPDATE views SET context_model_id = NULL WHERE id = :id"),
                {"id": row.id},
            )
            pointers_nulled += 1

    # Delete all instance context_models (incl. orphan autosave rows nothing
    # reads after Tasks 2/5). Templates are kept.
    deleted = bind.execute(
        sa.text("DELETE FROM context_models WHERE is_template = false")
    ).rowcount

    # Templates are assignment-free blueprints: reset any lingering placements.
    templates_reset = bind.execute(
        sa.text(
            "UPDATE context_models SET instance_assignments = '{}' "
            "WHERE is_template = true "
            "AND instance_assignments IS NOT NULL "
            "AND instance_assignments NOT IN ('{}', '', 'null')"
        )
    ).rowcount

    logger.info(
        "view_layout_merge: updated %s view configs, nulled %s cm pointers, "
        "deleted %s instance context_models, reset %s template assignment maps",
        configs_updated, pointers_nulled, deleted, templates_reset,
    )


def downgrade() -> None:
    """No-op: the fold-in is a one-way, user-approved breaking change. Deleted
    instance context_models and stripped legacy per-layer entityAssignments are
    not reconstructable."""
    pass
