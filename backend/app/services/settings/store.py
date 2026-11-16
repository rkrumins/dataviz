"""The settings store (management database): the values chosen by the platform, a workspace or a
graph (``setting_values``), each change with who made it and why (``setting_changes``), and the
one-time imports that have run (``settings_imports``).

Every function takes the caller's ``AsyncSession`` (a request's ``get_db_session``, or
``get_async_session()``), as the repositories do. :func:`apply` is the one writer: all or nothing,
each value checked against the version it was read at, and it commits — then moves the domain's
generation in Redis (``settings:gen:<domain>``, best effort) so every process reloads within two
seconds (``snapshot``).

Writers of a domain take one transaction-scoped advisory lock, so each write's ``rev`` (the next of
``setting_values_rev_seq``) is visible in the order it was taken: a process that read every row up
to ``rev`` N never misses one numbered lower that commits later.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import and_, false, func, or_, select, text, tuple_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import SettingChangeORM, SettingsImportORM, SettingValueORM

from .resolver import Row

logger = logging.getLogger(__name__)

SOURCES = ("api", "legacy_api", "migration", "revert")
_V, _C = SettingValueORM, SettingChangeORM
_COLUMNS = (_V.key, _V.scope, _V.scope_id, _V.value, _V.limits, _V.version, _V.rev,
            _V.updated_at, _V.updated_by)
_LOCK = text("SELECT pg_advisory_xact_lock(hashtext(:lock))")
#: How long a save waits on Redis to move the generation before it gives up (best effort).
_ANNOUNCE_WAIT_S = 0.5


def generation_key(domain: str) -> str:
    """The Redis key a save moves, which each process's snapshot watches."""
    return f"settings:gen:{domain}"


async def lock(session: AsyncSession, domain: str) -> None:
    """Take the domain's writer lock, until the transaction ends."""
    await session.execute(_LOCK, {"lock": f"settings:{domain}"})


class _Keep:
    def __repr__(self) -> str:
        return "KEEP"


#: A :class:`Change` field left as it is.
KEEP: Any = _Keep()


@dataclass(frozen=True)
class Change:
    """One value to set: ``value`` None inherits from the scope above; ``limits`` (platform only)
    None takes the setting's default limits. ``expected_version`` is the version it was read at
    (0: none saved yet)."""
    key: str
    scope: str
    scope_id: str
    expected_version: int
    value: Any = KEEP
    limits: Any = KEEP


@dataclass(frozen=True)
class Applied:
    """What one change did: before and after, and the value's new ``version`` and ``rev``."""
    key: str
    scope: str
    scope_id: str
    before_value: Any
    after_value: Any
    before_limits: Any
    after_limits: Any
    version: int
    rev: int


@dataclass(frozen=True)
class ChangeSet:
    """One save: every value it changed (none, when it changed nothing), under one id."""
    id: uuid.UUID
    domain: str
    actor: Optional[str]
    reason: Optional[str]
    source: str
    applied: Tuple[Applied, ...]


@dataclass(frozen=True)
class HistoryEntry:
    id: int
    change_set: uuid.UUID
    key: str
    scope: str
    scope_id: str
    before_value: Any
    after_value: Any
    before_limits: Any
    after_limits: Any
    version: int
    actor: Optional[str]
    reason: Optional[str]
    source: str
    at: datetime


#: Runs inside :func:`apply`'s transaction, before it commits.
Hook = Callable[[AsyncSession, ChangeSet], Awaitable[None]]


class SettingsConflict(Exception):
    """Values changed since they were read (409 ``settings_conflict``): ``conflicts`` names each,
    ``{key, scope, scopeId, expected, actual}``. Nothing was saved."""
    code = "settings_conflict"

    def __init__(self, conflicts: List[Dict[str, Any]]):
        self.conflicts = conflicts
        super().__init__("changed since they were read: "
                         + ", ".join(sorted({c["key"] for c in conflicts})))

    @property
    def keys(self) -> List[str]:
        return sorted({c["key"] for c in self.conflicts})


# ── Reads ─────────────────────────────────────────────────────────────────────────────────────────
async def _rows(session: AsyncSession, *where) -> List[Row]:
    found = await session.execute(select(*_COLUMNS).where(*where).order_by(_V.rev))
    return [Row(*r) for r in found.all()]


async def read_domain(session: AsyncSession, domain: str) -> List[Row]:
    """Every row of a domain."""
    return await _rows(session, _V.domain == domain)


async def read_since(session: AsyncSession, domain: str, rev: int) -> List[Row]:
    """The rows of a domain written after ``rev``."""
    return await _rows(session, _V.domain == domain, _V.rev > rev)


async def read_scope(session: AsyncSession, domain: str, scope: str, scope_id: str) -> List[Row]:
    """A scope's own rows: the platform's (``scope_id`` ``''``), a workspace's or a graph's."""
    return await _rows(session, _V.domain == domain, _V.scope == scope, _V.scope_id == scope_id)


async def read_key(session: AsyncSession, domain: str, key: str) -> List[Row]:
    """One setting's rows, at every scope."""
    return await _rows(session, _V.domain == domain, _V.key == key)


# ── Writes ────────────────────────────────────────────────────────────────────────────────────────
def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


async def apply(session: AsyncSession, domain: str, changes: Sequence[Change], *,
                actor: Optional[str], reason: Optional[str] = None, source: str = "api",
                before_commit: Optional[Hook] = None) -> ChangeSet:
    """Save ``changes`` all together or not at all, and commit ``session``.

    Every value must still be at its ``expected_version``, else :class:`SettingsConflict` names
    each that moved and nothing is saved. A change that changes nothing is left out; the others
    each get a new ``version`` and ``rev`` and a ``setting_changes`` row under one change set
    (``source``: ``api``, ``legacy_api``, ``migration`` or ``revert``). ``before_commit(session,
    change_set)`` runs in the same transaction (the write-through to the old storage, the activity
    event). On any failure the session is rolled back. After the commit, the domain's generation
    moves in Redis, best effort."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {', '.join(SOURCES)}")
    try:
        await lock(session, domain)
        current: Dict[Tuple[str, str, str], Row] = {}
        if changes:
            found = await session.execute(select(*_COLUMNS).where(
                _V.domain == domain,
                tuple_(_V.key, _V.scope, _V.scope_id).in_(
                    [(c.key, c.scope, c.scope_id) for c in changes])))
            current = {(r.key, r.scope, r.scope_id): Row(*r) for r in found.all()}
        conflicts = []
        for c in changes:
            row = current.get((c.key, c.scope, c.scope_id))
            actual = row.version if row is not None else 0
            if c.expected_version != actual:
                conflicts.append({"key": c.key, "scope": c.scope, "scopeId": c.scope_id,
                                  "expected": c.expected_version, "actual": actual})
        if conflicts:
            raise SettingsConflict(conflicts)
        applied: List[Applied] = []
        for c in changes:
            row = current.get((c.key, c.scope, c.scope_id))
            before_value = row.value if row is not None else None
            before_limits = row.limits if row is not None else None
            after_value = before_value if c.value is KEEP else c.value
            after_limits = before_limits if c.limits is KEEP else c.limits
            if _same(after_value, before_value) and _same(after_limits, before_limits):
                continue
            stmt = pg_insert(_V).values(domain=domain, key=c.key, scope=c.scope,
                                        scope_id=c.scope_id, value=after_value,
                                        limits=after_limits, version=1, updated_by=actor)
            stmt = stmt.on_conflict_do_update(
                index_elements=[_V.domain, _V.key, _V.scope, _V.scope_id],
                set_={"value": stmt.excluded.value, "limits": stmt.excluded.limits,
                      "version": _V.version + 1, "rev": func.nextval("setting_values_rev_seq"),
                      "updated_at": func.now(), "updated_by": stmt.excluded.updated_by},
            ).returning(_V.version, _V.rev)
            version, rev = (await session.execute(stmt)).one()
            applied.append(Applied(c.key, c.scope, c.scope_id, before_value, after_value,
                                   before_limits, after_limits, version, rev))
        change_set = ChangeSet(uuid.uuid4(), domain, actor, reason, source, tuple(applied))
        if applied:
            await session.execute(_C.__table__.insert(), [{
                "change_set": change_set.id, "domain": domain, "key": a.key, "scope": a.scope,
                "scope_id": a.scope_id, "before_value": a.before_value,
                "after_value": a.after_value, "before_limits": a.before_limits,
                "after_limits": a.after_limits, "version": a.version, "actor": actor,
                "reason": reason, "source": source} for a in applied])
        if before_commit is not None:
            await before_commit(session, change_set)
        await session.commit()
    except BaseException:
        await asyncio.shield(session.rollback())
        raise
    if applied:
        await announce(domain)
    return change_set


def _redis():
    """The client the generation lives on: the coordination bus build_policy's generation uses."""
    from backend.app.services.aggregation.redis_client import get_redis

    return get_redis()


async def announce(domain: str) -> bool:
    """Move the domain's generation, so every process reloads what changed within two seconds.
    False when Redis can't take it: the others then see it within their 30-second reload."""
    try:
        await asyncio.wait_for(_redis().incr(generation_key(domain)), timeout=_ANNOUNCE_WAIT_S)
        return True
    except Exception:  # noqa: BLE001 — a save never fails over it
        logger.info("settings: the %s generation could not be moved", domain, exc_info=True)
        return False


# ── History ───────────────────────────────────────────────────────────────────────────────────────
_HISTORY = (_C.id, _C.change_set, _C.key, _C.scope, _C.scope_id, _C.before_value,
            _C.after_value, _C.before_limits, _C.after_limits, _C.version, _C.actor, _C.reason,
            _C.source, _C.at)


async def history(session: AsyncSession, domain: str, *, scope: Optional[str] = None,
                  scope_id: Optional[str] = None, key: Optional[str] = None,
                  actor: Optional[str] = None, since: Optional[datetime] = None,
                  until: Optional[datetime] = None, limit: int = 50,
                  before_id: Optional[int] = None,
                  places: Optional[Sequence[Tuple[str, Sequence[str]]]] = None,
                  ) -> Tuple[List[HistoryEntry], Optional[int]]:
    """Changes, newest first, filtered by scope (and its id), key, actor and time (``since``
    inclusive, ``until`` exclusive); a page of ``limit``, and the ``before_id`` of the next page
    (None: no more). ``places`` keeps the changes at any of several places, each a scope and its
    ids: a workspace's own and its graphs'."""
    query = select(*_HISTORY).where(_C.domain == domain)
    for column, wanted in ((_C.scope, scope), (_C.scope_id, scope_id), (_C.key, key),
                           (_C.actor, actor)):
        if wanted is not None:
            query = query.where(column == wanted)
    if places is not None:
        query = query.where(or_(false(), *(and_(_C.scope == s, _C.scope_id.in_(list(ids)))
                                           for s, ids in places)))
    if since is not None:
        query = query.where(_C.at >= since)
    if until is not None:
        query = query.where(_C.at < until)
    if before_id is not None:
        query = query.where(_C.id < before_id)
    found = (await session.execute(query.order_by(_C.id.desc()).limit(limit + 1))).all()
    entries = [HistoryEntry(*r) for r in found[:limit]]
    return entries, (entries[-1].id if len(found) > limit else None)


async def revert(session: AsyncSession, domain: str, change_set: uuid.UUID, *,
                 actor: Optional[str], reason: Optional[str] = None,
                 before_commit: Optional[Hook] = None) -> ChangeSet:
    """Put back what a change set changed (``source`` ``revert``), all or nothing: a value changed
    again since is a :class:`SettingsConflict`. ``LookupError`` for a change set there isn't."""
    found = (await session.execute(
        select(_C.key, _C.scope, _C.scope_id, _C.before_value, _C.before_limits, _C.version)
        .where(_C.domain == domain, _C.change_set == change_set).order_by(_C.id))).all()
    if not found:
        raise LookupError(str(change_set))
    return await apply(session, domain, [
        Change(r.key, r.scope, r.scope_id, expected_version=r.version, value=r.before_value,
               limits=r.before_limits if r.scope == "platform" else KEEP) for r in found],
        actor=actor, reason=reason, source="revert", before_commit=before_commit)


# ── One-time imports ──────────────────────────────────────────────────────────────────────────────
async def imports_done(session: AsyncSession) -> Set[str]:
    """The names of the one-time imports that have run."""
    return set((await session.execute(select(SettingsImportORM.name))).scalars())


async def mark_import(session: AsyncSession, name: str, detail: Dict[str, Any]) -> None:
    """Record that an import has run (once: a second mark leaves the first)."""
    stmt = pg_insert(SettingsImportORM).values(name=name, detail=detail)
    await session.execute(stmt.on_conflict_do_nothing(index_elements=[SettingsImportORM.name]))
