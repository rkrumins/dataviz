"""The Playground: find it, join it, leave it — and, for a platform administrator, set it up.

``GET /playground`` tells anyone signed in whether there is a Playground they may join and
where they stand in it (joined, graphs made against the quota). ``POST /playground/join``
binds them as a **Playground member** at once, while ``playgroundEnabled`` is on;
``POST /playground/leave`` takes that binding away (their work stays). ``PUT /playground``
creates or configures the one Playground (``system:admin``). What members may do inside it
is decided by ``backend.app.services.playground_policy``.

``GET /playground/samples`` lists the graphs a member may start from a sample, and how many more
graphs they may start; ``POST /playground/samples/{sample_id}`` makes one — a blank graph loaded
with the sample as its first version, and a view on it (``backend.app.services.playground_samples``).
"""
from __future__ import annotations

import json
import logging
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.versioning import (
    CreateBlankGraphRequest, create_blank_graph, get_versioning_service, project_now,
)
from backend.app.api.v1.endpoints.views import _compute_ontology_digest, authorize_view_create
from backend.app.api.v1.feature_gate import ensure_view_mode_allowed, require_feature
from backend.app.api.v1.versioning_gate import require_versioning_enabled
from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db.engine import get_db_session
from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceORM
from backend.app.db.repositories import binding_repo, user_repo, view_activity_repo, view_repo
from backend.app.services import playground_policy, playground_samples, workspace_access
from backend.app.services.feature_flags import feature_flags
from backend.app.services.managed_sources import drop_managed_data_source
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.playground_policy import (
    DEFAULT_GRAPH_QUOTA, PLAYGROUND_KIND, PLAYGROUND_ROLE, PlaygroundSettings, get_playground,
    graphs_made_by, settings_of,
)
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.app.services.versioning.service import GraphVersioningService
from backend.auth_service.interface import User
from backend.common.models.management import ViewCreateRequest

logger = logging.getLogger(__name__)

router = APIRouter()

_FLAG = "playgroundEnabled"


class PlaygroundInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    enabled: bool
    exists: bool
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    name: Optional[str] = None
    description: Optional[str] = None
    joined: bool = False
    graph_quota: int = Field(DEFAULT_GRAPH_QUOTA, alias="graphQuota")
    graphs_used: int = Field(0, alias="graphsUsed")
    #: Set up and configure it — a platform administrator.
    can_set_up: bool = Field(False, alias="canSetUp")
    #: Where its blank graphs go — for its members (the wizard starts there) and its administrator.
    sandbox_provider_id: Optional[str] = Field(None, alias="sandboxProviderId")
    #: Its starter data models, for the person who can change them.
    starter_ontology_ids: Optional[List[str]] = Field(None, alias="starterOntologyIds")


class PlaygroundSetup(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field("Playground", min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=2000)
    sandbox_provider_id: str = Field(alias="sandboxProviderId")
    starter_ontology_ids: List[str] = Field(default_factory=list, alias="starterOntologyIds")
    graph_quota: int = Field(DEFAULT_GRAPH_QUOTA, ge=1, le=100, alias="graphQuota")


async def _info(session: AsyncSession, user: User, claims: PermissionClaims) -> PlaygroundInfo:
    enabled = await feature_flags.is_enabled_self_session(_FLAG, default=fail_safe_default(_FLAG))
    admin = has_permission(claims, "system:admin")
    ws = await get_playground(session)
    if ws is None:
        return PlaygroundInfo(enabled=enabled, exists=False, can_set_up=admin)
    settings = settings_of(ws)
    joined = bool(claims.ws_perms.get(ws.id))
    if not enabled and not joined and not admin:
        # Off, and they're not in it: nothing to offer, nothing to name.
        return PlaygroundInfo(enabled=False, exists=True)
    return PlaygroundInfo(
        enabled=enabled, exists=True, workspace_id=ws.id, name=ws.name, description=ws.description,
        joined=joined, graph_quota=settings.graph_quota,
        graphs_used=await graphs_made_by(session, ws.id, user.id) if joined else 0,
        can_set_up=admin,
        sandbox_provider_id=settings.sandbox_provider_id if admin or joined else None,
        starter_ontology_ids=settings.starter_ontology_ids if admin else None,
    )


@router.get("", response_model=PlaygroundInfo, response_model_by_alias=True)
async def get_playground_info(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Whether there is a Playground this person may join, and where they stand in it."""
    return await _info(session, user, claims)


@router.post("/join", response_model=PlaygroundInfo, response_model_by_alias=True,
             dependencies=[Depends(require_feature(_FLAG))])
async def join_playground(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Join the Playground as a Playground member, at once. Joining again changes nothing."""
    ws = await get_playground(session)
    if ws is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no Playground yet.")
    binding, outcome = await workspace_access.grant_role(
        session, subject_type="user", subject_id=user.id, role=PLAYGROUND_ROLE, ws_id=ws.id,
        granted_by=user.id,
    )
    if outcome != "existing":
        # Their claims change: the next request reads them afresh.
        revoked = await revoke_subject_sessions("user", user.id, session=session, reason="workspace_binding_added")
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.workspace.member_joined",
            payload={"workspace_id": ws.id, "binding_id": binding.id, "user_id": user.id,
                     "actor_id": user.id, "role": PLAYGROUND_ROLE, "sessions_revoked": revoked},
        )
    return PlaygroundInfo(
        enabled=True, exists=True, workspace_id=ws.id, name=ws.name, description=ws.description, joined=True,
        graph_quota=settings_of(ws).graph_quota, graphs_used=await graphs_made_by(session, ws.id, user.id),
        can_set_up=has_permission(claims, "system:admin"),
        sandbox_provider_id=settings_of(ws).sandbox_provider_id,
    )


@router.post("/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_playground(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Leave the Playground. What they made stays in it."""
    ws = await get_playground(session)
    if ws is None:
        return None
    binding = await binding_repo.find_binding(
        session, subject_type="user", subject_id=user.id, role_name=PLAYGROUND_ROLE,
        scope_type="workspace", scope_id=ws.id,
    )
    if binding is not None:
        await binding_repo.delete_binding(session, binding.id)
        await revoke_subject_sessions("user", user.id, session=session, reason="workspace_binding_removed")
    return None


@router.put("", response_model=PlaygroundInfo, response_model_by_alias=True)
async def set_up_playground(
    body: PlaygroundSetup,
    user: User = Depends(requires("system:admin")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Create the Playground, or change its name, sandbox provider, starter data models and quota.
    Open to everyone to join, publishing only on request — and nothing of production attachable."""
    provider = await session.get(ProviderORM, body.sandbox_provider_id)
    if provider is None or (provider.provider_type or "").lower() != "falkordb":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The sandbox provider must be a FalkorDB provider — blank graphs are made only there.",
        )
    if body.starter_ontology_ids:
        found = set((await session.execute(
            select(OntologyORM.id).where(OntologyORM.id.in_(body.starter_ontology_ids),
                                         OntologyORM.is_published.is_(True))
        )).scalars().all())
        missing = [o for o in body.starter_ontology_ids if o not in found]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Starter data models must be published ones: {', '.join(missing)}",
            )
    settings = PlaygroundSettings(
        sandbox_provider_id=body.sandbox_provider_id,
        starter_ontology_ids=list(dict.fromkeys(body.starter_ontology_ids)),
        graph_quota=body.graph_quota,
    )
    ws = await get_playground(session)
    if ws is None:
        ws = WorkspaceORM(
            name=body.name, description=body.description, kind=PLAYGROUND_KIND, created_by=user.id,
            request_policy="open", publish_policy="request", directory_listed=True, access_mode="app",
        )
        session.add(ws)
    else:
        ws.name = body.name
        ws.description = body.description
    ws.playground_settings = settings.to_json()
    await session.flush()
    _admit(provider, ws.id)
    return await _info(session, user, claims)


def _admit(provider: ProviderORM, ws_id: str) -> None:
    """Let the Playground onto its sandbox provider: a provider limited to named workspaces
    gains it, so its members can see the provider and start blank graphs there."""
    permitted = json.loads(provider.permitted_workspaces) if provider.permitted_workspaces else ["*"]
    if "*" not in permitted and ws_id not in permitted:
        provider.permitted_workspaces = json.dumps([*permitted, ws_id])


# ── Samples ─────────────────────────────────────────────────────────────

#: A sample is a blank graph: refused while the Playground, blank models or version control is off.
_SAMPLE_GATES = [Depends(require_feature(_FLAG)), Depends(require_feature("blankModelsEnabled")),
                 Depends(require_versioning_enabled)]


class SampleSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    title: str
    description: str
    #: A lucide icon name, and a colour name for its tile.
    icon: str
    color: str
    #: The layout its view opens in.
    view_type: str = Field(alias="viewType")
    node_count: int = Field(alias="nodeCount")
    edge_count: int = Field(alias="edgeCount")
    entity_types: List[str] = Field(alias="entityTypes")


class SampleCatalogue(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    samples: List[SampleSummary]
    #: How many more graphs this person may start in the Playground — a sample is one.
    quota_left: int = Field(alias="quotaLeft")


class StartedSample(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data_source_id: str = Field(alias="dataSourceId")
    view_id: str = Field(alias="viewId")


async def _members_playground(session: AsyncSession, claims: PermissionClaims) -> WorkspaceORM:
    """The Playground, for someone who may build graphs in it."""
    ws = await get_playground(session)
    if ws is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no Playground yet.")
    if not has_permission(claims, "workspace:datasource:manage", workspace_id=ws.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "type": "playground_not_member",
            "message": "Join the Playground to start a graph from a sample.",
        })
    return ws


@router.get("/samples", response_model=SampleCatalogue, response_model_by_alias=True,
            dependencies=_SAMPLE_GATES)
async def list_samples(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The samples a member may start a graph from, and how many more graphs they may start."""
    ws = await _members_playground(session, claims)
    left = settings_of(ws).graph_quota - await graphs_made_by(session, ws.id, user.id)
    return SampleCatalogue(quota_left=max(0, left), samples=[
        SampleSummary(id=s.id, title=s.title, description=s.description, icon=s.icon, color=s.color,
                      view_type=s.view_type, node_count=len(s.nodes), edge_count=len(s.edges),
                      entity_types=[t.name for t in s.entity_types.values()])
        for s in playground_samples.SAMPLES
    ])


@router.post("/samples/{sample_id}", response_model=StartedSample, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED, dependencies=_SAMPLE_GATES)
async def start_sample(
    sample_id: str,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Start a graph from a sample: a blank graph on the Playground's sandbox provider — one of
    the person's quota — whose first version is the sample, loaded as a day-0 import, and a view
    on it, shared with everyone in the Playground. They change it as they would any blank graph.

    The sample is the platform's, not the person's, so it lands on main as the graph's first
    version, as its genesis did; what they change after goes through drafts like any edit.

    What would refuse it is asked first, so a refusal leaves nothing behind; a sample that can't
    be loaded takes its graph and data source with it."""
    sample = playground_samples.get(sample_id)
    if sample is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no such sample.")
    ws = await _members_playground(session, claims)
    # Plain values: making the data model may roll the session back, which expires ``ws``.
    ws_id, provider_id = ws.id, settings_of(ws).sandbox_provider_id
    await playground_policy.assert_blank_graph(session, ws_id, provider_id, user.id)
    await authorize_view_create(claims, session, workspace_id=ws_id, data_source_id=None,
                                visibility="workspace")
    await ensure_view_mode_allowed(sample.view_type, session)

    made = await create_blank_graph(ws_id, CreateBlankGraphRequest(
        name=sample.title, description=sample.description, provider_id=provider_id,
        ontology_id=await playground_samples.ensure_ontology(session, sample)), user, svc, session)
    ds_id, graph_id = made["data_source_id"], made["graph_id"]
    try:
        await svc.bulk_ingest(graph_id=graph_id, rows=playground_samples.rows(sample), actor=user.id,
                              message=f"Started from the {sample.title} sample", standard_ids=True)
        view = await view_repo.create_view(session, ViewCreateRequest(
            name=sample.view_name, description=sample.description, workspace_id=ws_id,
            data_source_id=ds_id, view_type=sample.view_type, config=playground_samples.view_config(sample),
            visibility="workspace", tags=["sample"],
        ), ontology_digest=await _compute_ontology_digest(session, ws_id, ds_id), user_id=user.id)
        await view_activity_repo.record_view_activity(
            session, view_id=view.id, workspace_id=ws_id, action="created", actor=user.id,
            summary=f'Created "{view.name}" from the {sample.title} sample',
        )
    except Exception:
        logger.exception("sample %s could not be loaded into graph %s; removing it", sample.id, graph_id)
        await session.rollback()
        await _discard(session, ws_id, ds_id, graph_id, user.id)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail={
            "type": "sample_load_failed",
            "message": "The sample couldn't be loaded, so nothing was kept. Try again in a moment."})
    background.add_task(project_now, graph_id)
    return StartedSample(data_source_id=ds_id, view_id=view.id)


async def _discard(session: AsyncSession, ws_id: str, ds_id: str, graph_id: str, actor: str) -> None:
    """Take away a sample's graph that could not be loaded: its version history is queued for
    purge, as a permanent delete queues it, and its data source goes. Never raises — what it
    could not take away is logged."""
    from backend.app.services.versioning import purge_worker

    try:
        await purge_worker.create_purge_job(graph_id=graph_id, workspace_id=ws_id, actor=actor,
                                            data_source_id=ds_id)
    except Exception:
        logger.exception("could not queue the purge of graph %s — left in the version store", graph_id)
    await drop_managed_data_source(session, ds_id)
