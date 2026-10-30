"""A fork's data source: its row in ``workspace_data_sources``, made from its parent's.

A fork of a versioned graph is a data source of its own, keyed by the fork graph's ``dsfork_…``
id, in its parent's workspace and on its parent's provider. It names no FalkorDB graph
(``ck_ds_fork_no_key``): it reads through versioning, never a key of its own. Its governing
settings (:data:`GOVERNING`) are its parent's, copied when it is made.
"""
from __future__ import annotations

import json
from typing import Optional

from backend.app.db.models import WorkspaceDataSourceORM

#: The settings a fork takes from its parent: what it is governed by, never its own to change.
GOVERNING = (
    "ontology_id", "is_restricted", "access_level", "identity_property", "name_property",
    "draft_default_visibility", "draft_levels", "review_self_approval", "review_self_merge",
)


def label_of(row: WorkspaceDataSourceORM) -> str:
    return row.label or row.graph_name or row.id


def fork_row(parent: WorkspaceDataSourceORM, *, ds_id: str, name: str, parent_graph_id: str,
             actor: Optional[str]) -> WorkspaceDataSourceORM:
    """A new fork row of ``parent``, labelled ``"<parent label> · <name>"``, not yet added."""
    return WorkspaceDataSourceORM(
        id=ds_id, workspace_id=parent.workspace_id, provider_id=parent.provider_id,
        graph_name=None, label=f"{label_of(parent)} · {name}", is_primary=False, is_active=True,
        source_mode="managed", fork_of_data_source_id=parent.id, created_by=actor,
        extra_config=json.dumps({"origin": {"kind": "fork", "parentDataSourceId": parent.id,
                                            "parentGraphId": parent_graph_id}}),
        **{column: getattr(parent, column) for column in GOVERNING},
    )
