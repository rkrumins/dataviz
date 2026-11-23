"""A port read from the environment (or any setting), the same way everywhere.

Kubernetes puts ``<SERVICE>_PORT=tcp://<cluster ip>:<port>`` into every pod for each Service in its
namespace (Docker's legacy links do the same), unless the pod turns service links off. A Service
named ``falkordb``, ``redis`` or ``postgres`` — as this repo's own manifests name them — therefore
sets ``FALKORDB_PORT`` to ``tcp://10.0.0.5:6379`` in any pod that doesn't set the variable itself,
and ``int()`` of that fails: it was why no blank graph could be created (the version store's
same-server check read ``FALKORDB_PORT``), in the Playground or anywhere else.

:func:`read_port` reads a port as a number, or as the port of such a link (or of a connection URL
for that store), and otherwise — a URL for something else, text — warns once, saying what the value
is without the value itself (a URL can carry a password), and answers ``None``: what reads it for a
comparison (which providers share a server) leaves it out rather than guess. :func:`port_of` and
:func:`env_port` use a default in its place, for what must connect somewhere.
"""
from __future__ import annotations

import logging
import os
from typing import Optional, Set, Union
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

#: Schemes whose port is the store's port: a service link (``tcp``) and the store's own URLs.
_SCHEMES = {"falkordb": frozenset({"tcp", "redis", "rediss", "falkor", "falkordb"}),
            "redis": frozenset({"tcp", "redis", "rediss"}),
            "postgres": frozenset({"tcp", "postgres", "postgresql"}),
            None: frozenset({"tcp"})}
_warned: Set[str] = set()


def read_port(value: Union[int, str], *, name: str, store: Optional[str] = None) -> Optional[int]:
    """The port ``value`` gives, or ``None`` when it gives none. A number from 1 to 65535 (an
    ``int``, or its digits): that number. A URL with a port — ``tcp://10.0.0.5:6379``, as a
    Kubernetes service link writes it, or ``store``'s own URL — that port. Anything else: ``None``,
    with a warning naming ``name`` (once per name). Callers handle "not set" themselves."""
    if isinstance(value, int):
        return value if 0 < value < 65536 else _unreadable(name, "a number that isn't a port")
    raw = str(value).strip()
    if raw.isdigit():
        return read_port(int(raw), name=name, store=store)
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:                       # ``.port`` raises on a port that isn't one
        return _unreadable(name, "a URL without a usable port")
    scheme = parts.scheme.lower()
    if port and scheme in _SCHEMES.get(store, _SCHEMES[None]):
        return port
    return _unreadable(name, f"a {scheme}:// URL" if scheme and parts.netloc else "not a number")


def port_of(value: Union[int, str, None], default: int, *, name: str, store: Optional[str] = None) -> int:
    """:func:`read_port`, with ``default`` when ``value`` is unset, blank or gives no port."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    port = read_port(value, name=name, store=store)
    return default if port is None else port


def env_port(name: str, default: int, *, store: Optional[str] = None) -> int:
    """:func:`port_of` the environment variable ``name``."""
    return port_of(os.getenv(name), default, name=name, store=store)


def _unreadable(name: str, what: str) -> None:
    if name not in _warned:
        _warned.add(name)
        logger.warning("%s is set to %s, not a port. Set it to the port alone (e.g. 6379).", name, what)
    return None
