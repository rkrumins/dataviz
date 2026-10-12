"""The property bag's Postgres home: predicates on any key, spending no
FalkorDB attribute id.

FalkorDB numbers every distinct property name in a graph with a 16-bit id and
never frees one, so a source whose records carry ~65,000 keys fills the name
table and its rollups can no longer be written (``docs/PROPERTY_STORAGE.md``;
a production graph sits at 65,534 of 65,534 today). This module is the
Postgres half of the fix: the COMPLETE user bag of every node lives in
``propidx.node_props``, one LIST partition per physical graph, and every
predicate, sort, distinct and key-discovery answer is computed here and enters
FalkorDB as a per-label URN seek. The graph keeps topology and a constant set
of ~25 attribute names.

The alembic revision ``20260916_1000_property_index`` owns the DDL; this owns
the statements against it. Two rules the SQL below does not bend:

* **Bound parameters only.** No value is ever formatted into a statement. The
  two places Postgres refuses a parameter outright — a partition bound and an
  index expression — carry their values in through ``set_config`` /
  ``current_setting`` and ``format('%I','%L')`` inside a ``DO`` block rather
  than through f-strings. Identifiers are sha1 digests, and are still quoted.
* **No ``:name::type``.** SQLAlchemy's ``text()`` bind scanner stops a name at
  the first colon, so ``:urns::text[]`` silently binds ``:urn`` and leaves a
  stray ``s::text[]`` in the SQL. Every cast is spelled ``CAST(:n AS type)``.

Each method opens its own session from the injected factory — an async context
manager yielding an ``AsyncSession``, e.g. ``engine.get_jobs_session`` for the
projector; the request path needs the GRAPH_READ equivalent, which does not
exist yet (``get_graph_read_db_session`` is a FastAPI dependency, not a context
manager) and lands with the wiring slice. Each method sets
``statement_timeout`` from the caller's remaining budget when it is given one,
commits its writes, and swallows nothing.
"""
from __future__ import annotations

import hashlib
import json
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Iterable, Mapping, Sequence

from sqlalchemy import text

SCHEMA = "propidx"

# URN lists travel to Postgres in chunks this size: one array parameter per
# round trip that the planner still handles as a hashed ANY, and a bounded
# statement for the post-filter, whose candidate sets are capped far above it.
URN_CHUNK = 10_000

# Values kept per (label, key) for discovery.
KEY_SAMPLES = 5


def physical_graph_key(host: Any, port: Any, graph_name: str) -> str:
    """The identity a row is keyed by — the byte-for-byte twin of
    ``FalkorDBProvider._cache_ns``, from a RAW config host and port.

    ``graph_name`` alone is not an identity: it defaults to ``nexus_lineage``
    and DB uniqueness is (workspace, provider, graph_name), so the same name
    can be two different physical graphs on two FalkorDB instances.

    The host is resolved, not used as given: ``_cache_ns`` reads ``self._host``,
    which the provider set from ``_normalize_falkordb_host`` (``localhost`` and
    a missing host both become ``127.0.0.1``; both become
    ``$FALKORDB_DOCKER_LOCALHOST_REWRITE`` when it is set), and both provider
    construction paths resolve through ``resolve_falkordb_target`` first. Doing
    less here files a dev or docker-rewrite deployment's rows under a key
    nothing reads back. The import is function-scope so the module-scope
    direction stays one-way — the provider imports this module, not the
    reverse. The parity is pinned by a test against a real provider instance.
    """
    from .falkordb_provider import resolve_falkordb_target

    host, port = resolve_falkordb_target(host, port)
    return f"{host or ''}:{port or ''}:{graph_name}"


def partition_name(graph_key: str) -> str:
    """The LIST partition holding one physical graph's rows.

    A digest, not the key itself: graph keys carry hosts, colons and dots and
    run past Postgres' 63-byte identifier limit, and the name has to be
    reproducible from the key alone by every writer, reader and the purge path.
    """
    return "np_" + hashlib.sha1(graph_key.encode("utf-8")).hexdigest()[:16]


def content_hash(props: Mapping[str, Any]) -> str:
    """Canonical-JSON digest of a bag, so a re-upsert of an unchanged bag is a
    no-op instead of a row version, a WAL record and a GIN update.

    Key order is not identity — ``sort_keys`` — and non-JSON values (datetimes,
    Decimals) stringify exactly as the writers send them to the graph.
    """
    canonical = json.dumps(props, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.blake2b(canonical.encode("utf-8"), digest_size=16).hexdigest()


def _dumps(value: Any) -> str:
    """JSON text for a ``jsonb`` array element (asyncpg encodes jsonb from str)."""
    return json.dumps(value, default=str)


def _check_binds(params: Mapping[str, Any]) -> None:
    """``_pi_``-prefixed names are this module's own scope binds. A compiler
    fragment that used one would have its value silently replaced by the scope
    — a wrong answer with no error — so it is refused instead."""
    clash = sorted(k for k in params if k.startswith("_pi_"))
    if clash:
        raise ValueError(f"compiler fragment uses reserved bind name(s): {clash}")


def _chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _like_prefix(q: str) -> str:
    """``q`` as a LIKE prefix pattern with its wildcards neutralised, so a key
    typeahead for ``100%`` searches for that key and not for everything."""
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + "%"


# SET LOCAL takes no parameters (it is parsed, not planned), and the budget is
# a value like any other. set_config(..., is_local => true) IS SET LOCAL, and
# keeps it bound.
_STATEMENT_TIMEOUT = text("SELECT set_config('statement_timeout', :timeout_ms, true)")

# A partition bound must be a constant — a Param never reduces to one — so the
# graph key reaches the DDL through a GUC and format('%L'), still bound.
_SET_PARTITION_GUCS = text(
    "SELECT set_config('propidx.partition', :partition, true),"
    "       set_config('propidx.graph_key', :graph_key, true)"
)
# ``CREATE TABLE IF NOT EXISTS ... PARTITION OF`` is NOT atomic: the catalog
# check happens before the parent's ACCESS EXCLUSIVE lock is taken, so two
# workers seeding one graph both pass it and one raises DuplicateTable. The
# advisory lock (same key, same transaction) serialises them.
_LOCK_PARTITION = text(
    "SELECT pg_advisory_xact_lock(hashtext(current_setting('propidx.partition')))"
)
_CREATE_PARTITION = text(
    """
DO $do$ BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS propidx.%I PARTITION OF propidx.node_props '
    'FOR VALUES IN (%L)',
    current_setting('propidx.partition'), current_setting('propidx.graph_key'));
END $do$
"""
)

# The upsert. One statement per chunk: unnest turns the parameter arrays into
# rows, and the WHERE on the conflict action is what makes a re-seed of an
# unchanged bag free — without it every row would be rewritten every load. The
# guard covers every column the row stores, not just the digest: content_hash
# is over ``props`` alone, so a label or tag edit at the same epoch would
# otherwise be skipped and the stale value kept forever.
_UPSERT_ROWS = text(
    """
INSERT INTO propidx.node_props
       (graph_key, urn, entity_type, props, tags, content_hash, load_epoch, updated_at)
SELECT :graph_key, u.urn, u.entity_type, u.props, u.tags, u.content_hash, :epoch, now()
FROM unnest(CAST(:urns AS text[]), CAST(:types AS text[]), CAST(:props AS jsonb[]),
            CAST(:tags AS jsonb[]), CAST(:hashes AS text[]))
     AS u(urn, entity_type, props, tags, content_hash)
ON CONFLICT (graph_key, urn) DO UPDATE SET
  entity_type  = EXCLUDED.entity_type,
  props        = EXCLUDED.props,
  tags         = EXCLUDED.tags,
  content_hash = EXCLUDED.content_hash,
  load_epoch   = EXCLUDED.load_epoch,
  updated_at   = now()
WHERE node_props.content_hash IS DISTINCT FROM EXCLUDED.content_hash
   OR node_props.entity_type IS DISTINCT FROM EXCLUDED.entity_type
   OR node_props.tags IS DISTINCT FROM EXCLUDED.tags
   OR node_props.load_epoch <> EXCLUDED.load_epoch
"""
)

_UPSERT_KEYS = text(
    """
INSERT INTO propidx.prop_keys (graph_key, entity_type, key, kinds, samples, refreshed_at)
SELECT :graph_key, u.entity_type, u.key,
       ARRAY(SELECT jsonb_array_elements_text(u.kinds)), u.samples, now()
FROM unnest(CAST(:types AS text[]), CAST(:keys AS text[]), CAST(:kinds AS jsonb[]),
            CAST(:samples AS jsonb[]))
     AS u(entity_type, key, kinds, samples)
ON CONFLICT (graph_key, entity_type, key) DO UPDATE SET
  kinds = EXCLUDED.kinds, samples = EXCLUDED.samples, refreshed_at = now()
"""
)

# Discovery is recomputed, not accumulated: a key that no node carries any more
# must stop being offered, and node_count must be the count, not a running sum.
_DELETE_KEYS = text("DELETE FROM propidx.prop_keys WHERE graph_key = :graph_key")
_REFRESH_KEYS = text(
    """
INSERT INTO propidx.prop_keys
       (graph_key, entity_type, key, node_count, kinds, samples, refreshed_at)
SELECT :graph_key, n.entity_type, e.key, count(*),
       array_agg(DISTINCT jsonb_typeof(e.value)),
       to_jsonb((array_agg(DISTINCT e.value))[1 : CAST(:samples AS int)]),
       now()
FROM propidx.node_props AS n, LATERAL jsonb_each(n.props) AS e(key, value)
WHERE n.graph_key = :graph_key
GROUP BY n.entity_type, e.key
"""
)

_DELETE_URNS = text(
    "DELETE FROM propidx.node_props "
    "WHERE graph_key = :graph_key AND urn = ANY(CAST(:urns AS text[]))"
)
_SWEEP_EPOCH = text(
    "DELETE FROM propidx.node_props "
    "WHERE graph_key = :graph_key AND load_epoch < :epoch"
)
_WIPE_ROWS = text("DELETE FROM propidx.node_props WHERE graph_key = :graph_key")

_GET_STATE = text(
    """
SELECT storage_version, status, load_epoch, declared_ready, row_count, progress,
       last_built_at, last_verified_at, last_error
FROM propidx.graph_state WHERE graph_key = :graph_key
"""
)
# COALESCE on the conflict action so a caller can move one field without
# reading the row first and racing another writer for the rest of it. The
# load_epoch cast is load-bearing: the bare literal 0 would type the parameter
# int4 for the whole statement and reject a bigint watermark.
_SET_STATE = text(
    """
INSERT INTO propidx.graph_state
       (graph_key, storage_version, status, load_epoch, row_count, last_error, updated_at)
VALUES (:graph_key, COALESCE(:storage_version, 2), COALESCE(:status, 'building'),
        COALESCE(CAST(:load_epoch AS bigint), 0), :row_count, :last_error, now())
ON CONFLICT (graph_key) DO UPDATE SET
  storage_version = COALESCE(:storage_version, graph_state.storage_version),
  status          = COALESCE(:status, graph_state.status),
  load_epoch      = COALESCE(CAST(:load_epoch AS bigint), graph_state.load_epoch),
  row_count       = COALESCE(:row_count, graph_state.row_count),
  last_error      = :last_error,
  updated_at      = now()
"""
)
_BEGIN_LOAD_NEXT = text(
    """
INSERT INTO propidx.graph_state (graph_key, storage_version, status, load_epoch)
VALUES (:graph_key, 2, 'building', 1)
ON CONFLICT (graph_key) DO UPDATE SET
  status = 'building', load_epoch = graph_state.load_epoch + 1, updated_at = now()
RETURNING load_epoch
"""
)
# The projector's epoch is the versioning watermark ``to_seq``, picked before
# the graph delete and reused by the sweep, so it is the caller's to give.
# GREATEST on the conflict action keeps a replayed seed from moving the epoch
# backwards and resurrecting rows an later load already swept.
_BEGIN_LOAD_AT = text(
    """
INSERT INTO propidx.graph_state (graph_key, storage_version, status, load_epoch)
VALUES (:graph_key, 2, 'building', CAST(:epoch AS bigint))
ON CONFLICT (graph_key) DO UPDATE SET
  status = 'building',
  load_epoch = GREATEST(graph_state.load_epoch, CAST(:epoch AS bigint)),
  updated_at = now()
RETURNING load_epoch
"""
)

_FETCH_VALUES = text(
    """
SELECT urn,
       (SELECT COALESCE(jsonb_object_agg(k, props -> k), '{}'::jsonb)
        FROM unnest(CAST(:keys AS text[])) AS k WHERE props ? k) AS vals
FROM propidx.node_props
WHERE graph_key = :graph_key AND urn = ANY(CAST(:urns AS text[]))
"""
)

# ``ix_np_ci_gin`` indexes the EXPRESSION propidx.ci(props), so only a
# predicate written over that expression can use it — ``props ? :key`` seq
# scans the partition. ``ci`` case-folds string VALUES and leaves the key set
# verbatim, so existence over it is the same answer. The PROJECTION stays on
# raw ``props``: that is the value the caller asked for.
_DISTINCT = text(
    """
SELECT DISTINCT props -> :key AS value
FROM propidx.node_props
WHERE graph_key = :graph_key AND propidx.ci(props) ? :key
ORDER BY 1
LIMIT :limit
"""
)

_KEY_TYPEAHEAD = text(
    """
SELECT key, sum(node_count) AS node_count
FROM propidx.prop_keys
WHERE graph_key = :graph_key AND key LIKE :pattern ESCAPE '\\'
GROUP BY key
ORDER BY node_count DESC NULLS LAST, key
LIMIT :limit
"""
)

_UPSERT_HOT_INDEX = text(
    """
INSERT INTO propidx.hot_indexes (graph_key, key, kind, index_name, status)
VALUES (:graph_key, :key, :kind, :index_name, 'ready')
ON CONFLICT (graph_key, key, kind) DO UPDATE SET
  index_name = EXCLUDED.index_name, status = EXCLUDED.status
"""
)
_SET_HOT_INDEX_GUCS = text(
    "SELECT set_config('propidx.partition', :partition, true),"
    "       set_config('propidx.index_name', :index_name, true),"
    "       set_config('propidx.key', :key, true)"
)
# An index expression cannot carry a parameter either, so the key comes in the
# same way the partition bound does. Quotes are doubled because the format
# string is itself a literal inside the DO body.
_HOT_INDEX_DDL: dict[str, str] = {
    "text": (
        "'CREATE INDEX IF NOT EXISTS %I ON propidx.%I ((props ->> %L) text_pattern_ops)',"
        " current_setting('propidx.index_name'), current_setting('propidx.partition'),"
        " current_setting('propidx.key')"
    ),
    "numeric": (
        "'CREATE INDEX IF NOT EXISTS %I ON propidx.%I (((props ->> %L)::numeric)) "
        "WHERE jsonb_typeof(props -> %L) = ''number''',"
        " current_setting('propidx.index_name'), current_setting('propidx.partition'),"
        " current_setting('propidx.key'), current_setting('propidx.key')"
    ),
}

# ``trgm`` is deliberately absent: ``gin_trgm_ops`` needs the ``pg_trgm``
# extension, which the landed revision does not create (its docstring defers it
# to the phase-2 trigram hot index). The DDL would fail at runtime with an
# opaque catalog error, so the kind is refused before any SQL instead.


class PostgresPropertyIndex:
    """Every ``propidx`` statement for one physical graph.

    One instance per (graph, session factory); it holds no session, no
    connection and no cached state, so it is safe to build per request and per
    writer batch.
    """

    def __init__(self, graph_key: str, session_factory: Any) -> None:
        self._graph_key = graph_key
        self._session_factory = session_factory
        self._partition = partition_name(graph_key)

    @property
    def graph_key(self) -> str:
        return self._graph_key

    @asynccontextmanager
    async def _session(self, remaining_s: float | None) -> AsyncIterator[Any]:
        async with self._session_factory() as session:
            if remaining_s is not None:
                # Milliseconds as text: set_config's third argument is text, and
                # a floor of 1 ms means an exhausted budget fails fast instead of
                # reading 0 — which Postgres takes as "no timeout at all".
                await session.execute(
                    _STATEMENT_TIMEOUT,
                    {"timeout_ms": str(max(1, int(remaining_s * 1000)))},
                )
            yield session

    # ---- writes -----------------------------------------------------------

    async def ensure_partition(self, *, remaining_s: float | None = None) -> None:
        """Create this graph's LIST partition if it is not there yet."""
        async with self._session(remaining_s) as session:
            await session.execute(
                _SET_PARTITION_GUCS,
                {"partition": self._partition, "graph_key": self._graph_key},
            )
            await session.execute(_LOCK_PARTITION)
            await session.execute(_CREATE_PARTITION)
            await session.commit()

    async def upsert_rows(
        self,
        rows: Sequence[Mapping[str, Any]],
        epoch: int,
        *,
        chunk_size: int = 1_000,
        remaining_s: float | None = None,
    ) -> int:
        """Write bags. ``rows`` are ``{urn, entity_type, props, tags}``;
        ``chunk_size`` is the caller's batch size (the writers pass their save
        batch). Returns the rows actually written — a re-seed of unchanged bags
        at the same epoch writes none.
        """
        rows = list(rows)
        written = 0
        async with self._session(remaining_s) as session:
            for chunk in _chunks(rows, chunk_size):
                result = await session.execute(
                    _UPSERT_ROWS,
                    {
                        "graph_key": self._graph_key,
                        "epoch": epoch,
                        "urns": [r["urn"] for r in chunk],
                        "types": [r["entity_type"] for r in chunk],
                        "props": [_dumps(r["props"]) for r in chunk],
                        "tags": [_dumps(r.get("tags") or []) for r in chunk],
                        "hashes": [content_hash(r["props"]) for r in chunk],
                    },
                )
                written += max(result.rowcount or 0, 0)
            await session.commit()
        return written

    async def upsert_keys(
        self,
        rows: Sequence[Mapping[str, Any]],
        *,
        remaining_s: float | None = None,
    ) -> None:
        """Register ``{entity_type, key, kinds, samples}`` as the writers see
        them, so a key is discoverable before the next ``refresh_keys`` — which
        is what puts the exact ``node_count`` on it.
        """
        rows = list(rows)
        if not rows:
            return
        async with self._session(remaining_s) as session:
            await session.execute(
                _UPSERT_KEYS,
                {
                    "graph_key": self._graph_key,
                    "types": [r["entity_type"] for r in rows],
                    "keys": [r["key"] for r in rows],
                    "kinds": [_dumps(list(r.get("kinds") or [])) for r in rows],
                    "samples": [_dumps(list(r.get("samples") or [])) for r in rows],
                },
            )
            await session.commit()

    async def refresh_keys(self, *, remaining_s: float | None = None) -> None:
        """Recompute key discovery for the graph from the bags themselves.

        A FULL-GRAPH recompute: the scan expands to nodes x keys and
        ``array_agg(DISTINCT e.value)`` materialises every distinct value of a
        group before the sample slice throws all but ``KEY_SAMPLES`` away. Give
        it a budget on a large graph.
        """
        async with self._session(remaining_s) as session:
            await session.execute(_DELETE_KEYS, {"graph_key": self._graph_key})
            await session.execute(
                _REFRESH_KEYS,
                {"graph_key": self._graph_key, "samples": KEY_SAMPLES},
            )
            await session.commit()

    async def delete_urns(
        self, urns: Sequence[str], *, remaining_s: float | None = None
    ) -> int:
        """Drop rows for deleted nodes. Returns how many went."""
        urns = list(urns)
        deleted = 0
        async with self._session(remaining_s) as session:
            for chunk in _chunks(urns, URN_CHUNK):
                result = await session.execute(
                    _DELETE_URNS, {"graph_key": self._graph_key, "urns": list(chunk)}
                )
                deleted += max(result.rowcount or 0, 0)
            await session.commit()
        return deleted

    async def sweep_epoch(self, epoch: int, *, remaining_s: float | None = None) -> int:
        """Drop everything a full seed did not rewrite — rows below the seed's
        epoch are nodes that no longer exist. Run before the watermark
        publishes, or the index answers for a graph that has moved on.
        """
        async with self._session(remaining_s) as session:
            result = await session.execute(
                _SWEEP_EPOCH, {"graph_key": self._graph_key, "epoch": epoch}
            )
            await session.commit()
        return max(result.rowcount or 0, 0)

    async def wipe(self, *, remaining_s: float | None = None) -> None:
        """Empty the graph's rows and its key discovery, leaving the partition
        and the state row (the state row is routing truth and survives a
        rebuild).
        """
        async with self._session(remaining_s) as session:
            await session.execute(_WIPE_ROWS, {"graph_key": self._graph_key})
            await session.execute(_DELETE_KEYS, {"graph_key": self._graph_key})
            await session.commit()

    async def get_state(
        self, *, remaining_s: float | None = None
    ) -> dict[str, Any] | None:
        async with self._session(remaining_s) as session:
            row = (await session.execute(_GET_STATE, {"graph_key": self._graph_key})).first()
        if row is None:
            return None
        # jsonb columns arrive decoded: SQLAlchemy's asyncpg dialect installs a
        # json/jsonb codec on every connection (setup_asyncpg_jsonb_codec).
        return dict(row._mapping)

    async def set_state(
        self,
        *,
        storage_version: int | None = None,
        status: str | None = None,
        load_epoch: int | None = None,
        row_count: int | None = None,
        last_error: str | None = None,
        remaining_s: float | None = None,
    ) -> None:
        """Move the routing row. Omitted fields keep their stored value;
        ``last_error`` is written as given, so ``None`` clears it.
        """
        async with self._session(remaining_s) as session:
            await session.execute(
                _SET_STATE,
                {
                    "graph_key": self._graph_key,
                    "storage_version": storage_version,
                    "status": status,
                    "load_epoch": load_epoch,
                    "row_count": row_count,
                    "last_error": last_error,
                },
            )
            await session.commit()

    async def begin_load(
        self, epoch: int | None = None, *, remaining_s: float | None = None
    ) -> int:
        """Mark the graph building and return the epoch its rows carry — what
        tells a full seed's rows from the previous load's.

        A caller with a watermark (the projector's ``to_seq``, picked before
        ``client.delete()``) passes it and it is stored. A direct load with no
        watermark passes nothing and gets ``load_epoch + 1``.
        """
        async with self._session(remaining_s) as session:
            if epoch is None:
                result = await session.execute(
                    _BEGIN_LOAD_NEXT, {"graph_key": self._graph_key}
                )
            else:
                result = await session.execute(
                    _BEGIN_LOAD_AT, {"graph_key": self._graph_key, "epoch": epoch}
                )
            stored = result.scalar_one()
            await session.commit()
        return int(stored)

    async def end_load(self, epoch: int, *, remaining_s: float | None = None) -> None:
        """Sweep what the load did not rewrite, recompute discovery, publish.

        ``remaining_s`` is the budget for all three legs together, not for each
        of them — the sweep's time is time ``refresh_keys`` no longer has.
        """
        deadline = None if remaining_s is None else time.monotonic() + remaining_s

        def left() -> float | None:
            return None if deadline is None else max(0.0, deadline - time.monotonic())

        await self.sweep_epoch(epoch, remaining_s=left())
        await self.refresh_keys(remaining_s=left())
        await self.set_state(
            storage_version=2, status="ready", load_epoch=epoch, remaining_s=left()
        )

    async def create_hot_index(
        self, key: str, kind: str, *, remaining_s: float | None = None
    ) -> str:
        """Promote one hot key to an expression index on this graph's partition
        (``text`` for equality and prefix, ``numeric`` for ranges, ``trgm`` for
        contains) and record it. Returns the index name.
        """
        if kind == "trgm":
            raise NotImplementedError(
                "trgm hot indexes need pg_trgm, created by the phase-2 revision"
            )
        body = _HOT_INDEX_DDL[kind]
        index_name = "hx_" + hashlib.sha1(
            f"{self._graph_key}\0{key}\0{kind}".encode("utf-8")
        ).hexdigest()[:16]
        async with self._session(remaining_s) as session:
            await session.execute(
                _SET_HOT_INDEX_GUCS,
                {
                    "partition": self._partition,
                    "index_name": index_name,
                    "key": key,
                },
            )
            await session.execute(text(f"DO $do$ BEGIN EXECUTE format({body}); END $do$"))
            await session.execute(
                _UPSERT_HOT_INDEX,
                {
                    "graph_key": self._graph_key,
                    "key": key,
                    "kind": kind,
                    "index_name": index_name,
                },
            )
            await session.commit()
        return index_name

    # ---- reads ------------------------------------------------------------

    async def resolve(
        self,
        where_sql: str,
        params: Mapping[str, Any],
        *,
        limit: int,
        types: Sequence[str] | None = None,
        visible: Sequence[str] | None = None,
        remaining_s: float | None = None,
    ) -> list[tuple[str, str]]:
        """The anchor: the URNs matching a compiled predicate, per label.

        ``where_sql`` is a fragment the predicate compiler built, carrying its
        own bound parameters in ``params`` — never a value from a request.

        ``limit`` is a PLAN threshold, never an answer threshold: at most
        ``limit + 1`` rows come back, and more than ``limit`` means the
        predicate is over the threshold and must be post-filtered, not seeked
        from the truncated set.
        """
        sql, merged = self._scoped(
            "SELECT urn, entity_type FROM propidx.node_props",
            where_sql,
            params,
            types,
            visible,
        )
        # One past the threshold, so the caller can SEE the overflow: exactly
        # ``limit`` rows back is indistinguishable from a truncated set.
        merged["_pi_limit"] = limit + 1
        async with self._session(remaining_s) as session:
            rows = (await session.execute(text(sql + "\nLIMIT :_pi_limit"), merged)).all()
        return [(r[0], r[1]) for r in rows]

    async def count(
        self,
        where_sql: str,
        params: Mapping[str, Any],
        *,
        types: Sequence[str] | None = None,
        visible: Sequence[str] | None = None,
        remaining_s: float | None = None,
    ) -> int:
        """Exact count for a predicate — the uncapped answer the graph's capped
        candidate scan cannot give.
        """
        sql, merged = self._scoped(
            "SELECT count(*) FROM propidx.node_props", where_sql, params, types, visible
        )
        async with self._session(remaining_s) as session:
            return int((await session.execute(text(sql), merged)).scalar_one())

    def _scoped(
        self,
        select: str,
        where_sql: str,
        params: Mapping[str, Any],
        types: Sequence[str] | None,
        visible: Sequence[str] | None,
    ) -> tuple[str, dict[str, Any]]:
        """Compose the compiler's fragment with the graph, label and visibility
        scopes. The scopes push down so they narrow the index scan rather than
        filtering its output.

        The scope's own binds are ``_pi_``-prefixed: ``params`` comes from a
        generated compiler, and a plain ``:limit`` or ``:types`` in it would be
        overwritten here silently — a wrong hit set with no exception.
        """
        _check_binds(params)
        clauses = [f"{select}\nWHERE graph_key = :_pi_graph_key AND ({where_sql})"]
        merged: dict[str, Any] = {**params, "_pi_graph_key": self._graph_key}
        if types is not None:
            clauses.append("AND lower(entity_type) = ANY(CAST(:_pi_types AS text[]))")
            merged["_pi_types"] = [t.lower() for t in types]
        if visible is not None:
            clauses.append("AND urn = ANY(CAST(:_pi_visible AS text[]))")
            merged["_pi_visible"] = list(visible)
        return "\n".join(clauses), merged

    async def filter_rows(
        self,
        urns: Sequence[str],
        cols: Sequence[str],
        params: Mapping[str, Any] | None = None,
        *,
        remaining_s: float | None = None,
    ) -> dict[str, tuple]:
        """Evaluate compiled expressions per candidate URN, for the post-filter
        that re-evaluates the original predicate tree in Python. ``cols`` are
        compiler fragments in the order the caller wants them back.
        """
        params = params or {}
        _check_binds(params)
        urns = list(urns)
        cols = list(cols)
        if not urns or not cols:
            # An OR branch with no P-leaf projects nothing; an empty projection
            # would emit "SELECT urn,  FROM ..." and fail to parse.
            return {}
        projection = ", ".join(f"({col}) AS c{i}" for i, col in enumerate(cols))
        sql = text(
            f"SELECT urn, {projection} FROM propidx.node_props\n"
            "WHERE graph_key = :_pi_graph_key AND urn = ANY(CAST(:_pi_urns AS text[]))"
        )
        out: dict[str, tuple] = {}
        async with self._session(remaining_s) as session:
            for chunk in _chunks(urns, URN_CHUNK):
                rows = (
                    await session.execute(
                        sql,
                        {
                            **params,
                            "_pi_graph_key": self._graph_key,
                            "_pi_urns": list(chunk),
                        },
                    )
                ).all()
                for row in rows:
                    out[row[0]] = tuple(row[1:])
        return out

    async def fetch_values(
        self,
        urns: Sequence[str],
        keys: Sequence[str],
        *,
        remaining_s: float | None = None,
    ) -> dict[str, dict[str, Any]]:
        """The values behind a sort or a projection, by primary key. Only the
        requested keys cross the wire — a full bag is ~8 KB and a sort wants
        one field of it.
        """
        urns = list(urns)
        keys = list(keys)
        out: dict[str, dict[str, Any]] = {}
        async with self._session(remaining_s) as session:
            for chunk in _chunks(urns, URN_CHUNK):
                rows = (
                    await session.execute(
                        _FETCH_VALUES,
                        {"graph_key": self._graph_key, "urns": list(chunk), "keys": keys},
                    )
                ).all()
                for row in rows:
                    out[row[0]] = row[1] or {}
        return out

    async def group_by_value(
        self,
        key: str,
        *,
        urns: Sequence[str] | None = None,
        types: Sequence[str] | None = None,
        max_buckets: int,
        samples_per_bucket: int,
        remaining_s: float | None = None,
    ) -> list[dict[str, Any]]:
        """Aggregate by one property, exactly — the insight the graph can only
        approximate over its capped candidate set.
        """
        clauses = [
            "SELECT props -> :key AS value, count(*) AS n,",
            "       (array_agg(urn ORDER BY urn))[1 : CAST(:samples AS int)] AS samples",
            "FROM propidx.node_props",
            "WHERE graph_key = :graph_key AND propidx.ci(props) ? :key",
        ]
        params: dict[str, Any] = {
            "graph_key": self._graph_key,
            "key": key,
            "samples": samples_per_bucket,
            "max_buckets": max_buckets,
        }
        if urns is not None:
            clauses.append("AND urn = ANY(CAST(:urns AS text[]))")
            params["urns"] = list(urns)
        if types is not None:
            clauses.append("AND lower(entity_type) = ANY(CAST(:types AS text[]))")
            params["types"] = [t.lower() for t in types]
        clauses.append("GROUP BY 1 ORDER BY n DESC, 1 LIMIT :max_buckets")
        async with self._session(remaining_s) as session:
            rows = (await session.execute(text("\n".join(clauses)), params)).all()
        return [
            {"value": r[0], "count": int(r[1]), "samples": list(r[2] or [])}
            for r in rows
        ]

    async def distinct(
        self, key: str, limit: int = 100, *, remaining_s: float | None = None
    ) -> list[Any]:
        """Distinct values of one key — parameterised, so a key with a space or
        a dot in it is answered instead of silently rewritten.
        """
        async with self._session(remaining_s) as session:
            rows = (
                await session.execute(
                    _DISTINCT,
                    {"graph_key": self._graph_key, "key": key, "limit": limit},
                )
            ).all()
        return [r[0] for r in rows]

    async def keys(
        self, entity_type: str | None = None, *, remaining_s: float | None = None
    ) -> list[dict[str, Any]]:
        """Key discovery, read exactly rather than sampled from the graph."""
        clauses = [
            "SELECT entity_type, key, node_count, kinds, samples",
            "FROM propidx.prop_keys",
            "WHERE graph_key = :graph_key",
        ]
        params: dict[str, Any] = {"graph_key": self._graph_key}
        if entity_type is not None:
            clauses.append("AND lower(entity_type) = lower(:entity_type)")
            params["entity_type"] = entity_type
        clauses.append("ORDER BY key")
        async with self._session(remaining_s) as session:
            rows = (await session.execute(text("\n".join(clauses)), params)).all()
        return [
            {
                "entity_type": r[0],
                "key": r[1],
                "node_count": r[2],
                "kinds": list(r[3] or []),
                "samples": r[4] or [],
            }
            for r in rows
        ]

    async def key_typeahead(
        self, q: str, limit: int = 50, *, remaining_s: float | None = None
    ) -> list[dict[str, Any]]:
        """Prefix search over the key population, so a 100k-key source is
        browsable instead of a wall.
        """
        async with self._session(remaining_s) as session:
            rows = (
                await session.execute(
                    _KEY_TYPEAHEAD,
                    {
                        "graph_key": self._graph_key,
                        "pattern": _like_prefix(q),
                        "limit": limit,
                    },
                )
            ).all()
        return [{"key": r[0], "node_count": int(r[1] or 0)} for r in rows]
