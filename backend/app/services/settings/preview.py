"""What a proposed change set of versioned-graph settings would do, for the review before a save
(``POST …/settings/preview?mode=full``, :func:`.service.preview`). Each part is best effort: one
whose source can't be read is null and named in ``unavailable``, and the others still answer. A
part the change can't affect is null.

* ``graphs`` — of the graphs in the caller's reach (every graph for the platform, a workspace's,
  or the graph itself; not forks, which follow their root), how many would behave differently,
  and up to ten of them with what changes;
* ``alwaysLatest`` — graphs whose readers would move to Always the latest, read from the database
  while the graph store catches up, and graphs moving away from it;
* ``memory`` — the free memory a copy of the largest graph would need, against each node's under
  its start mark (system administrators only: node memory is operator data);
* ``residency`` — what the next memory check would unload, load and leave waiting on each node
  with the proposed values and classes, as the residency preview plans it
  (``residency.preview``);
* ``database`` — the most reads one process runs on the database at once, per graph and in all;
* ``drafts`` — closed drafts whose changes the next sweep would remove under a shorter window;
* ``outsideLimits`` — values chosen for workspaces and graphs that new limits would leave outside
  them: in force as exceptions, or ignored while the platform locks the setting;
* ``warnings`` — what to acknowledge before saving, each ``{code, text}``, with ``key`` where one
  setting is the cause.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config.settings_types import Setting
from backend.app.db.models import WorkspaceDataSourceORM

from . import resolver, store
from .resolver import SYSTEM_ADMIN, Context, Target

logger = logging.getLogger(__name__)

#: The most graphs, values or drafts a part lists.
SAMPLES = 10
#: What a copy's room is worked out from.
_MEMORY = frozenset({"builds.copyRoomPct", "builds.copyMaxBytes", "builds.method",
                     "residency.unloadStartPct"})
_DATABASE = ("database.readsPerProcess", "database.readsPerGraph", "database.readTimeoutMs")
_RETENTION = "drafts.keepClosedDays"
_CLASS = "residency.class"


async def labels(session: AsyncSession, data_source_ids: Iterable[Optional[str]]
                 ) -> Dict[str, str]:
    """The data sources' labels, by id."""
    ids = sorted({i for i in data_source_ids if i})
    if not ids:
        return {}
    found = await session.execute(select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label)
                                  .where(WorkspaceDataSourceORM.id.in_(ids)))
    return dict(found.all())


async def impact(session: AsyncSession, target: Target, before: Context, after: Context,
                 changed: Set[str], *, scoped: Optional[Sequence[Tuple[Any, Target]]],
                 editor: str, facts: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """Every part, for ``changed`` at ``target``: ``before`` is the context as saved, ``after``
    with the changes in it. ``scoped`` holds the graphs in reach, each with its target (None:
    they couldn't be listed); ``facts`` the live facts, a system administrator's only."""
    operator = editor == SYSTEM_ADMIN
    out: Dict[str, Any] = dict.fromkeys(("graphs", "alwaysLatest", "memory", "residency",
                                         "database", "drafts", "outsideLimits"))
    unavailable: List[str] = []

    async def part(name: str, compute: Awaitable[Any]) -> None:
        try:
            out[name] = await compute
        except Exception:  # noqa: BLE001 — one unreadable source leaves the rest
            logger.warning("settings preview: %s could not be worked out", name, exc_info=True)
            unavailable.append(name)

    reach = _reach(before.settings, changed)
    if scoped is None:
        unavailable += ["graphs"] + (["alwaysLatest"] if "reads.mode" in reach else [])
    else:
        await part("graphs", _graphs(session, before, after, scoped, reach))
        if "reads.mode" in reach:
            out["alwaysLatest"] = _always_latest(before, after, scoped)
    if operator and changed & _MEMORY:
        await part("memory", _memory(before, after, facts))
    if operator and (_CLASS in changed or (target.scope == "platform"
                                           and changed & _residency_keys(before.settings))):
        await part("residency", _residency(session, after))
    if changed & set(_DATABASE) or (out["alwaysLatest"] or {}).get("joining"):
        out["database"] = _database(before, after, target, facts if operator else None)
    if _RETENTION in changed:
        if scoped is None:
            unavailable.append("drafts")
        else:
            await part("drafts", _drafts(before, after, scoped))
    if target.scope == "platform":
        out["outsideLimits"] = _outside_limits(before, after)
    out["warnings"] = _warnings(before, after, target, changed, out)
    out["unavailable"] = unavailable
    return out


# ── What a change reaches ─────────────────────────────────────────────────────────────────────────
def _reads(s: Setting) -> Set[str]:
    """The settings whose value ``s``'s resolution reads: through a cap, a rule, the setting it is
    derived from, or a requirement of it or of one of its choices."""
    found = {c.setting for c in s.caps if c.setting} | {r.other for r in s.rules}
    found |= {r.setting for r in s.requires if r.setting}
    found |= {r.setting for c in s.choices for r in c.requires if r.setting}
    if s.key in resolver.DERIVED:
        found.add(resolver.DERIVED[s.key][0])
    return found


def _reach(settings: Mapping[str, Setting], changed: Set[str]) -> Set[str]:
    """The changed settings, and every setting whose answer reads one of them, however far."""
    reach = set(changed)
    while True:
        grown = {s.key for s in settings.values() if s.key not in reach and _reads(s) & reach}
        if not grown:
            return reach
        reach |= grown


def _same(a: Any, b: Any) -> bool:
    return a == b and isinstance(a, bool) == isinstance(b, bool)


async def _graphs(session: AsyncSession, before: Context, after: Context,
                  scoped: Sequence[Tuple[Any, Target]], reach: Set[str]) -> Dict[str, Any]:
    moved = []
    for graph, target in scoped:
        changes = []
        for key in sorted(reach):
            was = resolver.effective(before, key, target)
            will = resolver.effective(after, key, target)
            if not _same(was, will):
                changes.append({"key": key, "from": was, "to": will})
        if changes:
            moved.append((graph, changes))
    shown = moved[:SAMPLES]
    named = await labels(session, (g.data_source_id for g, _c in shown))
    return {"inScope": len(scoped), "changed": len(moved), "samples": [
        {"graphId": g.graph_id, "dataSourceId": g.data_source_id, "workspaceId": g.workspace_id,
         "label": named.get(g.data_source_id), "changes": changes} for g, changes in shown]}


def _always_latest(before: Context, after: Context,
                   scoped: Sequence[Tuple[Any, Target]]) -> Dict[str, int]:
    joining = leaving = 0
    for _graph, target in scoped:
        was = resolver.effective(before, "reads.mode", target) == "latest"
        will = resolver.effective(after, "reads.mode", target) == "latest"
        joining += will and not was
        leaving += was and not will
    return {"joining": joining, "leaving": leaving}


# ── Memory ────────────────────────────────────────────────────────────────────────────────────────
async def _memory(before: Context, after: Context,
                  facts: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """A copy of the largest graph needs its size times the copy room free on its node, under the
    node's start mark (as the registry's recommendations work it out)."""
    largest, nodes = (facts or {}).get("largestGraphBytes"), (facts or {}).get("nodes")
    if largest is None or not nodes:
        raise LookupError("the largest graph's size or the nodes' memory isn't known")
    need = {"from": int(largest) * int(resolver.effective(before, "builds.copyRoomPct")) // 100,
            "to": int(largest) * int(resolver.effective(after, "builds.copyRoomPct")) // 100}
    start = int(resolver.effective(after, "residency.unloadStartPct"))
    cap = resolver.effective(after, "builds.copyMaxBytes")
    rows = []
    for node in nodes:
        if not node.get("maxBytes") or node.get("usedBytes") is None:
            continue
        free = int(node["maxBytes"]) * start // 100 - int(node["usedBytes"])
        rows.append({"name": node.get("name"), "usedBytes": node["usedBytes"],
                     "maxBytes": node["maxBytes"], "freeBytes": free, "fits": free >= need["to"]})
    return {"largestGraphBytes": largest, "neededBytes": need,
            "copied": (resolver.effective(after, "builds.method") != "reseed"
                       and (cap == resolver.UNLIMITED or int(largest) <= int(cap))),
            "nodes": rows}


def _residency_keys(settings: Mapping[str, Setting]) -> Set[str]:
    """The settings the residency policy holds; not the class, which each graph's row stores."""
    return {s.key for s in settings.values()
            if s.legacy is not None and s.legacy.residency_policy and not s.materialized}


async def _residency(session: AsyncSession, after: Context) -> Dict[str, Any]:
    """The capacity planner run on the proposed values against current memory and graphs, each
    graph of the class the proposed settings give it, acting on nothing, as the residency
    policy's preview runs it."""
    from backend.app.services.versioning import residency, residency_policy

    wire = {s.legacy.residency_policy: resolver.encode(s, resolver.effective(after, s.key))
            for s in after.settings.values() if s.key in _residency_keys(after.settings)}
    pending = residency_policy.graph_values_pending(await store.imports_done(session))
    decided, snap = await residency.preview(residency_policy.effective(wire),
                                            classes=residency_policy.classes(after,
                                                                             pending=pending))
    listed = [x for m in decided.masters for x in (*m.evictions, *m.loads, *m.waits)]
    named = await labels(session, (snap.rows.get(x.graph_id, {}).get("data_source_id")
                                   for x in listed))

    def item(x: Any, **extra: Any) -> Dict[str, Any]:
        ds = snap.rows.get(x.graph_id, {}).get("data_source_id")
        return {"graphId": x.graph_id, "dataSourceId": ds, "label": named.get(ds),
                "bytes": x.bytes, **extra}

    return {
        "switchOn": after.switches.get(residency_policy.SWITCH) is True,
        "nodes": [{
            "name": m.master.endpoint, "usedBytes": m.master.used,
            "maxBytes": m.master.maxmemory or None, "usedAfterBytes": m.used_after,
            "unloads": [item(e, reason=e.reason) for e in m.evictions],
            "loads": [item(x) for x in m.loads],
            "waits": [item(w, reason=w.reason, shortfallBytes=w.shortfall) for w in m.waits],
        } for m in decided.masters],
        "unloads": len(decided.evictions),
        "unloadedBytes": sum(e.bytes or 0 for e in decided.evictions),
        "loads": len(decided.loads),
        "waits": sum(len(m.waits) for m in decided.masters),
    }


# ── The database ──────────────────────────────────────────────────────────────────────────────────
def _database(before: Context, after: Context, target: Target,
              facts: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """The bounds on reads from the database before and after: one process runs at most
    ``readsPerProcess`` at once, however many graphs read from it, each for up to
    ``readTimeoutMs``; with the connections one process's pool holds (``poolSize``, a system
    administrator's to see)."""
    out: Dict[str, Any] = {key.split(".", 1)[1]: {"from": resolver.effective(before, key, target),
                                                  "to": resolver.effective(after, key, target)}
                           for key in _DATABASE}
    if facts is not None:
        out["poolSize"] = facts.get("poolSize")
    return out


# ── Drafts ────────────────────────────────────────────────────────────────────────────────────────
async def _drafts(before: Context, after: Context,
                  scoped: Sequence[Tuple[Any, Target]]) -> Dict[str, Any]:
    """Closed drafts the next sweep would remove that the window in force keeps, in each
    workspace whose window gets shorter."""
    windows: Dict[Tuple[Any, Any], List[str]] = {}
    for workspace_id in sorted({graph.workspace_id for graph, _t in scoped}):
        at = Target("workspace", workspace_id)
        was = resolver.effective(before, _RETENTION, at)
        will = resolver.effective(after, _RETENTION, at)
        if resolver.as_number(will) < resolver.as_number(was):
            windows.setdefault((was, will), []).append(workspace_id)
    removed = 0
    for (was, will), workspaces in windows.items():
        removed += await _closed_drafts(workspaces, was, will)
    return {"workspaces": sum(len(w) for w in windows.values()), "removedAtNextSweep": removed}


async def _closed_drafts(workspaces: Sequence[str], was: Any, will: Any) -> int:
    """The drafts in these workspaces' graphs merged or abandoned between ``will`` and ``was``
    days ago whose changes are still there, and that nothing holds: what a sweep with a window of
    ``will`` days removes and one of ``was`` keeps (``prune_closed_drafts``' own rule)."""
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import (BranchORM, GraphORM, JobORM,
                                                        MergeRequestORM)
    from backend.app.services.versioning.service import _TERMINAL_PR_STATUS

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=int(will))).isoformat()
    b = BranchORM
    query = select(func.count()).select_from(b).join(GraphORM, GraphORM.id == b.graph_id).where(
        b.kind.in_(("draft", "fork_draft")), b.status.in_(("merged", "abandoned")),
        b.pruned_at.is_(None), b.updated_at < cutoff,
        GraphORM.workspace_id.in_(list(workspaces)), GraphORM.deleted_at.is_(None),
        GraphORM.lifecycle_state == "live",
        or_(GraphORM.lifecycle_changed_at.is_(None), GraphORM.lifecycle_changed_at < cutoff),
        ~select(1).where(MergeRequestORM.source_branch_id == b.id,
                         MergeRequestORM.status.not_in(_TERMINAL_PR_STATUS)).exists(),
        ~select(1).where(JobORM.branch_id == b.id,
                         JobORM.status.in_(("pending", "running"))).exists())
    if was != resolver.FOREVER:
        query = query.where(b.updated_at >= (now - timedelta(days=int(was))).isoformat())
    async with gvdb.graphver_session() as s:
        return int((await s.execute(query)).scalar_one())


# ── Limits ────────────────────────────────────────────────────────────────────────────────────────
def _limits(ctx: Context, s: Setting) -> Mapping[str, Any]:
    row = ctx.rows.get((s.key, "platform", ""))
    return row.limits if row is not None and row.limits is not None else s.default_limits


def _outside_limits(before: Context, after: Context) -> Optional[Dict[str, Any]]:
    """The values below the platform that the new limits would leave outside them, for each setting
    whose limits change: an exception, in force; or, while locked, ignored."""
    moved = {s.key: _limits(after, s) for s in after.settings.values()
             if s.limitable and _limits(after, s) != _limits(before, s)}
    if not moved:
        return None
    found = []
    for (key, scope, scope_id), row in after.rows.items():
        if key not in moved or scope == "platform" or row.value is None:
            continue
        if moved[key].get("lock"):
            status = "locked"
        elif resolver.outside_limits(moved[key], row.value):
            status = "exception"
        else:
            continue
        found.append({"key": key, "scope": scope, "scopeId": scope_id, "value": row.value,
                      "status": status})
    found.sort(key=lambda f: (f["key"], f["scope"], f["scopeId"]))
    return {"count": len(found), "locked": sum(f["status"] == "locked" for f in found),
            "samples": found[:SAMPLES]}


# ── Warnings ──────────────────────────────────────────────────────────────────────────────────────
def _riskier(s: Setting, was: Any, will: Any) -> bool:
    """Whether a change moves the way one of the setting's high-weight effects says is worse. A
    change of a value that is neither a number nor a switch (a choice, an identifier) always
    counts."""
    if isinstance(will, bool):
        up = will
    else:
        a, b = resolver.as_number(was), resolver.as_number(will)
        if a is None or b is None:
            return True
        up = b > a
    return any(e.weight == "high" and e.up_verdict is not None and (e.up_verdict == "worse") == up
               for e in s.guidance.effects)


def _plural(n: int, one: str, many: str) -> str:
    return f"{n:,} {one if n == 1 else many}"


def _warnings(before: Context, after: Context, target: Target, changed: Set[str],
              parts: Mapping[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for key in sorted(changed):
        s = before.settings[key]
        was = resolver.effective(before, key, target)
        will = resolver.effective(after, key, target)
        if s.guidance.risk == "high" and not _same(was, will) and _riskier(s, was, will):
            out.append({"code": "risky_change", "key": key, "text": s.guidance.risk_note})
    drafts, outside = parts["drafts"], parts["outsideLimits"]
    residency, memory, database = parts["residency"], parts["memory"], parts["database"]
    if drafts and drafts["removedAtNextSweep"]:
        out.append({"code": "drafts_removed", "key": _RETENTION, "text": (
            f"The next sweep removes the changes of "
            f"{_plural(drafts['removedAtNextSweep'], 'closed draft', 'closed drafts')}, and that "
            f"can't be undone.")})
    if outside and outside["locked"]:
        n = outside["locked"]
        out.append({"code": "values_locked_out", "text": (
            f"While locked, {_plural(n, 'value', 'values')} chosen for a workspace or a graph "
            f"{'is' if n == 1 else 'are'} ignored.")})
    if residency and residency["switchOn"] and residency["unloads"]:
        out.append({"code": "graphs_unloaded", "text": (
            f"The next memory check unloads {_plural(residency['unloads'], 'graph', 'graphs')}. "
            f"Each is read from the database until it loads again.")})
    if memory and memory["copied"] and memory["nodes"] and not any(
            n["fits"] for n in memory["nodes"]):
        out.append({"code": "copy_wont_fit", "key": "builds.copyRoomPct", "text": (
            "No node has the free memory a copy of your largest graph needs. Its builds wait for "
            "room, or are built from the database.")})
    pool = (database or {}).get("poolSize")
    reads = (database or {}).get("readsPerProcess", {}).get("to")
    if "database.readsPerProcess" in changed and pool and isinstance(reads, int) and reads >= pool:
        out.append({"code": "reads_fill_pool", "key": "database.readsPerProcess",
                    "text": before.settings["database.readsPerProcess"].guidance.risk_note})
    return out
