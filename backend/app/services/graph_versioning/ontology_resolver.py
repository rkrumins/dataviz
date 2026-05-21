"""Cross-DB ontology resolution for strict-mode graph commits.

The authored-graph engine lives in the Graph Store DB; ontologies live
in the management DB. This module bridges them with a single, pure
helper: given an :class:`OntologyORM` loaded from the management
session, project the membership sets the validator needs into an
:class:`OntologySpec`.

Pure (no I/O). The caller — typically the API endpoint, which already
holds the management session — is responsible for the lookup itself.
Centralising the projection ensures every site that builds a spec
honours the same containment/lineage classification rules, so strict-
mode behaviour stays single-sourced (see plan item A.1 + A.2).
"""
from __future__ import annotations

import json
from typing import Any

from backend.app.db.models import OntologyORM
from backend.app.services.graph_versioning.validation import OntologySpec


def _load_list(raw: str | None) -> list[Any]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return v if isinstance(v, list) else []


def _load_dict(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        v = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return v if isinstance(v, dict) else {}


def to_spec(orm: OntologyORM) -> OntologySpec:
    """Project a stored ontology into the validator's thin spec.

    Entity / relationship membership is taken from the rich
    ``*_definitions`` columns (the source of truth post-Phase 1+),
    falling back to the flat legacy lists when definitions are empty.
    Containment / lineage classification is taken from the dedicated
    columns; an ontology that pre-dates the classification yields
    empty frozensets, which the validator treats as "no DAG check"
    (back-compat preserved)."""
    entity_defs = _load_dict(orm.entity_type_definitions)
    rel_defs = _load_dict(orm.relationship_type_definitions)
    legacy_containment = _load_list(orm.containment_edge_types)
    legacy_lineage = _load_list(orm.lineage_edge_types)

    if entity_defs:
        entity_types = frozenset(entity_defs.keys())
    else:
        entity_types = frozenset()

    if rel_defs:
        relationship_types = frozenset(rel_defs.keys())
        # Prefer per-relationship is_containment/is_lineage flags from
        # the rich definitions; fall back to the flat legacy lists if
        # the flags are absent.
        rich_containment = {
            rid for rid, rdef in rel_defs.items()
            if isinstance(rdef, dict) and rdef.get(
                "is_containment", rdef.get("isContainment", False)
            )
        }
        rich_lineage = {
            rid for rid, rdef in rel_defs.items()
            if isinstance(rdef, dict) and rdef.get(
                "is_lineage", rdef.get("isLineage", False)
            )
        }
        containment = (
            frozenset(rich_containment)
            if rich_containment
            else frozenset(str(t) for t in legacy_containment)
        )
        lineage = (
            frozenset(rich_lineage)
            if rich_lineage
            else frozenset(str(t) for t in legacy_lineage)
        )
    else:
        relationship_types = frozenset(str(t) for t in legacy_containment + legacy_lineage)
        containment = frozenset(str(t) for t in legacy_containment)
        lineage = frozenset(str(t) for t in legacy_lineage)

    return OntologySpec(
        entity_types=entity_types,
        relationship_types=relationship_types,
        containment_edge_types=containment,
        lineage_edge_types=lineage,
    )


class OntologyNotFoundError(LookupError):
    """Strict-mode graph references an ontology that does not exist
    (or is soft-deleted). The API maps this to ``422 ontology_missing``."""


class OntologyNotPublishedError(ValueError):
    """Strict-mode graph references an unpublished ontology — drafts
    cannot back authored graphs (they could mutate during editing).
    The API maps this to ``422 ontology_not_published``."""


__all__ = [
    "to_spec",
    "OntologyNotFoundError",
    "OntologyNotPublishedError",
]
