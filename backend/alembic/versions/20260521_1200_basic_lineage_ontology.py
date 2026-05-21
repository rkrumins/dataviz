"""Seed the "Basic Lineage" is_system=True ontology.

Revision ID: 20260521_1200_basic_lineage_ontology
Revises: 20260516_1200_graph_permissions
Create Date: 2026-05-21

The simple-lineage on-ramp for user-authored graphs (Phase 1 closeout
item A.3). Inserts a single published, universal-scope, is_system=True
ontology containing canonical node and edge types for "draw a simple
lineage diagram without thinking about ontologies":

  * Entity types: Dataset, Pipeline, Service, Application, Database,
    Schema, Table.
  * Relationship types: CONTAINS (containment), FLOWS_TO, DERIVES_FROM,
    READS, WRITES, DEPENDS_ON (all lineage).

Idempotent: skipped if a row with this stable id already exists, so the
migration is safe to re-apply across environments. The id is fixed (not
random) so application code can reference it from a config constant.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260521_1200_basic_lineage_ontology"
down_revision: Union[str, None] = "20260516_1200_graph_permissions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


BASIC_LINEAGE_ONTOLOGY_ID = "bp_basic_lineage"


def _entity(name: str, plural: str, *, icon: str, color: str, level: int,
            can_contain: list[str] | None = None,
            can_be_contained_by: list[str] | None = None) -> dict:
    return {
        "name": name,
        "plural_name": plural,
        "description": None,
        "visual": {
            "icon": icon, "color": color, "shape": "rounded",
            "size": "md", "border_style": "solid", "show_in_minimap": True,
        },
        "hierarchy": {
            "level": level,
            "can_contain": list(can_contain or []),
            "can_be_contained_by": list(can_be_contained_by or []),
            "default_expanded": False,
            "roll_up_fields": [],
        },
        "behavior": {
            "selectable": True, "draggable": True, "expandable": True,
            "traceable": True, "click_action": "select",
            "double_click_action": "expand", "expansion_mode": "graph",
        },
        "fields": [],
    }


def _rel(name: str, *, is_containment: bool, is_lineage: bool,
         category: str, color: str, source_types: list[str],
         target_types: list[str], description: str) -> dict:
    return {
        "name": name,
        "description": description,
        "category": category,
        "is_containment": is_containment,
        "is_lineage": is_lineage,
        "direction": "source-to-target",
        "visual": {
            "stroke_color": color, "stroke_width": 2,
            "stroke_style": "solid" if is_containment else "solid",
            "animated": is_lineage, "animation_speed": "normal",
            "arrow_type": "arrow", "curve_type": "bezier",
        },
        "source_types": list(source_types),
        "target_types": list(target_types),
        "bidirectional": False,
        "show_label": False,
        "label_field": None,
    }


_ENTITY_TYPE_DEFINITIONS: dict[str, dict] = {
    "Application": _entity(
        "Application", "Applications", icon="AppWindow", color="#0ea5e9",
        level=0, can_contain=["Service", "Database"],
    ),
    "Service": _entity(
        "Service", "Services", icon="Server", color="#6366f1",
        level=1, can_contain=["Pipeline"],
        can_be_contained_by=["Application"],
    ),
    "Pipeline": _entity(
        "Pipeline", "Pipelines", icon="GitBranch", color="#8b5cf6",
        level=2, can_contain=["Dataset"],
        can_be_contained_by=["Service"],
    ),
    "Database": _entity(
        "Database", "Databases", icon="Database", color="#14b8a6",
        level=1, can_contain=["Schema"],
        can_be_contained_by=["Application"],
    ),
    "Schema": _entity(
        "Schema", "Schemas", icon="Folder", color="#22c55e",
        level=2, can_contain=["Table", "Dataset"],
        can_be_contained_by=["Database"],
    ),
    "Table": _entity(
        "Table", "Tables", icon="Table2", color="#84cc16",
        level=3, can_be_contained_by=["Schema"],
    ),
    "Dataset": _entity(
        "Dataset", "Datasets", icon="Box", color="#f59e0b",
        level=3, can_be_contained_by=["Pipeline", "Schema"],
    ),
}


_RELATIONSHIP_TYPE_DEFINITIONS: dict[str, dict] = {
    "CONTAINS": _rel(
        "CONTAINS", is_containment=True, is_lineage=False,
        category="structural", color="#64748b",
        source_types=[], target_types=[],
        description="Parent-child containment. Forms a DAG.",
    ),
    "FLOWS_TO": _rel(
        "FLOWS_TO", is_containment=False, is_lineage=True,
        category="flow", color="#6366f1",
        source_types=["Dataset", "Table", "Pipeline", "Service"],
        target_types=["Dataset", "Table", "Pipeline", "Service"],
        description="Data flows from source to target.",
    ),
    "DERIVES_FROM": _rel(
        "DERIVES_FROM", is_containment=False, is_lineage=True,
        category="flow", color="#a855f7",
        source_types=["Dataset", "Table"], target_types=["Dataset", "Table"],
        description="Target derives its content from source.",
    ),
    "READS": _rel(
        "READS", is_containment=False, is_lineage=True,
        category="flow", color="#0ea5e9",
        source_types=["Service", "Pipeline", "Application"],
        target_types=["Dataset", "Table", "Database"],
        description="Consumer reads from data source.",
    ),
    "WRITES": _rel(
        "WRITES", is_containment=False, is_lineage=True,
        category="flow", color="#f97316",
        source_types=["Service", "Pipeline", "Application"],
        target_types=["Dataset", "Table", "Database"],
        description="Producer writes to data sink.",
    ),
    "DEPENDS_ON": _rel(
        "DEPENDS_ON", is_containment=False, is_lineage=True,
        category="association", color="#94a3b8",
        source_types=[], target_types=[],
        description="Soft dependency (build / runtime / config).",
    ),
}


_CONTAINMENT_EDGE_TYPES = ["CONTAINS"]
_LINEAGE_EDGE_TYPES = ["FLOWS_TO", "DERIVES_FROM", "READS", "WRITES"]
_ROOT_ENTITY_TYPES = ["Application", "Database"]


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("ontologies"):
        return
    bind.execute(
        sa.text(
            """
            INSERT INTO ontologies (
                id, name, description, version,
                containment_edge_types, lineage_edge_types,
                edge_type_metadata, entity_type_hierarchy,
                root_entity_types,
                entity_type_definitions, relationship_type_definitions,
                is_published, is_system, scope, evolution_policy,
                schema_id, revision, created_by
            ) VALUES (
                :id, :name, :description, :version,
                :containment_edge_types, :lineage_edge_types,
                :edge_type_metadata, :entity_type_hierarchy,
                :root_entity_types,
                :entity_type_definitions, :relationship_type_definitions,
                true, true, 'universal', 'reject',
                :schema_id, 1, 'system'
            )
            ON CONFLICT (id) DO NOTHING
            """
        ),
        {
            "id": BASIC_LINEAGE_ONTOLOGY_ID,
            "name": "Basic Lineage",
            "description": (
                "Starter ontology for simple lineage diagrams: data "
                "platforms, services, pipelines, and the datasets / tables "
                "they read and write. CONTAINS is the containment edge "
                "(parent-child DAG); FLOWS_TO / DERIVES_FROM / READS / "
                "WRITES are lineage edges."
            ),
            "version": 1,
            "containment_edge_types": json.dumps(_CONTAINMENT_EDGE_TYPES),
            "lineage_edge_types": json.dumps(_LINEAGE_EDGE_TYPES),
            "edge_type_metadata": json.dumps({}),
            "entity_type_hierarchy": json.dumps({}),
            "root_entity_types": json.dumps(_ROOT_ENTITY_TYPES),
            "entity_type_definitions": json.dumps(_ENTITY_TYPE_DEFINITIONS),
            "relationship_type_definitions": json.dumps(_RELATIONSHIP_TYPE_DEFINITIONS),
            "schema_id": "basic_lineage",
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("ontologies"):
        return
    bind.execute(
        sa.text("DELETE FROM ontologies WHERE id = :id"),
        {"id": BASIC_LINEAGE_ONTOLOGY_ID},
    )
