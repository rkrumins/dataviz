"""A versioned graph's health, the top of its settings drawer (``GET …/graphs/{id}/health``): the
version it is at and the one its readers get, how they read it while it updates, its copy in
memory, its last build, what happened to it in the last day, and how many of the graph store's
property names it uses. Composed when someone asks from
what the platform already keeps — the watermark, the build's state, the settings in force, the
signals — so no read pays for it.

Each part is best effort: one that can't be read is null, with a ``problems`` entry ``{part,
message}``. A fork has no copy of its own: what it serves, its copy, its last build and the signals
about the copy and its reads are its root's, and ``follows`` names the root; its imports and
drafts are its own.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.versioning import update_progress

from . import preview as previews, resolver, service, signals

logger = logging.getLogger(__name__)

#: The signals counted for the graph whose copy serves the reads: a fork's root.
_STORE_SIGNALS = ("builds.", "reads.", "residency.")


async def graph_health(session: AsyncSession, svc: Any, meta: Mapping[str, Any]) -> Dict[str, Any]:
    """``{asOf, head, serving, versionsBehind, readMode, progress, lastUpdate, memory, lastBuild,
    signals, propertyNames, follows, problems}`` for the graph ``meta`` names
    (``graph_in_workspace``'s answer). ``svc`` is the versioning service."""
    gid = meta["graph_id"]
    out: Dict[str, Any] = {
        "asOf": datetime.now(timezone.utc).isoformat(), "head": None, "serving": None,
        "versionsBehind": None, "readMode": None, "progress": None, "lastUpdate": None,
        "memory": None, "lastBuild": None, "signals": None, "propertyNames": None,
        "follows": None}
    problems: List[Dict[str, str]] = []

    def problem(part: str, message: str) -> None:
        problems.append({"part": part, "message": message})

    graph = by_id = None
    try:
        listed = await (service.graphs(workspace_id=meta["workspace_id"])
                        if meta.get("fork_parent_graph_id") else service.graphs(graph_id=gid))
        by_id = {g.graph_id: g for g in listed}
        graph = by_id.get(gid)
    except Exception:  # noqa: BLE001 — the parts that need it say so
        logger.warning("graph health: the versioned graphs of %s could not be listed", gid,
                       exc_info=True)

    # What its readers get: a fork's watermark is its root's, as the fork reads it.
    wm = store = None
    store_id = gid
    try:
        wm = await svc.projection_watermark(gid)
        store_id = wm.get("reads_through") or gid
        store = wm if store_id == gid else await svc.projection_watermark(store_id)
    except Exception:  # noqa: BLE001
        logger.warning("graph health: the watermark of %s could not be read", gid, exc_info=True)
        if wm is None and graph is not None:
            store_id = service.root_of(graph, by_id).graph_id
    store_ds = meta.get("data_source_id")
    if store_id != gid:
        follows = by_id.get(store_id) if by_id else None
        ds = store_ds = follows.data_source_id if follows else None
        out["follows"] = {"graphId": store_id, "dataSourceId": ds,
                          "label": await _label(session, ds) if ds else None}

    if wm is None:
        for part in ("head", "serving", "versionsBehind"):
            problem(part, "The version it is at, and the one its readers get, can't be read.")
    else:
        head = {"seq": wm["committed"], "version": _revision(wm.get("committed_revision"))}
        if wm.get("served") is not None:
            serving = {"seq": wm["served"], "version": _revision(wm.get("served_revision")),
                       "source": "graph_store"}
        else:                                 # the database serves its readers, at the head
            serving = {"seq": head["seq"], "version": head["version"], "source": "database"}
        out.update(head=head, serving=serving,
                   versionsBehind=max(0, head["seq"] - serving["seq"]))

    ctx = None
    try:
        ctx = await service.context(session)
        if graph is None:
            raise LookupError(gid)
        mode = resolver.resolve(ctx, "reads.mode", service.target_of(graph, by_id))
        out["readMode"] = {k: mode[k] for k in ("effective", "declared", "source", "why")}
    except Exception:  # noqa: BLE001
        logger.warning("graph health: the read mode of %s could not be resolved", gid,
                       exc_info=True)
        problem("readMode", "How its readers read it while it updates can't be read.")

    # The update in flight and the last one that finished, as the projector records them
    # (``update_progress``), in one Redis read: a fork's are its root's.
    try:
        out["progress"], out["lastUpdate"], unrecorded = await update_progress.read_health(
            store_id, store)
        if unrecorded:
            problem("lastUpdate", unrecorded)
    except Exception:  # noqa: BLE001
        logger.warning("graph health: the updates of %s could not be read", gid, exc_info=True)
        problem("progress", "How far an update is can't be read right now.")
        problem("lastUpdate", "Its last update can't be read right now.")

    if store is None:
        problem("memory", "Its copy in memory can't be read.")
        problem("lastBuild", "Its new-version builds can't be read.")
    else:
        state = store.get("residency_state")
        loaded = state == "resident"
        node = None
        if loaded and store.get("falkor_graph_name"):
            node, why = await _node(store.get("falkor_provider"), store["falkor_graph_name"])
            if why:
                problem("memory.node", why)
        out["memory"] = {"bytes": store.get("size_bytes"), "node": node, "loaded": loaded,
                         "state": state, "rehydratingSince": store.get("rehydrating_since"),
                         "class": store.get("residency"), "lastReadAt": store.get("last_read_at")}
        grace = None
        if ctx is not None:
            try:
                grace = resolver.effective(ctx, "updates.retireGraceSecs")
            except Exception:  # noqa: BLE001 — the build is still told; only how far back isn't
                logger.warning("graph health: the retire grace could not be resolved",
                               exc_info=True)
        out["lastBuild"] = _last_build(store, grace)

    try:
        own = await signals.read("24h", graph_id=gid)
        stores = own if store_id == gid else await signals.read("24h", graph_id=store_id)
        out["signals"] = [{"id": sid, "count24h": (stores if sid.startswith(_STORE_SIGNALS)
                                                   else own)[sid]["count"]}
                          for sid in signals.IDS]
    except Exception:  # noqa: BLE001
        logger.warning("graph health: the signals of %s could not be read", gid, exc_info=True)
        problem("signals", "What happened in the last day can't be read right now.")

    out["propertyNames"] = await _property_names(session, store, store_ds)
    if out["propertyNames"] is None:
        problem("propertyNames", "How many property names it uses can't be read right now.")

    out["problems"] = problems
    return out


#: Of the budget, where a graph is told it is close: new names past the budget are kept as values.
_NEAR_BUDGET = 0.9


async def _property_names(session: AsyncSession, store: Optional[Mapping[str, Any]],
                          data_source_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """How many of the graph store's property names the graph's copy uses — FalkorDB numbers a
    graph's property names in one map that items and relationships share, at most ``ceiling`` of
    them, and never frees one — against ``budget``, where the platform's own writes stop adding
    names: past it, a new key is kept as a value (still shown and exported; searched by presence
    and equality), never lost. ``storedAsValues`` names those keys, by whether items or
    relationships carry them.

    Read from what is kept: the reading its last update recorded (``measuredBy`` ``update``), else
    the count the data source's statistics poll last took (``poll``: no keys named), else none yet
    (``registered`` null — not zero). ``state``: ``unknown``, ``ok``, ``near_budget`` or
    ``at_budget``. None, with a problem, when neither could be read."""
    from backend.app.providers.falkordb_materialize import _ATTRIBUTE_NAME_LIMIT
    from backend.app.providers.falkordb_provider import (_native_property_budget,
                                                         platform_property_names)

    reading = (store or {}).get("property_names")
    out: Dict[str, Any] = {"registered": None, "platform": None,
                           "budget": _native_property_budget(), "ceiling": _ATTRIBUTE_NAME_LIMIT,
                           "measuredAt": None, "measuredBy": None, "storedAsValues": None,
                           "state": "unknown"}
    if isinstance(reading, Mapping) and isinstance(reading.get("registered"), int):
        demoted = reading.get("demoted") if isinstance(reading.get("demoted"), Mapping) else {}
        out.update(registered=reading["registered"], platform=reading.get("platform"),
                   budget=reading.get("budget") or out["budget"],
                   ceiling=reading.get("ceiling") or out["ceiling"],
                   measuredAt=reading.get("at"), measuredBy="update",
                   storedAsValues={"nodes": list(demoted.get("nodes") or []),
                                   "edges": list(demoted.get("edges") or []),
                                   "count": int(demoted.get("count") or 0)})
    else:
        polled = None
        if data_source_id:
            try:
                from sqlalchemy import select

                from backend.app.db.models import DataSourceStatsORM
                polled = (await session.execute(
                    select(DataSourceStatsORM.property_key_count, DataSourceStatsORM.updated_at)
                    .where(DataSourceStatsORM.data_source_id == data_source_id))).first()
            except Exception:  # noqa: BLE001
                logger.warning("graph health: the property names of %s could not be read",
                               data_source_id, exc_info=True)
                if store is None:
                    return None
        if polled is not None and polled[0] is not None:
            platform = len(platform_property_names()) or None
            out.update(registered=int(polled[0]), platform=platform, measuredAt=polled[1],
                       measuredBy="poll")
        elif store is None:
            return None
    if out["registered"] is not None:
        out["state"] = ("at_budget" if out["registered"] >= out["budget"]
                        else "near_budget" if out["registered"] >= _NEAR_BUDGET * out["budget"]
                        else "ok")
    return out


def _revision(rev: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """A main commit as the watermark names it: ``{commitId, at, actor, message}``."""
    if not rev:
        return None
    return {"commitId": rev.get("commit_id"), "at": rev.get("created_at"),
            "actor": rev.get("actor"), "message": rev.get("message")}


#: What a build waits for, from the words the projector records with the wait
#: (``projection.py``: ``update_candidate(..., waiting=...)``): room for its copy on its node; a
#: summaries job building the serving copy's lineage summaries; or a lock another change holds
#: (``LockBusy``'s words, "… try again shortly"), a memory check's among them.
_WAITS = (("room", "no room"), ("summaries", "lineage-summaries job"), ("lock", "try again"))


def _waiting_for(why: str) -> Optional[str]:
    """``room``, ``summaries`` or ``lock``: what a build waits for, as its recorded words say;
    None when they say none of these (the words themselves are served as ``why``)."""
    return next((code for code, words in _WAITS if words in why), None)


def _last_build(wm: Mapping[str, Any], grace_secs: Optional[int] = None) -> Dict[str, Any]:
    """What is known of the graph's new-version builds, every key always there:

    * the build in flight: ``running``, or ``waiting`` with what for (``waitingFor``: ``room``,
      ``lock``, ``summaries``, or None when its words name none of them); ``why``, the words of
      the wait, or the error its last attempt failed with; ``attempts`` failed so far; ``since``,
      when it was asked for;
    * else the last one, while the copy it left is kept (nothing else records a finished build):
      ``switched``, its readers switched to it, ``at`` when, known while no later update has
      published, and the previous copy removed from ``copyRemovedAfter`` on (at the next retire
      run after it); or ``not_switched``: it was given up without a switch (why isn't recorded),
      ``at`` when, as its own copy is removed from then on, ``copyRemovedAfter``;
    * else ``none``: nothing in flight, and no switch within ``windowSecs`` (the retire grace in
      force; a switch's previous copy is kept that long), null when that can't be read. A build
      given up without a switch shows only until the next retire run."""
    out: Dict[str, Any] = {"outcome": "none", "since": None, "at": None, "waitingFor": None,
                           "why": None, "attempts": None, "copyRemovedAfter": None,
                           "windowSecs": None}
    build = wm.get("candidate")
    if build:
        waiting = build.get("waiting")
        return {**out, "outcome": "waiting" if waiting else "running",
                "waitingFor": _waiting_for(waiting) if waiting else None,
                "why": waiting or build.get("error"), "attempts": build.get("attempts"),
                "since": build.get("since")}
    left = [e for e in wm.get("retired_keys") or [] if isinstance(e, Mapping) and e.get("build")]
    if not left:
        return {**out, "windowSecs": grace_secs}
    last = left[-1]                           # retired_keys only ever grows at its end
    if last.get("afterSeq"):                  # the copy its readers were switched from
        at = wm.get("last_projected_at") if wm.get("projected") == last["afterSeq"] else None
        return {**out, "outcome": "switched", "at": at,
                "copyRemovedAfter": last.get("retireAfter")}
    # Its own copy, retired at once when it was given up: due from that moment.
    return {**out, "outcome": "not_switched", "at": last.get("retireAfter"),
            "copyRemovedAfter": last.get("retireAfter")}


async def _label(session: AsyncSession, data_source_id: str) -> Optional[str]:
    """A data source's label, to name the graph a fork follows; None when it can't be read."""
    try:
        return (await previews.labels(session, [data_source_id])).get(data_source_id)
    except Exception:  # noqa: BLE001 — the root is still named by its ids
        logger.warning("graph health: %s could not be named", data_source_id, exc_info=True)
        return None


async def _node(provider: Optional[str], key: str) -> Tuple[Optional[str], Optional[str]]:
    """The graph store node holding ``key``, as the Graph store page last read the nodes (never a
    sweep run in the request): ``(its name, None)``, or ``(None, why it can't be told)``."""
    from backend.app.services.graph_store import topology

    try:
        snapshot, _refreshing = await topology.snapshot_for_request()
        if snapshot is None:
            return None, "The graph store's nodes are being read: ask again in a moment."
        master = topology.placement_for_graph(snapshot, provider or "", key).master
    except Exception:  # noqa: BLE001
        logger.warning("graph health: where %s lives could not be read", key, exc_info=True)
        master = None
    if master is None:
        return None, "Which graph store node holds its copy can't be read."
    return master.endpoint, None
