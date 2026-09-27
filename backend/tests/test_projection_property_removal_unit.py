"""The projector removes a deleted property from its FalkorDB node — whatever the property is called.

``n += nativeProps`` only ever adds, so the projector first reads the keys each node holds and
nulls the ones the committed payload no longer has. It kept the platform's WHOLE attribute
catalogue off that list — rollup and ``_AggMeta`` names included, which never live on an entity
node — so a user property called ``weight``, ``id`` or ``confidence`` outlived its deletion; and
when the catalogue could not be resolved it removed nothing at all.
"""
import pytest

from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS
from backend.app.services.versioning.projection import FalkorProjector, _projector_owned_property_names


class _Client:
    """Answers the removal read with the keys (and identity stamps) of the nodes it holds."""

    def __init__(self, nodes):
        self.nodes = nodes
        self.queries = []

    async def query(self, cypher, params=None, **_):
        self.queries.append(cypher)
        rows = [[u, list(self.nodes[u]), self.nodes[u].get("urnSource"), self.nodes[u].get("nameSource")]
                for u in params["urns"] if u in self.nodes]
        return type("R", (), {"result_set": rows})()


def _item(urn, **native):
    return {"urn": urn, "nativeProps": native}


def test_keep_is_the_reserved_node_keys_and_never_empty():
    keep = _projector_owned_property_names()
    assert keep == set(_RESERVED_NODE_KEYS)
    assert {"urn", "gvHash", "urnSource", "nameSource", "propertiesRaw"} <= keep
    assert not {"weight", "id", "confidence", "seq", "aggKey"} & keep


@pytest.mark.asyncio
async def test_platform_named_user_properties_are_removed_when_deleted():
    client = _Client({"u1": {"urn": "u1", "displayName": "A", "gvHash": 1, "weight": 3, "id": "x",
                             "confidence": 0.5, "owner": "o"}})
    chunk = [_item("u1", owner="o")]
    await FalkorProjector.__new__(FalkorProjector)._mark_removed_properties(
        client, "Dataset", chunk, _projector_owned_property_names())
    assert chunk[0]["gone"] == {"weight": None, "id": None, "confidence": None}


@pytest.mark.asyncio
async def test_a_nodes_identity_property_is_kept():
    """A source whose identity column is ``extId`` stamped ``urnSource='extId'``: keep it."""
    client = _Client({"u1": {"urn": "u1", "urnSource": "extId", "extId": "E-1",
                             "nameSource": "label", "label": "Nice", "stale": 1}})
    chunk = [_item("u1")]
    await FalkorProjector.__new__(FalkorProjector)._mark_removed_properties(
        client, "Dataset", chunk, _projector_owned_property_names())
    assert chunk[0]["gone"] == {"stale": None}


@pytest.mark.asyncio
async def test_a_new_node_has_nothing_to_remove():
    client = _Client({})
    chunk = [_item("new", a=1)]
    await FalkorProjector.__new__(FalkorProjector)._mark_removed_properties(
        client, "Dataset", chunk, _projector_owned_property_names())
    assert chunk[0]["gone"] == {}
