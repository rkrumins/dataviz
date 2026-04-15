"""Shared adapter primitives for bulkheading external systems.

Any outbound-network dependency (graph provider, HTTP client, vector DB, etc.)
should wrap its concrete adapter in :class:`CircuitBreakerProxy` so that a
failing downstream cannot cascade into the web tier or starve the event loop.
"""

from .circuit import CircuitBreakerProxy, ProviderUnavailable

__all__ = ["CircuitBreakerProxy", "ProviderUnavailable"]
