"""Shared logger for the falkordb provider package.

Every module in this package logs under the historic module path
``backend.app.providers.falkordb_provider`` — not ``__name__`` — because
caplog-based tests (e.g. ``test_ensure_indices_onboarding.py``) filter on
that exact logger name and would silently stop matching if a module here
logged under its own ``__name__`` instead.
"""
import logging

logger = logging.getLogger("backend.app.providers.falkordb_provider")
