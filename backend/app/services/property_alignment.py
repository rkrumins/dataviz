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

Scale contract
--------------
``analyze_property_storage`` issues exactly ONE bounded query per label — a
capped sample — and nothing else. It deliberately does **not** count.

An exact ``count(n) WHERE n.<container> IS NOT NULL`` is a non-indexable full
label scan; on a multi-million-node graph it blows its budget, and a swallowed
timeout reports zero affected nodes for precisely the graphs with the most
trapped properties. Instead the affected figure is EXTRAPOLATED from the
sample against the per-label totals the counts lane already caches
(``{graph}:stats_cache``) — zero additional graph work at any graph size. The
same trick, for the same reason, as
:meth:`FalkorDBProvider._estimate_lineage_edge_count`.

Even so, this runs in the insights service's deep pass (behind its admission
gate and large-graph budget), not on the request path — see
``insights_service/collector.py``. The web tier serves the cached result.
"""

from __future__ import annotations

import json
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


async def _label_totals(provider) -> Dict[str, int]:
    """Per-label node totals from the counts the stats lane already caches.

    Reads ``{graph}:stats_cache`` — the Redis key ``get_stats`` writes and the
    insights collector primes write-through — so this costs no graph work at
    any graph size. Returns ``{}`` when the cache is cold; callers then report
    a ratio without an absolute, which is honest, rather than paying an O(N)
    scan to invent one.
    """
    redis = getattr(provider, "_redis", None)
    ns = getattr(provider, "_cache_ns", None)
    if redis is None or not ns:
        return {}
    try:
        cached = await redis.get(f"{ns}:stats_cache")
        if not cached:
            return {}
        counts = (json.loads(cached) or {}).get("entityTypeCounts") or {}
        return {str(k): int(v) for k, v in counts.items()}
    except Exception:
        return {}


async def analyze_property_storage(
    provider,
    mapping: Optional[SchemaMapping] = None,
    *,
    label_totals: Optional[Dict[str, int]] = None,
    sample_per_label: int = 200,
    max_labels: int = 100,
    timeout_s: float = 30.0,
) -> Dict[str, Any]:
    """Per-label report of how this graph stores node properties.

    Returns the payload that drives the Mapping tab: what shape each label is
    in, which container keys were seen, what property paths unpacking would
    produce, roughly how many nodes are affected, and which physical fields
    collide with platform-reserved names.

    ONE bounded query per label; no counting. See the module docstring for why.
    ``timeout_s`` defaults to the stats budget rather than the 5s generic read
    default because this runs in the deep profiling pass, not on a request.

    ``label_totals`` supplies the per-label node counts the estimates
    extrapolate against. The insights collector passes the ones it just
    computed; anyone else leaves it out and the cached counts are read from
    Redis instead.

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
    if label_totals is None:
        label_totals = await _label_totals(provider)

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
                elif parsed:
                    # Only a container that actually HELD something counts as
                    # needing alignment. An empty one has nothing trapped in
                    # it, and flagging it would pitch the operator a rewrite
                    # that yields zero new searchable properties.
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

        # Affected nodes, EXTRAPOLATED — never counted. The sample gives the
        # ratio; the cached per-label total gives the size. ``None`` when the
        # counts cache is cold: the UI shows the ratio and says the total is
        # not known yet, which beats inventing a number or scanning for one.
        label_total = label_totals.get(label)
        affected_estimate: Optional[int] = None
        if sampled and label_total is not None:
            affected_estimate = round(container_nodes / sampled * label_total)

        if affected_estimate:
            total_affected += affected_estimate
        all_paths.update(inferred_paths)

        out_labels[label] = {
            "sampled": sampled,
            "containerSampled": container_nodes,
            "labelTotal": label_total,
            "storage": storage,
            "nativeKeys": sorted(native_keys),
            "containerKeys": sorted(container_keys_seen),
            "inferredPaths": sorted(inferred_paths),
            "affectedEstimate": affected_estimate,
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

    needs = sorted(
        lbl for lbl, info in out_labels.items()
        if info["storage"] in ("container", "mixed")
    )
    return {
        "containerKey": container_key,
        "separator": separator,
        "collectUnmapped": mapping.collect_unmapped_as_properties,
        "propertyOverrides": dict(mapping.property_overrides or {}),
        "labels": out_labels,
        "totals": {
            "labels": len(out_labels),
            # Extrapolated, not counted — see the module docstring. Null when
            # no label could be sized because the counts cache was cold.
            "affectedEstimate": total_affected if label_totals else None,
            "newPaths": len(all_paths),
            "needsAlignment": needs,
        },
        # Lets the UI say "from a 200-node sample per type" instead of
        # implying a precision the numbers above don't have.
        "samplePerLabel": sample_per_label,
        "sizedFromCache": bool(label_totals),
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

    ``newlySearchable`` lists the keys that are NOT already fields on the
    physical node and would become ones — the half a property bag can't show,
    and the actual payoff of running the alignment. It is computed against the
    node's real top-level keys rather than against ``before``: since the read
    path already hydrates the container, ``before`` and ``after`` are identical
    whenever the mapping itself hasn't changed, so diffing them would report
    nothing gained for exactly the graphs that have the most to gain.
    """
    from backend.app.providers.falkordb_provider import (
        _RESERVED_NODE_KEYS,
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

            # What is ALREADY a real field on the physical node — everything
            # else the aligned bag holds is currently trapped in a container.
            already_native = {
                k for k in props if k not in _RESERVED_NODE_KEYS
            }
            native_after, _ = _split_user_properties(after.properties)
            samples.append({
                "urn": before.urn,
                "label": label,
                "displayName": before.display_name,
                "before": before.properties,
                "after": after.properties,
                "newlySearchable": sorted(set(native_after) - already_native),
            })

    return {"samples": samples, "count": len(samples)}


# ---------------------------------------------------------------------------
# The alignment run — unpack containers into native fields, for real.
# ---------------------------------------------------------------------------

#: Nodes per internal-ID window. Matches ``stamp_identity_urns``'s stride.
#: The window bounds MEMORY, not row count: a sparse range yields few rows, a
#: dense one yields at most ``window`` — either way the working set is capped.
ALIGN_WINDOW = 50_000


async def run_alignment(
    provider,
    mapping: Optional[SchemaMapping] = None,
    *,
    window: int = ALIGN_WINDOW,
    start_id: int = 0,
    progress_cb=None,
    should_cancel=None,
    dry_run: bool = False,
    timeout_s: float = 120.0,
) -> Dict[str, Any]:
    """Unpack every nested property container into native FalkorDB fields.

    Walks the graph in **internal-ID windows** rather than enumerating URNs.
    The CLI script this replaces buffered every URN for a label into a Python
    list before touching anything — roughly a gigabyte of strings at 10M
    nodes, and an unbounded scan before the first write. ID windows cost
    constant memory at any graph size, need no property index (the reason
    ``stamp_identity_urns`` chose them), and make the run resumable: the
    caller persists ``lastId`` and passes it back as ``start_id``.

    Reads are windowed by ID; WRITES are keyed by ``urn``, which is indexed —
    so the enumeration is scan-free and the mutation is index-backed. A node
    with no ``urn`` cannot be written back safely and is counted in
    ``skippedNoUrn``; for an onboarded graph ``stamp_identity_urns`` is what
    puts one there, and it runs first.

    A container that does not parse is **left exactly as it is** and counted.
    The original script's ``REMOVE`` fired regardless, destroying the data it
    was meant to migrate.

    Returns running totals; ``progress_cb(stats)`` is invoked per window so a
    job can publish them, and ``should_cancel()`` is honoured between windows.
    """
    from backend.app.providers.falkordb_provider import (
        _compute_searchable_text,
        _split_user_properties,
    )

    mapping = mapping or SchemaMapping()
    container_key = mapping.properties_field
    separator = mapping.properties_separator
    overrides = mapping.property_overrides or {}

    stats: Dict[str, Any] = {
        "processed": 0,      # nodes seen carrying a container
        "aligned": 0,        # nodes actually rewritten
        "unparseable": 0,    # container present but not a dict — preserved
        "skippedNoUrn": 0,   # cannot key the write back
        "lastId": start_id,
        "maxId": 0,
        "cancelled": False,
        "dryRun": dry_run,
    }
    if not container_key:
        return stats

    safe_key = str(container_key).replace("`", "")

    try:
        res = await provider._ro_query(
            "MATCH (n) RETURN max(ID(n))", op="align.max_id",
        )
        rows = res.result_set or []
        max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
    except Exception as exc:
        logger.warning("property alignment: max-id probe failed: %s", exc)
        return stats
    stats["maxId"] = max_id
    if max_id < 0:
        return stats

    read_cypher = (
        f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
        f"AND n.`{safe_key}` IS NOT NULL "
        f"RETURN n.urn AS urn, n.`{safe_key}` AS blob, "
        f"n.displayName AS displayName, n.qualifiedName AS qualifiedName, "
        f"n.description AS description"
    )
    write_cypher = (
        f"UNWIND $batch AS item "
        f"MATCH (n {{urn: item.urn}}) "
        f"SET n += item.nativeProps, "
        f"    n.propertiesRaw = item.propertiesRaw, "
        f"    n.searchableText = item.searchableText "
        f"REMOVE n.`{safe_key}`"
    )

    lo = max(0, int(start_id))
    while lo <= max_id:
        if should_cancel is not None and should_cancel():
            stats["cancelled"] = True
            break
        hi = lo + window

        try:
            res = await provider._ro_query(
                read_cypher, params={"lo": lo, "hi": hi},
                timeout=timeout_s, op="align.read",
            )
            rows = res.result_set or []
        except Exception as exc:
            # One bad window must not abandon the run; the range is recorded
            # so a re-run revisits it.
            logger.warning(
                "property alignment: window [%d,%d) read failed (continuing): %s",
                lo, hi, exc,
            )
            lo = hi
            stats["lastId"] = lo
            continue

        batch = []
        for row in rows:
            stats["processed"] += 1
            urn, blob = row[0], row[1]
            container = coerce_container(blob)
            if container is None:
                # Not a property dict. Preserve it, say so, move on.
                stats["unparseable"] += 1
                continue
            if not urn:
                stats["skippedNoUrn"] += 1
                continue

            user_props = flatten_properties(container, separator)
            for src, dst in overrides.items():
                if src in user_props and dst not in user_props:
                    user_props[dst] = user_props.pop(src)
            native_props, residual = _split_user_properties(user_props)
            batch.append({
                "urn": urn,
                "nativeProps": native_props,
                "propertiesRaw": residual,
                # Recomputed in the SAME pass. The old script left this stale
                # and offered a separate, non-composable backfill flag for it.
                "searchableText": _compute_searchable_text(
                    row[2], row[3], row[4], user_props,
                ),
            })

        if batch and not dry_run:
            try:
                await provider._query(
                    write_cypher, params={"batch": batch},
                    timeout=timeout_s, op="align.write",
                )
                stats["aligned"] += len(batch)
            except Exception as exc:
                logger.warning(
                    "property alignment: window [%d,%d) write failed "
                    "(continuing): %s", lo, hi, exc,
                )
        elif batch:
            stats["aligned"] += len(batch)

        lo = hi
        stats["lastId"] = lo
        if progress_cb is not None:
            await progress_cb(dict(stats))

    return stats
