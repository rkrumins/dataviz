"""
Domain events for the ontology service.

Events are fired by OntologyService and consumed by other services (e.g.
ContextEngine, cache invalidation, audit log) through the in-process event bus.

Design:
- Events are immutable dataclasses.
- Handlers are simple async functions registered via subscribe().
- No external broker is required today; the bus can be swapped for Redis Pub/Sub
  or any AMQP broker when the service is extracted as a standalone process.
"""
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional, Type

logger = logging.getLogger(__name__)

Handler = Callable[[Any], Awaitable[None]]


# ---------------------------------------------------------------------------
# Event definitions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OntologyCreated:
    ontology_id: str
    name: str
    is_system: bool
    occurred_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class OntologyUpdated:
    ontology_id: str
    name: str
    version: int
    occurred_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class OntologyPublished:
    ontology_id: str
    name: str
    version: int
    occurred_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class OntologyDeleted:
    ontology_id: str
    occurred_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class DataSourceOntologyChanged:
    """Fired when a data source is assigned a different (or no) ontology."""
    workspace_id: str
    data_source_id: str
    old_ontology_id: Optional[str]
    new_ontology_id: Optional[str]
    occurred_at: datetime = field(default_factory=datetime.utcnow)


# ---------------------------------------------------------------------------
# In-process event bus
# ---------------------------------------------------------------------------


class OntologyEventBus:
    """
    Lightweight synchronous-dispatch event bus.
    Handlers are called in registration order; errors are logged, not propagated.
    """

    def __init__(self) -> None:
        self._handlers: Dict[Type, List[Handler]] = {}

    def subscribe(self, event_type: Type, handler: Handler) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    async def publish(self, event: Any) -> None:
        handlers = self._handlers.get(type(event), [])
        for handler in handlers:
            try:
                result = handler(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                logger.exception(
                    "Event handler %s failed for %s", handler, type(event).__name__
                )


# Process-wide singleton — import and use directly.
event_bus = OntologyEventBus()
