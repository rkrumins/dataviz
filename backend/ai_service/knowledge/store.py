"""Where embeddings live: the ``VectorStore`` port, pgvector, and an in-memory one.

**Versioned collections.** A collection (``docs``, ``views``) has versions,
each tied to one embedding model, dimension and chunker. Syncing reuses the
active version while those match, re-embedding only chunks whose content
changed. A change of model builds a new version beside the active one; when
it is complete it becomes active in one statement and the old one is
retired — queries never see a half-built index (blue/green).

**pgvector.** One ``kb_chunks`` table holds every version, ``embedding`` as a
``halfvec`` of any dimension; each version gets its own partial HNSW index
on ``embedding::halfvec(D)`` (cosine), built when the version is, dropped
when it is retired. Every query names its collection and version, which the
partial index matches. A ``tsvector`` beside each chunk serves full-text
search for collections too large to hold in memory.

The store holds ids, text and metadata needed to rank — never an access
decision: whatever it returns is checked again, as the person asking,
before anyone sees it.
"""
from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Protocol

from .corpus import Chunk

logger = logging.getLogger(__name__)


@dataclass
class VersionInfo:
    collection: str
    version: int
    model: str
    dimensions: int
    chunker: str
    status: str                  # building | active | retired | failed
    documents: int = 0
    chunks: int = 0
    cursor: Optional[str] = None
    last_sync_at: Optional[str] = None
    error: Optional[str] = None


@dataclass
class StoredHit:
    chunk_id: str
    source_id: str
    title: str
    heading: str
    url: str
    text: str
    score: float
    metadata: dict = field(default_factory=dict)


class VectorStore(Protocol):
    kind: str

    async def ensure_schema(self) -> None: ...
    async def version_for(self, collection: str, *, model: str, dimensions: int, chunker: str) -> VersionInfo: ...
    async def active(self, collection: str) -> Optional[VersionInfo]: ...
    async def versions(self, collection: str) -> list[VersionInfo]: ...
    async def hashes(self, collection: str, version: int) -> dict[str, str]: ...
    async def upsert(self, collection: str, version: int, source_id: str, content_hash: str,
                     chunks: list[tuple[Chunk, list[float]]], metadata: dict) -> None: ...
    async def delete(self, collection: str, version: int, source_ids: list[str]) -> None: ...
    async def finish(self, collection: str, version: int, *, cursor: Optional[str] = None) -> None: ...
    async def fail(self, collection: str, version: int, error: str) -> None: ...
    async def search(self, collection: str, version: int, dimensions: int, vector: list[float],
                     limit: int) -> list[StoredHit]: ...
    async def try_lock(self, name: str): ...
    async def close(self) -> None: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


class _NoLock:
    async def __aenter__(self):
        return True

    async def __aexit__(self, *exc):
        return False


# ── In memory (tests; and nothing at all to run) ────────────────────────


class MemoryVectorStore:
    kind = "memory"

    def __init__(self) -> None:
        self._versions: dict[tuple[str, int], VersionInfo] = {}
        self._docs: dict[tuple[str, int, str], tuple[str, dict]] = {}
        self._chunks: dict[tuple[str, int], dict[str, tuple[Chunk, list[float]]]] = {}

    async def ensure_schema(self) -> None:
        return None

    async def versions(self, collection: str) -> list[VersionInfo]:
        return sorted((v for (c, _), v in self._versions.items() if c == collection),
                      key=lambda v: v.version)

    async def active(self, collection: str) -> Optional[VersionInfo]:
        return next((v for v in await self.versions(collection) if v.status == "active"), None)

    async def version_for(self, collection, *, model, dimensions, chunker) -> VersionInfo:
        for v in reversed(await self.versions(collection)):
            if v.status in ("active", "building") and (v.model, v.dimensions, v.chunker) == (model, dimensions, chunker):
                return v
        number = max([v.version for v in await self.versions(collection)] or [0]) + 1
        info = VersionInfo(collection, number, model, dimensions, chunker, "building")
        self._versions[(collection, number)] = info
        self._chunks[(collection, number)] = {}
        return info

    async def hashes(self, collection, version) -> dict[str, str]:
        return {sid: h for (c, v, sid), (h, _) in self._docs.items() if c == collection and v == version}

    async def upsert(self, collection, version, source_id, content_hash, chunks, metadata) -> None:
        bucket = self._chunks.setdefault((collection, version), {})
        for cid in [cid for cid, (c, _) in bucket.items() if c.source_id == source_id]:
            del bucket[cid]
        for chunk, vector in chunks:
            bucket[chunk.id] = (chunk, vector)
        self._docs[(collection, version, source_id)] = (content_hash, metadata)

    async def delete(self, collection, version, source_ids) -> None:
        bucket = self._chunks.get((collection, version), {})
        drop = set(source_ids)
        for cid in [cid for cid, (c, _) in bucket.items() if c.source_id in drop]:
            del bucket[cid]
        for sid in drop:
            self._docs.pop((collection, version, sid), None)

    async def finish(self, collection, version, *, cursor=None) -> None:
        info = self._versions[(collection, version)]
        for other in await self.versions(collection):
            if other.version != version and other.status == "active":
                other.status = "retired"
                self._chunks.pop((collection, other.version), None)
        info.status = "active"
        info.cursor = cursor if cursor is not None else info.cursor
        info.last_sync_at = _now()
        info.documents = len(await self.hashes(collection, version))
        info.chunks = len(self._chunks.get((collection, version), {}))

    async def fail(self, collection, version, error) -> None:
        info = self._versions.get((collection, version))
        if info and info.status == "building":
            info.status = "failed"
            info.error = error[:500]

    async def search(self, collection, version, dimensions, vector, limit) -> list[StoredHit]:
        bucket = self._chunks.get((collection, version), {})
        ranked = sorted(bucket.values(), key=lambda cv: -_cosine(cv[1], vector))[:limit]
        return [StoredHit(c.id, c.source_id, c.title, c.heading, c.url, c.text,
                          _cosine(v, vector), c.metadata) for c, v in ranked]

    def try_lock(self, name: str):
        return _NoLock()

    async def close(self) -> None:
        return None


# ── pgvector ────────────────────────────────────────────────────────────

SCHEMA_VERSION = 1

DDL = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    """CREATE TABLE IF NOT EXISTS kb_schema_version (
        version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS kb_collection_versions (
        collection TEXT NOT NULL, version INTEGER NOT NULL,
        model TEXT NOT NULL, dimensions INTEGER NOT NULL, chunker TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'building',
        documents INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0,
        sync_cursor TEXT, error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), activated_at TIMESTAMPTZ,
        last_sync_at TIMESTAMPTZ,
        PRIMARY KEY (collection, version))""",
    """CREATE UNIQUE INDEX IF NOT EXISTS kb_one_active_version
        ON kb_collection_versions (collection) WHERE status = 'active'""",
    """CREATE TABLE IF NOT EXISTS kb_documents (
        collection TEXT NOT NULL, version INTEGER NOT NULL, source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, version, source_id))""",
    """CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT NOT NULL, collection TEXT NOT NULL, version INTEGER NOT NULL,
        source_id TEXT NOT NULL, ord INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '', heading TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        embedding halfvec,
        tsv tsvector GENERATED ALWAYS AS (
            to_tsvector('english', coalesce(title, '') || ' ' || coalesce(heading, '') || ' ' || body)
        ) STORED,
        PRIMARY KEY (collection, version, id))""",
    "CREATE INDEX IF NOT EXISTS kb_chunks_source ON kb_chunks (collection, version, source_id)",
    "CREATE INDEX IF NOT EXISTS kb_chunks_tsv ON kb_chunks USING gin (tsv)",
]


def _dsn(url: str) -> str:
    return re.sub(r"^postgresql\+asyncpg://", "postgresql://", url.strip())


def _vec(vector: list[float]) -> str:
    return "[" + ",".join(f"{x:.6g}" for x in vector) + "]"


_COLLECTION_NAME = re.compile(r"[a-z][a-z0-9_]{0,31}")


def _index_name(collection: str, version: int) -> str:
    return f"kb_hnsw_{re.sub(r'[^a-z0-9]', '_', collection.lower())}_{int(version)}"


class PgVectorStore:
    kind = "pgvector"

    def __init__(self, url: str) -> None:
        self._dsn = _dsn(url)
        self._pool = None

    async def _get_pool(self):
        if self._pool is None:
            import asyncpg

            self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=4,
                                                   command_timeout=60)
        return self._pool

    async def ensure_schema(self) -> None:
        pool = await self._get_pool()
        async with pool.acquire() as conn:
            for statement in DDL:
                await conn.execute(statement)
            await conn.execute(
                "INSERT INTO kb_schema_version (version) VALUES ($1) ON CONFLICT DO NOTHING",
                SCHEMA_VERSION,
            )

    @staticmethod
    def _info(row) -> VersionInfo:
        return VersionInfo(
            collection=row["collection"], version=row["version"], model=row["model"],
            dimensions=row["dimensions"], chunker=row["chunker"], status=row["status"],
            documents=row["documents"], chunks=row["chunks"], cursor=row["sync_cursor"],
            last_sync_at=row["last_sync_at"].isoformat() if row["last_sync_at"] else None,
            error=row["error"],
        )

    async def versions(self, collection: str) -> list[VersionInfo]:
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT * FROM kb_collection_versions WHERE collection = $1 ORDER BY version", collection,
        )
        return [self._info(r) for r in rows]

    async def active(self, collection: str) -> Optional[VersionInfo]:
        return next((v for v in await self.versions(collection) if v.status == "active"), None)

    async def version_for(self, collection, *, model, dimensions, chunker) -> VersionInfo:
        if not _COLLECTION_NAME.fullmatch(collection):
            raise ValueError(f"{collection!r} is not a collection name")  # it is written into DDL
        pool = await self._get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT * FROM kb_collection_versions WHERE collection = $1
                   AND status IN ('active', 'building') AND model = $2 AND dimensions = $3
                   AND chunker = $4 ORDER BY version DESC LIMIT 1""",
                collection, model, dimensions, chunker,
            )
            if row is not None:
                return self._info(row)
            row = await conn.fetchrow(
                """INSERT INTO kb_collection_versions (collection, version, model, dimensions, chunker)
                   VALUES ($1, COALESCE((SELECT max(version) FROM kb_collection_versions
                                         WHERE collection = $1), 0) + 1, $2, $3, $4)
                   RETURNING *""",
                collection, model, dimensions, chunker,
            )
            # Each version's own partial index, matching what its queries name.
            await conn.execute(
                f"CREATE INDEX IF NOT EXISTS {_index_name(collection, row['version'])} ON kb_chunks "
                f"USING hnsw ((embedding::halfvec({int(dimensions)})) halfvec_cosine_ops) "
                f"WITH (m = 16, ef_construction = 64) "
                f"WHERE collection = '{collection}' AND version = {int(row['version'])}"
            )
            return self._info(row)

    async def hashes(self, collection, version) -> dict[str, str]:
        pool = await self._get_pool()
        rows = await pool.fetch(
            "SELECT source_id, content_hash FROM kb_documents WHERE collection = $1 AND version = $2",
            collection, version,
        )
        return {r["source_id"]: r["content_hash"] for r in rows}

    async def upsert(self, collection, version, source_id, content_hash, chunks, metadata) -> None:
        pool = await self._get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM kb_chunks WHERE collection = $1 AND version = $2 AND source_id = $3",
                collection, version, source_id,
            )
            await conn.executemany(
                """INSERT INTO kb_chunks (id, collection, version, source_id, ord, title, heading,
                                          url, body, metadata, embedding)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::halfvec)""",
                [(c.id, collection, version, source_id, c.ord, c.title, c.heading, c.url, c.text,
                  json.dumps(c.metadata), _vec(v)) for c, v in chunks],
            )
            await conn.execute(
                """INSERT INTO kb_documents (collection, version, source_id, content_hash, metadata)
                   VALUES ($1, $2, $3, $4, $5::jsonb)
                   ON CONFLICT (collection, version, source_id)
                   DO UPDATE SET content_hash = EXCLUDED.content_hash, metadata = EXCLUDED.metadata,
                                 updated_at = now()""",
                collection, version, source_id, content_hash, json.dumps(metadata),
            )

    async def delete(self, collection, version, source_ids) -> None:
        if not source_ids:
            return
        pool = await self._get_pool()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM kb_chunks WHERE collection = $1 AND version = $2 AND source_id = ANY($3)",
                collection, version, list(source_ids),
            )
            await conn.execute(
                "DELETE FROM kb_documents WHERE collection = $1 AND version = $2 AND source_id = ANY($3)",
                collection, version, list(source_ids),
            )

    async def finish(self, collection, version, *, cursor=None) -> None:
        pool = await self._get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                retired = await conn.fetch(
                    """UPDATE kb_collection_versions SET status = 'retired'
                       WHERE collection = $1 AND status = 'active' AND version <> $2
                       RETURNING version""", collection, version,
                )
                await conn.execute(
                    """UPDATE kb_collection_versions SET status = 'active',
                         activated_at = COALESCE(activated_at, now()), last_sync_at = now(),
                         sync_cursor = COALESCE($3, sync_cursor), error = NULL,
                         documents = (SELECT count(*) FROM kb_documents d
                                      WHERE d.collection = $1 AND d.version = $2),
                         chunks = (SELECT count(*) FROM kb_chunks c
                                   WHERE c.collection = $1 AND c.version = $2)
                       WHERE collection = $1 AND version = $2""",
                    collection, version, cursor,
                )
            for row in retired:
                old = row["version"]
                await conn.execute("DELETE FROM kb_chunks WHERE collection = $1 AND version = $2", collection, old)
                await conn.execute("DELETE FROM kb_documents WHERE collection = $1 AND version = $2", collection, old)
                await conn.execute(f"DROP INDEX IF EXISTS {_index_name(collection, old)}")

    async def fail(self, collection, version, error) -> None:
        pool = await self._get_pool()
        await pool.execute(
            """UPDATE kb_collection_versions SET status = CASE WHEN status = 'building'
                 THEN 'failed' ELSE status END, error = $3
               WHERE collection = $1 AND version = $2""", collection, version, error[:500],
        )

    async def search(self, collection, version, dimensions, vector, limit) -> list[StoredHit]:
        pool = await self._get_pool()
        dims = int(dimensions)
        async with pool.acquire() as conn, conn.transaction():
            for setting in ("SET LOCAL hnsw.ef_search = 80", "SET LOCAL hnsw.iterative_scan = relaxed_order"):
                try:
                    async with conn.transaction():
                        await conn.execute(setting)
                except Exception:  # noqa: BLE001 — older pgvector: the default applies
                    pass
            rows = await conn.fetch(
                f"""SELECT id, source_id, title, heading, url, body, metadata,
                           1 - (embedding::halfvec({dims}) <=> $3::halfvec({dims})) AS score
                    FROM kb_chunks WHERE collection = $1 AND version = $2
                    ORDER BY embedding::halfvec({dims}) <=> $3::halfvec({dims}) LIMIT $4""",
                collection, version, _vec(vector), int(limit),
            )
        return [StoredHit(r["id"], r["source_id"], r["title"], r["heading"], r["url"], r["body"],
                          float(r["score"]), json.loads(r["metadata"]) if isinstance(r["metadata"], str)
                          else dict(r["metadata"] or {})) for r in rows]

    def try_lock(self, name: str):
        return _AdvisoryLock(self, name)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None


class _AdvisoryLock:
    """One indexer per collection across every replica: a session advisory
    lock, held for the sync and released after. Not acquired → skip."""

    def __init__(self, store: PgVectorStore, name: str) -> None:
        self._store, self._name, self._conn = store, name, None

    async def __aenter__(self) -> bool:
        pool = await self._store._get_pool()
        self._conn = await pool.acquire()
        got = await self._conn.fetchval("SELECT pg_try_advisory_lock(hashtext($1))", f"kb:{self._name}")
        if not got:
            await pool.release(self._conn)
            self._conn = None
        return bool(got)

    async def __aexit__(self, *exc) -> bool:
        if self._conn is not None:
            try:
                await self._conn.execute("SELECT pg_advisory_unlock(hashtext($1))", f"kb:{self._name}")
            finally:
                await (await self._store._get_pool()).release(self._conn)
        return False


def build_store(url: str) -> Optional[VectorStore]:
    return PgVectorStore(url) if url else None
