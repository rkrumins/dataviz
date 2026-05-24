"""Pure composition of the source layer + enrichment layer.

Two inputs:
- ``source`` — dict of ``urn -> SourceProjection`` materialised from
  ``graph_source_nodes`` / ``graph_source_edges`` (the upstream
  system's view).
- ``enrichment`` — dict of ``urn -> EnrichmentProjection`` materialised
  from the existing ``load_graph_state`` (the user's edits / annotations).

Output:
- ``composed`` — dict of ``urn -> ComposedProjection`` with origin
  attribution, plus an orphan-suppression rule:

  * **both present**  → enrichment fields override source fields;
    tags union; ``origin='hybrid'``.
  * **source only**   → source fields verbatim; ``origin='source'``.
  * **enrichment only** → enrichment fields verbatim; ``origin='enrichment'``.
  * **enrichment marked deleted** → suppressed entirely (don't return
    a row at all; the enrichment was a tombstone).

  Edge orphan rule: an edge whose endpoint URNs aren't present in the
  composed node map is dropped (a dangling edge). Flagged with
  ``DROPPED_DANGLING`` in the diagnostic counts so the caller can
  surface "12 edges hidden — fix upstream lineage" in the UI.

Pure: no DB, no async, no I/O. Unit-testable by direct construction
of the input dicts.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


# ── input projections ──────────────────────────────────────────────


@dataclass(frozen=True)
class SourceNodeProjection:
    """Subset of GraphSourceNodeORM that composition cares about."""

    urn: str
    entity_type: str | None
    display_name: str | None
    position: Mapping | None
    properties: Mapping
    tags: tuple[str, ...]


@dataclass(frozen=True)
class SourceEdgeProjection:
    urn: str
    source_urn: str
    target_urn: str
    edge_type: str | None
    properties: Mapping
    tags: tuple[str, ...]


@dataclass(frozen=True)
class EnrichmentNodeProjection:
    """A node from the user's enrichment layer. ``deleted=True`` is a
    tombstone — suppresses the source row entirely."""

    urn: str
    entity_type: str | None
    display_name: str | None
    position: Mapping | None
    properties: Mapping
    tags: tuple[str, ...]
    deleted: bool = False


@dataclass(frozen=True)
class EnrichmentEdgeProjection:
    urn: str
    source_urn: str
    target_urn: str
    edge_type: str | None
    properties: Mapping
    tags: tuple[str, ...]
    deleted: bool = False


# ── output ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ComposedNode:
    urn: str
    entity_type: str | None
    display_name: str | None
    position: Mapping | None
    properties: Mapping
    tags: tuple[str, ...]
    origin: str   # 'source' | 'enrichment' | 'hybrid'


@dataclass(frozen=True)
class ComposedEdge:
    urn: str
    source_urn: str
    target_urn: str
    edge_type: str | None
    properties: Mapping
    tags: tuple[str, ...]
    origin: str


@dataclass(frozen=True)
class CompositionDiagnostics:
    """What composition dropped or suppressed — surfaced to the UI for
    the user to triage."""

    nodes_suppressed_by_enrichment: int = 0
    edges_suppressed_by_enrichment: int = 0
    edges_dropped_dangling: int = 0
    edges_dropped_endpoint_suppressed: int = 0


@dataclass(frozen=True)
class ComposedGraph:
    nodes: dict[str, ComposedNode] = field(default_factory=dict)
    edges: dict[str, ComposedEdge] = field(default_factory=dict)
    diagnostics: CompositionDiagnostics = field(
        default_factory=CompositionDiagnostics
    )


# ── pure compose ───────────────────────────────────────────────────


def _merge_props(src: Mapping, enr: Mapping) -> dict:
    """Enrichment fields override source fields (shallow merge)."""
    out = dict(src)
    out.update(enr)
    return out


def _union_tags(src: tuple[str, ...], enr: tuple[str, ...]) -> tuple[str, ...]:
    """Order-preserving union: source tags first, then enrichment-only
    tags in their original order."""
    seen: set[str] = set(src)
    extra = [t for t in enr if t not in seen]
    return tuple(list(src) + extra)


def compose(
    *,
    source_nodes: Mapping[str, SourceNodeProjection],
    source_edges: Mapping[str, SourceEdgeProjection],
    enrichment_nodes: Mapping[str, EnrichmentNodeProjection],
    enrichment_edges: Mapping[str, EnrichmentEdgeProjection],
) -> ComposedGraph:
    """Compose source + enrichment per the layered-model rules.

    See the module docstring for the four cases. Edges referencing a
    URN absent from the composed node map are dropped (dangling) —
    composition is a *visualisation* concern; the underlying source
    edge row is unchanged so a later re-sync of the source can revive
    it once the endpoint reappears.
    """
    nodes: dict[str, ComposedNode] = {}
    suppressed_nodes = 0

    # Index union of urns from both layers.
    node_urns = set(source_nodes) | set(enrichment_nodes)
    for urn in node_urns:
        src = source_nodes.get(urn)
        enr = enrichment_nodes.get(urn)
        if enr is not None and enr.deleted:
            # Tombstone — suppress entirely (even if source still has it).
            suppressed_nodes += 1
            continue
        if src is not None and enr is not None:
            nodes[urn] = ComposedNode(
                urn=urn,
                entity_type=enr.entity_type or src.entity_type,
                display_name=enr.display_name or src.display_name,
                position=enr.position or src.position,
                properties=_merge_props(src.properties, enr.properties),
                tags=_union_tags(src.tags, enr.tags),
                origin="hybrid",
            )
        elif src is not None:
            nodes[urn] = ComposedNode(
                urn=urn,
                entity_type=src.entity_type,
                display_name=src.display_name,
                position=src.position,
                properties=dict(src.properties),
                tags=tuple(src.tags),
                origin="source",
            )
        else:  # enrichment only (e.g. user-added node)
            nodes[urn] = ComposedNode(
                urn=urn,
                entity_type=enr.entity_type,
                display_name=enr.display_name,
                position=enr.position,
                properties=dict(enr.properties),
                tags=tuple(enr.tags),
                origin="enrichment",
            )

    # Edges — same rules + endpoint-presence guard.
    edges: dict[str, ComposedEdge] = {}
    suppressed_edges = 0
    dangling = 0
    endpoint_suppressed = 0
    composed_node_keys = set(nodes)

    edge_urns = set(source_edges) | set(enrichment_edges)
    for urn in edge_urns:
        src = source_edges.get(urn)
        enr = enrichment_edges.get(urn)
        if enr is not None and enr.deleted:
            suppressed_edges += 1
            continue
        if src is not None and enr is not None:
            ce = ComposedEdge(
                urn=urn,
                source_urn=enr.source_urn or src.source_urn,
                target_urn=enr.target_urn or src.target_urn,
                edge_type=enr.edge_type or src.edge_type,
                properties=_merge_props(src.properties, enr.properties),
                tags=_union_tags(src.tags, enr.tags),
                origin="hybrid",
            )
        elif src is not None:
            ce = ComposedEdge(
                urn=urn,
                source_urn=src.source_urn,
                target_urn=src.target_urn,
                edge_type=src.edge_type,
                properties=dict(src.properties),
                tags=tuple(src.tags),
                origin="source",
            )
        else:
            ce = ComposedEdge(
                urn=urn,
                source_urn=enr.source_urn,
                target_urn=enr.target_urn,
                edge_type=enr.edge_type,
                properties=dict(enr.properties),
                tags=tuple(enr.tags),
                origin="enrichment",
            )

        # Endpoint guard. Track endpoint_suppressed (an endpoint was
        # in the input but got tombstoned) separately from dangling
        # (endpoint never existed in any layer). The diagnostic split
        # gives the user actionable feedback. If ONE endpoint is
        # tombstoned and the other never existed, classify as
        # dangling — the missing endpoint is the dominant cause.
        src_present = ce.source_urn in composed_node_keys
        tgt_present = ce.target_urn in composed_node_keys
        if not (src_present and tgt_present):
            input_node_urns = set(source_nodes) | set(enrichment_nodes)
            missing_endpoints = (
                ([ce.source_urn] if not src_present else [])
                + ([ce.target_urn] if not tgt_present else [])
            )
            all_missing_were_tombstoned = all(
                m in input_node_urns for m in missing_endpoints
            )
            if all_missing_were_tombstoned:
                endpoint_suppressed += 1
            else:
                dangling += 1
            continue
        edges[urn] = ce

    return ComposedGraph(
        nodes=nodes,
        edges=edges,
        diagnostics=CompositionDiagnostics(
            nodes_suppressed_by_enrichment=suppressed_nodes,
            edges_suppressed_by_enrichment=suppressed_edges,
            edges_dropped_dangling=dangling,
            edges_dropped_endpoint_suppressed=endpoint_suppressed,
        ),
    )


__all__ = [
    "SourceNodeProjection",
    "SourceEdgeProjection",
    "EnrichmentNodeProjection",
    "EnrichmentEdgeProjection",
    "ComposedNode",
    "ComposedEdge",
    "ComposedGraph",
    "CompositionDiagnostics",
    "compose",
]
