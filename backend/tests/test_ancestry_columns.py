"""Where an entity sits, as the five columns every file of entities carries (common.ancestry_columns).

Pins: a chain (parent first, as a provider gives it) becomes a path from the top of the graph down;
an entity at the top has an empty path and no parent, and one whose chain the source couldn't say
keeps empty cells; containers are named once per file, a thousand to a lookup; a source that reads
no chains leaves every cell empty; a text cell joins names with `` / `` and URNs with ``; ``; and a
value that comes back in a file as something else is read as nothing, never refused.
"""
from __future__ import annotations

import pytest

from backend.common import ancestry_columns as ancestry


def test_a_chain_reads_from_the_top_of_the_graph_down_to_the_parent():
    names = {"urn:db": ("Warehouse", "Database"), "urn:schema": ("gold", "Schema")}
    assert ancestry.chains_to_columns(["urn:schema", "urn:db"], names) == {
        "parentUrn": "urn:schema", "parentName": "gold", "parentType": "Schema",
        "path": ["Warehouse", "gold"], "pathUrns": ["urn:db", "urn:schema"]}
    # A container not named reads as its URN.
    assert ancestry.chains_to_columns(["urn:x"], {})["path"] == ["urn:x"]
    assert ancestry.chains_to_columns(["urn:x"], {})["parentName"] == "urn:x"


def test_the_top_of_the_graph_has_an_empty_path_and_no_parent():
    assert ancestry.chains_to_columns([], {}) == {
        "parentUrn": None, "parentName": None, "parentType": None, "path": [], "pathUrns": []}


def test_a_text_cell_joins_names_and_urns_apart():
    record = {"urn": "u", "path": ["A", "B"], "pathUrns": ["urn:a/1", "urn:b"]}
    assert ancestry.joined(record) == {"urn": "u", "path": "A / B", "pathUrns": "urn:a/1; urn:b"}
    unplaced = {"urn": "u", "path": None}
    assert ancestry.joined(unplaced) is unplaced


async def test_place_reads_a_thousand_at_a_time_and_names_each_container_once(monkeypatch):
    monkeypatch.setattr(ancestry, "CHUNK", 2)
    chain_calls, name_calls = [], []

    async def chains(urns):
        chain_calls.append(list(urns))
        return {u: ([] if u == "root" else ["urn:schema", "urn:db"]) for u in urns if u != "lost"}

    async def lookup(urns):
        name_calls.append(list(urns))
        return {"urn:schema": ("gold", "Schema"), "urn:db": ("Warehouse", "Database")}

    records = [{"urn": u} for u in ("t1", "t2", "root", "lost")] + [{"kind": "edge"}]
    known: ancestry.Names = {}
    await ancestry.place(records, chains, lookup, known)
    assert chain_calls == [["t1", "t2"], ["root", "lost"]], "CHUNK entities to a read"
    assert name_calls == [["urn:db", "urn:schema"]], "each container named once per file"
    assert records[0]["path"] == ["Warehouse", "gold"] and records[1]["parentType"] == "Schema"
    assert records[2]["path"] == [] and records[2]["parentUrn"] is None
    assert "path" not in records[3], "a chain the source couldn't say stays empty, not a root"
    assert records[4] == {"kind": "edge"}, "a row with no urn is left as it is"
    assert known["urn:db"] == ("Warehouse", "Database")


async def test_names_past_the_cap_are_read_again_not_held(monkeypatch):
    monkeypatch.setattr(ancestry, "NAMES_MAX", 0)

    async def chains(urns):
        return {u: ["urn:p"] for u in urns}

    async def lookup(urns):
        return {"urn:p": ("Parent", "Folder")}

    records, known = [{"urn": "a"}], {}
    await ancestry.place(records, chains, lookup, known)
    assert records[0]["parentName"] == "Parent" and known == {}


async def test_a_source_that_reads_no_chains_leaves_every_cell_empty():
    async def chains(urns):
        raise NotImplementedError("no containment walk here")

    async def lookup(urns):  # pragma: no cover - never reached
        raise AssertionError

    records = [{"urn": "a"}]
    await ancestry.place(records, chains, lookup, {})
    assert records == [{"urn": "a"}]


@pytest.mark.parametrize("value, text, path", [
    ("gold", "gold", "gold"),
    (2024, "2024", "2024"),                    # a spreadsheet's number
    (None, None, None),
    (["a", 1], None, ["a", "1"]),
    ({"x": 1}, None, None),
    ([{"x": 1}], None, None),
])
def test_a_value_that_comes_back_as_something_else_is_read_as_nothing(value, text, path):
    assert ancestry.informational_text(value) == text
    assert ancestry.informational_path(value) == path
