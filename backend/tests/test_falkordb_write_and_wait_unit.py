"""``ResilientGraph.write_and_wait``: the projector's last write, confirmed on the replicas.

Redis ``WAIT`` counts the replicas that acknowledged the ISSUING connection's last write, so the
write and its WAIT must share one connection — a pooled client hands each command whichever
socket is free, and a WAIT on a socket that wrote nothing confirms nothing. So:

* the write and the WAIT go out together on one connection of the owning node's pool, and the
  answer is the replica count;
* any error once the write is on the wire (the socket closed under it by ``invalidate``, a WAIT
  refused) is "unconfirmed" (None), never retried: a WAIT re-sent on a reconnected socket would
  count a connection that wrote nothing;
* a socket that saw an error or a cancel is dropped before it goes back to the pool, so no
  later caller reads this call's reply;
* a key whose owning node changed since the handle was built is unconfirmed: the pass's writes
  went to the old master, and the new one's replicas say nothing about them.

Pure unit tests over a fake pool — no FalkorDB.
"""
import asyncio

import pytest
from redis.exceptions import ConnectionError, ResponseError

from backend.app.providers.falkordb_connection import FalkorDBConnConfig, TopologyGraphClients


class _Conn:
    def __init__(self, replies):
        self.replies, self.sent, self.disconnected = list(replies), [], False

    def pack_commands(self, commands):
        return [tuple(c) for c in commands]

    async def send_packed_command(self, packed):
        self.sent.append(packed)

    async def read_response(self):
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply

    async def disconnect(self, *a, **k):
        self.disconnected = True


class _Pool:
    def __init__(self, *replies):
        self.replies, self.handed, self.released, self.closed = replies, [], [], False

    async def get_connection(self, *a, **k):
        conn = _Conn(self.replies)
        self.handed.append(conn)
        return conn

    async def release(self, conn):
        self.released.append(conn)

    async def aclose(self):
        self.closed = True


class _DB:
    def select_graph(self, name):
        return object()


def _handle(pool, *, cfg=None, node=None):
    """A graph handle whose client cache already holds ``pool`` for the key's owner."""
    cfg = cfg or FalkorDBConnConfig()
    clients = TopologyGraphClients()
    ident = clients.identity(cfg)
    if node is not None:
        clients._owner[(ident, "g")] = node
    clients._clients[(ident, node)] = (_DB(), pool)
    return clients, cfg, asyncio.run(clients.get_graph(cfg, "g"))


def _write(handle):
    return asyncio.run(handle.write_and_wait(
        "MERGE (m:_GVProjMeta {id: 'meta'})", timeout_ms=1500, min_replicas=1, wait_ms=200))


def test_the_write_and_its_wait_go_out_together_on_one_connection():
    pool = _Pool([[b"header"], [], [b"stats"]], 1)
    _clients, _cfg, handle = _handle(pool)
    assert _write(handle) == 1
    [conn] = pool.handed
    assert conn.sent == [[
        ("GRAPH.QUERY", "g", "MERGE (m:_GVProjMeta {id: 'meta'})", "--compact", "timeout", 1500),
        ("WAIT", 1, 200),
    ]], "one send, one socket: the WAIT counts this write"
    assert pool.released == [conn] and not conn.disconnected and not pool.closed


def test_an_error_after_the_write_is_unconfirmed_and_the_socket_is_dropped():
    # invalidate() closes the pool, which disconnects the socket mid-WAIT.
    for replies in (([b"ok"], ConnectionError("Connection closed by server.")),
                    (ConnectionError("reset"),),
                    ([b"ok"], ResponseError("WAIT cannot be used with replica instances"))):
        pool = _Pool(*replies)
        _clients, _cfg, handle = _handle(pool)
        assert _write(handle) is None, replies
        [conn] = pool.handed
        assert conn.disconnected and pool.released == [conn], replies


def test_a_cancel_drops_the_socket_and_propagates():
    pool = _Pool([b"ok"], asyncio.CancelledError())
    _clients, _cfg, handle = _handle(pool)
    with pytest.raises(asyncio.CancelledError):
        _write(handle)
    [conn] = pool.handed
    assert conn.disconnected and pool.released == [conn]


def test_a_key_whose_owner_changed_since_the_handle_was_built_is_unconfirmed():
    cfg = FalkorDBConnConfig(mode="cluster", cluster_nodes=[("a", 1), ("b", 2)])
    old = _Pool([b"ok"], 1)
    clients, cfg, handle = _handle(old, cfg=cfg, node=("a", 1))
    # A failover / reshard: the slot map now names another master for the key.
    ident = clients.identity(cfg)
    new = _Pool([b"ok"], 1)
    clients._owner[(ident, "g")] = ("b", 2)
    clients._clients[(ident, ("b", 2))] = (_DB(), new)
    assert _write(handle) is None
    assert old.handed == [] and new.handed == [], "nothing is written to either master"


def test_a_cluster_write_goes_to_the_owning_node_pool():
    cfg = FalkorDBConnConfig(mode="cluster", cluster_nodes=[("a", 1), ("b", 2)])
    owner = _Pool([b"ok"], 1)
    clients, cfg, handle = _handle(owner, cfg=cfg, node=("a", 1))
    clients._clients[(clients.identity(cfg), ("b", 2))] = (_DB(), _Pool())
    assert _write(handle) == 1 and len(owner.handed) == 1
