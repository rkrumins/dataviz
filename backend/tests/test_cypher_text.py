"""Cypher text: one tokenizer for every reader of a query here, and the
compiled query with its values written in.

The tokenizer has to tell a keyword from the same letters in a string, a
comment or an escaped name, and know how deep in brackets each token sits
— the guard and the row cap stand on that. Writing parameters in has to
leave strings and comments alone and never confuse ``$p1`` with ``$p10``.
"""
from __future__ import annotations

import math

import pytest

from backend.app.services.native_query.cypher_text import inline_params, to_cypher_literal
from backend.app.services.native_query.lexer import (
    BACKTICK,
    COMMENT,
    NUMBER,
    OP,
    PARAM,
    PUNCT,
    STRING,
    WORD,
    LexError,
    tokenize,
)


def kinds(text):
    return [(t.kind, t.text) for t in tokenize(text)]


class TestTokenize:
    def test_names_literals_and_parameters(self):
        assert kinds("MATCH (n:`My Label` {x: 'a b', y: 1.5e3}) WHERE n.v >= $p0 RETURN n") == [
            (WORD, "MATCH"), (PUNCT, "("), (WORD, "n"), (PUNCT, ":"), (BACKTICK, "`My Label`"),
            (PUNCT, "{"), (WORD, "x"), (PUNCT, ":"), (STRING, "'a b'"), (PUNCT, ","),
            (WORD, "y"), (PUNCT, ":"), (NUMBER, "1.5e3"), (PUNCT, "}"), (PUNCT, ")"),
            (WORD, "WHERE"), (WORD, "n"), (PUNCT, "."), (WORD, "v"), (OP, ">="), (PARAM, "$p0"),
            (WORD, "RETURN"), (WORD, "n"),
        ]

    def test_a_keyword_in_a_string_comment_or_name_is_not_one(self):
        words = [t.text for t in tokenize(
            "RETURN 'CREATE' AS a, \"DELETE\" // SET x\n/* MERGE */ , `DROP` AS b") if t.kind == WORD]
        assert words == ["RETURN", "AS", "a", "AS", "b"]

    def test_escapes_stay_inside_their_string_or_name(self):
        assert kinds(r"RETURN 'it\'s', `a``b`") == [
            (WORD, "RETURN"), (STRING, r"'it\'s'"), (PUNCT, ","), (BACKTICK, "`a``b`")]

    def test_a_range_is_two_numbers_not_a_fraction(self):
        assert kinds("[*1..3]") == [(PUNCT, "["), (OP, "*"), (NUMBER, "1"), (OP, ".."),
                                    (NUMBER, "3"), (PUNCT, "]")]

    def test_depth_is_brackets_open_around_a_token(self):
        tokens = tokenize("CALL { MATCH (n) RETURN n } RETURN 1")
        depth = {(t.text, t.start): t.depth for t in tokens}
        assert depth[("RETURN", 17)] == 1 and depth[("RETURN", 28)] == 0
        assert depth[("{", 5)] == 0 and depth[("}", 26)] == 0

    def test_trivia_joins_back_to_the_text(self):
        text = "MATCH (n) // x\n  /* y */ RETURN n"
        assert "".join(t.text for t in tokenize(text, trivia=True)) == text
        assert COMMENT in {t.kind for t in tokenize(text, trivia=True)}

    @pytest.mark.parametrize("text, where", [
        ("RETURN 'open", 7), ("RETURN `open", 7), ("MATCH (n /* x", 9),
        ("MATCH (n", 6), ("RETURN 1)", 8), ("RETURN $", 7), ("RETURN #", 7),
    ])
    def test_text_cypher_cant_hold_says_where(self, text, where):
        with pytest.raises(LexError) as exc:
            tokenize(text)
        assert exc.value.position == where


class TestInline:
    def test_each_parameter_becomes_its_value_where_one_stands(self):
        cypher = ("MATCH (n) WHERE n.urn IN $_rootUrns AND n.name = '$p1' AND n.x = $p10 "
                  "/* $p1 */ RETURN n LIMIT $p1")
        assert inline_params(cypher, {"_rootUrns": ["a", "b'c"], "p1": 5, "p10": 1.5e20}) == (
            "MATCH (n) WHERE n.urn IN ['a', 'b\\'c'] AND n.name = '$p1' AND n.x = 1.5e20 "
            "/* $p1 */ RETURN n LIMIT 5")

    @pytest.mark.parametrize("value, literal", [
        (None, "null"), (True, "true"), (False, "false"), (-3, "-3"), (0.5, "0.5"), (2.0, "2.0"),
        (1e-7, "1e-07"), ("a\\b\n\t\x01", "'a\\\\b\\n\\t\\u0001'"),
        ([1, "x", [None]], "[1, 'x', [null]]"),
        ({"k": 1, "two words": "v", "back`tick": True}, "{k: 1, `two words`: 'v', `back``tick`: true}"),
    ])
    def test_literals(self, value, literal):
        assert to_cypher_literal(value) == literal

    @pytest.mark.parametrize("params", [
        {"p": math.nan}, {"p": math.inf}, {"p": 2 ** 64}, {"p": object()}, {},
    ])
    def test_nothing_is_written_when_a_value_cant_be(self, params):
        assert inline_params("RETURN $p", params) is None

    def test_nothing_is_written_for_text_that_isnt_cypher(self):
        assert inline_params("RETURN 'open", {}) is None
