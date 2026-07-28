"""Property-shape transforms — the pure half of physical→logical node mapping.

An onboarded third-party FalkorDB graph rarely stores user properties the way
the platform's own write path does (one native field per scalar, non-scalars in
``propertiesRaw``). It usually nests everything under a single container key —
``n.properties``, ``n.attributes``, ``n.metadata`` — as a JSON string or a map.

These helpers turn that shape into the flat ``key → value`` map the rest of the
stack expects. They are deliberately pure and dependency-free so the provider
read path, the analysis endpoint and the alignment runner can all share one
implementation and never drift — the same reason ``index_policy`` exists.

Flattening targets ``parent/child`` keys rather than preserving nested dicts,
because a flat key is a real, indexable FalkorDB property (so Advanced Search
can filter on it) AND ``PropertyEditor``'s ``groupByPath`` already renders a
flat map with ``/`` in the keys as an expandable folder tree. One shape serves
both.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Mapping, Optional

#: Separator that turns a nested path into a flat key. Mirrors
#: ``PATH_SEP`` in ``frontend/src/components/panels/PropertyEditor.tsx`` —
#: the folder tree only groups on this character, so a source configured
#: with anything else gets queryable keys that render flat.
DEFAULT_SEPARATOR = "/"

#: Nesting levels ``flatten_properties`` will descend before leaving the
#: remaining subtree intact as a value. Mirrors ``MAX_DEPTH`` in
#: ``PropertyEditor.tsx``, past which that component stops rendering rows
#: and falls back to a raw-JSON editor — flattening deeper would produce
#: keys the UI can't present as folders anyway.
MAX_FLATTEN_DEPTH = 6


def coerce_container(value: Any) -> Optional[Dict[str, Any]]:
    """Parse a property container into a dict, or return ``None``.

    Accepts the two shapes a container actually arrives in: a JSON string
    (how the platform's own legacy blob and most exporters write it) or a
    map/dict (how a driver may hand back a native map value).

    ``None`` means "this is not a property container" and callers MUST treat
    it as *preserve, do not touch*. The migration script's original bug was
    conflating "couldn't parse" with "empty", then issuing ``REMOVE`` — which
    silently destroyed the data it was supposed to migrate. A ``{}`` return
    (parsed fine, nothing inside) is a different answer from ``None``.
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def flatten_properties(
    props: Optional[Mapping[str, Any]],
    separator: str = DEFAULT_SEPARATOR,
    max_depth: int = MAX_FLATTEN_DEPTH,
) -> Dict[str, Any]:
    """Flatten nested dicts into ``parent<sep>child`` keys.

    ``{"technical": {"format": "parquet"}}`` → ``{"technical/format": "parquet"}``.

    What is NOT descended into, and why:

    * **Lists of scalars** stay at their path — FalkorDB stores them natively,
      so they are already indexable.
    * **Lists of dicts** and any other non-dict stay at their path as values;
      ``_split_user_properties`` routes them to ``propertiesRaw`` on write.
    * **Empty dicts** stay at their path as values, so the key is never lost.
    * **Anything past ``max_depth``** stays as a value rather than being
      dropped.

    Keys that already contain the separator are kept verbatim —
    ``buildPathTree`` filters empty segments, so they simply nest one level
    deeper visually. A source key that collides with a path this function
    generates is overwritten by plain dict assignment; the analyzer reports
    duplicate flattened paths so an operator can see it rather than having
    conflict resolution guessed for them here.
    """
    out: Dict[str, Any] = {}
    if not isinstance(props, Mapping):
        return out

    def _walk(node: Mapping[str, Any], prefix: str, depth: int) -> None:
        for raw_key, value in node.items():
            key = f"{prefix}{separator}{raw_key}" if prefix else str(raw_key)
            if isinstance(value, Mapping) and value and depth < max_depth:
                _walk(value, key, depth + 1)
            else:
                out[key] = value

    _walk(props, "", 1)
    return out


def coerce_tags(value: Any) -> list:
    """Turn a physical ``tags`` field into a list, tolerating every real shape.

    The read path used to call ``json.loads`` on any string here. A graph whose
    ``n.tags`` is a plain word (``"production"``) raised, which the caller's
    broad ``except`` swallowed by returning ``None`` for the WHOLE node — so
    the node vanished from every read rather than losing one field.

    Tolerates a native list, a JSON array string, or a single plain-string tag.
    Mirrors ``_accumulate_tag_values`` in ``falkordb_deep_search`` so the two
    paths agree on what a tag is.
    """
    if value is None:
        return []
    if isinstance(value, list):
        return [t for t in value if t is not None and t != ""]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                return []
            if isinstance(parsed, list):
                return [t for t in parsed if t is not None and t != ""]
            return []
        # Single tag stored as a plain string.
        return [stripped]
    return []


def apply_property_overrides(
    props: Dict[str, Any],
    overrides: Optional[Mapping[str, str]],
) -> Dict[str, Any]:
    """Rename property keys per an explicit physical→logical override map.

    This is how a physical field that collides with a platform-reserved name
    gets rescued: mapping ``{"level": "source/level"}`` moves the source's own
    ``level`` out of the way of the platform's hierarchy field, so it survives
    both the read filter and the write-path drop instead of disappearing.

    Overrides naming a key that isn't present are ignored. An override whose
    target already exists does not clobber it — the platform's value wins, and
    the rename is skipped, because silently overwriting is the failure mode
    this whole mapping layer exists to remove.
    """
    if not overrides:
        return props
    for source_key, target_key in overrides.items():
        if source_key not in props or not target_key:
            continue
        if target_key in props:
            continue
        props[target_key] = props.pop(source_key)
    return props
