"""The versioned-graph settings as the API serves and changes them: each setting's value in force at
the platform, a workspace or a graph and where it came from, a save checked and written all or
nothing, a preview of what a save would do, and the history of changes, each of which can be put
back.

A consumer reads a setting through :mod:`.effective`, from its process's snapshot. The API reads
what is saved now: the rows (``store.read_domain``), the feature switches
(``FeatureFlagService(ttl=0)``) and the deployment's environment. An administrator then sees what
was saved a moment ago, by anyone, and a save is checked against the values as they are.

Who edits: ``system_admin``, with ``system:admin``; ``workspace_admin``, with ``workspace:admin`` in
the workspace (an organisation admin holds it in every one); anyone else only reads. Per setting
and scope the registry says which of the two may set it (:mod:`.validate`).

A graph's values are its data source's: that is the store's scope id. A fork has none of its own.
It follows the graph it was forked from (:class:`FollowsRoot`).
"""
from __future__ import annotations

import dataclasses
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.common.activity_context import current_provenance
from backend.app.db.models import SettingChangeORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.activity import recorder
from backend.app.services.permission_service import PermissionClaims, has_permission

from . import effects, facts, legacy, preview as previews, registry, resolver, store
from .resolver import PLATFORM, SYSTEM_ADMIN, WORKSPACE_ADMIN, Context, Row, Target
from .snapshot import env_reader
from .store import KEEP, Change
from .validate import validate

logger = logging.getLogger(__name__)

#: The activity event a change set records, by the scope it changed: in the versioning families
#: of the platform's and the workspace's events, as the settings events before the store were.
EVENTS = {"platform": "platform.versioning.settings_updated",
          "workspace": "workspace.versioning.settings_updated",
          "graph": "workspace.versioning.graph_settings_updated"}


class InvalidSettings(Exception):
    """Changes that can't be saved as they are (422 ``invalid_settings``): ``errors``, each
    ``{key, code, message}``. Nothing was saved."""
    code = "invalid_settings"

    def __init__(self, errors: List[Dict[str, str]]):
        self.errors = errors
        super().__init__("; ".join(e["message"] for e in errors))


class FollowsRoot(Exception):
    """A fork has no settings of its own: it follows the graph it was forked from, ``root``
    (409 ``follows_root``)."""
    code = "follows_root"

    def __init__(self, root: "Graph"):
        self.root = root
        why = {w.code: w for w in registry().WHY}.get(self.code)
        super().__init__(why.text if why is not None else "A fork follows the graph it was "
                                                          "forked from.")


class NotRevertible(Exception):
    """A change set that changed values in more than one place at once (an import, an adoption)
    is not put back as one (409 ``not_revertible``)."""
    code = "not_revertible"

    def __init__(self) -> None:
        super().__init__("This change was made in more than one place at once, so it can't be "
                         "put back as one: change each place's values back instead.")


# ── Whose settings ────────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Place:
    """Whose settings a request is about: the resolver's target, and a graph's own id."""
    target: Target
    graph_id: Optional[str] = None

    @property
    def scope(self) -> str:
        return self.target.scope

    @property
    def scope_id(self) -> str:
        """The store's id for the place: ``''``, the workspace's, or the data source's."""
        t = self.target
        return {"platform": "", "workspace": t.workspace_id, "graph": t.graph_id}[t.scope] or ""

    def ids(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"scope": self.scope}
        if self.target.workspace_id:
            out["workspaceId"] = self.target.workspace_id
        if self.scope == "graph":
            out.update(graphId=self.graph_id, dataSourceId=self.target.graph_id)
        return out


PLATFORM_PLACE = Place(PLATFORM)


def workspace_place(workspace_id: str) -> Place:
    return Place(Target("workspace", workspace_id))


@dataclass(frozen=True)
class Graph:
    """A live versioned graph as its settings resolve: its data source (the store's scope id), its
    workspace, the graph it was forked from, and whether its copy is the platform's (False: a
    connected graph, read from its owner's own copy, which is never built beside)."""
    graph_id: str
    workspace_id: str
    data_source_id: str
    fork_parent_graph_id: Optional[str]
    platform_copy: bool


async def graphs(*, workspace_id: Optional[str] = None, graph_id: Optional[str] = None,
                 data_source_id: Optional[str] = None) -> List[Graph]:
    """The live versioned graphs, forks too, by graph id: every one, or a workspace's, one graph,
    or a data source's."""
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

    query = (select(GraphORM.id, GraphORM.workspace_id, GraphORM.data_source_id,
                    GraphORM.fork_parent_graph_id, ProjectionStateORM.owns_falkor_graph)
             .outerjoin(ProjectionStateORM, ProjectionStateORM.graph_id == GraphORM.id)
             .where(GraphORM.deleted_at.is_(None)).order_by(GraphORM.id))
    for column, wanted in ((GraphORM.workspace_id, workspace_id), (GraphORM.id, graph_id),
                           (GraphORM.data_source_id, data_source_id)):
        if wanted is not None:
            query = query.where(column == wanted)
    async with gvdb.graphver_session() as s:
        found = (await s.execute(query)).all()
    return [Graph(r[0], r[1], r[2], r[3], bool(r[4])) for r in found]


def root_of(graph: Graph, by_id: Mapping[str, Graph]) -> Graph:
    """The graph whose settings ``graph`` follows: itself, or a fork's root, up a fork of a fork.
    A fork lives in its root's workspace (it is made there, and moves with it)."""
    while graph.fork_parent_graph_id in by_id:
        graph = by_id[graph.fork_parent_graph_id]
    return graph


def target_of(graph: Graph, by_id: Mapping[str, Graph]) -> Target:
    """A graph's target. A fork's resolves through its root, whose copy serves its reads."""
    root = root_of(graph, by_id)
    graph_facts: Dict[str, Any] = {"platform_copy": root.platform_copy}
    if root is not graph:
        graph_facts["fork_of"] = root.data_source_id
    return Target("graph", root.workspace_id, graph.data_source_id, graph_facts)


async def graph_place(meta: Mapping[str, Any]) -> Place:
    """The settings of the graph ``meta`` names (``graph_in_workspace``'s answer). A fork has none
    of its own: :class:`FollowsRoot`, naming the graph it follows."""
    if meta.get("fork_parent_graph_id"):
        by_id = {g.graph_id: g for g in await graphs(workspace_id=meta["workspace_id"])}
        fork = by_id.get(meta["graph_id"]) or Graph(meta["graph_id"], meta["workspace_id"],
                                                    meta["data_source_id"],
                                                    meta["fork_parent_graph_id"], False)
        raise FollowsRoot(root_of(fork, by_id))
    found = await graphs(graph_id=meta["graph_id"])
    copy = found[0].platform_copy if found else False
    return Place(Target("graph", meta["workspace_id"], meta["data_source_id"],
                        {"platform_copy": copy}), graph_id=meta["graph_id"])


async def _place_of(session: AsyncSession, scope: str, scope_id: str) -> Place:
    """The place a change set changed, from its scope and the store's id for it."""
    if scope == "platform":
        return PLATFORM_PLACE
    if scope == "workspace":
        return workspace_place(scope_id)
    ds = await session.get(WorkspaceDataSourceORM, scope_id)
    found = await graphs(data_source_id=scope_id)
    graph_facts = {"platform_copy": found[0].platform_copy} if found else {}
    return Place(Target("graph", ds.workspace_id if ds is not None else None, scope_id,
                        graph_facts), graph_id=found[0].graph_id if found else None)


async def _covers(session: AsyncSession, place: Place, scope: str, scope_id: str) -> bool:
    """Whether the changes at ``scope``/``scope_id`` are ``place``'s to see: everything for the
    platform's administrators, a workspace's own and its graphs', a graph's own."""
    if place.scope == "platform":
        return True
    if place.scope == "graph":
        return (scope, scope_id) == ("graph", place.scope_id)
    if scope == "workspace":
        return scope_id == place.scope_id
    if scope != "graph":
        return False
    ds = await session.get(WorkspaceDataSourceORM, scope_id)
    return ds is not None and ds.workspace_id == place.scope_id


def editor_of(claims: PermissionClaims, workspace_id: Optional[str] = None) -> Optional[str]:
    """The role the caller edits as: ``system_admin`` (``system:admin``), ``workspace_admin``
    (``workspace:admin`` in the workspace, which ``system:org-admin`` implies), or None: they
    only read."""
    if has_permission(claims, "system:admin"):
        return SYSTEM_ADMIN
    if workspace_id is not None and has_permission(claims, "workspace:admin",
                                                   workspace_id=workspace_id):
        return WORKSPACE_ADMIN
    return None


# ── What a resolution reads ───────────────────────────────────────────────────────────────────────
async def _switches(session: AsyncSession) -> Dict[str, Any]:
    """Every feature switch, read now from the feature store, not the flag cache."""
    from backend.app.services.feature_flags import FeatureFlagService

    return await FeatureFlagService(ttl=0).get_all(session)


async def context(session: AsyncSession) -> Context:
    """The resolver's context as saved now: every row of the domain, the switches, the
    environment."""
    reg = registry()
    return resolver.context(reg.SETTINGS, await store.read_domain(session, reg.DOMAIN),
                            switches=await _switches(session),
                            env=env_reader(reg.SETTINGS, reg.DEPLOYMENT), why=reg.WHY)


def with_changes(ctx: Context, place: Place, changes: Sequence[Change]) -> Context:
    """``ctx`` as it would be once ``changes`` (all at ``place``) are saved."""
    rows = dict(ctx.rows)
    for c in changes:
        at = (c.key, place.scope, place.scope_id)
        old = rows.get(at) or Row(*at)
        rows[at] = dataclasses.replace(old, value=old.value if c.value is KEEP else c.value,
                                       limits=old.limits if c.limits is KEEP else c.limits)
    return dataclasses.replace(ctx, rows=rows)


def own_values(rows: Mapping[Tuple[str, str, str], Row]) -> Dict[str, List[str]]:
    """Each data source whose graph chose values of its own, and their keys."""
    out: Dict[str, List[str]] = {}
    for (key, scope, scope_id), row in rows.items():
        if scope == "graph" and row.value is not None:
            out.setdefault(scope_id, []).append(key)
    return {ds: sorted(keys) for ds, keys in out.items()}


# ── Values ────────────────────────────────────────────────────────────────────────────────────────
def _items(ctx: Context, place: Place, resolved: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The resolver's answers as served. The platform's carry their saved ``limits`` too (null:
    the setting's default limits apply)."""
    items = list(resolved)
    if place.scope == "platform":
        for item in items:
            row = ctx.rows.get((item["key"], "platform", ""))
            item["limits"] = row.limits if row is not None else None
    return items


def _version(ctx: Context, place: Place) -> int:
    """The highest revision among the rows ``place``'s values read: it moves whenever one of them
    is saved."""
    t = place.target
    reads = {("platform", ""), ("workspace", t.workspace_id), ("graph", t.graph_id)}
    return max((r.rev for (_k, scope, sid), r in ctx.rows.items() if (scope, sid) in reads),
               default=0)


async def values(session: AsyncSession, place: Place, editor: Optional[str], *,
                 ctx: Optional[Context] = None) -> Dict[str, Any]:
    """``{scope, workspaceId?, graphId?, dataSourceId?, editor, values, version}``: every setting
    at ``place`` as the resolver answers it, in the registry's order, for ``editor``."""
    ctx = ctx if ctx is not None else await context(session)
    resolved = resolver.resolve_all(ctx, place.target, editor=editor)
    return {**place.ids(), "editor": editor, "values": _items(ctx, place, resolved.values()),
            "version": _version(ctx, place)}


async def schema(session: AsyncSession, *, operator: bool) -> Dict[str, Any]:
    """The registry (``schema_json``), its examples and posture sentences rendered with the
    platform's values in force. Its recommendations from live facts (node memory, the largest
    graph) only for an ``operator``: those facts are a system administrator's to see. So are the
    values the deployment sets, read as config has them now: each "set by your deployment"
    fact's, and each cap's (:func:`_with_deployment_values`)."""
    ctx = await context(session)
    in_force = {key: r["effective"] for key, r in resolver.resolve_all(ctx).items()}
    out = registry().schema_json(in_force, await facts.collect() if operator else None)
    if operator:
        _with_deployment_values(out, ctx, in_force)
    return out


def _reading(ctx: Context, env: str) -> Dict[str, Any]:
    """A value the deployment sets, as this process's config reads it now: ``{value, set,
    problem}``. ``set`` False: the deployment leaves it to the default. ``value`` None when it
    can't be read, and ``problem`` says why; never a guess."""
    try:
        found = ctx.env(env)
    except Exception:  # noqa: BLE001 — said, rather than failing the registry
        logger.warning("settings schema: %s could not be read", env, exc_info=True)
        return {"value": None, "set": None, "problem": "It couldn't be read just now."}
    if found is None:                 # read by the worker alone, and not set: its default applies
        return {"value": None, "set": False,
                "problem": "Your deployment doesn't set it, and the default the worker uses "
                           "isn't one this server reads."}
    value = found.value
    if isinstance(value, str):        # the raw text, for a value config doesn't read
        try:
            number = float(value.strip())
        except ValueError:
            return {"value": None, "set": True,
                    "problem": f"Your deployment's value “{value}” isn't a number."}
        value = int(number) if number.is_integer() else number
    return {"value": value, "set": found.set, "problem": None}


def _with_deployment_values(out: Dict[str, Any], ctx: Context,
                            in_force: Mapping[str, Any]) -> None:
    """Give ``out`` (``schema_json``'s answer) the values the deployment sets, for a system
    administrator: each deployment fact's ``value``, whether the deployment sets it, and why it
    can't be read (:func:`_reading`); and each cap's ``value``, the deployment's or that of the
    setting that caps it, in force on the platform."""
    for fact in out["deployment"]:
        fact.update(_reading(ctx, fact["env"]))
    for setting in out["settings"]:
        for cap in setting["caps"]:
            if cap.get("deployment"):
                reading = _reading(ctx, cap["deployment"])
                cap.update(value=reading["value"], problem=reading["problem"])
            else:
                value = in_force.get(cap.get("setting"))
                cap.update(value=value, problem=None if value is not None else
                           "The setting that caps it couldn't be read.")


async def workspace_graphs(session: AsyncSession, workspace_id: str, *,
                           cursor: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
    """A page of a workspace's versioned graphs, by graph id: each with the settings it chose
    itself (``ownSettings``), the graph it follows when it is a fork, and the read mode and
    residency class in force (``{effective, declared, source, status, why}``)."""
    ctx = await context(session)
    listed = await graphs(workspace_id=workspace_id)
    by_id = {g.graph_id: g for g in listed}
    page = [g for g in listed if cursor is None or g.graph_id > cursor][:limit + 1]
    more, page = len(page) > limit, page[:limit]
    named = await previews.labels(session, (g.data_source_id for g in page))
    own = own_values(ctx.rows)

    def brief(key: str, target: Target) -> Dict[str, Any]:
        res = resolver.resolve(ctx, key, target)
        return {k: res[k] for k in ("effective", "declared", "source", "status", "why")}

    out = []
    for g in page:
        target, root = target_of(g, by_id), root_of(g, by_id)
        out.append({
            "graphId": g.graph_id, "dataSourceId": g.data_source_id,
            "label": named.get(g.data_source_id),
            "follows": ({"graphId": root.graph_id, "dataSourceId": root.data_source_id}
                        if root is not g else None),
            "ownSettings": own.get(g.data_source_id, []),
            "readMode": brief("reads.mode", target),
            "residencyClass": brief("residency.class", target),
        })
    return {"scope": "workspace", "workspaceId": workspace_id, "graphs": out,
            "nextCursor": page[-1].graph_id if more else None}


# ── Saving ────────────────────────────────────────────────────────────────────────────────────────
def _check(ctx: Context, place: Place, changes: Sequence[Change], editor: str) -> None:
    """Refuse what can't be saved: ``validate.SettingNotPermitted`` (403) for a value the editor
    may not set, else :class:`InvalidSettings` (422) for every other problem, a setting changed
    twice in one save among them."""
    seen, twice = set(), []
    for c in changes:
        if c.key in seen:
            s = ctx.settings.get(c.key)
            twice.append({"key": c.key, "code": "duplicate_change",
                          "message": f"{s.label if s else c.key} is changed more than once"})
        seen.add(c.key)
    if twice:
        raise InvalidSettings(twice)
    errors = validate(ctx, place.target, changes, editor=editor)
    if errors:
        raise InvalidSettings(errors)


def checker(editor: Optional[str], workspace_id: Optional[str] = None):
    """What an old endpoint's save (``legacy.save(check=...)``) runs under the writers' lock: the
    changes checked for ``editor`` exactly as a PATCH is (the platform's limits and locks among the
    rest), raising what a PATCH raises. None when there is nobody to check for. A graph's
    ``workspace_id`` names the workspace its values resolve through."""
    if editor is None:
        return None

    async def check(session: AsyncSession, scope: str, scope_id: str,
                    changes: Sequence[Change]) -> None:
        target = (Target("graph", workspace_id, scope_id) if scope == "graph"
                  else Target("workspace", scope_id) if scope == "workspace" else Target())
        _check(await context(session), Place(target), changes, editor)

    return check


async def _record(session: AsyncSession, change_set: store.ChangeSet, place: Place) -> None:
    """The change set's one activity event, filed under its place, with each value before and
    after, and the platform's limits where they changed, under the reason it was saved with."""
    provenance = current_provenance()
    if provenance is None:
        return
    if change_set.reason:
        provenance = dataclasses.replace(provenance, stated_reason=change_set.reason)
    applied = change_set.applied
    details: Dict[str, Any] = {
        "domain": change_set.domain, "changeSet": str(change_set.id), "source": change_set.source,
        "from": {a.key: a.before_value for a in applied},
        "to": {a.key: a.after_value for a in applied},
    }
    limits = {a.key: {"from": a.before_limits, "to": a.after_limits} for a in applied
              if a.before_limits != a.after_limits}
    if limits:
        details["limits"] = limits
    where: Dict[str, Any] = {}
    if place.scope == "workspace":
        ws = await session.get(WorkspaceORM, place.scope_id)
        where = {"workspace_id": place.scope_id, "target_type": "workspace",
                 "target_id": place.scope_id, "target_label": ws.name if ws is not None else None}
    elif place.scope == "graph":
        ds = await session.get(WorkspaceDataSourceORM, place.scope_id)
        where = (recorder.data_source_target(ds) if ds is not None else
                 {"workspace_id": place.target.workspace_id, "data_source_id": place.scope_id,
                  "target_type": "data_source", "target_id": place.scope_id})
        details["graphId"] = place.graph_id
    await recorder.record_activity(session, event_type=EVENTS[place.scope],
                                   provenance=provenance, details=details, **where)


def _before_commit(place: Place) -> store.Hook:
    """What a save does in its own transaction: its activity event, then the write to where each
    value lived before the store (``legacy.write_through``), so a rollback to the previous image
    behaves as configured."""
    async def hook(session: AsyncSession, change_set: store.ChangeSet) -> None:
        if change_set.applied:
            await _record(session, change_set, place)
            await legacy.write_through(session, change_set)
    return hook


async def _saved(session: AsyncSession, place: Place, editor: str,
                 change_set: store.ChangeSet) -> Dict[str, Any]:
    out = await values(session, place, editor)
    out["changeSetId"] = str(change_set.id) if change_set.applied else None
    return out


async def save(session: AsyncSession, place: Place, changes: Sequence[Change], *, editor: str,
               actor: str, reason: Optional[str] = None) -> Dict[str, Any]:
    """Save ``changes`` (all at ``place``) as ``editor``, all or nothing: refused as
    :func:`_check` refuses them, or :class:`~.store.SettingsConflict` (409) for a value changed
    since it was read. Then what the save sets in motion (:func:`.effects.after_save`). Returns
    the values as :func:`values` gives them, and the change set's id (None: nothing changed)."""
    ctx = await context(session)
    _check(ctx, place, changes, editor)
    change_set = await store.apply(session, registry().DOMAIN, changes, actor=actor, reason=reason,
                                   source="api", before_commit=_before_commit(place))
    await effects.after_save(change_set)
    return await _saved(session, place, editor, change_set)


# ── Previewing ────────────────────────────────────────────────────────────────────────────────────
def _moved(before: Mapping[str, Any], after: Mapping[str, Any]) -> bool:
    """Whether a setting's answer changed: its value, where it came from, its status or why."""
    def said(res: Mapping[str, Any]) -> Tuple[Any, ...]:
        return (res["effective"], res["declared"], res["source"], res["status"],
                [w["code"] for w in res["why"]])
    return said(before) != said(after)


async def preview(session: AsyncSession, place: Place, changes: Sequence[Change], *, editor: str,
                  full: bool = False) -> Dict[str, Any]:
    """What saving ``changes`` would do, saving nothing, refused as a save is (no version is
    checked). ``values``: each changed setting, and each other whose answer would change, as
    :func:`values` gives it once saved, with its ``example`` rendered with the values that would
    be in force. ``full`` adds ``impact`` (:func:`.preview.impact`)."""
    ctx = await context(session)
    _check(ctx, place, changes, editor)
    after = with_changes(ctx, place, changes)
    before_res = resolver.resolve_all(ctx, place.target, editor=editor)
    after_res = resolver.resolve_all(after, place.target, editor=editor)
    changed = {c.key for c in changes}
    found = await facts.collect() if editor == SYSTEM_ADMIN else None
    in_force = {key: res["effective"] for key, res in after_res.items()}
    items = []
    for key, res in after_res.items():
        if key in changed or _moved(before_res[key], res):
            example = ctx.settings[key].guidance.example
            items.append({**res, "example": example(in_force, found) if example else ""})
    out = {**place.ids(), "mode": "full" if full else "quick",
           "values": _items(after, place, items)}
    if full:
        try:
            scoped: Optional[List[Tuple[Graph, Target]]] = await _in_scope(place)
        except Exception:  # noqa: BLE001 — the parts that need the graphs say so
            logger.warning("settings preview: the graphs could not be listed", exc_info=True)
            scoped = None
        out["impact"] = await previews.impact(session, place.target, ctx, after, changed,
                                              scoped=scoped, editor=editor, facts=found)
    return out


async def _in_scope(place: Place) -> List[Tuple[Graph, Target]]:
    """The graphs a change at ``place`` reaches, each with its target: every graph for the
    platform, a workspace's, or the graph itself. Not forks: each follows its root."""
    listed = await graphs(workspace_id=None if place.scope == "platform"
                          else place.target.workspace_id)
    by_id = {g.graph_id: g for g in listed}
    return [(g, target_of(g, by_id)) for g in listed if g.fork_parent_graph_id is None
            and (place.scope != "graph" or g.data_source_id == place.scope_id)]


# ── History ───────────────────────────────────────────────────────────────────────────────────────
async def history(session: AsyncSession, place: Place, *, key: Optional[str] = None,
                  actor: Optional[str] = None, since: Optional[datetime] = None,
                  until: Optional[datetime] = None, scope: Optional[str] = None,
                  before_id: Optional[int] = None, limit: int = 50) -> Dict[str, Any]:
    """A page of the changes ``place`` may see, newest first: the platform's administrators every
    change (``scope`` narrows them), a workspace its own and its graphs', a graph its own. Each
    entry: who, when, why, how (``source``), the value and limits before and after, and its
    change set, which :func:`revert` puts back."""
    from backend.app.db.repositories.view_repo import resolve_user_ids

    filters: Dict[str, Any] = {"key": key, "actor": actor, "since": since, "until": until,
                               "before_id": before_id, "limit": limit}
    domain = registry().DOMAIN
    if place.scope == "platform":
        found, more = await store.history(session, domain, scope=scope, **filters)
    elif place.scope == "graph":
        found, more = await store.history(session, domain, scope="graph",
                                          scope_id=place.scope_id, **filters)
    else:
        sources = (await session.execute(select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.workspace_id == place.scope_id))).scalars().all()
        found, more = await store.history(
            session, domain, places=[("workspace", [place.scope_id]), ("graph", sources)],
            **filters)
    names = await resolve_user_ids(session, {e.actor for e in found})
    return {**place.ids(), "entries": [{
        "id": e.id, "changeSetId": str(e.change_set), "at": e.at,
        "actor": ({"id": e.actor, "name": (names.get(e.actor) or (None,))[0]}
                  if e.actor else None),
        "reason": e.reason, "source": e.source, "key": e.key, "scope": e.scope,
        "scopeId": e.scope_id, "from": {"value": e.before_value, "limits": e.before_limits},
        "to": {"value": e.after_value, "limits": e.after_limits}, "version": e.version,
    } for e in found], "nextCursor": more}


async def revert(session: AsyncSession, place: Place, change_set_id: uuid.UUID, *, editor: str,
                 actor: str, reason: Optional[str] = None) -> Dict[str, Any]:
    """Put back what a change set changed, all or nothing, checked as a save is: the change set
    must be one ``place`` sees (else ``LookupError``, as for one there isn't), made in one place
    (else :class:`NotRevertible`), and every value it changed must be as it left it (else
    :class:`~.store.SettingsConflict`). Returns the values of the place it changed, and the new
    change set's id."""
    domain = registry().DOMAIN
    found = (await session.execute(
        select(SettingChangeORM.key, SettingChangeORM.scope, SettingChangeORM.scope_id,
               SettingChangeORM.before_value, SettingChangeORM.before_limits,
               SettingChangeORM.version)
        .where(SettingChangeORM.domain == domain, SettingChangeORM.change_set == change_set_id)
        .order_by(SettingChangeORM.id))).all()
    if not found:
        raise LookupError(str(change_set_id))
    places = {(r.scope, r.scope_id) for r in found}
    for s, sid in places:
        if not await _covers(session, place, s, sid):
            raise LookupError(str(change_set_id))
    if len(places) > 1:
        raise NotRevertible()
    ((scope, scope_id),) = places
    target = place if (scope, scope_id) == (place.scope, place.scope_id) else (
        await _place_of(session, scope, scope_id))
    ctx = await context(session)
    _check(ctx, target, [Change(r.key, scope, scope_id, r.version, value=r.before_value,
                                limits=r.before_limits if scope == "platform" else KEEP)
                         for r in found], editor)
    change_set = await store.revert(session, domain, change_set_id, actor=actor, reason=reason,
                                    before_commit=_before_commit(target))
    await effects.after_save(change_set)
    return await _saved(session, target, editor, change_set)
