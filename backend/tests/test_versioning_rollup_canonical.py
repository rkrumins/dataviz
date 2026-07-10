"""The versioning projector's incremental :AGGREGATED maintenance must
emit the same CANONICAL level-bridged pairs as the aggregation worker.

Its original full ancestor cross-product wrote leaf-involving and
mixed-level cells the canonical boundary deliberately excludes — on a
canonically-aggregated graph every versioned lineage commit then created
full-cube rows that the on-demand reader either shadowed (leaf pairs) or
double-counted (mixed-level additive merge) until the next batch run.
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
        for n in list(node_ids):
            cur = self.parent.get(n)
            while cur:
                seen.add(cur)
                cur = self.parent.get(cur)
        return seen, {}


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

    # Canonical diagonal only — no leaf-involving, no mixed cells.
    assert set(pairs) == {
        ("urn:a2", "urn:b2"), ("urn:a1", "urn:b1"), ("urn:a0", "urn:b0"),
    }
    for (su, tu), v in pairs.items():
        assert v["dw"] == 1
        assert v["types"] == {"FLOWS"}
        # Level stamps + digest keep the read path's storage-regime probe
        # clean (NULL stamps flip readers to stored-only answers).
        assert isinstance(v["sl"], int) and isinstance(v["tl"], int)
        assert v["sl"] == v["tl"]
        assert v["dg"]


def test_projector_full_cube_without_level_map():
    """Legacy 2-tuple resolvers (and level-less ontologies) keep the
    original full cross-product — parity with the pipeline's own
    full-cube fallback."""

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"])

    p = _projector(resolver)
    s = _Session([("e1", "create", _CREATE)])
    pairs = asyncio.run(
        p._compute_rollup_deltas(s, SimpleNamespace(id="g1"), "main", 1, 2)
    )

    assert len(pairs) == 16  # {a3..a0} × {b3..b0}, no equal endpoints
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

    assert set(pairs) == {
        ("urn:a2", "urn:b2"), ("urn:a1", "urn:b1"), ("urn:a0", "urn:b0"),
    }
    assert all(v["dw"] == -1 for v in pairs.values())
