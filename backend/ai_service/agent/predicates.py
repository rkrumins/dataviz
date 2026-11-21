"""Search predicates the model writes: expanded, validated, and built.

The model writes ``SearchQuery`` predicates — the same JSON the Advanced
Search panel builds — never free-form Cypher it runs itself. Before anything
is sent to the platform, a predicate is:

1. **expanded** — two pseudo-kinds only the assistant understands are
   replaced by real predicates:

   * ``{"kind": "resultSet", "ref": "r1"}`` — an earlier answer's result set
     ("those"), as the predicate that produced it, so follow-ups compose
     without ever listing millions of URNs;
   * ``{"kind": "concept", "name": "PII"}`` — a business word, read through
     the confirmed concept mapping (``concepts``). An unresolved concept
     stops the search and asks the person instead.

2. **validated** — by the platform's own model
   (``backend.common.models.search.Predicate``), plus a check pydantic does
   not make: a field the model does not know is an error, not silently
   dropped, because a dropped ``maxHops`` or ``negate`` changes the answer.

3. **canonicalised** — dumped back by alias, so what runs is exactly what
   the person can open in Advanced Search.
"""
from __future__ import annotations

import typing
from typing import Any, Callable, Mapping, Optional

from pydantic import BaseModel, TypeAdapter, ValidationError

from backend.common.models import search as search_models
from backend.common.models.search import Predicate

_ADAPTER = TypeAdapter(Predicate)


class PredicateInvalid(ValueError):
    """The predicate cannot run; the message is written for the model to fix it."""


class ConceptNeeded(Exception):
    """A ``concept`` pseudo-predicate has no confirmed reading yet."""

    def __init__(self, name: str, applies_to: Optional[str] = None) -> None:
        super().__init__(name)
        self.name = name
        self.applies_to = applies_to


def _kind_models() -> dict[str, type[BaseModel]]:
    union = typing.get_args(Predicate)[0]
    out: dict[str, type[BaseModel]] = {}
    for model in typing.get_args(union):
        kind_field = model.model_fields.get("kind")
        if kind_field is not None and kind_field.default:
            out[str(kind_field.default)] = model
    return out


_MODELS = _kind_models()
#: Nested predicate-valued fields, by their wire names.
_NESTED_ONE = ("where", "sourceWhere", "targetWhere")
_NESTED_MANY = ("children",)


def _wire_names(model: type[BaseModel]) -> set[str]:
    names: set[str] = set()
    for name, info in model.model_fields.items():
        names.add(info.alias or name)
        names.add(name)
    return names


def _check_fields(node: Any, path: str) -> None:
    if not isinstance(node, Mapping):
        raise PredicateInvalid(f"{path or 'predicate'} must be an object with a 'kind'.")
    kind = node.get("kind")
    model = _MODELS.get(str(kind))
    if model is None:
        raise PredicateInvalid(
            f"{path or 'predicate'}: unknown kind {kind!r}. Use one of {sorted(_MODELS)} "
            "(or resultSet / concept).",
        )
    unknown = set(node) - _wire_names(model)
    if unknown:
        raise PredicateInvalid(
            f"{path or 'predicate'} ({kind}) has fields it does not take: {sorted(unknown)}. "
            f"It takes {sorted(n for n in _wire_names(model) if n[0].islower() and '_' not in n)}.",
        )
    for key in _NESTED_ONE:
        if isinstance(node.get(key), Mapping):
            _check_fields(node[key], f"{path}.{key}" if path else key)
    for key in _NESTED_MANY:
        for i, child in enumerate(node.get(key) or []):
            _check_fields(child, f"{path}.{key}[{i}]" if path else f"{key}[{i}]")


def expand(
    node: Any,
    *,
    result_set: Callable[[str], Optional[dict]],
    concept: Callable[[str, Optional[str]], Optional[dict]],
    _depth: int = 0,
) -> Any:
    """*node* with every ``resultSet`` and ``concept`` replaced."""
    if _depth > 12:
        raise PredicateInvalid("The predicate nests too deeply.")
    if isinstance(node, list):
        return [expand(n, result_set=result_set, concept=concept, _depth=_depth + 1) for n in node]
    if not isinstance(node, Mapping):
        return node
    kind = node.get("kind")
    if kind == "resultSet":
        ref = str(node.get("ref") or "").lstrip("@")
        found = result_set(ref)
        if found is None:
            raise PredicateInvalid(f"There is no earlier result {ref!r} in this conversation.")
        return expand(found, result_set=result_set, concept=concept, _depth=_depth + 1)
    if kind == "concept":
        name = str(node.get("name") or "").strip()
        if not name:
            raise PredicateInvalid("A concept needs a name.")
        found = concept(name, node.get("appliesTo"))
        if found is None:
            raise ConceptNeeded(name, node.get("appliesTo"))
        return expand(found, result_set=result_set, concept=concept, _depth=_depth + 1)
    out = {}
    for key, value in node.items():
        if key in _NESTED_ONE + _NESTED_MANY:
            out[key] = expand(value, result_set=result_set, concept=concept, _depth=_depth + 1)
        else:
            out[key] = value
    return out


def _friendly(exc: ValidationError) -> str:
    parts = []
    for error in exc.errors()[:4]:
        loc = ".".join(str(p) for p in error.get("loc", ()))
        parts.append(f"{loc}: {error.get('msg')}")
    return "; ".join(parts)


def validate(node: Any) -> dict:
    """The canonical form of an expanded predicate, or :class:`PredicateInvalid`."""
    _check_fields(node, "")
    try:
        model = _ADAPTER.validate_python(node)
    except ValidationError as exc:
        raise PredicateInvalid(f"The predicate is not valid: {_friendly(exc)}") from exc
    return _ADAPTER.dump_python(model, by_alias=True, exclude_none=True, mode="json")


# ── Builders ────────────────────────────────────────────────────────────


def is_urns(urns: list[str]) -> dict:
    return {"kind": "is", "refs": [{"urn": u} for u in urns[:64]]}


def all_of(*children: Optional[dict]) -> dict:
    parts = [c for c in children if c]
    if len(parts) == 1:
        return parts[0]
    return {"kind": "group", "op": "and", "children": parts}


def any_of(*children: Optional[dict]) -> dict:
    parts = [c for c in children if c]
    if len(parts) == 1:
        return parts[0]
    return {"kind": "group", "op": "or", "children": parts}


def of_types(types: list[str]) -> dict:
    return {"kind": "entityType", "op": "in", "values": list(types)[:32]}


def downstream_of(urns: list[str], *, max_hops: int = 10) -> dict:
    """Entities *urns* feed: whose upstream holds one of them."""
    return {"kind": "related", "axis": "upstream", "where": is_urns(urns),
            "maxHops": max(1, min(search_models.RELATION_ANCHORED_HOPS_MAX, max_hops))}


def upstream_of(urns: list[str], *, max_hops: int = 10) -> dict:
    """Entities that feed *urns*."""
    return {"kind": "related", "axis": "downstream", "where": is_urns(urns),
            "maxHops": max(1, min(search_models.RELATION_ANCHORED_HOPS_MAX, max_hops))}


def kinds() -> list[str]:
    return sorted(_MODELS)
