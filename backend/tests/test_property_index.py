"""The property side index, pinned where it can be pinned without Postgres.

This suite runs on the repo's in-memory SQLite engine, so it does not execute
these statements — it asserts the SQL they build and the pure functions around
them. That is where the failures this module can produce actually live:

* the key a row is filed under must be the SAME string the provider namespaces
  a physical graph by, or a graph's rows and its graph are two different things
  that never meet;
* the upsert's ``IS DISTINCT FROM`` / epoch guard is what makes a re-seed of an
  unchanged bag free instead of a full rewrite of every row and its GIN entry;
* ``:urns::text[]`` binds ``:urn`` and leaves ``s::text[]`` in the SQL —
  SQLAlchemy's ``text()`` scanner stops a name at a colon — so every statement
  is re-parsed here and its bind names compared with the parameters passed;
* a value that reaches the SQL TEXT instead of a parameter is an injection and
  a plan-cache miss, so the adversarial values below are looked for in every
  statement the module emits.

Anything that needs a live Postgres is in
``tests/integration/test_property_index_live.py``.
"""
from __future__ import annotations

import hashlib
import json
import re

import pytest
from sqlalchemy import text

from backend.app.providers.property_index import (
    PostgresPropertyIndex,
    URN_CHUNK,
    content_hash,
    partition_name,
    physical_graph_key,
)

GK = "falkordb-a:6379:nexus_lineage"


# --------------------------------------------------------------------------- #
# A session that executes nothing and remembers everything.
# --------------------------------------------------------------------------- #
class _Row(tuple):
    """A result row that also answers ``._mapping`` (``get_state`` reads it)."""

    def __new__(cls, values, mapping=None):
        row = super().__new__(cls, values)
        row._mapping = mapping or {}
        return row


class _Result:
    def __init__(self, rows=(), rowcount=0):
        self._rows = list(rows)
        self.rowcount = rowcount

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None

    def scalar_one(self):
        return self._rows[0][0] if self._rows else 0


class _Recorder:
    """Session factory + call log. ``results`` are handed out in order."""

    def __init__(self, results=None):
        self.calls: list[tuple[str, dict]] = []
        self.commits = 0
        self.opens = 0
        self._results = list(results or [])

    def __call__(self):
        self.opens += 1
        return _Session(self)

    def _next(self):
        return self._results.pop(0) if self._results else _Result()

    # -- query helpers ------------------------------------------------------
    @property
    def sql(self) -> list[str]:
        return [s for s, _ in self.calls]

    def only(self) -> tuple[str, dict]:
        assert len(self.calls) == 1, self.sql
        return self.calls[0]

    def find(self, needle: str) -> tuple[str, dict]:
        hits = [c for c in self.calls if needle in c[0]]
        assert len(hits) == 1, f"{needle!r} matched {len(hits)} statements"
        return hits[0]


class _Session:
    def __init__(self, rec: _Recorder):
        self._rec = rec

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, stmt, params=None):
        self._rec.calls.append((str(stmt), dict(params or {})))
        return self._rec._next()

    async def commit(self):
        self._rec.commits += 1


def _index(rec: _Recorder, graph_key: str = GK) -> PostgresPropertyIndex:
    return PostgresPropertyIndex(graph_key, rec)


def _assert_binds_match_params(rec: _Recorder) -> None:
    """Every name the SQL binds is supplied, and every parameter supplied is
    bound. Catches the ``:name::type`` truncation and a renamed placeholder."""
    for sql, params in rec.calls:
        assert set(text(sql)._bindparams) == set(params), sql


# --------------------------------------------------------------------------- #
# Identity
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "host,port,name",
    [
        ("falkordb-a", 6379, "nexus_lineage"),
        ("falkordb-b", 6380, "mygraph"),
        ("10.0.0.1", 6379, "gvt_abc-123"),
        # The cases the provider REWRITES. "localhost" is the constructor
        # default, so these are every dev box: _normalize_falkordb_host pins
        # localhost and a missing host to 127.0.0.1 before _cache_ns sees them.
        ("localhost", 6379, "nexus_lineage"),
        (None, None, "g"),
        ("", 0, "g"),
    ],
)
def test_physical_graph_key_matches_provider_cache_ns(host, port, name):
    """The row key and the provider's cache namespace are ONE identity. If they
    drift, a graph's rows are filed under a key nothing ever reads."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    provider = FalkorDBProvider(host=host, graph_name=name, port=port)
    assert physical_graph_key(host, port, name) == provider._cache_ns
    assert physical_graph_key(host, port, name) == provider.physical_graph_id()


def test_physical_graph_key_follows_the_docker_rewrite(monkeypatch):
    """With the Docker rewrite set even an already-IPv4 host moves, and the key
    has to move with it."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    monkeypatch.setenv("FALKORDB_DOCKER_LOCALHOST_REWRITE", "host.docker.internal")
    provider = FalkorDBProvider(host="127.0.0.1", graph_name="g", port=6379)
    assert physical_graph_key("127.0.0.1", 6379, "g") == provider._cache_ns
    assert provider._cache_ns == "host.docker.internal:6379:g"


def test_partition_name_is_deterministic_and_a_legal_identifier():
    assert partition_name(GK) == partition_name(GK)
    assert partition_name(GK) != partition_name("falkordb-b:6379:nexus_lineage")
    expected = "np_" + hashlib.sha1(GK.encode("utf-8")).hexdigest()[:16]
    assert partition_name(GK) == expected
    # Postgres truncates identifiers at 63 bytes; graph keys are longer than
    # that and carry colons and dots.
    assert re.fullmatch(r"np_[0-9a-f]{16}", partition_name(GK))


def test_content_hash_is_stable_under_key_order_and_changes_with_values():
    a = {"owner": "bob", "rows": 12, "nested": {"x": [1, 2]}}
    b = {"nested": {"x": [1, 2]}, "rows": 12, "owner": "bob"}
    assert content_hash(a) == content_hash(b)
    assert content_hash(a) != content_hash({**a, "rows": 13})
    assert content_hash({}) == content_hash({})
    assert len(content_hash(a)) == 32  # blake2b, digest_size=16


def test_content_hash_stringifies_non_json_values():
    """The writers pass datetimes and Decimals straight through; a hash that
    raised on them would fail the write it exists to make cheap."""
    from datetime import datetime

    assert content_hash({"seen": datetime(2026, 9, 16)}) == content_hash(
        {"seen": datetime(2026, 9, 16)}
    )


# --------------------------------------------------------------------------- #
# The upsert
# --------------------------------------------------------------------------- #
def _rows(n: int):
    return [
        {
            "urn": f"urn:li:dataset:{i}",
            "entity_type": "dataset",
            "props": {"owner": "bob", "i": i},
            "tags": ["gold"],
        }
        for i in range(n)
    ]


async def test_upsert_rows_is_one_unnest_insert_with_the_skip_guard():
    rec = _Recorder([_Result(rowcount=3)])
    written = await _index(rec).upsert_rows(_rows(3), 7, chunk_size=1000)

    sql, params = rec.only()
    # One statement: arrays in, rows out.
    assert sql.count("INSERT INTO") == 1
    assert "FROM unnest(" in sql
    assert [
        m for m in re.findall(r"CAST\(:(\w+) AS (\w+\[\])\)", sql)
    ] == [
        ("urns", "text[]"),
        ("types", "text[]"),
        ("props", "jsonb[]"),
        ("tags", "jsonb[]"),
        ("hashes", "text[]"),
    ]
    assert "AS u(urn, entity_type, props, tags, content_hash)" in sql
    assert "ON CONFLICT (graph_key, urn) DO UPDATE SET" in sql
    # The guard: an unchanged ROW at the same epoch writes nothing at all —
    # and every column the row stores is in it, because content_hash covers
    # props alone and a label or tag edit would otherwise be skipped forever.
    assert "WHERE node_props.content_hash IS DISTINCT FROM EXCLUDED.content_hash" in sql
    assert "OR node_props.entity_type IS DISTINCT FROM EXCLUDED.entity_type" in sql
    assert "OR node_props.tags IS DISTINCT FROM EXCLUDED.tags" in sql
    assert "OR node_props.load_epoch <> EXCLUDED.load_epoch" in sql

    assert params["epoch"] == 7
    assert params["graph_key"] == GK
    assert params["urns"] == [f"urn:li:dataset:{i}" for i in range(3)]
    assert params["types"] == ["dataset"] * 3
    assert json.loads(params["props"][0]) == {"owner": "bob", "i": 0}
    assert json.loads(params["tags"][0]) == ["gold"]
    assert params["hashes"] == [content_hash(r["props"]) for r in _rows(3)]
    assert written == 3
    assert rec.commits == 1
    _assert_binds_match_params(rec)


async def test_upsert_rows_chunks_at_the_caller_supplied_size_in_one_session():
    rec = _Recorder()
    await _index(rec).upsert_rows(_rows(5), 1, chunk_size=2)
    assert [len(p["urns"]) for _, p in rec.calls] == [2, 2, 1]
    # One session, one commit — a half-written batch is not a state the
    # ordering contract has a name for.
    assert (rec.opens, rec.commits) == (1, 1)


async def test_upsert_rows_with_no_rows_writes_nothing():
    rec = _Recorder()
    assert await _index(rec).upsert_rows([], 1, chunk_size=10) == 0
    assert rec.calls == []


# --------------------------------------------------------------------------- #
# Chunk boundaries on URN lists
# --------------------------------------------------------------------------- #
async def test_delete_urns_chunks_at_ten_thousand():
    assert URN_CHUNK == 10_000
    rec = _Recorder()
    urns = [f"urn:{i}" for i in range(URN_CHUNK * 2 + 1)]
    await _index(rec).delete_urns(urns)
    assert [len(p["urns"]) for _, p in rec.calls] == [10_000, 10_000, 1]
    assert "urn = ANY(CAST(:urns AS text[]))" in rec.sql[0]
    assert rec.commits == 1


async def test_filter_rows_chunks_at_ten_thousand_and_keys_by_urn():
    rows = [_Row((f"urn:{i}", True, False)) for i in range(2)]
    rec = _Recorder([_Result(rows), _Result([])])
    out = await _index(rec).filter_rows(
        [f"urn:{i}" for i in range(URN_CHUNK + 1)],
        ["props ? :k0", "propidx.ci(props) @> CAST(:v0 AS jsonb)"],
        {"k0": "owner", "v0": '{"owner":"bob"}'},
    )
    assert [len(p["_pi_urns"]) for _, p in rec.calls] == [10_000, 1]
    assert out == {"urn:0": (True, False), "urn:1": (True, False)}
    sql, _ = rec.calls[0]
    assert "(props ? :k0) AS c0" in sql
    assert "(propidx.ci(props) @> CAST(:v0 AS jsonb)) AS c1" in sql
    _assert_binds_match_params(rec)


@pytest.mark.parametrize("urns,cols", [(["urn:0"], []), ([], ["props ? :k"])])
async def test_filter_rows_with_nothing_to_project_runs_no_sql(urns, cols):
    """An OR branch with no P-leaf projects nothing; the empty join would emit
    ``SELECT urn,  FROM ...``, which Postgres refuses to parse."""
    rec = _Recorder()
    assert await _index(rec).filter_rows(urns, cols, {"k": "owner"}) == {}
    assert rec.calls == []


async def test_fetch_values_chunks_and_asks_only_for_the_keys_wanted():
    # jsonb arrives DECODED: SQLAlchemy's asyncpg dialect installs a jsonb
    # codec on every connection, so the driver has already run json.loads.
    rec = _Recorder([_Result([_Row(("urn:0", {"owner": "bob"}))])])
    out = await _index(rec).fetch_values(["urn:0"], ["owner"])
    sql, params = rec.only()
    assert params["keys"] == ["owner"]
    assert "jsonb_object_agg(k, props -> k)" in sql
    assert out == {"urn:0": {"owner": "bob"}}


# --------------------------------------------------------------------------- #
# statement_timeout
# --------------------------------------------------------------------------- #
async def test_remaining_budget_sets_a_local_statement_timeout_first():
    rec = _Recorder()
    await _index(rec).delete_urns(["urn:0"], remaining_s=2.5)
    sql, params = rec.calls[0]
    # SET LOCAL takes no parameters; set_config(..., is_local => true) is the
    # same thing with the value still bound.
    assert "set_config('statement_timeout'" in sql
    assert sql.rstrip().endswith("true)")
    assert params == {"timeout_ms": "2500"}
    assert "DELETE FROM" in rec.sql[1]


async def test_an_exhausted_budget_floors_at_one_millisecond():
    """0 is Postgres for "no timeout"; a caller out of budget must fail fast,
    not run unbounded."""
    rec = _Recorder()
    await _index(rec).delete_urns(["urn:0"], remaining_s=0.0)
    assert rec.calls[0][1] == {"timeout_ms": "1"}


async def test_no_budget_sets_no_timeout():
    rec = _Recorder()
    await _index(rec).delete_urns(["urn:0"])
    assert "set_config" not in rec.sql[0]


# --------------------------------------------------------------------------- #
# Values never reach the SQL text
# --------------------------------------------------------------------------- #
async def test_no_value_is_ever_interpolated_into_the_sql():
    hostile_key = "O'Brien; DROP TABLE propidx.node_props --"
    hostile_urn = "urn:'; DELETE FROM propidx.node_props; --"
    hostile_graph = "host';--:6379:g"
    rec = _Recorder(
        [
            _Result([_Row(("urn:0", "dataset"))]),
            _Result([_Row((1,))]),
            _Result([_Row(('"v"',))]),
        ]
    )
    idx = _index(rec, hostile_graph)

    await idx.ensure_partition()
    await idx.upsert_rows(
        [{"urn": hostile_urn, "entity_type": "dataset", "props": {hostile_key: 1}, "tags": []}],
        3,
    )
    await idx.upsert_keys([{"entity_type": "dataset", "key": hostile_key, "kinds": ["string"]}])
    await idx.delete_urns([hostile_urn])
    await idx.sweep_epoch(4)
    await idx.wipe()
    await idx.set_state(status="ready", last_error=hostile_key)
    await idx.refresh_keys()
    await idx.resolve("props ? :k", {"k": hostile_key}, limit=50, types=[hostile_key])
    await idx.count("props ? :k", {"k": hostile_key})
    await idx.distinct(hostile_key)
    await idx.fetch_values([hostile_urn], [hostile_key])
    await idx.keys(entity_type=hostile_key)
    await idx.key_typeahead(hostile_key)
    await idx.group_by_value(
        hostile_key, urns=[hostile_urn], max_buckets=10, samples_per_bucket=3
    )
    for kind in ("text", "numeric"):
        await idx.create_hot_index(hostile_key, kind)

    assert rec.calls
    for sql, _ in rec.calls:
        assert hostile_key not in sql
        assert hostile_urn not in sql
        assert hostile_graph not in sql
    _assert_binds_match_params(rec)


def test_key_typeahead_neutralises_like_wildcards():
    """A key literally named ``100%`` must search for itself, not for every key
    beginning ``100``."""
    from backend.app.providers.property_index import _like_prefix

    assert _like_prefix("100%") == "100\\%%"
    assert _like_prefix("a_b") == "a\\_b%"
    assert _like_prefix("c\\d") == "c\\\\d%"


# --------------------------------------------------------------------------- #
# DDL that Postgres will not let us parameterise
# --------------------------------------------------------------------------- #
async def test_ensure_partition_carries_the_graph_key_through_a_guc():
    """A partition bound must be a constant, so the key cannot be a parameter
    in the DDL — it is set as a local GUC and quoted by ``format('%L')``."""
    rec = _Recorder()
    await _index(rec).ensure_partition()

    guc_sql, guc_params = rec.calls[0]
    assert guc_params == {"partition": partition_name(GK), "graph_key": GK}
    assert "set_config('propidx.partition'" in guc_sql
    assert "set_config('propidx.graph_key'" in guc_sql

    # CREATE TABLE IF NOT EXISTS ... PARTITION OF is not atomic — two workers
    # seeding one graph both pass the catalog check and one raises
    # DuplicateTable — so the same transaction takes an advisory lock first.
    lock_sql, lock_params = rec.calls[1]
    assert lock_params == {}
    assert "pg_advisory_xact_lock(hashtext(current_setting('propidx.partition')))" in lock_sql

    ddl, params = rec.calls[2]
    assert params == {}
    assert "CREATE TABLE IF NOT EXISTS propidx.%I PARTITION OF propidx.node_props" in ddl
    assert "FOR VALUES IN (%L)" in ddl
    assert "current_setting('propidx.partition')" in ddl
    assert "current_setting('propidx.graph_key')" in ddl
    assert rec.commits == 1


async def test_create_hot_index_names_by_digest_and_matches_the_kind():
    rec = _Recorder()
    name = await _index(rec).create_hot_index("Asset Owner", "text")
    assert name == "hx_" + hashlib.sha1(
        f"{GK}\0Asset Owner\0text".encode("utf-8")
    ).hexdigest()[:16]

    guc_params = rec.calls[0][1]
    assert guc_params["key"] == "Asset Owner"
    assert guc_params["partition"] == partition_name(GK)
    assert guc_params["index_name"] == name

    ddl = rec.calls[1][0]
    assert "(props ->> %L) text_pattern_ops" in ddl
    assert "ON propidx.%I" in ddl  # on the partition, not the parent

    row_sql, row_params = rec.calls[2]
    assert "INSERT INTO propidx.hot_indexes" in row_sql
    assert row_params["kind"] == "text" and row_params["index_name"] == name
    assert rec.commits == 1


@pytest.mark.parametrize(
    "kind,fragment",
    [
        ("text", "(props ->> %L) text_pattern_ops"),
        ("numeric", "((props ->> %L)::numeric)"),
    ],
)
async def test_hot_index_kinds(kind, fragment):
    rec = _Recorder()
    await _index(rec).create_hot_index("owner", kind)
    assert fragment in rec.calls[1][0]


async def test_trgm_is_refused_before_any_sql():
    """``gin_trgm_ops`` needs pg_trgm, which the landed revision deliberately
    does not create; the DDL would fail with an opaque catalog error."""
    rec = _Recorder()
    with pytest.raises(NotImplementedError, match="pg_trgm"):
        await _index(rec).create_hot_index("owner", "trgm")
    assert rec.calls == []


async def test_an_unknown_hot_index_kind_raises_before_any_sql():
    """The column's CHECK allows three kinds; a fourth must not reach the DDL."""
    rec = _Recorder()
    with pytest.raises(KeyError):
        await _index(rec).create_hot_index("owner", "fulltext")
    assert rec.calls == []


# --------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------- #
async def test_resolve_composes_the_fragment_with_scopes_and_a_limit():
    rec = _Recorder([_Result([_Row(("urn:0", "dataset")), _Row(("urn:1", "column"))])])
    out = await _index(rec).resolve(
        "propidx.ci(props) @> CAST(:p0 AS jsonb)",
        {"p0": '{"owner":"bob"}'},
        limit=50_000,
        types=["Dataset", "Column"],
        visible=["urn:0", "urn:1"],
    )
    sql, params = rec.only()
    assert sql.startswith("SELECT urn, entity_type FROM propidx.node_props")
    assert (
        "WHERE graph_key = :_pi_graph_key AND (propidx.ci(props) @> CAST(:p0 AS jsonb))"
        in sql
    )
    assert "AND lower(entity_type) = ANY(CAST(:_pi_types AS text[]))" in sql
    assert "AND urn = ANY(CAST(:_pi_visible AS text[]))" in sql
    assert sql.rstrip().endswith("LIMIT :_pi_limit")
    # One PAST the plan threshold: exactly `limit` rows back would be
    # indistinguishable from a set truncated at it.
    assert params["_pi_limit"] == 50_001
    assert params["_pi_types"] == ["dataset", "column"]  # folded to match ix_np_type
    assert params["p0"] == '{"owner":"bob"}'
    assert out == [("urn:0", "dataset"), ("urn:1", "column")]
    _assert_binds_match_params(rec)


async def test_resolve_without_scopes_adds_no_scope_clauses():
    rec = _Recorder()
    await _index(rec).resolve("props ? :k", {"k": "owner"}, limit=10)
    sql, params = rec.only()
    assert "entity_type" not in sql.split("WHERE")[1]
    assert "visible" not in sql
    assert set(params) == {"_pi_graph_key", "k", "_pi_limit"}


@pytest.mark.parametrize("name", ["_pi_graph_key", "_pi_limit", "_pi_types"])
async def test_a_compiler_fragment_may_not_use_a_reserved_bind_name(name):
    """The scope's binds and the compiler's share one dict. A collision used to
    replace the compiler's value silently — a wrong hit set with no error."""
    rec = _Recorder()
    with pytest.raises(ValueError, match="reserved bind name"):
        await _index(rec).resolve(f"props ->> 'owner' = :{name}", {name: "x"}, limit=5)
    with pytest.raises(ValueError, match="reserved bind name"):
        await _index(rec).filter_rows(["urn:0"], [f"props ? :{name}"], {name: "x"})
    assert rec.calls == []


async def test_count_is_the_same_scope_without_a_limit():
    rec = _Recorder([_Result([_Row((41,))])])
    n = await _index(rec).count("props ? :k", {"k": "owner"}, types=["dataset"])
    sql, _ = rec.only()
    assert sql.startswith("SELECT count(*) FROM propidx.node_props")
    assert "LIMIT" not in sql
    assert n == 41


async def test_distinct_parameterises_the_key():
    rec = _Recorder([_Result([_Row(("Bob",)), _Row(("2024",)), _Row((None,))])])
    out = await _index(rec).distinct("Asset Owner", limit=25)
    sql, params = rec.only()
    assert "SELECT DISTINCT props -> :key" in sql
    # Existence is written over the INDEXED expression: ix_np_ci_gin is an
    # expression index on propidx.ci(props), so a bare `props ? :key` seq scans
    # the partition. ci preserves the key set verbatim, so it is the same answer.
    assert "propidx.ci(props) ? :key" in sql
    assert params == {"graph_key": GK, "key": "Asset Owner", "limit": 25}
    # Values come back as the driver decoded them — a string stays a string.
    assert out == ["Bob", "2024", None]


async def test_group_by_value_buckets_with_samples():
    rec = _Recorder([_Result([_Row(("bob", 12, ["urn:0", "urn:1"]))])])
    out = await _index(rec).group_by_value(
        "owner", types=["dataset"], max_buckets=20, samples_per_bucket=2
    )
    sql, params = rec.only()
    assert "(array_agg(urn ORDER BY urn))[1 : CAST(:samples AS int)]" in sql
    assert "propidx.ci(props) ? :key" in sql  # the indexed expression
    assert "GROUP BY 1 ORDER BY n DESC, 1 LIMIT :max_buckets" in sql
    assert params["samples"] == 2 and params["max_buckets"] == 20
    assert "urns" not in params  # no URN scope asked for, none pushed down
    assert out == [{"value": "bob", "count": 12, "samples": ["urn:0", "urn:1"]}]
    _assert_binds_match_params(rec)


async def test_keys_reads_discovery_exactly():
    rec = _Recorder([_Result([_Row(("dataset", "owner", 3, ["string"], ["bob"]))])])
    out = await _index(rec).keys("Dataset")
    sql, params = rec.only()
    assert "FROM propidx.prop_keys" in sql
    assert "AND lower(entity_type) = lower(:entity_type)" in sql
    assert params["entity_type"] == "Dataset"
    assert out == [
        {
            "entity_type": "dataset",
            "key": "owner",
            "node_count": 3,
            "kinds": ["string"],
            "samples": ["bob"],
        }
    ]


async def test_key_typeahead_is_a_prefix_search_on_the_indexed_column():
    rec = _Recorder([_Result([_Row(("owner", 9))])])
    out = await _index(rec).key_typeahead("own", limit=5)
    sql, params = rec.only()
    assert "key LIKE :pattern ESCAPE '\\'" in sql
    assert params["pattern"] == "own%"
    assert params["limit"] == 5
    assert out == [{"key": "owner", "node_count": 9}]


# --------------------------------------------------------------------------- #
# Epoch lifecycle
# --------------------------------------------------------------------------- #
async def test_begin_load_without_an_epoch_bumps_and_marks_building():
    rec = _Recorder([_Result([_Row((4,))])])
    epoch = await _index(rec).begin_load()
    sql, params = rec.only()
    assert "load_epoch = graph_state.load_epoch + 1" in sql
    assert "status = 'building'" in sql
    assert sql.rstrip().endswith("RETURNING load_epoch")
    assert params == {"graph_key": GK}
    assert epoch == 4
    assert rec.commits == 1


async def test_begin_load_stores_the_callers_watermark():
    """The projector's epoch is `to_seq`, picked BEFORE the graph delete and
    reused by the sweep — not a counter this table owns."""
    rec = _Recorder([_Result([_Row((900,))])])
    epoch = await _index(rec).begin_load(900)
    sql, params = rec.only()
    assert "VALUES (:graph_key, 2, 'building', CAST(:epoch AS bigint))" in sql
    # A replayed seed must not move the epoch backwards and resurrect swept rows.
    assert "GREATEST(graph_state.load_epoch, CAST(:epoch AS bigint))" in sql
    assert params == {"graph_key": GK, "epoch": 900}
    assert epoch == 900


async def test_sweep_epoch_deletes_strictly_below_the_epoch():
    rec = _Recorder([_Result(rowcount=17)])
    gone = await _index(rec).sweep_epoch(9)
    sql, params = rec.only()
    assert "WHERE graph_key = :graph_key AND load_epoch < :epoch" in sql
    assert params == {"graph_key": GK, "epoch": 9}
    assert gone == 17


async def test_end_load_sweeps_then_refreshes_then_publishes():
    """Order is the contract: the side table must equal committed main BEFORE
    anything reads it as ready."""
    rec = _Recorder()
    await _index(rec).end_load(9)
    sql = rec.sql
    assert len(sql) == 4
    assert "load_epoch < :epoch" in sql[0]
    assert "DELETE FROM propidx.prop_keys" in sql[1]
    assert "INSERT INTO propidx.prop_keys" in sql[2]
    assert "INSERT INTO propidx.graph_state" in sql[3]
    assert rec.calls[-1][1]["status"] == "ready"
    assert rec.calls[-1][1]["load_epoch"] == 9
    assert rec.calls[-1][1]["storage_version"] == 2
    # Each method owns its session and commits it.
    assert rec.opens == 3 and rec.commits == 3


async def test_set_state_leaves_omitted_fields_alone():
    rec = _Recorder()
    await _index(rec).set_state(status="failed", last_error="boom")
    sql, params = rec.only()
    assert "status          = COALESCE(:status, graph_state.status)" in sql
    assert "storage_version = COALESCE(:storage_version, graph_state.storage_version)" in sql
    assert params["storage_version"] is None and params["status"] == "failed"
    assert params["last_error"] == "boom"
    # graph_state.load_epoch is bigint; the bare literal 0 in the VALUES list
    # would type the parameter int4 and reject a watermark past 2**31.
    assert "COALESCE(CAST(:load_epoch AS bigint), 0)" in sql
    assert "COALESCE(CAST(:load_epoch AS bigint), graph_state.load_epoch)" in sql


async def test_get_state_returns_the_jsonb_columns_as_the_driver_decoded_them():
    rec = _Recorder(
        [
            _Result(
                [
                    _Row(
                        (2, "ready"),
                        mapping={
                            "storage_version": 2,
                            "status": "ready",
                            "load_epoch": 4,
                            "declared_ready": ["owner"],
                            "progress": None,
                        },
                    )
                ]
            )
        ]
    )
    state = await _index(rec).get_state()
    assert state["declared_ready"] == ["owner"]
    assert state["progress"] is None
    assert state["status"] == "ready"


async def test_get_state_of_an_unknown_graph_is_none():
    rec = _Recorder([_Result([])])
    assert await _index(rec).get_state() is None


async def test_wipe_clears_rows_and_discovery_but_not_routing():
    rec = _Recorder()
    await _index(rec).wipe()
    assert "DELETE FROM propidx.node_props WHERE graph_key = :graph_key" in rec.sql[0]
    assert "DELETE FROM propidx.prop_keys" in rec.sql[1]
    assert not any("graph_state" in s for s in rec.sql)
    assert rec.commits == 1


async def test_upsert_keys_converts_kinds_to_a_text_array():
    rec = _Recorder()
    await _index(rec).upsert_keys(
        [{"entity_type": "dataset", "key": "owner", "kinds": ["string"], "samples": ["bob"]}]
    )
    sql, params = rec.only()
    assert "ARRAY(SELECT jsonb_array_elements_text(u.kinds))" in sql
    assert "ON CONFLICT (graph_key, entity_type, key) DO UPDATE SET" in sql
    assert params["keys"] == ["owner"]
    assert json.loads(params["kinds"][0]) == ["string"]
    _assert_binds_match_params(rec)


async def test_refresh_keys_recomputes_rather_than_accumulates():
    rec = _Recorder()
    await _index(rec).refresh_keys()
    assert "DELETE FROM propidx.prop_keys" in rec.sql[0]
    assert "GROUP BY n.entity_type, e.key" in rec.sql[1]
    assert "array_agg(DISTINCT jsonb_typeof(e.value))" in rec.sql[1]
    assert rec.commits == 1
