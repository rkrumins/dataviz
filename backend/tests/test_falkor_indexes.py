"""``ensure_urn_indexes`` — the per-label urn indexes on keys the versioning layer writes."""
import asyncio

import pytest

from backend.app.services.versioning.falkor_indexes import ensure_urn_indexes, urn_index_ddl


class _Res:
    def __init__(self, rows):
        self.result_set = rows


class _Client:
    """Records statements; reports each created index under construction for ``building`` polls."""

    def __init__(self, building=0, refuse=None):
        self.statements = []
        self.created = set()
        self.building = building
        self.refuse = refuse or set()

    async def query(self, cypher, params=None, timeout=None):
        self.statements.append(cypher)
        if cypher.startswith("CREATE INDEX"):
            label = cypher.split(":")[1].split(")")[0]
            if label in self.refuse:
                raise RuntimeError("Invalid label")
            if label in self.created:
                raise RuntimeError("Attribute 'urn' is already indexed")
            self.created.add(label)
            return _Res([])
        state = "UNDER CONSTRUCTION" if self.building > 0 else "OPERATIONAL"
        self.building -= 1
        return _Res([[lbl, ["urn"], ["RANGE"], "english", [], "NODE", state] for lbl in sorted(self.created)])

    async def ro_query(self, cypher, params=None, timeout=None):
        return await self.query(cypher, params, timeout)


def test_ddl_is_one_statement_per_sanitised_label():
    assert urn_index_ddl(["dataset", "data-set", "dataset", "", "chart"]) == [
        "CREATE INDEX FOR (n:dataset) ON (n.urn)",
        "CREATE INDEX FOR (n:data_set) ON (n.urn)",
        "CREATE INDEX FOR (n:chart) ON (n.urn)",
    ]


def test_existing_indexes_are_success_and_wait_polls_until_operational(monkeypatch):
    from backend.app.services.versioning import falkor_indexes

    monkeypatch.setattr(falkor_indexes, "_INDEX_POLL_SECS", 0)
    client = _Client(building=2)
    client.created.add("dataset")
    asyncio.run(ensure_urn_indexes(client, ["dataset", "chart"], wait=True))
    assert client.created == {"dataset", "chart"}
    assert client.statements.count("CALL db.indexes()") == 3      # two "building" polls, then ready


def test_a_refused_statement_is_skipped_unless_strict():
    client = _Client(refuse={"bad"})
    asyncio.run(ensure_urn_indexes(client, ["bad", "chart"]))
    assert client.created == {"chart"}
    with pytest.raises(RuntimeError):
        asyncio.run(ensure_urn_indexes(_Client(refuse={"bad"}), ["bad"], strict=True))
