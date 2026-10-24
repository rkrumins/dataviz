"""The row cap a native query runs under, written into the query itself.

Each top-level ``RETURN`` — each side of a ``UNION`` — ends in
``LIMIT <cap + 1>``: added when it has none, lowered when it asks for more.
The one extra row is how a result says it was cut ("at least 201 rows; showing
200") without the engine producing more than that. A ``LIMIT`` the cap
can't be read from (a parameter, an expression) is refused, as is a query
that doesn't end in ``RETURN`` — except a bare schema listing (``CALL
db.labels()``), which is small by nature.

The cap is inserted right after the last token, never at the end of the text:
a ``// comment`` there would swallow it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

from backend.app.services.native_query.guard import METADATA_PROCEDURES, procedure_at
from backend.app.services.native_query.lexer import NUMBER, PUNCT, WORD, Token, is_clause_word
from backend.common.interfaces.native_query import NativeQueryRefused


@dataclass(frozen=True)
class Capped:
    #: What runs.
    text: str
    #: What was done to it, in words; empty when nothing was.
    notes: Tuple[str, ...]


def cap_rows(text: str, tokens: List[Token], *, limit: int, engine: str) -> Capped:
    """``text`` (tokenized as ``tokens``) under a cap of ``limit`` rows."""
    edits: List[Tuple[int, int, str]] = []
    if tokens and tokens[-1].kind == PUNCT and tokens[-1].text == ";":
        edits.append((tokens[-1].start, tokens[-1].end, ""))
        tokens = tokens[:-1]
    parts = _top_level_parts(tokens)
    if len(parts) == 1 and _bare_metadata_call(parts[0], engine):
        return Capped(_apply(text, edits), ())
    notes = []
    cap = str(limit + 1)
    for part in parts:
        returns = _last(part, "RETURN")
        if returns is None:
            at = part[0].start if part else len(text)
            raise NativeQueryRefused("End the query with RETURN, to say what to show.", position=at)
        limited = _last(part, "LIMIT", after=returns)
        if limited is None:
            edits.append((part[-1].end, part[-1].end, f" LIMIT {cap}"))
            notes.append(f"Added LIMIT {cap}: at most {limit:,} rows are shown.")
            continue
        asked = _whole_number(part, limited)
        if asked is None:
            raise NativeQueryRefused(
                "Write LIMIT as a whole number, like LIMIT 100.", position=part[limited].start,
            )
        if asked > limit:
            number = part[limited + 1]
            edits.append((number.start, number.end, cap))
            notes.append(f"Lowered LIMIT {asked:,} to {cap}: at most {limit:,} rows are shown.")
    return Capped(_apply(text, edits), tuple(dict.fromkeys(notes)))


def _top_level_parts(tokens: List[Token]) -> List[List[Token]]:
    """The statement split at each top-level UNION."""
    parts: List[List[Token]] = [[]]
    for i, token in enumerate(tokens):
        if token.depth == 0 and is_clause_word(tokens, i) and token.upper == "UNION":
            parts.append([])
        else:
            parts[-1].append(token)
    # UNION ALL: the ALL belongs to the union, not to the next part.
    return [p[1:] if p and p[0].kind == WORD and p[0].upper == "ALL" else p for p in parts]


def _bare_metadata_call(part: List[Token], engine: str) -> bool:
    if not part or part[0].kind != WORD or part[0].upper != "CALL" or _last(part, "RETURN") is not None:
        return False
    name, _ = procedure_at(part, 0)
    return name in METADATA_PROCEDURES[engine]


def _last(part: List[Token], word: str, *, after: int = -1) -> Optional[int]:
    """The index of the last top-level ``word`` keyword in ``part`` past ``after``."""
    for i in range(len(part) - 1, after, -1):
        if part[i].depth == 0 and part[i].upper == word and is_clause_word(part, i):
            return i
    return None


def _whole_number(part: List[Token], limited: int) -> Optional[int]:
    """The literal ``LIMIT n`` at ``limited`` asks for, when it is a plain
    whole number and the last thing in the part."""
    if limited + 2 != len(part) or part[limited + 1].kind != NUMBER:
        return None
    text = part[limited + 1].text.replace("_", "")
    try:
        if text[:2].lower() in ("0x", "0o"):
            return int(text, 0)
        return int(text) if text.isdigit() else None
    except ValueError:
        return None


def _apply(text: str, edits: List[Tuple[int, int, str]]) -> str:
    for start, end, insert in sorted(edits, reverse=True):
        text = text[:start] + insert + text[end:]
    return text
