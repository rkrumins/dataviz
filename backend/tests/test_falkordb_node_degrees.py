"""Degree totals ask for relationship types in the graph's own spelling.

FalkorDB matches relationship types case-sensitively, and ``get_edges``
already translates declared types to the source's observed spelling
(``_alias_rel_types``). ``get_node_degrees`` did not, so on a source that
spells its types differently every card counted zero and read as having no
lineage at all.

No live FalkorDB required — the graph handle is a stub.
"""
from types import SimpleNamespace

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _provider(proj_fails=None):
    p = FalkorDBProvider(host="x", graph_name="g")
    p.asked = []
    p.asked_proj = []

    async def _connected():
        return None

    async def _buckets(urns):
        return [("Dataset", list(urns))]

    async def _ro(cypher, params=None, timeout=None, **kw):
        p.asked.append(cypher)
        return SimpleNamespace(result_set=[["u1", 3]])

    async def _proj(cypher, params=None, timeout=None, **kw):
        # The projection graph holds roll-up cells OUT of u1 and into nothing.
        p.asked_proj.append(cypher)
        if proj_fails is not None:
            raise proj_fails
        return SimpleNamespace(result_set=[["u1", 1]] if "(n)-[:AGGREGATED]->()" in cypher else [])

    p._ensure_connected = _connected
    p._label_buckets = _buckets
    p._ro_query = _ro
    p._proj_ro_query = _proj
    return p


async def test_degrees_ask_for_the_graphs_own_spelling():
    p = _provider()
    p.set_source_type_aliases({"TRANSFORMS": ["transforms"]})

    degrees = await p.get_node_degrees(["u1"], ["TRANSFORMS"])

    assert degrees == {"u1": {"in": 3, "out": 3}}
    assert p.asked and all("[r:transforms]" in c for c in p.asked)
    assert p.asked_proj == []                        # nothing asked of the projection


# ── roll-up presence, for container markers ─────────────────────────
#
# A collapsed container whose lineage all sits below it has no lineage edge
# of its own, so its raw totals are zero and its marker read "none". In
# dedicated projection mode its roll-up cells live on the projection graph,
# which the raw count never reads.

async def test_rollup_presence_comes_from_the_projection_graph():
    p = _provider()
    degrees = await p.get_node_degrees(["u1", "u2"], ["TRANSFORMS"], include_rollups=True)
    assert degrees == {
        "u1": {"in": 3, "out": 3, "rollupIn": 0, "rollupOut": 1},
        "u2": {"in": 0, "out": 0, "rollupIn": 0, "rollupOut": 0},
    }
    assert all("AGGREGATED" not in c for c in p.asked)
    assert len(p.asked_proj) == 2
    # Presence, not a count: a count of cells is not a count of flows, and
    # an anchor's cells run to thousands.
    assert all("count(" not in c and "(n:Dataset)" in c for c in p.asked_proj)


async def test_a_shed_rollup_probe_is_told_to_ask_again():
    import pytest
    from backend.common.adapters import ProviderBusy

    p = _provider(proj_fails=ProviderBusy("falkordb", "shed"))
    with pytest.raises(ProviderBusy):
        await p.get_node_degrees(["u1"], ["TRANSFORMS"], include_rollups=True)


async def test_a_failed_rollup_probe_leaves_its_urns_unknown():
    p = _provider(proj_fails=RuntimeError("projection unreadable"))
    assert await p.get_node_degrees(["u1"], ["TRANSFORMS"], include_rollups=True) == {}
