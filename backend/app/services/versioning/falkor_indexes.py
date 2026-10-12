"""Per-label ``urn`` indexes on a FalkorDB key the versioning layer writes.

The projector MERGEs every node as ``MERGE (n:<Label> {urn: …})`` and anchors every edge on
``MATCH (a:<Label> {urn: …})``. FalkorDB indexes are label-scoped, so without an index on
``(:Label).urn`` each of those is a scan of the whole label — per UNWIND row. On a graph the
platform did not mint, the reader's ``ensure_indices`` creates the indexes; on a key the
versioning layer writes itself (a brand-new data source seeded from a package, or the nodes a
duplicate collapse re-points) nothing did, and a 100k-node label turned a seed into an O(n²)
crawl that hit the per-query budget.

``ensure_urn_indexes`` is the one helper for that: idempotent ``CREATE INDEX`` per label,
optionally waiting until FalkorDB reports each index operational (an index still under
construction is not used by the planner, so a write issued right after the DDL would still
scan).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Iterable, List, Optional

logger = logging.getLogger(__name__)

# How long ``wait=True`` gives a fresh index to finish building before it gives up waiting
# (the index still builds; queries in the meantime are slower, never wrong).
_INDEX_WAIT_SECS = 300.0
_INDEX_POLL_SECS = 0.5
_DDL_TIMEOUT_MS = 60_000


def _label(s: str) -> str:
    """The label as the projector writes it (``falkordb_provider._sanitize_label``)."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


def urn_index_ddl(labels: Iterable[str]) -> List[str]:
    """``CREATE INDEX FOR (n:<Label>) ON (n.urn)`` per distinct label, in first-seen order."""
    seen: set = set()
    out: List[str] = []
    for raw in labels:
        lbl = _label(raw)
        if lbl and lbl not in seen:
            seen.add(lbl)
            out.append(f"CREATE INDEX FOR (n:{lbl}) ON (n.urn)")
    return out


async def _query(client, cypher: str, *, read_only: bool = False):
    # Through the versioning layer's one seam to FalkorDB (``projection._q``), so the DDL gets its
    # server budget, the cluster window's write clamp and the client-side hang net like every
    # other statement. Imported here because ``projection`` imports this module.
    from .projection import _q
    return await _q(client, cypher, timeout_ms=_DDL_TIMEOUT_MS, read_only=read_only)


def _building_labels(rows, labels: set) -> set:
    """The labels among ``labels`` whose urn index ``CALL db.indexes()`` lists as still being
    built, or does not list at all. Version-tolerant: a cell scan, since column order varies
    between FalkorDB builds (the same reading as ``falkordb_materialize._agg_index_state``)."""
    ready: set = set()
    building: set = set()
    for row in rows or []:
        cells = [c for c in (row or []) if c is not None]
        text = [str(c) for c in cells]
        props = next((c for c in cells if isinstance(c, (list, tuple))), None)
        if props is not None and "urn" not in [str(p) for p in props]:
            continue
        if props is None and not any(t == "urn" for t in text):
            continue
        label = next((t for t in text if t in labels), None)
        if label is None:
            continue
        if any("UNDER CONSTRUCTION" in t.upper() for t in text):
            building.add(label)
        else:
            ready.add(label)
    return (labels - ready) | building


async def ensure_urn_indexes(client, labels: Iterable[str], *, strict: bool = False,
                             wait: bool = False, wait_secs: Optional[float] = None) -> List[str]:
    """Create the urn index of every label in ``labels`` on ``client``'s graph (a no-op for one
    that exists). ``wait`` polls ``CALL db.indexes()`` until each reports operational, for up to
    ``wait_secs`` (default 5 minutes). Best effort unless ``strict``: a refused statement is
    logged and skipped; with ``strict`` it raises, for a job that must not write unindexed.
    Returns the statements issued."""
    statements = urn_index_ddl(labels)
    for cypher in statements:
        try:
            await _query(client, cypher)
        except Exception as exc:  # noqa: BLE001 — "already indexed" is success; the rest per strict
            if "already indexed" in str(exc).lower():
                continue
            if strict:
                raise
            logger.warning("urn index not created (%s): %s", cypher, exc)
    if wait and statements:
        want = {_label(lbl) for lbl in labels if _label(lbl)}
        deadline = time.monotonic() + (wait_secs if wait_secs is not None else _INDEX_WAIT_SECS)
        while want:
            try:
                res = await _query(client, "CALL db.indexes()", read_only=True)
                want = _building_labels(getattr(res, "result_set", None), want)
            except Exception as exc:  # noqa: BLE001 — cannot see the catalogue: stop waiting
                logger.info("cannot read the index catalogue to wait on it: %s", exc)
                break
            if not want or time.monotonic() >= deadline:
                break
            await asyncio.sleep(_INDEX_POLL_SECS)
        if want:
            logger.warning("urn indexes still building after the wait: %s", sorted(want))
    return statements
