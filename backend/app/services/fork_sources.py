"""A fork's data source: its row in ``workspace_data_sources``, made from its parent's.

A fork of a versioned graph is a data source of its own, keyed by the fork graph's ``dsfork_…``
id, in its parent's workspace and on its parent's provider. It names no FalkorDB graph
(``ck_ds_fork_no_key``): it reads through versioning, never a key of its own. Its governing
settings (:data:`GOVERNING`) are its parent's: copied when it is made, kept in step when the
parent's change (:func:`follow_parent`), and never changed on the fork's row itself.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import select, update

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


def governing(row: WorkspaceDataSourceORM) -> Dict[str, object]:
    """``row``'s governing settings, to compare after a write (:func:`follow_parent`)."""
    return {column: getattr(row, column) for column in GOVERNING}


async def forks_of(session, ds_id: str) -> List[str]:
    """The fork rows made from ``ds_id``, and from those, live and trashed."""
    found: List[str] = []
    level = [ds_id]
    while level:
        level = list((await session.execute(select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.fork_of_data_source_id.in_(level)))).scalars().all())
        found += level
    return found


async def follow_parent(session, row: WorkspaceDataSourceORM, before: Dict[str, object]) -> List[str]:
    """After a write to ``row``'s governing settings (``before``: :func:`governing` of it as it
    was), in the same transaction: a fork's row refuses a change of one (409
    ``fork_settings_follow_parent``; its label and the rest stay its own), and the forks of any
    other row, forks of forks too, take the new values. A refusal rolls the transaction back.
    Returns the fork rows it changed."""
    changed = [column for column in GOVERNING if getattr(row, column) != before[column]]
    if not changed:
        return []
    if row.fork_of_data_source_id:
        await session.rollback()                     # nothing of the request is kept
        raise HTTPException(status_code=409, detail={
            "type": "fork_settings_follow_parent", "fields": changed,
            "message": "A fork's settings are its parent data source's: change them there."})
    forks = await forks_of(session, row.id)
    if forks:
        await session.execute(
            update(WorkspaceDataSourceORM).where(WorkspaceDataSourceORM.id.in_(forks))
            .values(updated_at=datetime.now(timezone.utc).isoformat(),
                    **{column: getattr(row, column) for column in changed}))
    return forks


async def governing_row(session, row: Optional[WorkspaceDataSourceORM]):
    """The row whose governing settings decide for ``row``: for a fork's, its root parent's."""
    while row is not None and row.fork_of_data_source_id:
        parent = await session.get(WorkspaceDataSourceORM, row.fork_of_data_source_id)
        if parent is None:
            break
        row = parent
    return row
