"""What a saved change set of versioned-graph settings sets in motion beyond the store, once it has
committed (``service.save``, ``service.revert``).

* Routes. A setting the registry marks ``routing`` (the read mode, how many versions behind a copy
  may serve) decides each graph's route, which every process keeps (``route_cache``). A save moves
  the route tokens of the graphs it reaches: the graph's own, a workspace's graphs', or every
  graph's for the platform's. :func:`~.store.apply` has moved the settings' generation by then, so
  a lookup that reads a route again reads the settings again too.
* Stored values in force. Code that can't ask the resolver reads a ``materialized`` setting's value
  where it is stored (:func:`materialize`).

Best effort: the save stands whatever happens here, and a route nobody told ages out within
``GRAPHVER_ROUTE_CACHE_SECS``.
"""
from __future__ import annotations

import logging
from typing import List, Sequence

from sqlalchemy import or_, select

from . import registry, store

logger = logging.getLogger(__name__)


async def after_save(change_set: store.ChangeSet) -> None:
    """Everything a committed change set sets in motion."""
    if not change_set.applied:
        return
    settings = registry().BY_KEY
    routed = [a for a in change_set.applied
              if a.key in settings and settings[a.key].routing]
    if routed:
        await announce_routes(routed)
    await materialize(change_set)


async def announce_routes(applied: Sequence[store.Applied]) -> bool:
    """Move the route tokens of the graphs these changes reach: every graph's for a platform value,
    else each workspace's graphs' and each graph's own (a graph's scope id is its data source's).
    When the graphs can't be listed, every graph's. False when Redis couldn't take the tokens."""
    from backend.app.services.versioning import route_cache

    if any(a.scope == "platform" for a in applied):
        return await route_cache.announce(every=True)
    workspaces = sorted({a.scope_id for a in applied if a.scope == "workspace"})
    sources = sorted({a.scope_id for a in applied if a.scope == "graph"})
    try:
        graph_ids = await _graphs_of(workspaces, sources)
    except Exception:  # noqa: BLE001 — an announcement too wide is only a re-read
        logger.warning("settings: the graphs a change reaches could not be listed; every route "
                       "is announced", exc_info=True)
        return await route_cache.announce(every=True)
    return await route_cache.announce(graph_ids)


async def _graphs_of(workspaces: Sequence[str], sources: Sequence[str]) -> List[str]:
    """The live graphs of these workspaces, and of these data sources."""
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import GraphORM

    async with gvdb.graphver_session() as s:
        found = await s.execute(select(GraphORM.id).where(
            GraphORM.deleted_at.is_(None),
            or_(GraphORM.workspace_id.in_(list(workspaces)),
                GraphORM.data_source_id.in_(list(sources)))))
        return list(found.scalars())


async def materialize(change_set: store.ChangeSet) -> None:
    """Each graph's stored value of a ``materialized`` setting kept in step with a save: the
    residency class, which the evictor reads in SQL (``projection_state.residency``) because it
    can't ask the resolver. A graph's own class re-classes that graph, a workspace's the
    workspace's graphs, the platform's every graph (one with a class of its own, or of its
    workspace, keeps it): one statement for them all (``residency.keep_classes``). Best effort: a
    class not written here is written by the next memory check, which puts every graph's class
    in step before it plans."""
    settings = registry().BY_KEY
    classes = [a for a in change_set.applied if a.key in settings
               and settings[a.key].materialized == "projection_state.residency"]
    if not classes:
        return
    from backend.app.services.versioning import residency

    everywhere = any(a.scope == "platform" for a in classes)
    try:
        moved = await residency.keep_classes(
            workspaces=None if everywhere else {a.scope_id for a in classes
                                                if a.scope == "workspace"},
            sources=None if everywhere else {a.scope_id for a in classes if a.scope == "graph"})
    except Exception:  # noqa: BLE001 — the save stands; the next memory check writes them
        logger.warning("settings: the graphs' residency classes could not be written; the next "
                       "memory check writes them", exc_info=True)
        return
    if moved:
        logger.info("settings: %d graph(s) re-classed", len(moved))
