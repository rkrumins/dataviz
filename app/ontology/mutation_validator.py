"""
Centralized mutation validator.

All node and edge create/update/delete operations must pass through
validate_node_mutation() or validate_edge_mutation() before being written
to the graph provider.  This ensures the ontology is the single gate for
allowed mutations — no scattered ad-hoc checks.

Design
------
- Takes a ResolvedOntology (already in memory after the resolve() call in ContextEngine).
- Returns a MutationResult with ok=True or ok=False + list of human-readable errors.
- Pure functions — no I/O, easily unit-tested.
- Used by:
    - ContextEngine.create_node()
    - Graph endpoint PATCH /nodes/:urn
    - Graph endpoint DELETE /nodes/:urn
    - Graph endpoint POST /edges  (Phase H)
    - Graph endpoint PATCH /edges/:id
    - Graph endpoint DELETE /edges/:id
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional

from .models import ResolvedOntology


# ─── Public contracts ─────────────────────────────────────────────────────────

class MutationOp(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"


@dataclass(frozen=True)
class MutationResult:
    ok: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @classmethod
    def success(cls, warnings: Optional[List[str]] = None) -> "MutationResult":
        return cls(ok=True, warnings=warnings or [])

    @classmethod
    def failure(cls, *errors: str, warnings: Optional[List[str]] = None) -> "MutationResult":
        return cls(ok=False, errors=list(errors), warnings=warnings or [])


# ─── Node validation ─────────────────────────────────────────────────────────

def validate_node_mutation(
    op: MutationOp,
    entity_type: str,
    ontology: ResolvedOntology,
    *,
    parent_entity_type: Optional[str] = None,
    existing_entity_type: Optional[str] = None,
) -> MutationResult:
    """
    Validate a node mutation against the resolved ontology.

    Parameters
    ----------
    op:                  CREATE | UPDATE | DELETE
    entity_type:         The entity type of the node being mutated.
    ontology:            The resolved ontology in scope.
    parent_entity_type:  For CREATE with a parent — the parent's entity type.
    existing_entity_type: For UPDATE — the current entity type (type changes disallowed).
    """
    errors: List[str] = []
    warnings: List[str] = []

    # entity_type_definitions is a dict (type_id → EntityTypeDefEntry) on ResolvedOntology
    known_types = set(ontology.entity_type_definitions.keys())

    if op == MutationOp.CREATE:
        if entity_type not in known_types:
            errors.append(
                f"Entity type '{entity_type}' is not defined in the active ontology. "
                f"Known types: {sorted(known_types)}"
            )
        if parent_entity_type is not None and entity_type in known_types:
            if parent_entity_type not in known_types:
                errors.append(
                    f"Parent entity type '{parent_entity_type}' is not defined in the active ontology."
                )
            else:
                # Check containment rule: parent's can_contain must include child type
                parent_def = ontology.entity_type_definitions.get(parent_entity_type)
                if parent_def is not None:
                    allowed_children = set(parent_def.hierarchy.can_contain)
                    # Empty can_contain means the type cannot contain anything.
                    # Non-empty means only those listed types are allowed.
                    if entity_type not in allowed_children:
                        errors.append(
                            f"Ontology does not allow '{parent_entity_type}' to contain '{entity_type}'. "
                            + (
                                f"Allowed children: {sorted(allowed_children)}"
                                if allowed_children
                                else f"'{parent_entity_type}' cannot contain any child nodes."
                            )
                        )

    elif op == MutationOp.UPDATE:
        if entity_type not in known_types:
            warnings.append(
                f"Entity type '{entity_type}' is not in the active ontology. "
                "The node may have been created with an older ontology version."
            )
        if existing_entity_type and existing_entity_type != entity_type:
            errors.append(
                f"Changing entity type from '{existing_entity_type}' to '{entity_type}' is not allowed. "
                "Delete and recreate the node instead."
            )

    elif op == MutationOp.DELETE:
        if entity_type not in known_types:
            warnings.append(
                f"Entity type '{entity_type}' is not in the active ontology; proceeding with delete."
            )

    if errors:
        return MutationResult.failure(*errors, warnings=warnings)
    return MutationResult.success(warnings=warnings)


# ─── Edge validation ──────────────────────────────────────────────────────────

def validate_edge_mutation(
    op: MutationOp,
    edge_type: str,
    source_entity_type: str,
    target_entity_type: str,
    ontology: ResolvedOntology,
) -> MutationResult:
    """
    Validate an edge mutation against the resolved ontology.

    Parameters
    ----------
    op:                  CREATE | UPDATE | DELETE
    edge_type:           The relationship type (e.g. "CONTAINS", "FLOWS_TO").
    source_entity_type:  Entity type of the source node.
    target_entity_type:  Entity type of the target node.
    ontology:            The resolved ontology in scope.
    """
    errors: List[str] = []
    warnings: List[str] = []

    # relationship_type_definitions is a dict (type_id → RelationshipTypeDefEntry)
    rel_by_id = {k.upper(): v for k, v in ontology.relationship_type_definitions.items()}
    edge_upper = edge_type.upper()

    if op == MutationOp.DELETE:
        # DELETE is always allowed; no schema check needed
        return MutationResult.success()

    rel_def = rel_by_id.get(edge_upper)

    if rel_def is None:
        if op == MutationOp.CREATE:
            errors.append(
                f"Relationship type '{edge_type}' is not defined in the active ontology. "
                f"Known types: {sorted(rel_by_id.keys())}"
            )
        else:
            warnings.append(
                f"Relationship type '{edge_type}' is not in the active ontology. "
                "The edge may have been created with an older ontology version."
            )
    else:
        # rel_def is a RelationshipTypeDefEntry; use .source_types / .target_types
        src_types = rel_def.source_types or []
        tgt_types = rel_def.target_types or []
        # Source type constraint
        if src_types and source_entity_type not in src_types:
            errors.append(
                f"'{source_entity_type}' is not a valid source for relationship '{edge_type}'. "
                f"Allowed sources: {sorted(src_types)}"
            )
        # Target type constraint
        if tgt_types and target_entity_type not in tgt_types:
            errors.append(
                f"'{target_entity_type}' is not a valid target for relationship '{edge_type}'. "
                f"Allowed targets: {sorted(tgt_types)}"
            )

    if errors:
        return MutationResult.failure(*errors, warnings=warnings)
    return MutationResult.success(warnings=warnings)


# ─── Containment cycle guard ──────────────────────────────────────────────────

def would_create_containment_cycle(
    new_parent_urn: str,
    child_urn: str,
    existing_containment: dict[str, str],   # child_urn → parent_urn
) -> bool:
    """
    Returns True if adding (new_parent_urn → child_urn) would create a cycle
    in the containment hierarchy.

    existing_containment maps child → parent for all current containment edges.
    """
    # Walk up from new_parent; if we reach child_urn the operation is circular
    visited = set()
    cursor = new_parent_urn
    while cursor:
        if cursor == child_urn:
            return True
        if cursor in visited:
            break
        visited.add(cursor)
        cursor = existing_containment.get(cursor)
    return False
