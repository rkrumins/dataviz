"""What turning ``placementContractEnabled`` on would change, per saved view: counted, not guessed.

Read-only: the only write is the optional ``--json`` file, and the flag itself is never read. For
each live view with layers it samples, once, the entities the view's config decides: its explicit
entries (the first ``ROOT_SAMPLE``), a page of each type a layer or rule claims (mapped to the
ontology's declared id), a page of each rule tag, and the ancestor chains of all of them. Over those
same nodes and containment edges it runs the server's placement today (``AssignmentEngine``, fed the
request the canvas builds, through an in-memory engine) and the placement contract
(``view_placement.place_all``). Per view it reports:

* the entities whose member layer changes, counted by transition (``inherited->rule``,
  ``rule->none``, ``none->rule``, ``explicit->rule +stale``, ...), with examples;
* rules that can never match (inert) and explicit entries naming a layer that is gone (stale);
* ``rejected``: the server refuses the view's config today, so the canvas placed it alone;
* canvas-only constructs (``config_flags``): config the canvas read differently from the server,
  which no server-side diff can count.

Counts are over the sample, not exact. ``tests/test_placement_legacy_parity.py`` runs
``diff_placements`` over the shared placement corpus, so every deliberate difference from today is
recorded in ``tests/fixtures/placement_legacy_marks.json``.

Usage::

    python -m backend.scripts.placement_dry_run                      # every live view with layers
    python -m backend.scripts.placement_dry_run --view <id>          # repeatable
    python -m backend.scripts.placement_dry_run --workspace <id>
    python -m backend.scripts.placement_dry_run --json /tmp/placement-dry-run.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from pydantic import ValidationError
from sqlalchemy import select

from backend.app.db.engine import get_async_session
from backend.app.db.models import ViewORM, view_is_live
from backend.app.models.assignment import EntityAssignment, LayerAssignmentRequest
from backend.app.models.graph import EdgeQuery, GraphEdge, GraphNode, NodeQuery, OntologyMetadata
from backend.app.providers.manager import provider_manager
from backend.app.services.assignment_engine import AssignmentEngine
from backend.app.services.context_engine import ContextEngine
from backend.app.services.layout_config import derive_entity_scope, parse_reference_layout
from backend.app.services.view_placement import (
    PlacementSpec, containment_from_ontology, containment_parents, facts_from_graph_node, place_all,
)
from backend.common.search_semantics import fold_case

REJECTED = "rejected"
ROOT_SAMPLE = 5000       # explicit entries read per view
PER_TYPE_SAMPLE = 2000   # nodes read per claimed type and per rule tag
_CHAIN_CHUNK = 500       # urns per ancestor-chain read
_EXAMPLES = 5

Diff = Union[str, Dict[str, Tuple[Optional[dict], dict]]]


# ---------------------------------------------------------------------------
# The core: today's server placement against the contract, over the same facts
# ---------------------------------------------------------------------------

def build_legacy_request(view_config: Optional[dict], urns: Sequence[str]) -> LayerAssignmentRequest:
    """The request the canvas sends for this view (``referenceModelStore.buildAssignmentRequest``)
    over ``urns``. Raises ``ValidationError`` where ``/assignments/compute`` answers 422 today."""
    layout = parse_reference_layout(view_config)

    def value_or(v: Any, default: Any) -> Any:  # the client's ``??``
        return default if v is None else v

    return LayerAssignmentRequest.model_validate({
        "urns": list(urns),
        "layers": [{
            "id": layer.get("id"),
            "name": layer.get("name"),
            "color": value_or(layer.get("color"), "#808080"),
            "order": layer.get("order"),
            "sequence": value_or(layer.get("sequence"), layer.get("order")),
            "entityTypes": layer.get("entityTypes"),
            "rules": value_or(layer.get("rules"), []),
            "logicalNodes": layer.get("logicalNodes"),
            "entityAssignments": [],  # already in ``assignments``: the normalizer moved them
        } for layer in layout.layers if isinstance(layer, dict)],
        "assignments": {urn: {
            "entityId": urn,
            "layerId": entry.get("layerId"),
            "logicalNodeId": entry.get("logicalNodeId"),
            "inheritsChildren": value_or(entry.get("inheritsChildren"), True),
            "priority": 1000,
            "assignedBy": "rule" if entry.get("assignedBy") == "rule" else "user",
            "assignedAt": value_or(entry.get("assignedAt"), ""),  # never read by the engine
        } for urn, entry in layout.assignments.items()},
        "entityScope": derive_entity_scope(view_config),
    })


class _Given:
    """The three ContextEngine reads ``compute_assignments`` makes, answered from what we hold
    (the shape of ``_FakeEngine`` in tests/test_assignment_engine_scope.py)."""

    def __init__(self, nodes: Sequence[GraphNode], edges: Sequence[GraphEdge], containment_types: List[str]):
        self._nodes = nodes
        self._edges = edges
        self._containment_types = containment_types

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return OntologyMetadata(
            containmentEdgeTypes=self._containment_types, edgeTypeMetadata={}, entityTypeHierarchy={})

    async def get_nodes_query(self, query: NodeQuery) -> List[GraphNode]:
        wanted = set(query.urns or ())
        return [n for n in self._nodes if n.urn in wanted]

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        return list(self._edges)


def _legacy_source(assignment: EntityAssignment, explicit: bool) -> str:
    if assignment.is_inherited:
        return "inherited"
    if assignment.rule_id:
        return "rule"
    return "explicit" if explicit else "stamped"


async def diff_placements(
    view_config: Optional[dict],
    containment: Dict[str, bool],
    nodes: Sequence[GraphNode],
    edges: Sequence[GraphEdge],
    created_in_branch: Iterable[str] = (),
) -> Diff:
    """``{urn: (old, new)}`` for each node whose MEMBER layer differs between the server's
    placement today and the placement contract, over the same nodes and edges; ``REJECTED`` when
    the server refuses the view's config (the request the canvas builds is a 422 today).

    ``containment`` is ``{EDGE_TYPE: child is source}`` (``containment_from_ontology``); the legacy
    engine reads only its keys. ``old`` is ``{layerId, source}``, None when the server leaves the
    node unassigned; ``new`` is the contract's ``Placement.to_json()``.
    """
    try:
        request = build_legacy_request(view_config, [n.urn for n in nodes])
    except ValidationError:
        return REJECTED
    legacy = await AssignmentEngine().compute_assignments(
        request, engine=_Given(nodes, edges, list(containment)))
    placed = place_all(
        PlacementSpec.from_config(view_config),
        {n.urn: facts_from_graph_node(n) for n in nodes},
        containment_parents(edges, containment),
        frozenset(created_in_branch),
    )
    changed: Dict[str, Tuple[Optional[dict], dict]] = {}
    for urn, new in placed.items():
        found = legacy.assignments.get(urn)
        if (found.layer_id if found else None) != (new.layer_id if new.member else None):
            old = None if found is None else {
                "layerId": found.layer_id, "source": _legacy_source(found, urn in request.assignments)}
            changed[urn] = (old, new.to_json())
    return changed


def config_flags(view_config: Optional[dict]) -> List[str]:
    """Config the canvas placed differently from the server today. The canvas placed those
    entities itself, so no server-side diff can count these:

    * ``duplicate-types``: a type in two layers' ``entityTypes`` (the canvas gave it to the later one);
    * ``authored-rules``: authored rules (the canvas priced ``entityTypes`` at ``order*10+index``, so
      an authored priority compared differently);
    * ``empty-rule``: a rule with no criterion (the canvas matched every entity with it);
    * ``glob-pattern``: a ``urnPattern`` (the canvas read it as an unanchored regex);
    * ``property-rule``: ``propertyMatch`` or ``conditions`` (the canvas read the wrong property bag
      and skipped conditions);
    * ``fallback-layer``: a ``showUnassigned`` layer in an open view (the canvas let children inherit
      it; under the contract it is display only).
    """
    layout = parse_reference_layout(view_config)
    layers = [layer for layer in layout.layers if isinstance(layer, dict)]
    rules = [rule for layer in layers for rule in _list(layer.get("rules")) if isinstance(rule, dict)]
    types = [t for layer in layers for t in {fold_case(x) for x in _strings(layer.get("entityTypes"))}]
    flags = []
    if len(types) != len(set(types)):
        flags.append("duplicate-types")
    if rules:
        flags.append("authored-rules")
    if any(not (rule.get("entityTypes") or rule.get("tags") or rule.get("urnPattern")
                or rule.get("propertyMatch") or rule.get("conditions")) for rule in rules):
        flags.append("empty-rule")
    if any(rule.get("urnPattern") for rule in rules):
        flags.append("glob-pattern")
    if any(rule.get("propertyMatch") or rule.get("conditions") for rule in rules):
        flags.append("property-rule")
    if derive_entity_scope(view_config) == "all" and any(layer.get("showUnassigned") is True for layer in layers):
        flags.append("fallback-layer")
    return flags


def _list(v: Any) -> list:
    return v if isinstance(v, list) else []


def _strings(v: Any) -> List[str]:
    return [s for s in _list(v) if isinstance(s, str) and s]


# ---------------------------------------------------------------------------
# One view: sample once, then summarise
# ---------------------------------------------------------------------------

async def _sample(engine: ContextEngine, config: dict) -> Tuple[List[GraphNode], List[GraphEdge], Dict[str, bool], bool]:
    """The nodes and containment edges this view's config decides, read once, plus
    ``{EDGE_TYPE: child is source}`` and whether any read was capped."""
    layout = parse_reference_layout(config)
    layers = [layer for layer in layout.layers if isinstance(layer, dict)]
    rules = [rule for layer in layers for rule in _list(layer.get("rules")) if isinstance(rule, dict)]
    resolved = await engine.get_resolved_ontology()
    # The provider widens a declared id to the spellings it observed; a claim may be any spelling.
    declared = {fold_case(t): t for t in (getattr(resolved, "entity_type_definitions", None) or {})}
    claimed = sorted({declared.get(fold_case(t), t)
                      for item in layers + rules for t in _strings(item.get("entityTypes"))})
    tags = sorted({t for rule in rules for t in _strings(rule.get("tags"))})

    explicit = list(layout.assignments)
    capped = len(explicit) > ROOT_SAMPLE
    sampled = set(explicit[:ROOT_SAMPLE])
    pages = ([NodeQuery(entityTypes=[t], limit=PER_TYPE_SAMPLE, includeChildCount=False) for t in claimed]
             + [NodeQuery(tags=[t], limit=PER_TYPE_SAMPLE, includeChildCount=False) for t in tags])
    for query in pages:
        page = await engine.get_nodes_query(query)
        capped = capped or len(page) >= PER_TYPE_SAMPLE
        sampled.update(n.urn for n in page)

    ancestors = set()
    roots = sorted(sampled)
    for start in range(0, len(roots), _CHAIN_CHUNK):
        try:
            chains = await engine.get_ancestor_chains(roots[start:start + _CHAIN_CHUNK])
        except NotImplementedError:  # a reader with no containment walk
            break
        ancestors.update(a for chain in chains.values() for a in chain)

    urns = sorted(sampled | ancestors)
    if not urns:
        return [], [], containment_from_ontology(resolved), capped
    # Read like compute_assignments reads a canvas: every node, and the edges among them.
    nodes = await engine.get_nodes_query(NodeQuery(urns=urns, limit=len(urns), includeChildCount=False))
    edge_cap = max(len(urns) * 8, 10_000)
    edges = await engine.get_edges(EdgeQuery(sourceUrns=urns, targetUrns=urns, limit=edge_cap))
    return nodes, edges, containment_from_ontology(resolved), capped or len(edges) >= edge_cap


def _transition(old: Optional[dict], new: dict) -> str:
    stale = " +stale" if new.get("staleExplicit") else ""
    return f"{old['source'] if old else 'none'}->{new['source']}{stale}"


def _summarise(view: Any, config: dict, nodes: Sequence[GraphNode], diff: Diff, capped: bool) -> Dict[str, Any]:
    """One view's report row (``view`` needs ``id``, ``name`` and ``workspace_id``)."""
    spec = PlacementSpec.from_config(config)
    stale = sorted(urn for urn, entry in spec.explicit.items() if entry.layer_id not in spec.layer_ids)
    by_transition: Counter = Counter()
    examples: Dict[str, List[str]] = {}
    if diff != REJECTED:
        for urn, (old, new) in sorted(diff.items()):
            key = _transition(old, new)
            by_transition[key] += 1
            if len(examples.setdefault(key, [])) < _EXAMPLES:
                examples[key].append(urn)
    return {
        "view": view.id,
        "name": view.name,
        "workspace": view.workspace_id,
        "scope": spec.scope,
        "sampled": len(nodes),
        "capped": capped,
        "rejected": diff == REJECTED,
        "changed": None if diff == REJECTED else len(diff),
        "byTransition": dict(sorted(by_transition.items())),
        "examples": examples,
        "inertRules": [{"layerId": layer_id, "ruleId": rule_id, "reason": reason}
                       for layer_id, rule_id, reason in spec.inert],
        "staleExplicit": {"count": len(stale), "examples": stale[:_EXAMPLES]},
        "canvasOnly": config_flags(config),
    }


def _render(row: Dict[str, Any]) -> List[str]:
    """Plain-text lines for one row; [] when there is nothing to say about the view."""
    head = f"view {row['view']} \"{row['name']}\""
    if "error" in row:
        return [f"{head}: error: {row['error']}"]
    if not (row["changed"] or row["rejected"] or row["inertRules"]
            or row["staleExplicit"]["count"] or row["canvasOnly"]):
        return []
    sample = f"{row['sampled']} sampled" + (", capped" if row["capped"] else "")
    outcome = "the server refuses this config today" if row["rejected"] else f"{row['changed']} would change"
    lines = [f"{head} (scope {row['scope']}, {sample}): {outcome}"]
    for key, count in row["byTransition"].items():
        lines.append(f"  {key}: {count}  e.g. {', '.join(row['examples'][key])}")
    for rule in row["inertRules"]:
        lines.append(f"  inert rule: layer {rule['layerId']}, rule {rule['ruleId']}: {rule['reason']}")
    if row["staleExplicit"]["count"]:
        lines.append(f"  stale explicit entries: {row['staleExplicit']['count']}"
                     f"  e.g. {', '.join(row['staleExplicit']['examples'])}")
    if row["canvasOnly"]:
        lines.append(f"  canvas only: {', '.join(row['canvasOnly'])}")
    return lines


async def _run(view_ids: Optional[List[str]], workspace_id: Optional[str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    async with get_async_session() as session:
        query = select(ViewORM).where(view_is_live())
        if view_ids:
            query = query.where(ViewORM.id.in_(view_ids))
        if workspace_id:
            query = query.where(ViewORM.workspace_id == workspace_id)
        for view in (await session.execute(query.order_by(ViewORM.id))).scalars().all():
            try:
                config = json.loads(view.config or "{}")
                if not isinstance(config, dict) or not parse_reference_layout(config).layers:
                    continue
                engine = await ContextEngine.for_workspace(
                    view.workspace_id, provider_manager, session, data_source_id=view.data_source_id)
                nodes, edges, containment, capped = await _sample(engine, config)
                diff = await diff_placements(config, containment, nodes, edges)
                rows.append(_summarise(view, config, nodes, diff, capped))
            except Exception as exc:  # noqa: BLE001 — one view's failure never stops the report
                rows.append({"view": view.id, "name": view.name, "workspace": view.workspace_id,
                             "error": f"{type(exc).__name__}: {exc}"})
    return rows


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report what placementContractEnabled would change, per saved view (read-only).")
    parser.add_argument("--view", action="append", help="only this view id (repeatable)")
    parser.add_argument("--workspace", help="only the views of this workspace")
    parser.add_argument("--json", metavar="PATH", help="also write the full report as JSON to PATH")
    args = parser.parse_args(argv)

    rows = asyncio.run(_run(args.view, args.workspace))
    for row in rows:
        for line in _render(row):
            print(line)
    changing = sum(1 for row in rows if row.get("changed") or row.get("rejected"))
    print(f"{changing} view(s) would change, of {len(rows)} with layers.")
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
