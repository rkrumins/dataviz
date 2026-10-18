"""KeyMigration (doc 14 §6), phase 1: a versioned graph's projection moves only between keys the
platform owns.

A platform key names its graph — ``gvp_<graphId>{<gid8>.<n>}``, the braces a cluster hash tag — so
no data source can bind it and no other graph can claim it. The swap itself is
``GraphVersioningService.move_projection``; the old key waits in ``projection_state.retired_keys``.
"""
from __future__ import annotations

import re


def owned_key(graph_id: str, n: int) -> str:
    """The ``n``-th platform key of ``graph_id``. Graph ids are ``graph_<ULID>``, so the tag is
    the ULID's random tail."""
    return f"gvp_{graph_id}{{{graph_id[-8:].lower()}.{n}}}"


def is_owned_key(graph_id: str, name: str) -> bool:
    """True when ``name`` is one of ``graph_id``'s platform keys (doc 14's
    ``^gvp_<gid>\\{[0-9a-z]{8}\\.\\d+\\}$``)."""
    return re.fullmatch(rf"gvp_{re.escape(graph_id)}\{{[0-9a-z]{{8}}\.\d+\}}", name) is not None
