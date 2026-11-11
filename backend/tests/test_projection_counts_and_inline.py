"""The verify's counts, and when ``project_now`` projects inside the request.

Pins:
- On a key the projector owns, the counts are FalkorDB's constant-time ones: unfiltered
  ``count(n)`` and ``count(r)``, less the derived labels' and the rollups' own counts. No WHERE
  filters every node or relationship: that is a scan, and it timed out on the large graphs a
  verify most needs to count.
- On a customer's key, the counts are taken a window of internal node ids at a time, so no
  statement costs the whole key.
- ``project_now`` projects a window ``fits_inline`` passes, and leaves a larger one to the worker
  with a nudge, rather than starting a pass its 10 s budget would cancel.
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints import versioning as endpoints
from backend.app.services.versioning import reconcile
from backend.common.derived_artifacts import DERIVED_LABELS


class _Counts:
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append((cypher, params))
        for needle, value in self.answers:
            if needle in cypher:
                return type("R", (), {"result_set": [[value]]})()
        return type("R", (), {"result_set": [[0]]})()


async def test_an_owned_keys_counts_are_constant_time_less_what_is_derived():
    client = _Counts([("MATCH (n:`_GVRollupMeta`)", 1), ("MATCH (n:`_AggMeta`)", 1),
                      ("MATCH (n) RETURN count(n)", 1002), ("[r:`AGGREGATED`]", 40),
                      ("MATCH ()-[r]->() RETURN count(r)", 540)])
    assert await reconcile.falkor_counts(client, owned=True) == (1000, 500)
    assert not [c for c, _p in client.calls if "WHERE" in c], client.calls
    assert {f"MATCH (n:`{label}`) RETURN count(n) AS c" for label in DERIVED_LABELS} <= {
        c for c, _p in client.calls}


async def test_a_customer_keys_counts_go_a_window_of_node_ids_at_a_time():
    client = _Counts([("max(id(n))", 2 * reconcile._COUNT_PAGE + 5), ("RETURN count(n)", 7),
                      ("count(DISTINCT", 3)])
    assert await reconcile.falkor_counts(client, owned=False) == (21, 9)
    windows = [p for c, p in client.calls if p]
    assert [w["lo"] for w in windows[::2]] == [0, reconcile._COUNT_PAGE, 2 * reconcile._COUNT_PAGE]
    assert all(w["hi"] - w["lo"] == reconcile._COUNT_PAGE for w in windows)


class _Projector:
    def __init__(self, fits):
        self.fits, self.projected = fits, []

    async def fits_inline(self, graph_id):
        return self.fits

    async def project_graph(self, graph_id, **_kw):
        self.projected.append(graph_id)
        return {"noop": False}


@pytest.mark.parametrize("fits", [True, False])
async def test_project_now_projects_a_small_window_and_hands_a_large_one_to_the_worker(monkeypatch, fits):
    proj, nudged = _Projector(fits), []

    async def no_repair(_gid):
        return None

    async def nudge(gid):
        nudged.append(gid)

    monkeypatch.setattr(endpoints, "_repair_projection_target", no_repair)
    monkeypatch.setattr(endpoints, "_get_projector", lambda: proj)
    monkeypatch.setattr(endpoints, "nudge_projection", nudge)
    await endpoints.project_now("g1")
    assert (proj.projected, nudged) == ((["g1"], []) if fits else ([], ["g1"]))
