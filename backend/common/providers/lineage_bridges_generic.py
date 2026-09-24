"""Lineage-bridges callbacks for any provider that can list edges.

The walker (``lineage_bridges.py``) needs four reads. FalkorDB answers them
with tuned, index-seeking queries (``backend/app/providers/falkordb_bridges.py``);
everything else — Neo4j, Spanner, a draft overlay, a versioned branch — answers
them here, from ``get_edges`` alone:

* ``region_seeds``  a containment walk DOWN from every inheriting member,
                    stopping at other members (each enumerates its own region)
                    and never entering one that does not inherit. Every region
                    node counts as a seed — without a degree read there is no
                    cheap way to know which carry lineage, and a node that
                    carries none simply expands to nothing;
* ``expand``        ``get_edges`` anchored on the frontier, source or target;
* ``degrees``       not offered: the walker reads in chunks and treats a chunk
                    that fills its limit as not read whole;
* ``ancestor_chains`` / ``hydrate`` — when the provider has them.

A draft overlay's ``get_edges`` is the main graph plus the draft's own changes,
so bridges computed here see a hop the draft created or removed — which the
closure's draft overlay, that never re-walks, does not.

It is a free-standing class rather than a default method on
``GraphDataProvider`` because the draft and versioned-branch readers do not
subclass that interface.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from backend.common.models.graph import EdgeQuery, GraphNode, NodeQuery
from backend.common.providers.lineage_bridges import ExpandPage, Hop, RegionSeeds

logger = logging.getLogger(__name__)

#: Nodes per containment/lineage read, and the deepest containment walked.
CHUNK = 200
MAX_CONTAINMENT_DEPTH = 16


class GenericBridgeCallbacks:
    supports_degrees = False

    def __init__(
        self,
        provider: Any,
        lineage_edge_types: Sequence[str],
        containment_edge_types: Sequence[str],
    ) -> None:
        self._p = provider
        self._ltypes = [t for t in (lineage_edge_types or []) if t]
        self._ctypes = [t for t in (containment_edge_types or []) if t]

    async def region_seeds(
        self, members: Mapping[str, bool], *, cap: int, timeout: float,
    ) -> RegionSeeds:
        owner: Dict[str, str] = {m: m for m in members}
        if not self._ctypes:
            return RegionSeeds(owner=owner, complete=True)
        seen: Set[str] = set(members)
        frontier: List[Tuple[str, str]] = [(m, m) for m in sorted(members) if members[m]]
        beneath = 0
        for _ in range(MAX_CONTAINMENT_DEPTH):
            if not frontier:
                return RegionSeeds(owner=owner, complete=True)
            parents = dict(frontier)
            nxt: List[Tuple[str, str]] = []
            for chunk in _chunks(sorted(parents), CHUNK):
                limit = cap - beneath + 1
                try:
                    edges = await asyncio.wait_for(self._p.get_edges(EdgeQuery(
                        sourceUrns=list(chunk), edgeTypes=self._ctypes, limit=limit,
                    )), timeout=timeout)
                except Exception as exc:
                    logger.warning("lineage_bridges (generic): containment read failed: %s", exc)
                    return RegionSeeds(owner=owner, complete=False, failed=True)
                for edge in sorted(edges, key=lambda e: (e.source_urn, e.target_urn)):
                    child = edge.target_urn
                    if child in seen or edge.source_urn not in parents:
                        continue
                    seen.add(child)
                    if beneath >= cap:
                        return RegionSeeds(owner=owner, complete=False)
                    owner[child] = parents[edge.source_urn]
                    beneath += 1
                    nxt.append((child, parents[edge.source_urn]))
                if len(edges) >= limit:
                    return RegionSeeds(owner=owner, complete=False)
            frontier = nxt
        return RegionSeeds(owner=owner, complete=not frontier)

    async def degrees(self, nodes, *, incoming: bool, timeout: float) -> Optional[Dict[str, int]]:
        return None

    async def expand(
        self, nodes: Sequence[Tuple[str, str]], *, incoming: bool, limit: int, timeout: float,
    ) -> ExpandPage:
        urns = [urn for urn, _ in nodes]
        query = (
            EdgeQuery(targetUrns=urns, edgeTypes=self._ltypes, limit=limit)
            if incoming else
            EdgeQuery(sourceUrns=urns, edgeTypes=self._ltypes, limit=limit)
        )
        try:
            edges = await asyncio.wait_for(self._p.get_edges(query), timeout=timeout)
        except Exception as exc:
            logger.warning("lineage_bridges (generic): lineage read failed: %s", exc)
            return ExpandPage(failed=set(urns))
        return ExpandPage(hops=[
            Hop(
                source=e.source_urn,
                target=e.target_urn,
                other=e.source_urn if incoming else e.target_urn,
                edge_id=str(e.id or ""),
                edge_type=str(e.edge_type or ""),
            )
            for e in edges
        ])

    async def ancestor_chains(
        self, urns: Sequence[str], *, timeout: float,
    ) -> Optional[Dict[str, List[str]]]:
        fn = getattr(self._p, "get_ancestor_chains", None)
        if not callable(fn):
            return None
        try:
            return await asyncio.wait_for(fn(list(urns)), timeout=timeout)
        except Exception as exc:
            logger.warning("lineage_bridges (generic): ancestor chains failed: %s", exc)
            return None

    async def hydrate(self, urns: Sequence[str], *, timeout: float) -> List[GraphNode]:
        batch = getattr(self._p, "get_nodes_batch", None)
        out: List[GraphNode] = []
        for chunk in _chunks(list(urns), CHUNK):
            if callable(batch):
                got = await asyncio.wait_for(batch(list(chunk)), timeout=timeout)
            else:
                got = await asyncio.wait_for(
                    self._p.get_nodes(NodeQuery(urns=list(chunk), limit=len(chunk))), timeout=timeout,
                )
            out.extend(n for n in got if n is not None)
        return out


def _chunks(items: Sequence, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]
