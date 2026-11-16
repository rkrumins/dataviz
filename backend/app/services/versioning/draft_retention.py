"""How long a merged or abandoned draft keeps its changes before the versioning worker removes them:
``drafts.keepClosedDays`` in the settings store (``config/versioned_graph_settings.py``), the
platform's unless a workspace chose its own. Forever keeps them for good.

The worker's sweep reads every workspace's window once a pass (``settings.effective.by_workspace``)
and removes by each, for its workspaces' graphs, and by the platform's for every other graph. When
the settings can't be read, the pass removes nothing: falling back to the default could remove what
an administrator chose to keep.

A system administrator sets the platform's window through ``/admin/versioning/draft-retention``
too, in that route's words (:func:`describe`): days, ``0`` for good, null for the environment's
default (``GRAPHVER_DRAFT_RETENTION_DAYS``, 30). :func:`effective` is the window the old column
(``platform_settings.gv_draft_retention_days``) gives, which one release keeps writing.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from . import config

#: The setting, in the settings store.
KEY = "drafts.keepClosedDays"
#: The days a window may be, in the route's words: 0 (keep for good) to ten years.
MIN_DAYS, MAX_DAYS = 0, 3650


def effective(saved: Optional[int]) -> int:
    """The window the old column gives for ``saved`` (None: the environment's default), within
    range."""
    days = config.DRAFT_RETENTION_DAYS if saved is None else saved
    return max(MIN_DAYS, min(MAX_DAYS, int(days)))


async def describe(session) -> Dict[str, Any]:
    """The platform's window as the admin card shows it, in the route's words: ``days`` in force,
    as ``saved`` (None: the default applies), ``default``, and the range a value may take."""
    from backend.app.services.settings import effective as settings, registry, resolver, store

    reg = registry()
    setting = reg.BY_KEY[KEY]
    found = resolver.resolve(await settings.refresh(strict=True), KEY)
    held = {r.key: r.value for r in await store.read_scope(session, reg.DOMAIN, "platform", "")}
    return {"days": resolver.encode(setting, found["effective"]),
            "saved": resolver.encode(setting, held.get(KEY)),
            "default": resolver.encode(setting, found["trail"][0]["value"]),
            "min": MIN_DAYS, "max": MAX_DAYS}


async def save(session, days: Optional[int], *, actor: Optional[str], record) -> None:
    """Set the platform's window from the route's words (``days``; 0 for good; None: the
    default), through the settings store as an old endpoint saves (``settings.legacy.save``).
    When it changed, ``record(session, before)``, with what it was in those words, runs in the same
    transaction. Commits."""
    from backend.app.services.settings import legacy, registry, resolver

    setting = registry().BY_KEY[KEY]

    async def recorded(s, change_set) -> None:
        await record(s, resolver.encode(setting, change_set.applied[0].before_value))

    await legacy.save(session, "platform", "", {KEY: resolver.decode(setting, days)}, actor=actor,
                      record=recorded)
