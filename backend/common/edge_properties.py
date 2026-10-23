"""Where an edge keeps a property, and how a condition reads one it keeps
in its JSON.

An edge stores the platform's own fields natively (``EDGE_NATIVE_KEYS``)
and every user property in one JSON text, ``r.properties`` (ADR-026),
written by ``json.dumps`` with its default separators. Cypher can't parse
that text, so a condition on a key kept there reads it as text: the key is
present when ``"key": `` occurs in it, and equals a value when
``"key": <the value's JSON>`` does, followed by ``,`` or ending the object.
A nested object's key reads the same way — the one known false positive.
Such a key takes presence and equality (``JSON_OPS``); a native field takes
every operator.

``json_holds`` is that reading in Python: the reference semantics the stub
evaluates, and the live tests hold the compiled Cypher to.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from backend.common.search_semantics import Comparison, fold_case

#: The fields the writers set natively on an edge: its identity, confidence
#: and content hash (``falkordb_provider``, ``versioning/projection.py``),
#: and a rollup's (``AGGREGATED``) own.
EDGE_NATIVE_KEYS = frozenset({
    "id", "confidence", "gvHash",
    "aggKey", "weight", "sourceEdgeTypes", "sourceLevel", "targetLevel",
    "sourceDepth", "targetDepth", "levelDigest", "gvSeq", "latestUpdate",
})

#: What a condition may ask of a key kept in the JSON.
JSON_OPS = frozenset({"eq", "neq", "in", "notIn", "isSet", "isNotSet"})


def key_needle(key: str) -> str:
    """The text a key leaves in the JSON."""
    return json.dumps(key) + ": "


def value_texts(cmp: Comparison) -> List[str]:
    """Each value's JSON text as ``json.dumps`` writes it — a whole number
    both ways, since 5 and 5.0 are equal and written differently."""
    out = []
    for value in cmp.values:
        out.append(json.dumps(value))
        if cmp.type == "number" and float(value).is_integer():
            out.append(json.dumps(float(value) if isinstance(value, int) else int(value)))
    return list(dict.fromkeys(out))


def folds(cmp: Comparison) -> bool:
    """Whether the text is compared case-folded: a string ignoring case."""
    return cmp.type == "string" and not cmp.case_sensitive


def json_holds(properties: Optional[Dict[str, Any]], key: str, cmp: Comparison) -> bool:
    """``cmp`` on ``key`` as the compiled Cypher reads an edge's user
    ``properties``: presence by the exact key; equality by the JSON text of
    a top-level value, key and text folded alike when the comparison
    ignores case."""
    props = properties or {}
    present = key in props
    if cmp.op == "isSet":
        return present
    if cmp.op == "isNotSet":
        return not present

    def norm(text: str) -> str:
        return fold_case(text) if folds(cmp) else text

    texts = {norm(t) for t in value_texts(cmp)}
    equal = any(norm(k) == norm(key) and norm(json.dumps(v)) in texts
                for k, v in props.items())
    if cmp.op in ("eq", "in"):
        return equal
    # neq / notIn: a missing key passes only when asked to.
    return not equal if cmp.include_missing else present and not equal
