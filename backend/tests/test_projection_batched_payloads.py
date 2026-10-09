"""A publish window's projection reads payloads a batch at a time, and indexes what it writes (no infra).

``_compute_changes`` folds a window over its version rows' identity columns and hands ``_apply``
upserts whose payload is still pending (``_Pending``: the row's urn/type/ends and a reference).
``_apply`` reads the payloads of each write batch as it writes it — and must write exactly what
it writes for the same upserts with their payloads in hand, native-property admission included.
Before writing, it makes the urn index of every label it merges or anchors on, once per (instance,
graph, label) per process — once it is made: a refused statement is asked again, and a graph whose
key was dropped is indexed again.
"""
import asyncio
import contextlib
from types import SimpleNamespace

from backend.app.services.versioning import projection
from backend.app.services.versioning.projection import FalkorProjector, _Pending


class _Client:
    def __init__(self, name="gvt_unit", refuse=None):
        self.name = name
        self.calls = []
        self.refuse = refuse or {}            # label -> the exception its CREATE INDEX raises

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append((cypher, params))
        for label, exc in self.refuse.items():
            if cypher == f"CREATE INDEX FOR (n:{label}) ON (n.urn)":
                raise exc
        return SimpleNamespace(result_set=[])

    async def delete(self):
        self.calls.append(("GRAPH.DELETE", None))

    def writes(self):
        return [(c, p) for c, p in self.calls if "CREATE INDEX" not in c]


class _Svc:
    def __init__(self, payloads):
        self.payloads, self.reads = payloads, []

    async def _payloads_by_version(self, s, refs):
        refs = list(refs)
        self.reads.append(len(refs))
        return {vid: self.payloads[vid] for _k, _g, vid in refs}


@contextlib.asynccontextmanager
async def _session():
    yield None


def _projector(svc):
    p = FalkorProjector(graph_client_factory=lambda *a: None, session_factory=_session, batch_size=2)
    p._svc = svc
    return p


def _node(i, typ):
    return {"urn": f"urn:{i}", "entityType": typ, "displayName": f"n{i}",
            "properties": {"rank": i, "owner": f"o{i % 2}", **({"rare": True} if i == 3 else {})}}


NODES = {f"v{i}": _node(i, "Table" if i % 3 else "Column") for i in range(7)}
EDGES = {f"w{i}": {"edgeType": "FLOWS", "sourceEntityId": f"e{i}", "targetEntityId": f"e{i + 1}",
                   "confidence": 0.5, "properties": {"i": i}} for i in range(5)}


def _pending(kind, vid, p):
    fields = ((("urn", p["urn"]), ("entityType", p["entityType"])) if kind == "node" else
              (("edgeType", p["edgeType"]), ("sourceEntityId", p["sourceEntityId"]),
               ("targetEntityId", p["targetEntityId"])))
    return _Pending((kind, "g", vid), fields)


def _upserts(pending: bool):
    nodes = [(f"e{i}", f"urn:{i}", _pending("node", f"v{i}", NODES[f"v{i}"]) if pending else NODES[f"v{i}"])
             for i in range(7)]
    edges = [(f"x{i}", f"urn:{i}", f"urn:{i + 1}",
              _pending("edge", f"w{i}", EDGES[f"w{i}"]) if pending else EDGES[f"w{i}"], "Table", "Column")
             for i in range(5)]
    return nodes, edges


def test_pending_payloads_are_read_per_batch_and_written_the_same():
    whole, lazy = _Client("gvt_whole"), _Client("gvt_lazy")
    svc = _Svc({**NODES, **EDGES})
    asyncio.run(_projector(_Svc({}))._apply(whole, *_upserts(False), [], []))
    asyncio.run(_projector(svc)._apply(lazy, *_upserts(True), [], []))
    assert lazy.writes() == whole.writes()
    # every read names at most one write batch (batch_size=2): never the window's payloads at once
    assert svc.reads and max(svc.reads) <= 2, svc.reads


def test_native_key_admission_counts_pending_payloads_like_held_ones(monkeypatch):
    """The admission ranks keys by how many nodes carry each: it gets the same counts — and makes
    the same pick, with the budget squeezed so one key is demoted — whether the payloads were held
    or read a batch at a time."""
    held = {"rank": 7, "owner": 7, "rare": 1}
    picked = {}
    real = projection._admit_native_keys

    def spy(props, **kw):
        native, demoted = real(props, **kw)
        picked.setdefault("calls", []).append((native, demoted))
        return native, demoted

    monkeypatch.setattr(projection, "_admit_native_keys", spy)
    p = _projector(_Svc({**NODES, **EDGES}))
    asyncio.run(p._apply(_Client("gvt_room"), _upserts(False)[0], [], [], []))
    staked = len(picked.pop("calls")[0][0]) - len(held)     # the platform's own names
    # room for those plus two user keys: the least carried one is stored as a value
    monkeypatch.setattr(projection, "_native_property_budget", lambda: staked + 2)
    asyncio.run(p._apply(_Client("gvt_a"), _upserts(False)[0], [], [], []))
    asyncio.run(p._apply(_Client("gvt_b"), _upserts(True)[0], [], [], []))
    assert picked["calls"][0] == picked["calls"][1]
    assert picked["calls"][0][1] == ["rare"], picked["calls"][0]
    counts = {}
    for props in asyncio.run(p._native_key_counts(_upserts(True)[0])):
        for k in props:
            counts[k] = counts.get(k, 0) + 1
    assert counts == held


def test_urn_indexes_are_made_once_per_graph_and_label(monkeypatch):
    monkeypatch.setattr(projection, "_URN_INDEXED", set())
    p = _projector(_Svc({**NODES, **EDGES}))
    client = _Client("gvt_idx")
    nodes, edges = _upserts(False)
    asyncio.run(p._apply(client, nodes, edges, [("urn:gone", "View")], []))
    ddl = sorted(c for c, _p in client.calls if "CREATE INDEX" in c)
    assert ddl == ["CREATE INDEX FOR (n:Column) ON (n.urn)", "CREATE INDEX FOR (n:Table) ON (n.urn)",
                   "CREATE INDEX FOR (n:View) ON (n.urn)"], ddl
    first_write = next(i for i, (c, _p) in enumerate(client.calls) if "CREATE INDEX" not in c)
    assert all("CREATE INDEX" in c for c, _p in client.calls[:first_write]), "indexes before writes"
    client.calls.clear()
    asyncio.run(p._apply(client, nodes, edges, [], []))
    assert not [c for c, _p in client.calls if "CREATE INDEX" in c], "made once per process"
    other = _Client("gvt_idx_other")
    asyncio.run(p._apply(other, nodes[:1], [], [], []))
    assert [c for c, _p in other.calls if "CREATE INDEX" in c] == ["CREATE INDEX FOR (n:Column) ON (n.urn)"]
    # The same graph name on another instance is another key, with indexes of its own.
    client.calls.clear()
    asyncio.run(p._apply(client, nodes[:1], [], [], [], provider_id="prov_2"))
    assert [c for c, _p in client.calls if "CREATE INDEX" in c] == ["CREATE INDEX FOR (n:Column) ON (n.urn)"]


async def _bump(*_a, **_k):
    return None


def test_a_dropped_key_is_indexed_again(monkeypatch):
    """GRAPH.DELETE takes the key's indexes with it: the reseed into it must make them again."""
    from backend.app.providers import graph_generation

    monkeypatch.setattr(projection, "_URN_INDEXED", set())
    monkeypatch.setattr(graph_generation, "bump_graph_generation", _bump)
    p = _projector(_Svc({**NODES, **EDGES}))
    client = _Client("gvt_evicted")
    p._client = lambda *_a: client
    nodes, _edges = _upserts(False)
    asyncio.run(p._apply(client, nodes[:1], [], [], []))
    asyncio.run(p.drop_graph("gvt_evicted"))
    client.calls.clear()
    asyncio.run(p._apply(client, nodes[:1], [], [], []))
    assert [c for c, _p in client.calls if "CREATE INDEX" in c] == ["CREATE INDEX FOR (n:Column) ON (n.urn)"]


def test_a_refused_index_is_asked_for_again_and_a_node_refusal_stops_the_set(monkeypatch):
    monkeypatch.setattr(projection, "_URN_INDEXED", set())
    p = _projector(_Svc({**NODES, **EDGES}))
    nodes, edges = _upserts(False)
    # A statement refused: the others are made, and it is asked for again on the next pass.
    client = _Client("gvt_refused", refuse={"Column": RuntimeError("Invalid label")})
    asyncio.run(p._apply(client, nodes, edges, [], []))
    client.refuse.clear()
    client.calls.clear()
    asyncio.run(p._apply(client, nodes, edges, [], []))
    assert [c for c, _p in client.calls if "CREATE INDEX" in c] == ["CREATE INDEX FOR (n:Column) ON (n.urn)"]
    # The node refused (it is still loading): nothing after it is tried, nothing is remembered.
    client = _Client("gvt_loading", refuse={"Column": RuntimeError("LOADING Redis is loading the dataset in memory")})
    asyncio.run(p._apply(client, nodes, edges, [], []))
    assert len([c for c, _p in client.calls if "CREATE INDEX" in c]) == 1
    assert not {k for k in projection._URN_INDEXED if k[1] == "gvt_loading"}
