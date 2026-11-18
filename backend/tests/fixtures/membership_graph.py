"""A small graph behind a fake engine, for the membership resolver and member sets.

    containment   dom ⊃ tbl_a ⊃ {col_a1, col_a2};  dom ⊃ tbl_b ⊃ col_b1;  tbl_up ⊃ col_up
    lineage       src3 → src2 → src1 → col_a1 → rep1 → rep2
                  tbl_up → tbl_b            (a lineage edge between containers)
                  u1…u5 → hub → col_a2      (hub: more lineage than one step carries — paged)

A closure step reaches at most ``step_max`` hops, so a walk deeper than one step must
re-root what the step left on its frontier — the path a 25-hop limit takes on a real
graph. ``seed_page`` pages a step's anchors (a container seed's insides) by seed cursor,
as a real closure does when it cannot afford them all.
"""
from backend.common.models.graph import (
    GraphEdge,
    GraphNode,
    TraceClosureResult,
    TraceFocus,
    TraceFrontierNode,
)

CONTAINS = {
    "dom": ["tbl_a", "tbl_b"],
    "tbl_a": ["col_a1", "col_a2"],
    "tbl_b": ["col_b1"],
    "tbl_up": ["col_up"],
}
LINEAGE = [
    ("src3", "src2"), ("src2", "src1"), ("src1", "col_a1"),
    ("col_a1", "rep1"), ("rep1", "rep2"),
    ("tbl_up", "tbl_b"),
    ("hub", "col_a2"),
    *[(f"u{i}", "hub") for i in range(1, 6)],
]
HUBS = {"hub"}
HUB_PAGE = 2


def _node(urn: str) -> GraphNode:
    return GraphNode(urn=urn, displayName=urn, entityType="thing")


class FakeEngine:
    def __init__(self, step_max: int = 25, chains: bool = True, step_gives_up: str = "",
                 seed_page: int = 0):
        self.step_max = step_max
        self.chains_supported = chains
        self.step_gives_up = step_gives_up   # a closure step's truncation reason, when set
        self.seed_page = seed_page           # anchors one step walks, 0 for all of them
        self.closure_calls = []
        self.descendant_calls = []
        self.parent = {c: p for p, cs in CONTAINS.items() for c in cs}
        self.all = set(self.parent) | set(CONTAINS) | {u for e in LINEAGE for u in e}

    # ── reads the resolver makes ────────────────────────────────────────────
    async def get_nodes_query(self, query):
        return [_node(u) for u in query.urns if u in self.all]

    async def get_descendants(self, urn, depth=5, entity_types=None, limit=100, offset=0):
        self.descendant_calls.append((urn, depth))
        out, frontier = [], [urn]
        for _ in range(depth):
            frontier = [c for p in frontier for c in CONTAINS.get(p, [])]
            out.extend(frontier)
        return [_node(u) for u in out[offset:offset + limit]]

    async def get_ancestor_chains(self, urns):
        if not self.chains_supported:
            raise NotImplementedError("no containment walk on this reader")
        out = {}
        for u in urns:
            chain, p = [], self.parent.get(u)
            while p:
                chain.append(p)
                p = self.parent.get(p)
            out[u] = chain
        return out

    async def trace_closure(self, req):
        self.closure_calls.append(req)
        up = req.direction == "upstream"
        nbrs = (lambda n: [s for s, t in LINEAGE if t == n]) if up else (lambda n: [t for s, t in LINEAGE if s == n])
        edge = (lambda a, b: (b, a)) if up else (lambda a, b: (a, b))

        if req.after_cursor:                       # a hub's next page
            start = int(req.after_cursor.split(":")[1])
            all_n = nbrs(req.urn)
            page = all_n[start:start + HUB_PAGE]
            more = start + HUB_PAGE < len(all_n)
            return self._result(up, [req.urn], set(page), [edge(req.urn, m) for m in page],
                                [TraceFrontierNode(urn=req.urn, nextCursor=f"e:{start + HUB_PAGE}")] if more else [])

        anchors = set()
        for s in req.seed_urns or [req.urn]:
            anchors |= self._lineage_leaves(s)
        seed_cursor = None
        if self.seed_page:
            ordered = sorted(anchors)
            if req.seed_cursor:
                ordered = [a for a in ordered if a >= req.seed_cursor[2:]]
            anchors, rest = set(ordered[:self.seed_page]), ordered[self.seed_page:]
            seed_cursor = f"s:{rest[0]}" if rest else None
        depth = min(req.upstream_depth if up else req.downstream_depth, self.step_max)
        seen, side, edges, frontier, unfinished = set(anchors), set(), [], set(anchors), []
        for hop in range(depth):
            nxt = set()
            for n in frontier:
                if n in HUBS and n not in anchors:
                    unfinished.append(TraceFrontierNode(urn=n, nextCursor="e:0", reason="cut"))
                    continue
                for m in nbrs(n):
                    s_, t_ = edge(n, m)
                    edges.append((s_, t_))
                    if m not in seen:
                        seen.add(m)
                        side.add(m)
                        nxt.add(m)
            frontier = nxt
        unfinished += [TraceFrontierNode(urn=n, reason="depth") for n in frontier if nbrs(n)]
        result = self._result(up, sorted(anchors), side, edges, unfinished)
        result.seed_cursor = seed_cursor
        return result

    # ── helpers ─────────────────────────────────────────────────────────────
    def _lineage_leaves(self, urn):
        """A container walks from what inside it carries lineage, as the real closure does."""
        carries = {u for e in LINEAGE for u in e}
        if urn in carries:
            return {urn}
        out, stack = set(), list(CONTAINS.get(urn, []))
        while stack:
            u = stack.pop()
            if u in carries:
                out.add(u)
            stack.extend(CONTAINS.get(u, []))
        return out or {urn}

    def _result(self, up, anchors, side, edges, frontier):
        nodes = [_node(u) for u in sorted(set(anchors) | set(side))]
        ge = [GraphEdge(id=f"{s}>{t}", sourceUrn=s, targetUrn=t, edgeType="FLOWS_TO") for s, t in edges]
        return TraceClosureResult(
            nodes=nodes, edges=ge,
            upstreamUrns=set(side) if up else set(),
            downstreamUrns=set() if up else set(side),
            focus=TraceFocus(urn=anchors[0] if anchors else "x", level=0, entityType="thing"),
            effectiveLevel=0,
            frontierUp=frontier if up else [], frontierDown=[] if up else frontier,
            truncated=bool(self.step_gives_up), truncationReason=self.step_gives_up or None,
        )
