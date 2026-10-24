"""What a native query may do: read the graph — and nothing else.

The engines enforce read-only themselves (FalkorDB's ``GRAPH.RO_QUERY``,
Neo4j's READ transactions and its own read-only check of the plan), so this
guard is the layer in front of them, and the only one for what an engine
would happily run as a read but must never run for a person here:

* more than one statement, or query options (``CYPHER …``);
* a write or administration clause — refused even though the engine would
  refuse it too, so the person reads why;
* ``LOAD CSV`` (files and URLs: the server would fetch them), ``USE``
  (another database), ``SHOW``, ``EXPLAIN`` / ``PROFILE``, batching in
  transactions;
* ``CALL`` of anything but a short list of read procedures — schema
  listings and the full-text and vector index queries, per engine;
* a namespaced function outside the engine's built-in namespaces, which
  keeps out ``apoc.*``, ``gds.*`` and every plugin;
* a ``$parameter`` — a native query carries its values in its text;
* a line break an engine might read differently from the guard — so where a
  ``//`` comment ends is never in doubt (``normalized`` turns ``\r\n`` and
  ``\r`` into ``\n`` first: Neo4j ends a comment at a lone ``\r``, FalkorDB
  doesn't, and text one of them read as code must never be a comment to the
  guard).

Every refusal names where it is (``position``). It reads tokens, never raw
text, so a keyword in a string, a comment or a backtick name is never
mistaken for one — and a word that can't be a keyword where it stands (a
property, a label, a map key) is left alone.
"""
from __future__ import annotations

import re
from typing import Dict, FrozenSet, List, Tuple

from backend.app.services.native_query.lexer import (
    BACKTICK,
    PARAM,
    PUNCT,
    WORD,
    LexError,
    Token,
    is_clause_word,
    tokenize,
)
from backend.common.interfaces.native_query import NativeQueryRefused, NativeQuerySyntaxError

FALKORDB = "falkordb"
NEO4J = "neo4j"
ENGINES = (FALKORDB, NEO4J)

#: Words that make a query something other than a read of this graph.
_DENIED: Dict[str, str] = {
    **dict.fromkeys(
        ("CREATE", "INSERT", "MERGE", "SET", "DELETE", "DETACH", "REMOVE", "FOREACH"),
        "writes to the graph",
    ),
    **dict.fromkeys(
        ("DROP", "ALTER", "RENAME", "GRANT", "DENY", "REVOKE", "TERMINATE", "START", "STOP",
         "ENABLE", "DISABLE", "DEALLOCATE", "REALLOCATE"),
        "changes the database",
    ),
    "LOAD": "reads files or URLs",
    "USE": "reads another database",
    "SHOW": "isn't a query of the graph",
    "EXPLAIN": "isn't a query of the graph",
    "PROFILE": "isn't a query of the graph",
    "CYPHER": "sets query options",
    "TRANSACTIONS": "batches writes",
    "PERIODIC": "batches writes",
}

#: Schema listings: small, and fine to CALL without a RETURN.
_METADATA = {
    FALKORDB: ("db.labels", "db.relationshipTypes", "db.propertyKeys", "db.indexes",
               "db.constraints"),
    NEO4J: ("db.labels", "db.relationshipTypes", "db.propertyKeys", "db.schema.visualization",
            "db.schema.nodeTypeProperties", "db.schema.relTypeProperties"),
}
#: …and the index queries, which return rows and so end in a RETURN.
_INDEX_QUERIES = {
    FALKORDB: ("db.idx.fulltext.queryNodes", "db.idx.fulltext.queryRelationships",
               "db.idx.vector.queryNodes", "db.idx.vector.queryRelationships"),
    NEO4J: ("db.index.fulltext.queryNodes", "db.index.fulltext.queryRelationships",
            "db.index.vector.queryNodes", "db.index.vector.queryRelationships"),
}
#: Lower case, as names are compared.
METADATA_PROCEDURES: Dict[str, FrozenSet[str]] = {
    engine: frozenset(n.lower() for n in names) for engine, names in _METADATA.items()
}
PROCEDURES: Dict[str, FrozenSet[str]] = {
    engine: METADATA_PROCEDURES[engine] | {n.lower() for n in _INDEX_QUERIES[engine]}
    for engine in ENGINES
}

#: The built-in namespaces a function may be called from (lower case).
FUNCTION_NAMESPACES: Dict[str, FrozenSet[str]] = {
    FALKORDB: frozenset({"vec", "string", "list"}),
    NEO4J: frozenset({
        "date", "datetime", "localdatetime", "localtime", "time", "duration", "point",
        "vector.similarity",
    }),
}


#: Line breaks other than ``\n``. Engines disagree on whether a ``//``
#: comment ends at them; after ``normalized``, none may remain.
_UNCLEAR_BREAK = re.compile("[\r\x0b\x0c\x85\u2028\u2029]")


def normalized(text: str) -> str:
    """``text`` with every ``\r\n`` and ``\r`` a ``\n``: what the guard
    checks, the row cap rewrites and the engine runs."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def check(text: str, *, engine: str) -> List[Token]:
    """The tokens of ``text`` (``normalized`` first), when it is a query a
    native read may run on ``engine``. Raises ``NativeQuerySyntaxError`` for
    text that isn't Cypher, ``NativeQueryRefused`` for a query that may not
    run."""
    unclear = _UNCLEAR_BREAK.search(text)
    if unclear:
        raise NativeQueryRefused(
            "The query has a line break that isn't a plain one. Write it again with plain line "
            "breaks.",
            position=unclear.start(),
        )
    try:
        tokens = tokenize(text)
    except LexError as exc:
        raise NativeQuerySyntaxError(str(exc).capitalize() + ".", position=exc.position) from exc
    if not tokens:
        raise NativeQueryRefused("Write a query to run.")
    for i, token in enumerate(tokens):
        if token.kind == PUNCT and token.text == ";" and i != len(tokens) - 1:
            raise NativeQueryRefused("Run one statement at a time.", position=token.start)
        if token.kind == PARAM:
            raise NativeQueryRefused(
                f"Write the value into the query: {token.text} has nothing to stand for here.",
                position=token.start,
            )
        if not is_clause_word(tokens, i):
            continue
        word = token.upper
        if word in _DENIED:
            # A keyword written in lower case is as often a name.
            hint = "" if token.text.isupper() else (
                f" If it's a name, write it in backticks: `{token.text}`.")
            raise NativeQueryRefused(
                f"{word} {_DENIED[word]}, and native queries only read.{hint}",
                position=token.start,
            )
        if word == "CALL":
            _check_call(tokens, i, engine)
    _check_functions(tokens, engine)
    return tokens


def procedure_at(tokens: List[Token], i: int) -> Tuple[str, int]:
    """The procedure name a ``CALL`` at ``i`` names (lower case, "" when it
    names none — a subquery) and the index after it."""
    parts, after = _dotted(tokens, i + 1)
    return ".".join(parts).lower(), after


def _check_call(tokens: List[Token], i: int, engine: str) -> None:
    following = tokens[i + 1] if i + 1 < len(tokens) else None
    if following is not None and following.kind == PUNCT and following.text in ("{", "("):
        return                                  # a subquery: its clauses are checked like any
    name, _ = procedure_at(tokens, i)
    if not name:
        raise NativeQueryRefused("CALL needs a procedure, or a { subquery }.", position=tokens[i].start)
    if name not in PROCEDURES[engine]:
        raise NativeQueryRefused(
            f"{_shown(tokens, i + 1)} isn't a procedure native queries may call. They may call "
            f"{', '.join(_METADATA[engine] + _INDEX_QUERIES[engine])}.",
            position=tokens[i + 1].start,
        )


def _check_functions(tokens: List[Token], engine: str) -> None:
    """Refuse ``ns.fn(…)`` outside the engine's own namespaces."""
    for i, token in enumerate(tokens):
        if token.kind not in (WORD, BACKTICK):
            continue
        before = tokens[i - 1] if i > 0 else None
        if before is not None and before.kind == PUNCT and before.text == ".":
            continue                            # inside a chain already looked at
        if before is not None and before.kind == WORD and before.upper == "CALL":
            continue                            # a procedure: _check_call's
        parts, after = _dotted(tokens, i)
        called = after < len(tokens) and tokens[after].kind == PUNCT and tokens[after].text == "("
        if len(parts) < 2 or not called:
            continue
        namespace = ".".join(parts[:-1]).lower()
        allowed = FUNCTION_NAMESPACES[engine]
        if not any(namespace == ns or namespace.startswith(ns + ".") for ns in allowed):
            raise NativeQueryRefused(
                f"{_shown(tokens, i)} isn't a function native queries may use: only the "
                f"engine's built-in functions are allowed.",
                position=token.start,
            )


def _dotted(tokens: List[Token], i: int) -> Tuple[List[str], int]:
    """The names of a dotted chain (``a.b.c``) starting at ``i``, unquoted,
    and the index after it."""
    parts: List[str] = []
    while i < len(tokens) and tokens[i].kind in (WORD, BACKTICK):
        # `apoc.coll`.sum or `apoc.coll.sum`: a dot inside backticks still
        # names a namespace, as far as what may be called is concerned.
        parts.extend(_unquoted(tokens[i]).split("."))
        if (i + 2 < len(tokens) and tokens[i + 1].kind == PUNCT and tokens[i + 1].text == "."
                and tokens[i + 2].kind in (WORD, BACKTICK)):
            i += 2
            continue
        return parts, i + 1
    return parts, i


def _unquoted(token: Token) -> str:
    return token.text[1:-1].replace("``", "`") if token.kind == BACKTICK else token.text


def _shown(tokens: List[Token], i: int) -> str:
    parts, _ = _dotted(tokens, i)
    return ".".join(parts)

