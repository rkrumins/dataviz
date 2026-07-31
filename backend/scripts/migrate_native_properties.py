"""Migration: unpack nested node property containers into native fields.

A graph built outside the platform — and every graph written before the
native-property refactor — nests its user properties under a single container
key (``n.properties`` by default). The read path hydrates that container so
the UI looks right, but a nested value is not an indexable field, so Advanced
Search cannot filter on any of it. This rewrites each node so every scalar
leaf becomes a real FalkorDB property (``SET n += $nativeProps``), preserving
anything non-scalar in ``n.propertiesRaw`` and removing the container.

**This is now a thin wrapper.** The walk itself lives in
``backend.app.services.property_alignment.run_alignment``, which the UI's
alignment job also drives — one implementation, so the two cannot drift.
Prefer the UI (Data source → Mapping → Align): it reports progress, can be
cancelled, resumes from a cursor, and runs behind the provider admission gate.
This script exists for operators without UI access.

What the shared runner changed, versus the original script:

* It walks **internal-ID windows** instead of buffering every URN for a label
  into a Python list — roughly a gigabyte of strings at 10M nodes, and an
  unbounded scan before the first write. Memory is now flat at any graph size.
* A container that does not parse is **left alone** and counted. The original
  ``REMOVE`` fired regardless, destroying the data it was meant to migrate.
* ``searchableText`` is recomputed in the same pass, so text search over
  property values is correct immediately. It used to need a separate,
  non-composable ``--searchable-text`` invocation, which was itself broken:
  it type-checked ``isinstance(props, dict)`` against what FalkorDB returns as
  a ``Node`` object, so property values never reached the computation.

Usage:
    python -m backend.scripts.migrate_native_properties --workspace-id <id>
    python -m backend.scripts.migrate_native_properties --data-source-id <id>
    python -m backend.scripts.migrate_native_properties              # default ws, all DS
    python -m backend.scripts.migrate_native_properties --dry-run
    python -m backend.scripts.migrate_native_properties --window 100000

Idempotent and restart-safe: removing the container drops a node out of the
working set, so a re-run only sees what is left. ``--start-id`` resumes an
interrupted run from the ID the last one reported.
"""

import argparse
import asyncio
import logging
import os
import sys
from typing import Optional

# Ensure project root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from backend.app.db.engine import get_async_session
from backend.app.db.repositories import data_source_repo, workspace_repo
from backend.app.providers.manager import provider_manager
from backend.app.services.context_engine import ContextEngine
from backend.app.services.property_alignment import ALIGN_WINDOW, run_alignment

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def _migrate_one_data_source(
    workspace_id: Optional[str],
    data_source_id: str,
    session,
    *,
    window: int,
    start_id: int,
    dry_run: bool,
) -> dict:
    """Align one data source's graph. Returns the runner's stats."""
    engine = await ContextEngine.for_workspace(
        workspace_id, provider_manager, session,
        data_source_id=data_source_id,
    )
    mapping = getattr(engine.provider, "_mapping", None)

    async def _log_progress(stats: dict) -> None:
        max_id = stats.get("maxId") or 0
        done = min(stats.get("lastId") or 0, max_id)
        pct = int(done / max_id * 100) if max_id else 0
        logger.info(
            "  %3d%% — %d aligned / %d seen (id %d of %d)",
            pct, stats.get("aligned", 0), stats.get("processed", 0),
            done, max_id,
        )

    stats = await run_alignment(
        engine.provider, mapping,
        window=window, start_id=start_id, dry_run=dry_run,
        progress_cb=_log_progress,
    )

    logger.info(
        "  data_source=%s: %d aligned, %d seen, %d unreadable (preserved), "
        "%d without urn (skipped)%s",
        data_source_id, stats["aligned"], stats["processed"],
        stats["unparseable"], stats["skippedNoUrn"],
        " [DRY RUN — nothing written]" if dry_run else "",
    )
    if stats["unparseable"]:
        logger.warning(
            "  data_source=%s: %d container(s) were not property dictionaries "
            "and were left untouched — inspect them before re-running.",
            data_source_id, stats["unparseable"],
        )
    return stats


async def migrate(
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    window: int = ALIGN_WINDOW,
    start_id: int = 0,
    dry_run: bool = False,
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

        # A workspace can have several data sources, each its own graph.
        if data_source_id:
            data_source_ids = [data_source_id]
        else:
            sources = await data_source_repo.list_data_sources(
                session, workspace_id,
            )
            if not sources:
                logger.warning(
                    "Workspace %s has no data sources to migrate", workspace_id,
                )
                return
            data_source_ids = [ds.id for ds in sources]
            logger.info(
                "Workspace %s: %d data source(s) to align",
                workspace_id, len(data_source_ids),
            )

        grand_total = 0
        for ds_id in data_source_ids:
            logger.info("=== data_source=%s ===", ds_id)
            try:
                stats = await _migrate_one_data_source(
                    workspace_id, ds_id, session,
                    window=window, start_id=start_id, dry_run=dry_run,
                )
                grand_total += stats["aligned"]
            except Exception as exc:
                logger.warning("data_source=%s: aborted — %s", ds_id, exc)

        logger.info(
            "All data sources processed. Grand total: %d nodes aligned%s.",
            grand_total, " (dry run)" if dry_run else "",
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Unpack nested node property containers into native FalkorDB "
            "fields. Prefer the UI (Data source -> Mapping) where available."
        ),
    )
    parser.add_argument("--workspace-id", help="Target workspace ID")
    parser.add_argument("--data-source-id", help="Target data source ID")
    parser.add_argument(
        "--window", type=int, default=ALIGN_WINDOW,
        help=(
            "Internal-ID span read per round-trip (default "
            f"{ALIGN_WINDOW}). Bounds memory, not row count."
        ),
    )
    parser.add_argument(
        "--start-id", type=int, default=0,
        help="Resume from this internal ID (as reported by an interrupted run).",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Report what would change without writing anything.",
    )
    args = parser.parse_args()

    asyncio.run(migrate(
        workspace_id=args.workspace_id,
        data_source_id=args.data_source_id,
        window=args.window,
        start_id=args.start_id,
        dry_run=args.dry_run,
    ))
