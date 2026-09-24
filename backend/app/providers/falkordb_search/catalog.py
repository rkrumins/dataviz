"""A view's properties, exactly: every key its entities carry, on how many,
stored as which kinds, with which values.

Discovery reads the first 200 nodes of each label, so a key or a value past
them is invisible and every count it gives is a sample's. The catalog reads
every entity in the view's scope instead — the search engine's units, one
unit at a time, in as many requests as it takes (``POST /search/catalog``,
followed like a search) — and keeps, per key:

* how many entities carry it, per entity type;
* the kinds its values are stored as (``typeOf``: Integer, Float, String,
  Boolean, List) — a key stored as two kinds compares as two;
* its numeric range, exactly: the minimum and maximum of the negative and
  the non-negative values are taken apart, because FalkorDB's ``min`` and
  ``max`` wrap at the int64 extremes (S0_FINDINGS §3);
* its values and how many entities hold each (a list counts per element) —
  while it has at most ``VALUES_MAX`` distinct values. Past that it is
  high-cardinality (names, identifiers, hashes, timestamps): its values are
  not listed and its distinct count is a floor. A statistic, never a cap on
  what a search finds.

Keys the platform writes (``platform_property_names``) are left out. Keys
demoted to ``propertiesRaw`` past the native-key budget are read from it and
counted like the rest (``residual``). Tags — stored as one JSON string per
entity — are counted per tag, from each distinct tag set once.

A complete catalog is kept per view scope and data version, and served for
``catalog_reuse_seconds`` after the data changes — marked as of when it was
read — so a busy graph is not rescanned on every open.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from datetime import datetime, timezone
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from backend.app.providers.falkordb_deep_search import (
    _RESERVED_NODE_KEYS,
    _build_compiler_for_provider,
)
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
from backend.app.providers.falkordb_search.plan import Context, Unit, make_plan, match_statement
from backend.app.providers.falkordb_search.session import (
    COMPLETE,
    FAILED,
    Session,
    SessionStore,
    store_for,
)
from backend.app.services.deep_search import (
    SearchFailed,
    SearchRunContext,
    get_deep_search_settings,
)
from backend.common.models.search import MatchAllPredicate, SearchQuery, SearchScope

#: Distinct values a key's values are listed and counted for; past it the
#: key is high-cardinality.
VALUES_MAX = 1000

#: Values listed per key in an answer, fullest first.
VALUES_SHOWN = 20

#: Distinct tag sets read per unit; past it the tags are not counted.
TAG_SETS_MAX = 10000

#: Entities a key never seen before is first sampled on: one holding more
#: than ``VALUES_MAX`` distinct values among them is high-cardinality at
#: once, before its values are counted over a whole unit.
PROBE_ENTITIES = 2000


# ---------------------------------------------------------------------------
# What the scan keeps
# ---------------------------------------------------------------------------

class CatalogStats:
    """The catalog so far: entities per label, and per key its entities per
    label, its kinds, its numeric range, its residual count and — while it
    has few enough — its values."""

    def __init__(self, entities: Optional[Dict[str, int]] = None,
                 keys: Optional[Dict[str, Dict[str, Any]]] = None,
                 tags: Optional[Dict[str, int]] = None, tagged: int = 0,
                 tags_counted: bool = True) -> None:
        self.entities: Dict[str, int] = entities or {}
        self.keys: Dict[str, Dict[str, Any]] = keys or {}
        self.tags: Dict[str, int] = tags or {}
        self.tagged = tagged
        # False once a unit held more distinct tag sets than are read.
        self.tags_counted = tags_counted

    @classmethod
    def from_json(cls, raw: Optional[str]) -> "CatalogStats":
        if not raw:
            return cls()
        d = json.loads(raw)
        return cls(d.get("entities") or {}, d.get("keys") or {}, d.get("tags") or {},
                   int(d.get("tagged") or 0), bool(d.get("tagsCounted", True)))

    def to_json(self) -> str:
        return json.dumps({"entities": self.entities, "keys": self.keys, "tags": self.tags,
                           "tagged": self.tagged, "tagsCounted": self.tags_counted},
                          separators=(",", ":"))

    def add_tag_sets(self, rows: List[List[Any]]) -> None:
        """One unit's distinct stored tag sets and the entities holding
        each — every tag in a set counts those entities once."""
        if len(rows) > TAG_SETS_MAX:
            self.tags_counted = False
        if not self.tags_counted:
            return
        for stored, n in rows:
            tags = _tags_of(stored)
            if not tags:
                continue
            self.tagged += int(n)
            for tag in tags:
                self.tags[tag] = self.tags.get(tag, 0) + int(n)

    def _key(self, key: str) -> Dict[str, Any]:
        return self.keys.setdefault(key, {
            "labels": {}, "kinds": {}, "range": [None, None, None, None],
            "values": {}, "distinct": 0, "residual": 0,
        })

    def high_cardinality(self, key: str) -> bool:
        return key in self.keys and self.keys[key]["values"] is None

    def mark_high_cardinality(self, key: str, distinct_at_least: int) -> None:
        self._too_many(self._key(key), int(distinct_at_least))

    def add_entities(self, label: str, n: int) -> None:
        self.entities[label or ""] = self.entities.get(label or "", 0) + int(n)

    def add_kind(self, label: str, key: str, kind: str, n: int) -> None:
        """``n`` entities of ``label`` hold ``key`` as ``kind``."""
        k = self._key(key)
        k["labels"][label or ""] = k["labels"].get(label or "", 0) + int(n)
        k["kinds"][kind] = k["kinds"].get(kind, 0) + int(n)

    def add_bounds(self, key: str, bounds: List[Any]) -> None:
        """[least ≥ 0, greatest ≥ 0, least < 0, greatest < 0] of some of
        ``key``'s numeric values."""
        held = self._key(key)["range"]
        for i, value in enumerate(bounds):
            if value is None or isinstance(value, bool):
                continue
            if held[i] is None:
                held[i] = value
            elif i % 2 == 0:
                held[i] = min(held[i], value)
            else:
                held[i] = max(held[i], value)

    def add_values(self, key: str, distinct_here: int, rows: List[List[Any]]) -> None:
        """One unit's ``[kind, value, entities]`` for ``key`` — all of them,
        unless the unit alone held more than ``VALUES_MAX`` distinct."""
        k = self._key(key)
        if k["values"] is None:
            k["distinct"] = max(k["distinct"], int(distinct_here))
            return
        if distinct_here > VALUES_MAX:
            self._too_many(k, int(distinct_here))
            return
        for kind, value, n in rows:
            slot = _slot(kind, value)
            k["values"][slot] = k["values"].get(slot, 0) + int(n)
        if len(k["values"]) > VALUES_MAX:
            self._too_many(k, len(k["values"]))

    def add_residual(self, label: str, raw: Any, skip: FrozenSet[str]) -> None:
        """One entity's ``propertiesRaw`` — the keys demoted past the
        native-key budget — counted like native ones."""
        try:
            props = json.loads(raw) if isinstance(raw, str) else {}
        except ValueError:
            return
        if not isinstance(props, dict):
            return
        for key, value in props.items():
            kind = _kind_of(value)
            if key in skip or kind is None:
                continue
            self.add_kind(label, key, kind, 1)
            if kind in ("Integer", "Float"):
                self.add_bounds(key, [value, value, None, None] if value >= 0
                                else [None, None, value, value])
            k = self.keys[key]
            k["residual"] += 1
            if k["values"] is not None:
                elements = value if kind == "List" else [value]
                slots = {_slot(_kind_of(e) or "Null", e) for e in elements}
                for slot in slots:
                    k["values"][slot] = k["values"].get(slot, 0) + 1
                if len(k["values"]) > VALUES_MAX:
                    self._too_many(k, len(k["values"]))

    @staticmethod
    def _too_many(k: Dict[str, Any], seen: int) -> None:
        k["distinct"] = max(k["distinct"], seen, len(k["values"] or {}))
        k["values"] = None

    def describe(self, key: str, complete: bool) -> Dict[str, Any]:
        k = self.keys[key]
        lo_pos, hi_pos, lo_neg, hi_neg = k["range"]
        values = k["values"]
        listed = []
        if values is not None:
            ranked = sorted(values.items(), key=lambda kv: (-kv[1], kv[0]))
            for slot, n in ranked[:VALUES_SHOWN]:
                kind, value = json.loads(slot)
                listed.append({"value": value, "kind": kind, "count": n})
        return {
            "key": key,
            "count": sum(k["labels"].values()),
            "byEntityType": dict(k["labels"]),
            "kinds": dict(k["kinds"]),
            "min": lo_neg if lo_neg is not None else lo_pos,
            "max": hi_pos if hi_pos is not None else hi_neg,
            "distinct": len(values) if values is not None else k["distinct"],
            "distinctExact": values is not None and complete,
            "values": listed,
            "residual": k["residual"],
        }


def _tags_of(stored: Any) -> List[str]:
    """The distinct tags of a stored tag set: a JSON list (as the provider
    writes it) or a native one."""
    if isinstance(stored, str):
        try:
            stored = json.loads(stored)
        except ValueError:
            return []
    if not isinstance(stored, list):
        return []
    return sorted({str(t) for t in stored if isinstance(t, (str, int, float)) and str(t)})


def _slot(kind: str, value: Any) -> str:
    """A value's identity: its kind with its JSON, so the Integer 1, the
    Float 1.0, the Boolean true and the String "1" stay four values."""
    return json.dumps([kind, value], separators=(",", ":"), sort_keys=True)


def _kind_of(value: Any) -> Optional[str]:
    """``typeOf`` for a value read from JSON."""
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int):
        return "Integer"
    if isinstance(value, float):
        return "Float"
    if isinstance(value, str):
        return "String"
    if isinstance(value, list):
        return "List"
    return None


# ---------------------------------------------------------------------------
# Statements, per unit
# ---------------------------------------------------------------------------

def entities_statement(unit: Unit, ctx: Context, clamps) -> Tuple[str, Dict[str, Any]]:
    head, params = match_statement(unit, ctx, clamps)
    return f"{head} RETURN labels(n)[0], count(n)", params


def keys_statement(unit: Unit, ctx: Context, clamps) -> Tuple[str, Dict[str, Any]]:
    """Every key's entities per label and per kind. (The platform's keys
    are dropped in Python: an ``IN`` list test on every row costs more.)"""
    head, params = match_statement(unit, ctx, clamps)
    return (f"{head} UNWIND keys(n) AS _k "
            "RETURN labels(n)[0], _k, typeOf(n[_k]), count(*)", params)


def probe_statement(unit: Unit, ctx: Context, clamps, keys: List[str]
                    ) -> Tuple[str, Dict[str, Any]]:
    """How many distinct values each of ``keys`` holds among the unit's
    first ``PROBE_ENTITIES`` entities."""
    head, params = match_statement(unit, ctx, clamps)
    params["_keys"] = list(keys)
    params["_probe"] = PROBE_ENTITIES
    return (f"{head} WITH n LIMIT $_probe UNWIND $_keys AS _k "
            "WITH _k, n[_k] AS _v WHERE _v IS NOT NULL "
            "RETURN _k, count(DISTINCT _v)", params)


def bounds_statement(unit: Unit, ctx: Context, clamps, keys: List[str]
                     ) -> Tuple[str, Dict[str, Any]]:
    """The numeric bounds of each of ``keys`` — its negative and its
    non-negative values apart, where ``min`` and ``max`` cannot wrap. Only
    for keys holding numbers: the four aggregates on every row of every key
    cost the key scan three times over."""
    head, params = match_statement(unit, ctx, clamps)
    params["_keys"] = list(keys)
    return (f"{head} UNWIND $_keys AS _k WITH _k, n[_k] AS _v "
            "WHERE typeOf(_v) IN ['Integer', 'Float'] "
            "RETURN _k, min(CASE WHEN _v >= 0 THEN _v END), max(CASE WHEN _v >= 0 THEN _v END), "
            "min(CASE WHEN _v < 0 THEN _v END), max(CASE WHEN _v < 0 THEN _v END)", params)


def values_statement(unit: Unit, ctx: Context, clamps, keys: List[str]
                     ) -> Tuple[str, Dict[str, Any]]:
    """Each key's values and the entities holding each — a list per
    element — cut at ``VALUES_MAX`` + 1, which is how a key shows it has
    more."""
    head, params = match_statement(unit, ctx, clamps)
    params["_keys"] = list(keys)
    params["_cap"] = VALUES_MAX + 1
    return (f"{head} UNWIND $_keys AS _k WITH n, _k, n[_k] AS _v WHERE _v IS NOT NULL "
            "WITH n, _k, CASE WHEN typeOf(_v) = 'List' THEN _v ELSE [_v] END AS _vs "
            "UNWIND _vs AS _e WITH _k, typeOf(_e) AS _t, _e, count(DISTINCT n) AS _c "
            "WITH _k, collect([_t, _e, _c]) AS _vals "
            "RETURN _k, size(_vals), _vals[..$_cap]", params)


def tags_statement(unit: Unit, ctx: Context, clamps) -> Tuple[str, Dict[str, Any]]:
    """The unit's distinct stored tag sets, with the entities holding each —
    usually a handful, however many entities."""
    head, params = match_statement(unit, ctx, clamps)
    params["_tagcap"] = TAG_SETS_MAX + 1
    return (f"{head} WITH n.tags AS _t WHERE _t IS NOT NULL AND _t <> '[]' "
            "RETURN _t, count(*) LIMIT $_tagcap", params)


def residual_statement(unit: Unit, ctx: Context, clamps) -> Tuple[str, Dict[str, Any]]:
    head, params = match_statement(unit, ctx, clamps)
    return (f"{head} WITH n WHERE n.propertiesRaw IS NOT NULL AND n.propertiesRaw <> '{{}}' "
            "RETURN labels(n)[0], n.propertiesRaw", params)


class _CatalogWork:
    """What the catalog takes from each unit, folded into ``CatalogStats``
    — committed with the session, so a unit counts exactly once."""

    def __init__(self, session: Session, ctx: Context, run, skip: FrozenSet[str]) -> None:
        self.session, self.ctx, self.run, self.skip = session, ctx, run, skip
        self.stats = CatalogStats()

    async def begin(self, store: SessionStore) -> None:
        # Read with the lease held: the catalog of the latest commit.
        self.stats = CatalogStats.from_json(await store.load_accumulator(self.session.sid))

    async def unit(self, unit: Unit, timeout_s: float):
        clamps = self.session.clamps
        statements = [entities_statement(unit, self.ctx, clamps),
                      keys_statement(unit, self.ctx, clamps),
                      residual_statement(unit, self.ctx, clamps),
                      tags_statement(unit, self.ctx, clamps)]
        entities, keyed, residual, tag_sets = await asyncio.gather(
            *(self.run(c, p, timeout_s) for c, p in statements))
        keyed_rows = [row for row in keyed.result_set or [] if row[1] not in self.skip]
        keys = {row[1] for row in keyed_rows}
        # A key never seen before is sampled first: one plainly unique per
        # entity (an identifier, a hash, a timestamp) is not worth counting
        # value by value across the whole unit.
        probed: List[List[Any]] = []
        new = sorted(k for k in keys if k not in self.stats.keys)
        if new:
            cypher, params = probe_statement(unit, self.ctx, clamps, new)
            probed = [r for r in (await self.run(cypher, params, timeout_s)).result_set or []
                      if r[1] > VALUES_MAX]
        unique = {r[0] for r in probed}
        tracked = sorted(k for k in keys - unique if not self.stats.high_cardinality(k))
        numeric = sorted({row[1] for row in keyed_rows if row[2] in ("Integer", "Float")})
        second = []
        if tracked:
            second.append(values_statement(unit, self.ctx, clamps, tracked))
        if numeric:
            second.append(bounds_statement(unit, self.ctx, clamps, numeric))
        answers = await asyncio.gather(*(self.run(c, p, timeout_s) for c, p in second))
        values = answers.pop(0).result_set or [] if tracked else []
        bounds = answers.pop(0).result_set or [] if numeric else []
        return (entities.result_set or [], keyed_rows, probed, values, bounds,
                residual.result_set or [], tag_sets.result_set or [])

    def fold(self, unit: Unit, result) -> None:
        entities, keyed, probed, values, bounds, residual, tag_sets = result
        for label, n in entities:
            self.stats.add_entities(label, n)
            self.session.count += int(n)
        for label, key, kind, n in keyed:
            self.stats.add_kind(label, key, kind, n)
        for key, distinct_at_least in probed:
            self.stats.mark_high_cardinality(key, distinct_at_least)
        for key, *bound in bounds:
            self.stats.add_bounds(key, bound)
        for key, distinct_here, rows in values:
            self.stats.add_values(key, distinct_here, rows or [])
        for label, raw in residual:
            self.stats.add_residual(label, raw, self.skip)
        self.stats.add_tag_sets(tag_sets)

    def commit(self) -> Dict[str, Any]:
        return {"accumulator": self.stats.to_json()}


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def execute_catalog_session(provider, scope: SearchScope, *, context: SearchRunContext,
                                  wait_ms: int, session_id: Optional[str] = None,
                                  refresh: bool = False) -> Dict[str, Any]:
    """The catalog of ``scope`` (resolved by the caller): this request's
    share of the scan, answered with everything read so far. A client
    follows it with the returned ``sessionId`` until it is complete."""
    from backend.app.providers.falkordb_search.engine import (
        _GRACE_S,
        _advance,
        _containment,
        _find,
        request_deadline,
        session_id as session_id_of,
        unit_budget,
    )

    settings = get_deep_search_settings()
    # A unit reads in more than one pass: two statements' budget.
    unit_s = unit_budget(settings, passes=2)
    deadline = request_deadline(time.monotonic(), wait_ms / 1000.0, unit_s)
    store = store_for(provider)
    name = f"catalog:{context.scope_hash}"

    # The latest complete catalog of this scope: this data's, or — within
    # the reuse window — a recent one, marked as of when it was read.
    if not session_id and not refresh:
        latest_sid = await store.pointed(name)
        latest = await store.load(latest_sid) if latest_sid else None
        if (latest is not None and latest.status == COMPLETE
                and latest.scope_hash == context.scope_hash
                and (latest.data_version == context.data_version
                     or time.time() - latest.created < settings.catalog_reuse_seconds)):
            return await _answer(store, latest, context)

    admit = context.admit

    async def run(cypher: str, params: Dict[str, Any], timeout_s: float):
        async with (admit() if admit else contextlib.nullcontext()):
            return await provider._ro_query(cypher, params=params, timeout=timeout_s)

    query_id = f"catalog:{context.scope_hash}"
    sid = session_id_of(query_id, context.data_version, None)
    session = await _find(store, session_id, query_id, None) or await store.load(sid)
    created = False
    if session is None or session.status == FAILED:
        query = SearchQuery(predicate=MatchAllPredicate(), scope=scope)
        compiler = _build_compiler_for_provider(provider)
        compiler.compile(query.predicate)
        plan = await make_plan(
            provider, query, compiler,
            run=lambda c, p: run(c, p, max(1.0, settings.chunk_timeout_ms / 1000.0)),
            width=settings.chunk_width, walk_max=settings.walk_max,
            timeout_s=max(0.5, deadline + _GRACE_S - time.monotonic()),
        )
        session = Session.start(sid, query_id, context.data_version, None, 0, plan,
                                scope_hash=context.scope_hash)
        created = True

    ctx = Context(
        where="true", params={}, sort=SortSpec((SortKey("n.urn"),)),
        containment=_containment(provider), max_depth=int(scope.max_depth or 12),
        visible=(list(scope.visible_urns or []) if scope.scope_mode == "visible" else None),
    )
    work = _CatalogWork(session, ctx, run, _skipped_keys())
    session = await _advance(session, created, store, work, deadline, settings,
                             ttl_s=settings.catalog_ttl_seconds, unit_s=unit_s)
    if session.status == FAILED:
        raise SearchFailed(f"catalog failed: {session.error}")
    if session.status == COMPLETE:
        await store.point(name, session.sid, settings.catalog_ttl_seconds)
    return await _answer(store, session, context)


def _skipped_keys() -> FrozenSet[str]:
    """What the platform writes on every node — never a user's property."""
    from backend.app.providers.falkordb_provider import platform_property_names
    return frozenset(_RESERVED_NODE_KEYS) | frozenset(platform_property_names())


async def _answer(store: SessionStore, session: Session, context: SearchRunContext
                  ) -> Dict[str, Any]:
    stats = CatalogStats.from_json(await store.load_accumulator(session.sid))
    complete = session.status == COMPLETE
    properties = sorted((stats.describe(key, complete) for key in stats.keys),
                        key=lambda p: (-p["count"], p["key"]))
    return {
        "sessionId": session.sid,
        "status": "complete" if complete else "running",
        "progress": {"scanned": session.scanned, "total": max(session.total, session.scanned),
                     "matched": session.count},
        "dataVersion": session.data_version,
        "stale": bool(context.data_version) and session.data_version != context.data_version,
        "asOf": datetime.fromtimestamp(session.created, tz=timezone.utc).isoformat(),
        "entities": session.count,
        "entityTypes": [{"type": label, "count": n} for label, n in
                        sorted(stats.entities.items(), key=lambda kv: (-kv[1], kv[0]))],
        "properties": properties,
        "tags": [{"tag": tag, "count": n} for tag, n in
                 sorted(stats.tags.items(), key=lambda kv: (-kv[1], kv[0]))]
        if stats.tags_counted else [],
        "tagged": stats.tagged if stats.tags_counted else None,
        "notes": list(session.notes),
    }
