"""One placement contract: which layer of a view an entity is in, and why.

The Python reference. ``frontend/src/lib/placement/placement.ts`` is its twin, and the two are
held together by the shared corpus in ``backend/tests/fixtures/placement/`` (pytest:
``tests/test_placement_conformance.py``; vitest: the frontend runner beside the twin).

``PlacementSpec.from_config`` compiles a FULL view config once: layers by (order, position), rules
sorted once by ``(-priority, layer order, layer position, rule index)``, each rule the AND of its
criteria. ``place`` answers for one entity from its own facts and what its parents pass down, in
tiers::

    own explicit entry
    > inherited from a hand-placed parent (gated by that parent's own ``inheritsChildren``)
    > [a curated view stops here, except the entity's own created-in-draft stamp]
    > stamped > own rule
    > inherited from a stamped or rule-placed parent (gated by the rule's ``inheritsFromParent``)
    > fallback (``showUnassigned``: display only, never a member) > none

``place_all`` places a set parents first, ignoring containment cycles, whatever the input order.
``suggest_placement`` is the write-path policy: pin an explicit entry only when the view is
curated or the chosen layer differs from what the contract already computes.

Pure: it reads no database and no graph. ``contract_enabled`` imports the flag service lazily.
"""
from __future__ import annotations

import heapq
import math
import re
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Mapping, Optional, Tuple

from backend.app.services.layout_config import derive_entity_scope, parse_reference_layout
from backend.common.search_semantics import (
    Comparison,
    SemanticsError,
    evaluate,
    fold_case,
    resolve_comparison,
)

if TYPE_CHECKING:  # pragma: no cover — annotation only
    from backend.common.models.graph import GraphEdge, GraphNode


CONTRACT_FLAG = "placementContractEnabled"
CONTRACT_VERSION = 1

#: A rule condition's operator -> the ``search_semantics`` operator it compares with.
RULE_OPERATORS: Dict[str, str] = {
    "equals": "eq", "notEquals": "neq", "contains": "contains",
    "startsWith": "startsWith", "endsWith": "endsWith", "exists": "isSet",
}

#: Fallback is display only: never a member, never inherited.
MEMBER_SOURCES = frozenset({"explicit", "inherited", "stamped", "rule"})

# What a placement passes to its children: an explicit (hand) placement beats the child's own
# stamp and rule; a stamped or rule (soft) placement only fills in when the child has neither.
HAND = "hand"
SOFT = "soft"

_FIELD_FALLBACK = {"name": "display_name", "type": "entity_type", "urn": "urn"}
_NO_CRITERIA = "has no criteria, so it can never place anything"


# ---------------------------------------------------------------------------
# Inputs and the answer
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class NodeFacts:
    """What the contract reads about one entity. ``properties`` is the USER bag."""
    urn: str
    entity_type: str = ""
    display_name: Optional[str] = None
    tags: frozenset = frozenset()
    properties: Mapping[str, Any] = field(default_factory=dict)
    #: The legacy ``layerAssignment`` stamp, a non-empty string or None.
    stamp: Optional[str] = None


@dataclass(frozen=True)
class ParentContext:
    """What one parent passes down, built by the caller from the parent's placement."""
    urn: str
    layer_id: str
    cascade: Optional[str]


@dataclass(frozen=True)
class Placement:
    layer_id: Optional[str]
    source: str  # explicit | inherited | stamped | rule | fallback | none
    rule_id: Optional[str] = None
    inherited_from: Optional[str] = None
    stale_explicit: bool = False
    ambiguous_parent: bool = False
    #: INTERNAL: what this placement passes to children (HAND | SOFT | None). Never serialized.
    cascade: Optional[str] = None

    @property
    def member(self) -> bool:
        return self.source in MEMBER_SOURCES

    def to_json(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"layerId": self.layer_id, "source": self.source}
        if self.rule_id is not None:
            out["ruleId"] = self.rule_id
        if self.inherited_from is not None:
            out["inheritedFrom"] = self.inherited_from
        if self.stale_explicit:
            out["staleExplicit"] = True
        if self.ambiguous_parent:
            out["ambiguousParent"] = True
        return out


# ---------------------------------------------------------------------------
# The compiled view
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ExplicitEntry:
    layer_id: str
    inherits_children: bool
    logical_node_id: Optional[str] = None


@dataclass(frozen=True)
class CompiledRule:
    id: str
    layer_id: str
    priority: Any
    key: Tuple[Any, Any, int, int]  # (-priority, layer order, layer position, rule index)
    types: Optional[frozenset]      # fold_case'd; None = any type
    tags: Optional[frozenset]       # exact; None = no tag criterion
    glob: Optional[re.Pattern]
    comparisons: Tuple[Tuple[str, Comparison], ...]
    cascades_soft: bool             # inheritsFromParent !== false

    def matches(self, facts: NodeFacts) -> bool:
        if self.types is not None and fold_case(facts.entity_type) not in self.types:
            return False
        if self.tags is not None and self.tags.isdisjoint(facts.tags):
            return False
        if self.glob is not None and self.glob.fullmatch(facts.urn) is None:
            return False
        return all(evaluate(_value(facts, name), cmp) for name, cmp in self.comparisons)


@dataclass(frozen=True)
class PlacementSpec:
    scope: str  # all | curated
    layer_ids: frozenset
    rules: Tuple[CompiledRule, ...]
    explicit: Mapping[str, ExplicitEntry]
    first_layer_id: Optional[str]
    fallback_layer_id: Optional[str]
    #: Rules that can never match: ``(layer id, rule id, reason)``. They claim nothing.
    inert: Tuple[Tuple[str, str, str], ...] = ()
    _by_type: Dict[str, Tuple[CompiledRule, ...]] = field(
        default_factory=dict, init=False, repr=False, compare=False)

    @classmethod
    def from_config(cls, config: Optional[dict]) -> "PlacementSpec":
        """Compile a FULL view config (``json.loads(ViewORM.config)``), not a bare layout."""
        layout = parse_reference_layout(config)
        layers = sorted(
            ((_num(raw.get("order")), position, raw) for position, raw in enumerate(layout.layers)
             if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"]),
            key=lambda item: (item[0], item[1]),
        )
        rules: List[CompiledRule] = []
        inert: List[Tuple[str, str, str]] = []
        for order, position, raw in layers:
            layer_id = raw["id"]
            authored = raw.get("rules") if isinstance(raw.get("rules"), list) else []
            for index, rule in enumerate(authored):
                if not isinstance(rule, dict):
                    continue
                rule_id = _rule_id(rule, layer_id, index)
                criteria, reason = _criteria(rule)
                if criteria is None:
                    inert.append((layer_id, rule_id, reason))
                    continue
                priority = _num(rule.get("priority"))
                rules.append(CompiledRule(
                    rule_id, layer_id, priority, (-priority, order, position, index), *criteria,
                    cascades_soft=rule.get("inheritsFromParent") is not False))
            # layer.entityTypes: priority-0 rules after the layer's authored ones.
            for offset, t in enumerate(dict.fromkeys(_strings(raw.get("entityTypes")))):
                rules.append(CompiledRule(
                    f"_type_{layer_id}_{t}", layer_id, 0, (0, order, position, len(authored) + offset),
                    frozenset({fold_case(t)}), None, None, (), cascades_soft=True))
        rules.sort(key=lambda r: r.key)

        explicit = {
            urn: ExplicitEntry(e["layerId"], e.get("inheritsChildren") is not False, e.get("logicalNodeId"))
            for urn, e in layout.assignments.items()
            if isinstance(e.get("layerId"), str) and e["layerId"]  # '' / missing = absent, never stale
        }
        return cls(
            scope=derive_entity_scope(config),
            layer_ids=frozenset(raw["id"] for _, _, raw in layers),
            rules=tuple(rules),
            explicit=explicit,
            first_layer_id=layers[0][2]["id"] if layers else None,
            fallback_layer_id=next(
                (raw["id"] for _, _, raw in layers if raw.get("showUnassigned") is True), None),
            inert=tuple(inert),
        )

    def rules_for(self, entity_type: str) -> Tuple[CompiledRule, ...]:
        """The rules that can claim this type, in sort order (cached per folded type)."""
        key = fold_case(entity_type)
        found = self._by_type.get(key)
        if found is None:
            found = self._by_type[key] = tuple(
                r for r in self.rules if r.types is None or key in r.types)
        return found

    def with_scope(self, scope: str) -> "PlacementSpec":
        return replace(self, scope=scope)


def _num(v: Any) -> Any:
    """A finite int or float as itself; anything else (bool, text, nan, missing) is 0."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return v
    return 0


def _strings(v: Any) -> List[str]:
    return [s for s in v if isinstance(s, str) and s] if isinstance(v, list) else []


def _rule_id(rule: dict, layer_id: str, index: int) -> str:
    rule_id = rule.get("id")
    return rule_id if isinstance(rule_id, str) and rule_id else f"_rule_{layer_id}_{index}"


def _glob(pattern: str) -> re.Pattern:
    """Anchored (with ``fullmatch``): ``*`` any run, ``?`` one code point, the rest literal."""
    return re.compile(
        "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pattern),
        re.DOTALL)


def _criteria(rule: dict):
    """``((types, tags, glob, comparisons), None)``, or ``(None, reason)`` for an inert rule."""
    types = frozenset(fold_case(t) for t in _strings(rule.get("entityTypes"))) or None
    tags = frozenset(_strings(rule.get("tags"))) or None
    pattern = rule.get("urnPattern")
    glob = _glob(pattern) if isinstance(pattern, str) and pattern else None
    conditions = rule.get("conditions")
    conds = ([rule["propertyMatch"]] if isinstance(rule.get("propertyMatch"), dict) else []) + [
        c for c in (conditions if isinstance(conditions, list) else []) if isinstance(c, dict)]

    comparisons: List[Tuple[str, Comparison]] = []
    for cond in conds:
        name = cond.get("field")
        if not isinstance(name, str) or not name:
            continue  # an unfinished condition is absent, like urnPattern ''
        operator = cond.get("operator") or "equals"
        op = RULE_OPERATORS.get(operator) if isinstance(operator, str) else None
        if op is None:
            return None, f"uses an unknown operator {operator}"
        try:
            comparisons.append((name, resolve_comparison(op, cond.get("value"))))
        except SemanticsError as e:
            return None, f"cannot compare '{name}': {e}"
    if types is None and tags is None and glob is None and not comparisons:
        return None, _NO_CRITERIA
    return (types, tags, glob, tuple(comparisons)), None


def _value(facts: NodeFacts, name: str) -> Any:
    stored = facts.properties.get(name)
    if stored is None and name in _FIELD_FALLBACK:
        return getattr(facts, _FIELD_FALLBACK[name])
    return stored


# ---------------------------------------------------------------------------
# Placing
# ---------------------------------------------------------------------------

def place(
    spec: PlacementSpec,
    facts: NodeFacts,
    parents: Iterable[ParentContext] = (),
    *,
    created_in_branch: bool = False,
) -> Placement:
    """Place one entity from its own facts and the contexts its parents pass down."""
    layer_ids = spec.layer_ids
    parents = [p for p in parents if p.layer_id in layer_ids]

    entry = spec.explicit.get(facts.urn)
    stale = entry is not None and entry.layer_id not in layer_ids
    if entry is not None and not stale:
        return Placement(entry.layer_id, "explicit", cascade=HAND if entry.inherits_children else None)

    inherited = _inherit(parents, HAND, stale)
    if inherited is not None:
        return inherited

    stamp = facts.stamp if facts.stamp in layer_ids else None
    if spec.scope == "curated":
        if created_in_branch and stamp:
            # The draft's own stamp; it cascades by hand, as Build Mode and rail create always have.
            return Placement(stamp, "stamped", stale_explicit=stale, cascade=HAND)
        return Placement(None, "none", stale_explicit=stale)
    if stamp:
        return Placement(stamp, "stamped", stale_explicit=stale, cascade=SOFT)

    for rule in spec.rules_for(facts.entity_type):
        if rule.matches(facts):
            return Placement(rule.layer_id, "rule", rule_id=rule.id, stale_explicit=stale,
                             cascade=SOFT if rule.cascades_soft else None)

    inherited = _inherit(parents, SOFT, stale)
    if inherited is not None:
        return inherited
    if spec.fallback_layer_id:
        return Placement(spec.fallback_layer_id, "fallback", stale_explicit=stale)
    return Placement(None, "none", stale_explicit=stale)


def _inherit(parents: List[ParentContext], cascade: str, stale: bool) -> Optional[Placement]:
    """Inherit from the smallest-URN parent offering ``cascade``; ambiguous when the parents at
    this tier name different layers."""
    tier = sorted((p for p in parents if p.cascade == cascade), key=lambda p: p.urn)
    if not tier:
        return None
    return Placement(tier[0].layer_id, "inherited", inherited_from=tier[0].urn, stale_explicit=stale,
                     ambiguous_parent=len({p.layer_id for p in tier}) > 1, cascade=cascade)


def place_all(
    spec: PlacementSpec,
    facts_by_urn: Mapping[str, NodeFacts],
    parents_by_urn: Mapping[str, Iterable[str]],
    created_in_branch: frozenset = frozenset(),
) -> Dict[str, Placement]:
    """Place a set of entities, parents before children, in a dict ordered that way.

    Parents outside the set are unknown. A parent edge inside a containment cycle (a strongly
    connected component) is ignored: nodes on the cycle resolve through their own tiers and their
    descendants still inherit. The answer is the same whatever the input order.
    """
    candidates = {
        u: sorted({p for p in parents_by_urn.get(u, ()) if p != u and p in facts_by_urn})
        for u in facts_by_urn
    }
    component = _components(candidates)
    parents = {u: [p for p in ps if component[p] != component[u]] for u, ps in candidates.items()}

    # Kahn, smallest URN first among the ready, so the order is deterministic too.
    waiting = {u: len(ps) for u, ps in parents.items()}
    children: Dict[str, List[str]] = {}
    for u, ps in parents.items():
        for p in ps:
            children.setdefault(p, []).append(u)
    ready = [u for u, n in waiting.items() if n == 0]
    heapq.heapify(ready)
    out: Dict[str, Placement] = {}
    while ready:
        u = heapq.heappop(ready)
        contexts = [ParentContext(p, out[p].layer_id, out[p].cascade)
                    for p in parents[u] if out[p].cascade and out[p].layer_id]
        out[u] = place(spec, facts_by_urn[u], contexts, created_in_branch=u in created_in_branch)
        for child in children.get(u, ()):
            waiting[child] -= 1
            if waiting[child] == 0:
                heapq.heappush(ready, child)
    return out


def _components(graph: Mapping[str, List[str]]) -> Dict[str, str]:
    """Tarjan's strongly connected components, iteratively (deep hierarchies never hit the
    recursion limit): each node -> the root of its component."""
    index: Dict[str, int] = {}
    low: Dict[str, int] = {}
    stack: List[str] = []
    on_stack: set = set()
    component: Dict[str, str] = {}
    for root in graph:
        if root in index:
            continue
        index[root] = low[root] = len(index)
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(graph[root]))]
        while work:
            v, edges = work[-1]
            for w in edges:
                if w not in index:
                    index[w] = low[w] = len(index)
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, iter(graph[w])))
                    break
                if w in on_stack:
                    low[v] = min(low[v], index[w])
            else:
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[v])
                if low[v] == index[v]:
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        component[w] = v
                        if w == v:
                            break
    return component


def suggest_placement(
    spec: PlacementSpec,
    facts: NodeFacts,
    chosen_layer_id: Optional[str] = None,
    default_layer_id: Optional[str] = None,
) -> Tuple[Optional[str], bool]:
    """``(layer id, pin)`` for a ROOT entity a write path creates.

    The chosen layer (a valid id) wins, else the layer the contract computes. A curated view with
    neither asks what an open view would compute, then falls back to the default layer, then to
    the first layer. Pin an explicit entry only when the view is curated or the layer differs from
    what the contract already computes.
    """
    def valid(layer_id: Optional[str]) -> Optional[str]:
        return layer_id if layer_id in spec.layer_ids else None

    curated = spec.scope == "curated"
    placed = place(spec, facts)
    current = placed.layer_id if placed.member else None
    layer_id = valid(chosen_layer_id) or current
    if layer_id is None and curated:
        open_placed = place(spec.with_scope("all"), facts)
        layer_id = open_placed.layer_id if open_placed.member else None
    if layer_id is None:
        layer_id = valid(default_layer_id) or (spec.first_layer_id if curated else None)
    return layer_id, layer_id is not None and (curated or layer_id != current)


# ---------------------------------------------------------------------------
# Callers' inputs: containment, facts, the save check, the flag
# ---------------------------------------------------------------------------

def child_is_source(edge_type: str, direction: Optional[str]) -> bool:
    """Whether a containment edge of this type points child -> parent.

    ``source-to-target`` is the resolver's default for a missing direction, so it says nothing:
    like ``bidirectional`` and None it leaves only ``BELONGS_TO`` pointing child -> parent.
    """
    if direction in ("target-to-source", "child-to-parent"):
        return True
    if direction == "parent-to-child":
        return False
    return str(edge_type).upper() == "BELONGS_TO"


def containment_from_ontology(ontology: Any) -> Dict[str, bool]:
    """``{EDGE_TYPE: child is source}`` for each containment type of an ontology: an
    ``OntologyMetadata`` (``EdgeTypeMetadata`` values) or a ``ResolvedOntology`` (dict values,
    upper-cased keys)."""
    metadata = getattr(ontology, "edge_type_metadata", None) or {}
    out: Dict[str, bool] = {}
    for edge_type in getattr(ontology, "containment_edge_types", None) or ():
        key = str(edge_type).upper()
        meta = metadata.get(key) or metadata.get(edge_type)
        direction = meta.get("direction") if isinstance(meta, dict) else getattr(meta, "direction", None)
        out[key] = child_is_source(key, direction)
    return out


def containment_parents(
    edges: Iterable[GraphEdge], containment: Mapping[str, bool],
) -> Dict[str, List[str]]:
    """``{child urn: [parent urns]}`` from the containment edges, oriented by ``containment``."""
    out: Dict[str, List[str]] = {}
    for edge in edges:
        is_source = containment.get(str(edge.edge_type).upper())
        if is_source is None:
            continue
        child, parent = ((edge.source_urn, edge.target_urn) if is_source
                         else (edge.target_urn, edge.source_urn))
        out.setdefault(child, []).append(parent)
    return out


def facts_from_graph_node(node: GraphNode) -> NodeFacts:
    """A graph node's facts. The stamp is the top-level ``layerAssignment`` when it is a non-empty
    string (even one naming no layer), else ``properties.layerAssignment``; '' is no stamp, and
    a '' display name is no name."""
    properties = node.properties or {}
    stamp = node.layer_assignment
    if not (isinstance(stamp, str) and stamp):
        stamp = properties.get("layerAssignment")
    return NodeFacts(
        urn=node.urn,
        entity_type=node.entity_type or "",
        display_name=node.display_name or None,
        tags=frozenset(t for t in node.tags or () if isinstance(t, str)),
        properties=properties,
        stamp=stamp if isinstance(stamp, str) and stamp else None,
    )


def inert_rule_errors(layout: Optional[dict], previous_layout: Optional[dict]) -> List[str]:
    """The save check, over two BARE reference layouts: one message per authored rule that can
    never match and is new or changed against ``previous_layout`` (by content, within its layer).
    A rule stored earlier and sent back unchanged passes, even moved, so a canvas gesture on an
    older view is never refused for a rule it did not touch. Not by rule id: an id-less rule's id
    is its position, which deleting a neighbour shifts."""
    def rules(raw: Optional[dict]):
        for layer in (raw.get("layers") if isinstance(raw, dict) else None) or ():
            if not (isinstance(layer, dict) and isinstance(layer.get("id"), str) and layer["id"]):
                continue
            authored = layer.get("rules")
            for index, rule in enumerate(authored if isinstance(authored, list) else ()):
                if isinstance(rule, dict):
                    yield layer, _rule_id(rule, layer["id"], index), rule

    stored: Dict[str, List[dict]] = {}
    for layer, _, rule in rules(previous_layout):
        stored.setdefault(layer["id"], []).append(rule)
    errors: List[str] = []
    for layer, rule_id, rule in rules(layout):
        if rule in stored.get(layer["id"], ()):
            continue
        criteria, reason = _criteria(rule)
        if criteria is None:
            errors.append(f"layer '{_label(layer, layer['id'])}': rule '{_label(rule, rule_id)}' {reason}")
    return errors


def _label(item: dict, fallback: str) -> str:
    name = item.get("name")
    return name if isinstance(name, str) and name else fallback


async def contract_enabled(session: Any = None) -> bool:
    """Whether placement goes through this contract (Admin -> Features, ``placementContractEnabled``).

    Default False, not the capability ``fail_safe_default``: the flag switches HOW layers are
    filled, so a flag definition that is missing means today's placement. A database error still
    raises, as it does for every other gate.
    """
    from backend.app.services.feature_flags import feature_flags

    if session is not None:
        return await feature_flags.is_enabled(CONTRACT_FLAG, session, default=False)
    return await feature_flags.is_enabled_self_session(CONTRACT_FLAG, default=False)
