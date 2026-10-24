"""A Cypher tokenizer: enough of the language to tell keywords and names,
literals, parameters and comments apart, and how deep in brackets each
token sits.

One tokenizer for everything that reads Cypher text here — what the guard
refuses on (``guard``), where a row cap goes (``limit``) and where a
parameter can be written as its value (``cypher_text``) — so a keyword in a
string or a comment is never mistaken for one in the query, by any of them.

Not a parser: it never decides whether a query is valid Cypher (the
database does), only what each piece of text is.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

#: Token kinds.
WORD = "word"           # an identifier or keyword
BACKTICK = "backtick"   # `an escaped name`
STRING = "string"       # 'a' or "a"
NUMBER = "number"
PARAM = "param"         # $name, $0, $`name`
PUNCT = "punct"         # ( ) [ ] { } , ; : . |
OP = "op"               # = <> <= >= != =~ -> <- + - * / % ^ ..
COMMENT = "comment"     # // … or /* … */
SPACE = "space"

_OPENERS = {"(": ")", "[": "]", "{": "}"}
_CLOSERS = {")", "]", "}"}
_OPS = ("=~", "<>", "<=", ">=", "!=", "->", "<-", "..", "+=")
_SINGLE_OPS = set("=<>+-*/%^!")
_PUNCT = set("()[]{},;:.|")


class LexError(ValueError):
    """Text Cypher can't hold: an unclosed string, comment or name, or
    brackets that don't pair. ``position``: where, in characters."""

    def __init__(self, message: str, position: int) -> None:
        super().__init__(message)
        self.position = position


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    start: int
    end: int
    #: Brackets open around it; a bracket itself counts as outside.
    depth: int

    @property
    def upper(self) -> str:
        return self.text.upper()


def tokenize(text: str, *, trivia: bool = False) -> List[Token]:
    """Every token in ``text``, in order. ``trivia``: keep spaces and
    comments too, so the tokens join back into exactly ``text``."""
    out: List[Token] = []
    stack: List[tuple] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        start = i
        if c.isspace():
            while i < n and text[i].isspace():
                i += 1
            if trivia:
                out.append(Token(SPACE, text[start:i], start, i, len(stack)))
            continue
        if text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
            if trivia:
                out.append(Token(COMMENT, text[start:i], start, i, len(stack)))
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end == -1:
                raise LexError("a /* comment is never closed", start)
            i = end + 2
            if trivia:
                out.append(Token(COMMENT, text[start:i], start, i, len(stack)))
            continue
        if c in ("'", '"'):
            i = _string_end(text, i)
            out.append(Token(STRING, text[start:i], start, i, len(stack)))
            continue
        if c == "`":
            i = _backtick_end(text, i)
            out.append(Token(BACKTICK, text[start:i], start, i, len(stack)))
            continue
        if c == "$":
            i += 1
            if i < n and text[i] == "`":
                i = _backtick_end(text, i)
            else:
                while i < n and (text[i].isalnum() or text[i] == "_"):
                    i += 1
            if i == start + 1:
                raise LexError("a $ with no parameter name", start)
            out.append(Token(PARAM, text[start:i], start, i, len(stack)))
            continue
        if c.isdigit() or (c == "." and i + 1 < n and text[i + 1].isdigit()
                           and not (out and out[-1].kind in (WORD, BACKTICK, NUMBER))):
            i = _number_end(text, i)
            out.append(Token(NUMBER, text[start:i], start, i, len(stack)))
            continue
        if c.isalpha() or c == "_":
            while i < n and (text[i].isalnum() or text[i] == "_"):
                i += 1
            out.append(Token(WORD, text[start:i], start, i, len(stack)))
            continue
        if c in _OPENERS:
            out.append(Token(PUNCT, c, start, i + 1, len(stack)))
            stack.append((_OPENERS[c], start))
            i += 1
            continue
        if c in _CLOSERS:
            if not stack or stack[-1][0] != c:
                raise LexError(f"a {c} with nothing to close", start)
            stack.pop()
            out.append(Token(PUNCT, c, start, i + 1, len(stack)))
            i += 1
            continue
        op = next((o for o in _OPS if text.startswith(o, i)), None)
        if op:
            i += len(op)
            out.append(Token(OP, op, start, i, len(stack)))
            continue
        if c in _SINGLE_OPS:
            out.append(Token(OP, c, start, i + 1, len(stack)))
            i += 1
            continue
        if c in _PUNCT:
            out.append(Token(PUNCT, c, start, i + 1, len(stack)))
            i += 1
            continue
        raise LexError(f"{c!r} isn't part of Cypher", start)
    if stack:
        closer, at = stack[-1]
        raise LexError(f"a bracket is never closed — it wants a {closer}", at)
    return out


def _string_end(text: str, i: int) -> int:
    quote, j, n = text[i], i + 1, len(text)
    while j < n:
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == quote:
            return j + 1
        j += 1
    raise LexError("a string is never closed", i)


def _backtick_end(text: str, i: int) -> int:
    j, n = i + 1, len(text)
    while j < n:
        if text[j] == "`":
            if j + 1 < n and text[j + 1] == "`":     # `` is an escaped backtick
                j += 2
                continue
            return j + 1
        j += 1
    raise LexError("a `name` is never closed", i)


def _number_end(text: str, i: int) -> int:
    n = len(text)
    if text.startswith(("0x", "0X", "0o", "0O"), i):
        j = i + 2
        while j < n and (text[j].isalnum() or text[j] == "_"):
            j += 1
        return j
    j = i
    while j < n and (text[j].isdigit() or text[j] == "_"):
        j += 1
    # A fraction — never the start of a range (1..3).
    if j < n and text[j] == "." and j + 1 < n and text[j + 1].isdigit():
        j += 1
        while j < n and (text[j].isdigit() or text[j] == "_"):
            j += 1
    if j < n and text[j] in "eE":
        k = j + 1
        if k < n and text[k] in "+-":
            k += 1
        if k < n and text[k].isdigit():
            j = k
            while j < n and text[j].isdigit():
                j += 1
    return j
