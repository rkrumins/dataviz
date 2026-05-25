"""Advanced-search core. Provider-agnostic compiler + executor + settings.

This package will grow to host the relocated compiler, executor, discovery,
cursor codec, and the minimal DeepSearchProvider Protocol (W0.3). Today it
exposes the settings dataclass (W0.2).
"""
from backend.app.services.deep_search.settings import (
    DeepSearchSettings,
    get_deep_search_settings,
)

__all__ = ["DeepSearchSettings", "get_deep_search_settings"]
