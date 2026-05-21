"""Stable IDs for built-in (``is_system=True``) ontologies seeded by
management-DB migrations.

Why a module: the IDs are referenced by both the migration (which
inserts the row) and the application (which lets the create-graph
"Simple lineage" on-ramp pick this ontology by ID without UI lookup).
Centralising them here keeps the two in lock-step.
"""
from __future__ import annotations

# Seeded by alembic/versions/20260521_1200_basic_lineage_ontology.py.
# Stable across environments so the frontend mode picker can pre-select
# it for the Simple-lineage on-ramp.
BASIC_LINEAGE_ONTOLOGY_ID = "bp_basic_lineage"


__all__ = ["BASIC_LINEAGE_ONTOLOGY_ID"]
