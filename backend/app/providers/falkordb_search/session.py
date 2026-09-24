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
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

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

    @classmethod
    def start(cls, sid: str, query_id: str, data_version: str,
              after: Optional[List[Any]], k: int, plan: Plan) -> "Session":
        session = cls(sid, query_id, data_version, after, k, list(plan.units),
                      list(plan.clamps), sum(u.size for u in plan.units),
                      notes=list(plan.notes))
        if not session.pending:
            session.status = COMPLETE
        return session

    def to_json(self) -> str:
        return json.dumps({
            "sid": self.sid, "q": self.query_id, "dv": self.data_version,
            "after": self.after, "k": self.k,
            "pending": [u.to_dict() for u in self.pending], "clamps": self.clamps,
            "total": self.total, "scanned": self.scanned, "count": self.count,
            "rows": self.rows, "status": self.status, "error": self.error,
            "notes": self.notes, "created": self.created,
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
            )
        except Exception as exc:                     # noqa: BLE001 — a miss, not an error
            logger.debug("search session unreadable: %r", exc)
            return None


class SessionStore:
    """Where sessions live between requests.

    A session's facets are kept beside it, not in it: they are computed
    once, by whichever request claimed them, while other requests commit
    the scan — one record would let each overwrite the other.
    """

    async def load(self, sid: str) -> Optional[Session]:
        raise NotImplementedError

    async def save(self, session: Session, token: Optional[str], ttl_s: int) -> bool:
        """Store the session. With a lease ``token``, only while that lease
        is still held — a holder that outlived its lease must not overwrite
        the request that took over."""
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

    async def load(self, sid: str) -> Optional[Session]:
        raw = await self._redis.get(self._key(sid))
        return Session.from_json(raw) if raw else None

    async def save(self, session: Session, token: Optional[str], ttl_s: int) -> bool:
        if token is not None and await self._holder(session.sid) != token:
            return False
        await self._redis.set(self._key(session.sid), session.to_json(), ex=ttl_s)
        return True

    async def lease(self, sid: str, ttl_ms: int) -> Optional[str]:
        token = uuid.uuid4().hex
        ok = await self._redis.set(self._lease_key(sid), token, nx=True, px=ttl_ms)
        return token if ok else None

    async def release(self, sid: str, token: str) -> None:
        if await self._holder(sid) == token:
            await self._redis.delete(self._lease_key(sid))

    async def delete(self, sid: str) -> None:
        await self._redis.delete(self._key(sid), self._lease_key(sid),
                                 f"{self._key(sid)}:facets", f"{self._key(sid)}:facets:claim")

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
        raw = await self._redis.get(self._lease_key(sid))
        if isinstance(raw, bytes):
            raw = raw.decode()
        return raw


class MemorySessionStore(SessionStore):
    """Sessions in this process — for a deployment without a cache Redis.
    Bounded: the oldest are dropped past ``max_sessions``."""

    def __init__(self, max_sessions: int = 256) -> None:
        self._max = max_sessions
        self._sessions: Dict[str, tuple] = {}     # sid -> (expires_at, json)
        self._leases: Dict[str, tuple] = {}       # sid -> (expires_at, token)
        self._facets: Dict[str, tuple] = {}       # sid -> (expires_at, facets)
        self._claims: Dict[str, float] = {}       # sid -> expires_at

    async def load(self, sid: str) -> Optional[Session]:
        entry = self._sessions.get(sid)
        if entry is None or entry[0] < time.monotonic():
            self._sessions.pop(sid, None)
            return None
        return Session.from_json(entry[1])

    async def save(self, session: Session, token: Optional[str], ttl_s: int) -> bool:
        if token is not None and self._holder(session.sid) != token:
            return False
        self._sessions.pop(session.sid, None)
        self._sessions[session.sid] = (time.monotonic() + ttl_s, session.to_json())
        while len(self._sessions) > self._max:
            self._sessions.pop(next(iter(self._sessions)))
        return True

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
        for held in (self._sessions, self._leases, self._facets, self._claims):
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
