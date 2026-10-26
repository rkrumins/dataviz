"""Native read-only queries on FalkorDB — a person's own Cypher, run apart from
everything else the provider does.

* **Its own connections.** A small pool per endpoint, the size of the native
  bulkhead, built the way the provider builds its own (same auth, TLS and
  sentinel failover). A slow native query never holds a socket the canvas
  needs, and the reply cap below applies to nothing else.
* **A replica first.** One in step with its master, as the provider's own
  read router judges it; otherwise the master.
* **A cap on the reply.** The pool's parser — hiredis, as everywhere else —
  counts what it reads off the socket for each reply and stops past
  ``max_reply_bytes``; redis-py then drops the connection. A ``RETURN
  collect(n)`` over millions of nodes costs this process at most the cap.
* **No retry, and no second run elsewhere.** A replica that fails is benched
  as the provider benches one; the person is told to try again.
* **The server's own timeout**, capped at its ``TIMEOUT_MAX``, with a client
  deadline a little past it for a node that doesn't answer at all.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import re
from typing import Any, Dict, Optional, Tuple

from redis._parsers import _AsyncHiredisParser
from redis.exceptions import AskError, ResponseError
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from redis.utils import str_if_bytes

from backend.common.interfaces.native_query import (
    NativeQueryError,
    NativeQueryResult,
    NativeQuerySyntaxError,
    NativeQueryTimeout,
    NativeQueryTooLarge,
    NativeQueryWriteRefused,
)

logger = logging.getLogger(__name__)

#: How long past the server's timeout a node may stay silent.
CLIENT_GRACE_S = 2.0

_MIB = 1024 * 1024
_OFFSET = re.compile(r"offset:\s*(\d+)", re.IGNORECASE)


class ReplyTooLarge(NativeQueryTooLarge):
    """The reply ran past the cap; the connection it came on is dropped."""


@functools.lru_cache(maxsize=8)
def capped_parser(max_bytes: int) -> type:
    """A hiredis parser that stops reading a reply past ``max_bytes``."""

    class ReplyCappedParser(_AsyncHiredisParser):
        cap = max_bytes

        async def read_response(self, disable_decoding: bool = False, push_request: bool = False):
            self._taken = 0
            return await super().read_response(disable_decoding, push_request)

        async def read_from_socket(self):
            # As redis-py's own, with the count: what is fed to the reader
            # is what the reply will cost.
            buffer = await self._stream.read(self._read_size)
            if not buffer or not isinstance(buffer, bytes):
                raise RedisConnectionError("Connection closed by server.") from None
            self._taken = getattr(self, "_taken", 0) + len(buffer)
            if self._taken > self.cap:
                raise ReplyTooLarge(
                    f"The answer is larger than {_size(self.cap)}. Return less — properties "
                    f"instead of whole nodes, or fewer rows.",
                )
            self._reader.feed(buffer)
            return True

    return ReplyCappedParser


async def run_native(
    provider: Any, query: str, *, row_cap: int, timeout_ms: int, max_reply_bytes: int,
    pool_size: int,
) -> NativeQueryResult:
    """``query`` on ``provider``'s graph, read-only — see the module docstring."""
    from backend.app.providers.falkordb_provider import (
        _is_query_memory_error,
        _is_query_timeout_error,
        _replica_at_fault,
    )
    from backend.app.services.native_query.cells import to_cell
    from backend.app.services.native_query.settings import get_native_query_settings

    await provider._ensure_connected()
    pools = getattr(provider, "_native_pools", None)
    if pools is None:
        pools = provider._native_pools = NativePools()
    try:
        replica = await provider._replica_for(provider._graph_name)
    except Exception:                                     # noqa: BLE001 — the master serves
        replica = None
    endpoint = None
    if replica is not None:
        endpoint = (str(replica.host), int(replica.port), provider._conn_cfg.mode == "cluster")
    cap_ms = provider._server_timeout_cap_ms()
    server_ms = min(timeout_ms, cap_ms) if cap_ms > 0 else timeout_ms
    # Past the longest query allowed, so the socket never gives up first.
    socket_timeout = get_native_query_settings().max_timeout_ms / 1000 + CLIENT_GRACE_S + 5
    graph = await pools.graph(provider, endpoint, max_reply_bytes=max_reply_bytes,
                              pool_size=pool_size, socket_timeout=socket_timeout)
    try:
        result = await asyncio.wait_for(
            graph.ro_query(query, timeout=server_ms), timeout=server_ms / 1000 + CLIENT_GRACE_S,
        )
    except (asyncio.TimeoutError, RedisTimeoutError) as exc:
        if replica is not None:
            provider._penalise_replica(replica, exc)
        raise NativeQueryTimeout(_timed_out(server_ms)) from exc
    except NativeQueryError:
        raise
    except ResponseError as exc:
        if type(exc) is not ResponseError:                # MOVED, NOPERM, OOM…: not the query
            if isinstance(exc, AskError):                 # the graph moved: find its new owner
                await pools.drop(endpoint)
            raise
        if _is_query_timeout_error(exc):
            raise NativeQueryTimeout(_timed_out(server_ms)) from exc
        if _is_query_memory_error(exc):
            raise NativeQueryTooLarge(
                "The query needs more memory than one query may use. Narrow what it matches, "
                "or return less.",
            ) from exc
        if await provider._is_verified_missing_graph(exc):
            return NativeQueryResult(columns=[], rows=[])
        raise query_error(exc) from exc
    except (RedisConnectionError, OSError) as exc:
        # redis-py has already dropped the connection that failed; the
        # pool's others carry on.
        if replica is not None and _replica_at_fault(exc):
            provider._penalise_replica(replica, exc)
        raise
    columns = [str_if_bytes(h[1]) if isinstance(h, (list, tuple)) else str_if_bytes(h)
               for h in (result.header or [])]
    rows = [[to_cell(value) for value in row] for row in (result.result_set or [])[:row_cap]]
    return NativeQueryResult(columns=columns, rows=rows)


def query_error(exc: ResponseError) -> NativeQueryError:
    """What FalkorDB said about the query, as the error a person reads."""
    text = str(exc).strip()
    if "only on read-only queries" in text:
        return NativeQueryWriteRefused("The query writes to the graph, and native queries only read.")
    offset = _OFFSET.search(text)
    message = text.split(" errCtx:")[0].removeprefix("errMsg: ").strip() or "The query could not run."
    if offset or "Invalid input" in text:
        return NativeQuerySyntaxError(message, position=int(offset.group(1)) if offset else None)
    return NativeQueryError(message)


class NativePools:
    """One small client per endpoint, built on first use; the master's is
    dropped when its graph moves, so the next query finds the new owner."""

    def __init__(self) -> None:
        self._clients: Dict[Tuple, Tuple[Any, Any]] = {}
        self._lock = asyncio.Lock()

    async def graph(self, provider: Any, endpoint: Optional[Tuple[str, int, bool]], *,
                    max_reply_bytes: int, pool_size: int, socket_timeout: float) -> Any:
        key = (endpoint or ("master",), max_reply_bytes)
        client = self._clients.get(key)
        if client is None:
            async with self._lock:
                client = self._clients.get(key)
                if client is None:
                    kwargs = provider._build_pool_kwargs(socket_timeout)
                    kwargs.update(max_connections=pool_size,
                                  parser_class=capped_parser(max_reply_bytes))
                    client = await _build(provider, endpoint, kwargs, socket_timeout)
                    self._clients[key] = client
        return client[0].select_graph(provider._graph_name)

    async def drop(self, endpoint: Optional[Tuple[str, int, bool]]) -> None:
        target = endpoint or ("master",)
        for key in [k for k in self._clients if k[0] == target]:
            await _close(self._clients.pop(key))

    async def aclose(self) -> None:
        clients, self._clients = list(self._clients.values()), {}
        for client in clients:
            await _close(client)


async def _build(provider: Any, endpoint: Optional[Tuple[str, int, bool]], kwargs: dict,
                 socket_timeout: float) -> Tuple[Any, Any]:
    from backend.app.providers.falkordb_connection import (
        build_graph_client,
        resolve_cluster_node_for_key,
    )

    cfg = provider._conn_cfg
    if endpoint is not None:
        host, port, readonly = endpoint
        return _node_client(cfg, host, port, kwargs, readonly=readonly)
    if cfg.mode == "cluster":
        # A single-node client at the graph's owner: a cluster client takes
        # no parser of ours. A reshard moves the graph, the query fails once,
        # and the next builds a client at the new owner.
        host, port = await resolve_cluster_node_for_key(cfg, provider._graph_name, socket_timeout)
        return _node_client(cfg, host, port, kwargs, readonly=False)
    return await build_graph_client(cfg, graph_name=provider._graph_name, pool_kwargs=kwargs)


def _node_client(cfg: Any, host: str, port: int, kwargs: dict, *, readonly: bool) -> Tuple[Any, Any]:
    from redis.asyncio import ConnectionPool, Redis

    from backend.app.providers.falkordb_connection import falkordb_over, tls_pool_kwargs

    extra = {"redis_connect_func": _readonly_handshake} if readonly else {}
    pool = ConnectionPool(host=host, port=port, **kwargs, **extra,
                          **tls_pool_kwargs(cfg.tls_settings()))
    return falkordb_over(Redis(connection_pool=pool)), pool


async def _readonly_handshake(connection: Any) -> None:
    """A cluster replica answers reads only on a connection that asked to."""
    await connection.on_connect()
    await connection.send_command("READONLY")
    if str_if_bytes(await connection.read_response()) != "OK":
        raise RedisConnectionError("The replica refused READONLY")


async def _close(client: Tuple[Any, Any]) -> None:
    from backend.app.providers.falkordb_connection import aclose_graph_client

    try:
        await asyncio.wait_for(aclose_graph_client(*client), timeout=2.0)
    except Exception:                                     # noqa: BLE001 — best effort
        logger.debug("FalkorDB native client close skipped", exc_info=True)


def _timed_out(server_ms: int) -> str:
    return (f"The query ran past its {server_ms / 1000:g}s limit. Narrow what it matches, or "
            f"allow it more time.")


def _size(size: int) -> str:
    return f"{size // _MIB} MiB" if size >= _MIB else f"{size:,} bytes"
