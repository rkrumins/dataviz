"""Projection liveness: an idle graph whose FalkorDB key lost what its watermark says it holds is
reseeded, not served from a cache that is not there.

* ``liveness_reset_to`` lowers the watermark to 0 when the key is missing, and to the marker's seq
  when the key lost the passes after it (a restore, a lost AOF tail). A key without a marker
  (projected before markers, bootstrapped, seeded from a package) is judged only by whether it
  exists — never reset because no marker is there.
* ``read_projection_marker`` reads the marker with ``GRAPH.RO_QUERY`` only. ``GRAPH.QUERY``
  creates a missing key, so a read that fell back to it would answer "the key is there, empty"
  about the very key that was lost. A client without ``ro_query`` cannot tell; any error other
  than the missing key propagates (unreachable is not lost).
* The projection lane runs the liveness loop.

Pure unit tests — no Postgres, no FalkorDB.
"""
import asyncio

import pytest

from backend.app.services.versioning import config, projection, worker


class _ResponseError(Exception):
    """What FalkorDB raises for a RO_QUERY on a key that does not exist."""


_MISSING = "Invalid graph operation on empty key"


class _Res:
    def __init__(self, rows):
        self.result_set = rows


class _Graph:
    def __init__(self, *, rows=None, raises=None):
        self.rows, self.raises, self.calls = rows if rows is not None else [], raises, []

    async def ro_query(self, cypher, params=None, timeout=None):
        self.calls.append(("ro_query", cypher, timeout))
        if self.raises is not None:
            raise self.raises
        return _Res(self.rows)

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append(("query", cypher, timeout))
        return _Res(self.rows)


def _run(coro):
    return asyncio.run(coro)


# ── liveness_reset_to ────────────────────────────────────────────────────


@pytest.mark.parametrize("exists, marker, projected, expected", [
    (False, None, 9, 0),        # the key is gone: reseed
    (False, 9, 9, 0),
    (True, 7, 9, 7),            # the key lost the passes after 7: re-apply (7, head]
    (True, 9, 9, None),         # healthy
    (True, 11, 9, None),        # ahead of Postgres: not this check's to fix
    (True, None, 9, None),      # unmarked (legacy, bootstrapped, package-seeded): left alone
])
def test_where_liveness_lowers_the_watermark(exists, marker, projected, expected):
    assert projection.liveness_reset_to(exists, marker, projected) == expected


# ── read_projection_marker ───────────────────────────────────────────────


def test_a_marked_key_answers_its_seq_read_only():
    g = _Graph(rows=[[7]])
    assert _run(projection.read_projection_marker(g)) == (True, 7)
    assert [c[0] for c in g.calls] == ["ro_query"]


def test_the_marker_read_is_bounded_short():
    """A hung node must not stall a sweep for the projector's long read budget."""
    g = _Graph(rows=[[7]])
    _run(projection.read_projection_marker(g))
    assert g.calls[0][2] == 5000


def test_an_unmarked_key_exists_without_a_seq():
    assert _run(projection.read_projection_marker(_Graph(rows=[]))) == (True, None)


def test_a_missing_key_is_reported_and_never_created():
    """The read helper re-sends an empty-key read as GRAPH.QUERY for every other caller. Here
    that would CREATE the lost key and report it present and unmarked — the one answer that
    hides the loss."""
    g = _Graph(raises=_ResponseError(_MISSING))
    assert _run(projection.read_projection_marker(g)) == (False, None)
    assert [c[0] for c in g.calls] == ["ro_query"], g.calls


def test_a_missing_key_wrapped_by_the_client_layer_is_still_missing():
    try:
        raise _ResponseError(_MISSING)
    except _ResponseError as cause:
        wrapped = RuntimeError("graph call failed")
        wrapped.__cause__ = cause
    g = _Graph(raises=wrapped)
    assert _run(projection.read_projection_marker(g)) == (False, None)
    assert [c[0] for c in g.calls] == ["ro_query"], g.calls


def test_an_unreachable_key_is_not_a_lost_one():
    g = _Graph(raises=ConnectionError("connection refused"))
    with pytest.raises(ConnectionError):
        _run(projection.read_projection_marker(g))
    assert [c[0] for c in g.calls] == ["ro_query"]


def test_a_client_without_ro_query_cannot_tell():
    class _Old:
        calls = []

        async def query(self, cypher, params=None, timeout=None):
            self.calls.append(cypher)
            return _Res([])

    g = _Old()
    assert _run(projection.read_projection_marker(g)) == (None, None)
    assert g.calls == []


def test_the_read_helper_can_refuse_to_create_a_missing_key():
    g = _Graph(raises=_ResponseError(_MISSING))
    with pytest.raises(_ResponseError):
        _run(projection._q(g, "MATCH (n) RETURN count(n)", read_only=True, missing="raise"))
    assert [c[0] for c in g.calls] == ["ro_query"]


# ── the loop ─────────────────────────────────────────────────────────────


class _Proj:
    def __init__(self):
        self.checked = 0

    async def check_liveness(self):
        self.checked += 1
        return [{"graph_id": "g1"}]


def test_the_projection_lane_runs_the_liveness_loop(monkeypatch):
    monkeypatch.setattr(config, "LIVENESS_SECS", 60)
    proj = _Proj()
    w = worker.ProjectionWorker(proj, lanes={"projection"})

    async def idle():
        return None

    for name in ("_poll_loop", "_stream_loop"):
        monkeypatch.setattr(w, name, idle)

    async def no_group():
        return None

    monkeypatch.setattr(worker, "ensure_consumer_group", no_group)
    monkeypatch.setattr(w, "_reclaim_pending", idle)

    async def go():
        task = asyncio.ensure_future(w.run())
        for _ in range(50):
            if proj.checked:
                break
            await asyncio.sleep(0.01)
        w.stop()
        await asyncio.wait_for(task, 5)

    _run(go())
    assert proj.checked == 1


def test_liveness_can_be_turned_off(monkeypatch):
    monkeypatch.setattr(config, "LIVENESS_SECS", 0)
    proj = _Proj()
    w = worker.ProjectionWorker(proj, lanes={"projection"})

    async def idle():
        return None

    for name in ("_poll_loop", "_stream_loop", "_reclaim_pending"):
        monkeypatch.setattr(w, name, idle)
    monkeypatch.setattr(worker, "ensure_consumer_group", idle)
    _run(asyncio.wait_for(w.run(), 5))
    assert proj.checked == 0
