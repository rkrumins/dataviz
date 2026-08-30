"""Closure-walk tuning constants and per-request walk state.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (constants lines 159-178, ``_ClosureWalk`` lines
762-800, as of the package move). ``ClosureMixin`` (the methods that use
these) lands in a later task; this module exists now so both this task's
imports and that later mixin agree on where they live.
"""
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Set, Tuple

from backend.app.models.graph import GraphEdge

# How many closure-frontier candidates get a real degree probe. Every boundary
# node the walk did not finish is a candidate, and they all share ONE
# `get_node_degrees` wave — so a hub-heavy closure could otherwise turn its
# "what did I miss?" epilogue into the most expensive part of the request.
# Past the cap the entries still ship, with totalCount None ("there is more,
# we don't know how much"), which is what an unprobed frontier honestly is.
CLOSURE_FRONTIER_PROBE_CAP = int(os.getenv("CLOSURE_FRONTIER_PROBE_CAP", "1000"))

# The degree-exact closure walk (``trace_closure`` / ``_walk_anchors``):
#   CLOSURE_WALK_SLICE — anchors whose degrees are read in one wave before the
#       budget decides how many of them fit; bounded so a huge ring never
#       turns the probe into the expensive part of the request.
#   CLOSURE_QUERY_CAP_SECS — the per-query ceiling. Every walk query is bounded
#       by the REQUEST deadline (minus a reserve for hydration), capped here;
#       the old flat 1.5 s clamp silently dropped rows on wide estates.
#   CLOSURE_WALK_RESERVE_FRACTION — the share of the request budget kept back
#       for hydration/containment after the walk stops.
CLOSURE_WALK_SLICE = int(os.getenv("CLOSURE_WALK_SLICE", "500"))
CLOSURE_QUERY_CAP_SECS = float(os.getenv("CLOSURE_QUERY_CAP_SECS", "10.0"))
CLOSURE_WALK_RESERVE_FRACTION = 0.2


@dataclass
class _ClosureWalk:
    """Mutable state of one ``trace_closure`` request's degree-exact walk —
    what the old loop kept as a dozen locals, shared with the helpers that
    now do the walking. ``reasons`` collects every truncation cause in the
    order it happened; the response reports the most severe."""
    ltypes: List[str]
    max_nodes: int
    deadline: float
    walk_deadline: float
    excluded: Set[str]
    visited: Set[str]
    discovered: Set[str]
    edges_by_id: Dict[str, GraphEdge] = field(default_factory=dict)
    upstream_urns: Set[str] = field(default_factory=set)
    downstream_urns: Set[str] = field(default_factory=set)
    cut_up: Dict[str, None] = field(default_factory=dict)
    cut_down: Dict[str, None] = field(default_factory=dict)
    degrees: Dict[str, Tuple[int, int]] = field(default_factory=dict)     # urn -> (in, out)
    paged: Dict[Tuple[str, str], str] = field(default_factory=dict)       # (urn, "up"|"down") -> "e:<n>"
    reasons: List[str] = field(default_factory=list)
    labels: Dict[str, str] = field(default_factory=dict)
    ring_up: List[Tuple[str, str]] = field(default_factory=list)          # partners found this hop
    ring_down: List[Tuple[str, str]] = field(default_factory=list)
    progress: int = 0                                                     # anchors walked this request

    def query_timeout(self) -> float:
        return max(0.6, min(CLOSURE_QUERY_CAP_SECS, self.walk_deadline - time.monotonic()))

    def record_edge(self, rec: Dict[str, Any]) -> None:
        eid = rec["edgeId"]
        if eid not in self.edges_by_id:
            self.edges_by_id[eid] = GraphEdge(
                id=eid,
                sourceUrn=rec["sourceUrn"],
                targetUrn=rec["targetUrn"],
                edgeType=rec["edgeType"],
                properties={},
            )
