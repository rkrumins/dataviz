"""Batched canvas contract (WS5).

The Context View canvas used to open by firing a storm of independent
requests — top-level nodes, then per-visible-set `/edges/aggregated`
(observed 7+ per settle), `/edges/between`, `/assignments/compute`,
children on every expand — which queued on the browser's 6 HTTP/1.1
connections and, over real network RTT, summed to the 15s+ perceived
load. These two endpoints collapse a canvas gesture into ONE request
each:

* ``POST /canvas/bootstrap`` — everything needed to paint the initial
  canvas: the root page (+ childCounts), the edges among those roots,
  and the aggregated lineage among them, plus a freshness/regime block
  and the provider-health signal.
* ``POST /canvas/expand`` — one container expand: its children page
  (+ edges) and the aggregated-edge DELTA touching those new children.

They compose the SAME engine methods the per-purpose endpoints use, so
there is no duplicated query logic; the per-purpose endpoints stay for
non-canvas consumers (drawers, admin, search).
"""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field

from backend.common.models.graph import (
    AggregatedEdgeResult,
    ChildrenWithEdgesResult,
    GraphEdge,
    TopLevelNodesResult,
)


class CanvasFreshness(BaseModel):
    """Freshness/regime block, sourced from the aggregated read's honest
    signals (WS3) so the canvas can show an "updating…" affordance and the
    self-heal state without a second round-trip. Composes with — does not
    replace — the provider-health model (``providerHealth`` below carries
    the 5-signal header verdict)."""
    stale: bool = False
    stale_reason: Optional[str] = Field(None, alias="staleReason")
    stamp_version: Optional[int] = Field(None, alias="stampVersion")
    regime: Optional[str] = None
    last_materialized_at: Optional[str] = Field(None, alias="lastMaterializedAt")
    materialization_triggered: bool = Field(False, alias="materializationTriggered")

    class Config:
        populate_by_name = True

    @classmethod
    def from_aggregated(cls, agg: Optional[AggregatedEdgeResult]) -> "CanvasFreshness":
        if agg is None:
            return cls()
        return cls(
            stale=bool(getattr(agg, "stale", False)),
            staleReason=getattr(agg, "stale_reason", None),
            stampVersion=getattr(agg, "stamp_version", None),
            regime=getattr(agg, "regime", None),
            lastMaterializedAt=getattr(agg, "last_materialized_at", None),
            materializationTriggered=bool(getattr(agg, "materialization_triggered", False)),
        )


class CanvasBootstrapRequest(BaseModel):
    entity_types: Optional[List[str]] = Field(None, alias="entityTypes")
    search_query: Optional[str] = Field(None, alias="searchQuery")
    limit: int = Field(100, ge=1, le=500)
    cursor: Optional[str] = None
    include_aggregated: bool = Field(True, alias="includeAggregated")
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    containment_edge_types: Optional[List[str]] = Field(None, alias="containmentEdgeTypes")

    class Config:
        populate_by_name = True


class CanvasBootstrapResult(BaseModel):
    roots: TopLevelNodesResult
    edges: List[GraphEdge] = Field(default_factory=list)
    aggregated: Optional[AggregatedEdgeResult] = None
    freshness: CanvasFreshness = Field(default_factory=CanvasFreshness)
    provider_health: str = Field("healthy", alias="providerHealth")

    class Config:
        populate_by_name = True


class CanvasExpandRequest(BaseModel):
    parent_urn: str = Field(alias="parentUrn")
    cursor: Optional[str] = None
    limit: int = Field(100, ge=1, le=500)
    # The set already on the canvas (bounded). New children's aggregated
    # edges are resolved against this ∪ the new children. Cap keeps the
    # aggregated leg's URN batch sane.
    visible_urns: List[str] = Field(default_factory=list, alias="visibleUrns", max_length=5000)
    include_aggregated: bool = Field(True, alias="includeAggregated")
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    containment_edge_types: Optional[List[str]] = Field(None, alias="containmentEdgeTypes")

    class Config:
        populate_by_name = True


class CanvasExpandResult(BaseModel):
    children: ChildrenWithEdgesResult
    aggregated_delta: Optional[AggregatedEdgeResult] = Field(None, alias="aggregatedDelta")
    freshness: CanvasFreshness = Field(default_factory=CanvasFreshness)

    class Config:
        populate_by_name = True
