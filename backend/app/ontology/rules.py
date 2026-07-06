"""Map a :class:`ResolvedOntology` to the versioning package's injected
:class:`OntologyRules` (management → graphver adapter).

The versioning package never imports the management DB or ontology models
(same decoupling as the projector's ``target_resolver``); this thin mapper is
the one place the two vocabularies meet. It is invoked at the API layer per
write request and the result is passed into ``GraphVersioningService`` calls
as ``ontology_rules=``.
"""
from __future__ import annotations

from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules

from .models import ResolvedOntology


def resolved_ontology_to_rules(resolved: ResolvedOntology) -> OntologyRules:
    """Build the rich commit-boundary rules from a resolved ontology.

    Edge-type keys are UPPERCASED (the validator's case-insensitive contract);
    entity-type keys keep their canonical casing.
    """
    entity_types = {
        type_id: EntityRule(can_contain=frozenset(entry.hierarchy.can_contain or []))
        for type_id, entry in (resolved.entity_type_definitions or {}).items()
    }
    edge_types = {
        type_id.upper(): EdgeRule(
            source_types=frozenset(entry.source_types or []),
            target_types=frozenset(entry.target_types or []),
            is_containment=bool(entry.is_containment),
        )
        for type_id, entry in (resolved.relationship_type_definitions or {}).items()
    }
    # UPPERCASE → declared casing, so the commit-boundary canonicalizer can restore the
    # ontology's exact spelling (edge_types/containment are keyed UPPERCASE). Relationship
    # ids win over the containment/lineage flat lists on a collision (the authoring guard
    # forbids case-insensitive duplicates, so they agree in practice).
    edge_type_canonical: dict = {}
    for names in (
        resolved.containment_edge_types or [],
        resolved.lineage_edge_types or [],
        list(resolved.relationship_type_definitions or {}),
    ):
        for t in names:
            if t:
                edge_type_canonical[t.upper()] = t
    return OntologyRules(
        entity_types=entity_types,
        edge_types=edge_types,
        containment_edge_types=frozenset(
            t.upper() for t in (resolved.containment_edge_types or [])
        ),
        edge_type_canonical=edge_type_canonical,
    )
