"""The Playground: what the shared sandbox workspace allows, in one place.

The Playground is one workspace (``WorkspaceORM.kind == 'playground'``) anyone who can
sign in may join, while ``playgroundEnabled`` is on, to build their own graphs from
blank and try views out. Its members hold the **Playground member** role, which lets
them manage data sources and views — so the routes that do that ask this module first,
and in the Playground only:

* **No production data.** Nothing can be attached to it — no catalog item, no existing
  graph, no data source moved in. Its graphs are blank graphs, made on the one provider
  the administrator set aside for it (``sandboxProviderId``).
* **Your own work.** A data source or a view there can be changed or deleted only by the
  person who made it (or a workspace admin). Drafts are opened, staged and resolved only on a
  graph you made, and start private. Its maker finishes it without the publish permission:
  publishes its drafts, merges their reviews (:func:`is_playground_maker`).
* **Never everyone.** Nothing in it is published to every signed-in person; sharing is
  with people, inside the Playground.
* **A quota.** Each person may have ``graphQuota`` graphs there at once (default 5), and
  ``layerQuota`` semantic layers of their own (default 20, ``playground_layers``).
  Experiments do not expire; the quota is the only bound. One import into a graph there holds
  at most ``maxImportRows`` rows (default 200,000), in place of the platform's ``IMPORT_MAX_ROWS``.
* **Starter data models.** A blank graph needs a published data model. A new member
  sees none (data models follow the data sources a person's workspaces use), so the
  ones the administrator chose (``starterOntologyIds``) are visible to its members.

A standard workspace is untouched by every check here.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import List, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims, has_permission

#: The switch that opens the Playground.
PLAYGROUND_FLAG = "playgroundEnabled"

PLAYGROUND_KIND = "playground"
PLAYGROUND_ROLE = "workspace_playground_member"
DEFAULT_GRAPH_QUOTA = 5
DEFAULT_LAYER_QUOTA = 20
DEFAULT_MAX_IMPORT_ROWS = 200_000


@dataclass
class PlaygroundSettings:
    sandbox_provider_id: Optional[str] = None
    starter_ontology_ids: List[str] = field(default_factory=list)
    graph_quota: int = DEFAULT_GRAPH_QUOTA
    layer_quota: int = DEFAULT_LAYER_QUOTA
    max_import_rows: int = DEFAULT_MAX_IMPORT_ROWS

    def to_json(self) -> str:
        return json.dumps({
            "sandboxProviderId": self.sandbox_provider_id,
            "starterOntologyIds": self.starter_ontology_ids,
            "graphQuota": self.graph_quota,
            "layerQuota": self.layer_quota,
            "maxImportRows": self.max_import_rows,
        })


def settings_of(ws: WorkspaceORM) -> PlaygroundSettings:
    """The playground's settings; defaults for anything unset or unreadable."""
    try:
        raw = json.loads(ws.playground_settings or "{}")
    except (TypeError, ValueError):
        raw = {}
    quota = raw.get("graphQuota")
    layers = raw.get("layerQuota")
    rows = raw.get("maxImportRows")
    return PlaygroundSettings(
        sandbox_provider_id=raw.get("sandboxProviderId") or None,
        starter_ontology_ids=[str(o) for o in raw.get("starterOntologyIds") or []],
        graph_quota=quota if isinstance(quota, int) and quota > 0 else DEFAULT_GRAPH_QUOTA,
        layer_quota=layers if isinstance(layers, int) and layers > 0 else DEFAULT_LAYER_QUOTA,
        max_import_rows=rows if isinstance(rows, int) and rows > 0 else DEFAULT_MAX_IMPORT_ROWS,
    )


async def get_playground(session: AsyncSession) -> Optional[WorkspaceORM]:
    return (await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.kind == PLAYGROUND_KIND, WorkspaceORM.deleted_at.is_(None))
    )).scalars().first()


async def playground_of(session: AsyncSession, ws_id: Optional[str]) -> Optional[WorkspaceORM]:
    """``ws_id``'s row when it is the playground, else None — the one question every check asks."""
    if not ws_id:
        return None
    ws = await session.get(WorkspaceORM, ws_id)
    return ws if ws is not None and ws.kind == PLAYGROUND_KIND else None


async def import_row_limit(session: AsyncSession, ws_id: Optional[str]) -> Optional[int]:
    """The most rows one import into ``ws_id``'s graph may hold when it is the playground
    (``maxImportRows``); None elsewhere, where the platform's ``IMPORT_MAX_ROWS`` holds."""
    ws = await playground_of(session, ws_id)
    return settings_of(ws).max_import_rows if ws is not None else None


def _refuse(code: int, kind: str, message: str) -> HTTPException:
    return HTTPException(status_code=code, detail={"type": kind, "message": message})


async def assert_can_attach(session: AsyncSession, ws_id: str) -> None:
    """Attaching a catalog item, an existing graph or a moved data source: never the playground."""
    if await playground_of(session, ws_id):
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "playground_no_attach",
            "The Playground only holds graphs built in it from blank — data from elsewhere "
            "can't be attached here.",
        )


def is_owner_or_admin(ws_id: str, created_by: Optional[str], user_id: Optional[str],
                      claims: PermissionClaims) -> bool:
    return (bool(user_id) and created_by == user_id) or has_permission(claims, "workspace:admin", workspace_id=ws_id)


async def assert_owner(session: AsyncSession, ws_id: str, created_by: Optional[str],
                       user_id: Optional[str], claims: PermissionClaims) -> None:
    """Changing or deleting a data source or a view: in the playground, only its maker (or an admin)."""
    if await playground_of(session, ws_id) and not is_owner_or_admin(ws_id, created_by, user_id, claims):
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "playground_not_yours",
            "In the Playground you can change only what you made.",
        )


async def is_playground_maker(session: AsyncSession, ds: Optional[WorkspaceDataSourceORM],
                              user_id: Optional[str], claims: PermissionClaims) -> bool:
    """Whether the caller finishes their own work on ``ds`` without ``workspace:datasource:publish``
    — publishes its drafts, merges their reviews, loads it and publishes an import into it: ``ds``
    is in the Playground and they made it, or they are a Playground or platform admin, and they may
    still build there. A person only, never an API key."""
    if ds is None or claims.key_scope is not None or await playground_of(session, ds.workspace_id) is None:
        return False
    return (has_permission(claims, "workspace:datasource:manage", workspace_id=ds.workspace_id)
            and is_owner_or_admin(ds.workspace_id, ds.created_by, user_id, claims))


async def assert_graph_maker(session: AsyncSession, ws_id: str, data_source_id: Optional[str],
                             user_id: Optional[str], claims: PermissionClaims) -> None:
    """Opening, staging or resolving a draft on a graph: in the playground, only on one the caller
    made (or as an admin). Another member's graph is theirs to read, not to change."""
    if await playground_of(session, ws_id) is None:
        return
    ds = await session.get(WorkspaceDataSourceORM, data_source_id) if data_source_id else None
    await assert_owner(session, ws_id, ds.created_by if ds is not None else None, user_id, claims)


async def assert_visibility(session: AsyncSession, ws_id: Optional[str], visibility: Optional[str]) -> None:
    """Publishing to everyone: never from the playground."""
    if visibility == "enterprise" and await playground_of(session, ws_id):
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "playground_not_public",
            "Nothing in the Playground is published to everyone. Share it with people instead.",
        )


async def graphs_made_by(session: AsyncSession, ws_id: str, user_id: str) -> int:
    """The live data sources ``user_id`` made in the workspace — what the quota counts."""
    return (await session.execute(
        select(func.count(WorkspaceDataSourceORM.id)).where(
            WorkspaceDataSourceORM.workspace_id == ws_id,
            WorkspaceDataSourceORM.created_by == user_id,
            WorkspaceDataSourceORM.deleted_at.is_(None),
        )
    )).scalar_one() or 0


async def assert_blank_graph(session: AsyncSession, ws_id: str, provider_id: Optional[str],
                             user_id: Optional[str]) -> None:
    """A new blank graph in the playground: while it is on, on its sandbox provider, within the
    person's quota. Off, what people made stays, but nothing new starts there."""
    ws = await playground_of(session, ws_id)
    if ws is None:
        return
    from backend.app.config.feature_wiring import fail_safe_default
    from backend.app.services.feature_flags import feature_flags
    if not await feature_flags.is_enabled(PLAYGROUND_FLAG, session, default=fail_safe_default(PLAYGROUND_FLAG)):
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "feature_disabled",
            "The Playground is turned off for this deployment, so no new graph can start in it.",
        )
    settings = settings_of(ws)
    if not settings.sandbox_provider_id or provider_id != settings.sandbox_provider_id:
        raise _refuse(
            status.HTTP_403_FORBIDDEN, "playground_provider",
            "Graphs in the Playground are made on its own sandbox provider.",
        )
    if user_id and await graphs_made_by(session, ws_id, user_id) >= settings.graph_quota:
        raise _refuse(
            status.HTTP_409_CONFLICT, "playground_quota",
            f"You have {settings.graph_quota} graphs in the Playground, its limit. "
            "Delete one to start another.",
        )


async def starter_ontology_ids(session: AsyncSession, claims: PermissionClaims) -> set[str]:
    """The data models a playground member may start from — none for anyone else."""
    ws = await get_playground(session)
    if ws is None or not claims.ws_perms.get(ws.id):
        return set()
    return set(settings_of(ws).starter_ontology_ids)
