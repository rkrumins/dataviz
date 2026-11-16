"""The versioned-graph settings store in memory, for tests: no Redis, no database.

Every test starts with an empty one (``conftest._settings_in_memory``, autouse). The process's
snapshot (``settings.snapshot``) reads it, so ``settings.effective`` gives each setting's
environment or code default and asks nothing of Redis or the database. A test that saves values
asks for ``settings_world``. That fixture also stands in for the store's own functions
(``store.apply``, whose writes need Postgres, and its reads), for a route that saves through them::

    async def test_a_workspace_value(settings_world):
        settings_world.set("drafts.levels", "workspace", "ws_1", "private_only")
        ...                       # read through settings.effective, as the app does

A value saved here is in the snapshot's next read: an async ``effective`` call, or
``await effective.refresh()`` before a sync ``effective.value``. ``readable = False`` puts the
database out of reach, as the real snapshot sees it: the last rows read keep serving and
``effective.readable()`` says so. The stand-ins replace module attributes, so the code under
test calls them as ``store.apply(...)``, never as a name imported from ``store``. A test against
Postgres and Redis that reads the real store calls :func:`use_the_database` first.

No graph's own value waits for its import (``settings.legacy.graph_values_imported``), so a
graph's read mode is the store's. A test of the time before the graphs' own values were copied
from a separate graph store calls ``not_imported``.
"""
from __future__ import annotations

import json
import math
import uuid
from typing import Any, Dict, List, Optional, Sequence, Set

from backend.app.services.settings import effective, legacy, registry, store
from backend.app.services.settings import snapshot as snapshots
from backend.app.services.settings.resolver import Row, RowKey
from backend.app.services.settings.store import KEEP, Applied, Change, ChangeSet, SettingsConflict


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


class SettingsWorld:
    """The store's rows and saves, and the snapshot that reads them."""

    def __init__(self, domain: Optional[str] = None):
        self.domain = domain or registry().DOMAIN
        self.rows: Dict[RowKey, Row] = {}
        #: Every save that changed something, oldest first (``store.apply``'s change sets).
        self.saves: List[ChangeSet] = []
        #: The one-time imports that have run (``settings_imports``): none, as in a store made
        #: from nothing.
        self.imports: Set[str] = set()
        self._readable = True
        self._rev = 0
        self._now = 0.0
        self.snapshot = snapshots.Snapshot(self.domain, loader=self._load,
                                           generation=self._generation, clock=lambda: self._now)

    # ── What the snapshot reads ───────────────────────────────────────────────────────────────────
    async def _load(self, domain: str, after: Optional[int]) -> List[Row]:
        if not self._readable:
            raise ConnectionError("the settings store is out of reach")
        return sorted((r for r in self.rows.values() if after is None or r.rev > after),
                      key=lambda r: r.rev)

    async def _generation(self, domain: str) -> str:
        return str(self._rev)

    def _moved(self) -> None:
        """Something changed: the snapshot's next read asks again, and reads it."""
        self._now += snapshots.RELOAD_S

    @property
    def readable(self) -> bool:
        return self._readable

    @readable.setter
    def readable(self, value: bool) -> None:
        self._readable = value
        self._moved()

    def not_imported(self, monkeypatch) -> None:
        """The graphs' own values still to be copied from a separate graph store: the import
        migration ran (``legacy`` in ``imports``) but ``legacy_graph`` isn't there yet, which the
        process asks, as it does every 30 seconds until it is."""
        self.imports = {legacy.MARKER}

        async def imports_done():
            return set(self.imports)

        monkeypatch.setattr(legacy, "_imports_done", imports_done)
        _ask_again(monkeypatch)

    # ── Saving ────────────────────────────────────────────────────────────────────────────────────
    def set(self, key: str, scope: str, scope_id: str, value: Any, *,
            limits: Any = None) -> Row:
        """A value saved at a scope (``scope_id``: ``""`` for the platform, a workspace's id, or
        a data source's), as a save through the store leaves it; None inherits."""
        if key not in registry().BY_KEY:
            raise KeyError(f"{key} is not a versioned-graph setting")
        old = self.rows.get((key, scope, scope_id))
        self._rev += 1
        row = Row(key, scope, scope_id, value, limits, (old.version if old else 0) + 1, self._rev)
        self.rows[(key, scope, scope_id)] = row
        self._moved()
        return row

    async def apply(self, session, domain: str, changes: Sequence[Change], *,
                    actor: Optional[str], reason: Optional[str] = None, source: str = "api",
                    before_commit: Optional[store.Hook] = None) -> ChangeSet:
        """``store.apply`` in memory, all or nothing. Each value is checked against its version
        (:class:`~store.SettingsConflict`), then ``before_commit(session, change_set)`` runs, then
        ``session`` commits. The rows change only once it has; on a failure it is rolled back."""
        assert domain == self.domain, domain
        if source not in store.SOURCES:
            raise ValueError(f"source must be one of {', '.join(store.SOURCES)}")
        staged, rev, applied = dict(self.rows), self._rev, []
        try:
            conflicts = []
            for c in changes:
                row = staged.get((c.key, c.scope, c.scope_id))
                actual = row.version if row is not None else 0
                if c.expected_version != actual:
                    conflicts.append({"key": c.key, "scope": c.scope, "scopeId": c.scope_id,
                                      "expected": c.expected_version, "actual": actual})
            if conflicts:
                raise SettingsConflict(conflicts)
            for c in changes:
                row = staged.get((c.key, c.scope, c.scope_id))
                before_value = row.value if row is not None else None
                before_limits = row.limits if row is not None else None
                after_value = before_value if c.value is KEEP else c.value
                after_limits = before_limits if c.limits is KEEP else c.limits
                if _same(after_value, before_value) and _same(after_limits, before_limits):
                    continue
                rev += 1
                version = (row.version if row is not None else 0) + 1
                staged[(c.key, c.scope, c.scope_id)] = Row(c.key, c.scope, c.scope_id, after_value,
                                                           after_limits, version, rev,
                                                           updated_by=actor)
                applied.append(Applied(c.key, c.scope, c.scope_id, before_value, after_value,
                                       before_limits, after_limits, version, rev))
            change_set = ChangeSet(uuid.uuid4(), domain, actor, reason, source, tuple(applied))
            if before_commit is not None:
                await before_commit(session, change_set)
            await session.commit()
        except BaseException:
            await session.rollback()
            raise
        if applied:
            self.rows, self._rev = staged, rev
            self.saves.append(change_set)
            self._moved()
        return change_set

    async def lock(self, session, domain: str) -> None:
        """``store.lock``: one test, one writer."""

    # ── The store's reads ─────────────────────────────────────────────────────────────────────────
    def _rows(self, keep) -> List[Row]:
        return sorted((r for r in self.rows.values() if keep(r)), key=lambda r: r.rev)

    async def read_domain(self, session, domain: str) -> List[Row]:
        return self._rows(lambda r: domain == self.domain)

    async def read_since(self, session, domain: str, rev: int) -> List[Row]:
        return self._rows(lambda r: domain == self.domain and r.rev > rev)

    async def read_scope(self, session, domain: str, scope: str, scope_id: str) -> List[Row]:
        return self._rows(lambda r: domain == self.domain and (r.scope, r.scope_id) == (scope,
                                                                                         scope_id))

    async def read_key(self, session, domain: str, key: str) -> List[Row]:
        return self._rows(lambda r: domain == self.domain and r.key == key)

    async def imports_done(self, session) -> Set[str]:
        return set(self.imports)

    # ── Putting it in place ───────────────────────────────────────────────────────────────────────
    def install(self, monkeypatch) -> None:
        """This world's snapshot as the process's, from a fresh ``effective``. No graph's own
        value waits for its import, and the process asks nothing about it."""
        monkeypatch.setitem(snapshots._SNAPSHOTS, self.domain, self.snapshot)
        monkeypatch.setitem(legacy._GRAPH_VALUES, "imported", True)
        monkeypatch.setitem(legacy._GRAPH_VALUES, "final", True)
        effective.reset()

    def install_store(self, monkeypatch) -> None:
        """This world in place of the store's writes and reads."""
        for name in ("apply", "lock", "read_domain", "read_since", "read_scope", "read_key",
                     "imports_done"):
            monkeypatch.setattr(store, name, getattr(self, name))


def _ask_again(monkeypatch) -> None:
    """The process has not asked whether the graphs' own values are in the store yet: it will."""
    monkeypatch.setitem(legacy._GRAPH_VALUES, "imported", False)
    monkeypatch.setitem(legacy._GRAPH_VALUES, "final", False)
    monkeypatch.setitem(legacy._GRAPH_VALUES, "asked_at", -math.inf)


def use_the_database(monkeypatch) -> snapshots.Snapshot:
    """For a test against Postgres and Redis: the process's snapshot reads the real store again,
    from a fresh ``effective``, and asks it whether the graphs' own values are in it."""
    snap = snapshots.Snapshot(registry().DOMAIN)
    monkeypatch.setitem(snapshots._SNAPSHOTS, snap.domain, snap)
    _ask_again(monkeypatch)
    effective.reset()
    return snap
