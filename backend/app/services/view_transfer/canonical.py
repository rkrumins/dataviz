"""The portable, canonical form of a view, and the hash that proves it survived a trip.

A view's *definition* is ``views.config`` minus two kinds of key:

* ENVIRONMENT keys: ids, owners, visibility. They describe where a view lives rather than what
  it is, and mean nothing (or something wrong) in another environment.
* METADATA keys: name, description, icon, tags. They are the view's label, not its shape, and
  whoever imports it is free to change them. Keeping them out of the hash is what lets a
  renamed copy still prove it holds the same view.

Everything else is kept verbatim, including keys this module has never heard of, so a field
added next year round-trips through an environment that predates it.

The hash is SHA-256 over the canonical JSON (sorted keys, compact separators, UTF-8) of that
definition. It is computed here and nowhere else, never in the browser, so there is one
serialiser and one answer: two environments holding the same definition produce the same
bytes, and that equality is the round-trip guarantee.
"""
from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Optional

from backend.app.services.layout_config import derive_entity_scope, parse_reference_layout

#: Keys that describe where a view lives, not what it is.
ENVIRONMENT_KEYS = frozenset({
    "id", "workspaceId", "dataSourceId", "scopeKey", "workspaceName", "isFavourited",
    "isDefault", "visibility", "isPublic", "createdBy", "createdAt", "updatedAt",
    "contextModelId",
})

#: Keys that label a view. Carried beside the definition, never hashed.
METADATA_KEYS = frozenset({"name", "description", "icon", "tags"})

#: Temporary client-side keys for entities that were never saved (see the canvas's
#: ``pruneTempAssignments``). They can never resolve anywhere, so they never travel.
STAGED_URN_PREFIX = "urn:staged:"

HASH_PREFIX = "sha256:"


def _raw_reference_layout(config: dict) -> Optional[dict]:
    """The stored referenceLayout, at either of the two places it has lived."""
    layout = config.get("layout")
    if isinstance(layout, dict) and isinstance(layout.get("referenceLayout"), dict):
        return layout["referenceLayout"]
    legacy = config.get("referenceLayout")
    return legacy if isinstance(legacy, dict) else None


def _canonical_reference_layout(raw: dict) -> dict:
    """Up-convert a stored referenceLayout to the canonical shape, keeping its side fields.

    ``parse_reference_layout`` folds legacy ``entityAssignments`` and exact-URN rules into the
    flat assignment map. Its side fields (``displayRules``, ``defaultNodeSortMode`` and anything
    newer) are copied across untouched. A ``None`` inside an assignment entry means the same as
    the key being absent, so it is dropped: otherwise a view saved by the backend's normaliser
    and the same view saved by the browser's would hash differently.
    """
    parsed = parse_reference_layout({"layout": {"referenceLayout": raw}})
    out = {k: copy.deepcopy(v) for k, v in raw.items() if k not in ("layers", "assignments")}
    out["layers"] = copy.deepcopy(parsed.layers)
    out["assignments"] = {
        urn: {k: copy.deepcopy(v) for k, v in entry.items() if v is not None}
        for urn, entry in parsed.assignments.items()
        if urn and not urn.startswith(STAGED_URN_PREFIX)
    }
    return out


def portable_definition(config: Any, view_type: Optional[str] = None) -> dict:
    """The environment-free definition of a view, in canonical form.

    ``config`` is the full ``views.config`` dict; ``view_type`` fills ``layout.type`` when the
    config never recorded it. Idempotent: feeding the result back in returns an equal dict.
    Never mutates its input.
    """
    source = config if isinstance(config, dict) else {}
    definition = {
        key: copy.deepcopy(value)
        for key, value in source.items()
        if key not in ENVIRONMENT_KEYS and key not in METADATA_KEYS and key != "referenceLayout"
    }

    layout = definition.get("layout")
    layout = dict(layout) if isinstance(layout, dict) else {}
    raw = _raw_reference_layout(source)
    if raw is not None:
        layout["referenceLayout"] = _canonical_reference_layout(raw)
    if not isinstance(layout.get("type"), str) or not layout["type"]:
        layout["type"] = view_type or "graph"
    definition["layout"] = layout

    # Stamp the scope explicitly. Derived, it flips from 'all' to 'curated' the moment a
    # rule-driven view gains one assignment (see migration 20260920_1200_view_entity_scope).
    content = definition.get("content")
    content = dict(content) if isinstance(content, dict) else {}
    if content.get("entityScope") not in ("all", "curated"):
        content["entityScope"] = derive_entity_scope(source)
    definition["content"] = content
    return definition


def config_from_definition(definition: dict, *, icon: Optional[str] = None) -> dict:
    """The ``views.config`` to store for a definition: the definition plus its icon.

    The icon is metadata, so it is not part of the definition, but ``views`` has no icon
    column and the frontend reads it from ``config.icon``.
    """
    config = copy.deepcopy(definition)
    if icon:
        config["icon"] = icon
    return config


def canonical_json(value: Any) -> str:
    """Sorted keys, compact separators, UTF-8 text, and no NaN or Infinity."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def content_hash(definition: Any) -> str:
    """``sha256:<hex>`` of the canonical JSON of ``definition``."""
    digest = hashlib.sha256(canonical_json(definition).encode("utf-8")).hexdigest()
    return f"{HASH_PREFIX}{digest}"


def metadata_of(config: Any, *, name: str, description: Optional[str], tags: Optional[list],
                view_type: Optional[str]) -> dict:
    """The label a view carries beside its definition."""
    source = config if isinstance(config, dict) else {}
    icon = source.get("icon")
    return {
        "name": name,
        "description": description or None,
        "icon": icon if isinstance(icon, str) and icon else None,
        "tags": list(tags) if tags else [],
        "viewType": view_type or "graph",
    }
