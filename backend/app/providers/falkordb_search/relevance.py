"""Relevance as a Cypher expression — the ranking ``_score_hit`` computes.

The capped engine scored its candidates in Python (``_score_hit`` over the
projected rows) and sorted them. The uncapped engine ranks inside every
chunk, so the same score has to be a Cypher expression over ``n``:

    score = max over text leaves, fields and needles of
            min(tier, ceiling(leaf, field)) × weight(field)

* tiers — exact 100, prefix 60, word 40, substring 20, reachable as the
  leaf's match mode allows (``_match_tier``);
* weights — displayName 1.0, tags 0.6, qualifiedName / property 0.5,
  description 0.4 (``_FIELD_WEIGHTS``);
* ceilings — ``_tier_ceiling``, applied here at build time;
* a ``target='any'`` leaf that none of the row's fields explains still
  scores the unattributed floor (``_UNATTRIBUTED_MATCH_SCORE``), exactly as
  a projected row does.

The fields are the ones a projected row carries (``_hit_projection``): the
name columns, description, tags, and the properties the query names. One
approximation, because FalkorDB has no regular expressions: the word tier
(``(?<!\\w)needle``) treats a character as part of a word when it is ASCII
alphanumeric, ``_``, or a cased letter (``toLower(c) <> toUpper(c)``) — an
uncased script (CJK, Arabic, …) or a non-ASCII digit before a needle ranks
it at the word tier where Python says substring. The order is this
expression's; the ``score`` a hit reports is still computed in Python from
the hydrated node, so a difference changes an annotation, never the order
or the page a hit lands on.

Every comprehension variable is private and numbered — FalkorDB does not
scope them (``falkordb_typed_ops``), and one expression nests many.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from backend.app.providers.falkordb_deep_search import (
    _FIELD_WEIGHTS,
    _TIER_EXACT,
    _TIER_PREFIX,
    _TIER_SUBSTRING,
    _TIER_WORD,
    _UNATTRIBUTED_MATCH_SCORE,
    _collect_text_leaves,
    _is_unattributable,
    _leaf_needles,
    _safe_property_name,
    _tier_ceiling,
)
from backend.app.providers.falkordb_typed_ops import text_of
from backend.common.models.search import GroupPredicate, PropertyPredicate, SearchQuery
from backend.common.search_semantics import fold_case


def display_name_expr(name_key: Optional[str]) -> str:
    """The row's display name: the first non-empty text of displayName, the
    source's name property, name, title, label — ``_rows_to_candidates``'s
    fallbacks, as ``or`` chains them. Null when there is none."""
    columns = ["displayName"]
    for key in (name_key, "name", "title", "label"):
        if key and key not in columns:
            columns.append(key)
    parts = ", ".join(_text_if_any(f"n.{_safe_property_name(c)}") for c in columns)
    return f"coalesce({parts})"


def _text_if_any(col: str) -> str:
    return f"CASE WHEN typeOf({col}) = 'String' AND {col} <> '' THEN {col} END"


def _string_only(col: str) -> str:
    return f"CASE WHEN typeOf({col}) = 'String' THEN {col} END"


def score_expr(
    query: SearchQuery, *, name_key: Optional[str] = None,
    reserved_keys: frozenset = frozenset(),
) -> Optional[Tuple[str, Dict[str, Any]]]:
    """``(expression, parameters)`` scoring a node the way ``_score_hit``
    scores a projected row, or None when the query has no text to score."""
    b = _Builder()
    property_keys = _projected_property_keys(query, reserved_keys)
    certain = _certain_leaves(query.predicate)
    leaves: List[str] = []
    constant = 0.0
    for _index, pred in _collect_text_leaves(query.predicate):
        needles, mode = _leaf_needles(pred)
        if not needles:
            continue
        fields = _fields(b, pred, name_key, property_keys, reserved_keys)
        if mode == "exact" and len(fields) == 1 and id(pred) in certain:
            # Every match satisfies this leaf, and an exact comparison on one
            # field can only be satisfied exactly: its score is the same on
            # every row, so it is a number, not work per row.
            field, _texts, _is_list, weight = fields[0]
            constant = max(constant, float(min(_TIER_EXACT, _tier_ceiling(pred, field)) * weight))
            continue
        case_sensitive = bool(getattr(pred, "case_sensitive", False))
        bound = [b.bind(n if case_sensitive else fold_case(n)) for n in needles]
        terms = [
            b.field_term(texts, is_list, needle, mode,
                         weight=weight, ceiling=_tier_ceiling(pred, field),
                         case_sensitive=case_sensitive)
            for field, texts, is_list, weight in fields
            for needle in bound
        ]
        leaf = b.maximum(terms)
        if _is_unattributable(pred):
            x = b.var("u")
            leaf = (f"[{x} IN [{leaf}] | CASE WHEN {x} > 0 THEN {x} "
                    f"ELSE {float(_UNATTRIBUTED_MATCH_SCORE)} END][0]")
        leaves.append(leaf)
    if not leaves:
        # Nothing, or only constants: every match scores alike and the
        # name decides, exactly as a constant key would.
        return None
    if constant:
        leaves.append(str(constant))
    return b.maximum(leaves), b.params


def _certain_leaves(predicate) -> set:
    """The leaves every match satisfies: those joined to the root by AND
    alone (not under an OR or a NOT)."""
    out: set = set()

    def walk(p) -> None:
        if isinstance(p, GroupPredicate):
            if p.op == "and":
                for child in p.children:
                    walk(child)
            return
        out.add(id(p))

    walk(predicate)
    return out


def _projected_property_keys(query: SearchQuery, reserved_keys: frozenset) -> List[str]:
    """The properties a projected row carries (``_hit_projection``)."""
    keys: List[str] = []
    for _index, leaf in _collect_text_leaves(query.predicate):
        key = leaf.key if isinstance(leaf, PropertyPredicate) else (
            leaf.property_key if getattr(leaf, "target", None) == "property" else None)
        if key and key not in keys:
            keys.append(key)
    if query.options.sort_property and query.options.sort_property not in keys:
        keys.append(query.options.sort_property)
    return [k for k in keys if k not in reserved_keys]


def _element_texts(b: "_Builder", col: str) -> str:
    """Each element's text, a scalar as one element — ``element_texts``."""
    e = b.var("e")
    return f"[{e} IN CASE WHEN typeOf({col}) = 'List' THEN {col} ELSE [{col}] END | {text_of(e)}]"


def _fields(b: "_Builder", pred, name_key, property_keys, reserved_keys):
    """``(field, texts, is_list, weight)`` per field the leaf scores against —
    ``_scored_fields`` over a projected row."""
    w = _FIELD_WEIGHTS
    if isinstance(pred, PropertyPredicate):
        if pred.key in reserved_keys:
            return []
        col = f"n.{_safe_property_name(pred.key)}"
        return [(f"property:{pred.key}", _element_texts(b, col), True, w["property"])]
    out = []
    target = pred.target
    if target in ("name", "any"):
        out.append(("displayName", display_name_expr(name_key), False, w["displayName"]))
    if target in ("name", "qualifiedName", "any"):
        out.append(("qualifiedName", _string_only("n.qualifiedName"), False, w["qualifiedName"]))
    if target in ("description", "any"):
        out.append(("description", _string_only("n.description"), False, w["description"]))
    if target in ("tags", "any"):
        # A list of tags scores each tag; tags stored as a JSON string score
        # the string, which reaches the same capped tiers for a needle
        # inside one tag.
        out.append(("tags", "CASE WHEN typeOf(n.tags) = 'List' THEN n.tags "
                            "WHEN typeOf(n.tags) = 'String' THEN [n.tags] ELSE [] END",
                    True, w["tags"]))
    if target == "property" and pred.property_key and pred.property_key not in reserved_keys:
        col = f"n.{_safe_property_name(pred.property_key)}"
        out.append((f"property:{pred.property_key}", _element_texts(b, col), True, w["property"]))
    if target == "any":
        for key in property_keys:
            col = f"n.{_safe_property_name(key)}"
            out.append((f"property:{key}", _string_only(col), False, w["property"]))
    return out


# Tiers each match mode can reach, best first (``_match_tier``).
_MODE_TIERS = {
    "exact": ("exact",),
    "prefix": ("exact", "prefix"),
    "suffix": ("exact", "suffix"),
    "substring": ("exact", "prefix", "word", "substring"),
}
_TIER_VALUE = {
    "exact": _TIER_EXACT, "prefix": _TIER_PREFIX, "word": _TIER_WORD,
    "suffix": _TIER_SUBSTRING, "substring": _TIER_SUBSTRING,
}


class _Builder:
    def __init__(self) -> None:
        self.params: Dict[str, Any] = {}
        self._vars = 0

    def bind(self, value: Any) -> str:
        name = f"_rel{len(self.params)}"
        self.params[name] = value
        return f"${name}"

    def var(self, stem: str) -> str:
        self._vars += 1
        return f"_{stem}{self._vars}"

    def maximum(self, exprs: List[str]) -> str:
        if not exprs:
            return "0.0"
        if len(exprs) == 1:
            return exprs[0]
        m, s = self.var("m"), self.var("s")
        return (f"reduce({m} = 0.0, {s} IN [{', '.join(exprs)}] | "
                f"CASE WHEN {s} > {m} THEN {s} ELSE {m} END)")

    def field_term(self, texts: str, is_list: bool, needle: str, mode: str, *,
                   weight: float, ceiling: int, case_sensitive: bool) -> str:
        if not is_list:
            return self._tier(texts, needle, mode, weight, ceiling, case_sensitive)
        h, m, s = self.var("h"), self.var("m"), self.var("s")
        tier = self._tier(h, needle, mode, weight, ceiling, case_sensitive)
        return (f"reduce({m} = 0.0, {s} IN [{h} IN {texts} | {tier}] | "
                f"CASE WHEN {s} > {m} THEN {s} ELSE {m} END)")

    def _tier(self, text: str, needle: str, mode: str, weight: float,
              ceiling: int, case_sensitive: bool) -> str:
        """``min(tier, ceiling) × weight`` of one text against one needle."""
        h = self.var("t")
        haystack = text if case_sensitive else f"toLower({text})"
        tests = {
            "exact": f"{h} = {needle}",
            "prefix": f"{h} STARTS WITH {needle}",
            "suffix": f"{h} ENDS WITH {needle}",
            "word": self._word(h, needle),
            "substring": f"{h} CONTAINS {needle}",
        }
        branches = " ".join(
            f"WHEN {tests[t]} THEN {float(min(_TIER_VALUE[t], ceiling) * weight)}"
            for t in _MODE_TIERS.get(mode, ("exact",))
        )
        return f"[{h} IN [{haystack}] | CASE {branches} ELSE 0.0 END][0]"

    def _word(self, h: str, needle: str) -> str:
        """Some occurrence of the needle follows a non-word character.

        ``split`` cuts the text at every occurrence; the character before
        occurrence j is the last one of part j — or of the needle itself
        when part j is empty (the occurrence follows the previous one). The
        first occurrence at position 0 is the prefix tier, tested first.
        """
        q, j, c = self.var("q"), self.var("j"), self.var("c")
        before = f"CASE WHEN {q}[{j}] = '' THEN {needle} ELSE {q}[{j}] END"
        return (
            f"ANY({q} IN [split(coalesce({h}, ''), {needle})] WHERE "
            f"ANY({j} IN range(0, size({q}) - 2) WHERE "
            f"ANY({c} IN [substring({before}, size({before}) - 1, 1)] WHERE "
            f"NOT ({c} = '_' OR ({c} >= '0' AND {c} <= '9') "
            f"OR toLower({c}) <> toUpper({c})))))"
        )
