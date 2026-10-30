"""A fork's data source: its row in ``workspace_data_sources``, made from its parent's.

A fork of a versioned graph is a data source of its own, keyed by the fork graph's ``dsfork_…``
id, in its parent's workspace and on its parent's provider. It names no FalkorDB graph
(``ck_ds_fork_no_key``): it reads through versioning, never a key of its own. Its governing
settings (:data:`GOVERNING`) are its parent's: copied when it is made, kept in step when the
parent's change (:func:`follow_parent`), and never changed on the fork's row itself. It goes to the
trash, back and away with its graph, through the fork routes, and moves with its parent: never on
its own through the data-source routes (:func:`refuse_lifecycle`).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import select, update

from backend.app.db.models import WorkspaceDataSourceORM
from backend.common.interfaces.provider import ProviderConfigurationError

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
    Returns the fork rows it changed.

    The row is written before its forks are listed: its lock makes a fork being made meanwhile
    (which reads its parent FOR SHARE) wait and copy the new values, or be listed. The parent's
    row, then its forks': the order every writer of both takes."""
    changed = [column for column in GOVERNING if getattr(row, column) != before[column]]
    if not changed:
        return []
    if row.fork_of_data_source_id:
        await session.rollback()                     # nothing of the request is kept
        raise HTTPException(status_code=409, detail={
            "type": "fork_settings_follow_parent", "fields": changed,
            "message": "A fork's settings are its parent data source's: change them there."})
    await session.flush()
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


class ForkHasNoStore(ProviderConfigurationError):
    """Something needs a data source's own FalkorDB graph — to write it, aggregate it, move it, give
    it a dedicated rollup graph — and a fork's row has none: it reads through version control.
    Answered 409 ``fork_has_no_store`` (``main.py``)."""

    def __init__(self, data_source_id: str):
        self.data_source_id = data_source_id
        self.detail = {
            "type": "fork_has_no_store", "dataSourceId": data_source_id,
            "message": "A fork has no graph store of its own: it reads its parent's through version "
                       "control. Do this on the data source it was forked from."}
        super().__init__(self.detail["message"])


def refuse_own_store(row: Optional[WorkspaceDataSourceORM]) -> None:
    """:class:`ForkHasNoStore` for a fork's row, where a request needs the data source's own graph."""
    if row is not None and getattr(row, "fork_of_data_source_id", None):
        raise ForkHasNoStore(row.id)


#: Every method of a graph provider that writes FalkorDB, or the caches kept for a graph.
_PROVIDER_WRITES = frozenset({
    "save_custom_graph", "create_node", "create_edge", "update_edge", "delete_edge",
    "set_projection_mode", "ensure_projections", "ensure_indices", "on_lineage_edge_written",
    "on_lineage_edge_deleted", "on_containment_changed", "purge_aggregated_edges",
    "materialize_lineage_for_edge", "materialize_aggregated_edges_batch", "stamp_identity_urns",
    "execute_command", "prime_stats_cache", "clear_content_caches",
})


class ForkReadOnlyProvider:
    """The provider the registry hands out for a fork's row: its root parent's published graph
    (``versioned_sources.physical_key``), read only. Reads delegate; every write is refused
    (:class:`ForkHasNoStore`), so nothing addressed to a fork reaches FalkorDB. Version control
    reads and writes a fork (``ContextEngine``), never this."""

    def __init__(self, inner, data_source_id: str):
        self._inner = inner
        self._data_source_id = data_source_id

    def __getattr__(self, name):
        if name in _PROVIDER_WRITES:
            async def _refused(*_args, **_kwargs):
                raise ForkHasNoStore(self._data_source_id)
            return _refused
        return getattr(self._inner, name)


def refuse_lifecycle(row: Optional[WorkspaceDataSourceORM]) -> None:
    """409 ``use_fork_endpoints`` for a fork's row, which the data-source routes never trash,
    restore, delete or move: it goes with its graph, and moves with its parent."""
    if row is not None and getattr(row, "fork_of_data_source_id", None):
        raise HTTPException(status_code=409, detail={
            "type": "use_fork_endpoints",
            "message": "A fork's data source goes to the trash and back with the fork, and moves "
                       "with the data source it was forked from."})


def refuse_primary(row: Optional[WorkspaceDataSourceORM]) -> None:
    """409 ``fork_not_primary`` for a fork's row, which is never a workspace's default: every
    lookup of the default skips forks, so the workspace would fall back to another source."""
    if row is not None and getattr(row, "fork_of_data_source_id", None):
        raise HTTPException(status_code=409, detail={
            "type": "fork_not_primary",
            "message": "A fork can't be the workspace's default data source. Make the data source "
                       "it was forked from the default instead."})


async def trash_row(session, ds_id: str, actor: Optional[str]) -> None:
    """Tombstone a fork's row after its graph went to the trash. A row already there, or none
    (a fork made before forks had rows), is left as it is."""
    row = await session.get(WorkspaceDataSourceORM, ds_id)
    if row is not None and row.fork_of_data_source_id and row.deleted_at is None:
        row.deleted_at, row.deleted_by = datetime.now(timezone.utc).isoformat(), actor


async def restore_row(session, ds_id: str) -> None:
    """Bring a fork's row back after its graph came back. A live row, or none, is left as it is."""
    row = await session.get(WorkspaceDataSourceORM, ds_id)
    if row is not None and row.fork_of_data_source_id and row.deleted_at is not None:
        row.deleted_at = row.deleted_by = None
        row.updated_at = datetime.now(timezone.utc).isoformat()
