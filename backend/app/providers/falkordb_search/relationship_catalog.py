"""A view's relationship properties, exactly: every key its relationships
carry, on how many, stored as which kinds, with which values — the entity
catalog's answer (``catalog``), for relationships.

The relationships in a view's scope are those a Connections search of any
relationship between any two entities in it reads (``edges``): its units
are bands of source entities, a hub's edges split by edge-ID band, sized
from each relationship type's count (``db.meta.stats()``) — never a scan of
every edge per type. Rollups (``AGGREGATED``) summarise other edges and are
never read.

A relationship keeps a user's properties natively, within the graph's
property-name budget, and the rest — every one, on a relationship written
before that — in its JSON bag ``r.properties``, which Cypher can't parse.
So each unit is read in two parts:

* relationships with an empty bag, counted in the graph as the entity
  catalog counts entities: keys and kinds, a probe of a new key's first
  ``PROBE_ENTITIES`` values, values while a key has at most ``VALUES_MAX``,
  signed numeric bounds;
* relationships holding a bag, read a page at a time and counted here, as
  every reader takes them (``falkordb_provider.edge_user_properties``: the
  bag wins a name both hold); a key from the bag is counted ``residual``.

The answer is the entity catalog's shape: ``entities`` counts
relationships, ``entityTypes`` and ``byEntityType`` are relationship types,
and there are no tags.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
from typing import Any, Dict, List, Optional, Tuple

from backend.app.providers.falkordb_provider import edge_user_properties
from backend.app.providers.falkordb_search import catalog
from backend.app.providers.falkordb_search.catalog import CatalogStats, collected, per_keys
from backend.app.providers.falkordb_search.edges import (
    EdgeContext,
    _plan,
    edge_context,
    edge_match,
)
from backend.app.providers.falkordb_search.plan import Plan, Unit, expand_unit
from backend.app.providers.falkordb_search.session import Session, SessionStore
from backend.common.models.search import EdgesPredicate, SearchQuery, SearchScope

#: The relationships whose properties are all native: their bag is empty.
_NO_BAG = "(e.properties IS NULL OR e.properties = '{}')"

#: A value ``_v`` of key ``_k`` that is a user's: never the platform's own
#: numeric confidence (one that isn't a number is the user's, as the readers
#: take it) — so its values and probe count only the user's.
_USERS = "NOT (_k = 'confidence' AND typeOf(_v) IN ['Integer', 'Float'])"

#: Native keys that are never a user's property on a relationship with an
#: empty bag: its identity, content hash and the bag itself. (A ``confidence``
#: is the platform's only when it is a number, ``_native_keys``.)
_ENVELOPE = frozenset({"id", "gvHash", "properties"})


def scan_query(scope: SearchScope) -> SearchQuery:
    """Every relationship between two entities in ``scope``, as stored."""
    return SearchQuery(predicate=EdgesPredicate(edge_class="any"), scope=scope)


async def relationship_plan(provider, scope: SearchScope, run, settings, deadline: float
                            ) -> Tuple[Plan, Dict[str, Any]]:
    """The units a relationship catalog reads, and what its edge context needs
    kept beside them (``edges._plan``)."""
    return await _plan(provider, scan_query(scope), run, settings, deadline)


def _native_keys(rows: List[List[Any]]) -> List[List[Any]]:
    """``[type, key, kind, n]`` rows of relationships with an empty bag, less
    what is never a user's: the envelope, and a ``confidence`` that is a
    number (one that isn't is the user's, as the readers take it)."""
    return [r for r in rows if r[1] not in _ENVELOPE
            and not (r[1] == "confidence" and r[2] in ("Integer", "Float"))]


# ---------------------------------------------------------------------------
# Statements, per unit
# ---------------------------------------------------------------------------

def _match(unit: Unit, ectx: EdgeContext, clamps) -> Tuple[str, Dict[str, Any]]:
    cypher, params, _src, _tgt = edge_match(unit, ectx, clamps)
    return cypher, params


def count_statement(unit: Unit, ectx: EdgeContext, clamps) -> Tuple[str, Dict[str, Any]]:
    """The unit's relationships per type — every one, bag or not."""
    head, params = _match(unit, ectx, clamps)
    return f"{head} RETURN type(e), count(e)", params


def keys_statement(unit: Unit, ectx: EdgeContext, clamps) -> Tuple[str, Dict[str, Any]]:
    """Every native key of the unit's relationships with an empty bag, per
    type and kind, as ONE row."""
    head, params = _match(unit, ectx, clamps)
    return (f"{head} WITH e WHERE {_NO_BAG} UNWIND keys(e) AS _k "
            "WITH type(e) AS _l, _k, typeOf(e[_k]) AS _t, count(*) AS _c "
            "RETURN collect([_l, _k, _t, _c])", params)


def probe_statement(unit: Unit, ectx: EdgeContext, clamps, keys: List[str]
                    ) -> Tuple[str, Dict[str, Any]]:
    """How many distinct values each of ``keys`` holds among the unit's first
    ``PROBE_ENTITIES`` relationships with an empty bag."""
    head, params = _match(unit, ectx, clamps)
    params["_keys"] = list(keys)
    params["_probe"] = catalog.PROBE_ENTITIES
    return (f"{head} WITH e WHERE {_NO_BAG} WITH e LIMIT $_probe UNWIND $_keys AS _k "
            f"WITH _k, e[_k] AS _v WHERE _v IS NOT NULL AND {_USERS} "
            "RETURN _k, count(DISTINCT _v)", params)


def bounds_statement(unit: Unit, ectx: EdgeContext, clamps, keys: List[str]
                     ) -> Tuple[str, Dict[str, Any]]:
    """The numeric bounds of each of ``keys``, its negative and non-negative
    values apart (``catalog.bounds_statement``)."""
    head, params = _match(unit, ectx, clamps)
    params["_keys"] = list(keys)
    return (f"{head} WITH e WHERE {_NO_BAG} UNWIND $_keys AS _k WITH _k, e[_k] AS _v "
            "WHERE typeOf(_v) IN ['Integer', 'Float'] AND _k <> 'confidence' "
            "RETURN _k, min(CASE WHEN _v >= 0 THEN _v END), max(CASE WHEN _v >= 0 THEN _v END), "
            "min(CASE WHEN _v < 0 THEN _v END), max(CASE WHEN _v < 0 THEN _v END)", params)


def values_statement(unit: Unit, ectx: EdgeContext, clamps, keys: List[str]
                     ) -> Tuple[str, Dict[str, Any]]:
    """Each key's values and the relationships holding each — a list per
    element — cut at ``VALUES_MAX`` + 1 (``catalog.values_statement``)."""
    head, params = _match(unit, ectx, clamps)
    params["_keys"] = list(keys)
    params["_cap"] = catalog.VALUES_MAX + 1
    return (f"{head} WITH e WHERE {_NO_BAG} UNWIND $_keys AS _k "
            f"WITH e, _k, e[_k] AS _v WHERE _v IS NOT NULL AND {_USERS} "
            "WITH e, _k, CASE WHEN typeOf(_v) = 'List' THEN _v ELSE [_v] END AS _vs "
            "UNWIND _vs AS _x WITH _k, typeOf(_x) AS _t, _x, count(DISTINCT e) AS _c "
            "WITH _k, collect([_t, _x, _c]) AS _vals "
            "RETURN _k, size(_vals), _vals[..$_cap]", params)


def bag_statement(unit: Unit, ectx: EdgeContext, clamps, after: Tuple[int, int]
                  ) -> Tuple[str, Dict[str, Any]]:
    """A page of the unit's relationships holding a bag, in (source, edge) ID
    order after ``after``: each one's type and ``properties(e)``."""
    head, params = _match(unit, ectx, clamps)
    params["_an"], params["_ae"] = int(after[0]), int(after[1])
    params["_page"] = catalog.PAGE
    return (f"{head} WITH n, e WHERE NOT {_NO_BAG} "
            "AND (ID(n) > $_an OR (ID(n) = $_an AND ID(e) > $_ae)) "
            "WITH n, e ORDER BY ID(n), ID(e) LIMIT $_page "
            "RETURN ID(n), ID(e), type(e), properties(e)", params)


async def _bags(run, unit: Unit, ectx: EdgeContext, clamps, timeout_s: float
                ) -> List[List[Any]]:
    """Every ``[type, properties(e)]`` of the unit's relationships holding a
    bag, a page at a time."""
    rows: List[List[Any]] = []
    after = (-1, -1)
    while True:
        cypher, params = bag_statement(unit, ectx, clamps, after)
        page = (await run(cypher, params, timeout_s)).result_set or []
        rows += [[r[2], r[3]] for r in page]
        if len(page) < catalog.PAGE:
            return rows
        after = (page[-1][0], page[-1][1])


# ---------------------------------------------------------------------------
# The work
# ---------------------------------------------------------------------------

class RelationshipCatalogWork:
    """What the relationship catalog takes from each unit, folded into
    ``CatalogStats`` — committed with the session, beside what its edge
    context needs (``state``), so a unit counts exactly once."""

    def __init__(self, session: Session, provider, scope: SearchScope, run,
                 state: Dict[str, Any]) -> None:
        self.session, self.run, self.state = session, run, dict(state)
        self.ectx = edge_context(provider, scan_query(scope), self.state)
        self.stats = CatalogStats()

    def _ectx(self) -> EdgeContext:
        anchor = dataclasses.replace(self.ectx.anchor,
                                     clamp_depths=tuple(self.session.clamp_depths))
        return dataclasses.replace(self.ectx, anchor=anchor)

    async def expand(self, unit: Unit, timeout_s: float) -> Optional[List[Unit]]:
        return await expand_unit(unit, self.ectx.anchor, self.run, timeout_s)

    async def begin(self, store: SessionStore) -> None:
        # Read with the lease held: the catalog of the latest commit.
        raw = await store.load_accumulator(self.session.sid)
        self.stats = CatalogStats.from_json(raw)

    async def unit(self, unit: Unit, timeout_s: float):
        ectx, clamps, run = self._ectx(), self.session.clamps, self.run
        (counts, keyed), bags = await asyncio.gather(
            asyncio.gather(*(run(c, p, timeout_s) for c, p in
                             (count_statement(unit, ectx, clamps),
                              keys_statement(unit, ectx, clamps)))),
            _bags(run, unit, ectx, clamps, timeout_s))
        keyed_rows = _native_keys(collected(keyed))
        keys = {row[1] for row in keyed_rows}
        new = sorted(k for k in keys if k not in self.stats.keys)
        probed = [r for r in await per_keys(
            run, lambda part: probe_statement(unit, ectx, clamps, part), new, timeout_s)
            if r[1] > catalog.VALUES_MAX]
        unique = {r[0] for r in probed}
        tracked = sorted(k for k in keys - unique if not self.stats.high_cardinality(k))
        numeric = sorted({row[1] for row in keyed_rows if row[2] in ("Integer", "Float")})
        values, bounds = await asyncio.gather(
            per_keys(run, lambda part: values_statement(unit, ectx, clamps, part), tracked,
                     timeout_s),
            per_keys(run, lambda part: bounds_statement(unit, ectx, clamps, part), numeric,
                     timeout_s))
        return counts.result_set or [], keyed_rows, probed, values, bounds, bags

    def fold(self, unit: Unit, result) -> None:
        counts, keyed, probed, values, bounds, bags = result
        stats = self.stats
        for edge_type, n in counts:
            stats.add_entities(edge_type, n)
            self.session.count += int(n)
        for edge_type, key, kind, n in keyed:
            stats.add_kind(edge_type, key, kind, n)
        for key, distinct_at_least in probed:
            stats.mark_high_cardinality(key, distinct_at_least)
        for key, *bound in bounds:
            stats.add_bounds(key, bound)
        for key, distinct_here, rows in values:
            stats.add_values(key, distinct_here, rows or [])
        for edge_type, native in bags:
            add_relationship(stats, edge_type, native or {})

    def commit(self) -> Dict[str, Any]:
        return {"accumulator": accumulator(self.stats, self.state)}


def add_relationship(stats: CatalogStats, edge_type: str, native: Dict[str, Any]) -> None:
    """One relationship's properties, as its readers take them from
    ``properties(e)``, counted under its type (the relationship itself is
    counted apart): a key its bag held is ``residual`` too."""
    properties, bag = edge_user_properties(edge_type, native)
    stats.add_properties(edge_type, properties, frozenset(), 1, frozenset(bag), catalog.VALUES_MAX)


def accumulator(stats: CatalogStats, state: Dict[str, Any]) -> str:
    """The session's accumulator: the statistics (``CatalogStats.from_json``
    reads them) and the edge context's state beside them."""
    held = json.loads(stats.to_json())
    held["edgeState"] = state
    return json.dumps(held, separators=(",", ":"))


def state_of(raw: Optional[str]) -> Dict[str, Any]:
    """The edge context's state a session's accumulator keeps."""
    return (json.loads(raw).get("edgeState") or {}) if raw else {}
