"""A view's layers as its canvas places them, compiled to Cypher: what a search's layer filter
matches.

``view_placement.place`` is the reference, and this is the same contract answered inside a query
for every entity a search reads, a tier at a time — the first that places the entity decides::

    its own explicit entry
    > an explicit entry above it that cascades (``inheritsChildren``), with no explicit entry on
      the way down
    > [a curated view stops here]
    > its own stamp, else its first matching rule in the spec's order
    > a stamp or cascading rule above it, with nothing decided on the way down
    > the fallback layer, whose column the canvas draws it in

Each tier answers whether it puts the entity in the target layer — true, false, or null when it
decides nothing — and ``coalesce`` takes the first that answers. Where a layer is known when the
test is written (an explicit entry's, a rule's), the comparison is made here, so the query only
reads which applies.

A cascade is read from the routes up the containment tree, each with the URNs on it, nearest
first, and what its top entity decides: nothing, a layer it passes down, or a block. A route
qualifies when its top passes a layer down and no shorter decided route is the start of it —
nothing on the way down decided — and where an entity has several parents, ``place`` inherits
from the smallest URN offering a cascade, level by level: the qualifying route whose URNs sort
first, which list comparison picks. The one difference is a containment cycle, whose edges
``place_all`` ignores and the walk follows. Each ancestor's rules are read once, on the route it
tops.

FalkorDB parses an operand with no operator after it twice (``native_query.parse_cost``), so
every nested part here is followed by one that changes nothing — ``= true``, ``+ ''``, ``+ []``
— and the parse grows with the view's rules, not their nesting. FalkorDB also evaluates every
branch of a ``CASE``, and one type error aborts the whole query, so each piece is total:
``substring`` never starts past the end of the text, ``CONTAINS`` only sees text or null. The
walks are pattern comprehensions, so the test belongs in a projection: a tail stage, a
relationship's test of its relative, a path's end.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS
from backend.app.providers.falkordb_typed_ops import Bind, compile_comparison
from backend.app.services.deep_search import CompileError
from backend.app.services.native_query.parse_cost import MAX_PARSE_COST, operand, parse_cost
from backend.app.services.view_placement import CompiledRule, LayerTarget, PlacementSpec

#: How far up the containment tree an entity's ancestors are read: as deep as a search's scope
#: walks (``view_scope._HARD_MAX_DEPTH``).
ANCESTOR_DEPTH = 20

#: What one layer test may cost FalkorDB to parse (``parse_cost``): a quarter of what the
#: provider refuses, so a statement holding several still parses. Some thirty rules that
#: compare properties reach it; types, tags and URN patterns cost little.
MAX_TEST_COST = MAX_PARSE_COST // 4


def layer_test(target: LayerTarget, var: str, *, name: Callable[[], str], bind: Bind,
               containment: Sequence[str]) -> str:
    """Whether the entity ``var`` is in ``target.layer_id`` as the canvas places it: true or
    false, never null. ``name`` gives the comprehensions a suffix no other part of the statement
    uses; ``containment`` is every containment edge type as the graph spells it."""
    spec, goal = target.spec, target.layer_id
    curated = spec.scope == "curated"
    groups = _explicit_groups(spec)
    if curated and not groups:
        return "false"          # a curated view places only what is placed by hand
    k, bind, rel = name(), _once(bind), "|".join(containment)
    hand_placed = sorted(u for _, _, urns in groups for u in urns)
    tiers: List[str] = []
    if groups:
        tiers.append(_explicit(var, groups, goal, bind))
        inheriting = [g for g in groups if g[1]]
        if inheriting and rel:
            def handed(a: str) -> str:
                # Every route here is topped by an entity placed by hand.
                whens = [f"WHEN {a}.urn IN {bind(urns)} THEN {code}" for code, urns in (
                    ("'y'", sorted(u for layer, _, us in inheriting if layer == goal for u in us)),
                    ("'n'", sorted(u for layer, _, us in inheriting if layer != goal for u in us)),
                ) if urns]
                return f"CASE {' '.join(whens)} ELSE 'x' END"
            tiers.append(_cascade(var, f"_xh{k}", rel, decides=handed,
                                  tops=lambda a: f"{a}.urn IN {bind(hand_placed)}"))
    if not curated:
        layers = bind(sorted(spec.layer_ids))
        tiers.append(f"CASE WHEN {var}.layerAssignment IN {layers} "
                     f"THEN {var}.layerAssignment = {bind(goal)} END")
        if spec.rules:
            whens = _rule_whens(var, spec.rules, lambda r: str(r.layer_id == goal).lower(), bind,
                                f"{k}o")
            tiers.append(f"CASE {' '.join(whens)} END")
        if rel:
            def soft(a: str) -> str:
                whens = ([f"WHEN {a}.urn IN {bind(hand_placed)} THEN 'x'"] if hand_placed else [])
                whens += [f"WHEN {a}.layerAssignment = {bind(goal)} THEN 'y'",
                          f"WHEN {a}.layerAssignment IN {layers} THEN 'n'"]
                whens += _rule_whens(a, spec.rules, lambda r: (
                    ("'y'" if r.layer_id == goal else "'n'") if r.cascades_soft else "'x'"),
                    bind, f"{k}c")
                return f"CASE {' '.join(whens)} END"
            tiers.append(_cascade(var, f"_xs{k}", rel, decides=soft))
        if spec.fallback_layer_id:
            tiers.append(str(spec.fallback_layer_id == goal).lower())
    test = f"coalesce({', '.join(operand(t) for t in tiers)}, false)"
    if parse_cost(f"RETURN {operand(test)}") > MAX_TEST_COST:      # as callers write it
        comparing = sum(1 for r in spec.rules if r.comparisons)
        raise CompileError(
            f"This view places entities with {len(spec.rules):,} rules"
            + (f", {comparing:,} of them comparing properties," if comparing else "")
            + " too many for a layer filter to follow quickly. Filter by type, tag or container "
            "instead.")
    return test


def _cascade(var: str, v: str, rel: str, *, decides: Callable[[str], str],
             tops: Optional[Callable[[str], str]] = None) -> str:
    """Whether the layer a cascade brings down to ``var`` is the target: null when none does.
    ``decides`` answers for the top of a route: null for nothing, ``'y'`` or ``'n'`` for a layer
    it passes down (the target or another), ``'x'`` for a decision that passes nothing down;
    ``tops``, when given, which entities can top a route at all."""
    q, a, x, r, c, e, o, b = (f"{v}{s}" for s in "qaxrceob")
    where = f"ID({a}) <> ID({var})" + (f" AND {tops(a)}" if tops else "")
    routes = (f"[{q} = ({a})-[:{rel}*1..{ANCESTOR_DEPTH}]->({var}) WHERE {where} "
              f"| [[{x} IN reverse(nodes({q}))[1..] | {x}.urn], {decides(a)} + ''] + []]")
    decided = f"[{c} IN {routes} WHERE {c}[1] IS NOT NULL]"
    qualifying = (f"[{c} IN {r} WHERE {c}[1] <> 'x' AND NONE({o} IN {r} WHERE "
                  f"size({o}[0]) < size({c}[0]) AND {c}[0][..size({o}[0])] = {o}[0])]")
    first = (f"reduce({b} = null, {e} IN {qualifying} + [] | "
             f"CASE WHEN {b} IS NULL OR {e}[0] < {b}[0] THEN {e} ELSE {b} END)[1]")
    return f"[{r} IN [{decided} + []] + [] | {first} = 'y'][0]"


def _explicit(x: str, groups: List[Tuple[str, bool, List[str]]], goal: str, bind: Bind) -> str:
    """Whether ``x``'s explicit entry is the target layer; null for no entry."""
    here = sorted(u for layer, _, urns in groups if layer == goal for u in urns)
    elsewhere = sorted(u for layer, _, urns in groups if layer != goal for u in urns)
    whens = ([f"WHEN {x}.urn IN {bind(here)} THEN true"] if here else []) + (
        [f"WHEN {x}.urn IN {bind(elsewhere)} THEN false"] if elsewhere else [])
    return f"CASE {' '.join(whens)} END"


def _explicit_groups(spec: PlacementSpec) -> List[Tuple[str, bool, List[str]]]:
    """The hand-placed entities by layer and cascade, stale entries (a layer the view no longer
    has) left out as ``place`` leaves them."""
    by: dict = {}
    for urn, entry in spec.explicit.items():
        if entry.layer_id in spec.layer_ids:
            by.setdefault((entry.layer_id, entry.inherits_children), []).append(urn)
    return [(layer, inherits, sorted(urns)) for (layer, inherits), urns in sorted(by.items())]


def _once(bind: Bind) -> Bind:
    """``bind``, each value bound once however many times the test writes it."""
    bound: Dict[str, str] = {}

    def once(value: Any) -> str:
        key = json.dumps(value, sort_keys=True, default=repr)
        if key not in bound:
            bound[key] = bind(value)
        return bound[key]

    return once


def _rule_whens(x: str, rules: Sequence[CompiledRule], outcome: Callable[[CompiledRule], str],
                bind: Bind, k: str) -> List[str]:
    """``WHEN … THEN …`` for the rules in the spec's order, the first ``x`` matches deciding:
    adjacent rules with one outcome read as one test, their types as one list."""
    whens: List[str] = []
    run, tests, types = None, [], set()

    def close() -> None:
        if run is None:
            return
        parts = ([f"toLower({_entity_type(x)}) IN {bind(sorted(types))}"] if types else []) + tests
        whens.append(f"WHEN {' OR '.join(operand(p) for p in parts)} THEN {run}")

    for i, rule in enumerate(rules):
        if outcome(rule) != run:
            close()
            run, tests, types = outcome(rule), [], set()
        if _types_only(rule):
            types.update(rule.types)
        else:
            tests.append(_rule_test(x, rule, bind, f"{k}{i}"))
    close()
    return whens


def _types_only(rule: CompiledRule) -> bool:
    return (rule.types is not None and rule.tags is None and rule.urn_pattern is None
            and not rule.comparisons)


def _rule_test(x: str, rule: CompiledRule, bind: Bind, k: str) -> str:
    """``CompiledRule.matches`` for the entity ``x``: the AND of its criteria."""
    tests = []
    if rule.types is not None:
        tests.append(f"toLower({_entity_type(x)}) IN {bind(sorted(rule.types))}")
    if rule.tags is not None:
        # Tags are a JSON list in text: a tag appears in it quoted, as the tag filter reads it.
        tags = f"toStringOrNull({x}.tags)"
        tests.append("(" + " OR ".join(f"{tags} CONTAINS {bind(json.dumps(t))}"
                                       for t in sorted(rule.tags)) + ")")
    if rule.urn_pattern is not None:
        tests.append(glob_test(f"toStringOrNull({x}.urn)", rule.urn_pattern, bind, k))
    for field, cmp in rule.comparisons:
        tests.append(compile_comparison(_value(x, field), cmp, bind))
    return "(" + " AND ".join(tests) + ")"


def _entity_type(x: str) -> str:
    """The type the canvas reads: the node's label, else its ``entityType``."""
    return f"coalesce(labels({x})[0], toStringOrNull({x}.entityType), 'unknown')"


def _value(x: str, field: str) -> str:
    """``view_placement._value``: a user property, with the entity's own name, type and URN
    standing in for a missing ``name``, ``type`` and ``urn``. A platform field is no user
    property, so a rule reads nothing there."""
    if field == "name":
        names = " ".join(f"WHEN {x}.{f} <> '' THEN {x}.{f}" for f in ("displayName", "title", "label"))
        return f"coalesce({x}.name, CASE {names} END)"
    if field == "type":
        return f"coalesce({x}.type, {_entity_type(x)})"
    if field == "urn":
        return f"{x}.urn"
    if field in _RESERVED_NODE_KEYS:
        return "null"
    return f"{x}.`{field.replace('`', '``')}`"


# ---------------------------------------------------------------------------
# URN globs, without regex (FalkorDB has none)
# ---------------------------------------------------------------------------

def glob_test(s: str, pattern: str, bind: Bind, k: str) -> str:
    """Whether the text ``s`` (or null) matches the glob in full, as ``view_placement._glob``
    does: ``*`` any run, ``?`` one character, the rest literal. The pieces between stars sit in
    order, each at its leftmost place after the one before, which leaves the most room for the
    rest. They are found by position in ``s`` itself, never in a slice of it: FalkorDB can crash
    slicing a slice at its end (``falkordb_typed_ops.padded``)."""
    parts = pattern.split("*")
    if len(parts) == 1:
        if "?" not in pattern:
            return f"{s} = {bind(pattern)}"
        return f"(size({s}) = {len(pattern)} AND {_at(s, pattern, 0, bind)})"
    first, *middle, last = parts
    least = len(first) + len(last)
    tests = [f"size({s}) >= {least}"]
    if first:
        tests.append(f"{s} STARTS WITH {bind(first)}" if "?" not in first
                     else _at(s, first, 0, bind))
    if last:
        tests.append(f"{s} ENDS WITH {bind(last)}" if "?" not in last
                     else _at(s, last, _at_least_zero(f"size({s}) - {len(last)}"), bind))
    middle = [m for m in middle if m]
    if middle:
        end = f"coalesce(size({s}), 0) - {len(last)}"   # the middle ends where the suffix starts
        after = str(len(first))     # where the next piece may start; null once one is missing
        for i, part in enumerate(middle):
            g, j = f"_xg{k}_{i}", f"_xj{k}_{i}"
            places = (f"range(coalesce({g}, 0), "
                      f"CASE WHEN {g} IS NULL THEN -1 ELSE {end} - {len(part)} END)")
            found = f"head([{j} IN {places} WHERE {_at(s, part, j, bind, inside=True)}])"
            after = f"[{g} IN [{after}] | {found} + {len(part)}][0]"
        tests.append(f"{after} IS NOT NULL")
    return "(" + " AND ".join(tests) + ")"


def _at(s: str, part: str, offset: Any, bind: Bind, *, inside: bool = False) -> str:
    """Whether ``part`` (``?`` any one character) sits in ``s`` at ``offset`` (never negative).
    ``inside``: the offset is known to leave room for the whole part in ``s``."""
    runs, start = [], None
    for i, c in enumerate(part + "?"):
        if c != "?" and start is None:
            start = i
        elif c == "?" and start is not None:
            runs.append((start, part[start:i]))
            start = None
    if not runs:
        return "true"
    # Padded with spaces as long as the part, no slice starts past the end (``padded``); where the
    # text is too short for the part, the glob's size test fails whatever the slices say.
    text = s if inside else f"{s} + '{' ' * len(part)}'"
    return "(" + " AND ".join(
        f"substring({text}, {offset if i == 0 else f'{offset} + {i}'}, {len(r)}) = {bind(r)}"
        for i, r in runs) + ")"


def _at_least_zero(expr: str) -> str:
    return f"CASE WHEN {expr} > 0 THEN {expr} ELSE 0 END"
