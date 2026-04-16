"""
Process role for the Synodic backend.

Controls which subsystems start in the FastAPI lifespan:

* ``WEB`` — HTTP API, auth, reads, lightweight writes. Fully stateless.
* ``WORKER`` — Aggregation execution, heavy provider I/O (future: Redis Stream consumer).
* ``CONTROLPLANE`` — Scheduler, outbox relay, crash recovery. Singleton.
* ``DEV`` — All-in-one for local development (current default behaviour).

Set via the ``SYNODIC_ROLE`` environment variable. Defaults to ``dev``.
"""

import os
import logging
from enum import Enum

logger = logging.getLogger(__name__)


class SynodicRole(str, Enum):
    WEB = "web"
    WORKER = "worker"
    CONTROLPLANE = "controlplane"
    DEV = "dev"


_current_role: SynodicRole | None = None


def current_role() -> SynodicRole:
    """Read and cache the process role from ``SYNODIC_ROLE`` env var."""
    global _current_role
    if _current_role is not None:
        return _current_role

    raw = os.getenv("SYNODIC_ROLE", "dev").lower().strip()
    try:
        _current_role = SynodicRole(raw)
    except ValueError:
        logger.warning(
            "Unknown SYNODIC_ROLE=%r — falling back to 'dev'. "
            "Valid roles: %s",
            raw,
            ", ".join(r.value for r in SynodicRole),
        )
        _current_role = SynodicRole.DEV

    logger.info("Synodic process role: %s", _current_role.value)
    return _current_role


def runs_scheduler() -> bool:
    """True if this process should run the aggregation scheduler."""
    return current_role() in (SynodicRole.DEV, SynodicRole.CONTROLPLANE)


def runs_worker() -> bool:
    """True if this process should run the aggregation worker."""
    return current_role() in (SynodicRole.DEV, SynodicRole.WORKER)


def runs_recovery() -> bool:
    """True if this process should recover interrupted jobs at startup."""
    return current_role() in (SynodicRole.DEV, SynodicRole.CONTROLPLANE)
