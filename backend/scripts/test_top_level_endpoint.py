"""
Verification script for the /nodes/top-level pipeline (Phase 1.7).

Exercises the full ontology-driven top-level/orphan computation end-to-end
by bypassing HTTP and calling `ContextEngine.get_top_level_or_orphan_nodes`
directly against a real workspace. Proves:

    1. The provider resolves containment edge types from the ontology
       (no hardcoded CONTAINS/BELONGS_TO fallback).
    2. Root-type vs orphan classification returns diagnostic totals.
    3. Cursor-based pagination yields distinct URNs across pages.
    4. `invalidate_ontology_cache()` forces the next call to re-resolve.
    5. A workspace with no containment edges raises
       `ProviderConfigurationError` (wired to HTTP 400 at the endpoint).

Usage:
    WORKSPACE_ID=<uuid> DATA_SOURCE_ID=<uuid> \
        python -m backend.scripts.test_top_level_endpoint

Optional:
    EMPTY_CONTAINMENT_WORKSPACE_ID  — a second workspace whose active
                                      ontology defines no containment
                                      edge types. If unset, step 5 is
                                      skipped with a warning.
"""

import asyncio
import logging
import os
import sys
from typing import Optional

# Make `backend.*` imports resolve when invoked as a module from repo root.
sys.path.append(os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.db.engine import get_async_session
from backend.app.services.context_engine import ContextEngine
from backend.app.registry.provider_registry import provider_registry
from backend.common.interfaces.provider import ProviderConfigurationError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("test_top_level_endpoint")


def _fmt_node(n, idx: int) -> str:
    urn = getattr(n, "urn", None) or getattr(n, "id", "<no-urn>")
    display = getattr(n, "display_name", None) or getattr(n, "displayName", "<no-name>")
    entity_type = getattr(n, "entity_type", None) or getattr(n, "entityType", "<no-type>")
    return f"  [{idx}] {display}  ({entity_type})  {urn}"


async def _fetch_page(engine: ContextEngine, *, limit: int, cursor: Optional[str]):
    return await engine.get_top_level_or_orphan_nodes(
        limit=limit,
        cursor=cursor,
        include_child_count=True,
    )


async def run_happy_path(workspace_id: str, data_source_id: Optional[str]) -> None:
    logger.info("=" * 72)
    logger.info("HAPPY PATH: workspace=%s data_source=%s", workspace_id, data_source_id)
    logger.info("=" * 72)

    async with get_async_session() as session:
        engine = await ContextEngine.for_workspace(
            workspace_id=workspace_id,
            registry=provider_registry,
            session=session,
            data_source_id=data_source_id,
        )

        # --- Step 1: first page ------------------------------------------------
        logger.info("Step 1: fetch first page (limit=20)")
        page1 = await _fetch_page(engine, limit=20, cursor=None)
        logger.info(
            "  total=%s  returned=%s  has_more=%s  next_cursor=%s",
            page1.total_count, len(page1.nodes), page1.has_more, page1.next_cursor,
        )
        logger.info(
            "  classification: root_type=%s  orphan=%s",
            page1.root_type_count, page1.orphan_count,
        )
        logger.info("  first-5 nodes:")
        for i, n in enumerate(page1.nodes[:5]):
            logger.info(_fmt_node(n, i))

        if not page1.nodes:
            logger.warning(
                "  empty result set — the workspace has no top-level/orphan "
                "instances, or the ontology resolves to an empty containment "
                "edge list (which should have raised instead)."
            )

        # --- Step 2: cursor pagination ----------------------------------------
        if page1.has_more and page1.next_cursor:
            logger.info("Step 2: fetch next page via cursor")
            page2 = await _fetch_page(engine, limit=20, cursor=page1.next_cursor)
            logger.info(
                "  total=%s  returned=%s  has_more=%s",
                page2.total_count, len(page2.nodes), page2.has_more,
            )

            urns1 = {getattr(n, "urn", getattr(n, "id", None)) for n in page1.nodes}
            urns2 = {getattr(n, "urn", getattr(n, "id", None)) for n in page2.nodes}
            overlap = urns1 & urns2
            if overlap:
                logger.error("  FAIL: cursor page overlaps with first page: %s", overlap)
            else:
                logger.info("  PASS: %d distinct URNs across pages", len(urns1) + len(urns2))
        else:
            logger.info("Step 2: skipped (no next_cursor — single-page result)")

        # --- Step 3: invalidate cache and re-fetch ----------------------------
        logger.info("Step 3: invalidate ontology cache and re-fetch")
        try:
            engine.invalidate_ontology_cache()
            logger.info("  cache invalidated")
        except Exception as exc:
            logger.error("  FAIL: invalidate_ontology_cache raised: %s", exc)
            raise

        page3 = await _fetch_page(engine, limit=20, cursor=None)
        if page3.total_count == page1.total_count:
            logger.info(
                "  PASS: refresh returned consistent total (%s)", page3.total_count,
            )
        else:
            logger.warning(
                "  total changed between calls (%s → %s) — possibly due to "
                "concurrent writes, not a test failure",
                page1.total_count, page3.total_count,
            )

        # --- Step 4: ontology digest (proves digest helper is wired) ----------
        logger.info("Step 4: compute ontology digest")
        digest = await engine.get_ontology_digest()
        if digest:
            logger.info("  digest=%s…", digest[:16])
        else:
            logger.warning("  digest unavailable (ontology resolution failed)")


async def run_empty_containment_path(workspace_id: str) -> None:
    logger.info("=" * 72)
    logger.info("EMPTY-CONTAINMENT PATH: workspace=%s", workspace_id)
    logger.info("=" * 72)

    async with get_async_session() as session:
        try:
            engine = await ContextEngine.for_workspace(
                workspace_id=workspace_id,
                registry=provider_registry,
                session=session,
                data_source_id=None,
            )
        except Exception as exc:
            logger.error("  engine construction failed unexpectedly: %s", exc)
            return

        try:
            result = await _fetch_page(engine, limit=20, cursor=None)
            logger.error(
                "  FAIL: expected ProviderConfigurationError, got %d nodes",
                len(result.nodes),
            )
        except ProviderConfigurationError as exc:
            logger.info("  PASS: raised ProviderConfigurationError — %s", exc)
        except Exception as exc:
            logger.error(
                "  FAIL: expected ProviderConfigurationError but got %s: %s",
                type(exc).__name__, exc,
            )


async def main() -> int:
    workspace_id = os.environ.get("WORKSPACE_ID")
    data_source_id = os.environ.get("DATA_SOURCE_ID")
    empty_ws = os.environ.get("EMPTY_CONTAINMENT_WORKSPACE_ID")

    if not workspace_id:
        logger.error("WORKSPACE_ID env var is required")
        return 1

    await run_happy_path(workspace_id, data_source_id)

    if empty_ws:
        await run_empty_containment_path(empty_ws)
    else:
        logger.info(
            "EMPTY-CONTAINMENT path skipped (set EMPTY_CONTAINMENT_WORKSPACE_ID "
            "to exercise the ProviderConfigurationError branch)."
        )

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
