"""A moved graph's platform key names the graph, so no data source and no other graph can hold it.

``owned_key`` mints ``gvp_<graphId>{<gid8>.<n>}`` (doc 14 §6: the hash tag keeps one graph's key on
one cluster slot); ``is_owned_key`` accepts exactly doc 14's ``^gvp_<gid>\\{[0-9a-z]{8}\\.\\d+\\}$``
for this graph, so an explicit move target that is not this graph's own platform key is refused.

The projection lane runs the loop that drops a moved graph's old keys, whether or not liveness is
on (``integration/test_versioning_projection_provider_routing.py`` runs the drop itself).
"""
import asyncio

from backend.app.services.versioning import config, keymigrate, worker

_GID = "graph_01JA2B3C4D5E6F7G8H9JKMNPQR"


def test_owned_key_names_the_graph_and_its_tag():
    assert keymigrate.owned_key(_GID, 1) == f"gvp_{_GID}{{{_GID[-8:].lower()}.1}}"
    assert keymigrate.owned_key(_GID, 2) == f"gvp_{_GID}{{{_GID[-8:].lower()}.2}}"


def test_only_this_graphs_platform_key_is_owned():
    assert keymigrate.is_owned_key(_GID, keymigrate.owned_key(_GID, 7))
    assert keymigrate.is_owned_key(_GID, f"gvp_{_GID}{{0a1b2c3d.12}}")   # any 8-char tag
    other = "graph_01JA2B3C4D5E6F7G8H9JKMNPQS"
    for name in (keymigrate.owned_key(other, 1), "nexus_lineage", "blank_ds_123",
                 f"{_GID}__fork_abc", f"gvp_{_GID}{{0A1B2C3D.1}}", f"gvp_{_GID}{{0a1b2c3.1}}",
                 f"gvp_{_GID}{{0a1b2c3d.}}", f"x_gvp_{_GID}{{0a1b2c3d.1}}"):
        assert not keymigrate.is_owned_key(_GID, name), name


def test_the_projection_lane_retires_old_keys_even_with_liveness_off(monkeypatch):
    monkeypatch.setattr(config, "LIVENESS_SECS", 0)
    proj, calls = object(), []

    async def retire(projector, **_kw):
        calls.append(projector)
        return [{"graphId": "g1", "key": "k1", "provider": "prov_A", "verdict": "dropped"}]

    async def idle(*_a):
        return None

    monkeypatch.setattr(keymigrate, "retire_moved_keys", retire)
    monkeypatch.setattr(worker, "ensure_consumer_group", idle)
    w = worker.ProjectionWorker(proj, lanes={"projection"})
    for name in ("_poll_loop", "_stream_loop", "_reclaim_pending"):
        monkeypatch.setattr(w, name, idle)

    async def go():
        task = asyncio.ensure_future(w.run())
        for _ in range(50):
            if calls:
                break
            await asyncio.sleep(0.01)
        w.stop()
        await asyncio.wait_for(task, 5)

    asyncio.run(go())
    assert calls == [proj]
