"""Property alignment — analyse how a graph physically stores node properties.

The platform's own write path gives every scalar user property its own native
FalkorDB field, so Advanced Search can index and filter on it. An onboarded
third-party graph almost never does that: it nests everything under one
container key. Those properties render (since the read path hydrates the
container) but stay invisible to search, because there is no field to index.

This module answers "what shape is this graph actually in, and what would
change if we aligned it?" — the read-only half. It samples nodes per label,
classifies the storage, and produces a before/after preview computed through
the REAL read path, so what an operator previews cannot drift from what they
will get.

Sampling cost matches ``/search/discover`` (one bounded query per label), so
callers can treat this as an ordinary synchronous endpoint.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from backend.app.providers.property_shapes import (
    coerce_container,
    flatten_properties,
)
from backend.graph.adapters.schema_mapping import SchemaMapping

logger = logging.getLogger(__name__)

#: Reserved keys the platform stamps onto foreign graphs itself, or that are
#: pure structure. Their presence says nothing about the source, so they are
#: never reported as collision candidates. Everything else in
#: ``_RESERVED_NODE_KEYS`` appearing on a container-shaped node most likely
#: came from the source — and is being silently shadowed on read and deleted
#: on write, which is what makes it worth surfacing.
_PLATFORM_STAMPED_KEYS = frozenset({
    "urn",             # stamp_identity_urns writes this on foreign graphs
    "displayName",     # ditto, from name_property
    "entityType",      # label-derived
    "properties",      # the container itself
    "propertiesRaw",   # native escape hatch
})

#: How many distinct sample values to keep per collision candidate. Enough for
#: an operator to recognise their own field, small enough to keep the payload
#: cheap.
_COLLISION_SAMPLE_CAP = 3

#: Cap on inferred paths reported per label, so a pathological container
#: (hundreds of keys) can't blow up the response.
_INFERRED_PATH_CAP = 200


def _classify(sampled: int, container_nodes: int, native_key_count: int) -> str:
    """Bucket a label's storage shape.

    ``empty``     — nothing sampled.
    ``container`` — every sampled node nests its properties; nothing native.
    ``mixed``     — some of each (mid-migration, or an inconsistent source).
    ``native``    — the platform's own shape; nothing to align.
    """
    if sampled == 0:
        return "empty"
    if container_nodes == 0:
        return "native"
    if container_nodes == sampled and native_key_count == 0:
        return "container"
    return "mixed"


async def analyze_property_storage(
    provider,
    mapping: Optional[SchemaMapping] = None,
    *,
    sample_per_label: int = 200,
    max_labels: int = 100,
    timeout_s: float = 5.0,
) -> Dict[str, Any]:
    """Per-label report of how this graph stores node properties.

    Returns the payload that drives the Mapping tab: what shape each label is
    in, which container keys were seen, what property paths unpacking would
    produce, how many nodes are affected, and which physical fields collide
    with platform-reserved names.

    Per-label failures are logged and skipped rather than failing the whole
    report — a single unreadable label should not blind the operator to the
    rest of the graph.
    """
    from backend.app.providers.falkordb_provider import _RESERVED_NODE_KEYS
    from backend.app.providers.falkordb_deep_search import _sanitize_label

    mapping = mapping or SchemaMapping()
    container_key = mapping.properties_field
    separator = mapping.properties_separator
    t0 = time.monotonic()

    try:
        res = await provider._ro_query_tolerant(
            "CALL db.labels() YIELD label RETURN label",
            params={}, timeout=timeout_s,
        )
        labels = [r[0] for r in (res.result_set or []) if r and r[0]]
    except Exception as exc:
        logger.warning("property analysis: CALL db.labels() failed: %s", exc)
        labels = []
    labels = labels[:max_labels]

    out_labels: Dict[str, Dict[str, Any]] = {}
    total_affected = 0
    all_paths: set = set()

    for label in labels:
        safe = _sanitize_label(label)
        try:
            res = await provider._ro_query_tolerant(
                f"MATCH (n:`{safe}`) WITH n LIMIT $lim RETURN n",
                params={"lim": int(sample_per_label)}, timeout=timeout_s,
            )
            rows = res.result_set or []
        except Exception as exc:
            logger.warning("property analysis: label=%s sample failed: %s", label, exc)
            continue

        sampled = len(rows)
        container_nodes = 0
        unparseable = 0
        native_keys: set = set()
        container_keys_seen: set = set()
        inferred_paths: set = set()
        collisions: Dict[str, List[Any]] = {}

        for row in rows:
            node = row[0] if row else None
            props = getattr(node, "properties", None) or {}
            if not isinstance(props, dict):
                continue

            if container_key and container_key in props:
                container_keys_seen.add(container_key)
                parsed = coerce_container(props[container_key])
                if parsed is None:
                    unparseable += 1
                else:
                    container_nodes += 1
                    for path in flatten_properties(parsed, separator):
                        if len(inferred_paths) < _INFERRED_PATH_CAP:
                            inferred_paths.add(path)

            for key, value in props.items():
                if key == container_key:
                    continue
                if key in _RESERVED_NODE_KEYS:
                    if key in _PLATFORM_STAMPED_KEYS or value is None:
                        continue
                    samples = collisions.setdefault(key, [])
                    if len(samples) < _COLLISION_SAMPLE_CAP and value not in samples:
                        samples.append(value)
                    continue
                native_keys.add(key)

        storage = _classify(sampled, container_nodes, len(native_keys))

        # Exact affected count — the sample tells us the shape, not the size,
        # and an operator about to rewrite a graph deserves the real number.
        affected = 0
        if container_key and container_nodes:
            try:
                res = await provider._ro_query_tolerant(
                    f"MATCH (n:`{safe}`) WHERE n.`{container_key}` IS NOT NULL "
                    f"RETURN count(n)",
                    params={}, timeout=timeout_s,
                )
                rs = res.result_set or []
                affected = int(rs[0][0]) if rs and rs[0] else 0
            except Exception as exc:
                logger.warning(
                    "property analysis: label=%s count failed: %s", label, exc,
                )

        total_affected += affected
        all_paths.update(inferred_paths)

        out_labels[label] = {
            "sampled": sampled,
            "storage": storage,
            "nativeKeys": sorted(native_keys),
            "containerKeys": sorted(container_keys_seen),
            "inferredPaths": sorted(inferred_paths),
            "affectedNodes": affected,
            "unparseable": unparseable,
            "collisions": [
                {
                    "field": field,
                    "samples": samples,
                    "suggested": f"source{separator}{field}",
                }
                for field, samples in sorted(collisions.items())
            ],
        }

    return {
        "containerKey": container_key,
        "separator": separator,
        "collectUnmapped": mapping.collect_unmapped_as_properties,
        "propertyOverrides": dict(mapping.property_overrides or {}),
        "labels": out_labels,
        "totals": {
            "labels": len(out_labels),
            "affectedNodes": total_affected,
            "newPaths": len(all_paths),
            "needsAlignment": sorted(
                lbl for lbl, info in out_labels.items()
                if info["storage"] in ("container", "mixed")
            ),
        },
        "elapsedMs": int((time.monotonic() - t0) * 1000),
    }


async def preview_alignment(
    provider,
    proposed: SchemaMapping,
    *,
    current: Optional[SchemaMapping] = None,
    labels: Optional[List[str]] = None,
    limit: int = 5,
    timeout_s: float = 5.0,
) -> Dict[str, Any]:
    """Before/after property bags for a handful of real nodes. Writes nothing.

    Both sides go through ``_node_from_props`` — the same function the drawer's
    payload comes from — so the preview cannot drift from what the operator
    will actually see. ``before`` uses the mapping in force today; ``after``
    uses the one being proposed.

    ``nativeAfter`` lists the keys that become real, indexable FalkorDB fields
    once the alignment job runs; that is the half the preview can't show by
    rendering a property bag, and it is what makes the properties searchable.
    """
    from backend.app.providers.falkordb_provider import (
        _node_from_props,
        _split_user_properties,
    )
    from backend.app.providers.falkordb_deep_search import _sanitize_label

    current = current or SchemaMapping()

    if not labels:
        try:
            res = await provider._ro_query_tolerant(
                "CALL db.labels() YIELD label RETURN label",
                params={}, timeout=timeout_s,
            )
            labels = [r[0] for r in (res.result_set or []) if r and r[0]][:5]
        except Exception as exc:
            logger.warning("property preview: label discovery failed: %s", exc)
            labels = []

    samples: List[Dict[str, Any]] = []
    for label in labels:
        if len(samples) >= limit:
            break
        safe = _sanitize_label(label)
        try:
            res = await provider._ro_query_tolerant(
                f"MATCH (n:`{safe}`) WITH n LIMIT $lim RETURN n",
                params={"lim": int(limit)}, timeout=timeout_s,
            )
            rows = res.result_set or []
        except Exception as exc:
            logger.warning("property preview: label=%s sample failed: %s", label, exc)
            continue

        for row in rows:
            if len(samples) >= limit:
                break
            node = row[0] if row else None
            props = getattr(node, "properties", None) or {}
            if not isinstance(props, dict) or "urn" not in props:
                continue

            before = _node_from_props(dict(props), label, current)
            after = _node_from_props(dict(props), label, proposed)
            if before is None or after is None:
                continue

            native_after, _ = _split_user_properties(after.properties)
            samples.append({
                "urn": before.urn,
                "label": label,
                "displayName": before.display_name,
                "before": before.properties,
                "after": after.properties,
                "nativeAfter": sorted(native_after),
            })

    return {"samples": samples, "count": len(samples)}
