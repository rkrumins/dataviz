"""KeyMigration (doc 14 §6), phase 1: a versioned graph's projection moves only between keys the
platform owns.

A platform key names its graph — ``gvp_<graphId>{<gid8>.<n>}``, the braces a cluster hash tag — so
no data source can bind it and no other graph can claim it. The swap itself is
``GraphVersioningService.move_projection``; the old key waits in ``projection_state.retired_keys``
until :func:`retire_moved_keys` drops it. Phase 1 is a reseed move: doc 14 L2 adds ``place``,
``seed_stream``, ``catchup``, ``parity`` and ``swap`` (blue/green, with no Postgres-read window).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Awaitable, Callable, Dict, List, Optional

from sqlalchemy import func, null, select, update

from . import config, db
from .models import GraphORM, ProjectionStateORM

logger = logging.getLogger(__name__)


def owned_key(graph_id: str, n: int) -> str:
    """The ``n``-th platform key of ``graph_id``. Graph ids are ``graph_<ULID>``, so the tag is
    the ULID's random tail."""
    return f"gvp_{graph_id}{{{graph_id[-8:].lower()}.{n}}}"


def is_owned_key(graph_id: str, name: str) -> bool:
    """True when ``name`` is one of ``graph_id``'s platform keys (doc 14's
    ``^gvp_<gid>\\{[0-9a-z]{8}\\.\\d+\\}$``)."""
    return re.fullmatch(rf"gvp_{re.escape(graph_id)}\{{[0-9a-z]{{8}}\.\d+\}}", name) is not None


async def retire_moved_keys(
        projector, *, key_in_use: Optional[Callable[..., Awaitable[List[dict]]]] = None,
        now: Optional[str] = None) -> List[Dict[str, object]]:
    """Drop each old key a move left in ``retired_keys`` whose time has come: its grace period
    (``retireAfter``) has passed and the graph's current key has caught up to the head at the move
    (``afterSeq``), so reads have long left the old one. Until then a move back onto it is cheap.

    Under the graph's projection lock (``gvproj``, a try-lock: a pass or an evict holding it means
    the next run), so no pass writes a key as it is dropped. A key is dropped only when no graph
    pins it, no other data source or catalog entry reads it (``key_in_use``, by default
    :func:`purge_worker.graph_key_readers`; the graph's own data source is left out) and it holds
    the projector's pass marker; otherwise it is kept and its entry goes (PROTECTED). A key already
    gone counts as dropped. When its readers or its marker cannot be read, or the drop fails, the
    entry stays for the next run. Returns ``[{graphId, key, provider, verdict}]`` for each entry
    that went."""
    if key_in_use is None:
        from .purge_worker import graph_key_readers as key_in_use
    now = now or datetime.now(timezone.utc).isoformat()
    session = projector._session
    async with session() as s:
        rows = (await s.execute(
            select(ProjectionStateORM.graph_id, GraphORM.data_source_id,
                   ProjectionStateORM.projected_commit_seq, ProjectionStateORM.retired_keys)
            .join(GraphORM, GraphORM.id == ProjectionStateORM.graph_id)
            .where(ProjectionStateORM.retired_keys.isnot(None))
        )).all()
    out: List[Dict[str, object]] = []
    for gid, ds_id, projected, entries in rows:
        due = [e for e in entries or []
               if e["retireAfter"] <= now and projected >= e["afterSeq"]]
        if not due:
            continue
        lock_scope = (db.graphver_lock_session() if session is db.graphver_session
                      else session())
        lock_s = await lock_scope.__aenter__()
        lock_arg = func.hashtext(f"gvproj:{gid}")
        acquired = False
        try:
            acquired = bool(await lock_s.scalar(select(func.pg_try_advisory_lock(lock_arg))))
            if not acquired:
                continue
            for entry in due:
                verdict = await _retire(projector, entry, ds_id, key_in_use)
                if verdict is None:
                    continue
                await _forget(session, gid, entry)
                logger.warning("retired key %s of graph %s on provider %s: %s",
                               entry["name"], gid, entry.get("provider"), verdict)
                out.append({"graphId": gid, "key": entry["name"],
                            "provider": entry.get("provider"), "verdict": verdict})
        finally:
            try:
                if acquired:
                    await lock_s.execute(select(func.pg_advisory_unlock(lock_arg)))
            finally:
                await lock_scope.__aexit__(None, None, None)
    return out


async def _retire(projector, entry: dict, ds_id: Optional[str], key_in_use) -> Optional[str]:
    """Drop one retired key if it may go, and say what became of it; None keeps its entry."""
    from backend.app.providers.falkordb_provider import _is_missing_graph_error

    from .projection import read_projection_marker

    name, provider = entry["name"], entry.get("provider")
    default = config.DEFAULT_FALKOR_PROVIDER
    ps = ProjectionStateORM
    async with projector._session() as s:
        pinned = await s.scalar(select(ps.graph_id).where(
            func.coalesce(func.nullif(ps.falkor_provider, ""), default) == (provider or default),
            ps.falkor_graph_name == name).limit(1))
    if pinned is not None:
        return f"PROTECTED: graph {pinned} projects into '{name}'"
    try:
        readers = await key_in_use(provider, name, ds_id)
    except Exception:                                   # noqa: BLE001 — fail closed
        logger.warning("retire: could not ask who reads '%s'; kept", name, exc_info=True)
        return None
    if readers:
        return (f"PROTECTED: '{name}' is read by {len(readers)} data source(s) or "
                "catalog entr(ies)")
    try:
        exists, seq = await read_projection_marker(await projector._graph_client(name, provider))
    except Exception:                                   # noqa: BLE001 — unreachable is not lost
        logger.warning("retire: could not read the marker of '%s'; kept", name, exc_info=True)
        return None
    if exists is False:
        return "gone"
    if exists is None:                                  # a client that cannot tell
        return None
    if seq is None:
        return f"PROTECTED: '{name}' holds no projection marker of ours"
    try:
        await projector.drop_graph(name, provider)
    except Exception as exc:                            # noqa: BLE001
        if not _is_missing_graph_error(exc):
            logger.warning("retire: dropping '%s' failed; kept", name, exc_info=True)
            return None
    return "dropped"


async def _forget(session, graph_id: str, entry: dict) -> None:
    """Take ``entry`` off the graph's ``retired_keys`` (SQL NULL once none is left)."""
    async with session() as s:
        ps = (await s.execute(
            select(ProjectionStateORM).where(ProjectionStateORM.graph_id == graph_id)
            .with_for_update().execution_options(populate_existing=True)
        )).scalar_one_or_none()
        if ps is None:
            return
        left = [e for e in ps.retired_keys or [] if e != entry]
        await s.execute(update(ProjectionStateORM)
                        .where(ProjectionStateORM.graph_id == graph_id)
                        .values(retired_keys=left or null())
                        .execution_options(synchronize_session=False))
