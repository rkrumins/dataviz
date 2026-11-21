"""Keeping the collections in step with their sources.

``docs``
    The corpus this release was built with. At start-up (and on Re-index) every
    chunk's content hash is compared with what is stored; only changed chunks
    are embedded, removed pages are deleted.
``views``
    Every view a read-only service account can list (``AI_INDEXER_API_KEY``),
    except private ones — those are found by keyword, as their owner. Every
    ``AI_VIEWS_SYNC_INTERVAL_SECONDS`` the views changed since the last sync
    (``updatedAfter``) are re-embedded; once a day the full list is compared
    with what is stored, and views that are gone are deleted.

Both build into a collection version tied to the embedding model, dimension
and chunker (``store``): a new model builds a new version beside the old one,
which keeps serving until the new one is complete. One indexer per collection
runs at a time, across replicas (an advisory lock).
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from ..platform_client import PlatformClient, PlatformError
from .corpus import CHUNKER, Chunk, chunk_id
from .embedder import Embedder, EmbedderUnavailable
from .store import VectorStore

logger = logging.getLogger(__name__)

VIEWS_CHUNKER = "view-card-v1"
_FULL_RECONCILE_SECONDS = 24 * 3600


@dataclass
class SyncReport:
    collection: str
    version: Optional[int] = None
    embedded: int = 0
    unchanged: int = 0
    deleted: int = 0
    status: str = "ok"
    error: Optional[str] = None
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


async def sync_chunks(store: VectorStore, embedder: Embedder, collection: str, chunks: list[Chunk],
                      *, chunker: str, complete: bool = True, cursor: Optional[str] = None,
                      metadata_of=None) -> SyncReport:
    """Bring *collection* to hold *chunks* (all of them when ``complete``)."""
    report = SyncReport(collection)
    if embedder.dimensions is None and chunks:
        await embedder.embed_query(chunks[0].embed_text())  # learn the dimension
    version = await store.version_for(collection, model=embedder.model,
                                      dimensions=int(embedder.dimensions or 0), chunker=chunker)
    report.version = version.version
    stored = await store.hashes(collection, version.version)
    by_source: dict[str, list[Chunk]] = {}
    for c in chunks:
        by_source.setdefault(c.source_id, []).append(c)
    try:
        for source_id, group in by_source.items():
            digest = hashlib.sha1("".join(c.content_hash for c in group).encode()).hexdigest()
            if stored.get(source_id) == digest:
                report.unchanged += 1
                continue
            vectors = await embedder.embed_documents([c.embed_text() for c in group])
            meta = metadata_of(group[0]) if metadata_of else group[0].metadata
            await store.upsert(collection, version.version, source_id, digest,
                               list(zip(group, vectors)), meta)
            report.embedded += 1
        if complete:
            gone = [sid for sid in stored if sid not in by_source]
            await store.delete(collection, version.version, gone)
            report.deleted = len(gone)
        await store.finish(collection, version.version, cursor=cursor)
    except EmbedderUnavailable as exc:
        report.status, report.error = "failed", str(exc)
        await store.fail(collection, version.version, str(exc))
    return report


def view_chunk(view: dict) -> Chunk:
    tags = ", ".join(view.get("tags") or [])
    text = "\n".join(p for p in [
        view.get("description") or "",
        f"Tags: {tags}" if tags else "",
        f"Workspace: {view.get('workspaceName') or ''}",
        f"Data source: {view.get('dataSourceName') or ''}",
        f"Kind: {view.get('viewType') or ''}",
    ] if p.strip())
    source_id = f"view/{view['id']}"
    return Chunk(
        id=chunk_id("views", source_id, 0), source_id=source_id, ord=0,
        title=str(view.get("name") or view["id"]), heading="", url=f"/views/{view['id']}",
        text=text or str(view.get("name") or ""),
        metadata={"viewId": view["id"], "workspaceId": view.get("workspaceId"),
                  "dataSourceId": view.get("dataSourceId"), "visibility": view.get("visibility")},
    )


async def list_shared_views(client: PlatformClient, *, updated_after: Optional[str] = None,
                            budget_seconds: float = 120.0) -> tuple[list[dict], bool]:
    """Views the service account can list, private ones left out.
    Returns (views, complete)."""
    out: list[dict] = []
    offset = 0
    deadline = time.monotonic() + budget_seconds
    while time.monotonic() < deadline:
        page = await client.list_views(limit=200, offset=offset, updated_after=updated_after)
        items = (page or {}).get("items") or []
        out.extend(v for v in items if v.get("id") and (v.get("visibility") or "").lower() != "private")
        if not (page or {}).get("hasMore") or not items:
            return out, True
        offset = int((page or {}).get("nextOffset") or offset + len(items))
    return out, False


class Indexer:
    """Runs the syncs, in the background and on request."""

    def __init__(self, *, store: VectorStore, embedder_factory, docs_chunks: list[Chunk],
                 views_client_factory=None, views_interval: int = 300) -> None:
        self._store = store
        self._embedder_factory = embedder_factory
        self._docs = docs_chunks
        self._views_client_factory = views_client_factory
        self._interval = views_interval
        self._last_full_views = 0.0
        self._task: Optional[asyncio.Task] = None
        self.reports: dict[str, SyncReport] = {}
        self._wake = asyncio.Event()
        self._pending: set[str] = {"docs", "views"}

    def request(self, collection: str) -> None:
        self._pending.add(collection)
        if collection == "views":
            self._last_full_views = 0.0
        self._wake.set()

    async def sync(self, collection: str) -> Optional[SyncReport]:
        embedder = await self._embedder_factory()
        if embedder is None:
            self.reports[collection] = SyncReport(collection, status="lexical",
                                                  error="No embedding model is set.")
            return self.reports[collection]
        async with self._store.try_lock(collection) as got:
            if not got:
                return None
            if collection == "docs":
                report = await sync_chunks(self._store, embedder, "docs", self._docs, chunker=CHUNKER)
            elif collection == "views":
                report = await self._sync_views(embedder)
            else:
                return None
        self.reports[collection] = report
        logger.info("knowledge sync %s: %s", collection, report)
        return report

    async def _sync_views(self, embedder: Embedder) -> SyncReport:
        if self._views_client_factory is None:
            return SyncReport("views", status="disabled",
                              error="No service account key is set (AI_INDEXER_API_KEY).")
        client = self._views_client_factory()
        try:
            active = await self._store.active("views")
            full = (time.monotonic() - self._last_full_views > _FULL_RECONCILE_SECONDS
                    or active is None or active.model != embedder.model)
            since = None if full else (active.cursor if active else None)
            started = datetime.now(timezone.utc).isoformat()
            views, complete = await list_shared_views(client, updated_after=since)
            report = await sync_chunks(
                self._store, embedder, "views", [view_chunk(v) for v in views],
                chunker=VIEWS_CHUNKER, complete=full and complete, cursor=started,
            )
            if full and complete:
                self._last_full_views = time.monotonic()
            return report
        except PlatformError as exc:
            return SyncReport("views", status="failed", error=exc.message)
        finally:
            await client.aclose()

    async def run_forever(self) -> None:
        while True:
            for collection in sorted(self._pending):
                try:
                    await self.sync(collection)
                except Exception:  # noqa: BLE001
                    logger.exception("knowledge sync %s failed", collection)
            self._pending = {"views"}
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._interval)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.run_forever(), name="ai-knowledge-indexer")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None


def status_of(report: Optional[Any]) -> dict:
    if report is None:
        return {}
    return {"lastStatus": report.status, "lastError": report.error, "lastRun": report.started_at,
            "embedded": report.embedded, "unchanged": report.unchanged, "deleted": report.deleted}
