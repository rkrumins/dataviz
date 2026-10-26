"""How long FalkorDB takes to parse a statement, estimated before it is sent.

FalkorDB parses Cypher with libcypher-parser, a PEG grammar whose expression
rule is, in short::

    _expression = _atom (continuation)+ | _atom

A continuation is an operator that binds tighter than the one the expression
is an operand of (``.key``, ``[i]``, ``IS NULL``, ``= x``, ``AND x`` …). An
operand with none after it fails the first alternative after parsing its atom
in full, and the second parses the atom again. So every operand left on its
own — a function's argument, the inside of brackets, the right side of AND
before another AND, a projection before ``AS`` — costs twice what is inside
it, and nested ones multiply: ``coalesce(coalesce(…))``, ``CASE``, ``ANY``,
``(…)`` double the time per level and ``NOT (…)`` quadruples it. Twelve nested
``NOT (`` take FalkorDB 4.18 over a minute to parse; nothing bounds that time,
the query's own timeout starts after it; and the thread parsing serves no one
else meanwhile.

``parse_cost`` replays that rule over the tokens, once, adding each atom's
cost twice where the parser would read it twice. Its unit is a token read;
``MAX_PARSE_COST`` is what FalkorDB parses in about half a second. It reads any
text, without judging it — the lexer (``lexer.tokenize``) and FalkorDB do
that: a construct it doesn't know costs its tokens, and what sits in its
brackets is still read as expressions. It scans with one regular expression
rather than the lexer, as the provider estimates every statement it sends.

``operand`` and ``negated`` are how a compiler keeps the time linear: a
condition nested in another gets an operator after it that binds tighter than
AND, OR and NOT — ``= true``, which leaves true, false and null as they are,
and ``= false`` in place of NOT.
"""
from __future__ import annotations

import re
from collections import OrderedDict
from typing import Dict, List

#: Token reads FalkorDB 4.18 parses in about half a second (``test_parse_cost_live``
#: measures the rate) — over twice what the search compiler writes for the
#: largest predicate the service's caps allow.
MAX_PARSE_COST = 1_000_000

#: A token, after any space and comments, in upper case: what the cost reads.
_TOKEN = re.compile(r"""
    (?:\s+|//[^\n]*|/\*.*?(?:\*/|\Z))*
    ( '(?:[^'\\]|\\.)*(?:'|\Z) | "(?:[^"\\]|\\.)*(?:"|\Z)
    | `(?:[^`]|``)*(?:`|\Z) | \$(?:`(?:[^`]|``)*(?:`|\Z)|\w*)
    | \d+(?:\.\d+)?(?:[eE][+-]?\d+)?\w* | \.\d\w* | [^\W\d]\w*
    | =~ | <> | <= | >= | != | -> | <- | \.\. | \+=
    | [^\s] )
""", re.X | re.S)

#: Infix operators by precedence, as libcypher-parser ranks them (``operators.c``):
#: an operand's continuation must rank at least as high as its context.
_INFIX = {"OR": 1, "XOR": 2, "AND": 3, "=": 5, "<>": 5, "!=": 5, "<": 6, ">": 6, "<=": 6,
          ">=": 6, "+": 7, "-": 7, "*": 8, "/": 8, "%": 8, "^": 9, "=~": 11, "IN": 11,
          "CONTAINS": 11, "STARTS": 11, "ENDS": 11}
_RIGHT_ASSOC = {"^"}
_NOT, _UNARY, _POSTFIX, _BRACKET, _DOT = 4, 10, 11, 12, 13
#: Where an expression ends: the next clause, a part of the one it is in, a closing bracket.
_ENDS = {"AS", "WHERE", "WHEN", "THEN", "ELSE", "END", "ASC", "ASCENDING", "DESC",
         "DESCENDING", "ORDER", "SKIP", "LIMIT", "UNION", "MATCH", "OPTIONAL", "WITH", "RETURN",
         "UNWIND", "CALL", "YIELD", "CREATE", "MERGE", "SET", "DELETE", "DETACH", "REMOVE",
         "FOREACH", "ON", "BY", "DISTINCT", ",", ")", "]", "}", "|", ";", ".."}
_PREDICATES = {"ANY", "ALL", "NONE", "SINGLE", "FILTER", "EXTRACT", "REDUCE"}
_OPENS, _CLOSES = {"(", "[", "{"}, {")", "]", "}"}
_ARROWS = {"-", "->", "<-", "<", ">"}


def _scan(text: str) -> List[str]:
    return _TOKEN.findall(text.upper())


def _is_name(token: str) -> bool:
    return token[:1].isalpha() or token[:1] in ("_", "`")


def _closings(tokens: List[str]) -> Dict[int, int]:
    """Where each bracket closes, by the index of the one opening it."""
    closes: Dict[int, int] = {}
    opened: List[int] = []
    for i, t in enumerate(tokens):
        if t in _OPENS:
            opened.append(i)
        elif t in _CLOSES and opened:
            closes[opened.pop()] = i
    return closes


class _Reader:
    def __init__(self, tokens: List[str]):
        self.t = tokens
        self.n = len(tokens)
        self.i = 0
        self.closes = _closings(tokens)

    def at(self, ahead: int = 0) -> str:
        j = self.i + ahead
        return self.t[j] if j < self.n else ""

    def past(self, opening: int) -> int:
        """Past the bracket ``opening`` opened, each token read on the way counted."""
        end = self.closes.get(opening, self.n - 1) + 1
        cost = max(0, end - self.i)
        self.i = max(self.i, end)
        return cost

    # -- statements ------------------------------------------------------------

    def statement(self) -> int:
        """Clauses, read loosely: what follows WHERE, a projection's items,
        ORDER BY, SKIP, LIMIT and UNWIND are expressions; patterns are read as
        patterns; anything else costs its token."""
        cost = 0
        while self.i < self.n:
            before = self.i
            w = self.t[self.i]
            if w in ("WHERE", "SKIP", "LIMIT", "UNWIND"):
                self.i += 1
                cost += 1 + self.expression()
            elif w in ("WITH", "RETURN", "BY", "YIELD"):
                self.i += 1
                cost += 1 + self.items()
            elif w in ("MATCH", "MERGE", "CREATE"):
                self.i += 1
                cost += 1 + self.patterns()
            if self.i == before:            # never stuck
                self.i += 1
                cost += 1
        return cost

    def items(self) -> int:
        cost = 0
        if self.at() == "DISTINCT":
            self.i += 1
            cost += 1
        while self.i < self.n:
            if self.at() == "*":
                self.i += 1
                cost += 1
            else:
                cost += self.expression()
            if self.at() == "AS":
                self.i += 2
                cost += 2
            if self.at() in ("ASC", "ASCENDING", "DESC", "DESCENDING"):
                self.i += 1
                cost += 1
            if self.at() != ",":
                break
            self.i += 1
            cost += 1
        return cost

    def patterns(self) -> int:
        cost = 0
        while self.i < self.n:
            if self.at(1) == "=" and _is_name(self.at()):
                self.i += 2                 # a path's name
                cost += 2
            cost += self.pattern()
            if self.at() != ",":
                break
            self.i += 1
            cost += 1
        return cost

    def pattern(self) -> int:
        """Nodes and relationships, ``shortestPath(…)`` too; a pattern's
        property maps hold expressions."""
        cost = 0
        while self.i < self.n:
            t = self.t[self.i]
            if t in ("(", "["):
                cost += self.pattern_part()
            elif t in _ARROWS:
                self.i += 1
                cost += 1
            elif t in ("SHORTESTPATH", "ALLSHORTESTPATHS") and self.at(1) == "(":
                self.i += 1
                cost += 1 + self.pattern_part()
            else:
                break
        return cost

    def pattern_part(self) -> int:
        """A node or relationship in brackets: names, labels, ranges, and a
        property map whose values are expressions."""
        opening = self.i
        end = self.closes.get(opening, self.n - 1)
        self.i += 1
        cost = 1
        while self.i < end:
            t = self.t[self.i]
            if t == "{":
                cost += self.map_literal()
            elif t in ("(", "["):
                cost += self.pattern_part()     # a node inside shortestPath( … )
            else:
                self.i += 1
                cost += 1
        return cost + self.past(opening)

    # -- expressions -------------------------------------------------------------

    def expression(self, context: int = 0) -> int:
        """``_expression`` at ``context``: its atom, then the continuations
        that rank at least as high — or, with none, its atom a second time."""
        if self.i >= self.n or self.t[self.i] in _ENDS:
            return 0
        atom = self.prefixed()
        extra, continued = 0, False
        t, n = self.t, self.n
        while self.i < n:
            s = t[self.i]
            if s == "." and _DOT >= context:
                self.i += 2
                extra += 2
            elif s == ":" and _DOT >= context and self.at(1) != ":":
                self.i += 2                     # a label check, n:Label
                extra += 2
            elif s == "[" and _BRACKET >= context:
                extra += self.subscript()
            elif s == "IS" and _POSTFIX >= context:
                self.i += 3 if self.at(1) == "NOT" else 2
                extra += 3
            else:
                rank = _INFIX.get(s)
                if rank is None or rank < context:
                    break
                self.i += 2 if s in ("STARTS", "ENDS") else 1
                extra += 1 + self.expression(rank if s in _RIGHT_ASSOC else rank + 1)
            continued = True
        return atom + extra if continued else 2 * atom + extra

    def prefixed(self) -> int:
        """``_atom``: a prefix operator and its operand, or an atom."""
        s = self.at()
        if s == "NOT":
            self.i += 1
            return 1 + self.expression(_NOT)
        if s in ("-", "+"):
            self.i += 1
            return 1 + self.expression(_UNARY)
        return self.atom()

    def atom(self) -> int:
        s = self.t[self.i]
        if s == "(":
            return self.parenthesized()
        if s == "[":
            return self.bracketed_list()
        if s == "{":
            return self.map_literal()
        if s == "CASE":
            return self.case()
        if s in _PREDICATES and self.at(1) == "(":
            self.i += 1
            return 1 + self.comprehension_body()
        if _is_name(s):
            j = 0
            while self.at(j + 1) == "." and self.at(j + 2):
                j += 2                           # a namespaced function
            if self.at(j + 1) == "(":
                self.i += j + 1
                return j + 1 + self.call()
        self.i += 1
        return 1

    def parenthesized(self) -> int:
        """``( expression )``, or a pattern used as a predicate: ``(a)-…``."""
        opening = self.i
        if self.at(self.closes.get(opening, self.n) - opening + 1) in ("-", "<-", "->"):
            return self.pattern()
        self.i += 1
        return 1 + self.expression() + self.past(opening)

    def bracketed_list(self) -> int:
        """A list comprehension, a pattern comprehension or a list literal."""
        opening = self.i
        self.i += 1
        cost = 1
        named = self.at(1) == "=" and _is_name(self.at())
        if self.at(1) == "IN" and self.at() not in _ENDS:
            self.i += 2
            cost += 2 + self.expression()
        elif named or self.at() == "(":
            if named:
                self.i += 2
                cost += 2
            cost += self.pattern()
        else:
            while self.i < self.n:
                cost += self.expression()
                if self.at() != ",":
                    break
                self.i += 1
                cost += 1
            return cost + self.past(opening)
        if self.at() == "WHERE":
            self.i += 1
            cost += 1 + self.expression()
        if self.at() == "|":
            self.i += 1
            cost += 1 + self.expression()
        return cost + self.past(opening)

    def comprehension_body(self) -> int:
        """``( x IN list WHERE p | v )`` and reduce's ``( a = init, x IN list | v )``."""
        opening = self.i
        self.i += 1
        cost = 1
        if self.at(1) == "=":
            self.i += 2
            cost += 2 + self.expression()
            if self.at() == ",":
                self.i += 1
                cost += 1
        if self.at(1) == "IN":
            self.i += 2
            cost += 2 + self.expression()
        if self.at() == "WHERE":
            self.i += 1
            cost += 1 + self.expression()
        if self.at() == "|":
            self.i += 1
            cost += 1 + self.expression()
        return cost + self.past(opening)

    def call(self) -> int:
        """A function's arguments, each an expression; ``count(*)`` too."""
        opening = self.i
        self.i += 1
        cost = 1
        if self.at() == "DISTINCT":
            self.i += 1
            cost += 1
        while self.i < self.n and self.at() != ")":
            if self.at() == "*":
                self.i += 1
                cost += 1
            else:
                cost += self.expression()
            if self.at() != ",":
                break
            self.i += 1
            cost += 1
        return cost + self.past(opening)

    def case(self) -> int:
        self.i += 1
        cost = 1
        if self.at() != "WHEN":
            cost += self.expression()
        while self.at() == "WHEN":
            self.i += 1
            cost += 1 + self.expression()
            if self.at() == "THEN":
                self.i += 1
                cost += 1 + self.expression()
        if self.at() == "ELSE":
            self.i += 1
            cost += 1 + self.expression()
        if self.at() == "END":
            self.i += 1
            cost += 1
        return cost

    def subscript(self) -> int:
        """``[i]`` or ``[a..b]`` after an atom. A slice is read as an index
        first, so its start is read twice."""
        opening = self.i
        self.i += 1
        start = self.expression()
        cost = 1 + start
        if self.at() == "..":
            self.i += 1
            cost += start + 1 + self.expression()
        return cost + self.past(opening)

    def map_literal(self) -> int:
        opening = self.i
        self.i += 1
        cost = 1
        while self.i < self.n and self.at() != "}":
            self.i += 1                         # the key
            cost += 1
            if self.at() == ":":
                self.i += 1
                cost += 1 + self.expression()
            if self.at() != ",":
                break
            self.i += 1
            cost += 1
        return cost + self.past(opening)


_COSTS: "OrderedDict[int, int]" = OrderedDict()


def parse_cost(text: str) -> int:
    """Token reads FalkorDB's parser makes on ``text``, re-reads included.
    Remembered for the last few thousand texts, as engines send one statement
    many times; names, literals and parameters don't change the cost, so
    statements that differ only in them — one per label — share an answer."""
    key = hash(_LITERALS.sub("_", text))
    cost = _COSTS.get(key)
    if cost is None:
        try:
            cost = _Reader(_scan(text)).statement()
        except RecursionError:
            cost = MAX_PARSE_COST + 1       # nested hundreds deep: past any budget
        _COSTS[key] = cost
        if len(_COSTS) > 4096:
            _COSTS.popitem(last=False)
    else:
        _COSTS.move_to_end(key)
    return cost


_LITERALS = re.compile(r"`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|\$\w+")


# ---------------------------------------------------------------------------
# Writing conditions FalkorDB parses once
# ---------------------------------------------------------------------------

def _alone(tokens: List[str]) -> bool:
    """Whether ``tokens`` are one operand with no operator after it: a
    bracket, a call, a CASE, or NOT and what it negates, from first to last."""
    n = len(tokens)
    if tokens[0] == "NOT":
        # NOT takes in what binds tighter than it: alone unless AND, OR or XOR
        # follows at the top.
        closes, i = _closings(tokens), 1
        while i < n:
            if tokens[i] in ("AND", "OR", "XOR"):
                return False
            i = closes.get(i, i) + 1
        return True
    i = 0
    if tokens[0] == "CASE":
        depth = 0
        for i, t in enumerate(tokens):
            depth += (t == "CASE") - (t == "END")
            if depth == 0:
                break
        return i == n - 1
    if _is_name(tokens[0]):
        if n > 1 and tokens[1] == "(":
            i = 1
        else:
            return n == 1
    if tokens[i] in _OPENS:
        return _closings(tokens).get(i) == n - 1
    return n == 1


def operand(expr: str) -> str:
    """The condition ``expr`` written so FalkorDB parses it once wherever it
    is put: in a group, under a NOT, in a comprehension, as an argument."""
    tokens = _scan(expr)
    if len(tokens) < 2 or not _alone(tokens):
        return expr                     # one word, or an operator follows it
    if tokens[0] == "NOT":
        return negated(expr[expr.upper().index("NOT") + 3:].lstrip())
    return f"{expr} = true"


def negated(expr: str) -> str:
    """NOT ``expr``, written so FalkorDB parses it once wherever it is put."""
    tokens = _scan(expr)
    if len(tokens) == 1:
        return f"NOT {expr}"
    if not _alone(tokens):
        return f"({expr}) = false"
    if tokens[0] == "NOT":
        return operand(expr[expr.upper().index("NOT") + 3:].lstrip())   # NOT NOT x is x
    return f"{expr} = false"


def once(expr: str, identity: str) -> str:
    """``expr`` followed by ``identity`` — an operator and an operand that leave
    its value as it is, ``+ 0.0`` for a number, ``+ []`` for a list — where
    nothing follows it, so FalkorDB parses it once wherever it is put."""
    tokens = _scan(expr)
    return f"{expr} {identity}" if len(tokens) > 1 and _alone(tokens) else expr


def grouped(expr: str) -> str:
    """``expr`` in brackets, unless it is in brackets already: a second pair
    doubles what FalkorDB parses of it."""
    tokens = _scan(expr)
    if tokens and tokens[0] == "(" and _closings(tokens).get(0) == len(tokens) - 1:
        return expr
    return f"({expr})"
