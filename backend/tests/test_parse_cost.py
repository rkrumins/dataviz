"""How long FalkorDB takes to parse what we send it, and keeping that linear.

libcypher-parser reads an operand with no operator after it twice, so every
level of such nesting doubles the time to parse a statement — ``NOT (`` four
times over — and no timeout bounds that time (``native_query.parse_cost``).
Here: the estimate follows the parser's rule, the forms that keep a nested
condition linear mean what they replace, the guards refuse what is over the
budget, and the search compiler's statements for the deepest predicates the
service allows grow linearly. ``tests/integration/test_parse_cost_live.py``
holds the estimate to FalkorDB's own times.
"""
from __future__ import annotations

import random

import pytest
from pydantic import TypeAdapter

from backend.app.providers.falkordb_deep_search import _Compiler, tail_clauses
from backend.app.providers.falkordb_provider import _refuse_slow_parse
from backend.app.services.deep_search import CompileError
from backend.app.services.native_query.guard import FALKORDB, NEO4J, check
from backend.app.services.native_query.parse_cost import (
    MAX_PARSE_COST,
    grouped,
    negated,
    once,
    operand,
    parse_cost,
)
from backend.common.interfaces.native_query import NativeQueryRefused
from backend.common.models.search import Predicate

P = TypeAdapter(Predicate).validate_python
LEAF = "x.owner = $p0"


def nest(wrap, depth: int, leaf: str = LEAF) -> str:
    for _ in range(depth):
        leaf = wrap(leaf)
    return f"MATCH (x) RETURN {leaf}"


class TestEstimate:
    def test_a_flat_statement_costs_about_its_tokens(self):
        q = ("MATCH (n:`dataset`) WHERE n.urn IN $urns AND toLower(n.name) STARTS WITH $p "
             "AND n.size >= 3 AND n.owner IS NOT NULL RETURN n.urn AS urn, count(*) AS c "
             "ORDER BY urn LIMIT 10")
        assert parse_cost(q) < 80

    @pytest.mark.parametrize("wrap", [
        lambda e: f"coalesce({e}, false)",
        lambda e: f"({e})",
        lambda e: f"CASE WHEN {e} THEN true END",
        lambda e: f"ANY(_z IN [1] WHERE {e})",
        lambda e: f"toBoolean({e})",
    ], ids=["coalesce", "brackets", "CASE", "ANY", "function"])
    def test_an_operand_on_its_own_doubles_per_level(self, wrap):
        ratio = parse_cost(nest(wrap, 12)) / parse_cost(nest(wrap, 11))
        assert 1.8 < ratio < 2.2

    def test_not_and_its_brackets_quadruple_per_level(self):
        ratio = parse_cost(nest(lambda e: f"NOT ({e})", 9)) / parse_cost(nest(lambda e: f"NOT ({e})", 8))
        assert 3.6 < ratio < 4.4

    @pytest.mark.parametrize("wrap", [
        lambda e: f"({e}) = false",
        lambda e: f"[{e}][0]",
        lambda e: f"({e} AND x.urn = 'a')",
    ], ids=["= false", "subscript", "AND after"])
    def test_an_operator_after_each_level_keeps_it_linear(self, wrap):
        growth = parse_cost(nest(wrap, 14)) - parse_cost(nest(wrap, 13))
        assert growth == parse_cost(nest(wrap, 13)) - parse_cost(nest(wrap, 12)) < 20

    def test_it_reads_the_shapes_the_engines_write(self):
        q = ("MATCH (n:`a`) WHERE n.urn IS NOT NULL WITH n, ANY(_xb1 IN [_xp1 = (n)-[:FLOWS_TO*1..3]"
             "->(_xr1) WHERE ID(_xr1) <> ID(n) AND ALL(_xe1 IN relationships(_xp1) WHERE "
             "_xe1.confidence >= $p1) | size([(_xr1)<-[:CONTAINS]-(_xy1) | 1]) = 0] WHERE _xb1) AS _xt0 "
             "WHERE _xt0 WITH n, reduce(_m = 0.0, _s IN [n.a, n.b] | CASE WHEN _s > _m THEN _s "
             "ELSE _m END) AS k, nodes(p)[1..-1] AS ns, n {.urn, .name} AS m, n:`b` AS isb "
             "RETURN n.urn, {k: k, ns: ns}, labels(n)[0] ORDER BY k DESC SKIP 1 LIMIT 5")
        assert 0 < parse_cost(q) < 1_000

    def test_it_reads_any_text_without_judging_it(self):
        """The lexer and FalkorDB judge the text; the estimate only counts."""
        rng = random.Random(7)
        pieces = ["(", ")", "[", "]", "{", "}", "NOT", "AND", "x", "'s", "`n`", "$p", "1", ",",
                  "|", "WHERE", "IN", "CASE", "WHEN", "END", "..", ".", ":", "-", "->", "=", "/*"]
        for _ in range(500):
            parse_cost(" ".join(rng.choice(pieces) for _ in range(rng.randint(1, 40))))
        assert parse_cost("MATCH (n) RETURN 'unclosed") > 0

    def test_nesting_hundreds_deep_is_past_the_budget(self):
        assert parse_cost("RETURN " + "(" * 2000 + "1" + ")" * 2000) > MAX_PARSE_COST

    def test_names_and_literals_dont_change_it(self):
        a = nest(lambda e: f"NOT ({e})", 6)
        assert parse_cost(a) == parse_cost(a.replace("owner", "`a name`").replace("$p0", "'x'"))


class TestLinearForms:
    @pytest.mark.parametrize("expr, as_operand, as_negation", [
        ("(a OR b)", "(a OR b) = true", "(a OR b) = false"),
        ("n.x = 1", "n.x = 1", "(n.x = 1) = false"),
        ("ANY(x IN l WHERE x)", "ANY(x IN l WHERE x) = true", "ANY(x IN l WHERE x) = false"),
        ("NOT (a)", "(a) = false", "(a) = true"),
        ("NOT a = b", "(a = b) = false", "a = b"),
        ("a AND b", "a AND b", "(a AND b) = false"),
        ("CASE WHEN a THEN b END", "CASE WHEN a THEN b END = true", "CASE WHEN a THEN b END = false"),
        ("true", "true", "NOT true"),
    ])
    def test_each_form_says_the_same(self, expr, as_operand, as_negation):
        assert operand(expr) == as_operand
        assert negated(expr) == as_negation

    def test_values_and_brackets(self):
        assert once("reduce(a = 0, x IN l | a + x)", "+ 0") == "reduce(a = 0, x IN l | a + x) + 0"
        assert once("n.size", "+ 0") == "n.size"
        assert once("[x IN l | x]", "+ []") == "[x IN l | x] + []"
        assert grouped("(a OR b)") == "(a OR b)"
        assert grouped("(a) OR (b)") == "((a) OR (b))"
        assert grouped("n.x = 1") == "(n.x = 1)"


class TestGuards:
    def test_a_native_query_falkordb_would_take_too_long_to_parse_is_refused(self):
        deep = nest(lambda e: f"NOT ({e})", 11, "n.x = 1").replace("MATCH (x)", "MATCH (n)")
        assert parse_cost(deep) > MAX_PARSE_COST
        with pytest.raises(NativeQueryRefused, match="nests too deeply"):
            check(deep, engine=FALKORDB)
        check(deep, engine=NEO4J)               # Neo4j's parser doesn't backtrack so
        linear = nest(lambda e: f"({e}) = false", 11, "n.x = 1").replace("MATCH (x)", "MATCH (n)")
        assert check(linear, engine=FALKORDB)

    def test_a_views_many_rules_go_in_statements_under_the_budget(self, monkeypatch):
        """Rule membership answers every rule in one statement per label — split where the
        rules' columns would cost FalkorDB more than a quarter of the budget to parse."""
        from backend.app.providers.falkordb_search import membership

        columns = [(str(i), f"x.owner = $p{i}") for i in range(10)]
        each = parse_cost("RETURN ANY(_mz IN [0] WHERE x.owner = $p0) = true AS m0")
        monkeypatch.setattr(membership, "_STATEMENT_COST", 3 * each)
        chunks = membership._chunks(columns)
        assert [i for chunk in chunks for i in chunk] == list(range(10))
        assert [len(chunk) for chunk in chunks] == [3, 3, 3, 1]
        assert membership._chunks(columns[:1]) == [[0]]

    def test_the_provider_refuses_a_statement_over_the_budget(self):
        with pytest.raises(CompileError, match="nests too deeply"):
            _refuse_slow_parse(nest(lambda e: f"NOT ({e})", 11))
        _refuse_slow_parse("MATCH (n) WHERE n.urn IN $urns RETURN n")


# ---------------------------------------------------------------------------
# The compiler: as deep as the service lets a predicate nest
# ---------------------------------------------------------------------------

ALICE = {"kind": "property", "key": "owner", "op": "eq", "value": "alice"}


def NOT(c):
    return {"kind": "group", "op": "not", "children": [c]}


def AND(*c):
    return {"kind": "group", "op": "and", "children": list(c)}


def OR(*c):
    return {"kind": "group", "op": "or", "children": list(c)}


def rel(axis, where, **kw):
    return {"kind": "related", "axis": axis, "where": where, **kw}


def statement(predicate) -> str:
    c = _Compiler(lineage_edge_types={"FLOWS_TO"}, containment_edge_types={"CONTAINS"})
    head = c.compile(P(predicate))
    return f"MATCH (n) WHERE {head} {tail_clauses(c.tail)} RETURN n"


def nots(depth):
    p = ALICE
    for _ in range(depth):
        p = NOT(p)
    return p


def rels(depth):
    p = ALICE
    for axis in ("upstream", "child", "downstream")[:depth]:
        p = rel(axis, p)
    return p


def tree(depth):
    p = ALICE
    for i in range(depth):
        p = (AND if i % 2 else OR)(p, p)
    return p


class TestCompiledStatements:
    @pytest.mark.parametrize("shape, shallow, deep", [
        (nots, 2, 5), (rels, 1, 3),
    ], ids=["NOT", "relationships"])
    def test_nesting_grows_the_parse_linearly(self, shape, shallow, deep):
        a, b = parse_cost(statement(shape(shallow))), parse_cost(statement(shape(deep)))
        # Plain, each level doubled or quadrupled it: NOT five deep cost 2.8M.
        assert b - a < 500 and b < 60_000

    def test_a_tree_as_deep_as_the_service_allows_costs_its_leaves(self):
        """A few times each leaf however deep: 32 leaves at depth 6, where
        plain nesting cost about three times more per leaf per level."""
        leaf = parse_cost(statement(ALICE))
        assert parse_cost(statement(tree(5))) < 32 * 4 * leaf

    def test_a_where_keeps_plain_groups_its_filter_tree_short_circuits(self):
        # A group at the top, and a group of leaves in it: plain.
        assert statement(OR(ALICE, AND(ALICE, ALICE))).count("ANY(_xg") == 0
        assert "NOT (" in statement(NOT(ALICE))
        # A group in a group holding one: a one-item comprehension's WHERE.
        assert statement(OR(ALICE, AND(ALICE, OR(ALICE, ALICE)))).count("ANY(_xg") == 1
        assert "IN [0] WHERE NOT (" in statement(OR(ALICE, NOT(NOT(ALICE))))

    def test_a_relationships_test_of_each_relative_is_written_to_parse_once(self):
        s = statement(rel("upstream", OR(rel("child", ALICE), NOT(rel("parent", ALICE)))))
        assert "] + [] WHERE" in s and ") = false" in s
        # A test with nothing nested in it is left as it was.
        assert "+ []" not in statement(rel("upstream", ALICE))
