"""Spanner Graph provider package.

Exposes :class:`SpannerGraphProvider` so the manager can
``from backend.app.providers.spanner import SpannerGraphProvider`` and
the test suite can do the same.
"""
from .provider import SpannerGraphProvider

__all__ = ["SpannerGraphProvider"]
