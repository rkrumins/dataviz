"""One definition of what a PARTIAL update to an entity means.

An update names only the fields it changes. Top-level fields replace; the
``properties`` bag is merged one level deep, so a property the update does not
mention is kept. Removing a property therefore has to be said explicitly:

* on the wire, as ``unsetProperties: [name, …]`` beside the payload;
* inside the service, as ``properties[name] = PROP_DELETE`` — the one internal
  form, shared with bulk import (``rowmodel``), which is how every write path
  (a draft save, the stage→commit checkpoint, a provider write-through, an
  import) applies a removal the same way.

A patch composed with another keeps its removals; a patch applied onto a real
value drops them; a full payload (a create) never carries one.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Optional

from backend.app.services.versioning.typed_merge import preserve_stored_type

__all__ = [
    "PROP_DELETE",
    "InvalidPatch",
    "normalize_update",
    "apply_patch",
    "compose_patches",
    "strip_deletes",
    "apply_properties_patch",
    "lift_top_level_node_fields",
    "MAX_UNSET",
    "MAX_PROPERTY_NAME",
]

#: Marks a property for removal inside a patch. Chosen so it can never collide
#: with real data; it never reaches storage (every apply strips it).
PROP_DELETE = "__nx_prop_delete__"

MAX_UNSET = 1000
MAX_PROPERTY_NAME = 512

#: Node fields that are TOP-LEVEL on the stored payload. A client that files one
#: under ``properties`` (older create flows did, for ``description``) would have
#: it stripped as a reserved key and lost; it is lifted instead.
_LIFTED_NODE_FIELDS = ("description", "qualifiedName", "sourceSystem")


class InvalidPatch(ValueError):
    """An update the service cannot apply as stated."""


def _is_delete(value: Any) -> bool:
    return isinstance(value, str) and value == PROP_DELETE


def normalize_update(payload: Optional[Mapping], unset: Optional[Iterable[str]]) -> dict:
    """The API boundary: an update payload plus ``unsetProperties`` → the internal patch.

    Validates the names, rejects a property both set and removed, and folds each
    removal into ``properties`` as :data:`PROP_DELETE`. A payload that already
    carries the marker (an older client, or a replayed bundle) is accepted as the
    same removal.
    """
    patch = dict(payload or {})
    names = list(unset or [])
    if not names:
        return patch
    if len(names) > MAX_UNSET:
        raise InvalidPatch(f"too many properties to unset ({len(names)} > {MAX_UNSET})")
    seen: Dict[str, None] = {}
    for name in names:
        if not isinstance(name, str) or not name or len(name) > MAX_PROPERTY_NAME:
            raise InvalidPatch(f"invalid property name to unset: {name!r}")
        seen.setdefault(name, None)
    props = dict(patch.get("properties") or {})
    both = sorted(k for k in seen if k in props and not _is_delete(props[k]))
    if both:
        raise InvalidPatch(f"properties both set and unset: {both}")
    for name in seen:
        props[name] = PROP_DELETE
    patch["properties"] = props
    return patch


def apply_patch(base: Optional[Mapping], patch: Mapping) -> dict:
    """Apply a partial update onto a concrete value.

    Top-level fields override; ``properties`` is merged one level deep; a
    property marked :data:`PROP_DELETE` is removed. The result never carries the
    marker. A key the base already has keeps its stored value when the patch sends
    the same value back in a lossier form (``typed_merge.preserve_stored_type``).
    """
    base = dict(base or {})
    out = {**base, **dict(patch)}
    if patch.get("properties") is not None or base.get("properties") is not None:
        out["properties"] = {k: v for k, v in _merge_props(base, patch).items()
                             if not _is_delete(v)}
    return out


def compose_patches(first: Mapping, second: Mapping) -> dict:
    """Two patches to one entity, in order, as one patch.

    The second's top-level fields win. Property entries merge with the second
    winning — KEEPING removal markers, so a removal in the first survives, and a
    value set by the second re-adds a property the first removed. A value the
    second re-sends in a lossier form keeps the first's, as two saves in turn would.
    """
    out = {**dict(first), **dict(second)}
    if first.get("properties") is not None or second.get("properties") is not None:
        out["properties"] = _merge_props(first, second)
    return out


def _merge_props(base: Mapping, patch: Mapping) -> dict:
    """``base``'s properties with ``patch``'s merged over them, key by key."""
    before = base.get("properties") or {}
    merged = dict(before)
    for k, v in (patch.get("properties") or {}).items():
        merged[k] = preserve_stored_type(before[k], v) if k in before else v
    return merged


def strip_deletes(payload: Optional[Mapping]):
    """A full payload with any removal marker dropped (a create has nothing to remove).

    Returns the same object when there is nothing to strip.
    """
    if not payload:
        return payload
    props = payload.get("properties")
    if not isinstance(props, Mapping) or not any(_is_delete(v) for v in props.values()):
        return payload
    out = dict(payload)
    out["properties"] = {k: v for k, v in props.items() if not _is_delete(v)}
    return out


def apply_properties_patch(existing: Optional[Mapping], patch: Optional[Mapping]) -> dict:
    """A property bag with a properties patch applied (a provider's edge bag)."""
    merged = {**(existing or {}), **(patch or {})}
    return {k: v for k, v in merged.items() if not _is_delete(v)}


def lift_top_level_node_fields(payload: Optional[Mapping]):
    """Move ``description`` / ``qualifiedName`` / ``sourceSystem`` filed under
    ``properties`` up to the top level (unless the top level already has one).

    Returns the same object when there is nothing to lift.
    """
    if not payload:
        return payload
    props = payload.get("properties")
    if not isinstance(props, Mapping) or not any(k in props for k in _LIFTED_NODE_FIELDS):
        return payload
    out = dict(payload)
    rest = dict(props)
    for key in _LIFTED_NODE_FIELDS:
        if key in rest:
            value = rest.pop(key)
            if out.get(key) in (None, "") and not _is_delete(value):
                out[key] = value
    out["properties"] = rest
    return out
