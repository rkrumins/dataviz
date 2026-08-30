"""Closure-walk tuning constants and per-request walk state.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (constants lines 159-178, ``_ClosureWalk`` lines
762-800, as of the package move).

``ClosureMixin`` is carved from ``backend/app/providers/falkordb/provider.py``'s
``FalkorDBProvider`` class body as it stood before this split:
``_lineage_degrees`` through ``_page_raw_lineage_single`` (lines
2094-2843), a single contiguous block — the "Degree-exact closure
walk" section-banner comment moved with the method it heads.

This is the walk *engine* that ``TraceMixin``'s ``trace_closure`` /
``trace_closure_coarse`` (``backend/app/providers/falkordb/trace.py``)
call; the entry points stayed there because that split is the plan's.
See ``docs/superpowers/plans/2026-08-30-pr1-falkordb-decoupling.md`` §2.2 for why this
has to be a mixin rather than a delegate/helper object.
"""
import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from backend.app.models.graph import GraphEdge
from backend.app.providers.falkordb._log import logger
from backend.app.providers.falkordb.rowmap import _sanitize_label

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


class ClosureMixin:
    """The degree-exact closure walk: per-anchor degree probing, prefix
    fitting against the request budget, raw-lineage seeding/paging, and
    the hub-cursor fallback. Called by ``TraceMixin.trace_closure`` /
    ``trace_closure_coarse``."""

    # ── Degree-exact closure walk ──────────────────────────────────────────
    #
    # ``trace_closure`` used to expand each BFS ring under ONE row LIMIT shared
    # by both directions (``max_nodes - discovered`` per label bucket). On a
    # wide container that LIMIT was the whole story: a 2,935-column table got
    # 1,014 of its 17,567 hop-1 edges, one direction starved the other
    # (984 upstream partners, 15 downstream), every seed in the ring was
    # re-offered as an ``e:0`` cursor, and the client re-walked the same rows
    # page after page. The walk below never asks for a row it cannot ship:
    # it reads each anchor's degrees first, walks the longest prefix of
    # anchors whose (node + degree) estimate fits the remaining budget, and
    # asks the database for exactly those rows (``LIMIT sum(degree) + 1`` — the
    # extra row is a concurrent-write tripwire). An anchor that is walked is
    # COMPLETE in every requested direction; an anchor that does not fit is
    # either the next page's first anchor (keyset mode) or a cursor-less
    # frontier entry (ring mode), and a hub that cannot fit any page is paged
    # by edge id with a REAL cursor. ``e:0`` is never minted.

    async def _lineage_degrees(
        self,
        anchors: List[Tuple[str, str]],
        ltypes: List[str],
        *,
        up: bool,
        down: bool,
        timeout: float,
    ) -> Optional[Dict[str, Tuple[int, int]]]:
        """``urn -> (in, out)`` raw-lineage degree for the given anchors, one
        index-seeking query per label bucket per requested direction.
        Labels come with the anchors (the seed/expansion rows carry
        ``labels(x)[0]``), so no URN→label round trip is paid here. Returns
        None when ANY bucket failed — the caller treats that as "cannot
        estimate", never as zero. A direction that was not requested is
        reported as 0 (it is never walked)."""
        if not anchors:
            return {}
        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        by_label: Dict[str, List[str]] = {}
        for urn, label in anchors:
            by_label.setdefault(label or "", []).append(urn)

        queries: List[Tuple[str, str, List[str]]] = []
        for label, urns in by_label.items():
            sl = _sanitize_label(label) if label else ""
            lbl = f":{sl}" if sl else ""
            if up:
                queries.append((
                    "in",
                    f"MATCH (n{lbl})<-[r:{rel_alt}]-() WHERE n.urn IN $urns "
                    "RETURN n.urn AS urn, count(r) AS degree",
                    urns,
                ))
            if down:
                queries.append((
                    "out",
                    f"MATCH (n{lbl})-[r:{rel_alt}]->() WHERE n.urn IN $urns "
                    "RETURN n.urn AS urn, count(r) AS degree",
                    urns,
                ))

        async def _run(cypher: str, urns: List[str]):
            return await self._ro_query(
                cypher, params={"urns": urns}, timeout=timeout, op="trace.closure_degrees",
            )

        try:
            results = await asyncio.gather(*(_run(c, u) for _, c, u in queries))
        except Exception as exc:
            logger.warning("trace_closure: degree read failed for %d anchors: %s", len(anchors), exc)
            return None

        out: Dict[str, List[int]] = {urn: [0, 0] for urn, _ in anchors}
        for (direction, _c, _u), result in zip(queries, results):
            for row in (result.result_set or []):
                urn = str(row[0])
                if urn in out:
                    out[urn][0 if direction == "in" else 1] = int(row[1] or 0)
        return {urn: (io[0], io[1]) for urn, io in out.items()}

    async def _walk_anchors(
        self,
        anchors: List[Tuple[str, str]],
        st: "_ClosureWalk",
        *,
        up: bool,
        down: bool,
        budget: int,
        keyset: bool,
        first_of_page: bool,
    ) -> int:
        """Walk ``anchors`` (urn-sorted ``(urn, label)`` pairs) one hop in the
        requested directions under ``budget`` new nodes. Returns the index of
        the first anchor NOT walked (``len(anchors)`` when all were).

        Every walked anchor is complete in each requested direction (I1).
        An anchor that does not fit: in ``keyset`` mode it ends the page and
        becomes the caller's cursor; otherwise it is filed as a cursor-less
        cut entry and skipped, so a hub never starves the rest of its ring.
        A non-fitting anchor at the very start of a page (``first_of_page``
        and nothing walked yet) is a hub that no page could hold: it is paged
        by edge id per direction and carries a REAL ``e:<n>`` cursor for any
        direction that filled its page.
        """
        n = len(anchors)
        idx = 0
        while idx < n:
            if budget <= 0:
                if keyset:
                    return idx
                self._file_cut(st, anchors[idx:], up=up, down=down)
                return n
            if time.monotonic() >= st.walk_deadline:
                st.reasons.append("timeout")
                if keyset:
                    return idx
                self._file_cut(st, anchors[idx:], up=up, down=down)
                return n

            chunk = anchors[idx: idx + CLOSURE_WALK_SLICE]
            need = [a for a in chunk if a[0] not in st.degrees]
            if need:
                deg = await self._lineage_degrees(
                    need, st.ltypes, up=up, down=down, timeout=st.query_timeout(),
                )
                if deg is None:
                    st.reasons.append("timeout")
                    if keyset:
                        return idx
                    self._file_cut(st, chunk, up=up, down=down)
                    idx += len(chunk)
                    continue
                st.degrees.update(deg)

            pos = 0
            while pos < len(chunk):
                if budget <= 0 or time.monotonic() >= st.walk_deadline:
                    break
                # The longest prefix whose estimate fits.
                prefix: List[Tuple[str, str]] = []
                est_sum = 0
                j = pos
                while j < len(chunk):
                    e = self._walk_estimate(chunk[j][0], st, up=up, down=down)
                    if est_sum + e > budget:
                        break
                    prefix.append(chunk[j])
                    est_sum += e
                    j += 1
                if not prefix:
                    anchor = chunk[pos]
                    if first_of_page and st.progress == 0:
                        spent = await self._hub_page(anchor, st, up=up, down=down, budget=budget)
                        budget -= spent
                        pos += 1
                        continue
                    if keyset:
                        return idx + pos
                    self._file_cut(st, [anchor], up=up, down=down)
                    pos += 1
                    continue
                spent = await self._expand_prefix(prefix, st, up=up, down=down)
                budget -= spent
                pos = j
            if pos < len(chunk):
                # Budget or deadline ended the chunk mid-way.
                if keyset:
                    return idx + pos
                if time.monotonic() >= st.walk_deadline:
                    st.reasons.append("timeout")
                self._file_cut(st, chunk[pos:], up=up, down=down)
            idx += len(chunk)
        return n

    def _walk_estimate(self, urn: str, st: "_ClosureWalk", *, up: bool, down: bool) -> int:
        d_in, d_out = st.degrees.get(urn, (0, 0))
        return (0 if urn in st.discovered else 1) + (d_in if up else 0) + (d_out if down else 0)

    def _file_cut(
        self, st: "_ClosureWalk", anchors: List[Tuple[str, str]], *, up: bool, down: bool,
    ) -> None:
        """An anchor the walk could not afford (or could not read): a
        cursor-less frontier entry in each requested direction. It is still
        shipped when it was already discovered; a never-discovered anchor
        (an explicit seed) is added to ``discovered`` so the client can stamp
        the entry — the client holds it anyway."""
        for urn, label in anchors:
            if urn not in st.discovered:
                st.discovered.add(urn)
                st.visited.add(urn)
                st.labels.setdefault(urn, label)
            if up:
                st.cut_up[urn] = None
            if down:
                st.cut_down[urn] = None
        if anchors and "max_nodes" not in st.reasons and "timeout" not in st.reasons:
            st.reasons.append("max_nodes")

    async def _expand_prefix(
        self,
        prefix: List[Tuple[str, str]],
        st: "_ClosureWalk",
        *,
        up: bool,
        down: bool,
    ) -> int:
        """Expand a prefix of anchors whose degree estimate fits. Asks each
        direction for exactly ``sum(degree) + 1`` rows: more rows than the
        degrees promised means the graph changed under us, and that direction
        is re-offered as cut rather than committed half-read. A failed label
        bucket files its anchors as cut under ``timeout``; the other buckets
        commit. Returns the number of NEW nodes committed."""
        labels = {urn: (label or st.labels.get(urn) or "") for urn, label in prefix}
        spent = 0
        for urn, _ in prefix:
            if urn not in st.discovered:
                st.discovered.add(urn)
                st.visited.add(urn)
                spent += 1
            st.labels.setdefault(urn, labels[urn])
        st.progress += len(prefix)

        for direction, active, key in (("incoming", up, 0), ("outgoing", down, 1)):
            if not active:
                continue
            wanted = [(urn, lbl) for urn, lbl in labels.items() if st.degrees.get(urn, (0, 0))[key] > 0]
            if not wanted:
                continue
            expected = sum(st.degrees[urn][key] for urn, _ in wanted)
            rows, failed_labels = await self._expand_raw_lineage_set(
                [urn for urn, _ in wanted], dict(wanted), direction, st.ltypes,
                expected + 1, st.query_timeout(),
            )
            cut_dir = st.cut_up if direction == "incoming" else st.cut_down
            if failed_labels:
                st.reasons.append("timeout")
                for urn, lbl in wanted:
                    if lbl in failed_labels:
                        cut_dir[urn] = None
            if len(rows) > expected:
                # Drift: the graph has more than the degrees said. Nothing
                # from this direction is committed; every anchor is re-offered.
                for urn, _ in wanted:
                    cut_dir[urn] = None
                if "max_nodes" not in st.reasons:
                    st.reasons.append("max_nodes")
                continue
            spent += self._commit_rows(rows, st, direction)
        return spent

    def _commit_rows(self, rows: List[Dict[str, Any]], st: "_ClosureWalk", direction: str) -> int:
        """Record edges and newly discovered partners. Edge FIRST, visited
        second: an edge into a node the client already holds is the seam that
        stitches this step onto its graph. Returns the number of new nodes."""
        spent = 0
        for rec in rows:
            other = rec.get("otherUrn")
            is_new = bool(other) and other not in st.visited
            if is_new and len(st.discovered) >= st.max_nodes:
                # Defensive: the estimate is an upper bound, so this is only
                # reachable under concurrent writes. Drop the edge WITH the
                # node and re-offer the near end.
                near = rec["targetUrn"] if direction == "incoming" else rec["sourceUrn"]
                (st.cut_up if direction == "incoming" else st.cut_down)[near] = None
                if "max_nodes" not in st.reasons:
                    st.reasons.append("max_nodes")
                continue
            st.record_edge(rec)
            if not is_new:
                continue
            st.visited.add(other)
            st.discovered.add(other)
            st.labels[other] = rec.get("otherLabel") or ""
            spent += 1
            if direction == "incoming":
                st.upstream_urns.add(other)
                st.ring_up.append((other, st.labels[other]))
            else:
                st.downstream_urns.add(other)
                st.ring_down.append((other, st.labels[other]))
        return spent

    async def _hub_page(
        self,
        anchor: Tuple[str, str],
        st: "_ClosureWalk",
        *,
        up: bool,
        down: bool,
        budget: int,
    ) -> int:
        """An anchor whose adjacency cannot fit the page: ship its first page
        per direction by edge id. Upstream gets half the budget, downstream
        the rest; a direction whose page came back FULL carries a real
        ``e:<last id + 1>`` cursor and a cut entry, a direction with fewer
        rows is complete. Returns the new nodes spent."""
        urn, label = anchor
        spent = 0
        if urn not in st.discovered:
            st.discovered.add(urn)
            st.visited.add(urn)
            spent += 1
            budget -= 1
        st.labels.setdefault(urn, label or "")
        st.progress += 1
        plan: List[Tuple[str, str, int]] = []
        if up and down:
            share_up = (budget + 1) // 2
            plan.append(("incoming", "up", share_up))
            plan.append(("outgoing", "down", -1))       # the rest, decided after up
        elif up:
            plan.append(("incoming", "up", budget))
        elif down:
            plan.append(("outgoing", "down", budget))
        for direction, side, limit in plan:
            if limit < 0:
                limit = budget
            if limit <= 0:
                (st.cut_up if side == "up" else st.cut_down)[urn] = None
                if "max_nodes" not in st.reasons:
                    st.reasons.append("max_nodes")
                continue
            rows, last_edge_id = await self._page_raw_lineage_single(
                urn, label or st.labels.get(urn) or "", direction, st.ltypes,
                0, limit, st.query_timeout(),
            )
            if rows is None:
                st.reasons.append("timeout")
                (st.cut_up if side == "up" else st.cut_down)[urn] = None
                continue
            new = self._commit_rows(rows, st, direction)
            spent += new
            budget -= new
            if len(rows) >= limit:
                (st.cut_up if side == "up" else st.cut_down)[urn] = None
                if last_edge_id is not None:
                    st.paged[(urn, side)] = f"e:{last_edge_id + 1}"
                if "max_nodes" not in st.reasons:
                    st.reasons.append("max_nodes")
        return spent

    async def _expand_raw_lineage_set(
        self,
        frontier: List[str],
        frontier_labels: Dict[str, str],
        direction: str,
        ltypes: List[str],
        limit: int,
        timeout_secs: float,
    ) -> Tuple[List[Dict[str, Any]], Set[str]]:
        """One BFS hop over RAW lineage edges — the regime-independent core of
        ``trace_closure``. Returns ``(rows, failed_labels)``: the label
        buckets whose query failed are named, never silently empty — the
        caller re-offers their anchors as cut entries under ``timeout``.

        Unlike ``_expand_aggregated_set`` this walks the DECLARED lineage
        rel-types directly (``[r:LTYPE1|LTYPE2|...]``) with NO neighbour
        label/level filter: focus scoping comes from starting at the focus and
        following its ACTUAL lineage, not from constraining peers. Reads the
        MAIN graph (raw edges live there, not the projection graph), so it is
        correct at the finest grain even in boundary regime where leaf rollups
        are never materialised.

        ``direction``: ``'incoming'`` walks upstream (``(f)<-[r]-(o)``),
        ``'outgoing'`` walks downstream (``(f)-[r]->(o)``). Each returned record
        is oriented source->target and carries ``otherUrn``/``otherLabel`` — the
        far (newly-discovered) endpoint and its entity-type label — so the
        caller seeds the next frontier ALREADY label-bucketed without a
        separate label round-trip.

        The frontier is bucketed by label so each sub-query uses the per-label
        ``(:Label).urn`` index (there is no label-less URN index; an unlabeled
        bucket pays one scan, still correct).

        There is deliberately NO exclude filter. The caller's already-known
        set is applied in Python AFTER the row is recorded, so an edge into a
        known node still ships while the node itself does not — see the note
        at the call site in ``trace_closure`` for the diamond this protects.
        """
        if not frontier or limit <= 0 or not ltypes:
            return [], set()

        by_label: Dict[str, List[str]] = {}
        for urn in frontier:
            by_label.setdefault(frontier_labels.get(urn) or "", []).append(urn)

        if direction == "incoming":
            arrow = "<-[r:{rel}]-"
            source_var, target_var = "o", "f"
        else:
            arrow = "-[r:{rel}]->"
            source_var, target_var = "f", "o"
        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        per_query_timeout = max(0.6, min(CLOSURE_QUERY_CAP_SECS, timeout_secs))

        queries: List[Tuple[str, str, Dict[str, Any]]] = []
        for f_label, urns in by_label.items():
            sl = _sanitize_label(f_label) if f_label else ""
            label_clause = f":{sl}" if sl else ""
            where_clause = "WHERE f.urn IN $frontier "
            params: Dict[str, Any] = {"frontier": urns, "limit": limit}
            cypher = (
                f"MATCH (f{label_clause}){arrow.format(rel=rel_alt)}(o) "
                + where_clause
                + f"RETURN {source_var}.urn AS sourceUrn, {target_var}.urn AS targetUrn, "
                "id(r) AS edgeId, type(r) AS edgeType, "
                "o.urn AS otherUrn, labels(o)[0] AS otherLabel "
                "LIMIT $limit"
            )
            queries.append((f_label, cypher, params))

        async def _run(c: str, p: Dict[str, Any]):
            try:
                return await self._ro_query(
                    c, params=p, timeout=per_query_timeout, op="trace.closure_expand",
                )
            except Exception as exc:
                logger.warning(
                    "trace_closure: raw lineage expand (%s) failed: %s",
                    direction, exc,
                )
                return None

        results = await asyncio.gather(*(_run(c, p) for _, c, p in queries))

        out: List[Dict[str, Any]] = []
        failed_labels: Set[str] = set()
        seen_edge_ids: Set[str] = set()
        for (f_label, _c, _p), result in zip(queries, results):
            if result is None:
                failed_labels.add(f_label)
                continue
            for row in (result.result_set or []):
                try:
                    eid = str(row[2]) if row[2] is not None else f"raw-{row[0]}-{row[1]}"
                    if eid in seen_edge_ids:
                        continue
                    seen_edge_ids.add(eid)
                    out.append({
                        "sourceUrn": row[0],
                        "targetUrn": row[1],
                        "edgeId": eid,
                        "edgeType": str(row[3]) if row[3] else ltypes[0],
                        "otherUrn": row[4],
                        "otherLabel": row[5],
                    })
                    if len(out) >= limit:
                        return out, failed_labels
                except Exception:
                    continue
        return out, failed_labels

    async def _collect_lineage_seed(
        self,
        focus_urn: str,
        focus_label: str,
        ltypes: List[str],
        ctypes: List[str],
        cap: int,
        timeout_secs: float,
        after_urn: Optional[str] = None,
    ) -> Tuple[List[Tuple[str, str]], bool]:
        """The anchors the closure walk STARTS from, in walk order.

        Lineage lives at the leaves, never on containers. A LEAF focus is its
        own seed. A CONTAINER focus (a Domain/Layer/Table with no lineage of
        its own) contributes nothing directly — so this is the ONE place
        containment flows DOWNWARD: walk containment down to find which
        descendants of the top-most node carry incident lineage, and seed from
        those. The closure BFS then shows only their LINEAGE hops; containment
        is never a hop. Bounded by ``cap`` (a container with more lineage
        leaves than that spills to the lazy/coarse path — handled by the
        caller's ``max_nodes`` truncation + cursor).

        Returns ``(anchors, failed)``: ``anchors`` is the focus's own row
        (page one only, when it carries lineage) followed by its
        lineage-bearing descendants ORDERED BY urn, as ``(urn, label)``
        pairs (label-bucketed for index-seeking sub-queries — no extra label
        lookup), at most ``cap`` descendants. The caller passes
        ``max_nodes + 1`` so a capped enumeration always leaves a KNOWN
        pending anchor for the cursor — the walk, not this query, decides
        where the page ends. ``after_urn`` is the INCLUSIVE keyset resume
        point (``d.urn >= $after``): it names the next anchor to consider,
        mirroring the ``e:<next id>`` convention. ``failed`` is True when a
        query errored; the caller reports ``seed_failed`` rather than
        shipping an empty page that claims to be complete.

        The caller's ``exclude_urns`` deliberately plays NO part here: it
        governs what is re-SHIPPED, never where the walk STARTS. Dropping a
        held node from the seed only means never re-deriving the hops it
        has not been asked about yet — see the ``wanted`` comment in
        ``trace_closure``, which is the same rule on the explicit-seed path.
        """
        if not ltypes:
            return [(focus_urn, focus_label)], False

        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        per_query_timeout = max(0.6, min(CLOSURE_QUERY_CAP_SECS, timeout_secs))
        sl = _sanitize_label(focus_label) if focus_label else ""
        label_clause = f":{sl}" if sl else ""

        # FalkorDB REJECTS the tempting single-round-trip form
        #     WITH [f] + collect(DISTINCT d) AS cands
        # (mixing a node alias with an aggregation) — it fails with
        #     "_AR_EXP_UpdateEntityIdx: Unable to locate a value with alias f"
        # VERIFIED against a live engine (a fake that string-matches Cypher
        # cannot catch this). So: two separately-valid queries, GATHERED, and
        # unioned in Python — a cursor role, not a filter:
        #   (1) does the focus itself carry lineage?         → LEAF focus
        #   (2) which containment descendants carry lineage? → CONTAINER focus
        # A seed-page CONTINUATION (after_urn) re-collects only descendants
        # past the keyset boundary; the focus-self seed belongs to page one.
        queries: List[Tuple[str, Dict[str, Any]]] = [] if after_urn else [(
            f"MATCH (f{label_clause} {{urn: $urn}}) WHERE (f)-[:{rel_alt}]-() "
            "RETURN f.urn AS urn, labels(f)[0] AS label",
            {"urn": focus_urn},
        )]
        descendants_idx = len(queries)
        if ctypes:
            ct_alt = "|".join(_sanitize_label(t) for t in ctypes)
            hops = self._containment_hop_bound()
            # ORDER BY urn makes the page deterministic and the keyset
            # (`d.urn > $after`) a true resume point — SKIP-free, so a deep
            # page costs the same as the first.
            after_clause = "AND d.urn >= $after " if after_urn else ""
            queries.append((
                f"MATCH (f{label_clause} {{urn: $urn}})-[c:{ct_alt}*1..{hops}]->(d) "
                f"WHERE (d)-[:{rel_alt}]-() {after_clause}"
                "RETURN DISTINCT d.urn AS urn, labels(d)[0] AS label "
                "ORDER BY urn LIMIT $cap",
                {"urn": focus_urn, "cap": cap, **({"after": after_urn} if after_urn else {})},
            ))
        elif after_urn:
            # No containment types ⇒ no descendant pages exist to resume.
            return [], False

        async def _run_seed(c: str, prm: Dict[str, Any]):
            try:
                return await self._ro_query(
                    c, params=prm, timeout=per_query_timeout, op="trace.closure_seed",
                )
            except Exception as exc:
                logger.warning(
                    "trace_closure: seed query failed for %s: %s", focus_urn, exc,
                )
                return None

        results = await asyncio.gather(*(_run_seed(c, prm) for c, prm in queries))
        failed = any(r is None for r in results)

        # The focus's own row first (page one), then descendants in urn
        # order — the order the walk consumes them, and the order the keyset
        # cursor resumes.
        seed: List[Tuple[str, str]] = []
        seen: Set[str] = set()
        for result in results:
            if result is None:
                continue
            for row in (result.result_set or []):
                u = row[0]
                if not u or u in seen:
                    continue
                seen.add(u)
                seed.append((u, (row[1] if len(row) > 1 else None) or ""))
        return seed, failed

    async def _descendant_lineage_seed(
        self,
        urns: List[str],
        labels: Dict[str, str],
        ltypes: List[str],
        ctypes: List[str],
        cap: int,
        timeout_secs: float,
        after_urn: Optional[str] = None,
    ) -> Tuple[List[Tuple[str, str]], bool]:
        """Which lineage-bearing entities live BENEATH these seeds, in urn
        order, resumable by the same inclusive keyset cursor as
        ``_collect_lineage_seed`` (``d.urn >= $after``).

        ``_collect_lineage_seed``'s containment-descent, asked of a SET
        rather than of one anchor: a walk continuation names the cards the
        reader clicked, and a card that holds finer things carries no
        lineage of its own — its columns do. Seeds that ARE leaves simply
        contribute nothing here (a leaf has no containment children), so
        the caller can hand over its whole seed list without sorting them
        first.

        Bucketed by label for the per-label ``(:Label).urn`` index, the
        same way ``_expand_raw_lineage_set`` buckets its frontier (there is
        no label-less URN index; an unlabeled bucket pays one scan, still
        correct). Each bucket is ``ORDER BY urn LIMIT $cap``; with several
        buckets the union is trimmed to the SAFE BOUND ``B = min(last urn of
        every bucket that filled its cap)`` so the merged list has no gap a
        later page could fall into — every un-enumerated row of a capped
        bucket is ``> B``. Returns ``(anchors, failed)``; ``failed`` names a
        query error the caller must report (``seed_failed``) instead of
        walking the literal seeds as if nothing lived beneath them.
        """
        if not urns or not ltypes or not ctypes or cap <= 0:
            return [], False

        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)
        ct_alt = "|".join(_sanitize_label(t) for t in ctypes)
        hops = self._containment_hop_bound()
        per_query_timeout = max(0.6, min(CLOSURE_QUERY_CAP_SECS, timeout_secs))
        after_clause = "AND d.urn >= $after " if after_urn else ""

        by_label: Dict[str, List[str]] = {}
        for u in urns:
            by_label.setdefault(labels.get(u) or "", []).append(u)

        async def _run(f_label: str, bucket: List[str]):
            sl = _sanitize_label(f_label) if f_label else ""
            label_clause = f":{sl}" if sl else ""
            cypher = (
                f"MATCH (f{label_clause})-[c:{ct_alt}*1..{hops}]->(d) "
                f"WHERE f.urn IN $seeds AND (d)-[:{rel_alt}]-() {after_clause}"
                "RETURN DISTINCT d.urn AS urn, labels(d)[0] AS label "
                "ORDER BY urn LIMIT $cap"
            )
            params: Dict[str, Any] = {"seeds": bucket, "cap": cap}
            if after_urn:
                params["after"] = after_urn
            try:
                return await self._ro_query(
                    cypher, params=params,
                    timeout=per_query_timeout, op="trace.closure_seed",
                )
            except Exception as exc:
                logger.warning(
                    "trace_closure: descendant seed query failed: %s", exc,
                )
                return None

        results = await asyncio.gather(
            *(_run(lbl, bucket) for lbl, bucket in by_label.items())
        )

        failed = any(r is None for r in results)
        merged: Dict[str, str] = {}
        bound: Optional[str] = None
        for result in results:
            if result is None:
                continue
            rows = result.result_set or []
            for row in rows:
                u = row[0]
                if not u or u in merged:
                    continue
                merged[u] = (row[1] if len(row) > 1 else None) or ""
            if len(rows) >= cap and rows[-1][0]:
                last = str(rows[-1][0])
                bound = last if bound is None else min(bound, last)
        anchors = sorted(merged.items())
        if bound is not None:
            anchors = [(u, lbl) for u, lbl in anchors if u <= bound]
        return anchors, failed

    async def _page_raw_lineage_single(
        self,
        urn: str,
        label: str,
        direction: str,
        ltypes: List[str],
        after_id: Optional[int],
        limit: int,
        timeout: float,
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[int]]:
        """Cursor page over ONE node's raw-lineage adjacency in ONE
        direction — the lazy/coarse fallback for a single frontier node
        whose full hop would blow the BFS budget, paired with
        ``_expand_raw_lineage_set``'s batched hop.

        Stable-ordered by ``id(r)``. ``after_id`` is INCLUSIVE — "the next
        edge id to consider", not "the last one you saw" — so ``0`` means
        from the start and the caller's next cursor is ``last_edge_id + 1``.
        The exclusive form could not express "from the start" at all: the
        wire grammar is ``^e:\\d+$``, so the only available start was
        ``e:0``, which silently skipped the edge with ``id(r) == 0``. Row
        dicts use the SAME keys as ``_expand_raw_lineage_set`` rows so
        callers can share processing code between the batched and
        single-node paths.

        ``label`` falsy falls back to an unlabeled anchor match — a
        single-node scan, so the missing per-label index is an accepted
        cost here (unlike the frontier-wide bucketing in the sibling
        helpers, where an unlabeled bucket would pay that cost per URN).
        """
        if not ltypes or limit <= 0:
            return [], None

        after = 0 if after_id is None else after_id
        sl = _sanitize_label(label) if label else ""
        label_clause = f":{sl}" if sl else ""
        rel_alt = "|".join(_sanitize_label(t) for t in ltypes)

        if direction == "incoming":
            arrow = f"<-[r:{rel_alt}]-"
            source_expr, target_expr = "o.urn", "f.urn"
        else:
            arrow = f"-[r:{rel_alt}]->"
            source_expr, target_expr = "f.urn", "o.urn"

        cypher = (
            f"MATCH (f{label_clause} {{urn: $urn}}){arrow}(o) "
            "WHERE id(r) >= $after "
            f"RETURN id(r) AS edgeId, {source_expr} AS sourceUrn, {target_expr} AS targetUrn, "
            "type(r) AS edgeType, o.urn AS otherUrn, labels(o)[0] AS otherLabel "
            "ORDER BY id(r) "
            "LIMIT $limit"
        )
        # Per-query bound, same as the sibling walk helpers — deliberately
        # NOT the caller's whole remaining budget. Keeping every individual
        # page query small is what lets the closure's overall deadline
        # degrade to a truncated (200) response instead of one runaway
        # query eating the whole request; a single label-qualified anchor
        # page at LIMIT <= 2000 fits comfortably inside this bound.
        per_query_timeout = max(0.6, min(CLOSURE_QUERY_CAP_SECS, timeout))
        try:
            result = await self._ro_query(
                cypher, params={"urn": urn, "after": after, "limit": limit},
                timeout=per_query_timeout, op="trace.closure_page",
            )
        except Exception as exc:
            logger.warning(
                "trace_closure: page query failed for %s (%s): %s", urn, direction, exc,
            )
            # None, not []: the caller must tell "nothing there" from "could
            # not read" — the latter is a flagged, resumable page.
            return None, None

        rows: List[Dict[str, Any]] = []
        last_edge_id: Optional[int] = None
        for row in (result.result_set or []):
            try:
                raw_eid = row[0]
                eid_int = int(raw_eid) if raw_eid is not None else None
                rows.append({
                    "sourceUrn": row[1],
                    "targetUrn": row[2],
                    "edgeId": str(raw_eid) if raw_eid is not None else f"raw-{row[1]}-{row[2]}",
                    "edgeType": str(row[3]) if row[3] else ltypes[0],
                    "otherUrn": row[4],
                    "otherLabel": row[5],
                })
                if eid_int is not None:
                    last_edge_id = eid_int
            except Exception:
                continue
        return rows, last_edge_id
