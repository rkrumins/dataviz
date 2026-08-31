"""Row <-> model mapping: kernel re-exports, plus the one that stays.

Every name here except ``_compute_searchable_text`` moved unchanged into
``backend.common.providers.rowmap`` under a public name (the pre-class
section of the former ``falkordb_provider.py``, lines 135-137 and 524-759
as of the package move); the aliases below bind the old private names to
the SAME objects so every existing ``from ...falkordb_provider import
_sanitize_label`` (etc.) call site keeps resolving to one shared function
and one shared mutable set, never a copy.

``_compute_searchable_text`` (lines 465-521) stays here instead of moving
to the kernel: it lazily imports ``backend.app.services.deep_search``, and
``backend/common/providers/`` has no dependency on ``backend.app`` today
and must not acquire one — the kernel is imported by the graph adapters
and by workers that do not mount the app.
"""
import json
from typing import Any, Dict, List, Optional

from backend.common.providers.rowmap import (
    sanitize_label,
    RESERVED_NODE_KEYS,
    split_user_properties,
    sanitize_node_properties,
    node_from_props,
    edge_from_row,
)

_sanitize_label = sanitize_label
_RESERVED_NODE_KEYS = RESERVED_NODE_KEYS
_split_user_properties = split_user_properties
_sanitize_node_properties = sanitize_node_properties
_node_from_props = node_from_props
_edge_from_row = edge_from_row


def _compute_searchable_text(
    display_name: Optional[str],
    qualified_name: Optional[str],
    description: Optional[str],
    user_properties: Optional[Dict[str, Any]],
    tags: Optional[List[str]] = None,
) -> str:
    """Build a lowercased, space-joined searchable string for n.searchableText.

    Includes displayName, qualifiedName, description, tags, and every
    string-valued user property value. Capped at
    ``DeepSearchSettings.searchable_text_cap_bytes`` (env
    ``DEEP_SEARCH_SEARCHABLE_TEXT_CAP``, default 8192) so a node with
    very large string properties can't bloat the denormalised field.

    ``tags`` is normally a list of strings, but some call sites only
    have the node's JSON-encoded ``n.tags`` string on hand (that's how
    tags are stored on the FalkorDB node) — a str is parsed via
    ``json.loads`` and used if it decodes to a list; any other type is
    ignored.

    Truncated at a word boundary when the cap fires so the tail
    doesn't end mid-token (a partial token would defeat
    ``CONTAINS '<word>'`` substring search).
    """
    parts: List[str] = []
    if display_name:
        parts.append(display_name)
    if qualified_name:
        parts.append(qualified_name)
    if description:
        parts.append(description)
    if user_properties:
        for value in user_properties.values():
            if isinstance(value, str):
                parts.append(value)
    if isinstance(tags, str):
        try:
            parsed_tags = json.loads(tags)
        except (TypeError, ValueError):
            parsed_tags = None
        tags = parsed_tags if isinstance(parsed_tags, list) else None
    if isinstance(tags, list):
        parts.extend(t for t in tags if isinstance(t, str) and t)
    result = " ".join(parts).lower()
    # Lazy import to avoid pulling settings into module import time
    # (this helper is hot — called on every write).
    from backend.app.services.deep_search import get_deep_search_settings
    cap = get_deep_search_settings().searchable_text_cap_bytes
    if len(result) <= cap:
        return result
    # Trim at the last word boundary <= cap so we never end mid-word.
    truncated = result[:cap]
    last_space = truncated.rfind(" ")
    if last_space > 0:
        truncated = truncated[:last_space]
    return truncated
