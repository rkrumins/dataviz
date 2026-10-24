"""Cypher text with its parameters written in as values.

What "Copy" hands a person, and what "Edit and run" starts from: the
compiled query as a statement that runs on its own. A parameter is replaced
only where the tokenizer says one stands — never inside a string, a comment
or an escaped name, and ``$p1`` never inside ``$p10``.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, Optional

from backend.app.services.native_query.lexer import PARAM, LexError, tokenize

_INT64 = (-(2 ** 63), 2 ** 63 - 1)
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Unwritable(ValueError):
    """A value Cypher has no literal for (NaN, a datetime, an object…)."""


def to_cypher_literal(value: Any) -> str:
    """``value`` as a Cypher literal."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if not _INT64[0] <= value <= _INT64[1]:
            raise Unwritable("an integer past 64 bits")
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise Unwritable("NaN or infinity")
        # Cypher's exponent takes no "+".
        text = repr(value).replace("e+", "e")
        return text if any(c in text for c in ".e") else f"{text}.0"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(to_cypher_literal(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{_key(k)}: {to_cypher_literal(v)}" for k, v in value.items()) + "}"
    raise Unwritable(f"a {type(value).__name__}")


def _string(text: str) -> str:
    out = []
    for c in text:
        if c == "\\":
            out.append("\\\\")
        elif c == "'":
            out.append("\\'")
        elif c == "\n":
            out.append("\\n")
        elif c == "\r":
            out.append("\\r")
        elif c == "\t":
            out.append("\\t")
        elif ord(c) < 0x20:
            out.append(f"\\u{ord(c):04x}")
        else:
            out.append(c)
    return "'" + "".join(out) + "'"


def _key(key: Any) -> str:
    key = str(key)
    return key if _NAME.match(key) else "`" + key.replace("`", "``") + "`"


def inline_params(cypher: str, params: Dict[str, Any]) -> Optional[str]:
    """``cypher`` with each parameter written as its value — or None when a
    parameter has no value given, or no Cypher literal, or the text can't
    be read as Cypher."""
    try:
        out = []
        for token in tokenize(cypher, trivia=True):
            if token.kind != PARAM:
                out.append(token.text)
                continue
            name = token.text[1:]
            if name.startswith("`"):
                name = name[1:-1].replace("``", "`")
            if name not in params:
                return None
            out.append(to_cypher_literal(params[name]))
        return "".join(out)
    except (LexError, Unwritable):
        return None
