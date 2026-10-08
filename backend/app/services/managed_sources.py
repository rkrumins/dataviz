"""Which data sources and catalog entries are bound to one physical graph key.

A FalkorDB graph is addressed by (provider, graph name), and nothing stops two data sources — in
one workspace or in two — from reading the same key, or a catalog entry from publishing it. Any
action that CHANGES a key in place therefore has to ask who else reads it first: collapsing a
bootstrap's duplicate nodes deletes them from the source graph for every reader, and (later) a
purge must not drop a key someone else still uses.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def graph_key_bindings(session: AsyncSession, provider_id: Optional[str], graph_name: str,
                             exclude_ds: Optional[str] = None) -> List[Dict[str, Optional[str]]]:
    """Every live binding of the key ``(provider_id, graph_name)``: data sources reading it (by
    ``graph_name``, or as their dedicated projection key) and catalog entries publishing it.

    EXACT match, unlike the blank-graph name check (``endpoints/versioning._taken_graph_names``):
    that one asks "could a new name collide?" and so matches loosely; this one asks "who reads THIS
    key?", and a FalkorDB key is case-sensitive. A soft-deleted data source reads nothing and is not
    a binding. ``exclude_ds`` leaves out the asker's own data source.

    Each binding is ``{kind: 'dataSource', dataSourceId, workspaceId, name}`` or
    ``{kind: 'catalogItem', catalogItemId, name}``."""
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    ds = WorkspaceDataSourceORM
    stmt = select(ds.id, ds.workspace_id, ds.label, ds.graph_name).where(
        ds.provider_id == provider_id, ds.deleted_at.is_(None),
        (ds.graph_name == graph_name) | (ds.dedicated_graph_name == graph_name),
    ).order_by(ds.id)
    if exclude_ds is not None:
        stmt = stmt.where(ds.id != exclude_ds)
    out: List[Dict[str, Optional[str]]] = [
        {"kind": "dataSource", "dataSourceId": ds_id, "workspaceId": ws_id,
         "name": label or name}
        for ds_id, ws_id, label, name in (await session.execute(stmt)).all()]
    cats = (await session.execute(select(CatalogItemORM.id, CatalogItemORM.name).where(
        CatalogItemORM.provider_id == provider_id,
        CatalogItemORM.source_identifier == graph_name,
    ).order_by(CatalogItemORM.id))).all()
    out.extend({"kind": "catalogItem", "catalogItemId": cat_id, "name": name}
               for cat_id, name in cats)
    return out


async def shared_with(session: AsyncSession, ds) -> Dict[str, object]:
    """The OTHER data sources bound to ``ds``'s physical graph — what a duplicate collapse in that
    graph changes besides ``ds`` — as the bootstrap status shows them: ``sharedWith`` names those
    in ``ds``'s own workspace (``[{dataSourceId, name}]``); those in other workspaces are only
    counted (``sharedWithOtherWorkspaces``). The status is readable by anyone who may read this
    workspace, and a workspace must never learn another's data sources — the rest of the API
    answers 404, not 403, for the same reason."""
    name = getattr(ds, "graph_name", None)
    mine: List[Dict[str, Optional[str]]] = []
    others = 0
    if name:
        for b in await graph_key_bindings(session, getattr(ds, "provider_id", None), name,
                                          exclude_ds=ds.id):
            if b["kind"] != "dataSource":
                continue
            if b["workspaceId"] == ds.workspace_id:
                mine.append({"dataSourceId": b["dataSourceId"], "name": b["name"]})
            else:
                others += 1
    return {"sharedWith": mine, "sharedWithOtherWorkspaces": others}
