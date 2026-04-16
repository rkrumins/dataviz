"""
Aggregation Service — self-contained package.

All aggregation logic lives here. Zero imports from the monolith's
API, auth, middleware, or main.py layers.

Allowed imports:
    ✔ common/interfaces/provider.py   (GraphDataProvider protocol)
    ✔ common/models/                  (shared Pydantic base models)
    ✔ app/db/engine.py                (Base, session factory)
    ✔ app/registry/provider_registry  (ProviderRegistry)

Forbidden imports:
    ✗ app/api/          (FastAPI endpoints)
    ✗ app/auth/         (authentication)
    ✗ app/middleware/    (HTTP middleware)
    ✗ app/main.py       (FastAPI app instance)
    ✗ app/graphql/      (GraphQL layer)
"""
from .dispatcher import (
    AggregationDispatcher,
    InProcessDispatcher,
    RedisStreamDispatcher,
    DualDispatcher,
)
from .service import AggregationService
from .worker import AggregationWorker
from .scheduler import AggregationScheduler
from .models import AggregationJobORM
from .schemas import (
    AggregationTriggerRequest,
    AggregationSkipRequest,
    AggregationScheduleRequest,
    AggregationJobResponse,
    PaginatedJobsResponse,
    DataSourceReadinessResponse,
    DriftCheckResponse,
)

__all__ = [
    "AggregationDispatcher",
    "InProcessDispatcher",
    "RedisStreamDispatcher",
    "DualDispatcher",
    "AggregationService",
    "AggregationWorker",
    "AggregationScheduler",
    "AggregationJobORM",
    "AggregationTriggerRequest",
    "AggregationSkipRequest",
    "AggregationScheduleRequest",
    "AggregationJobResponse",
    "PaginatedJobsResponse",
    "DataSourceReadinessResponse",
    "DriftCheckResponse",
]
