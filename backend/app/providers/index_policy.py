"""FalkorDB index policy — the single source of truth for WHICH labels and
properties ``ensure_indices`` creates indexes on.

Shared between the provider (which executes the DDL) and the
alignment-analysis endpoint (which PREDICTS query performance from cached
profiling data): a physical label is index-backed iff it appears in
``indexed_labels(...)`` — case-sensitively, because FalkorDB labels are.
Keeping both consumers on one module means the analysis can never silently
drift from what the provider actually indexes.
"""
from __future__ import annotations

from typing import Iterable, List, NamedTuple, Optional, Tuple

# Platform built-in labels every graph gets indexed regardless of ontology.
DEFAULT_INDEX_LABELS: List[str] = [
    "domain",
    "dataPlatform",
    "container",
    "dataset",
    "schemaField",
]

# `level` indexed for trace queries that filter by hierarchy level
# (Cypher: WHERE n.level = $level).
# `layerAssignment` indexed for the by-layer listing (Cypher:
# WHERE n.layerAssignment = $lid). NOTE: FalkorDB indexes are label-scoped,
# so the index only serves label-anchored matches — get_nodes_by_layer takes
# a CALL { MATCH (n:<label>) ... } UNION form over indexed_labels(...) for
# exactly this reason; a bare MATCH (n) cannot use it.
INDEXED_NODE_PROPS: List[str] = ["urn", "displayName", "qualifiedName", "level", "layerAssignment"]


def indexed_labels(entity_type_ids: Optional[Iterable[str]] = None) -> List[str]:
    """The exact, deduplicated, order-preserving label list ``ensure_indices``
    indexes: platform defaults first, then the ontology's declared entity
    type ids (their DECLARED spelling — a case-drifted physical label is by
    construction not in this list, so queries against it label-scan)."""
    extra = list(entity_type_ids) if entity_type_ids else []
    seen: set[str] = set()
    labels: List[str] = []
    for lbl in DEFAULT_INDEX_LABELS + extra:
        if lbl not in seen:
            seen.add(lbl)
            labels.append(lbl)
    return labels


# ── Edge indexes on :AGGREGATED ──────────────────────────────────────────
#
# A FalkorDB edge index is reachable ONLY when the relationship is the plan's
# ENTRY POINT — an unanchored ``MATCH ()-[r:T]->() WHERE r.p = $v``. Anchor a
# node first (``WHERE f.urn IN $frontier``, then traverse) and the planner
# seeks the NODE index and reads the edge property off the edge it already
# holds; the edge index cannot apply and costs a document per edge for
# nothing — in memory, on every write, and again on every load, because
# indexes are rebuilt from scratch when a graph is read back off disk.
#
# So every entry below names the query shape that ENTERS through it. An index
# that cannot name one does not belong here. "The DDL was accepted" is not a
# justification: that is how the four retired below came to exist.


class EdgeIndex(NamedTuple):
    """One declared edge index and the query that justifies it."""
    rel: str
    props: Tuple[str, ...]
    #: The query shape that enters through this index. Load-bearing: it is
    #: what a plan check asserts against, and what a reviewer weighs.
    entered_by: str

    @property
    def ddl(self) -> str:
        cols = ", ".join(f"r.{p}" for p in self.props)
        return f"CREATE INDEX FOR ()-[r:{self.rel}]-() ON ({cols})"

    def drop_ddl(self, *, legacy: bool = False) -> str:
        cols = ", ".join(f"r.{p}" for p in self.props)
        if legacy:                       # RedisGraph-era spelling
            return f"DROP INDEX ON :{self.rel}({', '.join(self.props)})"
        return f"DROP INDEX FOR ()-[r:{self.rel}]-() ON ({cols})"


AGGREGATED_EDGE_INDEXES: Tuple[EdgeIndex, ...] = (
    EdgeIndex(
        rel="AGGREGATED", props=("aggKey",),
        entered_by=(
            "MATCH ()-[r:AGGREGATED {aggKey: $k}]->() ... DELETE r — the "
            "reconcile phase's keyed delete and its lookup pass. Unanchored: "
            "the relationship IS the entry point, so this one is genuinely "
            "sought. Without it each keyed delete scans the whole cube."
        ),
    ),
)

#: Indexes this product used to create and no longer declares. Kept BY NAME so
#: the cleanup path knows what is ours to remove — a graph carries them until
#: something drops them, because nothing in Redis expires an index.
#:
#: All four are single-column, and every predicate on these properties anywhere
#: in this codebase is a PAIR (``r.sourceDepth = $d AND r.targetDepth = $d``).
#: No query filters on one of them alone, so no plan can enter through a
#: single-column index on it — whether or not a composite would also serve a
#: prefix seek. They were added as a fallback "if the planner does not support
#: composite edge indexes", but no fallback was ever implemented: the composite
#: and both singles were created unconditionally, every run, forever.
RETIRED_EDGE_INDEXES: Tuple[EdgeIndex, ...] = (
    EdgeIndex(rel="AGGREGATED", props=("sourceLevel",), entered_by="none — retired"),
    EdgeIndex(rel="AGGREGATED", props=("targetLevel",), entered_by="none — retired"),
    EdgeIndex(rel="AGGREGATED", props=("sourceDepth",), entered_by="none — retired"),
    EdgeIndex(rel="AGGREGATED", props=("targetDepth",), entered_by="none — retired"),
)

#: The two composites. Reachable ONLY through the unlabelled frontier bucket in
#: ``_build`` — ``MATCH (f)-[r:AGGREGATED]->(other) WHERE f.urn IN $frontier
#: AND r.sourceDepth = $d AND r.targetDepth = $d`` — where ``f`` carries no
#: label and FalkorDB has no label-less node index to offer (see
#: ``ensure_projections``: a property-only index is unsupported on every
#: build). There the planner's only alternative is an AllNodeScan, so the edge
#: index may genuinely win.
#:
#: Declared, therefore, but conditionally: they are the ONE thing here that
#: needs a PROFILE against a real cluster to settle. If the frontier is made
#: reliably label-anchored, this bucket disappears and so does their
#: justification — which is the better fix, and would take :AGGREGATED from
#: seven indexes to one.
CONDITIONAL_EDGE_INDEXES: Tuple[EdgeIndex, ...] = (
    EdgeIndex(
        rel="AGGREGATED", props=("sourceLevel", "targetLevel"),
        entered_by=(
            "MATCH (f)-[r:AGGREGATED]->(other) WHERE f.urn IN $frontier AND "
            "r.sourceLevel = $level AND r.targetLevel = $level — the UNLABELLED "
            "frontier bucket only. Every labelled bucket seeks the per-label "
            "urn index instead and never touches this."
        ),
    ),
    EdgeIndex(
        rel="AGGREGATED", props=("sourceDepth", "targetDepth"),
        entered_by=(
            "MATCH (f)-[r:AGGREGATED]->(other) WHERE f.urn IN $frontier AND "
            "r.sourceDepth = $d AND r.targetDepth = $d — the UNLABELLED "
            "frontier bucket only, as above."
        ),
    ),
)


def declared_edge_indexes() -> Tuple[EdgeIndex, ...]:
    """Every edge index this product creates today."""
    return AGGREGATED_EDGE_INDEXES + CONDITIONAL_EDGE_INDEXES


def edge_index_ddl() -> List[str]:
    """The CREATE statements, in declaration order."""
    return [ix.ddl for ix in declared_edge_indexes()]
