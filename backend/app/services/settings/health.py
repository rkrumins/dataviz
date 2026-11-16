"""A versioned graph's health, the top of its settings drawer (``GET …/graphs/{id}/health``): the
version it is at and the one its readers get, how they read it while it updates, its copy in
memory, its last build, and what happened to it in the last day. Composed when someone asks from
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

from . import resolver, service, signals

logger = logging.getLogger(__name__)

#: The signals counted for the graph whose copy serves the reads: a fork's root.
_STORE_SIGNALS = ("builds.", "reads.", "residency.")


async def graph_health(session: AsyncSession, svc: Any, meta: Mapping[str, Any]) -> Dict[str, Any]:
    """``{asOf, head, serving, versionsBehind, readMode, progress, lastUpdate, memory, lastBuild,
    signals, follows, problems}`` for the graph ``meta`` names (``graph_in_workspace``'s answer).
    ``svc`` is the versioning service."""
    gid = meta["graph_id"]
    out: Dict[str, Any] = {
        "asOf": datetime.now(timezone.utc).isoformat(), "head": None, "serving": None,
        "versionsBehind": None, "readMode": None, "progress": None, "lastUpdate": None,
        "memory": None, "lastBuild": None, "signals": None, "follows": None}
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
    if store_id != gid:
        follows = by_id.get(store_id) if by_id else None
        out["follows"] = {"graphId": store_id,
                          "dataSourceId": follows.data_source_id if follows else None}

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

    try:
        if graph is None:
            raise LookupError(gid)
        ctx = await service.context(session)
        mode = resolver.resolve(ctx, "reads.mode", service.target_of(graph, by_id))
        out["readMode"] = {k: mode[k] for k in ("effective", "declared", "source", "why")}
    except Exception:  # noqa: BLE001
        logger.warning("graph health: the read mode of %s could not be resolved", gid,
                       exc_info=True)
        problem("readMode", "How its readers read it while it updates can't be read.")

    # A pass's time, rows and rate are logged, never kept: nothing to show, rather than a guess.
    problem("lastUpdate", "How long its last update took, and how many rows it wrote, aren't "
                          "recorded yet.")

    if store is None:
        problem("memory", "Its copy in memory can't be read.")
        problem("lastBuild", "Its new-version builds can't be read.")
    else:
        loaded = store.get("residency_state") == "resident"
        node = None
        if loaded and store.get("falkor_graph_name"):
            node, why = await _node(store.get("falkor_provider"), store["falkor_graph_name"])
            if why:
                problem("memory.node", why)
        out["memory"] = {"bytes": store.get("size_bytes"), "node": node, "loaded": loaded,
                         "class": store.get("residency"), "lastReadAt": store.get("last_read_at")}
        out["lastBuild"] = _last_build(store)

    try:
        own = await signals.read("24h", graph_id=gid)
        stores = own if store_id == gid else await signals.read("24h", graph_id=store_id)
        out["signals"] = [{"id": sid, "count24h": (stores if sid.startswith(_STORE_SIGNALS)
                                                   else own)[sid]["count"]}
                          for sid in signals.IDS]
    except Exception:  # noqa: BLE001
        logger.warning("graph health: the signals of %s could not be read", gid, exc_info=True)
        problem("signals", "What happened in the last day can't be read right now.")

    out["problems"] = problems
    return out


def _revision(rev: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """A main commit as the watermark names it: ``{commitId, at, actor, message}``."""
    if not rev:
        return None
    return {"commitId": rev.get("commit_id"), "at": rev.get("created_at"),
            "actor": rev.get("actor"), "message": rev.get("message")}


def _last_build(wm: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The build in flight: ``running``, or ``waiting`` (for room, a lock or a summaries job), with
    why, or the error its last attempt failed with; ``at``, when it was asked for. Else the last
    one, while the copy it retired is kept (minutes; nothing else records a finished build):
    ``switched``, ``at`` known while no later update has published; or ``dropped``, ``at`` when it
    was. None: neither."""
    build = wm.get("candidate")
    if build:
        waiting = build.get("waiting")
        return {"outcome": "waiting" if waiting else "running", "at": build.get("since"),
                "why": waiting or build.get("error")}
    left = [e for e in wm.get("retired_keys") or [] if isinstance(e, Mapping) and e.get("build")]
    if not left:
        return None
    last = left[-1]                           # retired_keys only ever grows at its end
    if last.get("afterSeq"):                  # the copy its readers were switched from
        at = wm.get("last_projected_at") if wm.get("projected") == last["afterSeq"] else None
        return {"outcome": "switched", "at": at, "why": None}
    return {"outcome": "dropped", "at": last.get("retireAfter"), "why": None}


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
