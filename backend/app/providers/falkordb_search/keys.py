"""The order a search ranks its matches in — as Cypher, so it can be chunked.

The uncapped engine never holds every match at once. Each chunk of the graph
returns its own count and its own first rows in order, and Python merges the
chunks. That is only exact if the order is a pure function of one node,
computed in Cypher, and if Python compares the values Cypher returns exactly
as Cypher ordered them. Both hold (docs/search-engine/S0_FINDINGS.md):

* strings order byte-wise in FalkorDB, which is how Python orders ``str``;
* integers do NOT order correctly at the int64 extremes — ``ORDER BY``,
  ``>`` and list comparison subtract and wrap — so a number sorts by its sign
  first and its value second: two values of one sign never overflow.

Every order ends on the node's ``urn`` ascending, which makes it total. That
is what lets a page end at a row's keys and the next page start strictly
after them (keyset pagination) with nothing repeated and nothing skipped.

The orders are the ones ``_rank_candidate_rows`` applies to a capped
candidate set, moved into the query:

* ``relevance`` — the provenance score descending (``relevance.py``), then
  the display name, then the urn;
* ``displayName`` / ``qualifiedName`` — that text, lower-cased, in
  ``sortDir``, then the urn ascending (ties never flip);
* ``sortProperty`` — numbers (and booleans, as 0/1) before text, each in
  ``sortDir``; a missing value sorts as empty text;
* ``depth`` / ``matchCount`` — the urn alone, as before.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cmp_to_key
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_typed_ops import text_of
from backend.common.models.search import SearchQuery


@dataclass(frozen=True)
class SortKey:
    """One key: a Cypher expression over ``n`` and its direction."""
    expr: str
    descending: bool = False


@dataclass(frozen=True)
class SortSpec:
    """The keys, in order; the last is always the urn, ascending."""
    keys: Tuple[SortKey, ...]
    params: Dict[str, Any] = field(default_factory=dict)

    @property
    def aliases(self) -> List[str]:
        return [f"_k{i}" for i in range(len(self.keys))]

    def projection(self) -> str:
        """``<expr> AS _k0, …`` for the ``WITH`` that precedes ``ORDER BY``."""
        return ", ".join(f"{k.expr} AS {a}" for k, a in zip(self.keys, self.aliases))

    def order_by(self) -> str:
        return ", ".join(
            f"{a} DESC" if k.descending else a
            for k, a in zip(self.keys, self.aliases)
        )

    def after(self, row: Sequence[Any], prefix: str = "_a") -> Tuple[str, Dict[str, Any]]:
        """The condition "strictly after ``row``" over the projected aliases,
        and its parameters.

        ``k0 > a0 OR (k0 = a0 AND (k1 > a1 OR …))``, with ``<`` for a
        descending key. A later key is only compared where every earlier one
        is equal — so a number is only compared with a number of the same
        sign, the one comparison FalkorDB gets right.
        """
        aliases = self.aliases
        params = {f"{prefix}{i}": row[i] for i in range(len(aliases))}
        last = len(aliases) - 1
        cond = f"{aliases[last]} {self._op(last)} ${prefix}{last}"
        for i in range(last - 1, -1, -1):
            cond = (f"({aliases[i]} {self._op(i)} ${prefix}{i} OR "
                    f"({aliases[i]} = ${prefix}{i} AND {cond}))")
        return cond, params

    def _op(self, i: int) -> str:
        return "<" if self.keys[i].descending else ">"

    def sort_key(self) -> Callable[[Sequence[Any]], Any]:
        """A Python ``key=`` that orders projected rows as Cypher did."""
        directions = [k.descending for k in self.keys]

        def compare(a: Sequence[Any], b: Sequence[Any]) -> int:
            for x, y, descending in zip(a, b, directions):
                if x == y:
                    continue
                less = _less(x, y)
                return (1 if less else -1) if descending else (-1 if less else 1)
            return 0

        return cmp_to_key(compare)

    def merge(self, *row_lists: Sequence[Sequence[Any]], limit: int) -> List[List[Any]]:
        """The first ``limit`` rows of several ordered lists, in order."""
        rows = [list(r) for rows in row_lists for r in rows]
        rows.sort(key=self.sort_key())
        return rows[:limit]


def _less(x: Any, y: Any) -> bool:
    """``x < y`` for two values of one key. Each key holds one kind by
    construction; a mismatch (a node whose urn is not text) orders by kind
    name rather than raising in the middle of a merge."""
    try:
        return x < y
    except TypeError:
        return type(x).__name__ < type(y).__name__


_URN = SortKey("n.urn")


def name_text(name_key: Optional[str]) -> str:
    """The display name the ranking reads, lower-cased — the same fallbacks
    ``_rows_to_candidates`` applies (displayName, the source's name
    property, name, title, label)."""
    from backend.app.providers.falkordb_search.relevance import display_name_expr
    return f"toLower(coalesce({display_name_expr(name_key)}, ''))"


def build_sort_spec(
    query: SearchQuery,
    *,
    name_key: Optional[str] = None,
    relevance: Optional[Tuple[str, Dict[str, Any]]] = None,
) -> SortSpec:
    """The keys for ``query``'s requested order.

    ``relevance`` is ``relevance.score_expr``'s expression and parameters
    (None when the query has nothing textual to score, in which case every
    match scores alike and the name decides, as before).
    """
    from backend.app.providers.falkordb_deep_search import _safe_property_name
    options = query.options
    descending = options.sort_dir == "desc"
    if options.sort_property:
        col = f"n.{_safe_property_name(options.sort_property)}"
        numeric = (f"typeOf({col}) IN ['Integer', 'Float', 'Boolean'] "
                   f"AND {col} = {col}")
        keys = (
            # Numbers (and booleans) first, text after — the kind rank.
            SortKey(f"CASE WHEN {numeric} THEN 0 ELSE 1 END", descending),
            # The sign, so the value below only meets values of its own sign.
            SortKey(f"CASE WHEN typeOf({col}) IN ['Integer', 'Float'] "
                    f"AND {col} < 0 THEN 0 ELSE 1 END", descending),
            SortKey(f"CASE WHEN typeOf({col}) IN ['Integer', 'Float'] AND {col} = {col} "
                    f"THEN {col} WHEN {col} = true THEN 1 ELSE 0 END", descending),
            SortKey(f"CASE WHEN {numeric} THEN '' "
                    f"ELSE coalesce(toLower({text_of(col)}), '') END", descending),
            _URN,
        )
        return SortSpec(keys)
    if options.sort in ("displayName", "qualifiedName"):
        text = (name_text(name_key) if options.sort == "displayName"
                else "toLower(coalesce(toStringOrNull(n.qualifiedName), ''))")
        return SortSpec((SortKey(text, descending), _URN))
    if options.sort == "relevance":
        keys: Tuple[SortKey, ...] = (SortKey(name_text(name_key)), _URN)
        if relevance is None:
            return SortSpec(keys)
        expr, params = relevance
        return SortSpec((SortKey(expr, descending=True),) + keys, dict(params))
    return SortSpec((_URN,))
