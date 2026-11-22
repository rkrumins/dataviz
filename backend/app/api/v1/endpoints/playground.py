"""The Playground: find it, join it, leave it — and, for a platform administrator, set it up.

``GET /playground`` tells anyone signed in whether there is a Playground they may join and
where they stand in it (joined, graphs made against the quota). ``POST /playground/join``
binds them as a **Playground member** at once, while ``playgroundEnabled`` is on;
``POST /playground/leave`` takes that binding away (their work stays). ``PUT /playground``
creates or configures the one Playground (``system:admin``). What members may do inside it
is decided by ``backend.app.services.playground_policy``.

``GET /playground/samples`` lists the graphs a member may start from a sample, and how many more
graphs they may start; ``POST /playground/samples/{sample_id}`` makes one — a blank graph loaded
with the sample as its first version, its views, library, details and an example change waiting
for review (``backend.app.services.playground_samples``). ``POST /playground/graphs`` makes one
for the person's own data, with no rows yet: on a semantic layer on offer, or on one of their own
made from their file's types (``backend.app.services.playground_layers``); the file then loads
through the standard import. Both are starter graphs, made the same way
(``backend.app.services.playground_starter``).

``GET /playground/models`` lists the semantic layers a member may build on, and
``GET /playground/models/{id}/template`` gives one's standard import template;
``POST /playground/models/match`` scores them against a file's types. ``POST /playground/layers``
makes a layer of the member's own, ``/layers/{id}/share`` shares it with the Playground and
``/layers/{id}/types`` adds a file's types to it (``backend.app.services.playground_layers``).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.ontologies import (
    _invalidate_ontology_caches, get_ontology_impact, merged_variants_of, normalise_layer_body,
    score_ontologies, with_access,
)
from backend.app.api.v1.endpoints.versioning import (
    CreateBlankGraphRequest, _live_containment_types, _node_identity_for_meta, _rules_for_meta,
    create_blank_graph, get_import_export_service, get_versioning_service, import_contract_of,
    project_now,
)
from backend.app.api.v1.endpoints.views import _compute_ontology_digest, authorize_view_create
from backend.app.api.v1.feature_gate import ensure_view_mode_allowed, require_feature
from backend.app.api.v1.versioning_gate import require_versioning_enabled
from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.config.feature_wiring import fail_safe_default
from backend.app.db.engine import get_db_session
from backend.app.db.models import OntologyORM, ProviderORM, ViewORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.db.repositories import (binding_repo, ontology_definition_repo, user_repo,
                                         view_activity_repo, view_repo, view_version_repo)
from backend.app.services import (playground_layers, playground_policy, playground_samples,
                                  playground_starter, view_library, workspace_access)
from backend.app.services.feature_flags import feature_flags
from backend.app.services.playground_starter import EntityType, Example, RelationshipType, Starter
from backend.app.services.versioning.import_export.resolve import pointer_id, pointer_seed
from backend.common.models.view_library import DisplayRule, SavedQueryInput
from backend.app.services.managed_sources import drop_managed_data_source
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.services.playground_policy import (
    DEFAULT_GRAPH_QUOTA, DEFAULT_LAYER_QUOTA, DEFAULT_MAX_IMPORT_ROWS, PLAYGROUND_KIND, PLAYGROUND_ROLE,
    PlaygroundSettings,
    get_playground, graphs_made_by, settings_of,
)
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.app.services.versioning.service import GraphVersioningService
from backend.auth_service.interface import User
from backend.common.models.graph import GraphSchemaStats
from backend.common.models.management import (
    OntologyDefinitionResponse, OntologySuggestResponse, OntologyUpdateRequest, ViewCreateRequest,
)

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
    #: Semantic layers of their own a member may keep, and how many the reader has.
    layer_quota: int = Field(DEFAULT_LAYER_QUOTA, alias="layerQuota")
    layers_used: int = Field(0, alias="layersUsed")
    #: The most rows one import into a graph here may hold.
    max_import_rows: int = Field(DEFAULT_MAX_IMPORT_ROWS, alias="maxImportRows")
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
    layer_quota: int = Field(DEFAULT_LAYER_QUOTA, ge=1, le=200, alias="layerQuota")
    max_import_rows: int = Field(DEFAULT_MAX_IMPORT_ROWS, ge=1, alias="maxImportRows")


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
        layer_quota=settings.layer_quota,
        layers_used=await playground_layers.layers_made_by(session, ws.id, user.id) if joined else 0,
        max_import_rows=settings.max_import_rows,
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
        layer_quota=settings_of(ws).layer_quota,
        layers_used=await playground_layers.layers_made_by(session, ws.id, user.id),
        max_import_rows=settings_of(ws).max_import_rows,
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
    """Create the Playground, or change its name, sandbox provider, starter data models, quotas and
    the most rows one import there may hold.
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
        layer_quota=body.layer_quota,
        max_import_rows=body.max_import_rows,
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


class Started(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data_source_id: str = Field(alias="dataSourceId")
    #: The Context View: the one to open.
    view_id: str = Field(alias="viewId")
    #: Every view it was made with, by kind: ``context``, ``graph`` (and a sample's ``hierarchy``).
    view_ids: Dict[str, str] = Field(alias="viewIds")


class StartedSample(Started):
    #: The example change waiting for review: a private draft on the Graph view, and its review.
    draft_id: Optional[str] = Field(None, alias="draftId")
    review_id: Optional[str] = Field(None, alias="reviewId")


async def _members_playground(session: AsyncSession, claims: PermissionClaims) -> WorkspaceORM:
    """The Playground, for someone who may build graphs in it."""
    ws = await get_playground(session)
    if ws is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no Playground yet.")
    if not has_permission(claims, "workspace:datasource:manage", workspace_id=ws.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "type": "playground_not_member",
            "message": "Join the Playground to start a graph there.",
        })
    return ws


async def _may_start(session: AsyncSession, claims: PermissionClaims, user: User, starter: Starter
                     ) -> Tuple[str, Optional[str]]:
    """What would refuse a starter graph, asked before anything is made: membership, the quota and
    the sandbox provider, making views there, and each layout its views are in. Returns the
    Playground's id and its sandbox provider (plain values: making a data model may roll the
    session back, which expires the row)."""
    ws = await _members_playground(session, claims)
    ws_id, provider_id = ws.id, settings_of(ws).sandbox_provider_id
    await playground_policy.assert_blank_graph(session, ws_id, provider_id, user.id)
    await authorize_view_create(claims, session, workspace_id=ws_id, data_source_id=None,
                                visibility="workspace")
    for _key, view_type, _name, _config in playground_starter.views(starter):
        await ensure_view_mode_allowed(view_type, session)
    return ws_id, provider_id


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
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Start a graph from a sample: a blank graph on the Playground's sandbox provider — one of
    the person's quota — whose first version is the sample, loaded as a day-0 import; a Context
    View (to open first), a Graph view and a Hierarchy view on it, shared with everyone in the
    Playground; saved queries and a display rule on the Context View; the data source described,
    tagged and linked to how the Playground works; and an example change waiting for review — a
    private draft on the Graph view, with a review that asks nobody. They change it as they would
    any blank graph, and publish and merge their own changes (``playground_policy``).

    The sample is the platform's, not the person's, so it lands on main as the graph's first
    version, as its genesis did; what they change after goes through drafts like any edit.

    What would refuse it is asked first, so a refusal leaves nothing behind; a sample that can't
    be made takes its graph, data source, views and draft with it."""
    sample = playground_samples.get(sample_id)
    if sample is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no such sample.")
    starter = playground_samples.starter(sample)
    ws_id, provider_id = await _may_start(session, claims, user, starter)
    await playground_starter.ensure_ontology(session, starter)
    return StartedSample(**await _start(request, background, session, svc, user, ws_id, provider_id,
                                        starter, failure="sample_load_failed", own_ontology=False))


# ── A graph for the person's own data ───────────────────────────────────

#: A data model made from a file holds at most this many thing types, and connection types, each
#: named in at most ``_TYPE_NAME_MAX`` characters; a refusal lists at most ``_ERRORS_SHOWN``.
_INFER_TYPES_MAX = 50
_TYPE_NAME_MAX = 60
_ERRORS_SHOWN = 50

_TypeName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_TYPE_NAME_MAX)]


class InferredConnectionType(BaseModel):
    name: _TypeName
    #: The pairs of thing types its rows join, ``[from, to]``.
    ends: List[Tuple[_TypeName, _TypeName]] = Field(default_factory=list)


class InferredModel(BaseModel):
    """A data model made from a file's types: its thing types, and its connection types with the
    pairs of thing types each joins."""
    model_config = ConfigDict(populate_by_name=True)

    thing_types: List[_TypeName] = Field(alias="thingTypes", min_length=1)
    connection_types: List[InferredConnectionType] = Field(default_factory=list, alias="connectionTypes")


class GraphModel(BaseModel):
    """What a new graph is built on: a semantic layer on offer here (``ontologyId``), or one of the
    person's own made from their file's types (``infer``, an :class:`InferredModel` held to its
    limits by the route) — one or the other."""
    model_config = ConfigDict(populate_by_name=True)

    ontology_id: Optional[str] = Field(None, alias="ontologyId", min_length=1, max_length=200)
    infer: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def _one_of(self) -> "GraphModel":
        if (self.ontology_id is None) == (self.infer is None):
            raise ValueError("Build the graph on an ontologyId or on infer, one of the two.")
        return self


class NewGraph(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=4000)
    model: GraphModel
    #: The entity types its file uses, which are its Context View's layers (on an ``ontologyId``).
    types: Optional[List[str]] = Field(None, max_length=1000)


class StartedGraph(Started):
    graph_id: str = Field(alias="graphId")
    main_branch_id: str = Field(alias="mainBranchId")


def _type_errors(exc: ValidationError) -> List[dict]:
    """Each wrong type, as ``invalid_rows`` names it: its section, its index there, and the field
    that is wrong (``name`` for a thing type; the section itself when the whole list is)."""
    out = []
    for err in exc.errors():
        loc = list(err["loc"]) or ["infer"]
        if len(loc) == 1:
            index, field = None, str(loc[0])
        else:
            index, field = loc[1], str(loc[2]) if len(loc) > 2 else "name"
        out.append({"section": str(loc[0]), "index": index, "field": field, "code": "invalid",
                    "message": err["msg"]})
    return out


def _inferred(raw: Dict[str, Any]) -> dict:
    """The file's types as ``create_owned`` takes them — or the refusal: 413 ``too_large`` past
    ``_INFER_TYPES_MAX`` thing types or connection types (with the ``limit``), 422 ``invalid_rows``
    naming each type that is wrong."""
    for section, what in (("thingTypes", "types of thing"), ("connectionTypes", "types of connection")):
        listed = raw.get(section)
        if isinstance(listed, list) and len(listed) > _INFER_TYPES_MAX:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail={
                "type": "too_large", "section": section, "limit": _INFER_TYPES_MAX,
                "message": f"A data model made from a file holds at most {_INFER_TYPES_MAX} {what}; "
                           f"this one has {len(listed):,}."})
    try:
        return InferredModel.model_validate(raw).model_dump(by_alias=True, mode="json")
    except ValidationError as exc:
        errors = _type_errors(exc)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={
            "type": "invalid_rows", "count": len(errors), "errors": errors[:_ERRORS_SHOWN],
            "message": f"{len(errors):,} problem{'s' if len(errors) != 1 else ''} in the file's types: "
                       "fix them and send it again. Nothing was made."})


def _graph_starter(body: NewGraph, ontology_id: str, entity_types: Dict[str, EntityType],
                   relationship_types: Dict[str, RelationshipType]) -> Starter:
    """A graph for the person's own data, as a starter with no rows: its views over the types of
    its semantic layer ``ontology_id``. The layer exists already, so the fields that describe one
    to make are left empty."""
    return Starter(
        title=body.name, description=body.description, icon="Upload", ontology_id=ontology_id,
        ontology_name="", ontology_description="", entity_types=entity_types,
        relationship_types=relationship_types, fields=(), rows=(), message=f"Created {body.name}",
        view_name=body.name)


@router.post("/graphs", response_model=StartedGraph, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED, dependencies=_SAMPLE_GATES)
async def create_graph(
    body: NewGraph,
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    svc: GraphVersioningService = Depends(get_versioning_service),
    session: AsyncSession = Depends(get_db_session),
):
    """Start a graph for the person's own data: a blank graph of their quota on the Playground's
    sandbox provider, a Context View (to open first) and a Graph view, the data source described —
    and no rows yet. Its file loads through the standard import
    (``/{ws_id}/versioning/graphs/{graph_id}/imports``), which holds each row to its semantic layer.
    A graph with no data is a graph: an import that fails is tried again into it.

    It is built on a semantic layer on offer here (``ontologyId``: 404 ``unknown_ontology``, 422
    ``ontology_not_published``, 403 ``ontology_not_offered``), its Context View's layers the types
    its file uses (``types``), in the layer's order; or on a layer of their own, made and published
    from the file's types (``infer``: 413 ``too_large``, 422 ``invalid_rows``, 409 ``layer_quota``),
    over all of them. What would refuse it is asked first; a graph that can't be made takes its data
    source and views with it, and the layer made for it — never a layer it was built on."""
    infer = _inferred(body.model.infer) if body.model.infer is not None else None
    # No rows, so no hierarchy: its views are a Context View and a Graph view whatever its types,
    # and what would refuse them is asked before its layer is looked up or made.
    ws_id, provider_id = await _may_start(session, claims, user, _graph_starter(body, "", {}, {}))
    if infer is None:
        layer = await playground_layers.assert_offered(session, claims, user.id, body.model.ontology_id)
        ontology_id = layer.id
        types = await playground_layers.starter_types_of(session, ontology_id, body.types or None)
    else:
        layer = await playground_layers.create_owned(
            session, claims=claims, user_id=user.id, playground_id=ws_id, name=f"{body.name} data model",
            description=f"Made for the graph “{body.name}”, from the types in its file.",
            source={"infer": infer}, publish=True)
        ontology_id = layer.id
        try:
            types = await playground_layers.starter_types_of(session, ontology_id)
        except Exception:
            await _drop_ontology(session, ontology_id)
            raise
    made = await _start(request, background, session, svc, user, ws_id, provider_id,
                        _graph_starter(body, ontology_id, *types), failure="graph_create_failed",
                        own_ontology=infer is not None)
    return StartedGraph(**made)


async def _start(request: Request, background: BackgroundTasks, session: AsyncSession,
                 svc: GraphVersioningService, user: User, ws_id: str, provider_id: Optional[str],
                 starter: Starter, *, failure: str, own_ontology: bool) -> dict:
    """Make a starter graph on its data model (already made): the blank graph, its first version (a
    sample's rows; a graph for the person's own data has none, its file loads through the import),
    its views (each at version 1), the Context View's library, the data source's details and the
    example change. Returns what the routes answer. Anything that fails takes all of it with it
    (:func:`_discard`) — with ``own_ontology``, the data model too — and answers 502 ``failure``."""
    try:
        made = await create_blank_graph(ws_id, CreateBlankGraphRequest(
            name=starter.title, description=starter.description, provider_id=provider_id,
            ontology_id=starter.ontology_id), user, svc, session)
    except Exception:
        if own_ontology:
            await _drop_ontology(session, starter.ontology_id)
        raise
    ds_id, graph_id = made["data_source_id"], made["graph_id"]
    try:
        if starter.rows:
            loaded = await svc.bulk_ingest(graph_id=graph_id, rows=list(starter.rows), actor=user.id,
                                           message=starter.message, standard_ids=True)
            if loaded.get("rejected"):
                raise RuntimeError(f"{len(loaded['rejected'])} rows were refused")
        digest = await _compute_ontology_digest(session, ws_id, ds_id)
        view_ids: Dict[str, str] = {}
        for key, view_type, name, config in playground_starter.views(starter):
            view = await view_repo.create_view(session, ViewCreateRequest(
                name=name, description=starter.description, workspace_id=ws_id, data_source_id=ds_id,
                view_type=view_type, config=config, visibility="workspace",
                tags=list(starter.tags) or None,
            ), ontology_digest=digest, user_id=user.id)
            view_ids[key] = view.id
            await view_activity_repo.record_view_activity(
                session, view_id=view.id, workspace_id=ws_id, action="created", actor=user.id,
                summary=f'Created "{view.name}" with {starter.title}',
            )
        context = view_ids["context"]
        for query in starter.queries:
            await view_library.put_query(session, context, f"{context}_{query.slug}", SavedQueryInput(
                name=query.name, description=query.description, predicate=query.predicate), actor=user.id)
        for rule in starter.rules:
            await view_library.put_rule(session, context, None, DisplayRule(**rule))
        for view_id in view_ids.values():
            await view_version_repo.checkpoint(session, await session.get(ViewORM, view_id),
                                               source="create", actor=user.id, message=starter.message)
        if starter.tags or starter.links:
            ds = await session.get(WorkspaceDataSourceORM, ds_id)
            ds.tags = json.dumps(list(starter.tags)) if starter.tags else None
            ds.links = json.dumps([{"label": label, "url": _on_this_site(request, path)}
                                   for label, path in starter.links]) if starter.links else None
            ds.metadata_updated_by = user.id
            ds.metadata_updated_at = datetime.now(timezone.utc).isoformat()
        draft_id = review_id = None
        if starter.example is not None:
            draft_id, review_id = await _example_change(session, svc, user.id, ws_id, ds_id, graph_id,
                                                        view_ids["graph"], starter.example)
        await session.commit()
    except Exception:
        logger.exception("starter graph %s could not be made in graph %s; removing it", starter.title, graph_id)
        await session.rollback()
        await _discard(session, ws_id, ds_id, graph_id, user.id,
                       ontology_id=starter.ontology_id if own_ontology else None)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail={
            "type": failure,
            "message": "The graph couldn't be made, so nothing was kept. Try again in a moment."})
    background.add_task(project_now, graph_id)
    return {"data_source_id": ds_id, "graph_id": graph_id, "main_branch_id": made["main_branch_id"],
            "view_id": view_ids["context"], "view_ids": view_ids, "draft_id": draft_id,
            "review_id": review_id}


async def _example_change(session: AsyncSession, svc: GraphVersioningService, actor: str, ws_id: str,
                          ds_id: str, graph_id: str, view_id: str, example: Example) -> Tuple[str, str]:
    """The example change waiting for review: a private draft opened from ``view_id`` that adds
    one thing, connected from one the graph holds, saved; and a review of it that asks nobody, so
    nobody is told. Returns the draft's and the review's ids."""
    branch_id = await svc.open_draft(graph_id=graph_id, owner=actor, name=example.title,
                                     originating_view_id=view_id, visibility="private")
    await view_repo.ensure_overlay(session, view_id, branch_id)
    meta = {"data_source_id": ds_id, "kind": "blank"}
    rules = await _rules_for_meta(session, ws_id, meta)
    node = {k: v for k, v in example.node.items() if k != "kind"}
    # The thing it connects from has the id the first version's import gave it.
    source = pointer_id(await svc.identity_scope(graph_id), pointer_seed(example.source))
    await svc.stage_changes(graph_id=graph_id, branch_id=branch_id, actor=actor, ontology_rules=rules, ops=[
        {"op": "create", "entity_kind": "node", "payload": node},
        {"op": "create", "entity_kind": "edge", "payload": {
            "edgeType": example.relationship, "sourceEntityId": source, "targetEntityId": node["urn"]}},
    ])
    await svc.checkpoint(graph_id=graph_id, branch_id=branch_id, actor=actor, message=example.title,
                         containment_edge_types=await _live_containment_types(session, ws_id, ds_id),
                         ontology_rules=rules, node_identity=await _node_identity_for_meta(session, meta))
    review_id = await svc.open_draft_mr(graph_id=graph_id, branch_id=branch_id, actor=actor,
                                        title=example.title, description=example.description,
                                        reviewers=[], reviewer_groups=[])
    return branch_id, review_id


def _on_this_site(request: Request, path: str) -> str:
    """``path`` on the site the person is using — the origin their browser sent the request from,
    else this server's: a data source's link is a full web address."""
    origin = request.headers.get("origin") or ""
    parsed = urlparse(origin)
    site = parsed.scheme in ("http", "https") and parsed.netloc and not parsed.path.strip("/")
    return (origin if site else str(request.base_url)).rstrip("/") + path


async def _drop_ontology(session: AsyncSession, ontology_id: str) -> None:
    """Take away a layer of the person's own made for a graph that wasn't made
    (``playground_layers.drop_owned``). Never raises."""
    try:
        await playground_layers.drop_owned(session, ontology_id)
        await session.commit()
    except Exception:
        logger.exception("could not remove data model %s — left unused", ontology_id)


async def _discard(session: AsyncSession, ws_id: str, ds_id: str, graph_id: str, actor: str, *,
                   ontology_id: Optional[str] = None) -> None:
    """Take away a starter graph that could not be made: its version history — its drafts and
    reviews with it — is queued for purge, as a permanent delete queues it, its data source goes,
    and so does ``ontology_id``, a data model made for it alone. Never raises — what it could not
    take away is logged."""
    from backend.app.services.versioning import purge_worker

    try:
        await purge_worker.create_purge_job(graph_id=graph_id, workspace_id=ws_id, actor=actor,
                                            data_source_id=ds_id)
    except Exception:
        logger.exception("could not queue the purge of graph %s — left in the version store", graph_id)
    await drop_managed_data_source(session, ds_id)
    if ontology_id:
        await _drop_ontology(session, ontology_id)


# ── Semantic layers ─────────────────────────────────────────────────────
# What a member may build on, and layers of their own (``playground_layers``). Members only, while
# the Playground is on.

_LAYER_GATES = [Depends(require_feature(_FLAG))]


class PlaygroundModel(BaseModel):
    """A semantic layer a member may build on: its newest version on offer."""
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    description: Optional[str] = None
    version: int
    #: ``approved``, ``starter``, ``sample``, ``yours`` or ``shared``.
    kind: str
    is_published: bool = Field(alias="isPublished")
    #: Shared with the Playground (a layer of one's own that others may build on).
    shared: bool = False
    entity_type_count: int = Field(alias="entityTypeCount")
    relationship_type_count: int = Field(alias="relationshipTypeCount")
    #: How many of the reader's live Playground graphs are built on any version of it.
    used_by: int = Field(alias="usedBy")


class NewLayer(BaseModel):
    """A layer of one's own, from ``from``: ``{blank: true}``, ``{cloneOf: id}``, ``{layer: <a
    Semantic Layers file>}`` or ``{infer: {thingTypes, connectionTypes}}``."""
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(None, max_length=4000)
    source: Dict[str, Any] = Field(alias="from")


class ShareLayer(BaseModel):
    shared: bool


class TypeToAdd(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=playground_layers.NAME_MAX)


class RelationshipToAdd(TypeToAdd):
    #: The type pairs its rows join: ``[from, to]``, each a type's id or name.
    ends: List[Tuple[str, str]] = Field(default_factory=list, max_length=500)


class LayerTypesToAdd(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    entity_types: List[TypeToAdd] = Field(default_factory=list, alias="entityTypes",
                                          max_length=playground_layers.TYPES_MAX)
    relationship_types: List[RelationshipToAdd] = Field(default_factory=list, alias="relationshipTypes",
                                                        max_length=playground_layers.TYPES_MAX)


class LayerTypesAdded(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    #: The layer version now in use: a new one when the layer was published.
    ontology_id: str = Field(alias="ontologyId")
    version: int
    #: How many of the reader's graphs moved to it.
    moved_graphs: int = Field(alias="movedGraphs")
    entity_type_ids: Dict[str, str] = Field(alias="entityTypeIds")
    relationship_type_ids: Dict[str, str] = Field(alias="relationshipTypeIds")


async def _layer_response(session: AsyncSession, claims: PermissionClaims, user: User,
                          ontology_id: str) -> OntologyDefinitionResponse:
    layer = await ontology_definition_repo.get_ontology(session, ontology_id)
    await with_access(session, claims, user.id, [layer])
    return layer


async def _own_layer(session: AsyncSession, claims: PermissionClaims, user: User, ontology_id: str) -> OntologyORM:
    """A layer of the caller's own here — 404 ``unknown_ontology`` for one they can't see, 403
    ``layer_not_yours`` for another's."""
    from backend.app.services.workspace_visibility import ensure_ontology_visible
    row = await session.get(OntologyORM, ontology_id)
    if row is None or row.deleted_at:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={
            "type": "unknown_ontology", "message": "There is no such semantic layer."})
    await ensure_ontology_visible(session, claims, ontology_id, user_id=user.id)
    if not await playground_layers.owns_layer(session, claims, user.id, row):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "type": "layer_not_yours", "message": "Only the person who made this semantic layer can change it."})
    return row


@router.get("/models", response_model=List[PlaygroundModel], response_model_by_alias=True,
            dependencies=_LAYER_GATES)
async def list_models(
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """The semantic layers a member may build a graph on: approved org-wide layers, the starters,
    the samples', their own (drafts too) and those shared with the Playground — the newest version
    of each, by kind and then name."""
    await _members_playground(session, claims)
    return [PlaygroundModel(**m) for m in await playground_layers.models(session, claims, user.id)]


@router.post("/models/match", response_model=OntologySuggestResponse, response_model_by_alias=True,
             dependencies=[*_LAYER_GATES, Depends(require_feature("semanticLayerAutoSuggest"))])
async def match_models(
    stats: GraphSchemaStats = Body(...),
    min_score: float = Query(0.1, ge=0.0, le=1.0, description=(
        "Leave out layers scoring below this overlap; 0 scores every layer on offer.")),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """How well each layer on offer fits a file's types, best first — scored as
    ``POST /admin/ontologies/suggest`` scores every layer, without its draft (``suggested``). Every
    layer on offer that scores is listed, not only the best five."""
    await _members_playground(session, claims)
    offered = [ontology_definition_repo._to_response(row)
               for row in await playground_layers.newest_offered(session, claims, user.id)]
    return OntologySuggestResponse(suggested=None, matchingOntologies=score_ontologies(stats, offered, min_score),
                                   mergedVariants=merged_variants_of(stats))


@router.get("/models/{ontology_id}/template", dependencies=_LAYER_GATES)
async def model_template(
    ontology_id: str,
    format: str = Query("csv"),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
    ie=Depends(get_import_export_service),
):
    """The standard import template for a layer on offer (csv, ndjson or xlsx): what
    ``GET …/graphs/{graph_id}/imports/template`` gives for a graph on it."""
    from fastapi.responses import Response
    from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
    from backend.app.ontology.resolver import resolve_ontology
    from backend.app.services.versioning.import_export.formats import get_adapter
    from backend.app.services.versioning.import_export.stream import MEDIA_TYPES
    try:
        get_adapter(format)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    format = format.lower()
    await _members_playground(session, claims)
    await playground_layers.assert_offered(session, claims, user.id, ontology_id)
    layer = await SQLAlchemyOntologyRepository(session).get_by_id(ontology_id)
    data = await ie.build_template(export_format=format,
                                   ontology=import_contract_of(resolve_ontology(None, layer)))
    return Response(content=data, media_type=MEDIA_TYPES.get(format, "application/octet-stream"),
                    headers={"Content-Disposition": f'attachment; filename="import-template.{format}"'})


@router.post("/layers", response_model=OntologyDefinitionResponse, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED, dependencies=_LAYER_GATES)
async def create_layer(
    body: NewLayer,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """A semantic layer of the member's own: blank, a copy of a layer they can see, a Semantic
    Layers file, or a file's types (published at once). Private to them until they share it; one
    of their ``layerQuota`` (409 ``layer_quota``)."""
    ws = await _members_playground(session, claims)
    row = await playground_layers.create_owned(
        session, claims=claims, user_id=user.id, playground_id=ws.id, name=body.name,
        description=body.description, source=body.source, publish=bool(body.source.get("infer")))
    return await _layer_response(session, claims, user, row.id)


@router.post("/layers/{ontology_id}/share", response_model=OntologyDefinitionResponse,
             response_model_by_alias=True, dependencies=_LAYER_GATES)
async def share_layer(
    ontology_id: str,
    body: ShareLayer,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Share a layer of one's own with the Playground — others build on it, read-only, once it is
    published — or make it private again. Graphs others already built on it keep it."""
    await _members_playground(session, claims)
    row = await _own_layer(session, claims, user, ontology_id)
    await playground_layers.share(session, row, body.shared, user.id)
    await session.commit()
    return await _layer_response(session, claims, user, ontology_id)


@router.post("/layers/{ontology_id}/types", response_model=LayerTypesAdded, response_model_by_alias=True,
             dependencies=_LAYER_GATES)
async def add_layer_types(
    ontology_id: str,
    body: LayerTypesToAdd,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Add a file's types to a layer of one's own: an entity type per name it lacks, and a lineage
    relationship per relationship name it lacks, joining the types named at its ends. A draft
    changes in place; a published layer gets its next version, published, and the member's graphs
    on it move to that version. Names it has already are found, not added. Only the layer's newest
    version takes types: 409 ``not_latest`` names it."""
    ws = await _members_playground(session, claims)
    row = await _own_layer(session, claims, user, ontology_id)
    newest = (await session.execute(
        select(OntologyORM).where(ontology_definition_repo.lineage_of(row), OntologyORM.deleted_at.is_(None))
        .order_by(OntologyORM.version.desc()).limit(1))).scalar_one()
    if newest.id != row.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "type": "not_latest", "latestId": newest.id, "latestVersion": newest.version,
            "message": f"Version {newest.version} of this layer is newer: add the types to it."})
    entities, relationships, entity_ids, relationship_ids, changed = playground_layers.with_types(
        row, [t.name for t in body.entity_types], [(r.name, r.ends) for r in body.relationship_types])
    if not changed:
        return LayerTypesAdded(ontology_id=row.id, version=row.version, moved_graphs=0,
                               entity_type_ids=entity_ids, relationship_type_ids=relationship_ids)
    req = OntologyUpdateRequest(entityTypeDefinitions=entities, relationshipTypeDefinitions=relationships)
    normalise_layer_body(req)
    made = await ontology_definition_repo.update_ontology(session, row.id, req, actor=user.id)
    moved = 0
    if made.id != row.id:                       # it was published: publish the new version, and move
        impact = await get_ontology_impact(made.id, session, claims=None)
        if not impact["allowed"]:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=impact["reason"])
        await ontology_definition_repo.publish_ontology(session, made.id, actor=user.id)
        moved = await playground_layers.move_graphs(session, ws_id=ws.id, user_id=user.id,
                                                    from_id=row.id, to_id=made.id)
        await _invalidate_ontology_caches(session, row.id, background)
    await _invalidate_ontology_caches(session, made.id, background)
    return LayerTypesAdded(ontology_id=made.id, version=made.version, moved_graphs=moved,
                           entity_type_ids=entity_ids, relationship_type_ids=relationship_ids)
