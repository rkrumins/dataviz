"""Row <-> GraphNode/GraphEdge mapping shared by every provider adapter.

Moved unchanged (apart from dropping the leading underscore to make each
name part of this module's public surface) from the pre-class section of
the former ``backend/app/providers/falkordb_provider.py`` — see
``backend/app/providers/falkordb/rowmap.py``, which re-exports these same
objects under their old private names so existing call sites keep
resolving to them without a copy.

Kernel hygiene: this module may import only ``json``, ``logging``, and
``backend.common.models.graph`` — no dependency on ``backend.app``. The
one function that needed one (``_compute_searchable_text``, which lazily
imports ``backend.app.services.deep_search``) stayed behind in the
FalkorDB package instead of moving here.
"""
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from backend.common.models.graph import GraphEdge, GraphNode

logger = logging.getLogger(__name__)


def sanitize_label(s: str) -> str:
    """Sanitize string for use as FalkorDB label/relationship type (alphanumeric + underscore)."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in str(s))


# Reserved node-key set — fields the provider writes directly onto a FalkorDB
# node. User-supplied `properties` keys that collide with these names are
# dropped at write time so provider state stays authoritative. Used by both
# the write-side split helper and the read-side reconstruction of the user
# `properties` dict (everything NOT in this set is a user property).
#
# `properties` is included because nodes upserted before the native-property
# refactor still carry the legacy JSON blob; the read path parses it as a
# transitional fallback, and the write path strips it on next write.
# `propertiesRaw` is the post-refactor escape hatch — a JSON-stringified
# dict of values that couldn't be written natively (nested objects, lists
# of dicts, etc.).
RESERVED_NODE_KEYS: frozenset = frozenset({
    "urn", "entityType", "displayName", "qualifiedName", "description",
    "tags", "layerAssignment", "childCount", "sourceSystem", "lastSyncedAt",
    "level", "levelDigest",
    # Denormalised internal fields the write paths SET directly on the node
    # (provider save + FalkorDB projector). They are NOT user properties and
    # not GraphNode fields, so without reserving them the read-path treats them
    # as user `properties` — surfacing `entityId` (the raw urn) and
    # `searchableText` ("<displayName> <qualifiedName> …") in the Properties
    # panel. This leak hit every node a post-merge full re-seed rewrote.
    "entityId", "searchableText",
    "properties",      # legacy blob — read path no longer hydrates from it
    "propertiesRaw",   # native escape hatch for non-scalar property values
    # Provenance written by the conformance stamp: which SOURCE property each
    # canonical value was filled from. They are what lets a re-pointed mapping
    # rewrite its own previous work without ever touching a node that carried a
    # native urn / displayName. Provider-owned bookkeeping, not user data.
    "urnSource", "nameSource",
})


# One-time warning latch (W1.3): logged once per provider boot when we
# encounter a pre-refactor node that still carries the ``n.properties``
# JSON blob. The read path no longer hydrates from the blob — operators
# run the backfill migration to surface those properties as native fields.
_logged_legacy_blob: bool = False


def split_user_properties(
    props: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], str]:
    """Split a user-supplied `properties` dict into (native_scalar, residual_json).

    Returns
    -------
    native_scalar : dict
        Keys whose values are FalkorDB-native (scalars or flat lists of
        scalars). Suitable for `SET n += $native_scalar` — each key becomes
        a real node property and is therefore indexable and Cypher-queryable.
    residual_json : str
        JSON-stringified dict of values that couldn't be written natively
        (nested dicts, lists of dicts, anything heterogenous). Always a
        string — empty dict serialises to "{}" so the SET clause always
        has a value and we don't need a separate REMOVE round-trip when
        the residual becomes empty on an upsert.

    Keys that collide with `RESERVED_NODE_KEYS` are dropped with a warning
    so user data can't shadow provider-owned fields like `urn` or `level`.
    `None` values are skipped (writing null would shadow an existing value).
    """
    native: Dict[str, Any] = {}
    residual: Dict[str, Any] = {}
    collided: List[str] = []
    for k, v in (props or {}).items():
        if v is None:
            continue
        if k in RESERVED_NODE_KEYS:
            collided.append(k)
            continue
        if isinstance(v, bool) or isinstance(v, (str, int, float)):
            native[k] = v
        elif isinstance(v, list) and all(
            isinstance(x, (str, int, float, bool)) for x in v
        ):
            native[k] = v
        else:
            residual[k] = v
    if collided:
        logger.warning(
            "user-property keys collided with reserved node keys, dropping: %s",
            collided,
        )
    return native, json.dumps(residual)


def sanitize_node_properties(payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Drop reserved keys from a node payload's nested ``properties`` dict on the WRITE path.

    The read path mirrors denormalised top-level fields (``childCount``, ``tags``, …) INTO
    ``properties``, and the canvas round-trips ``properties`` verbatim on save — so without this the
    stored version-row ``properties`` accumulates reserved keys, which the projector then drops one by
    one via :func:`split_user_properties`, logging ``user-property keys collided with reserved node
    keys`` for every node. Sanitising on write keeps stored payloads to exactly the keys the projector
    would keep, silencing that flood and closing the pollution channel (same class as the earlier
    ``{id, confidence}`` corruption). Only the nested ``properties`` is touched — legitimate top-level
    fields (``urn``/``displayName``/``childCount``/…) are untouched. Returns the original payload
    unchanged when nothing is reserved (so hashes for already-clean payloads are byte-identical)."""
    if not isinstance(payload, dict) or not isinstance(payload.get("properties"), dict):
        return payload
    props = payload["properties"]
    clean = {k: v for k, v in props.items() if k not in RESERVED_NODE_KEYS}
    if len(clean) == len(props):
        return payload
    return {**payload, "properties": clean}


def node_from_props(
    props: Dict[str, Any],
    entity_type_str: Optional[str] = None,
    identity_property: Optional[str] = None,
    name_property: Optional[str] = None,
) -> Optional[GraphNode]:
    """Build GraphNode from FalkorDB node properties.

    ``identity_property`` / ``name_property`` are the source's resolved
    node-identity mapping (see ``backend.app.services.node_identity``). They
    make this function the READ-TIME half of the mapping: an id-keyed graph
    hydrates correctly on the very next request, without waiting for an
    aggregation run to stamp ``urn`` onto its nodes — which is what a
    read-only source or a dedicated projection can never get.

    Reconstructs the user `properties` dict from two layers, in
    increasing priority (later wins):

      1. Non-reserved native keys on the node — written by the
         post-refactor ingest path. The source of truth.
      2. JSON-stringified residual in `props['propertiesRaw']` —
         non-scalar values that couldn't be written natively (nested
         dicts, lists of dicts). Layered on top of native because
         residual keys are disjoint from native keys by construction.

    The pre-refactor ``n.properties`` legacy JSON blob is no longer
    consulted (W1.3 / greenfield cleanup). Nodes that still carry
    that blob will lose those properties on read until the next
    write hydrates them as native fields — operators run
    ``backend/scripts/migrate_native_properties.py`` to backfill.
    A one-time WARNING surfaces if such a node is observed so the
    operator knows to run the migration.
    """
    if not props:
        return None
    # Identity: the canonical `urn` when the node has one, else the source's
    # URN-equivalent. Before this fallback existed, EVERY node on an id-keyed
    # graph was dropped here — silently, one `return None` at a time — so the
    # canvas showed an empty graph and the mapping looked like it did nothing.
    urn = props.get("urn")
    if not urn and identity_property and identity_property != "urn":
        urn = props.get(identity_property)
    if not urn:
        return None
    entity_type = entity_type_str or props.get("entityType", "unknown")

    if "properties" in props:
        # Pre-refactor node still carries the legacy blob. Flag it once
        # per provider boot so operators can run the backfill. The
        # warning is bounded by ``_logged_legacy_blob`` (module-level
        # set) so we don't spam the logs in production.
        global _logged_legacy_blob
        if not _logged_legacy_blob:
            logger.warning(
                "deep_search: node urn=%s still carries the pre-refactor "
                "n.properties JSON blob; run "
                "backend/scripts/migrate_native_properties.py to backfill. "
                "These properties are NOT visible to advanced search "
                "until migrated.",
                props.get("urn"),
            )
            _logged_legacy_blob = True

    user_props: Dict[str, Any] = {}
    for k, v in props.items():
        if k in RESERVED_NODE_KEYS:
            continue
        user_props[k] = v

    residual_blob = props.get("propertiesRaw")
    if isinstance(residual_blob, str) and residual_blob:
        try:
            residual_dict = json.loads(residual_blob)
            if isinstance(residual_dict, dict):
                user_props.update(residual_dict)
        except (json.JSONDecodeError, TypeError):
            pass

    try:
        return GraphNode(
            urn=str(urn),
            entityType=str(entity_type),
            # Onboarded third-party graphs often store the human name under
            # `name`/`title`/`label` rather than the platform's `displayName`,
            # which would otherwise render a BLANK node label. The source's
            # CONFIGURED name property goes first — that is the operator
            # telling us where the name lives, and it is the only thing that
            # can find a name under a key this list could never guess. The
            # common keys stay as the fallback for unmapped sources.
            displayName=(
                props.get("displayName")
                or (props.get(name_property) if name_property else None)
                or props.get("name")
                or props.get("title")
                or props.get("label")
                or ""
            ),
            qualifiedName=props.get("qualifiedName"),
            description=props.get("description"),
            properties=user_props,
            tags=json.loads(props["tags"]) if isinstance(props.get("tags"), str) else (props.get("tags") or []),
            layerAssignment=props.get("layerAssignment"),
            # DETERMINISTIC childCount (2026-08-20 ruling): the stored
            # property is an ingest-time snapshot that drifts as the graph
            # changes — it is NEVER a truth source. childCount is set ONLY
            # by the read paths that count real containment edges live
            # (get_nodes, get_nodes_batch, get_node, children fetches);
            # a path that cannot compute reports unknown, not stale.
            childCount=None,
            sourceSystem=props.get("sourceSystem"),
            lastSyncedAt=props.get("lastSyncedAt"),
        )
    except Exception as e:
        logger.warning(f"Failed to build GraphNode from props: {e}")
        return None


def edge_from_row(source_urn: str, target_urn: str, rel_type: str, props: Dict[str, Any]) -> GraphEdge:
    """Build GraphEdge from FalkorDB edge data."""
    edge_id = props.get("id") or f"{source_urn}|{rel_type}|{target_urn}"
    return GraphEdge(
        id=edge_id,
        sourceUrn=source_urn,
        targetUrn=target_urn,
        edgeType=str(rel_type),
        confidence=props.get("confidence"),
        properties=json.loads(props["properties"]) if isinstance(props.get("properties"), str) else (props.get("properties") or {}),
    )
