"""Which of the entities on screen match which rules.

A display rule used to be evaluated by downloading every entity it matched
— up to 125,000 URNs, capped — and looking up the ones on the canvas. The
canvas only ever needs the answer for what it shows, so it now asks exactly
that: "of these (at most 1,000) URNs, which match rules A…K?".

One statement per label the URNs carry, through that label's urn index,
each rule a boolean column. A column is wrapped in ``ANY(… WHERE …)``:
FalkorDB short-circuits AND / OR there, never in a bare projection — 1,000
URNs × 10 rules cost 36 ms wrapped, 65 ms bare (S0_FINDINGS §8).

The view's scope is enforced here, on the server: an entity outside it
never matches, whatever it holds. Containment scope — the view's roots, and
a rule's own ``descendantOf`` — is checked against each entity's ancestors,
read in the same statement. ``withinHops`` and ``path`` say nothing about
one entity on its own, so a rule using them is refused (``errors``).
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Sequence, Set, Tuple

from backend.app.providers.falkordb_deep_search import (
    _build_compiler_for_provider,
    _sanitize_label,
    _searchable_labels,
)
from backend.app.providers.falkordb_search.plan import _labels_in_scope, _quote, _rel
from backend.app.services.deep_search import CompileError
from backend.common.models.search import SearchScope


async def evaluate_membership(
    provider, scope: SearchScope, items: Sequence[Tuple[str, Any]], urns: Sequence[str],
    *, run, timeout_s: float,
) -> Dict[str, Any]:
    """``{"matches": {item: [urn…]}, "errors": {item: why}, "elapsedMs"}``.

    ``scope`` is the RESOLVED scope (the service stamps it): its roots, its
    entity types, its visible URNs. ``run(cypher, params)`` executes one
    statement under the caller's admission."""
    started = time.monotonic()
    matches: Dict[str, List[str]] = {item_id: [] for item_id, _ in items}
    errors: Dict[str, str] = {}
    urns = list(dict.fromkeys(u for u in urns if u))
    columns, params, hoisted = _compile(provider, items, errors)
    if not urns or not columns:
        return _result(matches, errors, started)

    containment = _containment(provider)
    depth = int(scope.max_depth or 12)
    roots = set(scope.root_urns or []) if scope.scope_mode == "view" else set()
    visible = (set(scope.visible_urns or [])
               if scope.scope_mode == "visible" and scope.visible_urns else None)
    ancestors_needed = bool(containment) and (bool(roots) or any(hoisted.values()))
    labels = None
    allowed = None
    if visible is None and not (roots and containment):
        labels = await _searchable_labels(provider, timeout_s=timeout_s)
        allowed = {lbl.lower() for lbl in _labels_in_scope(provider, labels, scope.entity_types)}
    by_label = await _labels_by_urn(provider, run, labels, urns, timeout_s)

    anc = (f"[(n)<-[:{_rel(containment)}*0..{depth}]-(_ma) | _ma.urn]"
           if ancestors_needed else "[]")
    flags = ", ".join(f"ANY(_mz IN [0] WHERE {where}) AS m{i}"
                      for i, (_, where) in enumerate(columns))
    rows: Dict[str, Tuple[Set[str], Set[str], List[bool]]] = {}
    for label, label_urns in by_label.items():
        res = await run(
            f"MATCH (n:`{_sanitize_label(label)}`) WHERE n.urn IN $_urns "
            f"RETURN n.urn, labels(n), {anc}, {flags}",
            {**params, "_urns": label_urns},
        )
        for row in res.result_set or []:
            urn, node_labels, ancestors, values = row[0], row[1], row[2], row[3:]
            seen = rows.get(urn)
            if seen is None:
                rows[urn] = ({str(x).lower() for x in node_labels or []},
                             {a for a in ancestors or [] if a}, [bool(v) for v in values])
            else:           # a node read under two labels: the same answer
                seen[1].update(a for a in ancestors or [] if a)

    for urn in urns:
        found = rows.get(urn)
        if found is None:
            continue
        node_labels, ancestors, values = found
        if visible is not None and urn not in visible:
            continue
        if roots and containment and not (ancestors & roots):
            continue
        if allowed is not None and not (node_labels & allowed):
            continue
        for (item_id, _), value in zip(columns, values):
            if value and all(ancestors & s for s in hoisted[item_id]):
                matches[item_id].append(urn)
    return _result(matches, errors, started)


def _compile(provider, items, errors) -> Tuple[List[Tuple[str, str]], Dict[str, Any],
                                              Dict[str, List[Set[str]]]]:
    """Each rule's WHERE fragment — parameters numbered on from the last
    rule's, so every rule shares one statement — and its ``descendantOf``
    URN sets."""
    columns: List[Tuple[str, str]] = []
    params: Dict[str, Any] = {}
    hoisted: Dict[str, List[Set[str]]] = {}
    counter = 0
    for item_id, predicate in items:
        compiler = _build_compiler_for_provider(provider)
        compiler._param_counter = counter
        try:
            where = compiler.compile(predicate)
        except CompileError as exc:
            errors[item_id] = str(exc)
            continue
        if compiler.hoisted_within_hops or compiler.hoisted_path is not None:
            errors[item_id] = ("A rule can't use 'within hops' or a path: they "
                               "describe a route through the graph, not an entity.")
            continue
        counter = compiler._param_counter
        params.update(compiler.params)
        hoisted[item_id] = [set(s) for s in compiler.hoisted_root_urns]
        columns.append((item_id, where if where else "true"))
    return columns, params, hoisted


async def _labels_by_urn(provider, run, labels, urns: List[str], timeout_s: float
                         ) -> Dict[str, List[str]]:
    """The URNs grouped by a label each carries: from the provider's
    urn→label cache (a Redis pipeline, seeking the label indexes only for
    what it has never seen), else through every label's urn index."""
    resolve = getattr(provider, "_resolve_urn_labels_bulk", None)
    if resolve is not None:
        out: Dict[str, List[str]] = {}
        for urn, label in (await resolve(urns)).items():
            if label:
                out.setdefault(str(label), []).append(urn)
        return out
    if labels is None:
        labels = await _searchable_labels(provider, timeout_s=timeout_s)
    return await _labels_of(run, labels, urns)


async def _labels_of(run, labels: Sequence[str], urns: List[str]) -> Dict[str, List[str]]:
    """Which label each URN is under, through the per-label urn index."""
    if not labels:
        return {}
    union = " UNION ALL ".join(
        f"MATCH (n:`{_sanitize_label(lbl)}`) WHERE n.urn IN $_urns "
        f"RETURN '{_quote(lbl)}' AS label, n.urn AS urn"
        for lbl in labels
    )
    res = await run(union, {"_urns": urns})
    out: Dict[str, List[str]] = {}
    for label, urn in res.result_set or []:
        out.setdefault(str(label), []).append(urn)
    return out


def _containment(provider) -> Tuple[str, ...]:
    try:
        return tuple(sorted(provider._get_containment_edge_types()))
    except Exception:
        return ()


def _result(matches, errors, started) -> Dict[str, Any]:
    return {"matches": {k: v for k, v in matches.items() if k not in errors},
            "errors": errors, "elapsedMs": int((time.monotonic() - started) * 1000)}
