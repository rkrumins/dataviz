"""Pure parsers for one node's ``INFO`` reply.

Every function here takes the dict redis-py hands back from ``INFO`` (or a
raw section text) and returns plain data — no I/O, no exceptions for a
missing field. Absence is normal: a replica omits ``connected_slaves``, a
managed instance can block a whole section, and an older server has fewer
fields. Every reader treats ``None`` as "not said", never as zero.

The replication figures are why this module exists. A rollup rebuild
writes to a master while its replicas re-apply every batch (see
``docs/FALKORDB_DEPLOYMENT.md``), so "how far behind is this replica, and
is its link even up" is the difference between a shard that keeps serving
and one Kubernetes restarts mid-run.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def as_int(value: Any) -> Optional[int]:
    """``int`` when the field is a number (or a numeric string), else None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    n = as_int(value)
    if n is not None:
        return bool(n)
    text = str(value).strip().lower()
    if text in ("yes", "true", "on"):
        return True
    if text in ("no", "false", "off"):
        return False
    return None


def parse_info_text(raw: Any) -> Dict[str, Any]:
    """``INFO`` as a flat dict, whatever the client handed back.

    redis-py parses ``INFO`` for us (including ``slaveN`` entries, which
    become dicts) — but a raw-mode client, a bytes reply, or a fake in a
    test may hand back the text, so parse it the same way here. Section
    headers (``# Replication``) are skipped; ``k=v,k=v`` values become
    nested dicts, exactly as redis-py does it.
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if not isinstance(raw, str):
        return {}
    out: Dict[str, Any] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        if "=" in value and "," in value:
            inner: Dict[str, Any] = {}
            for part in value.split(","):
                k, _, v = part.partition("=")
                inner[k.strip()] = v.strip()
            out[key.strip()] = inner
        else:
            out[key.strip()] = value.strip()
    return out


def memory_stats(info: Dict[str, Any]) -> Dict[str, Any]:
    """The memory picture of one node.

    ``usedPct`` is None when the node has no ``maxmemory`` — unlimited is
    unknowable, never "full" (the same rule the write budget applies).
    ``memClientsReplicas`` and ``memReplBacklog`` are what replication
    itself costs on this node: the buffers that overflow into a full
    resync when a rebuild outruns the replicas.
    """
    used = as_int(info.get("used_memory"))
    maxmemory = as_int(info.get("maxmemory"))
    return {
        "used": used,
        "rss": as_int(info.get("used_memory_rss")),
        "peak": as_int(info.get("used_memory_peak")),
        "maxmemory": maxmemory,
        "policy": info.get("maxmemory_policy"),
        "usedPct": (round(used / maxmemory * 100, 1)
                    if used is not None and maxmemory else None),
        "fragmentationRatio": as_float(info.get("mem_fragmentation_ratio")),
        "memClientsReplicas": as_int(info.get("mem_clients_slaves")),
        "memReplBacklog": as_int(info.get("mem_replication_backlog")),
    }


def server_stats(info: Dict[str, Any]) -> Dict[str, Any]:
    """Identity and liveness of one node.

    ``runId`` is the restart detector: it is regenerated on every start, so
    a changed ``runId`` between two snapshots proves the process restarted
    even when uptime is ambiguous.
    """
    return {
        "redisVersion": info.get("redis_version"),
        "uptimeS": as_int(info.get("uptime_in_seconds")),
        "runId": info.get("run_id"),
        "connectedClients": as_int(info.get("connected_clients")),
        "blockedClients": as_int(info.get("blocked_clients")),
        "opsPerSec": as_int(info.get("instantaneous_ops_per_sec")),
        "loading": _as_bool(info.get("loading")),
        "aofEnabled": _as_bool(info.get("aof_enabled")),
        "aofLastWriteStatus": info.get("aof_last_write_status"),
        "rdbLastBgsaveStatus": info.get("rdb_last_bgsave_status"),
        "bgsaveInProgress": _as_bool(info.get("rdb_bgsave_in_progress")),
        "aofRewriteInProgress": _as_bool(info.get("aof_rewrite_in_progress")),
        "latestForkUsec": as_int(info.get("latest_fork_usec")),
        # A resync is a fork plus a full dataset transfer; a growing count
        # under a rebuild is the shape of a replica that cannot keep up.
        "syncFull": as_int(info.get("sync_full")),
        "syncPartialOk": as_int(info.get("sync_partial_ok")),
        "syncPartialErr": as_int(info.get("sync_partial_err")),
    }


def _replica_entry(value: Any) -> Optional[Dict[str, Any]]:
    """One ``slaveN`` entry → ``{endpoint, ip, port, state, offset, lag}``."""
    if isinstance(value, str):
        value = parse_info_text(f"slave:{value}").get("slave")
    if not isinstance(value, dict):
        return None
    ip = value.get("ip")
    port = as_int(value.get("port"))
    if not ip or port is None:
        return None
    return {
        "endpoint": f"{ip}:{port}",
        "ip": str(ip),
        "port": port,
        "state": value.get("state"),
        "offset": as_int(value.get("offset")),
        "lagS": as_int(value.get("lag")),
    }


def replication_stats(info: Dict[str, Any]) -> Dict[str, Any]:
    """Role, link health and per-replica lag.

    On a master: ``connectedReplicas`` and one entry per replica with its
    replication offset — ``lagBytes`` is this master's offset minus the
    replica's, the only figure that says how much writing the replica has
    still to absorb. On a replica: the master it follows, whether the link
    is ``up``, and whether it is mid-sync (a full resync shows as
    ``masterSyncInProgress`` and is the expensive case).
    """
    role = info.get("role")
    master_offset = as_int(info.get("master_repl_offset"))
    replicas: List[Dict[str, Any]] = []
    for key, value in info.items():
        if not (isinstance(key, str) and key.startswith("slave") and key[5:].isdigit()):
            continue
        entry = _replica_entry(value)
        if entry is None:
            continue
        if master_offset is not None and entry.get("offset") is not None:
            entry["lagBytes"] = max(0, master_offset - int(entry["offset"]))
        replicas.append(entry)
    replicas.sort(key=lambda r: r["endpoint"])
    replica_offset = as_int(info.get("slave_repl_offset"))
    lag_bytes = None
    if role == "slave" and master_offset is not None and replica_offset is not None:
        lag_bytes = max(0, master_offset - replica_offset)
    master_host = info.get("master_host")
    master_port = as_int(info.get("master_port"))
    return {
        "role": "master" if role == "master" else ("replica" if role == "slave" else role),
        "masterEndpoint": (f"{master_host}:{master_port}"
                           if master_host and master_port is not None else None),
        "masterLinkStatus": info.get("master_link_status"),
        "masterSyncInProgress": _as_bool(info.get("master_sync_in_progress")),
        "masterLastIoS": as_int(info.get("master_last_io_seconds_ago")),
        "replOffset": master_offset if role == "master" else replica_offset,
        "lagBytes": lag_bytes,
        "connectedReplicas": as_int(info.get("connected_slaves")),
        "replicas": replicas,
    }


def parse_config_pairs(raw: Any) -> Dict[str, str]:
    """``CONFIG GET`` reply → ``{name: value}`` for every client shape."""
    out: Dict[str, str] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            out[_text(key)] = _text(value)
        return out
    if isinstance(raw, (list, tuple)):
        if raw and all(isinstance(i, (list, tuple)) and len(i) == 2 for i in raw):
            for name, value in raw:
                out[_text(name)] = _text(value)
        elif len(raw) % 2 == 0:
            for i in range(0, len(raw), 2):
                out[_text(raw[i])] = _text(raw[i + 1])
    return out


def _text(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return str(value)


def parse_memory_bytes(value: Any) -> Optional[int]:
    """A Redis size setting (``1gb``, ``268435456``) as bytes."""
    if value is None:
        return None
    n = as_int(value)
    if n is not None:
        return n
    text = _text(value).strip().lower()
    for suffix, factor in (("kb", 1024), ("mb", 1024 ** 2), ("gb", 1024 ** 3),
                           ("k", 1000), ("m", 1000 ** 2), ("g", 1000 ** 3)):
        if text.endswith(suffix):
            head = as_float(text[: -len(suffix)])
            return int(head * factor) if head is not None else None
    return None


def replica_output_buffer_hard_limit(config: Dict[str, str]) -> Optional[int]:
    """The replica class's HARD limit from ``client-output-buffer-limit``.

    The reply is one string — ``normal 0 0 0 slave 268435456 67108864 60
    pubsub …`` — and the replica (``slave``) class's first number is the
    hard limit: the master drops a replica whose buffer passes it, which
    forces a full resync. Under a rollup rebuild that is the difference
    between a replica that catches up and one that resyncs in a loop.
    """
    raw = config.get("client-output-buffer-limit")
    if not raw:
        return None
    parts = _text(raw).split()
    for i, part in enumerate(parts):
        if part.lower() in ("slave", "replica") and i + 1 < len(parts):
            return parse_memory_bytes(parts[i + 1])
    return None
