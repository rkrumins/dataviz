"""Mutation validation for authored graphs.

Authored fresh (not extracted from ContextEngine — that 1700-line
hot-path extraction is deferred until the backend test harness is
runnable; see the Phase-0 status notes). The strict path is shaped so
the engine can feed it a thin :class:`OntologySpec` adapted from the
existing ``ResolvedOntology`` later, with no behavioural drift.

Two modes (matches user_graphs.schema_mode):

* ``schemaless`` (default) — **structural** integrity only: every node
  key present and unique; every edge endpoint resolves to a node in
  the resulting graph state (no dangling edges). Types are free-form.
* ``strict`` — structural integrity **plus** every node ``entity_type``
  and edge ``edge_type`` must exist in the bound ontology.

The validator runs against the *resulting state* (base graph with the
working set applied), so the engine resolves adds/deletes first and
hands the validator the final node/edge picture. Pure logic, no DB —
fully unit-testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Iterator


@dataclass(frozen=True)
class NodeSpec:
    key: str
    entity_type: str | None = None


@dataclass(frozen=True)
class EdgeSpec:
    key: str
    source_key: str
    target_key: str
    edge_type: str | None = None


@dataclass(frozen=True)
class OntologySpec:
    """Thin projection of a resolved ontology — just the membership
    sets the validator needs. The engine builds this from the existing
    ontology service so strict-mode rules stay single-sourced.

    ``containment_edge_types`` and ``lineage_edge_types`` classify the
    relationship types so the validator can enforce containment-DAG
    (no cycles among containment edges) while leaving lineage cycles
    permitted (real data flows can loop back). They default empty for
    back-compat with strict graphs whose ontology pre-dated the
    classification — in that case no DAG check runs and lineage is
    treated as undifferentiated."""

    entity_types: frozenset[str]
    relationship_types: frozenset[str]
    containment_edge_types: frozenset[str] = field(default_factory=frozenset)
    lineage_edge_types: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class Violation:
    code: str
    message: str
    object_kind: str          # 'node' | 'edge'
    object_id: str


class GraphValidationError(ValueError):
    """Raised when a working set would produce an invalid graph.
    Carries every violation so the API can return them all at once."""

    def __init__(self, violations: list[Violation]) -> None:
        self.violations = violations
        super().__init__(
            f"{len(violations)} graph validation violation(s): "
            + "; ".join(f"[{v.code}] {v.message}" for v in violations[:5])
            + ("…" if len(violations) > 5 else "")
        )


@dataclass
class _Acc:
    violations: list[Violation] = field(default_factory=list)

    def add(self, code: str, message: str, kind: str, oid: str) -> None:
        self.violations.append(Violation(code, message, kind, oid))


def validate_graph_state(
    *,
    nodes: Iterable[NodeSpec],
    edges: Iterable[EdgeSpec],
    schema_mode: str,
    ontology: OntologySpec | None = None,
) -> None:
    """Validate the resulting graph state. Raises
    :class:`GraphValidationError` with every violation, or returns
    ``None`` if valid.

    ``nodes``/``edges`` are the FINAL state (base + working set
    applied, deletes removed) — the engine resolves that before
    calling. ``schema_mode`` ∈ {'schemaless','strict'}; ``ontology`` is
    required iff strict.
    """
    if schema_mode not in ("schemaless", "strict"):
        raise ValueError(f"unknown schema_mode: {schema_mode!r}")
    if schema_mode == "strict" and ontology is None:
        raise ValueError("strict schema_mode requires an OntologySpec")

    acc = _Acc()
    node_list = list(nodes)

    # ── nodes: presence + uniqueness ────────────────────────────────
    seen: set[str] = set()
    node_keys: set[str] = set()
    for n in node_list:
        if not n.key:
            acc.add("node_key_empty", "node has an empty key", "node", n.key or "")
            continue
        if n.key in seen:
            acc.add(
                "node_key_duplicate",
                f"duplicate node key {n.key!r}",
                "node",
                n.key,
            )
            continue
        seen.add(n.key)
        node_keys.add(n.key)
        if schema_mode == "strict":
            et = n.entity_type
            if not et or et not in ontology.entity_types:  # type: ignore[union-attr]
                acc.add(
                    "node_type_unknown",
                    f"entity_type {et!r} not in ontology",
                    "node",
                    n.key,
                )

    # ── edges: endpoints resolve (no dangling) + type membership ────
    seen_edges: set[str] = set()
    for e in edges:
        if not e.key:
            acc.add("edge_key_empty", "edge has an empty key", "edge", e.key or "")
            continue
        if e.key in seen_edges:
            acc.add(
                "edge_key_duplicate",
                f"duplicate edge key {e.key!r}",
                "edge",
                e.key,
            )
            continue
        seen_edges.add(e.key)
        if e.source_key not in node_keys:
            acc.add(
                "edge_dangling_source",
                f"edge {e.key!r} source {e.source_key!r} is not a node",
                "edge",
                e.key,
            )
        if e.target_key not in node_keys:
            acc.add(
                "edge_dangling_target",
                f"edge {e.key!r} target {e.target_key!r} is not a node",
                "edge",
                e.key,
            )
        if schema_mode == "strict":
            rt = e.edge_type
            if not rt or rt not in ontology.relationship_types:  # type: ignore[union-attr]
                acc.add(
                    "edge_type_unknown",
                    f"edge_type {rt!r} not in ontology",
                    "edge",
                    e.key,
                )

    # ── containment DAG enforcement ─────────────────────────────────
    # Strict-mode only and only when the ontology classifies any edge
    # as containment. Pure-structural cycle detection over the
    # containment-edge subgraph; lineage edges are not checked here
    # (real data flows can legitimately loop back to upstream).
    if (
        schema_mode == "strict"
        and ontology is not None
        and ontology.containment_edge_types
    ):
        _check_containment_dag(
            edges=edges, containment_types=ontology.containment_edge_types, acc=acc,
        )

    if acc.violations:
        raise GraphValidationError(acc.violations)


def _check_containment_dag(
    *,
    edges: Iterable[EdgeSpec],
    containment_types: frozenset[str],
    acc: "_Acc",
) -> None:
    """Append a ``containment_cycle`` violation per cycle found in the
    containment-edge subgraph. Uses iterative 3-color DFS (white →
    gray → black) so deep hierarchies don't blow the recursion limit.
    A single violation per discovered cycle (named by the node where
    the back-edge closes) is enough for the UI to surface a clear
    fix — listing every edge on every cycle would drown the user.
    """
    adjacency: dict[str, list[str]] = {}
    for e in edges:
        if e.edge_type and e.edge_type in containment_types:
            adjacency.setdefault(e.source_key, []).append(e.target_key)
            adjacency.setdefault(e.target_key, [])  # ensure sink keys are visited

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {k: WHITE for k in adjacency}
    parent: dict[str, str | None] = {k: None for k in adjacency}
    reported: set[str] = set()

    for root in list(adjacency.keys()):
        if color[root] != WHITE:
            continue
        # Iterative DFS with an explicit stack of (node, neighbor-iter).
        stack: list[tuple[str, "Iterator[str]"]] = [(root, iter(adjacency[root]))]
        color[root] = GRAY
        while stack:
            node, neighbors = stack[-1]
            nxt = next(neighbors, None)
            if nxt is None:
                color[node] = BLACK
                stack.pop()
                continue
            c = color.get(nxt, WHITE)
            if c == WHITE:
                color[nxt] = GRAY
                parent[nxt] = node
                stack.append((nxt, iter(adjacency.get(nxt, []))))
            elif c == GRAY:
                # Back-edge: cycle closes at `nxt`. Walk the parent
                # chain from `node` back to `nxt` to render the path
                # in the violation message.
                if nxt in reported:
                    continue
                reported.add(nxt)
                path = [node]
                cur = parent.get(node)
                while cur is not None and cur != nxt:
                    path.append(cur)
                    cur = parent.get(cur)
                path.append(nxt)
                path.reverse()
                acc.add(
                    "containment_cycle",
                    f"containment cycle: {' -> '.join(path)} -> {nxt}",
                    "node",
                    nxt,
                )


__all__ = [
    "NodeSpec",
    "EdgeSpec",
    "OntologySpec",
    "Violation",
    "GraphValidationError",
    "validate_graph_state",
]
