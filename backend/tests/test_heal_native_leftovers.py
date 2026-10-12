"""heal_native_leftovers: make FalkorDB agree with Postgres about which properties a node has.

Removes only a projected node's native keys that its committed main payload no longer holds —
never a reserved key, never the node's identity property, never on a node main does not hold —
and a dry run writes nothing.
"""
import importlib.util
import pathlib

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "heal_native_leftovers",
    pathlib.Path(__file__).resolve().parents[1] / "scripts" / "heal_native_leftovers.py")
heal = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(heal)


def test_stale_keys_are_the_unreserved_non_identity_keys_the_payload_lacks():
    held = ["urn", "displayName", "gvHash", "urnSource", "extId", "weight", "owner", "kept"]
    payload = {"properties": {"kept": 1}}
    assert heal.stale_native_keys(held, ("extId", None), payload) == {"weight", "owner"}


def test_a_node_main_does_not_hold_is_never_touched():
    assert heal.stale_native_keys(["weight"], (None, None), None) == set()


def test_a_key_demoted_to_properties_raw_is_still_the_payloads():
    assert heal.stale_native_keys(["nested"], (None, None), {"properties": {"nested": {"a": 1}}}) == set()


class _Graph:
    """A tiny FalkorDB: nodes by internal id → {labels, props}."""

    def __init__(self, nodes):
        self.nodes = nodes
        self.writes = []

    async def query(self, cypher, params=None, **_):
        params = params or {}
        if cypher.startswith("MATCH (n) RETURN max(id(n))"):
            return type("R", (), {"result_set": [[max(self.nodes) if self.nodes else None]]})()
        if cypher.startswith("MATCH (n) WHERE id(n) >= $lo"):
            rows = [[n["labels"], n["props"].get("urn"), n["props"].get("entityId"), list(n["props"]),
                     n["props"].get("urnSource"), n["props"].get("nameSource")]
                    for i, n in self.nodes.items()
                    if params["lo"] <= i < params["hi"] and n["props"].get("entityId") is not None]
            return type("R", (), {"result_set": rows})()
        if cypher.startswith("UNWIND $batch AS item MATCH"):
            self.writes.append(cypher)
            by_urn = {n["props"]["urn"]: n for n in self.nodes.values()}
            for item in params["batch"]:
                for k in item["gone"]:
                    by_urn[item["urn"]]["props"].pop(k, None)
            return type("R", (), {"result_set": []})()
        raise AssertionError(cypher)


def _graph():
    return _Graph({
        0: {"labels": ["Dataset"], "props": {"urn": "a", "entityId": "a", "gvHash": 1, "weight": 2, "owner": "o"}},
        1: {"labels": ["Dataset"], "props": {"urn": "b", "entityId": "b", "extra": 1}},        # not on main
        2: {"labels": ["Dataset"], "props": {"urn": "c", "weight": 9}},                          # not projected
        3: {"labels": ["_AggMeta"], "props": {"urn": "m", "entityId": "m", "seq": 1}},          # platform node
    })


async def _lookup(ids):
    return {"a": {"properties": {"owner": "o"}}, "m": {"properties": {}}}


@pytest.mark.asyncio
async def test_dry_run_counts_and_writes_nothing():
    g = _graph()
    res = await heal.heal_graph(g, _lookup, apply=False, id_page=2)
    assert (res["healed"], dict(res["keys"])) == (1, {"weight": 1})
    assert g.writes == [] and "weight" in g.nodes[0]["props"]


@pytest.mark.asyncio
async def test_apply_removes_only_the_stale_keys_and_is_idempotent():
    g = _graph()
    await heal.heal_graph(g, _lookup, apply=True, id_page=2)
    assert g.nodes[0]["props"] == {"urn": "a", "entityId": "a", "gvHash": 1, "owner": "o"}
    assert g.nodes[1]["props"]["extra"] == 1 and g.nodes[2]["props"]["weight"] == 9
    assert g.nodes[3]["props"]["seq"] == 1
    again = await heal.heal_graph(g, _lookup, apply=True, id_page=2)
    assert again["healed"] == 0
