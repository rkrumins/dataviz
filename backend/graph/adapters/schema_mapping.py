"""
Schema mapping layer for translating foreign graph database schemas
to Synodic's expected property model.

When connecting to an existing Neo4j (or other) database whose nodes use
property names like ``uuid``, ``title``, ``name`` instead of Synodic's
canonical ``urn``, ``displayName``, ``qualifiedName``, a SchemaMapping
object describes that translation so the provider can query and hydrate
GraphNode / GraphEdge objects transparently.

Configuration lives in ``extra_config.schemaMapping`` on either the
Provider (shared default) or the WorkspaceDataSource (per-workspace
override).  DataSource-level config wins when present.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SchemaMapping(BaseModel):
    """Configurable property mapping from a foreign graph schema to Synodic's
    canonical GraphNode / GraphEdge fields.

    Default values correspond to Synodic's own property schema so that no
    mapping is needed when the target database was populated via
    ``save_custom_graph``.
    """

    # ── Node identity ────────────────────────────────────────────────
    identity_field: str = Field(
        default="urn",
        description="Foreign property that maps to Synodic 'urn' (the primary identifier).",
    )

    # ── Display / descriptive fields ─────────────────────────────────
    display_name_field: str = Field(
        default="displayName",
        description="Foreign property that maps to 'displayName'.",
    )
    qualified_name_field: str = Field(
        default="qualifiedName",
        description="Foreign property that maps to 'qualifiedName'.",
    )
    description_field: str = Field(
        default="description",
        description="Foreign property that maps to 'description'.",
    )

    # ── Structured fields ────────────────────────────────────────────
    tags_field: str = Field(
        default="tags",
        description="Foreign property that holds tags (JSON array string or native list).",
    )
    properties_field: Optional[str] = Field(
        default="properties",
        description="Foreign property for the catch-all properties dict (JSON string or dict). "
                    "Set to None if the foreign schema stores all properties as top-level node properties.",
    )
    layer_field: str = Field(
        default="layerAssignment",
        description="Foreign property for layer assignment.",
    )
    source_system_field: str = Field(
        default="sourceSystem",
        description="Foreign property for source system identifier.",
    )
    last_synced_field: str = Field(
        default="lastSyncedAt",
        description="Foreign property for last-synced timestamp.",
    )

    # ── Entity type resolution ───────────────────────────────────────
    entity_type_strategy: str = Field(
        default="label",
        description="How to derive entity type: 'label' (from the first Neo4j label) "
                    "or 'property' (read from entity_type_field).",
    )
    entity_type_field: Optional[str] = Field(
        default="entityType",
        description="Foreign property to read entity type from when entity_type_strategy='property'.",
    )

    # ── Edge identity ────────────────────────────────────────────────
    edge_id_field: Optional[str] = Field(
        default="id",
        description="Foreign edge property for edge id. Falls back to '{src}|{type}|{tgt}' when absent.",
    )
    edge_confidence_field: Optional[str] = Field(
        default="confidence",
        description="Foreign edge property for confidence score.",
    )
    edge_properties_field: Optional[str] = Field(
        default="properties",
        description="Foreign edge property for the catch-all properties dict.",
    )

    # ── Collect-all mode ─────────────────────────────────────────────
    collect_unmapped_as_properties: bool = Field(
        default=True,
        description="When True, any foreign node properties not explicitly mapped above "
                    "are collected into the GraphNode.properties dict.",
    )

    # ================================================================
    # Factory helpers
    # ================================================================

    @classmethod
    def from_extra_config(cls, extra_config: Optional[Dict[str, Any]]) -> "SchemaMapping":
        """Parse a SchemaMapping from a provider/data-source ``extra_config`` dict.

        Returns defaults (native Synodic schema) when no mapping is present.
        """
        if not extra_config:
            return cls()
        raw = extra_config.get("schemaMapping")
        if not raw:
            return cls()
        if isinstance(raw, str):
            raw = json.loads(raw)
        return cls(**raw)

    @classmethod
    def merge(
        cls,
        provider_config: Optional[Dict[str, Any]],
        datasource_config: Optional[Dict[str, Any]],
    ) -> "SchemaMapping":
        """Build a SchemaMapping by layering data-source overrides on top of
        provider-level defaults.  DataSource values win on conflict.
        """
        base = cls.from_extra_config(provider_config)
        if not datasource_config or "schemaMapping" not in datasource_config:
            return base
        override_raw = datasource_config.get("schemaMapping", {})
        if isinstance(override_raw, str):
            override_raw = json.loads(override_raw)
        merged = base.model_dump()
        merged.update({k: v for k, v in override_raw.items() if v is not None})
        return cls(**merged)

    # ================================================================
    # Field-name resolver  (Synodic canonical name → foreign field)
    # ================================================================

    _SYNODIC_TO_ATTR = {
        "urn": "identity_field",
        "displayName": "display_name_field",
        "qualifiedName": "qualified_name_field",
        "description": "description_field",
        "tags": "tags_field",
        "properties": "properties_field",
        "layerAssignment": "layer_field",
        "sourceSystem": "source_system_field",
        "lastSyncedAt": "last_synced_field",
        "entityType": "entity_type_field",
    }

    def cypher_field(self, synodic_field: str) -> str:
        """Return the Neo4j property name that corresponds to a Synodic field.

        Example: if identity_field='uuid', then ``cypher_field('urn')`` → ``'uuid'``.
        """
        attr = self._SYNODIC_TO_ATTR.get(synodic_field)
        if attr:
            return getattr(self, attr) or synodic_field
        return synodic_field

    @property
    def is_default(self) -> bool:
        """True when all mappings match Synodic's native schema (no translation needed)."""
        return self == SchemaMapping()


# ====================================================================
# Node property translation
# ====================================================================

def map_node_props(
    raw_props: Dict[str, Any],
    labels: List[str],
    mapping: SchemaMapping,
) -> Dict[str, Any]:
    """Translate a foreign node's properties into Synodic's canonical dict
    suitable for passing to ``_node_from_props()``.

    Parameters
    ----------
    raw_props : dict
        Properties as they come from Neo4j (``dict(node)``).
    labels : list[str]
        Neo4j node labels (``list(node.labels)``).
    mapping : SchemaMapping
        Active schema mapping.

    Returns
    -------
    dict
        Dict with keys ``urn``, ``displayName``, ``entityType``, etc.
    """
    out: Dict[str, Any] = {}

    # Identity
    out["urn"] = raw_props.get(mapping.identity_field, "")

    # Display fields
    out["displayName"] = raw_props.get(mapping.display_name_field, "")
    out["qualifiedName"] = raw_props.get(mapping.qualified_name_field)
    out["description"] = raw_props.get(mapping.description_field)

    # Entity type
    if mapping.entity_type_strategy == "label":
        out["entityType"] = labels[0] if labels else "unknown"
    else:
        out["entityType"] = raw_props.get(mapping.entity_type_field or "entityType", "unknown")

    # Tags — may be JSON string or native list
    tags_raw = raw_props.get(mapping.tags_field)
    if isinstance(tags_raw, str):
        try:
            tags_raw = json.loads(tags_raw)
        except (json.JSONDecodeError, TypeError):
            tags_raw = []
    out["tags"] = tags_raw if isinstance(tags_raw, list) else []

    # Properties — may be JSON string, dict, or None
    if mapping.properties_field:
        props_raw = raw_props.get(mapping.properties_field)
        if isinstance(props_raw, str):
            try:
                props_raw = json.loads(props_raw)
            except (json.JSONDecodeError, TypeError):
                props_raw = {}
        out["properties"] = props_raw if isinstance(props_raw, dict) else {}
    else:
        out["properties"] = {}

    # Collect unmapped properties
    if mapping.collect_unmapped_as_properties:
        mapped_fields = {
            mapping.identity_field, mapping.display_name_field,
            mapping.qualified_name_field, mapping.description_field,
            mapping.tags_field, mapping.layer_field,
            mapping.source_system_field, mapping.last_synced_field,
        }
        if mapping.properties_field:
            mapped_fields.add(mapping.properties_field)
        if mapping.entity_type_field:
            mapped_fields.add(mapping.entity_type_field)
        for k, v in raw_props.items():
            if k not in mapped_fields and k not in out.get("properties", {}):
                out["properties"][k] = v

    # Layer, source system, last synced
    out["layerAssignment"] = raw_props.get(mapping.layer_field)
    out["sourceSystem"] = raw_props.get(mapping.source_system_field)
    out["lastSyncedAt"] = raw_props.get(mapping.last_synced_field)

    return out


def map_edge_props(
    raw_props: Dict[str, Any],
    mapping: SchemaMapping,
) -> Dict[str, Any]:
    """Translate a foreign edge's properties into Synodic's canonical dict
    suitable for passing to ``_edge_from_row()``.
    """
    out: Dict[str, Any] = {}
    out["id"] = raw_props.get(mapping.edge_id_field or "id")
    out["confidence"] = raw_props.get(mapping.edge_confidence_field or "confidence")

    if mapping.edge_properties_field:
        props_raw = raw_props.get(mapping.edge_properties_field)
        if isinstance(props_raw, str):
            try:
                props_raw = json.loads(props_raw)
            except (json.JSONDecodeError, TypeError):
                props_raw = {}
        out["properties"] = props_raw if isinstance(props_raw, dict) else {}
    else:
        out["properties"] = {}

    return out
