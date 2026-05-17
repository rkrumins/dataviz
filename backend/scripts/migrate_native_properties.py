"""
Migration: convert blob-stored node ``properties`` to native FalkorDB fields.

Before this migration, FalkorDBProvider stored a node's user-supplied
``properties`` dict as a single JSON-stringified field ``n.properties``.
That forced every property predicate (e.g. ``logicalType = 'STRING'``) to
be evaluated in Python after fetch, defeating any index.

This script rewrites every existing node so that each scalar user-property
becomes a native FalkorDB property (``SET n += $nativeProps``) and any
non-scalar residual is preserved in ``n.propertiesRaw`` (JSON-stringified).
The legacy ``n.properties`` blob is removed.

Idempotent + restart-safe: each iteration processes only nodes that still
have the legacy ``n.properties`` field. The ``REMOVE n.properties`` SET
clause strips the field, so processed nodes drop out of the working set
automatically. No cursor needed — restarting after an interruption picks
up where the last run stopped.

Usage:
    python -m backend.scripts.migrate_native_properties --workspace-id <id>
    python -m backend.scripts.migrate_native_properties --data-source-id <id>
    python -m backend.scripts.migrate_native_properties              # default ws
    python -m backend.scripts.migrate_native_properties --label dataset
    python -m backend.scripts.migrate_native_properties --batch-size 500

Performance: ~10-30 minutes on a 1M-node FalkorDB graph at the default
batch size of 1000.
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import List, Optional

# Ensure project root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.app.db.engine import get_async_session
from backend.app.db.repositories import workspace_repo
from backend.app.providers.manager import provider_manager
from backend.app.providers.falkordb_provider import (
    _split_user_properties,
    _sanitize_label,
)
from backend.app.services.context_engine import ContextEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def _get_query(provider):
    """Return the provider's write method. Mirrors backfill_node_levels.py."""
    write = getattr(provider, "_query", None) or getattr(provider, "_run_write", None)
    if write is None:
        raise RuntimeError(
            f"Provider {type(provider).__name__} has no recognized query method"
        )
    return write


async def _discover_labels(provider) -> List[str]:
    """FalkorDB-native label discovery via CALL db.labels().

    Returns an empty list on failure; callers fall back to a label-less
    scan (slower but correct).
    """
    query = _get_query(provider)
    try:
        result = await query("CALL db.labels()")
        rs = getattr(result, "result_set", None) or []
        return [row[0] for row in rs if row and row[0]]
    except Exception as exc:
        logger.warning(
            "CALL db.labels() failed (%s); falling back to label-less scan",
            exc,
        )
        return []


async def _migrate_one_pass(
    provider, label: Optional[str], batch_size: int,
) -> int:
    """Migrate every node with legacy ``n.properties`` in one label.

    Loops until the working set (``WHERE n.properties IS NOT NULL``) is
    exhausted. Each batch:
      1. SELECT a batch of {urn, blob} from the working set
      2. Parse each blob, split into (native_scalars, residual_json)
      3. UNWIND-update: SET n += $nativeProps, n.propertiesRaw, REMOVE n.properties
    """
    query = _get_query(provider)
    label_clause = f":`{_sanitize_label(label)}`" if label else ""
    total = 0

    while True:
        select_cypher = (
            f"MATCH (n{label_clause}) "
            f"WHERE n.properties IS NOT NULL "
            f"WITH n LIMIT {batch_size} "
            f"RETURN n.urn AS urn, n.properties AS blob"
        )
        result = await query(select_cypher)
        rs = getattr(result, "result_set", None) or []
        if not rs:
            break

        batch_items = []
        for row in rs:
            urn, blob = row[0], row[1]
            if not urn:
                continue
            user_props = {}
            if isinstance(blob, str) and blob:
                try:
                    parsed = json.loads(blob)
                    if isinstance(parsed, dict):
                        user_props = parsed
                except (json.JSONDecodeError, TypeError):
                    # Invalid JSON in the blob — strip the field but log so
                    # the operator can investigate. Keep going; one bad
                    # node shouldn't stall a million-node migration.
                    logger.warning(
                        "urn=%s: invalid JSON in n.properties; "
                        "stripping anyway, residual will be empty",
                        urn,
                    )
            native_props, residual_blob = _split_user_properties(user_props)
            batch_items.append({
                "urn": urn,
                "nativeProps": native_props,
                "propertiesRaw": residual_blob,
            })

        if not batch_items:
            break

        update_cypher = (
            "UNWIND $batch AS item "
            "MATCH (n {urn: item.urn}) "
            "SET n += item.nativeProps, "
            "    n.propertiesRaw = item.propertiesRaw "
            "REMOVE n.properties"
        )
        await query(update_cypher, params={"batch": batch_items})

        total += len(batch_items)
        logger.info(
            "  %s: batch of %d migrated (running total %d)",
            label or "<all>", len(batch_items), total,
        )

        # If the SELECT returned fewer rows than batch_size, the working
        # set is exhausted — avoid an extra empty round-trip.
        if len(rs) < batch_size:
            break

    return total


async def migrate(
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    label: Optional[str] = None,
    batch_size: int = 1000,
) -> None:
    async with get_async_session() as session:
        if not workspace_id and not data_source_id:
            ws = await workspace_repo.get_default_workspace(session)
            if not ws:
                logger.error(
                    "No workspace specified and no default workspace found"
                )
                return
            workspace_id = ws.id
            logger.info("Using default workspace: %s (%s)", ws.name, ws.id)

        engine = await ContextEngine.for_workspace(
            workspace_id, provider_manager, session,
            data_source_id=data_source_id,
        )

        if label:
            labels: List[Optional[str]] = [label]
        else:
            discovered = await _discover_labels(engine.provider)
            labels = discovered if discovered else [None]

        logger.info(
            "Migrating native properties across %d label(s): %s",
            len(labels), labels,
        )

        total = 0
        for lbl in labels:
            try:
                migrated = await _migrate_one_pass(
                    engine.provider, lbl, batch_size,
                )
                logger.info("%s: %d nodes migrated", lbl or "<all>", migrated)
                total += migrated
            except Exception as exc:
                logger.warning("%s: failed — %s", lbl or "<all>", exc)

        # Final verification: count nodes that still carry the legacy blob.
        # A non-zero result is a signal to re-run (some node was added during
        # migration, or a per-label pass errored partway).
        try:
            query = _get_query(engine.provider)
            verify = await query(
                "MATCH (n) WHERE n.properties IS NOT NULL "
                "RETURN count(n) AS remaining"
            )
            rs = getattr(verify, "result_set", None) or []
            remaining = int(rs[0][0]) if rs and rs[0] else 0
            if remaining > 0:
                logger.warning(
                    "Migration complete but %d nodes still carry "
                    "n.properties — re-run to finish", remaining,
                )
            else:
                logger.info(
                    "Migration complete: 0 nodes carry the legacy blob. "
                    "Total migrated this run: %d", total,
                )
        except Exception as exc:
            logger.warning(
                "Verification query failed: %s. Total migrated this run: %d",
                exc, total,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Migrate blob-stored node properties to native FalkorDB fields."
        ),
    )
    parser.add_argument("--workspace-id", help="Target workspace ID")
    parser.add_argument("--data-source-id", help="Target data source ID")
    parser.add_argument(
        "--label",
        help="Restrict migration to a single label (auto-discovered if omitted)",
    )
    parser.add_argument(
        "--batch-size", type=int, default=1000,
        help="Number of nodes processed per round-trip (default 1000)",
    )
    args = parser.parse_args()

    asyncio.run(migrate(
        workspace_id=args.workspace_id,
        data_source_id=args.data_source_id,
        label=args.label,
        batch_size=args.batch_size,
    ))
