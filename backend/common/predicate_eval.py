"""A search predicate answered for one entity, in Python — the meaning the FalkorDB compiler
gives it, written over a node dict.

Two callers answer predicates without FalkorDB: the in-memory stub provider
(``graph.adapters.stub_deep_search``), over its fixture graph, and a draft's deep search
(``app.providers.draft_search``), over the values a draft holds for the entities it changed —
the published graph answers the rest. They share this one evaluator, so a draft's count is
main's count corrected by exactly the answers main would give, and the stub's results are the
engine's.

A node dict holds what a FalkorDB node holds: ``urn``, ``entityType`` (its label),
``displayName``, ``qualifiedName``, ``description``, ``tags`` (a list), ``layerAssignment``,
``searchableText`` and every user property under its own key (``NODE_FIELDS`` are the node's
own). ``graph`` answers what needs more than the node — its ancestors (``_ancestors``), its
relationships, its degree, its placement in a view. An edge's filter (``edge_matches``) reads an edge
dict the same way: its own fields under their keys, a user's properties in its ``properties``.
"""
from __future__ import annotations

import json
from typing import Any, Dict

from backend.app.services.deep_search import CompileError
from backend.common.edge_properties import EDGE_NATIVE_KEYS, json_holds
from backend.common.models.search import (
    DegreePredicate,
    DescendantOfPredicate,
    EdgeGroupPredicate,
    EdgeHasPropertyPredicate,
    EdgePropertyPredicate,
    EntityTypePredicate,
    GroupPredicate,
    HasIncomingPredicate,
    HasOutgoingPredicate,
    HasPropertyPredicate,
    IsLeafPredicate,
    IsOrphanPredicate,
    IsPredicate,
    IsRootPredicate,
    LayerPredicate,
    MatchAllPredicate,
    PropertyPredicate,
    RelatedPredicate,
    TagPredicate,
    TextPredicate,
)
from backend.common.search_semantics import (
    SemanticsError,
    evaluate,
    evaluate_keys,
    fold_case,
    resolve_comparison,
    resolve_predicate,
)

# The node dict's own fields, not user properties — what a search BY property name must not
# match (the FalkorDB compiler excludes ``platform_property_names()`` for the same reason).
NODE_FIELDS = frozenset({
    "urn", "entityType", "displayName", "qualifiedName", "description",
    "tags", "layerAssignment", "searchableText",
})

#: The degree shorthands, as the degree test each stands for.
SUGAR = {
    IsOrphanPredicate: ("both", "eq", 0), IsLeafPredicate: ("out", "eq", 0),
    IsRootPredicate: ("in", "eq", 0), HasIncomingPredicate: ("in", "gt", 0),
    HasOutgoingPredicate: ("out", "gt", 0),
}


def matches(node: Dict[str, Any], predicate, graph=None, depth: int = 12) -> bool:
    """Walk the predicate tree against an in-memory node dict.

    ``graph`` answers what needs more than the node: its relationships and degree.
    Unsupported kinds raise ``CompileError`` with a clear message — honest about what it can
    do rather than silently returning wrong results. ``depth``: how far below its containers a
    ``descendantOf`` naming no ``maxDepth`` reaches (the scope's).
    """
    if isinstance(predicate, GroupPredicate):
        if predicate.op == "and":
            return all(matches(node, c, graph, depth) for c in predicate.children)
        if predicate.op == "or":
            return any(matches(node, c, graph, depth) for c in predicate.children)
        if predicate.op == "not":
            # Validator enforces exactly one child.
            return not matches(node, predicate.children[0], graph, depth)
        raise CompileError(f"stub: unsupported group op {predicate.op!r}")

    if isinstance(predicate, DescendantOfPredicate) and graph is not None:
        urns = set(predicate.urns)
        for ref in predicate.refs or ():
            if ref.urn is None:
                raise CompileError(
                    f"descendantOf: the name reference '{ref.label()}' was not resolved")
            urns.add(ref.urn)
        reach = int(predicate.max_depth or depth)
        return node.get("urn") in urns or any(
            a in urns for a in graph._ancestors(node)[:reach])

    if isinstance(predicate, RelatedPredicate) and graph is not None:
        return graph._relation_holds(node, predicate)

    if isinstance(predicate, DegreePredicate) and graph is not None:
        return graph._degree(node["urn"], predicate)

    if type(predicate) in SUGAR and graph is not None:
        direction, op, value = SUGAR[type(predicate)]
        return graph._degree(node["urn"], DegreePredicate(
            direction=direction, op=op, value=value, edgeClass=predicate.edge_class,
            edgeTypes=predicate.edge_types))

    if isinstance(predicate, MatchAllPredicate):
        return True

    if isinstance(predicate, IsPredicate):
        urns = set()
        for ref in predicate.refs:
            if ref.urn is None:
                raise CompileError(f"is: the name reference '{ref.label()}' was not resolved")
            urns.add(ref.urn)
        return node.get("urn") in urns

    if isinstance(predicate, EntityTypePredicate):
        # ``toLower(labels(n)[0]) IN $values``, the values lowered too.
        et = str(node.get("entityType") or "").lower()
        wanted = {str(v).lower() for v in predicate.values}
        if predicate.op == "in":
            return et in wanted
        if predicate.op == "notIn":
            return et not in wanted
        raise CompileError(f"stub: unsupported entityType op {predicate.op!r}")

    if isinstance(predicate, LayerPredicate):
        target = getattr(predicate, "_placement", None)
        if target is not None and graph is not None:
            placement = graph._placement_of(node["urn"], target)
            if placement is None:
                return False
            if target.layer_id is None:     # in any of the view's layers, as a member
                return placement.member
            return placement.layer_id == target.layer_id
        return node.get("layerAssignment") == predicate.layer_assignment

    if isinstance(predicate, TextPredicate):
        return _text_holds(node, predicate)

    if isinstance(predicate, PropertyPredicate):
        # The reference evaluator IS the compiled Cypher's meaning (the
        # live parity test holds them together), so this answers a
        # typed comparison exactly as FalkorDB would.
        try:
            cmp = resolve_predicate(predicate)
        except SemanticsError as exc:
            raise CompileError(f"property {predicate.key!r}: {exc}") from exc
        if predicate.value_key:
            return evaluate_keys(node.get(predicate.key), node.get(predicate.value_key), cmp)
        return evaluate(node.get(predicate.key), cmp)

    if isinstance(predicate, HasPropertyPredicate):
        if predicate.key_match == "exact":
            present = node.get(predicate.key) is not None
        else:
            needle = fold_case(predicate.key)
            present = any(
                (fold_case(k).startswith(needle) if predicate.key_match == "prefix"
                 else needle in fold_case(k))
                for k, v in node.items()
                if k not in NODE_FIELDS and v is not None
            )
        return not present if predicate.negate else present

    if isinstance(predicate, TagPredicate):
        # ``n.tags CONTAINS '"tag"'`` per value, composed by the op.
        tags = set(node.get("tags") or [])
        wanted = set(predicate.values)
        if predicate.op in ("has", "hasAny"):
            return bool(wanted & tags)
        if predicate.op == "hasAll":
            return wanted <= tags
        if predicate.op == "notHas":
            return not (wanted & tags)
        raise CompileError(f"stub: unsupported tag op {predicate.op!r}")

    raise CompileError(
        f"stub: predicate kind {type(predicate).__name__} not implemented. "
        f"Extend backend/common/predicate_eval.py as tests need it."
    )


def _text_holds(node: Dict[str, Any], predicate: TextPredicate) -> bool:
    """The FalkorDB compiler's column mapping (``_visit_text`` in ``falkordb_deep_search.py``):

      name           → displayName + qualifiedName
      qualifiedName  → qualifiedName
      description    → description
      tags           → the tag list, as the JSON text the node stores it as
      any            → searchableText + displayName + qualifiedName

    Each column is compared SEPARATELY (a match on displayName OR on qualifiedName) — never a
    joined haystack — so exact/prefix/suffix hold per field: ``toLower(toString(col)) <op> $v``,
    the value lowered by Python as the compiler binds it, unless case-sensitive."""
    target = predicate.target or "any"
    if target == "property" and predicate.property_key:
        # Same typed text comparison the compiler makes for it.
        op = {"exact": "eq", "prefix": "startsWith",
              "suffix": "endsWith"}.get(predicate.match, "contains")
        return evaluate(
            node.get(predicate.property_key),
            resolve_comparison(op, predicate.value, value_type="string",
                               case_sensitive=predicate.case_sensitive),
        )
    sensitive = predicate.case_sensitive
    needle = predicate.value or ""
    if not sensitive:
        needle = needle.lower()
    if not needle:
        return True
    if target == "name":
        cols = ("displayName", "qualifiedName")
    elif target == "qualifiedName":
        cols = ("qualifiedName",)
    elif target == "description":
        cols = ("description",)
    elif target == "tags":
        cols = ("tags",)
    elif target == "any":
        cols = ("searchableText", "displayName", "qualifiedName")
    else:
        cols = (target,)

    for key in cols:
        value = node.get(key)
        if value is None:
            continue                    # null compares to nothing
        if isinstance(value, list):
            value = json.dumps(value)   # how a node stores its tags
        text = str(value) if sensitive else fold_case(str(value))
        if predicate.match == "exact":
            matched = text == needle
        elif predicate.match == "prefix":
            matched = text.startswith(needle)
        elif predicate.match == "suffix":
            matched = text.endswith(needle)
        else:  # substring (default)
            matched = needle in text
        if matched:
            return True
    return False


def edge_matches(edge: Dict[str, Any], predicate) -> bool:
    """An edge filter (a Connections search's ``edgePredicate``) on an edge dict — its own fields
    (``EDGE_NATIVE_KEYS``) under their keys, a user's properties in its ``properties`` — as the
    FalkorDB compiler reads it (``edge_properties``): an own field by every operator, a property
    kept in the edge's JSON by presence and equality (``json_holds``). ``None``: no filter."""
    if predicate is None:
        return True
    if isinstance(predicate, EdgeGroupPredicate):
        if predicate.op == "not":
            return not edge_matches(edge, predicate.children[0])
        tests = (edge_matches(edge, c) for c in predicate.children)
        return all(tests) if predicate.op == "and" else any(tests)
    if isinstance(predicate, EdgeHasPropertyPredicate):
        present = (edge.get(predicate.key) is not None if predicate.key in EDGE_NATIVE_KEYS
                   else predicate.key in (edge.get("properties") or {}))
        return not present if predicate.negate else present
    if isinstance(predicate, EdgePropertyPredicate):
        try:
            cmp = resolve_predicate(predicate)
        except SemanticsError as exc:
            raise CompileError(f"edge property {predicate.key!r}: {exc}") from exc
        if predicate.key in EDGE_NATIVE_KEYS:
            return evaluate(edge.get(predicate.key), cmp)
        return json_holds(edge.get("properties"), predicate.key, cmp)
    raise CompileError(f"edge predicate kind {type(predicate).__name__} not implemented")
