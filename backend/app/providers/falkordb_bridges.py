"""FalkorDB callbacks for the lineage-bridges walker.

The walker (``backend/common/providers/lineage_bridges.py``) owns the
algorithm; this module is how FalkorDB answers its four questions, and it
answers them with the closure walk's own index-seeking reads so the two walks
cost the same per row:

* ``region_seeds``    which lineage-bearing nodes each member owns — the
                      members' own nodes from one degree read, their contents
                      from ``_member_region_pairs`` (a sibling of
                      ``_descendant_lineage_seed`` that also says WHICH member
                      each descendant sits under, so ownership needs no
                      per-node chain lookup);
* ``degrees``         ``_lineage_degrees``;
* ``expand``          ``_expand_raw_lineage_set`` — which names its failed label
                      buckets, so a failed read is a cut, never an empty answer;
* ``ancestor_chains`` / ``hydrate`` — the cached chain read and the batched node
                      fetch every trace already uses.

Relationship types arrive uppercased from the engine and are case-aligned to
this graph's own spelling here, exactly as ``trace_closure`` does, because the
``[:TYPE]`` patterns are case-sensitive.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from backend.common.models.graph import GraphNode
from backend.common.providers.lineage_bridges import ExpandPage, Hop, RegionSeeds

if TYPE_CHECKING:  # pragma: no cover
    from .falkordb_provider import FalkorDBProvider

logger = logging.getLogger(__name__)

#: Rows per region-enumeration page. Larger than any member nesting depth, so a
#: page trimmed back to whole descendants always makes progress.
REGION_PAGE_ROWS = 5000


class FalkorBridgeCallbacks:
    supports_degrees = True

    def __init__(
        self,
        provider: "FalkorDBProvider",
        lineage_edge_types: Sequence[str],
        containment_edge_types: Sequence[str],
    ) -> None:
        self._p = provider
        ltypes = [t.upper() for t in (lineage_edge_types or []) if t]
        ctypes = [t.upper() for t in (containment_edge_types or []) if t]
        self._ltypes: List[str] = list(provider._alias_rel_types(ltypes)) if ltypes else []
        self._ctypes: List[str] = list(provider._alias_rel_types(ctypes)) if ctypes else []

    # -- seeds ------------------------------------------------------------

    async def region_seeds(
        self, members: Mapping[str, bool], *, cap: int, timeout: float,
    ) -> RegionSeeds:
        roots = sorted(members)
        if not roots or not self._ltypes:
            return RegionSeeds()
        labels: Dict[str, Optional[str]] = await self._p._resolve_urn_labels_bulk(roots)

        # 1. The members' own nodes that carry lineage — never capped.
        anchors = [(u, labels.get(u) or "") for u in roots]
        degrees = await self._p._lineage_degrees(
            anchors, self._ltypes, up=True, down=True, timeout=timeout,
        )
        if degrees is None:
            return RegionSeeds(complete=False, failed=True)
        owner: Dict[str, str] = {u: u for u, (i, o) in degrees.items() if i + o > 0}
        seed_labels: Dict[str, str] = {u: labels.get(u) or "" for u in owner}
        if not self._ctypes:
            return RegionSeeds(owner=owner, labels=seed_labels, complete=True)

        # 2. The member forest: how deep each member sits among the others, so
        #    a node under two members is owned by the deeper one.
        try:
            chains = await asyncio.wait_for(
                self._p._compute_and_store_ancestors_bulk(roots), timeout=timeout,
            )
        except Exception as exc:
            logger.warning("lineage_bridges: member chains failed: %s", exc)
            return RegionSeeds(owner=owner, labels=seed_labels, complete=False, failed=True)
        depth = {m: sum(1 for a in chains.get(m) or [] if a in members) for m in roots}

        # 3. Whose contents to enumerate: every inheriting member, plus every
        #    non-inheriting one with an inheriting member above it — that one
        #    BLOCKS, and its rows are how a node under it is known to belong to
        #    nobody rather than to the member above.
        query_roots = [
            m for m in roots
            if members[m] or any(members.get(a) for a in chains.get(m) or [] if a in members)
        ]
        pairs, complete, failed = await self._member_region_pairs(
            query_roots, labels, cap=cap, timeout=timeout,
        )
        for urn, (candidates, label) in pairs.items():
            if urn in members:
                continue                        # a member owns itself (step 1)
            deepest = max(candidates, key=lambda r: (depth.get(r, 0), r))
            if members.get(deepest):
                owner[urn] = deepest
                seed_labels[urn] = label
        return RegionSeeds(
            owner=owner, labels=seed_labels, complete=complete and not failed, failed=failed,
        )

    async def _member_region_pairs(
        self,
        roots: Sequence[str],
        labels: Mapping[str, Optional[str]],
        *,
        cap: int,
        timeout: float,
    ) -> Tuple[Dict[str, Tuple[Set[str], str]], bool, bool]:
        """``descendant -> ({member roots above it}, label)`` for every
        lineage-bearing descendant of ``roots``, up to ``cap`` rows.

        One label-qualified, keyset-paged query per root label bucket (there is
        no label-less URN index). A page is ``ORDER BY urn`` and TRIMMED back to
        whole descendants before the next one starts at the trimmed urn, so a
        descendant's root rows never straddle two pages. Returns
        ``(pairs, complete, failed)``."""
        from .falkordb_provider import _sanitize_label

        pairs: Dict[str, Tuple[Set[str], str]] = {}
        if not roots:
            return pairs, True, False
        rel_alt = "|".join(_sanitize_label(t) for t in self._ltypes)
        ct_alt = "|".join(_sanitize_label(t) for t in self._ctypes)
        hops = self._p._containment_hop_bound()
        by_label: Dict[str, List[str]] = {}
        for urn in roots:
            by_label.setdefault(labels.get(urn) or "", []).append(urn)

        rows_total = 0
        complete = True
        for label, bucket in sorted(by_label.items()):
            sl = _sanitize_label(label) if label else ""
            label_clause = f":{sl}" if sl else ""
            after: Optional[str] = None
            while True:
                room = cap - rows_total
                if room <= 0:
                    return pairs, False, False
                page_rows = min(REGION_PAGE_ROWS, room + 1)
                after_clause = "AND d.urn >= $after " if after is not None else ""
                cypher = (
                    f"MATCH (f{label_clause})-[:{ct_alt}*1..{hops}]->(d) "
                    f"WHERE f.urn IN $roots AND (d)-[:{rel_alt}]-() {after_clause}"
                    "RETURN DISTINCT f.urn AS root, d.urn AS urn, labels(d)[0] AS label "
                    "ORDER BY urn, root LIMIT $cap"
                )
                params: Dict[str, Any] = {"roots": bucket, "cap": page_rows}
                if after is not None:
                    params["after"] = after
                try:
                    result = await self._p._ro_query(
                        cypher, params=params, timeout=max(0.6, timeout), op="bridges.region",
                    )
                except Exception as exc:
                    logger.warning("lineage_bridges: region enumeration failed: %s", exc)
                    return pairs, False, True
                rows = [r for r in (result.result_set or []) if r and r[1]]
                full = len(rows) >= page_rows
                if full:
                    last = str(rows[-1][1])
                    trimmed = [r for r in rows if str(r[1]) != last]
                    if not trimmed:
                        # One descendant under more roots than a page holds:
                        # cannot happen at any real nesting depth; stop honestly.
                        return pairs, False, False
                    rows = trimmed
                for root, urn, lbl in (r[:3] for r in rows):
                    entry = pairs.get(str(urn))
                    if entry is None:
                        entry = (set(), str(lbl or ""))
                        pairs[str(urn)] = entry
                    entry[0].add(str(root))
                rows_total += len(rows)
                if not full:
                    break
                after = last
                if rows_total >= cap:
                    complete = False
                    break
        return pairs, complete, False

    # -- the walk ---------------------------------------------------------

    async def degrees(
        self, nodes: Sequence[Tuple[str, str]], *, incoming: bool, timeout: float,
    ) -> Optional[Dict[str, int]]:
        got = await self._p._lineage_degrees(
            list(nodes), self._ltypes, up=incoming, down=not incoming, timeout=timeout,
        )
        if got is None:
            return None
        return {urn: (io[0] if incoming else io[1]) for urn, io in got.items()}

    async def expand(
        self, nodes: Sequence[Tuple[str, str]], *, incoming: bool, limit: int, timeout: float,
    ) -> ExpandPage:
        labels = {urn: label or "" for urn, label in nodes}
        rows, failed_labels = await self._p._expand_raw_lineage_set(
            [urn for urn, _ in nodes], labels,
            "incoming" if incoming else "outgoing",
            self._ltypes, limit, timeout,
        )
        return ExpandPage(
            hops=[
                Hop(
                    source=str(r["sourceUrn"]),
                    target=str(r["targetUrn"]),
                    other=str(r["otherUrn"]),
                    other_label=str(r.get("otherLabel") or ""),
                    edge_id=str(r.get("edgeId") or ""),
                    edge_type=str(r.get("edgeType") or ""),
                )
                for r in rows if r.get("otherUrn")
            ],
            failed={urn for urn, label in labels.items() if label in failed_labels},
        )

    async def ancestor_chains(
        self, urns: Sequence[str], *, timeout: float,
    ) -> Optional[Dict[str, List[str]]]:
        try:
            return await asyncio.wait_for(
                self._p._compute_and_store_ancestors_bulk(list(urns)), timeout=timeout,
            )
        except Exception as exc:
            logger.warning("lineage_bridges: ancestor chains failed: %s", exc)
            return None

    async def hydrate(self, urns: Sequence[str], *, timeout: float) -> List[GraphNode]:
        if not urns:
            return []
        return await asyncio.wait_for(self._p.get_nodes_batch(list(urns)), timeout=timeout)
