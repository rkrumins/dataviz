# Re-export from common kernel — preserves all existing imports unchanged.
# Providers inherit from GraphDataProvider via: from .base import GraphDataProvider
from backend.common.interfaces.provider import GraphDataProvider

__all__ = ["GraphDataProvider"]
