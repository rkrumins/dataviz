"""The value in force, for code that acts on a versioned-graph setting: no query on a hot path.

Every consumer reads a setting here, never from the store or the old columns::

    await effective.refresh()                     # where the caller can wait: a request, a pass
    effective.value("updates.pacingRatio")        # sync, from this process's snapshot
    await effective.value_of("drafts.levels", workspace_id=ws, graph_id=ds)

:func:`refresh` asks the snapshot (:mod:`.snapshot`) for its rows, which costs a Redis read at most
every two seconds and a database read only when a save moved the domain's generation, and rebuilds
the resolver's :class:`~.resolver.Context` only when the rows or the feature switches changed.
:func:`value` then resolves from that context with no IO, so it can run per statement or per read.
:func:`value_of` refreshes first, and for a setting the registry marks ``strict`` (a rule people
act on, such as who may approve a review) it asks the generation at once, so a change holds from
the next request.

A graph's value resolves graph → workspace → platform, so a graph target names its workspace too
(``graph_id`` is the data source's id). Before the first refresh, and while the database is out of
reach before any rows were read, every value is the deployment's environment or the code default,
as it was before the store existed. :func:`readable` says whether the last refresh could read the
store, for the settings the registry marks ``unreadable="skip"``: a pass that would act on one
does nothing while it is False.
"""
from __future__ import annotations

import logging
from typing import Any, Mapping, Optional, Tuple

from . import registry
from .resolver import Context, Target, context, effective as _effective
from .snapshot import env_reader, snapshot

logger = logging.getLogger(__name__)

#: The context built from the rows and switches last read, and what it was built from.
_STATE: dict = {"ctx": None, "rows": None, "switches": None}


def _switch_keys() -> Tuple[str, ...]:
    """The feature switches the registry's requirements name (its settings' and their choices')."""
    keys = set()
    for s in registry().SETTINGS:
        for req in s.requires:
            if req.feature:
                keys.add(req.feature)
        for choice in s.choices:
            for req in choice.requires:
                if req.feature:
                    keys.add(req.feature)
    return tuple(sorted(keys))


async def _read_switches(keys: Tuple[str, ...]) -> Mapping[str, Optional[bool]]:
    """Each switch through the feature-flag cache; None for one that can't be read, which the
    resolver counts as off (a consumer that must not mistake unread for off asks the switch
    itself, as ``build_policy.switch_state`` does)."""
    from backend.app.services.feature_flags import feature_flags

    out = {}
    for key in keys:
        try:
            out[key] = await feature_flags.is_enabled_self_session(key, default=False)
        except Exception:  # noqa: BLE001 — a settings read never fails its caller
            logger.warning("settings: the %s switch could not be read", key, exc_info=True)
            out[key] = None
    return out


def _build(rows: Mapping, switches: Mapping[str, Optional[bool]]) -> Context:
    reg = registry()
    return context(reg.SETTINGS, rows, switches=switches,
                   env=env_reader(reg.SETTINGS, reg.DEPLOYMENT), why=reg.WHY)


async def refresh(*, strict: bool = False) -> Context:
    """Bring this process's context up to date (see the module's docstring) and return it."""
    rows = await snapshot().rows(strict=strict)
    switches = await _read_switches(_switch_keys())
    state = _STATE
    if state["ctx"] is None or rows is not state["rows"] or switches != state["switches"]:
        state.update(ctx=_build(rows, switches), rows=rows, switches=switches)
    return state["ctx"]


def context_now() -> Context:
    """The context as last refreshed, without IO; before any refresh, the defaults'."""
    if _STATE["ctx"] is None:
        _STATE.update(ctx=_build({}, {}), rows=None, switches=None)
    return _STATE["ctx"]


def target(workspace_id: Optional[str] = None, graph_id: Optional[str] = None,
           graph_facts: Optional[Mapping[str, Any]] = None) -> Target:
    """Whose value: a graph's (``graph_id``, the data source's id, with its workspace), a
    workspace's, or the platform's when neither is given."""
    scope = "graph" if graph_id else "workspace" if workspace_id else "platform"
    return Target(scope=scope, workspace_id=workspace_id, graph_id=graph_id,
                  graph_facts=dict(graph_facts or {}))


def value(key: str, *, workspace_id: Optional[str] = None, graph_id: Optional[str] = None,
          graph_facts: Optional[Mapping[str, Any]] = None) -> Any:
    """The value in force for ``key``, from the context as last refreshed, without IO."""
    return _effective(context_now(), key, target(workspace_id, graph_id, graph_facts))


async def value_of(key: str, *, workspace_id: Optional[str] = None,
                   graph_id: Optional[str] = None,
                   graph_facts: Optional[Mapping[str, Any]] = None,
                   strict: bool = False) -> Any:
    """:func:`value` after a :func:`refresh`, strict when asked or when the setting must never be
    stale."""
    strict = strict or registry().BY_KEY[key].freshness == "strict"
    ctx = await refresh(strict=strict)
    return _effective(ctx, key, target(workspace_id, graph_id, graph_facts))


def readable() -> bool:
    """Whether the values come from the store as the database last gave them: False before a
    :func:`refresh` read it, and while the database can't be read (the last rows, or the defaults,
    serve meanwhile)."""
    return snapshot().readable


def reset() -> None:
    """Forget the context (tests)."""
    _STATE.update(ctx=None, rows=None, switches=None)
