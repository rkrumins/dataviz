"""Where the cluster's nodes were last seen, so a cold process can find it.

A provider's ``startupNodes`` are the masters as they were the day someone
wrote the connection down. Masters move — a failover promotes a replica — and
the list does not follow. Nothing breaks while it drifts, because a running
process seeds from the nodes its last sweep found. The list matters in exactly
one moment: a process starting COLD, which is every process after a deploy or
an eviction. If none of those addresses answers then, a healthy cluster reads
as unreachable.

This is that memory, outside the process. Three things it has to get right:

**Any node will do.** ``CLUSTER NODES`` is answered by masters and replicas
alike, so a promoted replica is as good a seed as the master it replaced. Role
is stored to ORDER the list, never to filter it — filtering to "nodes that were
masters" is precisely the bug being fixed.

**A node that comes back is the same node.** With masters and replicas pinned
to static nodes, an address that goes away for maintenance comes back
unchanged. So an address is not forgotten because it failed to answer; it
sorts below the ones that did, and returns to the front the moment it answers
again.

**Remembering must not make discovery slower.** Seeds are tried in order until
one answers, each costing a connect budget, so an unbounded list of dead
addresses would turn a total outage into a very long wait. The list handed out
is capped, and the operator's configured seeds always keep their place in it.

The store is the shared bus Redis — deliberately NOT the FalkorDB being
described, which would make the memory unreadable in exactly the outage it
exists for. Every call is best-effort: a bus that is down costs the memory,
never the discovery.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

#: How long an address stands after the cluster last mentioned it. Generous by
#: design: with static allocation an address outlives any single outage, and
#: the cost of keeping a dead one is one connect attempt at the BACK of the
#: order. The cost of forgetting a live one is a cluster nobody can find.
SEED_TTL_S = 30 * 24 * 3600

#: The most remembered addresses handed to one discovery. Seeds are tried
#: serially until one answers, so this bounds what a total outage costs before
#: the configured seeds are reached. Nine covers a 3×2 cluster with room.
MAX_REMEMBERED = 9

#: What one memory read or write may cost. The memory is an OPTIMISATION —
#: without it discovery falls back to the configured seeds and works — so it
#: must never be able to slow a sweep down. Without this bound a bus that is
#: merely unreachable costs a full connect timeout per instance per sweep,
#: which is the exact shape of problem this module exists downstream of.
_BUDGET_S = 0.5

#: When the bus is down, stop asking for a while. Otherwise every instance in
#: every sweep pays the budget above to rediscover the same outage.
_COOLDOWN_S = 30.0
_unavailable_until: float = 0.0


async def _bounded(what: str, coro) -> Optional[Any]:
    """Run a memory operation under its budget, or give up quietly.

    A failure arms the cooldown: the next caller skips the bus entirely rather
    than paying to learn the same thing again.
    """
    global _unavailable_until
    try:
        async with asyncio.timeout(_BUDGET_S):
            return await coro
    except (TimeoutError, asyncio.TimeoutError):
        _unavailable_until = time.monotonic() + _COOLDOWN_S
        logger.debug("graph store seed memory: %s timed out; standing down", what)
    except Exception as exc:                    # noqa: BLE001 — best-effort
        _unavailable_until = time.monotonic() + _COOLDOWN_S
        logger.debug("graph store seed memory: %s failed (%s)", what, exc)
    return None


def _key(instance_id: str) -> str:
    return f"graphstore:seeds:{instance_id}"


async def _bus() -> Optional[Any]:
    """The shared bus Redis, or None. Never raises, never the graph store."""
    if time.monotonic() < _unavailable_until:
        return None
    try:
        from backend.app.services.aggregation.redis_client import get_redis

        return get_redis()
    except Exception as exc:                    # noqa: BLE001 — memory is optional
        logger.debug("graph store seed memory: no bus (%s)", exc)
        return None


async def remember(
    instance_id: str,
    nodes: Iterable[Tuple[str, str, bool]],
    *,
    client: Optional[Any] = None,
) -> None:
    """Record where this cluster's nodes are.

    ``nodes`` is ``(endpoint, role, answered)`` for every node the CLUSTER
    listed — not only the ones that answered. The cluster vouching for an
    address is itself evidence the address is real, and a node that is down
    right now is one that will be back; it simply sorts below the ones that
    spoke. ``answered`` is what separates them.
    """
    redis = client or await _bus()
    if redis is None:
        return
    # Float, not whole seconds: two sweeps inside one second are ordinary on
    # a busy fleet, and truncating them to the same instant loses the very
    # thing this timestamp is for — which of two nodes spoke MOST recently.
    now = time.time()
    payload: Dict[str, str] = {}
    for endpoint, role, answered in nodes:
        if not endpoint or ":" not in endpoint or endpoint.startswith(":"):
            continue                            # no address to dial later
        payload[endpoint] = json.dumps({
            "role": role,
            "seen": now,
            # Preserved across sweeps by the merge below: a node that has not
            # answered for a while keeps the last time it did, which is what
            # orders it against a node that never has.
            "ok": now if answered else 0,
        })
    if not payload:
        return
    existing = await _bounded("read-before-write", redis.hgetall(_key(instance_id)))
    if existing is not None:
        for endpoint, raw in (existing or {}).items():
            endpoint = _text(endpoint)
            if endpoint not in payload:
                continue
            was = _load(raw)
            if was and not json.loads(payload[endpoint])["ok"]:
                merged = json.loads(payload[endpoint])
                merged["ok"] = float(was.get("ok") or 0)
                payload[endpoint] = json.dumps(merged)
    await _bounded("write", redis.hset(_key(instance_id), mapping=payload))
    await _bounded("expire", redis.expire(_key(instance_id), SEED_TTL_S))


async def recall(
    instance_id: str, *, client: Optional[Any] = None,
) -> List[Tuple[str, int]]:
    """Addresses to try, best first, as ``(host, port)``.

    Ordered by what makes one most likely to answer NOW:

    1. Nodes that answered most recently — a node that spoke last sweep is the
       best bet this sweep.
    2. Among those, masters before replicas. Both answer ``CLUSTER NODES``
       equally well, so this is a preference and never a filter; a promoted
       replica must remain a usable seed or the whole exercise is pointless.
    3. Then everything else the cluster ever mentioned, so a node that is on
       its way back is still tried before giving up.
    """
    redis = client or await _bus()
    if redis is None:
        return []
    raw = await _bounded("read", redis.hgetall(_key(instance_id)))
    if raw is None:
        return []

    cutoff = time.time() - SEED_TTL_S
    rows: List[Tuple[float, int, str]] = []
    for endpoint, blob in (raw or {}).items():
        endpoint = _text(endpoint)
        entry = _load(blob)
        if entry is None or float(entry.get("seen") or 0) < cutoff:
            continue
        rows.append((
            -float(entry.get("ok") or 0),                   # answered recently
            0 if entry.get("role") == "master" else 1,      # a preference only
            endpoint,
        ))
    rows.sort()

    out: List[Tuple[str, int]] = []
    for _ok, _role, endpoint in rows[:MAX_REMEMBERED]:
        host, _, port = endpoint.rpartition(":")
        if host and port.isdigit():
            out.append((host, int(port)))
    return out


async def forget(instance_id: str, *, client: Optional[Any] = None) -> None:
    """Drop a store's memory — for a provider that has been deleted, or an
    operator who has genuinely rebuilt a cluster at new addresses."""
    redis = client or await _bus()
    if redis is None:
        return
    await _bounded("forget", redis.delete(_key(instance_id)))


def _text(value: Any) -> str:
    return value.decode() if isinstance(value, (bytes, bytearray)) else str(value)


def _load(blob: Any) -> Optional[Dict[str, Any]]:
    try:
        entry = json.loads(_text(blob))
        return entry if isinstance(entry, dict) else None
    except Exception:                           # noqa: BLE001 — a bad row is skipped
        return None
