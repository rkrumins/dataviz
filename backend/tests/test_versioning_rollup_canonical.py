"""The versioning projector's incremental :AGGREGATED maintenance must
emit the same pair sets as the aggregation worker's shared pair rules.

The stored regime (cube vs boundary) is only knowable from the graph at
APPLY time, so the compute step returns the full ancestor-closure CUBE
deltas (``dw``) with the canonical depth-bridged subset flagged
(``dwc``); ``_apply_rollups`` picks the delta matching the graph. On a
boundary graph only ``dwc`` is applied — writing the full cube there
would shadow leaf pairs and double-count the reader's additive
mixed-level merges until the next batch run.
"""
import asyncio
from types import SimpleNamespace

from backend.app.services.versioning.projection import FalkorProjector


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _Session:
    def __init__(self, rows):
        self.rows = rows

    async def execute(self, stmt):
        return _Rows(self.rows)


class _Svc:
    """4-level chains a0⊃a1⊃a2⊃a3 / b0⊃b1⊃b2⊃b3, entityType lvl{i}."""

    def __init__(self):
        self.parent = {}
        self.types = {}
        for c in ("a", "b"):
            for i in range(4):
                self.types[f"{c}{i}"] = f"lvl{i}"
                if i:
                    self.parent[f"{c}{i}"] = f"{c}{i - 1}"

    async def _values_at(self, s, gid, bid, ids, seq):
        return {
            i: {"urn": f"urn:{i}", "entityType": self.types[i]}
            for i in ids if i in self.types
        }

    async def _containment_ancestors(self, s, gid, bid, node_ids, cset, as_of):
        seen = set(node_ids)
        edges = {}
        for n in list(node_ids):
            child, cur = n, self.parent.get(n)
            while cur:
                seen.add(cur)
                edges[f"ce_{child}"] = {
                    "sourceEntityId": cur, "targetEntityId": child,
                    "edgeType": "CONTAINS",
                }
                child, cur = cur, self.parent.get(cur)
        return seen, edges


def _projector(resolver):
    p = FalkorProjector(
        graph_client_factory=lambda name, provider_id=None: None,
        batch_size=10,
        edge_types_resolver=resolver,
    )
    p._svc = _Svc()
    return p


_CREATE = {"sourceEntityId": "a3", "targetEntityId": "b3", "edgeType": "FLOWS"}


def test_projector_emits_canonical_pairs_with_level_stamps():
    levels = {f"lvl{i}": i for i in range(4)}

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"], levels)

    p = _projector(resolver)
    s = _Session([("e1", "create", _CREATE)])
    pairs = asyncio.run(
        p._compute_rollup_deltas(s, SimpleNamespace(id="g1"), "main", 1, 2)
    )

    # Full cube deltas (every ancestor combination minus the raw
    # mirror), with the canonical diagonal flagged via dwc — the apply
    # step selects by the graph's stored regime.
    assert len(pairs) == 4 * 4 - 1
    canonical = {k for k, v in pairs.items() if v.get("dwc")}
    assert canonical == {
        ("urn:a2", "urn:b2"), ("urn:a1", "urn:b1"), ("urn:a0", "urn:b0"),
    }
    for (su, tu), v in pairs.items():
        assert v["dw"] == 1
        assert v["types"] == {"FLOWS"}
        # Structural depth stamps ride every pair.
        assert isinstance(v["sd"], int) and isinstance(v["td"], int)
        assert v["dg"]
    for k in canonical:
        v = pairs[k]
        # Level stamps + digest keep the read path's storage-regime probe
        # clean (NULL stamps flip readers to stored-only answers).
        assert isinstance(v["sl"], int) and isinstance(v["tl"], int)
        assert v["sl"] == v["tl"]
        assert v["dwc"] == 1


def test_projector_structural_canonical_without_level_map():
    """Level maps are STAMPS, never the selector: a legacy 2-tuple
    resolver (no level map) still emits the structural depth-diagonal —
    parity with the pipeline's structural boundary. Stamps and digest
    are simply omitted."""

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"])

    p = _projector(resolver)
    s = _Session([("e1", "create", _CREATE)])
    pairs = asyncio.run(
        p._compute_rollup_deltas(s, SimpleNamespace(id="g1"), "main", 1, 2)
    )

    canonical = {k for k, v in pairs.items() if v.get("dwc")}
    assert canonical == {
        ("urn:a2", "urn:b2"), ("urn:a1", "urn:b1"), ("urn:a0", "urn:b0"),
    }
    assert all("sl" not in v and "dg" not in v for v in pairs.values())


def test_projector_delete_emits_negative_canonical_deltas():
    levels = {f"lvl{i}": i for i in range(4)}

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"], levels)

    class _SvcWithBefore(_Svc):
        async def _values_at(self, s, gid, bid, ids, seq):
            out = await super()._values_at(s, gid, bid, ids, seq)
            if "e1" in ids and seq <= 1:
                out["e1"] = dict(_CREATE)   # edge existed before the window
            return out

    p = _projector(resolver)
    p._svc = _SvcWithBefore()
    s = _Session([("e1", "delete", None)])
    pairs = asyncio.run(
        p._compute_rollup_deltas(s, SimpleNamespace(id="g1"), "main", 1, 2)
    )

    canonical = {k for k, v in pairs.items() if v.get("dwc")}
    assert canonical == {
        ("urn:a2", "urn:b2"), ("urn:a1", "urn:b1"), ("urn:a0", "urn:b0"),
    }
    assert all(v["dw"] == -1 for v in pairs.values())
    assert all(pairs[k]["dwc"] == -1 for k in canonical)


def test_projector_self_nesting_type_emits_every_depth():
    """Self-nesting types (Node ⊃ Node) must roll up at every containment
    depth even though every container shares ONE type level — the
    structural mirror of the pipeline's boundary. Stamps carry the type
    level where mapped."""
    levels = {"Roots": 0, "Node": 1}

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"], levels)

    class _SelfNestSvc(_Svc):
        def __init__(self):
            self.parent = {
                "a3": "a2", "a2": "a1",       # Roots a1 ⊃ Node a2 ⊃ leaf a3
                "b3": "b2", "b2": "b1",
            }
            self.types = {
                "a1": "Roots", "a2": "Node", "a3": "Node",
                "b1": "Roots", "b2": "Node", "b3": "Node",
            }

    p = _projector(resolver)
    p._svc = _SelfNestSvc()
    s = _Session([("e1", "create",
                   {"sourceEntityId": "a3", "targetEntityId": "b3",
                    "edgeType": "FLOWS"})])
    pairs = asyncio.run(
        p._compute_rollup_deltas(s, SimpleNamespace(id="g1"), "main", 1, 2)
    )

    canonical = {k for k, v in pairs.items() if v.get("dwc")}
    assert canonical == {
        ("urn:a2", "urn:b2"),      # Node-container diagonal — was missing
        ("urn:a1", "urn:b1"),      # Roots diagonal
    }
    assert pairs[("urn:a2", "urn:b2")]["sl"] == 1
    assert pairs[("urn:a1", "urn:b1")]["sl"] == 0
    # Structural depth stamps on every cube pair, self-nesting included.
    assert pairs[("urn:a2", "urn:b2")]["sd"] == 1
    assert pairs[("urn:a3", "urn:b1")]["sd"] == 2
    assert pairs[("urn:a3", "urn:b1")]["td"] == 0
