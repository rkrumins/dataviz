"""A search session: one search's progress, shared by every request for it.

A session is driven by the requests that ask for it — no background worker.
Each request takes the session's lease, runs the units still pending until
its wait is spent, commits what it found and answers with it. So:

* cancelling is free: a client that stops asking stops the work within one
  unit;
* identical searches share the work: a request that finds the lease held
  waits for the holder's commit and answers with that;
* a crash loses at most one request's worth: the lease expires and the next
  request carries on from the last commit;
* any process can continue any session, because the state is in Redis. With
  no Redis (quickstart, tests) it lives in this process.

The state is small: the plan still to run, the running count, and the first
``k`` rows in order — the rows are sort keys ending in the urn, never node
IDs, so they stay meaningful to hydrate whatever happened to the IDs.

A search that asked for the ``ancestor`` facet also keeps a tally beside the
session: for every containment ancestor of a match, how many matches it
holds, per entity type. It grows with each commit, in the same transaction,
so each unit is counted exactly once; the facet is its fullest entries, and
any one container's count is a lookup.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from redis.exceptions import WatchError

from backend.app.providers.falkordb_search.plan import Plan, Unit

logger = logging.getLogger(__name__)

RUNNING, COMPLETE, FAILED = "running", "complete", "failed"


@dataclass
class Session:
    sid: str
    query_id: str                     # the query it answers (``query_identity``)
    data_version: str                 # the data it started on
    after: Optional[List[Any]]        # a later page: rows strictly after these keys
    k: int                            # rows kept, in order
    pending: List[Unit]               # units still to run
    clamps: List[List[int]]
    total: int                        # estimated nodes across every unit
    scanned: int = 0                  # estimated nodes in the units done
    count: int = 0                    # matches in the units done (exact)
    rows: List[List[Any]] = field(default_factory=list)
    status: str = RUNNING
    error: Optional[str] = None
    notes: List[str] = field(default_factory=list)
    created: float = field(default_factory=time.time)
    scope_hash: str = ""              # the resolved view scope it was planned for

    @classmethod
    def start(cls, sid: str, query_id: str, data_version: str,
              after: Optional[List[Any]], k: int, plan: Plan,
              scope_hash: str = "") -> "Session":
        session = cls(sid, query_id, data_version, after, k, list(plan.units),
                      list(plan.clamps), sum(u.size for u in plan.units),
                      notes=list(plan.notes), scope_hash=scope_hash)
        if not session.pending:
            session.status = COMPLETE
        return session

    def adopt(self, other: "Session") -> None:
        """Become ``other`` — a later commit of this same session — in
        place, so whatever holds this object sees it."""
        self.__dict__.update(other.__dict__)

    def to_json(self) -> str:
        return json.dumps({
            "sid": self.sid, "q": self.query_id, "dv": self.data_version,
            "after": self.after, "k": self.k,
            "pending": [u.to_dict() for u in self.pending], "clamps": self.clamps,
            "total": self.total, "scanned": self.scanned, "count": self.count,
            "rows": self.rows, "status": self.status, "error": self.error,
            "notes": self.notes, "created": self.created, "sh": self.scope_hash,
        }, separators=(",", ":"))

    @classmethod
    def from_json(cls, raw: Any) -> Optional["Session"]:
        """The session, or None for anything this build can't read (a shape
        change deployed inside the TTL is a restart, not a 500)."""
        try:
            d = json.loads(raw)
            return cls(
                d["sid"], d["q"], d["dv"], d.get("after"), int(d["k"]),
                [Unit.from_dict(u) for u in d["pending"]],
                [list(c) for c in d.get("clamps") or []],
                int(d["total"]), int(d["scanned"]), int(d["count"]),
                [list(r) for r in d.get("rows") or []], d["status"], d.get("error"),
                list(d.get("notes") or []), float(d.get("created") or 0.0),
                str(d.get("sh") or ""),
            )
        except Exception as exc:                     # noqa: BLE001 — a miss, not an error
            logger.debug("search session unreadable: %r", exc)
            return None


# A tally entry: [matches held, displayName, label, {entity type: matches}].
Tally = List[Any]


def add_tally(into: Dict[str, Tally], urn: str, entry: Tally) -> None:
    """Fold one ancestor's counts into a tally map."""
    held = into.get(urn)
    if held is None:
        into[urn] = [int(entry[0]), entry[1], entry[2], dict(entry[3])]
        return
    held[0] += int(entry[0])
    held[1] = held[1] or entry[1]
    held[2] = held[2] or entry[2]
    for et, k in entry[3].items():
        held[3][et] = held[3].get(et, 0) + int(k)


class SessionStore:
    """Where sessions live between requests.

    A session's facets are kept beside it, not in it: they are computed
    once, by whichever request claimed them, while other requests commit
    the scan — one record would let each overwrite the other.
    """

    async def load(self, sid: str) -> Optional[Session]:
        raise NotImplementedError

    async def save(self, session: Session, token: Optional[str], ttl_s: int,
                   tallies: Optional[Dict[str, Tally]] = None) -> bool:
        """Store the session. With a lease ``token``, only while that lease
        is still held — a holder that outlived its lease must not overwrite
        the request that took over. ``tallies`` (the ancestor counts of the
        units this commit folds in) are added to the session's in the same
        transaction: a unit's counts land exactly when the unit does."""
        raise NotImplementedError

    async def top_tallies(self, sid: str, n: int) -> List[Tuple[str, Tally]]:
        """The ``n`` ancestors holding the most matches, fullest first (ties
        in descending urn order)."""
        raise NotImplementedError

    async def read_tallies(self, sid: str, urns: Iterable[str]) -> Dict[str, Tally]:
        """These ancestors' tallies; one holding no match is absent."""
        raise NotImplementedError

    async def lease(self, sid: str, ttl_ms: int) -> Optional[str]:
        """Take the right to run the session's units, or None when another
        request holds it."""
        raise NotImplementedError

    async def release(self, sid: str, token: str) -> None:
        raise NotImplementedError

    async def delete(self, sid: str) -> None:
        raise NotImplementedError

    async def claim_facets(self, sid: str, ttl_s: int) -> bool:
        """The right to compute the session's facets; False when another
        request has it (and has not given up for ``ttl_s``)."""
        raise NotImplementedError

    async def save_facets(self, sid: str, facets: Any, ttl_s: int) -> None:
        raise NotImplementedError

    async def load_facets(self, sid: str) -> Optional[Any]:
        raise NotImplementedError


class RedisSessionStore(SessionStore):
    """Sessions in the provider's cache Redis, under its namespace."""

    def __init__(self, redis, namespace: str) -> None:
        self._redis = redis
        self._ns = namespace

    def _key(self, sid: str) -> str:
        return f"{self._ns}:dss:{sid}"

    def _lease_key(self, sid: str) -> str:
        return f"{self._ns}:dss:{sid}:lease"

    def _tally_key(self, sid: str) -> str:
        return f"{self._ns}:dss:{sid}:anc"

    def _rank_key(self, sid: str) -> str:
        return f"{self._ns}:dss:{sid}:ancz"

    async def load(self, sid: str) -> Optional[Session]:
        raw = await self._redis.get(self._key(sid))
        return Session.from_json(raw) if raw else None

    async def save(self, session: Session, token: Optional[str], ttl_s: int,
                   tallies: Optional[Dict[str, Tally]] = None) -> bool:
        sid = session.sid
        async with self._redis.pipeline(transaction=True) as pipe:
            try:
                if token is not None:
                    # The lease is watched: if it changes hands before the
                    # commit, nothing here is written.
                    await pipe.watch(self._lease_key(sid))
                    if _text(await pipe.get(self._lease_key(sid))) != token:
                        return False
                merged: Dict[str, Tally] = {}
                if tallies:
                    urns = list(tallies)
                    reader = pipe if token is not None else self._redis
                    for urn, raw in zip(urns, await reader.hmget(self._tally_key(sid), urns)):
                        if raw:
                            add_tally(merged, urn, json.loads(raw))
                        add_tally(merged, urn, tallies[urn])
                pipe.multi()
                pipe.set(self._key(sid), session.to_json(), ex=ttl_s)
                if merged:
                    pipe.hset(self._tally_key(sid), mapping={
                        urn: json.dumps(entry, separators=(",", ":"))
                        for urn, entry in merged.items()})
                    pipe.zadd(self._rank_key(sid), {urn: entry[0] for urn, entry in merged.items()})
                # The tally lives exactly as long as its session.
                pipe.expire(self._tally_key(sid), ttl_s)
                pipe.expire(self._rank_key(sid), ttl_s)
                await pipe.execute()
            except WatchError:
                return False
        return True

    async def top_tallies(self, sid: str, n: int) -> List[Tuple[str, Tally]]:
        if n <= 0:
            return []
        urns = [_text(u) for u in await self._redis.zrevrange(self._rank_key(sid), 0, n - 1)]
        held = await self.read_tallies(sid, urns)
        return [(urn, held[urn]) for urn in urns if urn in held]

    async def read_tallies(self, sid: str, urns: Iterable[str]) -> Dict[str, Tally]:
        urns = list(urns)
        if not urns:
            return {}
        raws = await self._redis.hmget(self._tally_key(sid), urns)
        return {urn: json.loads(raw) for urn, raw in zip(urns, raws) if raw}

    async def lease(self, sid: str, ttl_ms: int) -> Optional[str]:
        token = uuid.uuid4().hex
        ok = await self._redis.set(self._lease_key(sid), token, nx=True, px=ttl_ms)
        return token if ok else None

    async def release(self, sid: str, token: str) -> None:
        if await self._holder(sid) == token:
            await self._redis.delete(self._lease_key(sid))

    async def delete(self, sid: str) -> None:
        await self._redis.delete(self._key(sid), self._lease_key(sid),
                                 f"{self._key(sid)}:facets", f"{self._key(sid)}:facets:claim",
                                 self._tally_key(sid), self._rank_key(sid))

    async def claim_facets(self, sid: str, ttl_s: int) -> bool:
        return bool(await self._redis.set(f"{self._key(sid)}:facets:claim", "1",
                                          nx=True, ex=ttl_s))

    async def save_facets(self, sid: str, facets: Any, ttl_s: int) -> None:
        await self._redis.set(f"{self._key(sid)}:facets",
                              json.dumps(facets, separators=(",", ":")), ex=ttl_s)

    async def load_facets(self, sid: str) -> Optional[Any]:
        raw = await self._redis.get(f"{self._key(sid)}:facets")
        return json.loads(raw) if raw else None

    async def _holder(self, sid: str) -> Optional[str]:
        return _text(await self._redis.get(self._lease_key(sid)))


class MemorySessionStore(SessionStore):
    """Sessions in this process — for a deployment without a cache Redis.
    Bounded: the oldest are dropped past ``max_sessions``."""

    def __init__(self, max_sessions: int = 256) -> None:
        self._max = max_sessions
        self._sessions: Dict[str, tuple] = {}     # sid -> (expires_at, json)
        self._leases: Dict[str, tuple] = {}       # sid -> (expires_at, token)
        self._facets: Dict[str, tuple] = {}       # sid -> (expires_at, facets)
        self._claims: Dict[str, float] = {}       # sid -> expires_at
        self._tallies: Dict[str, Dict[str, Tally]] = {}   # sid -> its session's tally

    async def load(self, sid: str) -> Optional[Session]:
        entry = self._sessions.get(sid)
        if entry is None or entry[0] < time.monotonic():
            self._sessions.pop(sid, None)
            self._tallies.pop(sid, None)
            return None
        return Session.from_json(entry[1])

    async def save(self, session: Session, token: Optional[str], ttl_s: int,
                   tallies: Optional[Dict[str, Tally]] = None) -> bool:
        if token is not None and self._holder(session.sid) != token:
            return False
        self._sessions.pop(session.sid, None)
        self._sessions[session.sid] = (time.monotonic() + ttl_s, session.to_json())
        held = self._tallies.setdefault(session.sid, {})
        for urn, entry in (tallies or {}).items():
            add_tally(held, urn, entry)
        while len(self._sessions) > self._max:
            evicted = next(iter(self._sessions))
            self._sessions.pop(evicted)
            self._tallies.pop(evicted, None)
        return True

    async def top_tallies(self, sid: str, n: int) -> List[Tuple[str, Tally]]:
        ranked = sorted(self._live_tallies(sid).items(),
                        key=lambda kv: (kv[1][0], kv[0]), reverse=True)
        return [(urn, entry) for urn, entry in ranked[:max(0, n)]]

    async def read_tallies(self, sid: str, urns: Iterable[str]) -> Dict[str, Tally]:
        held = self._live_tallies(sid)
        return {urn: held[urn] for urn in urns if urn in held}

    def _live_tallies(self, sid: str) -> Dict[str, Tally]:
        entry = self._sessions.get(sid)
        if entry is None or entry[0] < time.monotonic():
            return {}
        return self._tallies.get(sid, {})

    async def lease(self, sid: str, ttl_ms: int) -> Optional[str]:
        if self._holder(sid) is not None:
            return None
        token = uuid.uuid4().hex
        self._leases[sid] = (time.monotonic() + ttl_ms / 1000.0, token)
        return token

    async def release(self, sid: str, token: str) -> None:
        if self._holder(sid) == token:
            self._leases.pop(sid, None)

    async def delete(self, sid: str) -> None:
        for held in (self._sessions, self._leases, self._facets, self._claims, self._tallies):
            held.pop(sid, None)

    async def claim_facets(self, sid: str, ttl_s: int) -> bool:
        now = time.monotonic()
        if self._claims.get(sid, 0.0) > now:
            return False
        self._claims[sid] = now + ttl_s
        return True

    async def save_facets(self, sid: str, facets: Any, ttl_s: int) -> None:
        self._facets[sid] = (time.monotonic() + ttl_s, json.dumps(facets))
        while len(self._facets) > self._max:
            self._facets.pop(next(iter(self._facets)))

    async def load_facets(self, sid: str) -> Optional[Any]:
        entry = self._facets.get(sid)
        if entry is None or entry[0] < time.monotonic():
            return None
        return json.loads(entry[1])

    def _holder(self, sid: str) -> Optional[str]:
        entry = self._leases.get(sid)
        if entry is None or entry[0] < time.monotonic():
            self._leases.pop(sid, None)
            return None
        return entry[1]


_MEMORY = MemorySessionStore()


def _text(raw: Any) -> Optional[str]:
    return raw.decode() if isinstance(raw, bytes) else raw


def store_for(provider) -> SessionStore:
    """The provider's cache Redis when it has one, else this process."""
    redis = getattr(provider, "_redis", None)
    ns = getattr(provider, "_cache_ns", None)
    if redis is not None and ns:
        return RedisSessionStore(redis, ns)
    return _MEMORY


async def wait_for_commit(store: SessionStore, sid: str, seen: Optional[Session],
                          deadline: float, poll_s: float = 0.15) -> Optional[Session]:
    """Another request holds the lease: answer with its next commit, or
    with what is there when this request's wait runs out."""
    latest = seen
    while time.monotonic() < deadline:
        await asyncio.sleep(min(poll_s, max(0.0, deadline - time.monotonic())))
        current = await store.load(sid)
        if current is None:
            continue      # the holder has not made its first commit yet
        if (latest is None or current.status != RUNNING
                or current.scanned != latest.scanned or current.count != latest.count):
            return current
        latest = current
    return latest
