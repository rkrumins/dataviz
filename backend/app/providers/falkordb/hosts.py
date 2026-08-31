"""FalkorDB host/port resolution.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (lines 418-462 as of the package move).
"""
import os
from typing import Optional, Tuple


def _normalize_falkordb_host(host: Optional[str]) -> str:
    """Resolve a stored FalkorDB host to something actually reachable.

    1. **Docker→host rewrite** (opt-in): when the backend runs inside a
       container, a stored ``localhost`` / ``127.0.0.1`` points at the
       *container itself*, not the operator's FalkorDB, so the provider is
       falsely "down". Setting ``FALKORDB_DOCKER_LOCALHOST_REWRITE`` (e.g.
       ``host.docker.internal`` on Docker Desktop) redirects it to a
       reachable target. This is the Docker-direction sibling of
       ``LOCAL_DEV_FALKORDB_OVERRIDE`` (which rewrites the Docker hostname →
       localhost for host-run processes).
    2. **IPv4 pin**: otherwise pin the literal ``localhost`` to ``127.0.0.1``
       to dodge IPv6 ``::1`` dual-stack connect failures against IPv4-only
       Docker port publishing (opt out with ``FALKORDB_DISABLE_IPV4_NORMALIZE``).

    Other hostnames are left untouched.
    """
    h = host or "localhost"
    if h in ("localhost", "127.0.0.1"):
        rewrite = os.getenv("FALKORDB_DOCKER_LOCALHOST_REWRITE", "").strip()
        if rewrite:
            return rewrite
    if h == "localhost" and os.getenv(
        "FALKORDB_DISABLE_IPV4_NORMALIZE", ""
    ).strip().lower() not in ("1", "true", "yes"):
        return "127.0.0.1"
    return h


def resolve_falkordb_target(host: Optional[str], port: Optional[int]) -> Tuple[str, int]:
    """Single host/port resolution path for a FalkorDB provider.

    Composes ``apply_local_dev_falkordb_override`` (Docker hostname → host,
    opt-in for host-run dev processes) then ``_normalize_falkordb_host``
    (env Docker→host rewrite / IPv4 pin), in that exact order — the same
    composition every call site previously assembled inline (provider
    creation, projection registry resolve, registry key-list). Consolidating
    here is what guarantees a given ``(host, port)`` resolves to the SAME
    target in every process, so the read instance and the projection
    instance can no longer drift apart.
    """
    from backend.app.providers.manager import apply_local_dev_falkordb_override
    host, port = apply_local_dev_falkordb_override(host, port)
    host = _normalize_falkordb_host(host)
    return host, port
