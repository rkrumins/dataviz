"""FINDING THE CLUSTER FROM A COLD START.

A provider's startup nodes are the masters as they were the day someone wrote
the connection down. Masters move. Nothing breaks while the list drifts,
because a running process seeds from the nodes its last sweep found — so the
drift is invisible until a deploy or an eviction, when every process is cold
and has only that list. Then a healthy cluster reads as unreachable.

This is the memory that closes it, and the three things it has to get right:

* **A promoted replica is a usable seed.** Any node answers CLUSTER NODES, so
  role orders the list and must never filter it. Filtering to "nodes that were
  masters" is the bug, not the fix.
* **A restarted node is the same node.** With static allocation an address
  survives its outage, so a node is never forgotten for failing to answer — it
  sorts below the ones that did and returns to the front when it speaks again.
* **Remembering must not cost anything when the bus is down.** The memory is an
  optimisation; discovery works without it. A bus that is merely unreachable
  must not add a connect timeout to every sweep.
"""
import asyncio
import json
import time

import pytest

from backend.app.services.graph_store import seed_memory


def _run(coro):
    return asyncio.run(coro)


class _FakeRedis:
    """A HASH, and nothing else."""

    def __init__(self, initial=None):
        self.h = dict(initial or {})
        self.expired = None

    async def hgetall(self, key):
        return dict(self.h)

    async def hset(self, key, mapping=None):
        self.h.update(mapping or {})

    async def expire(self, key, ttl):
        self.expired = ttl

    async def delete(self, key):
        self.h.clear()


def _entry(role, *, seen=None, ok=None):
    now = int(time.time())
    return json.dumps({"role": role, "seen": seen if seen is not None else now,
                       "ok": now if ok is None else ok})


@pytest.fixture(autouse=True)
def _no_cooldown_leak():
    seed_memory._unavailable_until = 0.0
    yield
    seed_memory._unavailable_until = 0.0


# ── a promoted replica is still a seed ───────────────────────────────────


def test_replicas_are_remembered_and_handed_back():
    """The whole point. If only masters were kept, a cluster that has failed
    over twice would leave a cold process with nothing to dial."""
    r = _FakeRedis()
    _run(seed_memory.remember("i1", [
        ("10.0.0.1:6379", "master", True),
        ("10.0.0.4:6379", "replica", True),
        ("10.0.0.5:6379", "replica", True),
    ], client=r))

    seeds = _run(seed_memory.recall("i1", client=r))
    assert ("10.0.0.4:6379".split(":")[0], 6379) in seeds
    assert len(seeds) == 3


def test_a_master_is_preferred_but_a_replica_is_never_excluded():
    r = _FakeRedis({
        "10.0.0.4:6379": _entry("replica"),
        "10.0.0.1:6379": _entry("master"),
    })
    seeds = _run(seed_memory.recall("i1", client=r))
    assert seeds[0] == ("10.0.0.1", 6379), "the master should be tried first"
    assert ("10.0.0.4", 6379) in seeds, "the replica must still be tried"


def test_a_replica_that_became_master_sorts_first_after_the_next_sweep():
    """A failover promoted 10.0.0.4. The next sweep records its new role, and
    it moves to the front on its own — no invalidation, no special case."""
    r = _FakeRedis({
        "10.0.0.1:6379": _entry("master"),
        "10.0.0.4:6379": _entry("replica"),
    })
    _run(seed_memory.remember("i1", [
        ("10.0.0.4:6379", "master", True),
        ("10.0.0.1:6379", "replica", True),
    ], client=r))
    assert _run(seed_memory.recall("i1", client=r))[0] == ("10.0.0.4", 6379)


# ── a restarted node is the same node ────────────────────────────────────


def test_a_node_that_did_not_answer_is_kept_and_sorts_last():
    """Static allocation means the address comes back. Forgetting it is how a
    cluster becomes unfindable one maintenance window at a time."""
    r = _FakeRedis()
    _run(seed_memory.remember("i1", [
        ("10.0.0.1:6379", "master", True),
        ("10.0.0.2:6379", "master", False),      # down for maintenance
    ], client=r))

    seeds = _run(seed_memory.recall("i1", client=r))
    assert seeds == [("10.0.0.1", 6379), ("10.0.0.2", 6379)]


def test_a_node_that_comes_back_returns_to_the_front():
    r = _FakeRedis()
    _run(seed_memory.remember("i1", [
        ("10.0.0.1:6379", "master", True),
        ("10.0.0.2:6379", "master", False),
    ], client=r))
    # The node returns; this sweep reaches it.
    _run(seed_memory.remember("i1", [
        ("10.0.0.1:6379", "master", False),
        ("10.0.0.2:6379", "master", True),
    ], client=r))
    assert _run(seed_memory.recall("i1", client=r))[0] == ("10.0.0.2", 6379)


def test_when_it_did_answer_survives_a_sweep_that_could_not_reach_it():
    """A node down for one sweep must not be flattened to "never answered" —
    that would sort it level with an address nobody has ever reached."""
    r = _FakeRedis()
    _run(seed_memory.remember("i1", [("10.0.0.2:6379", "master", True)], client=r))
    before = json.loads(r.h["10.0.0.2:6379"])["ok"]
    assert before > 0

    _run(seed_memory.remember("i1", [("10.0.0.2:6379", "master", False)], client=r))
    assert json.loads(r.h["10.0.0.2:6379"])["ok"] == before


# ── bounds ───────────────────────────────────────────────────────────────


def test_the_list_is_capped():
    """Seeds are tried serially until one answers, so an unbounded list turns
    a total outage into a very long wait — which is what this whole area of
    the code exists to stop."""
    r = _FakeRedis({f"10.0.0.{i}:6379": _entry("replica") for i in range(1, 40)})
    assert len(_run(seed_memory.recall("i1", client=r))) == seed_memory.MAX_REMEMBERED


def test_an_address_the_cluster_stopped_mentioning_ages_out():
    old = int(time.time()) - seed_memory.SEED_TTL_S - 60
    r = _FakeRedis({
        "10.0.0.1:6379": _entry("master"),
        "10.9.9.9:6379": _entry("master", seen=old, ok=old),
    })
    assert _run(seed_memory.recall("i1", client=r)) == [("10.0.0.1", 6379)]


def test_an_address_with_nothing_to_dial_is_not_stored():
    """A NOADDR node reports ':0'. Remembering it would spend a seed attempt
    on something that cannot be connected to."""
    r = _FakeRedis()
    _run(seed_memory.remember("i1", [
        (":0", "replica", False), ("", "master", False),
        ("10.0.0.1:6379", "master", True),
    ], client=r))
    assert list(r.h) == ["10.0.0.1:6379"]


# ── the bus is optional ──────────────────────────────────────────────────


def test_a_bus_that_hangs_costs_the_memory_and_not_the_sweep():
    """The regression this nearly shipped as: an unreachable bus added a
    connect timeout to every instance of every sweep."""

    class _Hanging:
        async def hgetall(self, key):
            await asyncio.sleep(3600)

    started = time.monotonic()
    assert _run(seed_memory.recall("i1", client=_Hanging())) == []
    assert time.monotonic() - started < seed_memory._BUDGET_S * 3


def test_a_hang_arms_a_cooldown_so_the_next_caller_pays_nothing():
    class _Hanging:
        def __init__(self):
            self.calls = 0

        async def hgetall(self, key):
            self.calls += 1
            await asyncio.sleep(3600)

    bus = _Hanging()
    _run(seed_memory.recall("i1", client=bus))
    assert seed_memory._unavailable_until > time.monotonic()

    # A caller that does not bring its own client now skips the bus entirely.
    assert _run(seed_memory.recall("i1")) == []


def test_a_bus_that_errors_is_not_an_error():
    class _Broken:
        async def hgetall(self, key):
            raise ConnectionError("no route to host")

    assert _run(seed_memory.recall("i1", client=_Broken())) == []


def test_a_corrupt_row_is_skipped_not_fatal():
    r = _FakeRedis({"10.0.0.1:6379": "not json", "10.0.0.2:6379": _entry("master")})
    assert _run(seed_memory.recall("i1", client=r)) == [("10.0.0.2", 6379)]


def test_forget_clears_a_store_that_was_genuinely_rebuilt():
    r = _FakeRedis({"10.0.0.1:6379": _entry("master")})
    _run(seed_memory.forget("i1", client=r))
    assert _run(seed_memory.recall("i1", client=r)) == []
