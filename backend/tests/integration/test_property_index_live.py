"""The property side index against a REAL Postgres.

Everything here is what the unit suite cannot see: that a LIST partition bound
actually accepts the graph key through a GUC, that ``unnest`` of five parameter
arrays types itself as the columns claim, that the ``IS DISTINCT FROM`` guard
really makes the second write of an unchanged bag a no-op, that ``propidx.ci``
answers a case-folded containment predicate through the GIN, and that a hot
index builds on the partition.

Run against a database the alembic revision ``20260916_1000_property_index``
has been applied to::

    PROPIDX_TEST_DATABASE_URL=postgresql+asyncpg://user:pw@localhost/viz \
      python -m pytest backend/tests/integration/test_property_index_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.providers.property_index import PostgresPropertyIndex, partition_name

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("PROPIDX_TEST_DATABASE_URL"),
        reason="PROPIDX_TEST_DATABASE_URL is unset (needs a migrated Postgres)",
    ),
]


@pytest.fixture
async def index():
    engine = create_async_engine(os.environ["PROPIDX_TEST_DATABASE_URL"])
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    graph_key = f"pytest:6379:propidx_{uuid.uuid4().hex[:8]}"
    idx = PostgresPropertyIndex(graph_key, factory)
    await idx.ensure_partition()
    try:
        yield idx
    finally:
        async with factory() as session:
            await session.execute(
                text(f'DROP TABLE IF EXISTS propidx."{partition_name(graph_key)}"')
            )
            await session.execute(
                text("DELETE FROM propidx.prop_keys WHERE graph_key = :g"),
                {"g": graph_key},
            )
            await session.execute(
                text("DELETE FROM propidx.graph_state WHERE graph_key = :g"),
                {"g": graph_key},
            )
            await session.commit()
        await engine.dispose()


def _row(i: int, **props):
    return {
        "urn": f"urn:li:dataset:{i}",
        "entity_type": "dataset",
        "props": {"Asset Owner": "Bob", "rows": i, **props},
        "tags": ["gold"],
    }


async def test_load_lifecycle_and_predicates(index: PostgresPropertyIndex):
    epoch = await index.begin_load()
    assert epoch >= 1

    rows = [_row(i) for i in range(3)]
    assert await index.upsert_rows(rows, epoch, chunk_size=2) == 3
    # The guard: the same bags at the same epoch write nothing at all.
    assert await index.upsert_rows(rows, epoch, chunk_size=2) == 0
    # A changed bag does.
    assert await index.upsert_rows([_row(0, extra="x")], epoch) == 1
    # So does a tag or a label edit: content_hash covers props alone, so the
    # skip guard has to test the other stored columns itself.
    tagged = {**_row(1), "tags": ["silver"]}
    assert await index.upsert_rows([tagged], epoch) == 1
    relabelled = {**_row(2), "entity_type": "chart"}
    assert await index.upsert_rows([relabelled], epoch) == 1
    assert [t for _, t in await index.resolve("TRUE", {}, limit=10, types=["chart"])] == [
        "chart"
    ]
    assert await index.upsert_rows([_row(2)], epoch) == 1  # and back

    # Case-folded equality through the GIN, and the raw value for exactness.
    hits = await index.resolve(
        "propidx.ci(props) @> CAST(:p0 AS jsonb)",
        {"p0": '{"Asset Owner":"bob"}'},
        limit=100,
        types=["Dataset"],
    )
    assert sorted(u for u, _ in hits) == [f"urn:li:dataset:{i}" for i in range(3)]
    assert await index.count("props ? :k", {"k": "rows"}) == 3

    # `limit` is a PLAN threshold: one row past it comes back so the caller can
    # tell "exactly `limit` matched" from "truncated, post-filter it".
    assert len(await index.resolve("props ? :k", {"k": "rows"}, limit=2)) == 3

    assert await index.fetch_values(["urn:li:dataset:1"], ["Asset Owner"]) == {
        "urn:li:dataset:1": {"Asset Owner": "Bob"}
    }
    assert await index.distinct("Asset Owner") == ["Bob"]

    buckets = await index.group_by_value(
        "Asset Owner", max_buckets=5, samples_per_bucket=2
    )
    assert buckets[0]["value"] == "Bob" and buckets[0]["count"] == 3
    assert len(buckets[0]["samples"]) == 2

    filtered = await index.filter_rows(
        [f"urn:li:dataset:{i}" for i in range(3)], ["props ? :k0"], {"k0": "extra"}
    )
    assert filtered["urn:li:dataset:0"] == (True,)
    assert filtered["urn:li:dataset:2"] == (False,)
    # No P-leaf under this OR branch: an empty projection would not parse.
    assert await index.filter_rows(["urn:li:dataset:0"], []) == {}

    await index.end_load(epoch)
    state = await index.get_state()
    assert (state["storage_version"], state["status"], state["load_epoch"]) == (
        2,
        "ready",
        epoch,
    )
    # A watermark past int4: graph_state.load_epoch is bigint.
    await index.set_state(load_epoch=5_000_000_000)
    assert (await index.get_state())["load_epoch"] == 5_000_000_000
    await index.set_state(load_epoch=epoch)

    keys = {k["key"] for k in await index.keys("dataset")}
    assert {"Asset Owner", "rows", "extra"} <= keys
    assert [k["key"] for k in await index.key_typeahead("Asset")] == ["Asset Owner"]


async def test_a_later_epoch_sweeps_the_rows_the_seed_did_not_rewrite(
    index: PostgresPropertyIndex,
):
    first = await index.begin_load()
    await index.upsert_rows([_row(i) for i in range(3)], first)

    second = await index.begin_load()
    await index.upsert_rows([_row(0)], second)
    assert await index.sweep_epoch(second) == 2
    assert await index.count("TRUE", {}) == 1

    await index.delete_urns(["urn:li:dataset:0"])
    assert await index.count("TRUE", {}) == 0


async def test_concurrent_seeds_of_one_graph_do_not_race_the_partition(
    index: PostgresPropertyIndex,
):
    """CREATE TABLE IF NOT EXISTS ... PARTITION OF checks the catalog before it
    locks the parent, so without the advisory lock one of these raises
    DuplicateTable."""
    import asyncio

    other = PostgresPropertyIndex(index.graph_key, index._session_factory)
    await asyncio.gather(*[other.ensure_partition() for _ in range(8)])


async def test_hot_indexes_build_on_the_partition(index: PostgresPropertyIndex):
    await index.upsert_rows([_row(i) for i in range(2)], 1)
    for key, kind in (("Asset Owner", "text"), ("rows", "numeric")):
        name = await index.create_hot_index(key, kind)
        async with index._session_factory() as session:
            found = (
                await session.execute(
                    text(
                        "SELECT tablename FROM pg_indexes "
                        "WHERE schemaname = 'propidx' AND indexname = :n"
                    ),
                    {"n": name},
                )
            ).scalar_one()
        assert found == partition_name(index.graph_key)
