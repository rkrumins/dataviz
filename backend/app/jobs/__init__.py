"""Job platform package.

Producer-side seam (``JobEmitter``), consumer-side seam
(``JobEventConsumer``), broker abstraction (``JobBroker``), and
live-state store (``LiveStateStore``). All workers and SSE handlers
go through these interfaces; concrete Redis (or future Kafka,
Pub/Sub, NATS) implementations are selected by env at startup.

Quick start (producer):

    from backend.app.jobs import get_emitter
    emitter = get_emitter()
    await emitter.publish(
        job_id="agg_xyz",
        kind="aggregation",
        scope=JobScope(workspace_id=ws_id, data_source_id=ds_id),
        type="progress",
        live_state={"processed_edges": 5000, "total_edges": 60000, ...},
    )

Quick start (consumer):

    from backend.app.jobs import get_consumer
    from backend.app.jobs.broker import JobScope as Scope
    consumer = get_consumer()
    async for event in consumer.stream(Scope(job_id="agg_xyz"), from_sequence=0):
        ...

Backend selection:

* ``JOB_BROKER_BACKEND`` env: ``redis_streams`` (default), ``in_memory`` (tests)
* ``JOB_STATE_STORE_BACKEND`` env: ``redis_hash`` (default), ``in_memory`` (tests)

Adding a new broker/store is a single-file addition under
``brokers/`` or ``state_stores/`` plus a registration in this
module's factory. Producer/consumer code is untouched.

See ``docs/runbooks/jobs.md`` for on-call procedures.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

# Two distinct ``JobScope`` types intentionally live in different
# modules:
#
# * ``schemas.JobScope`` — the **producer-facing** scope (workspace_id,
#   data_source_id, provider_id, asset_name) carried on every event
#   envelope. Workers and emitters use this one. Re-exported here as
#   the unqualified ``JobScope``; producers ``from backend.app.jobs
#   import JobScope`` and get this version.
#
# * ``broker.JobScope`` — the **broker-facing** subscription-target
#   scope (just ``job_id``). Used internally by the consumer / SSE
#   handler when subscribing to a single job's stream. Re-exported
#   under the longer name ``BrokerJobScope`` so producer code never
#   accidentally uses it where a workspace/ds scope is needed.
from .broker import JobBroker, BackfillNotSupported  # noqa: F401
from .broker import JobScope as BrokerJobScope, TenantScope as BrokerTenantScope  # noqa: F401
from .consumer import JobEventConsumer
from .emitter import JobEmitter
from .schemas import (  # noqa: F401
    JobEvent,
    JobEventType,
    JobKind,
    JobScope,
    JobStatus,
)
from .state_store import LiveStateStore

logger = logging.getLogger(__name__)


# Process-singleton instances. The emitter holds an in-memory sequence
# counter per job_id, so it must be a singleton within a worker
# process. The broker / state store are stateless (or use external
# state), but we keep them as singletons too so connection pooling
# in the underlying clients isn't fragmented.
_broker: Optional[JobBroker] = None
_state_store: Optional[LiveStateStore] = None
_emitter: Optional[JobEmitter] = None
_consumer: Optional[JobEventConsumer] = None


def _build_broker() -> JobBroker:
    backend = os.getenv("JOB_BROKER_BACKEND", "redis_streams").strip().lower()
    if backend == "redis_streams":
        from backend.app.services.aggregation.redis_client import get_redis
        from .brokers.redis_streams import RedisStreamsJobBroker
        return RedisStreamsJobBroker(get_redis())
    if backend == "in_memory":
        from .brokers.in_memory import InMemoryJobBroker
        return InMemoryJobBroker()
    raise ValueError(
        f"Unknown JOB_BROKER_BACKEND={backend!r}. "
        f"Supported: redis_streams, in_memory."
    )


def _build_state_store() -> LiveStateStore:
    backend = os.getenv("JOB_STATE_STORE_BACKEND", "redis_hash").strip().lower()
    if backend == "redis_hash":
        from backend.app.services.aggregation.redis_client import get_redis
        from .state_stores.redis_hash import RedisHashLiveStateStore
        return RedisHashLiveStateStore(get_redis())
    if backend == "in_memory":
        from .state_stores.in_memory import InMemoryLiveStateStore
        return InMemoryLiveStateStore()
    raise ValueError(
        f"Unknown JOB_STATE_STORE_BACKEND={backend!r}. "
        f"Supported: redis_hash, in_memory."
    )


def get_broker() -> JobBroker:
    """Return the process-wide ``JobBroker`` singleton."""
    global _broker
    if _broker is None:
        _broker = _build_broker()
        logger.info(
            "Job platform broker initialised: backend=%s",
            os.getenv("JOB_BROKER_BACKEND", "redis_streams"),
        )
    return _broker


def get_state_store() -> LiveStateStore:
    """Return the process-wide ``LiveStateStore`` singleton."""
    global _state_store
    if _state_store is None:
        _state_store = _build_state_store()
        logger.info(
            "Job platform state store initialised: backend=%s",
            os.getenv("JOB_STATE_STORE_BACKEND", "redis_hash"),
        )
    return _state_store


def get_emitter() -> JobEmitter:
    """Return the process-wide ``JobEmitter`` singleton.

    Workers must reach for this — never construct ``JobEmitter``
    directly, never bypass to ``redis.xadd``."""
    global _emitter
    if _emitter is None:
        _emitter = JobEmitter(get_broker(), get_state_store())
    return _emitter


def get_consumer() -> JobEventConsumer:
    """Return the process-wide ``JobEventConsumer`` singleton.

    Used by the SSE endpoint and tests."""
    global _consumer
    if _consumer is None:
        _consumer = JobEventConsumer(get_broker())
    return _consumer


def reset_for_testing() -> None:
    """Test-only hook to drop cached singletons so a fresh broker
    selection (via env override) can be applied. Production code
    must not call this."""
    global _broker, _state_store, _emitter, _consumer
    _broker = None
    _state_store = None
    _emitter = None
    _consumer = None


__all__ = [
    "JobBroker",
    "JobEmitter",
    "JobEventConsumer",
    "JobEvent",
    "JobScope",            # schema scope (workspace_id, ds_id, ...)
    "BrokerJobScope",      # broker single-job subscription scope
    "BrokerTenantScope",   # broker per-tenant subscription scope
    "JobKind",
    "JobEventType",
    "JobStatus",
    "BackfillNotSupported",
    "LiveStateStore",
    "get_broker",
    "get_state_store",
    "get_emitter",
    "get_consumer",
    "reset_for_testing",
]
