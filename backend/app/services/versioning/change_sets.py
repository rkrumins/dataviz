"""Change lists built once and kept, for every process to read.

A change list's index (:class:`~.change_index.ChangeIndex`) and its containment tree
(:class:`~.change_index.ChangeTree`) cost O(changed entities) reads of version rows to build. Each
process used to build its own, on the first request that wanted one, and lose it on restart: a
deployment of four workers built every list four times, and a review's first open waited on it.
Here a built list is written to ``graphver.change_sets`` (compressed JSON) under a key naming
exactly what it is of — a draft at its head, a window of ``main`` between two revisions, the
containment types it was laid out by — and read back by any process. While one process builds a
list, the others asking for it wait for it (a Postgres advisory lock on its key) rather than build
it too.

Each revision of ``main`` is also kept as its own changes, with every entity as it was before and
after (:func:`dump_revision`): two revisions compared are composed from the revisions between
them, in memory, with no version row read again.

Best-effort throughout: a store that can't be read or written leaves the caller to build the list
itself, as before. What the store holds can always be built again; nothing else depends on it.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
import zlib
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from . import db
from .change_index import ChangeEntry, ChangeIndex, ChangeTree
from .models import ChangeSetORM, _now

logger = logging.getLogger(__name__)

#: The body's layout; a body of another is read as missing and built again.
FORMAT = 2
#: Bodies past this (compressed) are not kept: built again when asked for.
MAX_BODY = 48 * 1024 * 1024
#: The windows kept per graph (each with its tree); older ones are built again when asked for.
WINDOWS_KEPT = 64
#: How long a process waits for another's build of the same list before it builds it itself.
WAIT_S = 90.0

#: One entity a revision changed: ``[entity_id, kind, hash before, hash after, names after,
#: names before]`` — a hash None where it wasn't live; names ``[type, name, qname, urn, src, tgt]``
#: as that side has them, the names before only where they differ from after.
RevisionRow = List[Any]


def key_of(*parts: Any) -> str:
    """A stored list's key: a digest of what it is of."""
    return hashlib.sha256(repr(parts).encode()).hexdigest()


def _pack(doc: dict) -> bytes:
    return zlib.compress(json.dumps(doc, separators=(",", ":")).encode(), 1)


def _unpack(body: bytes) -> dict:
    doc = json.loads(zlib.decompress(body))
    if doc.get("v") != FORMAT:
        raise ValueError(f"change set format {doc.get('v')!r}")
    return doc


def dump_index(index: ChangeIndex) -> bytes:
    return _pack({
        "v": FORMAT, "entries": [list(e) for e in index.entries], "counts": index.counts,
        "entity_counts": index.entity_counts, "edge_counts": index.edge_counts,
        "structure_counts": index.structure_counts, "impact": index.impact, "by_type": index.by_type,
        "too_large": index.too_large, "window": index.window, "approximate": index.approximate,
        "end_urns": index.end_urns})


def load_index(body: bytes) -> ChangeIndex:
    doc = _unpack(body)
    index = ChangeIndex(
        [ChangeEntry(*e) for e in doc["entries"]], counts=doc["counts"],
        entity_counts=doc["entity_counts"], edge_counts=doc["edge_counts"],
        structure_counts=doc["structure_counts"], impact=doc["impact"], by_type=doc["by_type"],
        too_large=doc["too_large"], window=doc["window"], approximate=doc["approximate"])
    index.end_urns = doc["end_urns"]
    return index


def dump_tree(tree: ChangeTree) -> bytes:
    return _pack({"v": FORMAT, "parent_of": tree.parent_of,
                  "names": {k: list(v) for k, v in tree.names.items()}})


def load_tree(index: ChangeIndex, body: bytes) -> ChangeTree:
    doc = _unpack(body)
    return ChangeTree(index, doc["parent_of"], {k: tuple(v) for k, v in doc["names"].items()})


def dump_revision(rows: Sequence[RevisionRow]) -> bytes:
    """One revision's changes (:data:`RevisionRow` each)."""
    return _pack({"v": FORMAT, "rows": rows})


def load_revision(body: bytes) -> List[RevisionRow]:
    return _unpack(body)["rows"]


class ChangeSetStore:
    """``graphver.change_sets``, read and written in short sessions of their own."""

    async def get(self, graph_id: str, key: str) -> Optional[bytes]:
        return (await self.get_many(graph_id, [key])).get(key)

    async def get_many(self, graph_id: str, keys: Sequence[str]) -> Dict[str, bytes]:
        if not keys:
            return {}
        out: Dict[str, bytes] = {}
        try:
            async with db.graphver_session() as s:
                for i in range(0, len(keys), 1000):
                    out.update((await s.execute(select(ChangeSetORM.key, ChangeSetORM.body).where(
                        ChangeSetORM.graph_id == graph_id,
                        ChangeSetORM.key.in_(list(keys[i:i + 1000]))))).all())
        except Exception:  # noqa: BLE001 — a store that can't be read is a miss
            logger.warning("change sets of %s could not be read", graph_id, exc_info=True)
        return out

    async def put(self, graph_id: str, key: str, origin: str, body: bytes, size: int,
                  *, keep_prefix: Optional[str] = None) -> bool:
        """Keep ``body`` under ``key``. ``keep_prefix``: this is the newest of ``origin`` (a draft's
        version): the origin's other keys, not starting with it, go. A window keeps the newest
        :data:`WINDOWS_KEPT` of the graph's."""
        if len(body) > MAX_BODY:
            return False
        try:
            async with db.graphver_session() as s:
                await s.execute(pg_insert(ChangeSetORM).values(
                    graph_id=graph_id, key=key, origin=origin, built_at=_now(), size=size, body=body)
                    .on_conflict_do_update(index_elements=["graph_id", "key"],
                                           set_={"body": body, "size": size, "built_at": _now()}))
                if keep_prefix is not None:
                    await s.execute(delete(ChangeSetORM).where(
                        ChangeSetORM.graph_id == graph_id, ChangeSetORM.origin == origin,
                        ~ChangeSetORM.key.startswith(keep_prefix)))
                elif origin == "window":
                    newest = (select(ChangeSetORM.key).where(
                        ChangeSetORM.graph_id == graph_id, ChangeSetORM.origin == "window")
                        .order_by(ChangeSetORM.built_at.desc()).limit(WINDOWS_KEPT * 2))
                    await s.execute(delete(ChangeSetORM).where(
                        ChangeSetORM.graph_id == graph_id, ChangeSetORM.origin == "window",
                        ChangeSetORM.key.notin_(newest)))
            return True
        except Exception:  # noqa: BLE001 — not kept: built again when next asked for
            logger.warning("change set %s of %s could not be kept", key[:12], graph_id, exc_info=True)
            return False

    async def lock(self, key: str, wait: float = WAIT_S) -> Optional["_Lock"]:
        """Hold the build of ``key`` across processes: a session advisory lock on its digest, on a
        connection of its own, until :meth:`_Lock.release`. Another process holding it is waited
        for, up to ``wait`` seconds — then None, and the caller builds it alongside, as it does
        when the store can't lock at all."""
        lock_id = int.from_bytes(bytes.fromhex(key[:16]), "big", signed=True)
        conn = None
        try:
            conn = await db.get_engine().connect()
            deadline = time.monotonic() + wait
            while True:
                held = bool(await conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": lock_id}))
                await conn.commit()
                if held:
                    return _Lock(conn, lock_id)
                if time.monotonic() >= deadline:
                    break
                await asyncio.sleep(0.25)
        except Exception:  # noqa: BLE001 — no lock: the caller builds it, as before
            logger.warning("change set lock %s unavailable", key[:12], exc_info=True)
        if conn is not None:
            await _Lock(conn, None).release()
        return None


class _Lock:
    def __init__(self, conn, lock_id: Optional[int]):
        self._conn, self._id = conn, lock_id

    async def release(self) -> None:
        conn, self._conn = self._conn, None
        if conn is None:
            return
        try:
            if self._id is not None:
                await asyncio.shield(conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": self._id}))
                await asyncio.shield(conn.commit())
            await asyncio.shield(conn.close())
        except BaseException:  # noqa: BLE001 — a connection that can't be unlocked is dropped, its lock with it
            with contextlib.suppress(Exception):
                await conn.invalidate()
                await conn.close()


async def shared(store: ChangeSetStore, graph_id: str, key: str, origin: str, *, build, dump, load,
                 size_of, keep_prefix: Optional[str] = None):
    """What ``key`` names: read from the store, else built once (``build()``, awaited) by whichever
    process gets there first while the others wait for it, and kept. ``dump``/``load`` turn it to
    and from a body; ``size_of`` counts its entries. The caller has it as soon as it is built; it
    is written after, still under the lock, so whoever asks meanwhile waits for the write."""
    body = await store.get(graph_id, key)
    if body is not None:
        try:
            return await asyncio.to_thread(load, body)
        except Exception:  # noqa: BLE001 — unreadable (another format): built again
            logger.info("change set %s of %s unreadable; building it again", key[:12], graph_id)
    held = await store.lock(key)
    try:
        if held is not None:
            body = await store.get(graph_id, key)       # built while this one waited
            if body is not None:
                with contextlib.suppress(Exception):
                    return await asyncio.to_thread(load, body)
        built = await build()
    except BaseException:
        if held is not None:
            await held.release()
        raise
    if built is None:                                   # nothing to keep (too large, say)
        if held is not None:
            await held.release()
        return built
    task = asyncio.ensure_future(_keep(store, held, graph_id, key, origin, built, dump, size_of(built),
                                       keep_prefix))
    _WRITING.add(task)
    task.add_done_callback(_WRITING.discard)
    return built


async def _keep(store: ChangeSetStore, held: Optional[_Lock], graph_id: str, key: str, origin: str,
                built, dump, size: int, keep_prefix: Optional[str]) -> None:
    try:
        try:
            body = await asyncio.to_thread(dump, built)
        except Exception:  # noqa: BLE001 — kept in this process only
            logger.warning("change set %s of %s could not be written", key[:12], graph_id, exc_info=True)
            return
        await store.put(graph_id, key, origin, body, size, keep_prefix=keep_prefix)
    finally:
        if held is not None:
            await held.release()


#: Writes not yet done in this process (:func:`settled` waits for them).
_WRITING: set = set()


async def settled() -> None:
    """Every write this process has started, done — for tests, and for a worker about to exit."""
    while _WRITING:
        await asyncio.gather(*list(_WRITING), return_exceptions=True)


STORE = ChangeSetStore()
