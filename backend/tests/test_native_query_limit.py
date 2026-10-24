"""The row cap, written into the query: every top-level RETURN — each side of
a UNION — ends in ``LIMIT <cap + 1>``, so the engine never produces more
than one row past what is shown, and that one row says the result was cut.
"""
from __future__ import annotations

import pytest

from backend.app.services.native_query.guard import FALKORDB, NEO4J, check
from backend.app.services.native_query.limit import cap_rows
from backend.common.interfaces.native_query import NativeQueryRefused


def capped(query, engine=NEO4J, limit=200):
    return cap_rows(query, check(query, engine=engine), limit=limit, engine=engine)


@pytest.mark.parametrize("query, runs", [
    ("MATCH (n) RETURN n", "MATCH (n) RETURN n LIMIT 201"),
    ("MATCH (n) RETURN n ORDER BY n.name SKIP 10",
     "MATCH (n) RETURN n ORDER BY n.name SKIP 10 LIMIT 201"),
    ("MATCH (n) RETURN DISTINCT n.type", "MATCH (n) RETURN DISTINCT n.type LIMIT 201"),
    ("MATCH (n) RETURN *", "MATCH (n) RETURN * LIMIT 201"),
    # A LIMIT before the last RETURN is the query's own business.
    ("MATCH (n) WITH n LIMIT 5 RETURN n", "MATCH (n) WITH n LIMIT 5 RETURN n LIMIT 201"),
    # So is one inside a subquery.
    ("CALL { MATCH (n) RETURN n LIMIT 99999 } RETURN n",
     "CALL { MATCH (n) RETURN n LIMIT 99999 } RETURN n LIMIT 201"),
])
def test_a_return_without_a_limit_gets_one(query, runs):
    result = capped(query)
    assert result.text == runs
    assert result.notes == ("Added LIMIT 201: at most 200 rows are shown.",)


def test_the_cap_goes_after_the_last_token_never_after_a_comment():
    # Appended at the end of the text, a // comment would swallow it.
    assert capped("MATCH (n) RETURN n // every one").text == "MATCH (n) RETURN n LIMIT 201 // every one"
    assert capped("MATCH (n)\nRETURN n /* all */").text == "MATCH (n)\nRETURN n LIMIT 201 /* all */"


def test_a_limit_within_the_cap_is_kept():
    result = capped("MATCH (n) RETURN n LIMIT 10")
    assert result.text == "MATCH (n) RETURN n LIMIT 10"
    assert result.notes == ()


def test_a_limit_past_the_cap_is_lowered():
    result = capped("MATCH (n) RETURN n LIMIT 5000")
    assert result.text == "MATCH (n) RETURN n LIMIT 201"
    assert result.notes == ("Lowered LIMIT 5,000 to 201: at most 200 rows are shown.",)
    assert capped("MATCH (n) RETURN n LIMIT 0x1000").text == "MATCH (n) RETURN n LIMIT 201"
    assert capped("MATCH (n) RETURN n LIMIT 1_000").text == "MATCH (n) RETURN n LIMIT 201"


def test_each_side_of_a_union_is_capped():
    result = capped("MATCH (a) RETURN a.x AS x UNION ALL MATCH (b) RETURN b.x AS x LIMIT 3000")
    assert result.text == (
        "MATCH (a) RETURN a.x AS x LIMIT 201 UNION ALL MATCH (b) RETURN b.x AS x LIMIT 201"
    )
    assert len(result.notes) == 2


def test_a_trailing_semicolon_is_dropped():
    assert capped("MATCH (n) RETURN n;").text == "MATCH (n) RETURN n LIMIT 201"
    assert capped("MATCH (n) RETURN n LIMIT 3 ;").text == "MATCH (n) RETURN n LIMIT 3 "


@pytest.mark.parametrize("query, at", [
    ("MATCH (n) RETURN n LIMIT toInteger('5')", 19),
    ("MATCH (n) RETURN n LIMIT 5 + 5", 19),
    ("MATCH (n) RETURN n LIMIT 2.5", 19),
    ("MATCH (n) RETURN n LIMIT -1", 19),
])
def test_a_limit_the_cap_cannot_read_is_refused(query, at):
    with pytest.raises(NativeQueryRefused) as refused:
        capped(query)
    assert refused.value.position == at
    assert str(refused.value) == "Write LIMIT as a whole number, like LIMIT 100."


@pytest.mark.parametrize("query, at", [
    ("MATCH (n) WITH n", 0),
    ("MATCH (n) RETURN n UNION MATCH (m) WITH m", 25),
    ("CALL db.index.fulltext.queryNodes('names', 'x')", 0),
])
def test_a_query_must_end_in_return(query, at):
    with pytest.raises(NativeQueryRefused) as refused:
        capped(query)
    assert refused.value.position == at
    assert "RETURN" in str(refused.value)


@pytest.mark.parametrize("query, engine", [
    ("CALL db.labels()", NEO4J),
    ("CALL db.propertyKeys() YIELD propertyKey", NEO4J),
    ("CALL db.indexes()", FALKORDB),
    ("CALL db.relationshipTypes();", FALKORDB),
])
def test_a_schema_listing_needs_no_return(query, engine):
    result = capped(query, engine)
    assert "LIMIT" not in result.text
    assert result.notes == ()


def test_a_schema_listing_with_a_return_is_capped_like_any_query():
    assert capped("CALL db.labels() YIELD label RETURN label").text == (
        "CALL db.labels() YIELD label RETURN label LIMIT 201"
    )


def test_property_names_spelled_like_the_clauses_are_left_alone():
    result = capped("MATCH (n) RETURN n.limit, n.union, n.return")
    assert result.text == "MATCH (n) RETURN n.limit, n.union, n.return LIMIT 201"
