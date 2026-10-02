"""Backfill views.config content.entityScope so it is never inferred again.

A view's entity scope — 'all' (contents resolve by the layers' type rules) vs
'curated' (only what was explicitly placed) — was stored only when something
happened to write it. Everywhere else it was DERIVED at read time from "does
this view have any assignments".

That inference is the bug factory. A rule-driven view (layers carrying
`entityTypes`, no assignments) reads as 'all'; drag ONE entity into it and the
same view now reads as 'curated', which switches off the very rules that were
placing its contents. The view saves showing one entity.

This writes the CURRENT DERIVED ANSWER onto every view that lacks one, so:

  * nothing changes behaviour — every view keeps resolving exactly as it does
    today, because the value written is the value that was being computed;
  * the answer stops depending on assignments existing, so it can no longer
    flip as a side effect of an unrelated edit.

The rule below is a FROZEN COPY of `app.services.layout_config`'s
`derive_entity_scope` as of this revision, deliberately not an import: a
migration that imports app code breaks every not-yet-upgraded environment the
day that module is renamed or moved.

Idempotent — a view that already carries a valid scope is left alone, so a
re-run is a no-op. Downgrade cannot distinguish a backfilled value from one
that was always there, so it does nothing rather than destroy real settings.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "20260920_1200_view_entity_scope"
down_revision = "20260916_1100_property_key_count"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

VALID = ("all", "curated")
BATCH = 500


def _is_exact_urn_pattern(pattern: Any) -> bool:
    """A rule naming ONE urn is an assignment in disguise; a glob is not."""
    return isinstance(pattern, str) and bool(pattern) and "*" not in pattern and "?" not in pattern


def _logical_nodes_have_exact_rule(nodes: Any) -> bool:
    """Depth-first over a logicalNodes tree of arbitrary nesting."""
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        for rule in node.get("rules") or []:
            if isinstance(rule, dict) and _is_exact_urn_pattern(rule.get("urnPattern")):
                return True
        if _logical_nodes_have_exact_rule(node.get("children")):
            return True
    return False


def _raw_layout(config: Any) -> dict:
    """The stored referenceLayout, at either of the two places it has lived."""
    if not isinstance(config, dict):
        return {}
    layout = config.get("layout")
    if isinstance(layout, dict) and isinstance(layout.get("referenceLayout"), dict):
        return layout["referenceLayout"]
    legacy = config.get("referenceLayout")
    return legacy if isinstance(legacy, dict) else {}


def _has_any_assignment(config: Any) -> bool:
    """Mirrors the three sources `_normalize` up-converts from. Only whether
    ANY exists matters here, so it short-circuits instead of building the map."""
    raw = _raw_layout(config)

    assignments = raw.get("assignments")
    if isinstance(assignments, dict):
        if any(isinstance(v, dict) for v in assignments.values()):
            return True

    for layer in raw.get("layers") or []:
        if not isinstance(layer, dict):
            continue
        for entry in layer.get("entityAssignments") or []:
            if isinstance(entry, dict) and (entry.get("urn") or entry.get("entityId")):
                return True
        for rule in layer.get("rules") or []:
            if isinstance(rule, dict) and _is_exact_urn_pattern(rule.get("urnPattern")):
                return True
        if _logical_nodes_have_exact_rule(layer.get("logicalNodes")):
            return True

    return False


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, config FROM views")).fetchall()

    updates: list[dict] = []
    skipped_explicit = 0
    skipped_unparseable = 0

    for view_id, raw_config in rows:
        try:
            config = json.loads(raw_config) if isinstance(raw_config, str) else raw_config
        except (TypeError, ValueError):
            # A config we cannot read is a config we must not rewrite. Leaving
            # it alone keeps the (unchanged) read-time derivation serving it.
            skipped_unparseable += 1
            continue
        if not isinstance(config, dict):
            skipped_unparseable += 1
            continue

        content = config.get("content")
        if not isinstance(content, dict):
            content = {}
            config["content"] = content

        if content.get("entityScope") in VALID:
            skipped_explicit += 1
            continue

        content["entityScope"] = "curated" if _has_any_assignment(config) else "all"
        updates.append({"vid": view_id, "cfg": json.dumps(config)})

    for i in range(0, len(updates), BATCH):
        conn.execute(
            sa.text("UPDATE views SET config = :cfg WHERE id = :vid"),
            updates[i:i + BATCH],
        )

    log.info(
        "view entityScope backfill: %d written, %d already explicit, %d unreadable (left alone)",
        len(updates), skipped_explicit, skipped_unparseable,
    )


def downgrade() -> None:
    """No-op on purpose.

    A backfilled value is indistinguishable from one a user chose, so removing
    "the ones this migration added" would also strip deliberate settings. The
    read path still honours an explicit scope, so leaving the values in place
    is both harmless and correct on the way down.
    """
