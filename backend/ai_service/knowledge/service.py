"""The knowledge facade: what the agent, the MCP server and the admin routes call."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy import select

from .. import connections, settings_store
from ..config import AiServiceConfig
from ..db import session_scope
from ..models import AiKnowledgeSourceORM, AiLlmConnectionORM
from . import corpus as corpus_mod
from .embedder import Embedder, EmbedderUnavailable
from .indexer import Indexer, status_of
from .lexical import Bm25Index
from .retrieval import Hit, fuse
from .sources import ExternalMcpSource, ProductKnowledge, ask_all
from .store import VectorStore, build_store

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class KnowledgeCaller:
    """Who a knowledge search is for: their delegation verifies views."""

    user_id: str
    delegation: str


class KnowledgeService:
    def __init__(self, config: AiServiceConfig, *, store: Optional[VectorStore] = None,
                 corpus: Optional[dict] = None, platform_transport=None) -> None:
        from ..mcp.knowledge_server import build_server

        self.config = config
        self.corpus = corpus if corpus is not None else corpus_mod.load()
        self.docs = corpus_mod.chunks(self.corpus)
        self._by_id = {c.id: c for c in self.docs}
        self.bm25 = Bm25Index().build(
            self.docs, text_of=lambda c: f"{c.title} {c.heading} {c.heading} {c.text}",
        )
        self.store = store if store is not None else build_store(config.vector_db_url)
        self.platform_transport = platform_transport
        self._embedder: Optional[tuple[str, Embedder]] = None
        self._external: dict[str, tuple[str, ExternalMcpSource]] = {}
        self.mcp = build_server(self)
        self.product = ProductKnowledge(self.mcp)
        self.indexer: Optional[Indexer] = None
        if self.store is not None:
            self.indexer = Indexer(
                store=self.store, embedder_factory=self.embedder, docs_chunks=self.docs,
                views_client_factory=self._views_client if config.indexer_api_key else None,
                views_interval=config.views_sync_interval_seconds,
            )

    def _views_client(self):
        from ..platform_client import PlatformClient

        return PlatformClient(self.config.platform_api_url, self.config.indexer_api_key,
                              timeout=self.config.platform_timeout_seconds,
                              transport=self.platform_transport)

    # ── lifecycle ──────────────────────────────────────────────────

    async def start(self) -> None:
        if self.store is None:
            return
        try:
            await self.store.ensure_schema()
        except Exception as exc:  # noqa: BLE001 — knowledge degrades to lexical, never blocks start
            logger.error("The vector store cannot be prepared (%s); retrieval stays lexical.", exc)
            return
        if self.indexer is not None and self.config.indexer_enabled:
            self.indexer.start()

    async def stop(self) -> None:
        if self.indexer is not None:
            await self.indexer.stop()
        for _, source in list(self._external.values()):
            await source.aclose()
        if self.store is not None:
            await self.store.close()

    def reindex(self, collection: str) -> bool:
        if self.indexer is None or collection not in ("docs", "views"):
            return False
        self.indexer.request(collection)
        return True

    # ── embedding ──────────────────────────────────────────────────

    async def embedder(self) -> Optional[Embedder]:
        async with session_scope() as session:
            settings = await settings_store.load(session)
            if not settings.embedding_connection_id:
                return None
            row = await session.get(AiLlmConnectionORM, settings.embedding_connection_id)
        if row is None or not row.enabled:
            return None
        stamp = f"{row.id}:{row.updated_at}"
        if self._embedder is not None and self._embedder[0] == stamp:
            return self._embedder[1]
        try:
            provider = connections.registry.get(row, allow_hosts=self.config.egress_allowed_hosts,
                                                timeout=self.config.llm_timeout_seconds)
            model = provider.model_for("embedding")
        except Exception as exc:  # noqa: BLE001
            logger.info("No embedder: %s", exc)
            return None
        embedder = Embedder(provider, model=model, dimensions=provider.capabilities.embedding_dimensions,
                            batch_size=self.config.embed_batch_size)
        self._embedder = (stamp, embedder)
        return embedder

    async def _dense(self, collection: str, query: str, limit: int) -> list:
        if self.store is None:
            return []
        try:
            embedder = await self.embedder()
            if embedder is None or not embedder.available:
                return []
            active = await self.store.active(collection)
            if active is None or active.model != embedder.model:
                return []
            vector = await embedder.embed_query(query)
            return await self.store.search(collection, active.version, active.dimensions, vector, limit)
        except (EmbedderUnavailable, Exception) as exc:  # noqa: BLE001 — fall back to lexical
            logger.info("dense retrieval for %s unavailable: %s", collection, exc)
            return []

    # ── searching ──────────────────────────────────────────────────

    async def search_docs_local(self, query: str, limit: int = 6) -> list[Hit]:
        lexical = [Hit(c.id, c.source_id, c.title, c.heading, c.url, c.text, s, metadata=c.metadata)
                   for c, s in self.bm25.search(query, limit * 3)]
        dense = [Hit(h.chunk_id, h.source_id, h.title, h.heading, h.url, h.text, h.score,
                     metadata=h.metadata) for h in await self._dense("docs", query, limit * 3)]
        return fuse(lexical, dense, limit=limit, key=lambda h: h.source_id)

    async def search_collection(self, collection: str, query: str, limit: int = 10) -> list[dict]:
        hits = await self._dense(collection, query, limit)
        return [{"sourceId": h.source_id, "title": h.title, "score": h.score, "metadata": h.metadata}
                for h in hits]

    def document(self, doc_id: str) -> Optional[dict]:
        chunk = self._by_id.get(doc_id) or next(
            (c for c in self.docs if c.source_id == doc_id), None,
        )
        if chunk is None:
            return None
        parts = [c.text for c in self.docs if c.source_id == chunk.source_id]
        return {"id": chunk.id, "sourceId": chunk.source_id, "title": chunk.title,
                "heading": chunk.heading, "url": chunk.url, "text": "\n\n".join(parts)}

    async def _external_sources(self, persona: str) -> list[ExternalMcpSource]:
        async with session_scope() as session:
            rows = (await session.execute(
                select(AiKnowledgeSourceORM).where(AiKnowledgeSourceORM.enabled.is_(True))
            )).scalars().all()
        out = []
        for row in rows:
            personas = []
            try:
                import json

                personas = json.loads(row.personas or "[]")
            except ValueError:
                personas = ["help"]
            if persona not in personas:
                continue
            stamp = f"{row.id}:{row.updated_at}"
            held = self._external.get(row.id)
            if held is None or held[0] != stamp:
                try:
                    source = ExternalMcpSource(row, allow_hosts=self.config.egress_allowed_hosts)
                except Exception as exc:  # noqa: BLE001
                    logger.info("knowledge source %s cannot be built: %s", row.name, exc)
                    continue
                self._external[row.id] = (stamp, source)
            out.append(self._external[row.id][1])
        return out

    async def search_for_answer(self, query: str, *, caller: KnowledgeCaller, persona: str,
                                limit: int = 6) -> list[Hit]:
        sources: list[Any] = [self.product, *(await self._external_sources(persona))]
        rankings = await ask_all(sources, query, limit, caller)
        return fuse(*rankings, limit=limit, key=lambda h: f"{h.source}:{h.source_id}")

    # ── status ─────────────────────────────────────────────────────

    async def status(self) -> dict:
        collections = []
        embedder = None
        try:
            embedder = await self.embedder()
        except Exception:  # noqa: BLE001
            embedder = None
        for name in ("docs", "views"):
            entry: dict[str, Any] = {"name": name}
            report = self.indexer.reports.get(name) if self.indexer else None
            if self.store is None:
                entry["status"] = "lexical" if name == "docs" and self.docs else "disabled"
                entry["documents"] = len({c.source_id for c in self.docs}) if name == "docs" else 0
                entry["chunks"] = len(self.docs) if name == "docs" else 0
            else:
                try:
                    versions = await self.store.versions(name)
                except Exception as exc:  # noqa: BLE001
                    versions = []
                    entry["error"] = str(exc)[:200]
                active = next((v for v in versions if v.status == "active"), None)
                building = next((v for v in versions if v.status == "building"), None)
                if active:
                    entry.update({"version": active.version, "model": active.model,
                                  "dimensions": active.dimensions, "documents": active.documents,
                                  "chunks": active.chunks, "lastSyncAt": active.last_sync_at})
                entry["status"] = ("building" if building else "ready" if active else
                                   "failed" if any(v.status == "failed" for v in versions) else
                                   "lexical" if name == "docs" else "disabled")
                if name == "views" and not self.config.indexer_api_key:
                    entry["status"] = "disabled"
                    entry["error"] = "Set AI_INDEXER_API_KEY to a read-only service account's key."
                if embedder is None and entry["status"] not in ("ready", "building"):
                    entry["status"] = "lexical" if name == "docs" else "disabled"
            entry.update(status_of(report))
            collections.append(entry)
        return {"store": self.store.kind if self.store else "none",
                "embedding": {"model": embedder.model if embedder else None,
                              "available": bool(embedder and embedder.available)},
                "collections": collections}
