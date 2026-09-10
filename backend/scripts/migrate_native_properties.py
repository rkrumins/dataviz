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

A workspace can have multiple data sources, each backed by its own graph
(cached per ``(provider_id, graph_name)``). ``--workspace-id`` iterates
every data source in the workspace; ``--data-source-id`` overrides this
to target exactly one.

Usage:
    python -m backend.scripts.migrate_native_properties --workspace-id <id>
    python -m backend.scripts.migrate_native_properties --data-source-id <id>
    python -m backend.scripts.migrate_native_properties              # default ws, all DS
    python -m backend.scripts.migrate_native_properties --label dataset
    python -m backend.scripts.migrate_native_properties --batch-size 500

Performance: ~10-30 minutes on a 1M-node FalkorDB graph at the default
batch size of 1000.

Searchable-text backfill (one-time):
    python -m backend.scripts.migrate_native_properties --searchable-text

Computes and SETs ``n.searchableText`` on every existing node (any label).
Required before ``text target='any'`` searches return correct results on
pre-existing data. Idempotent — re-runs overwrite the field.
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
from backend.app.db.repositories import data_source_repo, workspace_repo
from backend.app.providers.manager import provider_manager
from backend.app.providers.falkordb_provider import (
    _compute_searchable_text,
    _split_user_properties,
    _sanitize_label,
    _RESERVED_NODE_KEYS,
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

    Two phases per label:
      A. One full-label scan to enumerate URNs needing migration. The
         ``WHERE n.properties IS NOT NULL`` predicate can't be index-driven,
         so we pay this scan once instead of once per batch.
      B. For each URN batch, one labeled UNWIND read + one labeled UNWIND
         write — both ride the per-label ``(:Label) ON (n.urn)`` index.

    Restart-safe: a re-run's Phase A only enumerates URNs that still carry
    the legacy field. Idempotent: Phase B's ``REMOVE n.properties`` is a
    no-op if the field is already gone.
    """
    query = _get_query(provider)
    label_clause = f":`{_sanitize_label(label)}`" if label else ""

    enum_cypher = (
        f"MATCH (n{label_clause}) "
        f"WHERE n.properties IS NOT NULL "
        f"RETURN n.urn AS urn"
    )
    result = await query(enum_cypher)
    rs = getattr(result, "result_set", None) or []
    urns = [row[0] for row in rs if row and row[0]]
    if not urns:
        return 0

    logger.info(
        "  %s: %d nodes to migrate (enumerated in one scan)",
        label or "<all>", len(urns),
    )

    fetch_cypher = (
        f"UNWIND $urns AS u "
        f"MATCH (n{label_clause} {{urn: u}}) "
        f"RETURN n.urn AS urn, n.properties AS blob"
    )
    update_cypher = (
        f"UNWIND $batch AS item "
        f"MATCH (n{label_clause} {{urn: item.urn}}) "
        f"SET n += item.nativeProps, "
        f"    n.propertiesRaw = item.propertiesRaw "
        f"REMOVE n.properties"
    )

    total = 0
    for start in range(0, len(urns), batch_size):
        batch_urns = urns[start:start + batch_size]

        result = await query(fetch_cypher, params={"urns": batch_urns})
        rs = getattr(result, "result_set", None) or []

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
            continue

        await query(update_cypher, params={"batch": batch_items})

        total += len(batch_items)
        logger.info(
            "  %s: batch of %d migrated (running total %d / %d)",
            label or "<all>", len(batch_items), total, len(urns),
        )

    return total


async def _backfill_searchable_text(
    provider, batch_size: int, progress_every: int = 10,
) -> int:
    """Compute and SET ``n.searchableText`` on every node (any label).

    Uses keyset pagination on ``n.urn`` so this is restart-safe and
    streams rather than buffering every URN. Idempotent: re-runs simply
    overwrite the field.

    Returns total nodes processed.
    """
    query = _get_query(provider)
    fetch_cypher = (
        "MATCH (n) "
        "WHERE $cursor IS NULL OR n.urn > $cursor "
        "RETURN n.urn AS urn, n.displayName AS displayName, "
        "n.qualifiedName AS qualifiedName, n.description AS description, "
        "n AS props "
        "ORDER BY n.urn ASC LIMIT $limit"
    )
    update_cypher = (
        "UNWIND $batch AS row "
        "MATCH (n {urn: row.urn}) "
        "SET n.searchableText = row.text"
    )

    cursor: Optional[str] = None
    total = 0
    batches = 0
    while True:
        result = await query(
            fetch_cypher, params={"cursor": cursor, "limit": batch_size},
        )
        rs = getattr(result, "result_set", None) or []
        if not rs:
            break

        batch_items = []
        last_urn = cursor
        for row in rs:
            urn = row[0]
            if not urn:
                continue
            display_name = row[1]
            qualified_name = row[2]
            description = row[3]
            props = row[4] if len(row) > 4 else None
            # FalkorDB returns the node object as a dict-like; pull the
            # non-reserved keys to recover user properties.
            user_props = {}
            if isinstance(props, dict):
                for k, v in props.items():
                    if k in _RESERVED_NODE_KEYS:
                        continue
                    user_props[k] = v
            # n.tags is stored as a JSON-encoded string on the node;
            # _compute_searchable_text parses it.
            raw_tags = props.get("tags") if isinstance(props, dict) else None
            text = _compute_searchable_text(
                display_name, qualified_name, description, user_props,
                tags=raw_tags,
            )
            batch_items.append({"urn": urn, "text": text})
            last_urn = urn

        if batch_items:
            await query(update_cypher, params={"batch": batch_items})
            total += len(batch_items)

        batches += 1
        if batches % progress_every == 0:
            logger.info(
                "  searchable-text backfill: %d nodes processed", total,
            )

        if last_urn == cursor or len(rs) < batch_size:
            break
        cursor = last_urn

    logger.info(
        "  searchable-text backfill: complete (%d nodes processed)", total,
    )
    return total


async def _migrate_one_data_source(
    workspace_id: Optional[str],
    data_source_id: str,
    label: Optional[str],
    batch_size: int,
    session,
    searchable_text: bool = False,
) -> int:
    """Migrate every label in one data source's graph. Returns nodes migrated."""
    engine = await ContextEngine.for_workspace(
        workspace_id, provider_manager, session,
        data_source_id=data_source_id,
    )

    if searchable_text:
        # Standalone searchable-text backfill pass. Operates over every
        # node (any label) and does not touch the legacy n.properties blob.
        return await _backfill_searchable_text(engine.provider, batch_size)

    if label:
        labels: List[Optional[str]] = [label]
    else:
        discovered = await _discover_labels(engine.provider)
        labels = discovered if discovered else [None]

    logger.info(
        "  Migrating across %d label(s): %s", len(labels), labels,
    )

    total = 0
    for lbl in labels:
        try:
            migrated = await _migrate_one_pass(
                engine.provider, lbl, batch_size,
            )
            logger.info("  %s: %d nodes migrated", lbl or "<all>", migrated)
            total += migrated
        except Exception as exc:
            logger.warning("  %s: failed — %s", lbl or "<all>", exc)

    # Per-data-source verification: each graph is independent.
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
                "  data_source=%s: %d nodes still carry n.properties "
                "— re-run to finish", data_source_id, remaining,
            )
        else:
            logger.info(
                "  data_source=%s: complete (0 legacy blobs remain, "
                "%d migrated this run)", data_source_id, total,
            )
    except Exception as exc:
        logger.warning(
            "  data_source=%s: verification failed (%s); "
            "%d migrated this run", data_source_id, exc, total,
        )

    return total


async def migrate(
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    label: Optional[str] = None,
    batch_size: int = 1000,
    searchable_text: bool = False,
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

        # When --data-source-id is given, migrate exactly that one.
        # Otherwise enumerate every data source in the workspace — each
        # is its own (provider_id, graph_name) and needs its own pass.
        if data_source_id:
            data_source_ids = [data_source_id]
        else:
            sources = await data_source_repo.list_data_sources(
                session, workspace_id,
            )
            if not sources:
                logger.warning(
                    "Workspace %s has no data sources to migrate",
                    workspace_id,
                )
                return
            data_source_ids = [ds.id for ds in sources]
            logger.info(
                "Workspace %s: %d data source(s) to migrate",
                workspace_id, len(data_source_ids),
            )

        grand_total = 0
        for ds_id in data_source_ids:
            logger.info("=== data_source=%s ===", ds_id)
            try:
                grand_total += await _migrate_one_data_source(
                    workspace_id, ds_id, label, batch_size, session,
                    searchable_text=searchable_text,
                )
            except Exception as exc:
                logger.warning(
                    "data_source=%s: aborted — %s", ds_id, exc,
                )

        logger.info(
            "All data sources processed. Grand total: %d nodes %s.",
            grand_total,
            "backfilled" if searchable_text else "migrated",
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
    parser.add_argument(
        "--searchable-text", action="store_true",
        help=(
            "Run the searchable-text backfill pass instead of the "
            "blob-to-native migration. Computes and SETs n.searchableText "
            "on every node (any label). Idempotent — safe to re-run."
        ),
    )
    args = parser.parse_args()

    asyncio.run(migrate(
        workspace_id=args.workspace_id,
        data_source_id=args.data_source_id,
        label=args.label,
        batch_size=args.batch_size,
        searchable_text=args.searchable_text,
    ))
