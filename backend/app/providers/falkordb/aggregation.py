"""Aggregation run metadata and control-flow primitives.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (``AggRunMeta`` lines 16-30, ``AggregationBatchAbort``
lines 57-63, ``_completed`` lines 66-69, as of the package move).
``AggregationMixin`` (the methods that use these) lands in a later task;
this module exists now so both this task's imports and that later mixin
agree on where they live.
"""
from typing import NamedTuple, Optional


class AggRunMeta(NamedTuple):
    """Aggregation-run metadata resolved by ``_aggregation_run_meta``.

    ``regime``: 'cube' (every ancestor combination stored) or 'boundary'
    (canonical depth-diagonal only). ``stamp_version``: 2 = every stored
    :AGGREGATED edge carries sourceDepth/targetDepth; 1 = legacy stamps
    (depth unknown); 0 = env-forced, no stored contract. ``max_depth``:
    deepest containment depth stamped by the last run (None when
    unknown). ``last_materialized_at``: ISO timestamp of the last
    completed run (None = never / unknown)."""

    regime: str
    stamp_version: int
    max_depth: Optional[int]
    last_materialized_at: Optional[str]


class AggregationBatchAbort(Exception):
    """Raised when sustained provider failure makes continuing pointless.

    The worker's outer try/except marks the job ``status=failed`` and
    preserves ``last_cursor`` so the job can be resumed once the
    provider recovers.
    """


async def _completed(value):
    """A completed awaitable — lets asyncio.gather mix cached values with
    live queries without special-casing."""
    return value
