"""Versioned-graph settings over HTTP (``services/settings/service.py``): the registry with its
guidance, and the values of the platform, a workspace and a graph, each with where it came from,
saved all or nothing, previewed, and with their history, each change of which can be put back.

* ``GET /settings/versioned-graphs/schema`` — any signed-in person; the recommendations it makes
  from live facts (node memory, the largest graph) only for system administrators.
* ``/admin/versioning/settings`` — the platform's: system administrators.
* ``/{ws_id}/versioning/settings`` and ``/{ws_id}/versioning/graphs/{graph_id}/settings`` — a
  workspace's and a graph's: read with ``workspace:datasource:read``; saved, previewed, their
  history read and put back with ``workspace:admin``, and each value only by the role the registry
  names for it there (403 ``setting_not_permitted``). A fork follows its root (409
  ``follows_root``).

A save is ``{changes: [{key, value?, limits?, expectedVersion}], reason?}``: ``value`` null
inherits from the scope above and ``limits`` (the platform's only) null takes the setting's default
limits; left out, either stays. Its reason is the body's, else the ``X-Activity-Reason`` header's.
Refusals: 422 ``invalid_settings`` (``errors``, each ``{key, code, message}``), 403
``setting_not_permitted`` (``denied``, each naming the ``editor`` who may), 409
``settings_conflict`` (``conflicts``, each with the version expected and the one found).

None of these routes is on the API-key surface (``auth/api_key_surface``): a key is refused.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import Any, List, Literal, Optional, Sequence

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.common import activity_context
from backend.app.db.engine import get_db_session
from backend.app.db.models import WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.settings import service, store, validate
from backend.app.services.settings.resolver import SYSTEM_ADMIN
from backend.app.services.settings.service import PLATFORM_PLACE, Place
from backend.auth_service.interface import User

from .versioning import graph_in_workspace

schema_router = APIRouter()
platform_router = APIRouter()
workspace_router = APIRouter()
graph_router = APIRouter()

_READ = "workspace:datasource:read"
_ADMIN = "workspace:admin"


class SettingChange(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str = Field(..., min_length=1, max_length=200)
    value: Any = Field(None, description="The value chosen here; null inherits from the scope "
                                         "above. Left out, it stays as it is.")
    limits: Any = Field(None, description="The platform's only: what workspace administrators may "
                                          "choose ({allowed, range, lock}); null takes the "
                                          "setting's default limits. Left out, they stay.")
    expected_version: int = Field(..., alias="expectedVersion", ge=0,
                                  description="The value's version as read (0: none saved yet)")


class SettingsSave(BaseModel):
    changes: List[SettingChange] = Field(..., min_length=1, max_length=100)
    reason: Optional[str] = Field(None, max_length=500,
                                  description="Why; else the X-Activity-Reason header's")


class PreviewChange(SettingChange):
    expected_version: Optional[int] = Field(None, alias="expectedVersion", ge=0)


class SettingsPreview(BaseModel):
    changes: List[PreviewChange] = Field(..., min_length=1, max_length=100)


class RevertRequest(BaseModel):
    reason: Optional[str] = Field(None, max_length=500,
                                  description="Why; else the X-Activity-Reason header's")


def _changes(place: Place, items: Sequence[SettingChange]) -> List[store.Change]:
    """The changes as the store takes them: a field left out stays as it is."""
    return [store.Change(c.key, place.scope, place.scope_id, c.expected_version or 0,
                         value=c.value if "value" in c.model_fields_set else store.KEEP,
                         limits=c.limits if "limits" in c.model_fields_set else store.KEEP)
            for c in items]


def _reason(given: Optional[str]) -> Optional[str]:
    return activity_context.clean_reason(given) or activity_context.current().stated_reason


@contextmanager
def _answers():
    """The settings' refusals as HTTP answers."""
    try:
        yield
    except validate.SettingNotPermitted as exc:
        raise HTTPException(status_code=403, detail={
            "type": exc.code, "message": str(exc), "denied": exc.denied}) from exc
    except service.InvalidSettings as exc:
        raise HTTPException(status_code=422, detail={
            "type": exc.code, "message": str(exc), "errors": exc.errors}) from exc
    except store.SettingsConflict as exc:
        raise HTTPException(status_code=409, detail={
            "type": exc.code, "message": "Changed since it was read: reload, and apply the "
                                         "changes again", "conflicts": exc.conflicts}) from exc
    except service.FollowsRoot as exc:
        raise HTTPException(status_code=409, detail={
            "type": exc.code, "message": str(exc), "rootGraphId": exc.root.graph_id,
            "rootDataSourceId": exc.root.data_source_id,
            "workspaceId": exc.root.workspace_id}) from exc
    except service.NotRevertible as exc:
        raise HTTPException(status_code=409, detail={"type": exc.code,
                                                     "message": str(exc)}) from exc
    except LookupError:
        raise HTTPException(status_code=404, detail="change set not found") from None


# ── The registry ──────────────────────────────────────────────────────────────────────────────────
@schema_router.get("/schema",
                   summary="Every versioned-graph setting: what it is, what it changes, its scopes")
async def get_settings_schema(
    request: Request,
    _user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    """The registry (``settings_types.schema``): categories, settings and their guidance, the
    glossary, why a value in force can differ from the one chosen, what the deployment sets. Its
    examples and posture sentences are rendered with the platform's values in force; its
    recommendations from live facts (``recommended.forThisPlatform``) and the values the
    deployment sets (each deployment fact's and each cap's ``value``, as config reads them when
    asked) only for system administrators, since node memory and sizing are operator data.
    ``If-None-Match`` with its ``ETag`` answers 304 while it is unchanged. The tag is this
    answer's own hash, so a value read differently since, or another role's answer, never
    matches it, and the browser revalidates on every use (``no-cache``)."""
    body = await service.schema(session, operator=service.editor_of(claims) == SYSTEM_ADMIN)
    content = json.dumps(body, sort_keys=True, default=str)
    tag = 'W/"' + hashlib.sha256(content.encode()).hexdigest()[:32] + '"'
    headers = {"ETag": tag, "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type="application/json", headers=headers)


# ── The platform's ────────────────────────────────────────────────────────────────────────────────
@platform_router.get("", summary="The platform's versioned-graph settings, and where each "
                                 "came from")
async def get_platform_settings(
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """``{scope, editor, values, version}``: every setting as the resolver answers it — the value in
    force, the one chosen, where it came from, the trail, its status and why, and what may be
    chosen — with the limits saved for workspaces (``limits``; null: the default limits)."""
    return await service.values(session, PLATFORM_PLACE, SYSTEM_ADMIN)


@platform_router.patch("", summary="Change the platform's versioned-graph settings")
async def patch_platform_settings(
    body: SettingsSave,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """All or nothing; recorded once, with each value before and after. Answers the values as GET
    does, and ``changeSetId`` (null: nothing changed)."""
    with _answers():
        return await service.save(session, PLATFORM_PLACE, _changes(PLATFORM_PLACE, body.changes),
                                  editor=SYSTEM_ADMIN, actor=user.id, reason=_reason(body.reason))


@platform_router.post("/preview", summary="What changing the platform's settings would do")
async def preview_platform_settings(
    body: SettingsPreview,
    mode: Literal["quick", "full"] = Query("quick"),
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Saves nothing. ``quick``: each changed setting, and each other whose answer would change, as
    it would be. ``full`` adds ``impact``: graphs that would behave differently, readers moving to
    or from the database, memory a copy needs, unloads and loads, database reads, drafts removed,
    values outside new limits, and warnings to acknowledge."""
    with _answers():
        return await service.preview(session, PLATFORM_PLACE,
                                     _changes(PLATFORM_PLACE, body.changes),
                                     editor=SYSTEM_ADMIN, full=mode == "full")


@platform_router.get("/history", summary="Every change to versioned-graph settings")
async def platform_settings_history(
    key: Optional[str] = Query(None, max_length=200),
    actor: Optional[str] = Query(None, max_length=200),
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    scope: Optional[Literal["platform", "workspace", "graph"]] = None,
    cursor: Optional[int] = Query(None, ge=1, description="The previous page's nextCursor"),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Newest first, at every scope (``scope`` narrows them). Each entry: who, when, why, how
    (``source``: api, legacy_api, migration or revert), the value and limits before and after,
    and its ``changeSetId``."""
    return await service.history(session, PLATFORM_PLACE, key=key, actor=actor, since=since,
                                 until=until, scope=scope, before_id=cursor, limit=limit)


@platform_router.post("/history/{change_set_id}/revert",
                      summary="Put back what a change to versioned-graph settings changed")
async def revert_platform_settings(
    change_set_id: uuid.UUID,
    body: Optional[RevertRequest] = None,
    user: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """Checked as a save is, all or nothing: 409 ``settings_conflict`` for a value changed since.
    Answers the values of the place it changed, and ``changeSetId``."""
    with _answers():
        return await service.revert(session, PLATFORM_PLACE, change_set_id, editor=SYSTEM_ADMIN,
                                    actor=user.id, reason=_reason(body.reason if body else None))


# ── A workspace's ─────────────────────────────────────────────────────────────────────────────────
async def _workspace(session: AsyncSession, ws_id: str) -> Place:
    ws = await session.get(WorkspaceORM, ws_id)
    if ws is None or ws.deleted_at is not None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return service.workspace_place(ws_id)


@workspace_router.get("", summary="A workspace's versioned-graph settings, and where each "
                                  "came from")
async def get_workspace_settings(
    ws_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """``{scope, workspaceId, editor, values, version}``; ``editor`` is the caller's role here
    (null: they read only), and each value says whether they may change it."""
    return await service.values(session, await _workspace(session, ws_id),
                                service.editor_of(claims, ws_id))


@workspace_router.patch("", summary="Change a workspace's versioned-graph settings")
async def patch_workspace_settings(
    ws_id: str,
    body: SettingsSave,
    user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the platform's PATCH, within the platform's limits for a workspace administrator."""
    place = await _workspace(session, ws_id)
    with _answers():
        return await service.save(session, place, _changes(place, body.changes),
                                  editor=service.editor_of(claims, ws_id), actor=user.id,
                                  reason=_reason(body.reason))


@workspace_router.post("/preview", summary="What changing a workspace's settings would do")
async def preview_workspace_settings(
    ws_id: str,
    body: SettingsPreview,
    mode: Literal["quick", "full"] = Query("quick"),
    _user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the platform's preview, for this workspace's graphs."""
    place = await _workspace(session, ws_id)
    with _answers():
        return await service.preview(session, place, _changes(place, body.changes),
                                     editor=service.editor_of(claims, ws_id), full=mode == "full")


@workspace_router.get("/history",
                      summary="Changes to a workspace's versioned-graph settings and its graphs'")
async def workspace_settings_history(
    ws_id: str,
    key: Optional[str] = Query(None, max_length=200),
    actor: Optional[str] = Query(None, max_length=200),
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    cursor: Optional[int] = Query(None, ge=1, description="The previous page's nextCursor"),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the platform's history, for the workspace's own values and its graphs'."""
    return await service.history(session, await _workspace(session, ws_id), key=key, actor=actor,
                                 since=since, until=until, before_id=cursor, limit=limit)


@workspace_router.post("/history/{change_set_id}/revert",
                       summary="Put back a change to a workspace's or one of its graphs' settings")
async def revert_workspace_settings(
    ws_id: str,
    change_set_id: uuid.UUID,
    body: Optional[RevertRequest] = None,
    user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the platform's revert, for a change this workspace's history lists (else 404)."""
    place = await _workspace(session, ws_id)
    with _answers():
        return await service.revert(session, place, change_set_id,
                                    editor=service.editor_of(claims, ws_id), actor=user.id,
                                    reason=_reason(body.reason if body else None))


@workspace_router.get("/graphs", summary="A workspace's versioned graphs and their settings")
async def workspace_settings_graphs(
    ws_id: str,
    cursor: Optional[str] = Query(None, max_length=200,
                                  description="The previous page's nextCursor"),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """A page of the workspace's graphs by graph id, each with the settings it chose itself
    (``ownSettings``), the graph it follows when it is a fork (``follows``), and its read mode and
    residency class in force."""
    await _workspace(session, ws_id)
    return await service.workspace_graphs(session, ws_id, cursor=cursor, limit=limit)


# ── A graph's ─────────────────────────────────────────────────────────────────────────────────────
@graph_router.get("", summary="A versioned graph's settings, and where each came from")
async def get_graph_settings(
    ws_id: str,
    _user: User = Depends(requires(_READ, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """``{scope, workspaceId, graphId, dataSourceId, editor, values, version}``: the graph's values
    resolve graph → workspace → platform. A fork has none: 409 ``follows_root``, naming its root."""
    with _answers():
        place = await service.graph_place(meta)
    return await service.values(session, place, service.editor_of(claims, ws_id))


@graph_router.patch("", summary="Change a versioned graph's settings")
async def patch_graph_settings(
    ws_id: str,
    body: SettingsSave,
    user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the workspace's PATCH, for this graph."""
    with _answers():
        place = await service.graph_place(meta)
        return await service.save(session, place, _changes(place, body.changes),
                                  editor=service.editor_of(claims, ws_id), actor=user.id,
                                  reason=_reason(body.reason))


@graph_router.post("/preview", summary="What changing a versioned graph's settings would do")
async def preview_graph_settings(
    ws_id: str,
    body: SettingsPreview,
    mode: Literal["quick", "full"] = Query("quick"),
    _user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the workspace's preview, for this graph."""
    with _answers():
        place = await service.graph_place(meta)
        return await service.preview(session, place, _changes(place, body.changes),
                                     editor=service.editor_of(claims, ws_id), full=mode == "full")


@graph_router.get("/history", summary="Changes to a versioned graph's settings")
async def graph_settings_history(
    ws_id: str,
    key: Optional[str] = Query(None, max_length=200),
    actor: Optional[str] = Query(None, max_length=200),
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    cursor: Optional[int] = Query(None, ge=1, description="The previous page's nextCursor"),
    limit: int = Query(50, ge=1, le=200),
    _user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the workspace's history, for this graph's own values."""
    with _answers():
        place = await service.graph_place(meta)
    return await service.history(session, place, key=key, actor=actor, since=since, until=until,
                                 before_id=cursor, limit=limit)


@graph_router.post("/history/{change_set_id}/revert",
                   summary="Put back a change to a versioned graph's settings")
async def revert_graph_settings(
    ws_id: str,
    change_set_id: uuid.UUID,
    body: Optional[RevertRequest] = None,
    user: User = Depends(requires(_ADMIN, workspace="ws_id")),
    meta: dict = Depends(graph_in_workspace),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> dict:
    """As the workspace's revert, for a change this graph's history lists (else 404)."""
    with _answers():
        place = await service.graph_place(meta)
        return await service.revert(session, place, change_set_id,
                                    editor=service.editor_of(claims, ws_id), actor=user.id,
                                    reason=_reason(body.reason if body else None))
