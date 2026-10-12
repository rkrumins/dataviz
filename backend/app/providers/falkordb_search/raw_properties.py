"""Property values kept in ``propertiesRaw``, searched exactly.

A node stores a user property natively — where Cypher can compare it — when
its value is a scalar or a flat list of scalars and its name fits the graph's
native budget (``falkordb_provider._admit_native_keys``). Anything else — a
nested object, a list of objects, a name past the budget — is kept as JSON
text in ``n.propertiesRaw``, which Cypher can't parse, and a search on such a
key used to match nothing there.

Now each property condition carries its answer for those nodes in two
parameter lists, filled per unit of a scan: ``$_rN``, the nodes keeping the
key raw, and ``$_tN``, those whose raw value satisfies the condition — by
``search_semantics.evaluate``, the reference evaluator of the same semantics
the Cypher compiles. A probe reads the raw text of the unit's nodes whose
JSON mentions one of the keys. A value condition becomes

    (ID(n) IN $_rN AND ID(n) IN $_tN) OR (NOT ID(n) IN $_rN AND <native>)

— exact inside any AND, OR or NOT: a node keeps a key in one place or the
other. A key's mere presence (``hasProperty``) is ``<native> OR ID(n) IN
$_tN``. A nested value compares as its JSON text.

A graph with no raw properties at all — the usual case — skips all of it,
and a unit whose label holds none is not probed: which labels hold any is one
statement per graph and data version.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Sequence, Tuple

from backend.common.search_semantics import Comparison, evaluate, fold_case


@dataclass(frozen=True)
class RawLeaf:
    """One property condition of a compiled predicate, as it applies to the
    raw JSON: a value comparison (``cmp``), or the presence of a key whose
    name equals, starts with or contains ``key`` (``cmp`` None)."""
    key: str
    cmp: Optional[Comparison]
    key_match: str          # 'exact' | 'prefix' | 'contains'
    raw_ids: str            # parameter: the nodes keeping the key raw
    true_ids: str           # parameter: those the condition holds for
    native: str = ""        # the condition on native values alone

    @property
    def wrapped(self) -> str:
        """The condition, exact for nodes keeping the key either way."""
        if self.cmp is None:
            return f"({self.native} OR ID(n) IN ${self.true_ids})"
        return (f"((ID(n) IN ${self.raw_ids} AND ID(n) IN ${self.true_ids}) "
                f"OR (NOT ID(n) IN ${self.raw_ids} AND {self.native}))")

    def unneeded(self, lists: Dict[str, List[int]]) -> bool:
        """Whether the native condition alone is exact where ``lists`` were
        read: no node there keeps the key raw (for presence, has it raw)."""
        return not lists[self.true_ids if self.cmp is None else self.raw_ids]


def answered(where: str, leaves: Sequence[RawLeaf], lists: Dict[str, List[int]]) -> str:
    """``where`` for the nodes ``lists`` were read for: each condition whose
    key none of them keeps raw back to its native form — the raw check costs
    only where there is something raw to check."""
    for leaf in leaves:
        if leaf.unneeded(lists):
            where = where.replace(leaf.wrapped, leaf.native, 1)
    return where


def empty_params(leaves: Sequence[RawLeaf]) -> Dict[str, List[int]]:
    """Every leaf's lists, empty: the compiled predicate as if no node kept
    anything raw."""
    out: Dict[str, List[int]] = {}
    for leaf in leaves:
        out[leaf.raw_ids] = []
        out[leaf.true_ids] = []
    return out


# ---------------------------------------------------------------------------
# The probe: which nodes' raw JSON might hold one of the keys
# ---------------------------------------------------------------------------

def probe_condition(leaves: Sequence[RawLeaf]) -> Tuple[str, Dict[str, Any]]:
    """A WHERE condition on ``n`` true for (at least) every node whose raw
    JSON holds a key one of ``leaves`` reads. Case-sensitive for a key named
    exactly — ``"key":`` as ``json.dumps`` writes it, escapes included —
    folded for a key matched by name."""
    exact: List[str] = []
    folded: List[str] = []
    any_raw = False
    for leaf in leaves:
        if leaf.key_match == "exact":
            exact.append(json.dumps(leaf.key) + ":")
            if not leaf.key.isascii():
                exact.append(json.dumps(leaf.key, ensure_ascii=False) + ":")
        elif leaf.key.isascii():
            needle = fold_case(leaf.key)
            folded.append('"' + needle if leaf.key_match == "prefix" else needle)
        else:
            # A folded non-ASCII name can't be found in escaped JSON: read
            # every node keeping anything raw.
            any_raw = True
    if any_raw:
        return "n.propertiesRaw IS NOT NULL AND n.propertiesRaw <> '{}'", {}
    params: Dict[str, Any] = {}
    terms: List[str] = []
    for i, fragment in enumerate(dict.fromkeys(exact)):
        params[f"_rawf{i}"] = fragment
        terms.append(f"n.propertiesRaw CONTAINS $_rawf{i}")
    for i, fragment in enumerate(dict.fromkeys(folded)):
        params[f"_rawl{i}"] = fragment
        terms.append(f"toLower(n.propertiesRaw) CONTAINS $_rawl{i}")
    return "(" + " OR ".join(terms) + ")", params


# ---------------------------------------------------------------------------
# Evaluation, in Python, of what the probe read
# ---------------------------------------------------------------------------

def evaluate_rows(rows: Iterable[Sequence[Any]], leaves: Sequence[RawLeaf]
                  ) -> Dict[str, List[int]]:
    """Each leaf's lists for probed ``(node id, raw text)`` rows."""
    out = empty_params(leaves)
    for row in rows:
        node_id, text = row[0], row[1]
        raw = _parse(text)
        if not raw:
            continue
        for leaf in leaves:
            if leaf.cmp is None:
                if _has_key(raw, leaf):
                    out[leaf.true_ids].append(node_id)
            elif leaf.key in raw:
                out[leaf.raw_ids].append(node_id)
                if evaluate(_comparable(raw[leaf.key]), leaf.cmp):
                    out[leaf.true_ids].append(node_id)
    return out


def _parse(text: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(text, str) or not text or text == "{}":
        return None
    try:
        raw = json.loads(text)
    except ValueError:
        return None
    return raw if isinstance(raw, dict) else None


def _has_key(raw: Dict[str, Any], leaf: RawLeaf) -> bool:
    if leaf.key_match == "exact":
        return leaf.key in raw
    needle = fold_case(leaf.key)
    if leaf.key_match == "prefix":
        return any(fold_case(k).startswith(needle) for k in raw)
    return any(needle in fold_case(k) for k in raw)


def _comparable(value: Any) -> Any:
    """A raw value as a comparison reads it: a scalar or a flat list of
    scalars as it is (a name past the native budget keeps such values), a
    nested one as its JSON text."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, list) and all(isinstance(x, (str, int, float, bool)) for x in value):
        return value
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Which labels keep anything raw — once per graph and data version
# ---------------------------------------------------------------------------

_RAW_LABELS: Dict[Tuple[str, str], FrozenSet[str]] = {}
_RAW_LABELS_MAX = 512


async def graph_raw_labels(provider, run, data_version: str) -> FrozenSet[str]:
    """The labels of the provider's graph whose nodes keep any property raw,
    as of ``data_version`` — none, usually; read again for every call
    without one. ``run(cypher, params)`` executes one statement."""
    key = (str(getattr(provider, "_graph_name", "") or ""), str(data_version or ""))
    known = _RAW_LABELS.get(key) if data_version else None
    if known is not None:
        return known
    res = await run("MATCH (n) WHERE n.propertiesRaw IS NOT NULL AND n.propertiesRaw <> '{}' "
                    "UNWIND labels(n) AS _l RETURN DISTINCT _l", {})
    found = frozenset(str(row[0]) for row in res.result_set or [] if row and row[0])
    if data_version:
        if len(_RAW_LABELS) >= _RAW_LABELS_MAX:
            _RAW_LABELS.pop(next(iter(_RAW_LABELS)))
        _RAW_LABELS[key] = found
    return found
