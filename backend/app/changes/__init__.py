"""The change feed — "something you are showing may have moved".

Nine always-mounted client surfaces each polled their own endpoint on
their own timer, and every one of them was asking a question whose
answer is almost always no. This package answers that question once, for
all of them, so the endpoints themselves are only called when there is
something to fetch.

Layout:

* :mod:`topics` — the topic vocabulary, and derivation of a caller's
  topic set from their identity. This is the authorization boundary.
* :mod:`registry` — the version counters, and ``bump`` / ``snapshot``.

The endpoints live in ``api/v1/endpoints/changes.py``.
"""
from .registry import ChangeRegistry, get_registry
from .publish import publish_change, publish_change_after_commit

__all__ = [
    "ChangeRegistry",
    "get_registry",
    "publish_change",
    "publish_change_after_commit",
]
