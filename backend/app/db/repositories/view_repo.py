"""
Repository for views table.
Views define how to visually render context models (or ad-hoc graphs).
Supports CRUD, filtering, favourites, and enterprise discovery.
"""
import asyncio
import json
import logging
import os
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Dict, List, NamedTuple, Optional, Sequence, Set, Tuple

from sqlalchemy import and_, case, false, literal_column, select, delete, func, or_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from pydantic import BaseModel

from ..models import (
    ProductEventORM,
    ViewORM,
    ViewFavouriteORM,
    ViewVisitORM,
    ViewLayoutOverlayORM,
    WorkspaceORM,
    ContextModelORM,
    WorkspaceDataSourceORM,
    UserORM,
    view_is_live,
)
from backend.common.models.management import (
    ViewHealthInfo,
    ViewPublishRequest,
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewLayoutUpdateRequest,
    ViewResponse,
    ViewListResponse,
    ViewFacetValue,
    ViewFacetCreator,
    ViewFacetContributor,
    ViewFacetDataSource,
    ViewFacetSourceKinds,
    ViewFacetWorkspace,
    ViewFacetsResponse,
    ViewCatalogStats,
)
from backend.app.services.layout_config import (
    derive_entity_scope,
    sanitize_node_ordering,
    strip_node_ordering,
)
from backend.app.services.view_transfer.canonical import (
    config_from_definition, join_definition,
)
from backend.app.services.view_transfer.merge import merge_layout_side_fields
from backend.app.services.versioning.layout_promote import (
    merge_layout_3way,
    merge_scope_3way,
    merge_display_rules_3way,
    merge_default_sort_3way,
)

if TYPE_CHECKING:
    from backend.app.services.view_source_kinds import SourceKindSets

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #

async def _get_workspace_name(
    session: AsyncSession, workspace_id: Optional[str]
) -> Optional[str]:
    if not workspace_id:
        return None
    result = await session.execute(
        select(WorkspaceORM.name).where(WorkspaceORM.id == workspace_id)
    )
    return result.scalar_one_or_none()


def _nameable_template(user_id: Optional[str]):
    """The layout templates a view may name as the one it was built from: not
    deleted, and not someone else's personal one — whose name is theirs."""
    mine = ContextModelORM.created_by == user_id if user_id else false()
    return and_(
        ContextModelORM.deleted_at.is_(None),
        or_(ContextModelORM.visibility != "private", mine),
    )


async def _get_context_model_name(
    session: AsyncSession, context_model_id: Optional[str], user_id: Optional[str] = None,
) -> Optional[str]:
    if not context_model_id:
        return None
    result = await session.execute(
        select(ContextModelORM.name).where(
            ContextModelORM.id == context_model_id, _nameable_template(user_id),
        )
    )
    return result.scalar_one_or_none()


_NO_SOURCE = (None, None, None)


async def _get_data_source_facts(
    session: AsyncSession, data_source_id: Optional[str]
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """A live source's ``(label, classification, trust_status)``; Nones when there is none."""
    if not data_source_id:
        return _NO_SOURCE
    result = await session.execute(
        select(WorkspaceDataSourceORM.label, WorkspaceDataSourceORM.classification,
               WorkspaceDataSourceORM.trust_status)
        .where(WorkspaceDataSourceORM.id == data_source_id)
        .where(WorkspaceDataSourceORM.deleted_at.is_(None))
    )
    row = result.one_or_none()
    return tuple(row) if row else _NO_SOURCE


async def _get_favourite_count(
    session: AsyncSession, view_id: str
) -> int:
    result = await session.execute(
        select(func.count()).where(ViewFavouriteORM.view_id == view_id)
    )
    return result.scalar() or 0


async def _is_favourited(
    session: AsyncSession, view_id: str, user_id: Optional[str]
) -> bool:
    if not user_id:
        return False
    result = await session.execute(
        select(ViewFavouriteORM.id).where(
            ViewFavouriteORM.view_id == view_id,
            ViewFavouriteORM.user_id == user_id,
        )
    )
    return result.scalar_one_or_none() is not None


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

async def resolve_user_ids(
    session: AsyncSession, user_ids: Set[Optional[str]],
) -> Dict[str, tuple[Optional[str], Optional[str]]]:
    """Resolve a set of user ids to ``{id: (display_name, email)}`` in one query.

    The view enrichment paths — single-row (:func:`_to_enriched_response`) and
    batched (:func:`_batch_enrich_rows`) — use its sibling
    :func:`_resolve_user_identities`, which also reads the avatar, so each
    resolves a view's creator, last modifier and data publisher from ONE
    lookup — no N+1, no second query per row. Exported (not underscored) so the
    versioning API boundary can reuse the exact same display-name formula when
    resolving commit/branch/PR actors.

    Ids that are NULL, the legacy ``"anonymous"`` sentinel, or reference a
    user record that no longer exists are simply absent from the result;
    callers treat a miss as "unresolvable" and fall back to the raw id.
    """
    clean = {uid for uid in user_ids if uid and uid != "anonymous"}
    if not clean:
        return {}
    result = await session.execute(
        select(UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email)
        .where(UserORM.id.in_(clean))
    )
    resolved: Dict[str, tuple[Optional[str], Optional[str]]] = {}
    for uid, first, last, email in result.all():
        display = f"{first or ''} {last or ''}".strip() or email
        resolved[uid] = (display, email)
    return resolved


async def _resolve_user_identities(
    session: AsyncSession, user_ids: Set[Optional[str]],
) -> Dict[str, tuple[Optional[str], Optional[str], Optional[str]]]:
    """:func:`resolve_user_ids` plus the user's chosen avatar:
    ``{id: (display_name, email, avatar_id)}``, same naming rule, same misses.

    A sibling rather than a third tuple member there: other domains unpack
    that function's values as pairs.
    """
    clean = {uid for uid in user_ids if uid and uid != "anonymous"}
    if not clean:
        return {}
    result = await session.execute(
        select(
            UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email,
            UserORM.avatar_id,
        )
        .where(UserORM.id.in_(clean))
    )
    return {
        uid: (f"{first or ''} {last or ''}".strip() or email, email, avatar_id)
        for uid, first, last, email, avatar_id in result.all()
    }


# ------------------------------------------------------------------ #
# View health (server-authoritative)                                    #
# ------------------------------------------------------------------ #

_STALE_THRESHOLD_DAYS = 90


class _ScopeFacts(NamedTuple):
    """What the server knows about a view's workspace + data source."""
    ws_exists: bool
    ws_active: bool
    ds_exists: bool
    ds_active: bool


def _health_for(row: ViewORM, facts: _ScopeFacts) -> Dict[str, Optional[str]]:
    """Verdict on one view's scope integrity.

    Mirrors the ``attention_only`` SQL filter in ``_apply_view_filters``
    so the badge and the "needs attention" list can never disagree. The
    browser cannot compute this: its workspace store holds only the
    caller's own memberships, so "not mine" is indistinguishable there
    from "deleted" — which is how every shared view came to be labelled
    "Source deleted".
    """
    if not facts.ws_exists:
        return {"status": "broken", "reason": "Workspace no longer exists"}
    if not facts.ws_active:
        return {"status": "warning", "reason": "Workspace is inactive"}
    if row.data_source_id:
        if not facts.ds_exists:
            return {"status": "broken", "reason": "Data source no longer exists"}
        if not facts.ds_active:
            return {"status": "warning", "reason": "Data source is inactive"}
    # Stale is judged on the last change of either kind, as the "needs attention"
    # filter is (``_last_change_expr``): a view whose data is published every week
    # is not stale because nobody has touched its settings since spring.
    changed = max(row.updated_at or "", row.data_updated_at or "")
    try:
        updated = datetime.fromisoformat(changed.replace("Z", "+00:00"))
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        age_days = (datetime.now(timezone.utc) - updated).days
        if age_days > _STALE_THRESHOLD_DAYS:
            return {"status": "stale", "reason": f"Not updated in {age_days} days"}
    except (TypeError, ValueError):
        pass
    return {"status": "healthy", "reason": None}


async def _scope_facts_for(
    session: AsyncSession, rows: Sequence[ViewORM],
) -> Dict[str, _ScopeFacts]:
    """Batch-resolve workspace/data-source existence + active flags,
    keyed by view id. Two SELECTs regardless of row count."""
    ws_ids = {r.workspace_id for r in rows if r.workspace_id}
    ds_ids = {r.data_source_id for r in rows if r.data_source_id}

    ws_state: Dict[str, bool] = {}
    if ws_ids:
        res = await session.execute(
            select(WorkspaceORM.id, WorkspaceORM.is_active)
            .where(WorkspaceORM.id.in_(ws_ids))
            .where(WorkspaceORM.deleted_at.is_(None))
        )
        ws_state = {wid: bool(active) for wid, active in res.all()}

    ds_state: Dict[str, bool] = {}
    if ds_ids:
        res = await session.execute(
            select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.is_active)
            .where(WorkspaceDataSourceORM.id.in_(ds_ids))
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        )
        ds_state = {did: bool(active) for did, active in res.all()}

    out: Dict[str, _ScopeFacts] = {}
    for r in rows:
        out[r.id] = _ScopeFacts(
            ws_exists=r.workspace_id in ws_state,
            ws_active=ws_state.get(r.workspace_id, False),
            ds_exists=(r.data_source_id in ds_state) if r.data_source_id else True,
            ds_active=ds_state.get(r.data_source_id, False) if r.data_source_id else True,
        )
    return out


def _to_response(
    row: ViewORM,
    *,
    workspace_name: Optional[str] = None,
    data_source_name: Optional[str] = None,
    data_source_classification: Optional[str] = None,
    data_source_trust_status: Optional[str] = None,
    context_model_name: Optional[str] = None,
    created_by_name: Optional[str] = None,
    created_by_email: Optional[str] = None,
    updated_by_name: Optional[str] = None,
    updated_by_email: Optional[str] = None,
    data_updated_by_name: Optional[str] = None,
    data_updated_by_email: Optional[str] = None,
    created_by_avatar_id: Optional[str] = None,
    updated_by_avatar_id: Optional[str] = None,
    data_updated_by_avatar_id: Optional[str] = None,
    favourite_count: int = 0,
    is_favourited: bool = False,
    config_override: Optional[dict] = None,
    health: Optional[Dict[str, Optional[str]]] = None,
    publish_requester_name: Optional[str] = None,
    label_override: Optional[dict] = None,
) -> ViewResponse:
    # ``config_override`` lets branch-scoped-layout callers project the
    # EFFECTIVE (base ⊕ overlay) config into the response without touching the
    # row. Default None = read ``row.config`` verbatim (unchanged behaviour).
    # ``label_override`` does the same for the name, description, tags and view
    # type an import staged in the draft proposes.
    config_dict = config_override if config_override is not None else json.loads(row.config or "{}")
    label = label_override or {}
    # Project layoutType from config so metadata-only consumers (e.g. the
    # ViewWizard scope resolver) don't have to parse the full config blob.
    layout_type = None
    if isinstance(config_dict, dict):
        raw_layout = config_dict.get("layoutType")
        layout_type = str(raw_layout) if raw_layout is not None else None
    return ViewResponse(
        health=ViewHealthInfo(**health) if health else None,
        publish_request=(
            ViewPublishRequest(
                requested_by=row.publish_requested_by,
                requested_by_name=publish_requester_name,
                requested_at=row.publish_requested_at,
                note=row.publish_request_note,
            )
            if getattr(row, "publish_requested_at", None) else None
        ),
        id=row.id,
        name=label.get("name") or row.name,
        description=label.get("description") if label_override else row.description,
        contextModelId=row.context_model_id,
        contextModelName=context_model_name,
        contextModelVersion=row.context_model_version,
        workspaceId=row.workspace_id,
        workspaceName=workspace_name,
        dataSourceId=row.data_source_id,
        dataSourceName=data_source_name,
        dataSourceClassification=data_source_classification,
        dataSourceTrustStatus=data_source_trust_status,
        viewType=label.get("viewType") or row.view_type or "graph",
        layoutType=layout_type,
        config=config_dict,
        visibility=row.visibility or "private",
        createdBy=row.created_by,
        createdByName=created_by_name,
        createdByEmail=created_by_email,
        updatedBy=row.updated_by,
        updatedByName=updated_by_name,
        updatedByEmail=updated_by_email,
        dataUpdatedAt=getattr(row, 'data_updated_at', None),
        dataUpdatedBy=getattr(row, 'data_updated_by', None),
        dataUpdatedByName=data_updated_by_name,
        dataUpdatedByEmail=data_updated_by_email,
        createdByAvatarId=created_by_avatar_id,
        updatedByAvatarId=updated_by_avatar_id,
        dataUpdatedByAvatarId=data_updated_by_avatar_id,
        tags=(label.get("tags") or None) if label_override else (json.loads(row.tags) if row.tags else None),
        isPinned=bool(row.is_pinned) if row.is_pinned else False,
        favouriteCount=favourite_count,
        isFavourited=is_favourited,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
        deletedAt=getattr(row, 'deleted_at', None),
        ontologyDigest=getattr(row, 'ontology_digest', None),
        portableId=getattr(row, 'portable_id', None),
        draftBranchId=getattr(row, 'draft_branch_id', None),
    )


async def _to_enriched_response(
    session: AsyncSession,
    row: ViewORM,
    user_id: Optional[str] = None,
    *,
    config_override: Optional[dict] = None,
    label_override: Optional[dict] = None,
) -> ViewResponse:
    """Build a ViewResponse enriched with workspace name, data source name, CM name, and favourite info.

    Single-row enrichment used by create/get/update paths where N+1 is not a concern.
    For list paths, call :func:`_batch_enrich_rows` instead — it issues 5 batched queries
    in parallel regardless of row count.

    ``config_override`` is forwarded to :func:`_to_response` so branch-scoped
    callers can project the effective (base ⊕ overlay) config; default None
    reads the row's stored config unchanged.
    """
    ws_name = await _get_workspace_name(session, row.workspace_id)
    ds_name, ds_class, ds_trust = await _get_data_source_facts(session, row.data_source_id)
    cm_name = await _get_context_model_name(session, row.context_model_id, user_id)
    # Resolve creator, modifier AND data-publisher in one batched lookup
    # (dedupes when they're the same principal) — avatars included.
    user_map = await _resolve_user_identities(session, {
        row.created_by, row.updated_by,
        getattr(row, 'data_updated_by', None),
        getattr(row, 'publish_requested_by', None),
    })
    creator_name, creator_email, creator_avatar = user_map.get(
        row.created_by or "", (None, None, None))
    modifier_name, modifier_email, modifier_avatar = user_map.get(
        row.updated_by or "", (None, None, None))
    publisher_name, publisher_email, publisher_avatar = user_map.get(
        getattr(row, 'data_updated_by', None) or "", (None, None, None))
    fav_count = await _get_favourite_count(session, row.id)
    fav = await _is_favourited(session, row.id, user_id)
    facts = (await _scope_facts_for(session, [row]))[row.id]
    followed = await followed_configs(session, [row], {row.id: config_override} if config_override else None)
    config_override = followed.get(row.id, config_override)
    return _to_response(
        row,
        health=_health_for(row, facts),
        publish_requester_name=user_map.get(
            getattr(row, 'publish_requested_by', None) or "", (None, None, None))[0],
        workspace_name=ws_name,
        data_source_name=ds_name,
        data_source_classification=ds_class,
        data_source_trust_status=ds_trust,
        context_model_name=cm_name,
        created_by_name=creator_name,
        created_by_email=creator_email,
        updated_by_name=modifier_name,
        updated_by_email=modifier_email,
        data_updated_by_name=publisher_name,
        data_updated_by_email=publisher_email,
        created_by_avatar_id=creator_avatar,
        updated_by_avatar_id=modifier_avatar,
        data_updated_by_avatar_id=publisher_avatar,
        favourite_count=fav_count,
        is_favourited=fav,
        config_override=config_override,
        label_override=label_override,
    )


# ------------------------------------------------------------------ #
# Batched enrichment for list paths (kills N+1)                       #
# ------------------------------------------------------------------ #
#
# Previously, list endpoints called _to_enriched_response per row, which
# fanned out to 6 sequential SELECTs per row (workspace name, datasource
# name, context-model name, creator info, favourite count, is-favourited).
# At limit=20 this was ~121 round-trips, and under any concurrency the
# WEB pool would saturate, ballooning per-query latency until the request
# took multiple seconds.
#
# _batch_enrich_rows issues at most 5 lookups regardless of row count,
# in parallel via asyncio.gather. _to_response remains the single
# row→Pydantic converter so existing single-row paths are unaffected.

def _batch_enrich_enabled() -> bool:
    """Kill-switch for the batched-enrichment path.

    Default ON. Set ``VIEWS_BATCH_ENRICH=false`` to fall back to the
    legacy per-row path while we observe the new query shapes in prod.
    Read on each call so test fixtures and runtime overrides take effect
    without re-import. Cheap (os.getenv hits a dict).
    """
    return os.getenv("VIEWS_BATCH_ENRICH", "true").lower() not in ("false", "0", "no", "")


async def _batch_enrich_rows(
    session: AsyncSession,
    rows: Sequence[ViewORM],
    user_id: Optional[str] = None,
    *,
    fav_count_overrides: Optional[Dict[str, int]] = None,
) -> List[ViewResponse]:
    """Enrich a batch of view rows with name lookups + favourite info using batched queries.

    Issues at most 5 SELECTs total (workspaces, datasources, context models,
    users, favourite counts, favourites-by-user) regardless of how many
    rows are passed — versus 6×N round-trips in the legacy per-row path.

    Queries are issued sequentially because ``AsyncSession`` is not safe
    for concurrent operations on a single session (it serialises via an
    internal lock); the win here is the *number* of round-trips, not
    parallelism.

    ``fav_count_overrides`` lets callers that already computed the
    favourite count (e.g. ``list_popular_views`` which JOINs an aggregated
    subquery) skip the GROUP BY query and reuse those counts.
    """
    if not rows:
        return []

    workspace_ids: Set[str] = {r.workspace_id for r in rows if r.workspace_id}
    ds_ids: Set[str] = {r.data_source_id for r in rows if r.data_source_id}
    cm_ids: Set[str] = {r.context_model_id for r in rows if r.context_model_id}
    user_ids: Set[Optional[str]] = {
        uid for r in rows
        for uid in (
            r.created_by, r.updated_by,
            getattr(r, 'data_updated_by', None),
            getattr(r, 'publish_requested_by', None),
        )
    }
    view_ids: List[str] = [r.id for r in rows]

    ws_map: Dict[str, str] = {}
    if workspace_ids:
        res = await session.execute(
            select(WorkspaceORM.id, WorkspaceORM.name)
            .where(WorkspaceORM.id.in_(workspace_ids))
        )
        ws_map = {wid: name for wid, name in res.all()}

    # id → (label, classification, trust status), for live sources only.
    ds_map: Dict[str, Tuple[Optional[str], Optional[str], Optional[str]]] = {}
    if ds_ids:
        res = await session.execute(
            select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label,
                   WorkspaceDataSourceORM.classification, WorkspaceDataSourceORM.trust_status)
            .where(WorkspaceDataSourceORM.id.in_(ds_ids))
            .where(WorkspaceDataSourceORM.deleted_at.is_(None))
        )
        ds_map = {did: (label, cls, trust) for did, label, cls, trust in res.all()}

    cm_map: Dict[str, str] = {}
    if cm_ids:
        res = await session.execute(
            select(ContextModelORM.id, ContextModelORM.name)
            .where(ContextModelORM.id.in_(cm_ids), _nameable_template(user_id))
        )
        cm_map = {cid: name for cid, name in res.all()}

    # Scope integrity (existence + active flags) for the whole batch.
    health_map = await _scope_facts_for(session, rows)

    # One users lookup resolves every creator AND modifier id in the batch,
    # avatars included.
    user_map = await _resolve_user_identities(session, user_ids)

    # Favourite counts: skip the GROUP BY when the caller already has
    # them (popular views computes them from its JOINed subquery).
    if fav_count_overrides is not None:
        fav_counts: Dict[str, int] = dict(fav_count_overrides)
    elif view_ids:
        res = await session.execute(
            select(ViewFavouriteORM.view_id, func.count())
            .where(ViewFavouriteORM.view_id.in_(view_ids))
            .group_by(ViewFavouriteORM.view_id)
        )
        fav_counts = {vid: cnt for vid, cnt in res.all()}
    else:
        fav_counts = {}

    fav_set: Set[str] = set()
    if user_id and user_id != "anonymous" and view_ids:
        res = await session.execute(
            select(ViewFavouriteORM.view_id)
            .where(ViewFavouriteORM.view_id.in_(view_ids))
            .where(ViewFavouriteORM.user_id == user_id)
        )
        fav_set = {vid for (vid,) in res.all()}

    followed = await followed_configs(session, rows)

    responses: List[ViewResponse] = []
    for row in rows:
        creator = user_map.get(row.created_by or "", (None, None, None))
        modifier = user_map.get(row.updated_by or "", (None, None, None))
        publisher = user_map.get(getattr(row, 'data_updated_by', None) or "", (None, None, None))
        ds_name, ds_class, ds_trust = ds_map.get(row.data_source_id, _NO_SOURCE) if row.data_source_id else _NO_SOURCE
        responses.append(_to_response(
            row,
            config_override=followed.get(row.id),
            workspace_name=ws_map.get(row.workspace_id) if row.workspace_id else None,
            data_source_name=ds_name,
            data_source_classification=ds_class,
            data_source_trust_status=ds_trust,
            context_model_name=cm_map.get(row.context_model_id) if row.context_model_id else None,
            created_by_name=creator[0],
            created_by_email=creator[1],
            updated_by_name=modifier[0],
            updated_by_email=modifier[1],
            data_updated_by_name=publisher[0],
            data_updated_by_email=publisher[1],
            created_by_avatar_id=creator[2],
            updated_by_avatar_id=modifier[2],
            data_updated_by_avatar_id=publisher[2],
            favourite_count=fav_counts.get(row.id, 0),
            is_favourited=row.id in fav_set,
            health=_health_for(row, health_map[row.id]),
            publish_requester_name=user_map.get(
                getattr(row, 'publish_requested_by', None) or "", (None, None, None))[0],
        ))
    return responses


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def create_view(
    session: AsyncSession,
    req: ViewCreateRequest,
    *,
    ontology_digest: Optional[str] = None,
    user_id: Optional[str] = None,
) -> ViewResponse:
    """Persist a new view.

    ``ontology_digest`` should be supplied by the endpoint layer, computed
    from the currently-resolved ontology for the view's workspace/data
    source. It is stored verbatim and used later by the wizard's drift
    detection. Pass None only when the caller has no way to resolve the
    ontology (e.g. ad-hoc tests, legacy seed scripts).

    ``user_id`` is stored in ``created_by`` so the Explorer can filter
    views by creator ("My Views"). Legacy rows created before this
    parameter existed have NULL ``created_by``.
    """
    logger.info(
        "create_view: name=%s workspace_id=%s data_source_id=%s digest=%s",
        req.name, req.workspace_id, req.data_source_id,
        ontology_digest[:12] + "…" if ontology_digest else None,
    )

    # Stamp the entity scope at BIRTH so it is never inferred later.
    #
    # `derive_entity_scope` falls back to "curated iff this view has any
    # assignment", which is a property that CHANGES as the view is edited: a
    # rule-driven view reads 'all' until the first drag and 'curated' after,
    # and that flip switches off the very rules placing its contents. Writing
    # the answer once, here, is what stops it moving.
    #
    # Done in the repository rather than in a client so it holds for every
    # caller — wizard, import, duplicate, direct API — in every environment.
    # The value written is exactly what the read path would have derived, so a
    # view created before and after this behaves identically.
    config = dict(req.config) if isinstance(req.config, dict) else {}
    if config:
        content = config.get("content")
        content = dict(content) if isinstance(content, dict) else {}
        if content.get("entityScope") not in ("all", "curated"):
            content["entityScope"] = derive_entity_scope(config)
        config["content"] = content

    row = ViewORM(
        name=req.name,
        description=req.description,
        context_model_id=req.context_model_id,
        context_model_version=req.context_model_version,
        workspace_id=req.workspace_id,
        data_source_id=req.data_source_id,
        view_type=req.view_type or "graph",
        config=json.dumps(config) if config else "{}",
        visibility=req.visibility or "private",
        created_by=user_id,
        tags=json.dumps(req.tags, ensure_ascii=False) if req.tags else None,
        is_pinned=req.is_pinned,
        ontology_digest=ontology_digest,
    )
    session.add(row)
    await session.flush()
    return await _to_enriched_response(session, row, user_id)


async def get_view(
    session: AsyncSession, view_id: str
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return await _to_enriched_response(session, row)


async def get_view_enriched(
    session: AsyncSession,
    view_id: str,
    user_id: Optional[str] = None,
    *,
    branch_id: Optional[str] = None,
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    # Branch-effective read: when a draft (branch_id) is reading, project the
    # base ⊕ overlay config (and the label an import staged there proposes);
    # no branch (or no overlay) → base, byte-identical.
    if not branch_id:
        return await _to_enriched_response(session, row, user_id)
    overlay = await get_overlay(session, row.id, branch_id)
    return await _to_enriched_response(
        session, row, user_id,
        config_override=_with_overlay(_load_config(row), overlay),
        label_override=_json_or_none(overlay.label) if overlay is not None else None,
    )


async def update_view(
    session: AsyncSession,
    view_id: str,
    req: ViewUpdateRequest,
    *,
    ontology_digest: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Optional[ViewResponse]:
    """Update an existing view.

    ``ontology_digest`` — when the endpoint layer can resolve the active
    ontology, it passes the fresh digest here so the saved view reflects
    the CURRENT ontology state (not the one it was originally created
    against). This resets the drift-detection baseline on every explicit
    save; passing None preserves the existing digest unchanged.

    ``user_id`` is stamped into ``updated_by`` so surfaces can show who
    last edited the view. When None (e.g. legacy callers / seed scripts)
    the existing ``updated_by`` is preserved.

    The layout and scope in ``config`` are not written here; the stored
    ones are kept (see ``_keep_config_layout``). Neither is a coverage it
    leaves out (see ``_keep_coverage``); ``req.coverage`` writes one on its
    own, over whatever ``config`` said.
    """
    # populate_existing: the endpoint loaded the row before the lock; read
    # what the lock holds, not that.
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
        .with_for_update().execution_options(populate_existing=True)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.context_model_id is not None:
        row.context_model_id = req.context_model_id
    if req.context_model_version is not None:
        row.context_model_version = req.context_model_version
    if req.view_type is not None:
        row.view_type = req.view_type
    if req.config is not None:
        stored = _load_config(row)
        _keep_config_layout(req.config, stored)
        _keep_coverage(req.config, stored)
        row.config = json.dumps(req.config)
    if req.coverage is not None:
        config = _load_config(row)
        config["coverage"] = req.coverage
        row.config = json.dumps(config)
    # visibility is NOT written here: it is a security field with its own
    # authorization (publish gate) — see update_visibility. The endpoint
    # 422s before reaching this function; skipping it here keeps a direct
    # repo caller from bypassing that rule too.
    if req.tags is not None:
        row.tags = json.dumps(req.tags, ensure_ascii=False)
    if req.is_pinned is not None:
        row.is_pinned = req.is_pinned
    if ontology_digest is not None:
        row.ontology_digest = ontology_digest
    if user_id is not None:
        row.updated_by = user_id

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return await _to_enriched_response(session, row)


def _keep_display_rules(new_layout: Any, previous_layout: Any) -> None:
    """Keep the stored ``displayRules`` on a replacement ``referenceLayout``,
    whatever the replacement says about them.

    Every layout writer replaces ``referenceLayout`` wholesale, and the rules
    live inside it. A caller that edits layers — the View Wizard, a config
    save built from its own copy of the layout — sent back the rules it had
    read, or none: a copy read before someone changed a rule put the old
    rules back, and a layout without the key deleted every rule on the view.
    Rules are written only through the view's library
    (``backend.app.services.view_library``), one rule at a time; every other
    writer keeps the ones stored.
    """
    if not isinstance(new_layout, dict):
        return
    rules = previous_layout.get("displayRules") if isinstance(previous_layout, dict) else None
    if isinstance(rules, list):
        new_layout["displayRules"] = rules
    else:
        new_layout.pop("displayRules", None)


def _keep_coverage(new_config: Any, stored_config: dict) -> None:
    """Keep the stored ``coverage`` on a whole replacement config that says nothing of it.

    ``coverage`` says whether a view is meant to show everything in its source ('complete') or
    only what it was made to show ('specialised'). It is changed on its own
    (``ViewUpdateRequest.coverage``), so most config saves never mention it: one built by a
    client that doesn't know the key, or from a copy read before it was set, would otherwise
    drop it, and the view would go back to saying neither. A config that does carry the key
    writes it."""
    if isinstance(new_config, dict) and "coverage" not in new_config and "coverage" in stored_config:
        new_config["coverage"] = stored_config["coverage"]


def _keep_config_layout(new_config: Any, stored_config: dict) -> None:
    """Keep the stored ``referenceLayout`` (its display rules included) and
    ``content.entityScope`` on a whole replacement config, whatever it says.

    They are written only by PUT /layout (the overlay, on a draft), promote,
    restore and the library. A config save is built from the copy its caller
    read, which on a draft is the published view with the draft's overlay
    laid over it: writing its layout and scope published the draft's edits
    unreviewed (VIEWS-1)."""
    if not isinstance(new_config, dict):
        return
    new_config.pop("referenceLayout", None)          # the legacy top-level spelling
    stored = _base_reference_layout(stored_config)
    layout = new_config.get("layout")
    if stored:
        if not isinstance(layout, dict):
            layout = new_config["layout"] = {}
        layout["referenceLayout"] = stored
    elif isinstance(layout, dict):
        layout.pop("referenceLayout", None)
    stored_content = stored_config.get("content")
    content = new_config.get("content")
    if isinstance(stored_content, dict) and "entityScope" in stored_content:
        if not isinstance(content, dict):
            content = new_config["content"] = {}
        content["entityScope"] = stored_content["entityScope"]
    elif isinstance(content, dict):
        content.pop("entityScope", None)
    # A view made from a query keeps its definition: it changes through PUT
    # /views/{id}/membership only, never a settings save built from an older copy.
    # A subset view's search likewise, through PUT /views/{id}/search.
    for key in ("membership", "search"):
        if key in stored_config:
            new_config[key] = stored_config[key]
        else:
            new_config.pop(key, None)


def _subset_layout(config: dict, reference_layout: dict) -> bool:
    """Whether ``config`` is a subset view's — and if so, refuse a layout it can't
    hold (``ValueError``, a 422): one that follows its base stores no layers, an
    own one only layers of types (``search_views.layout_problems``). A view made from
    a query that follows a view is no subset here (it holds members of its own), but
    stores no layers either: they are that view's."""
    from backend.app.services.search_views import followed_base, is_subset, layout_problems
    if not is_subset(config):
        if followed_base(config) and reference_layout.get("layers"):
            raise ValueError("Its layers come from the view it follows: change them there.")
        return False
    candidate = {**config, "layout": {**(config.get("layout") if isinstance(config.get("layout"), dict)
                                         else {}), "referenceLayout": reference_layout}}
    candidate.pop("referenceLayout", None)
    problem = layout_problems(candidate)
    if problem:
        raise ValueError(problem)
    return True


async def _gate_node_ordering(session: AsyncSession, reference_layout: dict) -> dict:
    """Enforce ``nodeSortingEnabled`` on the write side.

    The gate lives here rather than in the endpoints because this is the
    one place both layout writers already share. Three endpoints reach
    these two functions (views.py x2, versioning.py), and a gate repeated
    three times is a gate somebody will forget on the fourth.

    Fails OPEN, like every capability flag: if the value can't be read we
    keep accepting orders rather than silently discarding a user's
    curation over a database hiccup. The switch exists to stop a team
    re-sorting curated views, not to defend a secret.
    """
    from backend.app.services.feature_flags import feature_flags

    if await feature_flags.is_enabled(
        "nodeSortingEnabled", session, default=True,
    ):
        return reference_layout
    return strip_node_ordering(reference_layout)


async def check_layer_rules(
    session: AsyncSession, reference_layout: Any, previous_layout: Any,
) -> None:
    """Refuse (``ValueError``; the endpoints map it to 422) a NEW or CHANGED layer rule
    that can never match, while the placement contract is on
    (``placementContractEnabled``). Off, every rule is accepted exactly as before.

    Both layouts are BARE referenceLayouts. A rule stored earlier and sent back
    unchanged always passes: the canvas rewrites the whole layout on every gesture,
    and an older view's inert rule must not block a drag that never touched it.
    """
    from backend.app.services.view_placement import contract_enabled, inert_rule_errors

    if not await contract_enabled(session):
        return
    errors = inert_rule_errors(reference_layout, previous_layout)
    if errors:
        raise ValueError("; ".join(errors))


async def _made_from_a_query(session: AsyncSession, config: dict):
    """The view's membership definition when it is made from a query (live or a
    snapshot: either way its members are rows of ``view_members``) and the preview is
    on, else None. With the preview off, a view made from a query is left as it is:
    its entries are taken as they are written."""
    from backend.common.models.view_membership import read_definition

    definition = read_definition(config)
    if definition is None:
        return None
    from backend.app.services.feature_flags import feature_flags

    if not await feature_flags.is_enabled("viewMembershipEnabled", session, default=False):
        return None
    return definition


async def _layers_placed_in(session: AsyncSession, row: ViewORM, config: dict, reference_layout: dict) -> list:
    """The layers a layout write places things in: the ones it sends — or, for a view made
    from a query that follows another, the ones it is served (that view's as it is now,
    "Other matches" among them), since it stores none. With the view it follows gone, a
    ``ValueError`` (a 422): nothing is placed in layers it can't show."""
    from backend.common.models.view_membership import read_definition

    definition = read_definition(config)
    if definition is None or definition.layout.kind != "follow":
        return reference_layout.get("layers", [])
    from backend.app.services.live_views import layouts, pipeline

    base = await pipeline.source_config(session, definition, row.workspace_id)
    if base is None:
        raise ValueError("The view it follows can't be read, so nothing can be placed in this one "
                         "until it is back.")
    return layouts.followed(base)


async def tell_followers(session: AsyncSession, row: ViewORM, config: dict) -> None:
    """Called before ``config`` is written over ``row``'s published one: when it changes how
    the view places entities (``placement_digest`` — a rename or a recolour doesn't), every
    view made from a query that follows it is marked out of date, to be placed again when
    it is next opened."""
    from backend.app.db.repositories import view_membership_repo
    from backend.app.services.view_placement import PlacementSpec, placement_digest

    followers = await view_membership_repo.followers(session, row.id)
    if followers and (placement_digest(PlacementSpec.from_config(_load_config(row)))
                      != placement_digest(PlacementSpec.from_config(config))):
        await view_membership_repo.mark_followers_pending(session, followers)


def _remember_overrides(config: dict, overrides: Dict[str, dict]) -> None:
    from backend.app.services.live_views.ownership import remember

    membership = config.get("membership")
    if isinstance(membership, dict) and overrides:
        membership["overrides"] = remember(membership.get("overrides") or {}, overrides)


async def update_view_layout(
    session: AsyncSession,
    view_id: str,
    req: ViewLayoutUpdateRequest,
    *,
    user_id: Optional[str] = None,
) -> Optional[ViewResponse]:
    """Persist a view's layer layout in isolation.

    Only touches ``config["layout"]["referenceLayout"]`` (and, when
    supplied, ``config["content"]["entityScope"]``) — every other config key
    (name/description/content/filters/...) is left untouched, and so are the
    view's display rules (see ``_keep_display_rules``).

    Raises ``ValueError`` if an assignment names a ``layerId`` that isn't
    one of the submitted layers' ids — for a view made from a query that
    follows another, one of the layers it is served (the endpoint maps this
    to a 422) — or if ``check_layer_rules`` refuses a new or changed layer rule.
    """
    # populate_existing: as in update_view.
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
        .with_for_update().execution_options(populate_existing=True)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    config = json.loads(row.config or "{}")
    if not isinstance(config, dict):
        config = {}
    previous_layout = _base_reference_layout(config)
    reference_layout = req.reference_layout
    entity_scope = req.entity_scope
    # Refused before anything is written, members' places included.
    subset = _subset_layout(config, reference_layout)
    layers = await _layers_placed_in(session, row, config, reference_layout)
    kept = await _made_from_a_query(session, config)
    if kept is not None:
        # The members follow the data, whatever this copy of the layout says: an entry
        # for one is a move, applied to it and remembered (live_views.ownership).
        from backend.app.db.repositories import view_members_repo, view_membership_repo
        from backend.app.services.live_views.ownership import layer_ids_of, reconcile_layout_write
        from backend.app.services.live_views.pipeline import fallback_of

        epoch = await view_members_repo.members_epoch(session, row.id)
        incoming = reference_layout.get("assignments") or {}
        placed_in, fallback = layer_ids_of({"layers": layers}), fallback_of(kept, layers)
        reconciled = reconcile_layout_write(
            previous_layout.get("assignments") or {}, incoming,
            members=await view_members_repo.placements(session, row.id, epoch, incoming),
            layer_ids=placed_in, fallback_layer_id=fallback,
            record_overrides=True, now=datetime.now(timezone.utc).isoformat(),
        )
        reference_layout = {**reference_layout, "assignments": reconciled.assignments}
        entity_scope = "curated"
        _remember_overrides(config, reconciled.overrides)
        await view_members_repo.move(session, row.id, epoch, reconciled.moves)
        if await view_members_repo.rehome(session, row.id, epoch, placed_in, fallback):
            await view_membership_repo.mark_pending(session, row, reason="layer_removed")
    if subset:
        entity_scope = "all"          # a subset holds every match of its layers' types
    await check_layer_rules(session, reference_layout, previous_layout)
    layout = config.get("layout")
    if not isinstance(layout, dict):
        layout = {}
    # Self-heal invalid node-ordering fields (drop, never reject — see
    # sanitize_node_ordering) before the wholesale write, then apply the
    # nodeSortingEnabled kill switch.
    layout["referenceLayout"] = await _gate_node_ordering(
        session, sanitize_node_ordering(reference_layout),
    )
    config["layout"] = layout

    if entity_scope is not None:
        content = config.get("content")
        if not isinstance(content, dict):
            content = {}
        content["entityScope"] = entity_scope
        config["content"] = content

    _keep_display_rules(layout["referenceLayout"], previous_layout)

    layer_ids = {
        layer.get("id") for layer in layers
        if isinstance(layer, dict)
    }
    for urn, assignment in reference_layout.get("assignments", {}).items():
        layer_id = assignment.get("layerId") if isinstance(assignment, dict) else None
        if layer_id not in layer_ids:
            raise ValueError(
                f"assignment for '{urn}' names unknown layerId '{layer_id}'"
            )

    await tell_followers(session, row, config)
    row.config = json.dumps(config)
    if user_id is not None:
        row.updated_by = user_id
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return await _to_enriched_response(session, row)


# ------------------------------------------------------------------ #
# Branch-scoped layout overlays                                        #
# ------------------------------------------------------------------ #
#
# A draft branch's layer edits live in ``view_layout_overlays`` keyed by
# (view_id, branch_id) instead of on the published ``views.config``, so they
# don't leak to Published until the draft is promoted (merge/publish). Each
# overlay holds the draft's effective BARE referenceLayout + entityScope plus a
# fork-point snapshot of the published base, which the 3-way promote merge
# (``layout_promote``) uses to tell what the draft actually changed.
#
# INVARIANT: ``merge_layout_3way`` and the overlay columns operate on the BARE
# ``referenceLayout`` (``config["layout"]["referenceLayout"]``), never the full
# view config — see ``_base_reference_layout``.


def _base_reference_layout(config: dict) -> dict:
    """Extract the BARE published referenceLayout from a full view config,
    tolerating the legacy top-level ``config["referenceLayout"]`` spelling.
    Returns ``{}`` when absent."""
    if not isinstance(config, dict):
        return {}
    layout = config.get("layout")
    if isinstance(layout, dict) and isinstance(layout.get("referenceLayout"), dict):
        return layout["referenceLayout"]
    legacy = config.get("referenceLayout")
    if isinstance(legacy, dict):
        return legacy
    return {}


def _load_config(row: ViewORM) -> dict:
    config = json.loads(row.config or "{}")
    return config if isinstance(config, dict) else {}


async def followed_configs(
    session: AsyncSession, rows: Sequence[ViewORM], configs: Optional[Dict[str, dict]] = None,
) -> Dict[str, dict]:
    """Each view in ``rows`` that follows another (``search_views.followed_base``: a
    subset that follows its base, or a view made from a query that follows a view), with
    its config as it is read: the base's layers, entity styles and drawn relationships
    composed in (``search_views.served_config``). Its layers are never stored, so it is
    always its base's as the base is now.

    The bases are read in one query, as the system: a subset's readers see the layers
    it shows, not the base. A base gone, or out of the subset's workspace, leaves the
    subset no layers — never anyone else's. ``configs`` gives a row's config where it
    is not the stored one (a draft's)."""
    from backend.app.services.search_views import followed_base, served_config

    wanted: Dict[str, tuple] = {}
    for row in rows:
        if not getattr(row, "subset_of", None):
            continue
        config = (configs or {}).get(row.id) or _load_config(row)
        base_id = followed_base(config)
        if base_id:
            wanted[row.id] = (row, config, base_id)
    if not wanted:
        return {}
    base_ids = {base_id for _, _, base_id in wanted.values()}
    bases = {b.id: b for b in (await session.execute(
        select(ViewORM).where(ViewORM.id.in_(base_ids), view_is_live()))).scalars()}
    out: Dict[str, dict] = {}
    for view_id, (row, config, base_id) in wanted.items():
        base = bases.get(base_id)
        usable = base is not None and base.workspace_id == row.workspace_id and base.id != row.id
        out[view_id] = served_config(config, _load_config(base) if usable else None)
    return out


async def get_overlay(
    session: AsyncSession, view_id: str, branch_id: str
) -> Optional[ViewLayoutOverlayORM]:
    """Return the (view_id, branch_id) overlay row, or None if none exists."""
    result = await session.execute(
        select(ViewLayoutOverlayORM).where(
            ViewLayoutOverlayORM.view_id == view_id,
            ViewLayoutOverlayORM.branch_id == branch_id,
        )
    )
    return result.scalar_one_or_none()


async def ensure_overlay(
    session: AsyncSession, view_id: str, branch_id: str
) -> ViewLayoutOverlayORM:
    """Idempotently return the (view_id, branch_id) overlay, creating it from
    the view's published base if absent.

    On first creation the draft's effective layout EQUALS the base: both
    ``reference_layout`` and ``fork_base_layout`` snapshot the view's current
    BARE referenceLayout, and both scope columns snapshot the derived base
    ``entityScope``. Raises ValueError if the view does not exist (an overlay
    can't reference a missing view — the FK would reject it anyway)."""
    existing = await get_overlay(session, view_id, branch_id)
    if existing is not None:
        return existing

    result = await session.execute(select(ViewORM).where(ViewORM.id == view_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise ValueError(f"cannot open a layout overlay for missing view '{view_id}'")

    config = _load_config(row)
    base_layout = _base_reference_layout(config)
    base_scope = derive_entity_scope(config)

    overlay = ViewLayoutOverlayORM(
        view_id=view_id,
        branch_id=branch_id,
        reference_layout=json.dumps(base_layout),
        entity_scope=base_scope,
        fork_base_layout=json.dumps(base_layout),
        fork_base_entity_scope=base_scope,
    )
    # Two first writes to one draft race on the primary key: the loser reads the
    # winner's overlay rather than failing the save.
    try:
        async with session.begin_nested():
            session.add(overlay)
    except IntegrityError:
        existing = await get_overlay(session, view_id, branch_id)
        if existing is None:
            raise
        return existing
    return overlay


def _validate_layer_refs(reference_layout: dict) -> None:
    """Raise ValueError (endpoint maps to 422) if any assignment names a
    ``layerId`` that isn't one of the submitted layers — mirrors
    :func:`update_view_layout`'s validation."""
    layer_ids = {
        layer.get("id") for layer in reference_layout.get("layers", [])
        if isinstance(layer, dict)
    }
    for urn, assignment in reference_layout.get("assignments", {}).items():
        layer_id = assignment.get("layerId") if isinstance(assignment, dict) else None
        if layer_id not in layer_ids:
            raise ValueError(
                f"assignment for '{urn}' names unknown layerId '{layer_id}'"
            )


async def update_overlay_layout(
    session: AsyncSession,
    view_id: str,
    branch_id: str,
    req: ViewLayoutUpdateRequest,
) -> Optional[ViewResponse]:
    """Write a draft's layer layout onto its branch overlay (never the views
    row). Returns the view enriched with the EFFECTIVE (overlay) layout, or
    None if the view doesn't exist.

    Raises ValueError (→ 422) if an assignment names an unknown ``layerId``,
    matching :func:`update_view_layout`, or if ``check_layer_rules`` refuses a
    new or changed layer rule (compared with the draft's current layout)."""
    result = await session.execute(select(ViewORM).where(ViewORM.id == view_id))
    row = result.scalar_one_or_none()
    if not row:
        return None

    requested = req.reference_layout
    existing = await get_overlay(session, view_id, branch_id)
    config = _load_config(row)
    kept = await _made_from_a_query(session, config)
    if kept is not None:
        # The members are the published view's (the member table's); a draft's save
        # keeps its moves of them as entries of its own, remembered when the draft is
        # published, not before.
        from backend.app.db.repositories import view_members_repo
        from backend.app.services.live_views.ownership import layer_ids_of, reconcile_layout_write

        stored = (json.loads(existing.reference_layout or "{}") if existing is not None
                  else _base_reference_layout(config))
        incoming = requested.get("assignments") or {}
        reconciled = reconcile_layout_write(
            stored.get("assignments") or {}, incoming,
            members=await view_members_repo.placements(
                session, view_id, await view_members_repo.members_epoch(session, view_id),
                set(incoming) | set(stored.get("assignments") or {})),
            layer_ids=layer_ids_of(requested), fallback_layer_id=kept.layout.fallback_layer_id,
            record_overrides=False,
        )
        requested = {**requested, "assignments": reconciled.assignments}

    # Validate BEFORE any write so a bad request never mutates the overlay.
    subset = _subset_layout(config, requested)
    _validate_layer_refs(requested)
    await check_layer_rules(
        session, requested,
        json.loads(existing.reference_layout or "{}") if existing is not None
        else _base_reference_layout(config),
    )

    overlay = await ensure_overlay(session, view_id, branch_id)
    # Read-modify-write under the overlay's own lock: two saves to one draft at
    # once each keep the display rules the other just wrote.
    await session.refresh(overlay, with_for_update=True)

    reference_layout = dict(await _gate_node_ordering(
        session, sanitize_node_ordering(requested),
    ))
    _keep_display_rules(reference_layout, json.loads(overlay.reference_layout or "{}"))
    overlay.reference_layout = json.dumps(reference_layout)
    if subset:
        overlay.entity_scope = "all"
    elif req.entity_scope is not None:
        overlay.entity_scope = "curated" if kept is not None else req.entity_scope
    await session.flush()  # onupdate stamps overlay.updated_at

    return await get_view_enriched(session, view_id, branch_id=branch_id)


async def effective_view_config(
    session: AsyncSession,
    view_row_or_id,
    branch_id: Optional[str],
) -> dict:
    """Central read-side merge: return the view's config with the branch
    overlay projected in.

    When ``branch_id`` is given AND an overlay exists, override
    ``config["layout"]["referenceLayout"]`` with the overlay's draft layout and
    ``config["content"]["entityScope"]`` with the overlay's scope. Otherwise
    the base config is returned unchanged. ``view_row_or_id`` may be a loaded
    ``ViewORM`` (GET path) or a view id; a missing id yields ``{}``."""
    if isinstance(view_row_or_id, ViewORM):
        row = view_row_or_id
    else:
        result = await session.execute(
            select(ViewORM).where(ViewORM.id == view_row_or_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            return {}

    config = _load_config(row)
    if not branch_id:
        return config
    return _with_overlay(config, await get_overlay(session, row.id, branch_id))


def _json_or_none(text: Optional[str]) -> Optional[dict]:
    value = json.loads(text) if text else None
    return value if isinstance(value, dict) else None


def _with_overlay(config: dict, overlay: Optional[ViewLayoutOverlayORM]) -> dict:
    """``config`` as the draft holding ``overlay`` sees it.

    A draft whose overlay only edits layers overrides the layout and scope. One holding a staged
    import proposes the whole design: the view reads as that design (the layout, scope and rest
    of the definition from the overlay), as it will once the draft goes live."""
    if overlay is None:
        return config
    if overlay.definition is not None:
        label = _json_or_none(overlay.label) or {}
        definition = join_definition(
            json.loads(overlay.definition), json.loads(overlay.reference_layout or "{}"), overlay.entity_scope,
        )
        return config_from_definition(definition, icon=label.get("icon"))

    layout = config.get("layout")
    if not isinstance(layout, dict):
        layout = {}
    layout["referenceLayout"] = json.loads(overlay.reference_layout or "{}")
    config["layout"] = layout

    if overlay.entity_scope is not None:
        content = config.get("content")
        if not isinstance(content, dict):
            content = {}
        content["entityScope"] = overlay.entity_scope
        config["content"] = content

    return config


async def promote_overlay(
    session: AsyncSession, view_id: str, branch_id: str, *, actor: Optional[str] = None
) -> bool:
    """Promote a draft overlay into the published base via the pure 3-way merge
    and DELETE the overlay. Returns True iff an overlay existed and was promoted.

    F = overlay fork-base, P = current published base, D = overlay draft. The
    merge handles CREATE/UPDATE/DELETE of layers and assignments (draft wins
    conflicts) and self-heals orphaned assignments; ``entityScope`` merges with
    the same draft-wins rule. Best-effort by design — the merge never raises."""
    overlay = await get_overlay(session, view_id, branch_id)
    if overlay is None:
        return False

    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id).with_for_update()
    )
    row = result.scalar_one_or_none()
    if row is None:
        # Orphaned overlay (shouldn't happen under the FK) — discard it.
        await session.delete(overlay)
        await session.flush()
        return False

    if overlay.definition is not None:
        await _promote_staged_import(session, row, overlay, branch_id, actor)
        return True

    config = _load_config(row)
    fork_base = json.loads(overlay.fork_base_layout or "{}")
    published = _base_reference_layout(config)
    draft = json.loads(overlay.reference_layout or "{}")

    merged_layout = merge_layout_3way(fork_base, published, draft)
    # merge_layout_3way returns only {layers, assignments}; re-attach the merged
    # side-fields so promote never wipes them off the published base.
    merged_display_rules = merge_display_rules_3way(fork_base, published, draft)
    if merged_display_rules is not None:
        merged_layout["displayRules"] = merged_display_rules
    merged_default_sort = merge_default_sort_3way(fork_base, published, draft)
    if merged_default_sort is not None:
        merged_layout["defaultNodeSortMode"] = merged_default_sort
    # And every other side field, so publishing a draft never drops one it doesn't know.
    merged_layout.update(merge_layout_side_fields(fork_base, published, draft))
    merged_scope = merge_scope_3way(
        overlay.fork_base_entity_scope,
        derive_entity_scope(config),
        overlay.entity_scope,
    )
    kept = await _made_from_a_query(session, config)
    if kept is not None:
        # The data moved on while the draft was open: the member table's members are
        # the truth, and the draft's moves of them are kept.
        from backend.app.db.repositories import view_members_repo, view_membership_repo
        from backend.app.services.live_views.ownership import layer_ids_of, reconcile_promote

        epoch = await view_members_repo.members_epoch(session, row.id)
        drafted = draft.get("assignments") or {}
        reconciled = reconcile_promote(
            merged_layout.get("assignments") or {}, fork=fork_base.get("assignments") or {}, draft=drafted,
            members=await view_members_repo.placements(session, row.id, epoch, drafted),
            layer_ids=layer_ids_of(merged_layout), fallback_layer_id=kept.layout.fallback_layer_id,
            now=datetime.now(timezone.utc).isoformat(),
        )
        merged_layout["assignments"] = reconciled.assignments
        merged_scope = "curated"
        _remember_overrides(config, reconciled.overrides)
        await view_members_repo.move(session, row.id, epoch, reconciled.moves)
        if await view_members_repo.rehome(session, row.id, epoch, layer_ids_of(merged_layout),
                                          kept.layout.fallback_layer_id):
            await view_membership_repo.mark_pending(session, row, reason="layer_removed")

    try:
        if _subset_layout(config, merged_layout):
            merged_scope = "all"
    except ValueError:
        # Promote never raises: a merge a subset can't hold (the published view
        # changed under the draft) keeps the published layers.
        logger.warning("promote: subset view %s kept its layers; the draft's merge can't hold", row.id)
        merged_layout, merged_scope = published, "all"

    layout = config.get("layout")
    if not isinstance(layout, dict):
        layout = {}
    layout["referenceLayout"] = merged_layout
    config["layout"] = layout

    content = config.get("content")
    if not isinstance(content, dict):
        content = {}
    content["entityScope"] = merged_scope
    config["content"] = content

    await tell_followers(session, row, config)
    row.config = json.dumps(config)
    if actor is not None:
        row.updated_by = actor
    row.updated_at = datetime.now(timezone.utc).isoformat()

    await session.delete(overlay)
    await session.flush()

    # The draft's layout is now the view's: record it in the view's history. Imported here,
    # not at module level, because the version repository reads back through this module.
    # Best-effort like the promote itself: a history write must never undo a merge.
    from backend.app.db.repositories import view_version_repo
    try:
        await view_version_repo.checkpoint(
            session, row, source="promote", actor=actor,
            message="Draft changes published", provenance={"branchId": branch_id},
        )
    except Exception:  # noqa: BLE001
        logger.exception("promote_overlay: version checkpoint failed for view %s", view_id)
    return True


async def _promote_staged_import(
    session: AsyncSession, row: ViewORM, overlay: ViewLayoutOverlayORM, branch_id: str,
    actor: Optional[str],
) -> None:
    """An import staged in the draft goes live: its design and label merge 3-way into the view,
    the file winning where both sides changed the same thing, recorded as the import in the
    view's history. Base is the view as published when the import was staged; ours, the view as
    published now; theirs, what the draft proposes (the file, plus any layer edits made in the
    draft since)."""
    # Imported here, not at module level: these read back through this module.
    from backend.app.db.repositories import view_activity_repo, view_version_repo
    from backend.app.services.view_transfer.canonical import content_hash
    from backend.app.services.view_transfer.merge import merge_definitions, merge_labels

    staged = _json_or_none(overlay.staged_provenance) or {}
    await view_version_repo.snapshot_if_dirty(
        session, row, actor=actor, message="Saved automatically before a draft's import went live")
    published = await view_version_repo.working_state_async(row)
    label = merge_labels(_json_or_none(overlay.fork_base_label) or {}, published.label,
                         _json_or_none(overlay.label) or {})
    # The overlay's columns are read here, on the event loop; decoding and merging the designs
    # (seconds for a large view) runs in a worker thread.
    parts = (overlay.fork_base_definition, overlay.fork_base_layout, overlay.fork_base_entity_scope,
             overlay.definition, overlay.reference_layout, overlay.entity_scope)

    def merge() -> tuple:
        base_rest, base_layout, base_scope, rest, layout, scope = parts
        base = join_definition(json.loads(base_rest or "{}"), json.loads(base_layout or "{}"), base_scope)
        proposed = join_definition(json.loads(rest), json.loads(layout or "{}"), scope)
        merged = merge_definitions(base, published.definition, proposed)
        return merged, json.dumps(config_from_definition(merged.definition, icon=label.get("icon")))

    merged, merged_config = await asyncio.to_thread(merge)
    # Members are data, not design: a file holds none, and the view keeps its own
    # until they are worked out again, in the layers it has now.
    from backend.app.db.repositories import view_members_repo, view_membership_repo
    from backend.app.services.live_views.ownership import carry_into_config

    config_dict = json.loads(merged_config)
    if carry_into_config(config_dict):
        await view_membership_repo.mark_pending(session, row, reason="design_replaced")
    await view_members_repo.rehome_view(session, row.id, config_dict)
    await tell_followers(session, row, config_dict)
    merged_config = json.dumps(config_dict)
    row.config = merged_config
    row.name = label.get("name") or row.name
    row.description = label.get("description") or None
    row.tags = json.dumps(label["tags"], ensure_ascii=False) if label.get("tags") else None
    row.view_type = label.get("viewType") or row.view_type
    if staged.get("portableId"):
        row.portable_id = staged["portableId"]
    if actor is not None:
        row.updated_by = actor
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.delete(overlay)
    await session.flush()

    stored = await view_version_repo.working_state_async(row)
    provenance = {**(staged.get("provenance") or {}), "branchId": branch_id,
                  "stagedBy": staged.get("actor"), "stagedAt": staged.get("stagedAt"), "publishedBy": actor}
    if merged.conflicts:
        provenance["conflicts"] = merged.conflicts[:200]
    # The view holds something other than the file: keep the file's design, so a later file
    # from the same lineage still finds it (view_version_repo.base_definition).
    origin_hash = None
    file_definition = staged.get("fileDefinition")
    file_hash = await asyncio.to_thread(content_hash, file_definition) if isinstance(file_definition, dict) else None
    if file_hash is not None and file_hash != stored.content_hash:
        provenance["originDefinition"] = file_definition
        origin_hash = file_hash
    version, _ = await view_version_repo.checkpoint(
        session, row, source="import", actor=staged.get("actor") or actor, force=True,
        origin_hash=origin_hash, message=f"{staged.get('message') or 'Imported'}, published from a draft",
        provenance=provenance, request_id=staged.get("requestId"),
    )
    await view_activity_repo.record_view_activity(
        session, view_id=row.id, workspace_id=row.workspace_id, action="imported", actor=actor,
        summary=f"{staged.get('summary') or 'Imported'} · published from a draft",
        changes={"action": staged.get("action"), "version": version.version, "branchId": branch_id},
    )


async def _go_live(
    session: AsyncSession, row: ViewORM, visibility: Optional[str], actor: Optional[str],
) -> None:
    """A view that existed only in its draft is now there for everyone its visibility reaches:
    private, or shared with its workspace as asked when it was imported."""
    from backend.app.db.repositories import view_activity_repo

    row.draft_branch_id = None
    target = visibility if visibility in ("private", "workspace") else "private"
    if target != row.visibility:
        previous, row.visibility = row.visibility, target
        await view_activity_repo.record_view_activity(
            session, view_id=row.id, workspace_id=row.workspace_id, action="visibility_changed",
            actor=actor, summary=f"Visibility {previous} → {target}, as its draft was published",
            changes={"visibility": {"from": previous, "to": target}},
        )
    await session.flush()


async def promote_overlays_for_branch(
    session: AsyncSession, branch_id: str, *, actor: Optional[str] = None
) -> int:
    """Promote every overlay on ``branch_id`` (usually one — branch-per-view)
    into its view's published base, and bring any view that existed only in
    that draft live. Returns the number of overlays promoted."""
    waiting = (await session.execute(
        select(ViewORM).where(ViewORM.draft_branch_id == branch_id)
    )).scalars().all()
    goes_live_as: Dict[str, Optional[str]] = {}
    for row in waiting:
        overlay = await get_overlay(session, row.id, branch_id)
        staged = _json_or_none(overlay.staged_provenance) if overlay is not None else None
        goes_live_as[row.id] = (staged or {}).get("visibility")

    result = await session.execute(
        select(ViewLayoutOverlayORM.view_id).where(
            ViewLayoutOverlayORM.branch_id == branch_id
        )
    )
    view_ids = [vid for (vid,) in result.all()]
    promoted = 0
    for view_id in view_ids:
        if await promote_overlay(session, view_id, branch_id, actor=actor):
            promoted += 1
    for row in waiting:
        await _go_live(session, row, goes_live_as.get(row.id), actor)
    return promoted


async def drop_overlays_for_branch(
    session: AsyncSession, branch_id: str
) -> int:
    """Discard every overlay on ``branch_id`` (draft abandon), and every view
    that existed only in that draft: it never went live, so nothing of it is
    kept. Returns the number of overlay rows deleted."""
    result = await session.execute(
        delete(ViewLayoutOverlayORM).where(
            ViewLayoutOverlayORM.branch_id == branch_id
        )
    )
    await session.execute(delete(ViewORM).where(ViewORM.draft_branch_id == branch_id))
    return result.rowcount or 0


async def delete_view(
    session: AsyncSession, view_id: str
) -> bool:
    """Soft-delete a view by setting deleted_at timestamp."""
    now = datetime.now(timezone.utc).isoformat()
    result = await session.execute(
        update(ViewORM)
        .where(ViewORM.id == view_id, ViewORM.deleted_at.is_(None))
        .values(deleted_at=now)
    )
    return result.rowcount > 0


async def restore_view(
    session: AsyncSession, view_id: str
) -> bool:
    """Restore a soft-deleted view by clearing deleted_at."""
    result = await session.execute(
        update(ViewORM)
        .where(ViewORM.id == view_id, ViewORM.deleted_at.isnot(None))
        .values(deleted_at=None)
    )
    return result.rowcount > 0


async def permanently_delete_view(
    session: AsyncSession, view_id: str
) -> bool:
    """Hard-delete a view from the database (irreversible)."""
    result = await session.execute(
        delete(ViewORM).where(ViewORM.id == view_id)
    )
    return result.rowcount > 0


# ------------------------------------------------------------------ #
# Filtered listing & discovery                                         #
# ------------------------------------------------------------------ #

def _contains(text: str) -> str:
    """A LIKE pattern matching ``text`` anywhere, with its own ``%``, ``_`` and ``\\``
    escaped (pair it with ``escape="\\"``) so they match literally."""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _last_change_expr():
    """When the view last changed: the later of its last settings/layout edit
    and its last data publish.

    ``updated_at`` alone misses data changes — the publish fan-out
    (``versioning._touch_views_data_updated``) stamps ``data_updated_at`` and
    deliberately leaves ``updated_at`` alone, so a publish never poses as a
    settings edit. "Changed since" means either. ISO-8601 UTC strings compare
    in time order; a NULL ``data_updated_at`` (never published) fails the
    comparison and falls to the ELSE.
    """
    return case(
        (ViewORM.data_updated_at > ViewORM.updated_at, ViewORM.data_updated_at),
        else_=ViewORM.updated_at,
    )


def _contributor_clause(ids: List[str], role: Optional[str]):
    """Views these people created, last edited, or last published data behind.

    With no role, created OR last edited. Published is opt-in: a publish
    stamps ``data_updated_by`` on every view of its data source, so counting
    it by default would list hundreds of views a person never opened.
    """
    if role == "created":
        return ViewORM.created_by.in_(ids)
    if role == "edited":
        return ViewORM.updated_by.in_(ids)
    if role == "published":
        return ViewORM.data_updated_by.in_(ids)
    return or_(ViewORM.created_by.in_(ids), ViewORM.updated_by.in_(ids))


def source_kind_clause(kind: str, sets: "SourceKindSets"):
    """The Explorer's Versioned / External filter, as SQL.

    A view is classified by its own data source, else (NULL) by its
    workspace's default — the rule ``SourceKindSets.kind_for`` annotates the
    returned rows with. Both kinds are written out because NOT-ing the
    versioned predicate is NULL, not true, for a NULL-source view, which would
    silently drop every such view from External. A NULL-source view in a
    workspace with no default source reads no data and is in neither.
    """
    if kind == "versioned":
        return or_(
            ViewORM.data_source_id.in_(sets.versioned_ds),
            and_(
                ViewORM.data_source_id.is_(None),
                ViewORM.workspace_id.in_(sets.versioned_ws),
            ),
        )
    return or_(
        and_(
            ViewORM.data_source_id.isnot(None),
            ViewORM.data_source_id.not_in(sets.versioned_ds),
        ),
        and_(
            ViewORM.data_source_id.is_(None),
            ViewORM.workspace_id.in_(sets.external_ws),
        ),
    )


def _apply_view_filters(
    query,
    *,
    visibility: Optional[str] = None,
    visibility_in: Optional[List[str]] = None,
    workspace_id: Optional[str] = None,
    workspace_ids: Optional[List[str]] = None,
    context_model_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    view_type: Optional[str] = None,
    view_types: Optional[List[str]] = None,
    created_by: Optional[str] = None,
    created_by_in: Optional[List[str]] = None,
    created_by_not: Optional[str] = None,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    updated_after: Optional[str] = None,
    updated_before: Optional[str] = None,
    contributor_in: Optional[List[str]] = None,
    contributor_role: Optional[str] = None,
    source_kind: Optional[str] = None,
    source_kind_sets: Optional["SourceKindSets"] = None,
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    ids_in: Optional[List[str]] = None,
    user_id: Optional[str] = None,
    favourited_only: bool = False,
    include_deleted: bool = False,
    deleted_only: bool = False,
    attention_only: bool = False,
    readable=None,
):
    """Apply all filter predicates to a query on ``ViewORM``.

    Shared by the listing, counting, and discovery code paths so the same
    set of predicates produces the same result set whether the caller is
    fetching rows or the total count.

    ``readable`` is the caller's access clause (from
    ``view_access.readable_views_clause``). Applying it here — inside the
    same WHERE as every other predicate — is what makes ``total`` /
    ``has_more`` honest; the old Python post-filter over-reported both.
    ``ids_in`` / ``created_by_not`` exist for the shared-with-me
    category (explicit grants, excluding the caller's own views).
    ``source_kind`` needs ``source_kind_sets`` (``view_source_kinds.load_sets``).
    Time bounds are UTC ISO strings: ``*_after`` inclusive, ``*_before`` exclusive.
    """
    if readable is not None:
        query = query.where(readable)

    # Soft-delete filtering. A view waiting in a draft to go live is in no live list.
    if deleted_only:
        query = query.where(ViewORM.deleted_at.isnot(None))
    elif not include_deleted:
        query = query.where(view_is_live())
    else:
        query = query.where(ViewORM.draft_branch_id.is_(None))

    if ids_in is not None:
        query = query.where(ViewORM.id.in_(ids_in))
    if created_by_not:
        query = query.where(
            or_(ViewORM.created_by.is_(None), ViewORM.created_by != created_by_not)
        )

    # When favourited_only is True, inner-join on the favourites table so only
    # views the requesting user has bookmarked are returned.
    if favourited_only and user_id:
        query = query.join(
            ViewFavouriteORM,
            (ViewFavouriteORM.view_id == ViewORM.id) &
            (ViewFavouriteORM.user_id == user_id),
        )

    # Multi-workspace takes precedence over single-workspace filter.
    if workspace_ids:
        query = query.where(ViewORM.workspace_id.in_(workspace_ids))
    elif workspace_id:
        query = query.where(ViewORM.workspace_id == workspace_id)

    if context_model_id:
        query = query.where(ViewORM.context_model_id == context_model_id)
    if data_source_id:
        query = query.where(ViewORM.data_source_id == data_source_id)

    # View type: multi wins over single.
    if view_types:
        query = query.where(ViewORM.view_type.in_(view_types))
    elif view_type:
        query = query.where(ViewORM.view_type == view_type)

    # Creator: multi wins over single.
    if created_by_in:
        query = query.where(ViewORM.created_by.in_(created_by_in))
    elif created_by:
        query = query.where(ViewORM.created_by == created_by)

    if contributor_in:
        query = query.where(_contributor_clause(contributor_in, contributor_role))

    if created_after:
        query = query.where(ViewORM.created_at >= created_after)
    if created_before:
        query = query.where(ViewORM.created_at < created_before)
    if updated_after:
        query = query.where(_last_change_expr() >= updated_after)
    if updated_before:
        query = query.where(_last_change_expr() < updated_before)

    if source_kind:
        query = query.where(source_kind_clause(source_kind, source_kind_sets))

    # Visibility filters — visibility_in (set match) wins over single visibility.
    if visibility_in:
        query = query.where(ViewORM.visibility.in_(visibility_in))
    elif visibility:
        query = query.where(ViewORM.visibility == visibility)

    # Tag filter — OR semantics across the supplied tags. Tags are stored
    # as a JSON-encoded string (e.g. ``["finance","pii"]``), so we look
    # for the token as JSON writes it. In both spellings: tags written before
    # 2026-11 escaped every non-ASCII character (``"Caf\u00e9"``), newer ones
    # store it as typed (``"Café"``), and the filter must find either.
    if tags:
        tokens = {json.dumps(t, ensure_ascii=a) for t in tags for a in (False, True)}
        query = query.where(
            or_(*[ViewORM.tags.ilike(_contains(token), escape="\\") for token in sorted(tokens)])
        )

    # Search / attention both need workspace + data source joins; do them once.
    needs_ws_join = bool(search) or attention_only
    needs_ds_join = bool(search) or attention_only
    if needs_ws_join:
        query = query.outerjoin(
            WorkspaceORM, ViewORM.workspace_id == WorkspaceORM.id,
        )
    if needs_ds_join:
        query = query.outerjoin(
            WorkspaceDataSourceORM,
            ViewORM.data_source_id == WorkspaceDataSourceORM.id,
        )

    if search:
        terms = search.split()
        if terms:
            # A term is text: its % and _ match themselves, not "anything".
            query = query.where(and_(*[
                (
                    ViewORM.name.ilike(_contains(term), escape="\\")
                    | ViewORM.description.ilike(_contains(term), escape="\\")
                    | WorkspaceORM.name.ilike(_contains(term), escape="\\")
                    | WorkspaceDataSourceORM.label.ilike(_contains(term), escape="\\")
                    | ViewORM.created_by.ilike(_contains(term), escape="\\")
                    | ViewORM.tags.ilike(_contains(term), escape="\\")
                )
                for term in terms
            ]))

    if attention_only:
        # Views "needing attention" are those that are stale (nothing changed,
        # settings or data, in 90 days), or reference an inactive/missing
        # workspace or data source.
        # Mirrors the useViewHealth hook on the frontend so server-side
        # filtering returns the same set the client would compute locally.
        stale_cutoff = (
            datetime.now(timezone.utc) - timedelta(days=90)
        ).isoformat()
        ds_id_set_but_missing = (
            ViewORM.data_source_id.isnot(None)
            & WorkspaceDataSourceORM.id.is_(None)
        )
        query = query.where(
            or_(
                _last_change_expr() < stale_cutoff,  # nothing changed, settings or data
                WorkspaceORM.id.is_(None),          # workspace missing (broken)
                WorkspaceORM.is_active.is_(False),  # workspace inactive (warning)
                WorkspaceDataSourceORM.is_active.is_(False),
                ds_id_set_but_missing,
            )
        )

    return query


class RecentViewEntry(BaseModel):
    """One entry in the user's "Continue where you left off" strip. Shaped to
    match the frontend's existing RecentViewEntry so consumers are unchanged."""
    viewId: str
    viewName: str
    viewType: str
    icon: Optional[str] = None
    workspaceId: Optional[str] = None
    workspaceName: Optional[str] = None
    dataSourceId: Optional[str] = None
    dataSourceName: Optional[str] = None
    visitedAt: str


async def record_view_visit(
    session: AsyncSession, view_id: str, user_id: Optional[str],
) -> None:
    """Upsert this user's visit to a view. Anonymous is a no-op — recents are
    per-identity by definition (the localStorage version leaked one user's
    recents to the next user on a shared browser)."""
    if not user_id or user_id == "anonymous":
        return
    now = datetime.now(timezone.utc).isoformat()
    existing = (await session.execute(
        select(ViewVisitORM).where(
            ViewVisitORM.view_id == view_id,
            ViewVisitORM.user_id == user_id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        existing.visited_at = now
    else:
        session.add(ViewVisitORM(view_id=view_id, user_id=user_id, visited_at=now))

    # The row above is an UPSERT — it holds this user's LAST visit, not a
    # history, so it can answer "who has seen this view" but never "how many
    # opens on Tuesday". Analytics needs the second question, so the open is
    # ALSO appended to the immutable product-event log.
    #
    # ``subject_id`` is the same view id as the payload's, denormalised into a
    # real column so analytics can GROUP BY it instead of decoding every event
    # in the window. Free here — the id is already in hand — and it is what
    # keeps this table's read cost flat as the write rate grows.
    #
    # The workspace is deliberately still absent. It is knowable from the view,
    # and resolving it would put a second SELECT on a path that runs every time
    # anyone opens anything; analytics groups by view first, which collapses
    # millions of events into one row per opened view, and maps only those to
    # their workspaces.
    session.add(ProductEventORM(
        event_type="view.opened",
        actor_id=user_id,
        subject_id=view_id,
        payload=json.dumps({"viewId": view_id}),
    ))
    await session.flush()
    # Opening a view is the commonest thing anyone does here — it is what
    # "last activity" in Admin → Users mostly records. Gated, so almost
    # every open costs nothing more.
    from backend.app.db.repositories import user_repo
    await user_repo.note_activity(session, user_id)


async def list_recent_views(
    session: AsyncSession, user_id: Optional[str], *, limit: int = 5,
    readable=None,
) -> List[RecentViewEntry]:
    """This user's most recently visited views, newest first.

    Joined against the LIVE view rows, so names/scope are never a stale snapshot
    and a deleted view drops out on its own (no more clicking a recent entry into
    a 404). ``readable`` additionally drops views the user has since
    lost access to — a visit row is history, not a capability.
    """
    if not user_id or user_id == "anonymous":
        return []
    query = (
        select(ViewORM, ViewVisitORM.visited_at)
        .join(ViewVisitORM, ViewVisitORM.view_id == ViewORM.id)
        .where(
            ViewVisitORM.user_id == user_id,
            view_is_live(),
        )
        .order_by(ViewVisitORM.visited_at.desc())
        .limit(limit)
    )
    if readable is not None:
        query = query.where(readable)
    rows = (await session.execute(query)).all()

    out: List[RecentViewEntry] = []
    for view_row, visited_at in rows:
        enriched = await _to_enriched_response(session, view_row, user_id)
        try:
            cfg = json.loads(view_row.config or "{}")
        except (TypeError, ValueError):
            cfg = {}
        out.append(RecentViewEntry(
            viewId=enriched.id,
            viewName=enriched.name,
            viewType=enriched.view_type,
            icon=cfg.get("icon"),
            workspaceId=enriched.workspace_id,
            workspaceName=enriched.workspace_name,
            dataSourceId=enriched.data_source_id,
            dataSourceName=enriched.data_source_name,
            visitedAt=visited_at,
        ))
    return out


#: The Type column's labels (frontend ``lib/domainLabels.ts`` VIEW_TYPE_LABELS), so a
#: Type sort orders by what the reader sees — ``reference`` reads "Context View".
_VIEW_TYPE_SORT_LABELS = {
    "graph": "Graph", "hierarchy": "Hierarchy", "reference": "Context View",
    "layered-lineage": "Layered Lineage", "tree": "Tree", "list": "List", "grid": "Grid",
    "timeline": "Timeline",
}

#: "Most opened" counts opens over the same trailing window the cards' usage shows.
_OPENS_WINDOW_DAYS = 30


#: "Most opened" ranks this many of the most-opened views; the rest tie behind them
#: and fall back to the last change, so the ORDER BY stays a bounded CASE.
_OPENS_RANK_CAP = 1000


def _view_order_by(sort: Optional[str], rank: Optional[Dict[str, int]] = None):
    """Map an Explorer sort key to an ORDER BY clause list. Every sort runs here,
    so it orders the WHOLE result, not just the loaded page, and every one ends on
    the id: offset paging over tied keys (one publish stamps the same time on every
    view of a source; names repeat) would otherwise skip or repeat rows.
    ``data_updated_at`` is TEXT ISO timestamps, so NULLs (views whose data was
    never published) are pushed last via a coalesce sentinel.

    ``rank`` carries what another domain knows (a creator's display name, a view's
    opens) as plain ids → positions, read beforehand by :func:`_sort_rank` — never
    JOINed (``backend/app/db/DOMAIN_OWNERSHIP.md``)."""
    return [*_view_order_keys(sort, rank or {}), ViewORM.id.asc()]


async def _sort_rank(session: AsyncSession, sort: Optional[str], filter_kwargs: dict) -> Dict[str, int]:
    """The positions an owner or most-opened sort orders by, read from the owning
    domain by id: creators' names through :func:`resolve_user_ids` (identity), opens
    through the analytics event log. Only the creators of THIS result are named."""
    if sort in ("owner-az", "owner-za"):
        creators = (await session.execute(
            _apply_view_filters(select(ViewORM.created_by).distinct(), **filter_kwargs)
        )).scalars().all()
        names = await resolve_user_ids(session, set(creators))
        named = sorted(names, key=lambda uid: ((names[uid][0] or "").lower(), uid),
                       reverse=sort == "owner-za")
        return {uid: i for i, uid in enumerate(named)}
    if sort == "most-opened":
        from backend.app.db.repositories.analytics_repo import view_open_counts
        since = (datetime.now(timezone.utc) - timedelta(days=_OPENS_WINDOW_DAYS)).isoformat()
        return await view_open_counts(session, since=since, limit=_OPENS_RANK_CAP)
    return {}


def _favourite_count():
    # Correlated so popularity sorts across the whole result without reshaping the joins.
    return (
        select(func.count(ViewFavouriteORM.id))
        .where(ViewFavouriteORM.view_id == ViewORM.id)
        .scalar_subquery()
    )


def _view_order_keys(sort: Optional[str], rank: Dict[str, int]):
    if sort == "newest":
        return [ViewORM.created_at.desc()]
    if sort == "oldest":
        return [ViewORM.created_at.asc()]
    if sort == "updated":
        return [ViewORM.updated_at.desc()]
    if sort == "updated-asc":
        return [ViewORM.updated_at.asc()]
    if sort == "data-newest":
        # Most recently changed DATA first; never-published (NULL) → "" sorts last.
        return [func.coalesce(ViewORM.data_updated_at, "").desc(), ViewORM.updated_at.desc()]
    if sort == "data-oldest":
        # Oldest changed data first; never-published (NULL) → "9999" sorts last.
        return [func.coalesce(ViewORM.data_updated_at, "9999").asc(), ViewORM.updated_at.asc()]
    if sort == "recently-modified":
        # The later of data-publish and settings-edit — the intuitive default.
        return [_last_change_expr().desc()]
    if sort == "modified-asc":
        # The same "last changed" the list's Updated column shows, oldest first.
        return [_last_change_expr().asc()]
    # A–Z as people read it: "apple" sits beside "Apple", not after "Zebra".
    by_name = func.lower(ViewORM.name)
    if sort == "az":
        return [by_name.asc()]
    if sort == "za":
        return [by_name.desc()]
    # Equal likes fall back to the last change, settings or data, as the list's
    # Updated column shows it.
    if sort == "popular":
        return [_favourite_count().desc(), _last_change_expr().desc()]
    if sort == "likes-asc":
        return [_favourite_count().asc(), _last_change_expr().desc()]
    if sort in ("type-az", "type-za"):
        label = case(_VIEW_TYPE_SORT_LABELS, value=ViewORM.view_type, else_=ViewORM.view_type)
        return [label.asc() if sort == "type-az" else label.desc(), by_name.asc()]
    if sort in ("owner-az", "owner-za"):
        # Positions in name order (reversed for Z→A); a creator with no account sorts last.
        if not rank:
            return [by_name.asc()]
        return [case(rank, value=ViewORM.created_by, else_=len(rank)).asc(), by_name.asc()]
    if sort == "most-opened":
        if not rank:
            return [_last_change_expr().desc()]
        return [case(rank, value=ViewORM.id, else_=0).desc(), _last_change_expr().desc()]
    # Default (no sort, or one this list doesn't know): recently modified, as the
    # endpoint documents — the later of a settings edit and a data publish.
    return [_last_change_expr().desc()]


async def count_views(session: AsyncSession, **filters) -> int:
    """How many views ``_apply_view_filters(**filters)`` leaves: the list's
    ``total`` (``list_views_filtered`` counts through here), without the rows."""
    # COUNT(DISTINCT id): DISTINCT guards against the joins multiplying rows
    # when a view has many favourites (for favourited_only queries) or other cases.
    query = _apply_view_filters(select(func.count(func.distinct(ViewORM.id))), **filters)
    return (await session.execute(query)).scalar_one() or 0


# A histogram bucket is its timestamp's own text cut short: to the hour
# ("YYYY-MM-DDTHH") or to ten minutes ("YYYY-MM-DDTHH:M"). Every writer of these
# columns stores datetime.now(timezone.utc).isoformat(), so the cut IS the UTC
# bucket on any database, with no date arithmetic to port; the client folds the
# buckets into its reader's own days.
_HISTOGRAM_CUT = {"hour": 13, "10min": 15}


def _histogram_statement(*, field: str, grain: str, after: str, before: str, **filters):
    """The histogram's single statement — apart from its execution so its SQL can
    be checked against the Postgres dialect."""
    ts = ViewORM.created_at if field == "created" else _last_change_expr()
    # Literal positions keep the SELECT, GROUP BY and ORDER BY text identical,
    # which Postgres needs to accept the grouping, whatever the driver binds.
    label = func.substr(ts, literal_column("1"), literal_column(str(_HISTOGRAM_CUT[grain])))
    return _apply_view_filters(
        select(label, func.count(func.distinct(ViewORM.id)))
        .where(ts >= after, ts < before)
        .group_by(label)
        .order_by(label),
        **filters,
    )


async def view_histogram(
    session: AsyncSession, *, field: str, grain: str, after: str, before: str, **filters,
) -> List[tuple]:
    """``[(label, n)]``, ascending and sparse: how many views were created
    (``field="created"``) or last changed (``"updated"``, the later of a settings
    edit and a data publish) in each bucket of ``[after, before)``, among exactly
    the views ``count_views(**filters)`` counts. Bounds are UTC ISO strings."""
    rows = await session.execute(_histogram_statement(
        field=field, grain=grain, after=after, before=before, **filters,
    ))
    return [(t, n) for t, n in rows.all()]


async def list_views_filtered(
    session: AsyncSession,
    *,
    sort: Optional[str] = None,
    visibility: Optional[str] = None,
    visibility_in: Optional[List[str]] = None,
    workspace_id: Optional[str] = None,
    workspace_ids: Optional[List[str]] = None,
    context_model_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    view_type: Optional[str] = None,
    view_types: Optional[List[str]] = None,
    created_by: Optional[str] = None,
    created_by_in: Optional[List[str]] = None,
    created_by_not: Optional[str] = None,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    updated_after: Optional[str] = None,
    updated_before: Optional[str] = None,
    contributor_in: Optional[List[str]] = None,
    contributor_role: Optional[str] = None,
    source_kind: Optional[str] = None,
    source_kind_sets: Optional["SourceKindSets"] = None,
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    ids_in: Optional[List[str]] = None,
    limit: int = 50,
    offset: int = 0,
    user_id: Optional[str] = None,
    favourited_only: bool = False,
    include_deleted: bool = False,
    deleted_only: bool = False,
    attention_only: bool = False,
    readable=None,
) -> ViewListResponse:
    """Return a paginated envelope of views matching the given filters.

    The envelope includes an authoritative ``total`` count so the Explorer
    can render "20 of 1,432" style stats without guessing from page size.
    ``has_more`` and ``next_offset`` are computed once on the server so
    callers never have to reason about "was this the last page?".
    """
    # --- shared filter application (select + count share this) -----------
    filter_kwargs = dict(
        visibility=visibility,
        visibility_in=visibility_in,
        workspace_id=workspace_id,
        workspace_ids=workspace_ids,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        view_type=view_type,
        view_types=view_types,
        created_by=created_by,
        created_by_in=created_by_in,
        created_by_not=created_by_not,
        created_after=created_after,
        created_before=created_before,
        updated_after=updated_after,
        updated_before=updated_before,
        contributor_in=contributor_in,
        contributor_role=contributor_role,
        source_kind=source_kind,
        source_kind_sets=source_kind_sets,
        search=search,
        tags=tags,
        ids_in=ids_in,
        user_id=user_id,
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
        readable=readable,
    )

    select_query = _apply_view_filters(select(ViewORM), **filter_kwargs)
    select_query = (
        select_query
        .order_by(*_view_order_by(sort, await _sort_rank(session, sort, filter_kwargs)))
        .limit(limit)
        .offset(offset)
    )

    result = await session.execute(select_query)
    rows = result.scalars().unique().all()

    total = await count_views(session, **filter_kwargs)

    if _batch_enrich_enabled():
        responses = await _batch_enrich_rows(session, rows, user_id)
    else:
        responses = [await _to_enriched_response(session, row, user_id) for row in rows]

    has_more = (offset + len(responses)) < total
    next_offset = offset + len(responses) if has_more else None
    return ViewListResponse(
        items=responses,
        total=total,
        has_more=has_more,
        next_offset=next_offset,
    )


#: Every facet ``get_view_facets`` can compute, by its name in the response.
FACET_FIELDS = (
    "tags", "viewTypes", "creators", "contributors",
    "workspaces", "dataSources", "visibilities", "sourceKinds",
)

# The filters each facet leaves out. A facet counted under its own selection
# would read 0 for every option but the chosen one, so the menu could no longer
# say what switching to another option leaves. Creators and contributors share
# one query; ``created_by`` stays in it, because it is My Views — a scope, not a
# person picked from that menu.
_OWN_FILTERS = {
    "tags": ("tags",),
    "viewTypes": ("view_type", "view_types"),
    "workspaces": ("workspace_id", "workspace_ids"),
    "dataSources": ("data_source_id",),
    "visibilities": ("visibility", "visibility_in"),
    "people": ("contributor_in", "contributor_role", "created_by_in"),
    "sourceKinds": ("source_kind",),
}

# Tags and people run to thousands on a large catalog, and a menu shows the top
# of them. A value the request has selected is kept past the cap: a selection
# must never vanish from its own menu.
_FACET_CAP = 500


def _person(user_id: Optional[str]) -> Optional[str]:
    """NULL, empty and the legacy "anonymous" sentinel are nobody."""
    return user_id if user_id and user_id != "anonymous" else None


def _capped(rows: list, key, is_selected) -> list:
    """``rows`` ranked by ``key``: the first ``_FACET_CAP``, then any selected one
    past them (still in rank order)."""
    ranked = sorted(rows, key=key)
    return ranked[:_FACET_CAP] + [r for r in ranked[_FACET_CAP:] if is_selected(r)]


async def _workspace_and_source_names(
    session: AsyncSession, ws_ids, ds_ids,
) -> tuple[Dict[str, str], Dict[str, tuple]]:
    """Names for the workspace and data-source facets, in one statement:
    ``({ws_id: name}, {ds_id: (label, ws_id, ws_name)})``.

    One statement because both tables are the workspace domain's, so joining
    them is not the cross-domain kind (DOMAIN_OWNERSHIP.md); the views are only
    ever matched to either by id. A source's workspace comes from the source
    itself, not from the views that name it.
    """
    if not ws_ids and not ds_ids:
        return {}, {}
    rows = (await session.execute(
        select(
            WorkspaceORM.id, WorkspaceORM.name,
            WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label,
        )
        .select_from(WorkspaceORM)
        .outerjoin(
            WorkspaceDataSourceORM,
            and_(
                WorkspaceDataSourceORM.workspace_id == WorkspaceORM.id,
                WorkspaceDataSourceORM.id.in_(list(ds_ids)),
            ),
        )
        .where(or_(
            WorkspaceORM.id.in_(list(ws_ids)),
            WorkspaceDataSourceORM.id.isnot(None),
        ))
    )).all()
    ws_names: Dict[str, str] = {}
    sources: Dict[str, tuple] = {}
    for ws_id, ws_name, ds_id, ds_label in rows:
        ws_names[ws_id] = ws_name
        if ds_id:
            sources[ds_id] = (ds_label, ws_id, ws_name)
    return ws_names, sources


async def get_view_facets(
    session: AsyncSession,
    *,
    fields: Sequence[str] = FACET_FIELDS,
    **filters,
) -> ViewFacetsResponse:
    """The Explorer's filter menus: each facet's values, and how many views each
    would leave.

    ``filters`` are ``_apply_view_filters`` kwargs — what the list applies,
    ``readable`` and the category's ``ids_in`` / ``created_by_not`` included.
    Every facet is counted through ``_apply_view_filters`` with only its own
    filter left out (``_OWN_FILTERS``), so an option's count is the list's
    ``total`` were that option chosen instead — and nothing is ever counted
    beyond the caller's read reach (``readable``) or outside ``view_is_live``:
    an unscoped facet leaks private views' tags and people, which is how the
    endpoint first shipped. ``source_kind_sets`` must accompany ``source_kind``;
    without sets ``sourceKinds`` is None and a data source's ``kind`` unknown.

    One statement per facet plus one user and one name lookup, whatever the
    catalog's size: nine at most. Facets not in ``fields`` are left empty.
    """
    def counted(query, facet: str):
        own = _OWN_FILTERS[facet]
        return _apply_view_filters(
            query, **{k: v for k, v in filters.items() if k not in own},
        )

    sets = filters.get("source_kind_sets")
    n_views = func.count(func.distinct(ViewORM.id))
    response = ViewFacetsResponse(tags=[], view_types=[], creators=[])

    if "tags" in fields:
        # Parsed in Python since the column is a JSON string. Counted case-blind,
        # as the tag filter matches (``PII`` finds ``pii``), once per view, under the
        # first spelling met (a chosen tag keeps the reader's own).
        tag_counts: Counter = Counter()
        label: Dict[str, str] = {}
        for t in filters.get("tags") or ():
            label.setdefault(t.lower(), t)
            tag_counts[t.lower()] += 0
        tag_rows = await session.execute(counted(
            select(ViewORM.tags).where(ViewORM.tags.isnot(None)), "tags",
        ))
        for (tags_json,) in tag_rows.all():
            try:
                parsed = json.loads(tags_json) if tags_json else []
            except (ValueError, TypeError):
                continue
            if not isinstance(parsed, list):
                continue
            for key in {t.lower() for t in parsed if isinstance(t, str) and t}:
                tag_counts[key] += 1
            for t in parsed:
                if isinstance(t, str) and t:
                    label.setdefault(t.lower(), t)
        selected_tags = {t.lower() for t in filters.get("tags") or ()}
        response.tags = [
            ViewFacetValue(value=label[k], count=c)
            for k, c in _capped(
                list(tag_counts.items()), lambda x: (-x[1], x[0]),
                lambda x: x[0] in selected_tags,
            )
        ]

    # A GROUP BY each; an unset value reads as the view itself shows it (_to_response).
    for facet, column, unset, attr in (
        ("viewTypes", ViewORM.view_type, "graph", "view_types"),
        ("visibilities", ViewORM.visibility, "private", "visibilities"),
    ):
        if facet in fields:
            value_rows = await session.execute(counted(
                select(column, n_views).group_by(column), facet,
            ))
            setattr(response, attr, sorted(
                (ViewFacetValue(value=v or unset, count=n) for v, n in value_rows.all()),
                key=lambda f: (-f.count, f.value),
            ))

    if "creators" in fields or "contributors" in fields:
        # Creator, last editor and last data publisher from ONE grouped scan
        # whose rows are (creator, editor, publisher) combinations.
        people_rows = (await session.execute(counted(
            select(
                ViewORM.created_by, ViewORM.updated_by, ViewORM.data_updated_by, n_views,
            ).group_by(ViewORM.created_by, ViewORM.updated_by, ViewORM.data_updated_by),
            "people",
        ))).all()
        # The creator facet lists every stored creator, the sentinel included.
        by_creator: Counter = Counter()
        created, edited, published, either = Counter(), Counter(), Counter(), Counter()
        for creator, editor, publisher, n in people_rows:
            if creator is not None:
                by_creator[creator] += n
            creator, editor, publisher = map(_person, (creator, editor, publisher))
            if creator:
                created[creator] += n
            if editor:
                edited[editor] += n
            if publisher:
                published[publisher] += n
            # A set: whoever created AND last edited a view counts it once.
            for person in {creator, editor} - {None}:
                either[person] += n

        # Only people in the views counted are looked up. One selected but in none
        # of them is listed as sent — resolving any id a caller names would make
        # this a directory of everyone, readable views or not.
        people = set(either) | set(published)
        selected_people = set(filter(None, map(_person, filters.get("contributor_in") or ())))
        identities = await _resolve_user_identities(
            session,
            (set(by_creator) if "creators" in fields else set())
            | (people if "contributors" in fields else set()),
        )
        if "creators" in fields:
            creator_facets = []
            for uid, n in by_creator.items():
                # Unresolvable (record gone, or the legacy sentinel): the raw id.
                name, email, _avatar = identities.get(uid, (uid, None, None))
                creator_facets.append(ViewFacetCreator(
                    user_id=uid, display_name=name, email=email, count=n,
                ))
            response.creators = sorted(
                creator_facets, key=lambda c: (-c.count, c.display_name.lower(), c.user_id),
            )
        if "contributors" in fields:
            contributor_facets = []
            for uid in people | selected_people:
                name, email, avatar_id = identities.get(uid, (uid, None, None))
                contributor_facets.append(ViewFacetContributor(
                    user_id=uid,
                    display_name=name,
                    email=email,
                    avatar_id=avatar_id,
                    count=either[uid],
                    created_count=created[uid],
                    edited_count=edited[uid],
                    published_count=published[uid],
                ))
            response.contributors = _capped(
                contributor_facets,
                lambda c: (-c.count, -c.published_count, c.display_name.lower(), c.user_id),
                lambda c: c.user_id in selected_people,
            )

    ws_counts: Dict[str, int] = {}
    if "workspaces" in fields:
        ws_counts = dict((await session.execute(counted(
            select(ViewORM.workspace_id, n_views).group_by(ViewORM.workspace_id),
            "workspaces",
        ))).all())
    ds_counts: Dict[str, int] = {}
    if "dataSources" in fields:
        # Only views that name their source: what ``dataSourceId`` matches.
        ds_counts = dict((await session.execute(counted(
            select(ViewORM.data_source_id, n_views)
            .where(ViewORM.data_source_id.isnot(None))
            .group_by(ViewORM.data_source_id),
            "dataSources",
        ))).all())
    if ws_counts or ds_counts:
        ws_names, sources = await _workspace_and_source_names(session, ws_counts, ds_counts)
        response.workspaces = sorted(
            (
                ViewFacetWorkspace(id=ws_id, name=ws_names.get(ws_id) or ws_id, count=n)
                for ws_id, n in ws_counts.items()
            ),
            key=lambda w: (-w.count, w.name.lower(), w.id),
        )
        data_source_facets = []
        for ds_id, n in ds_counts.items():
            label, ws_id, ws_name = sources.get(ds_id, (None, None, None))
            data_source_facets.append(ViewFacetDataSource(
                id=ds_id,
                name=label or ds_id,
                workspace_id=ws_id,
                workspace_name=ws_name,
                kind=sets.kind_for(ds_id, ws_id) if sets is not None else None,
                count=n,
            ))
        response.data_sources = sorted(
            data_source_facets, key=lambda d: (-d.count, d.name.lower(), d.id),
        )

    if "sourceKinds" in fields and sets is not None:
        versioned, external = (await session.execute(counted(
            select(
                func.sum(case((source_kind_clause("versioned", sets), 1), else_=0)),
                func.sum(case((source_kind_clause("external", sets), 1), else_=0)),
            ),
            "sourceKinds",
        ))).one()
        response.source_kinds = ViewFacetSourceKinds(
            versioned=versioned or 0, external=external or 0,
        )

    return response


async def get_view_stats(
    session: AsyncSession,
    *,
    visibility: Optional[str] = None,
    visibility_in: Optional[List[str]] = None,
    workspace_id: Optional[str] = None,
    workspace_ids: Optional[List[str]] = None,
    context_model_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    view_type: Optional[str] = None,
    view_types: Optional[List[str]] = None,
    created_by: Optional[str] = None,
    created_by_in: Optional[List[str]] = None,
    created_by_not: Optional[str] = None,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    updated_after: Optional[str] = None,
    updated_before: Optional[str] = None,
    contributor_in: Optional[List[str]] = None,
    contributor_role: Optional[str] = None,
    source_kind: Optional[str] = None,
    source_kind_sets: Optional["SourceKindSets"] = None,
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    ids_in: Optional[List[str]] = None,
    user_id: Optional[str] = None,
    favourited_only: bool = False,
    include_deleted: bool = False,
    deleted_only: bool = False,
    attention_only: bool = False,
    readable=None,
    recent_since: Optional[str] = None,
) -> ViewCatalogStats:
    """Compute the Explorer stats bar numbers for a given filter set.

    Accepts the same filter params as ``list_views_filtered`` and
    reuses ``_apply_view_filters`` so the stats always describe the
    exact same population the list endpoint would return. Four cheap
    aggregate queries — no row materialisation.
    """
    filter_kwargs = dict(
        visibility=visibility,
        visibility_in=visibility_in,
        workspace_id=workspace_id,
        workspace_ids=workspace_ids,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        view_type=view_type,
        view_types=view_types,
        created_by=created_by,
        created_by_in=created_by_in,
        created_by_not=created_by_not,
        created_after=created_after,
        created_before=created_before,
        updated_after=updated_after,
        updated_before=updated_before,
        contributor_in=contributor_in,
        contributor_role=contributor_role,
        source_kind=source_kind,
        source_kind_sets=source_kind_sets,
        search=search,
        tags=tags,
        ids_in=ids_in,
        user_id=user_id,
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        # Respect an incoming ``attention_only`` on the base queries so
        # total/recent/last-activity all describe the same population.
        # The needs_attention query below always overlays True — when
        # both resolve to True the numbers line up as expected.
        attention_only=attention_only,
        readable=readable,
    )

    # Total — matches list ``total`` for identical filters.
    total_query = _apply_view_filters(
        select(func.count(func.distinct(ViewORM.id))),
        **filter_kwargs,
    )
    total_result = await session.execute(total_query)
    total = total_result.scalar_one() or 0

    # Recently added — same filters plus a created_after overlay. From the
    # caller's own cutoff when it sends one: the Explorer's Recent list holds its
    # "seven days ago" from when the page opened, and the tile must count that
    # list, not a window that slides on with every refetch.
    since = recent_since or (
        datetime.now(timezone.utc) - timedelta(days=7)
    ).isoformat()
    # Caller may already have a stricter created_after; use the later
    # of the two so we never broaden what they asked for.
    effective_created_after = (
        max(created_after, since)
        if created_after
        else since
    )
    recent_kwargs = {**filter_kwargs, "created_after": effective_created_after}
    recent_query = _apply_view_filters(
        select(func.count(func.distinct(ViewORM.id))),
        **recent_kwargs,
    )
    recent_result = await session.execute(recent_query)
    recently_added = recent_result.scalar_one() or 0

    # Needs attention — matches the ``attentionOnly`` list filter exactly.
    attention_kwargs = {**filter_kwargs, "attention_only": True}
    attention_query = _apply_view_filters(
        select(func.count(func.distinct(ViewORM.id))),
        **attention_kwargs,
    )
    attention_result = await session.execute(attention_query)
    needs_attention = attention_result.scalar_one() or 0

    # Last activity across the same filtered set: the later of a settings edit and
    # a data publish, which is what the cards show.
    last_activity_query = _apply_view_filters(
        select(func.max(_last_change_expr())),
        **filter_kwargs,
    )
    last_activity_result = await session.execute(last_activity_query)
    last_activity_at = last_activity_result.scalar_one()

    return ViewCatalogStats(
        total=total,
        recently_added=recently_added,
        needs_attention=needs_attention,
        last_activity_at=last_activity_at,
    )


async def count_views_grouped(
    session: AsyncSession,
    column,
    *,
    readable=None,
    ids: Optional[Sequence[str]] = None,
) -> Dict[str, int]:
    """Live views the caller can read, counted per value of ``column``
    (``ViewORM.workspace_id``, ``.data_source_id`` or ``.context_model_id``).

    Counted through ``_apply_view_filters`` like the Explorer's list, stats and
    facets, so a count shown on the dashboard or a template card is the total
    the Explorer would show for the same filter. ``ids`` limits the groups to
    those values; a view whose ``column`` is NULL is in no group.
    """
    query = select(column, func.count(func.distinct(ViewORM.id))).where(column.isnot(None))
    if ids is not None:
        if not ids:
            return {}
        query = query.where(column.in_(list(ids)))
    rows = await session.execute(
        _apply_view_filters(query.group_by(column), readable=readable)
    )
    return {value: int(n) for value, n in rows.all()}


async def count_views_by_scope(
    session: AsyncSession,
    *,
    readable=None,
    workspace_ids: Optional[Sequence[str]] = None,
    data_source_ids: Optional[Sequence[str]] = None,
) -> Tuple[int, Dict[str, int], Dict[str, int]]:
    """Live views the caller can read: ``(total, by workspace, by data source)``.

    One GROUP BY over (workspace, data source), counted through
    ``_apply_view_filters`` like ``count_views_grouped``, and summed both ways
    here: a view has one of each, so the sums are exact. ``workspace_ids`` /
    ``data_source_ids`` narrow what is counted — all three numbers.
    """
    query = select(
        ViewORM.workspace_id, ViewORM.data_source_id, func.count(func.distinct(ViewORM.id)),
    )
    for column, ids in ((ViewORM.workspace_id, workspace_ids), (ViewORM.data_source_id, data_source_ids)):
        if ids is not None:
            if not ids:
                return 0, {}, {}
            query = query.where(column.in_(list(ids)))
    rows = await session.execute(_apply_view_filters(
        query.group_by(ViewORM.workspace_id, ViewORM.data_source_id), readable=readable,
    ))
    total, by_ws, by_ds = 0, {}, {}
    for ws_id, ds_id, n in rows.all():
        total += n
        if ws_id:
            by_ws[ws_id] = by_ws.get(ws_id, 0) + n
        if ds_id:
            by_ds[ds_id] = by_ds.get(ds_id, 0) + n
    return total, by_ws, by_ds



async def set_context_model_version(
    session: AsyncSession, view_id: str, version: int, *, user_id: Optional[str] = None,
) -> Optional[ViewResponse]:
    """Record the layout-template version a view's layers now match — after an
    update was applied, or declined. Not an edit of the view, so ``updated_at``
    stays as it was."""
    await session.execute(
        update(ViewORM).where(ViewORM.id == view_id)
        .values(context_model_version=version, updated_at=ViewORM.updated_at)
    )
    row = await session.get(ViewORM, view_id)
    if row is None:
        return None
    await session.refresh(row)
    return await _to_enriched_response(session, row, user_id)


async def touch_views_data_updated(
    session: AsyncSession, ds_id: str, actor: Optional[str], *,
    summary: str = "Underlying data updated", changes: Optional[dict] = None,
) -> int:
    """Stamp ``data_updated_at``/``data_updated_by`` on every live view that reads
    data source ``ds_id``, and record a ``data_changed`` activity on each (the
    timeline's Data channel). Returns how many views it stamped; the caller commits.

    The views that read it are its own and, when it is its workspace's default,
    the views with no data source of their own there — they read it too
    (``SourceKindSets.kind_for``), and missed every publish while only the
    first kind was stamped. ``updated_at`` is self-assigned so the column's
    ``onupdate`` does not fire: data freshness must not pose as a settings edit
    (the whole reason the two are separate). ``actor`` is None for a change made
    outside this app, which nobody here published."""
    from backend.app.db.repositories import data_source_repo, view_activity_repo

    reads = ViewORM.data_source_id == ds_id
    ds = await session.get(WorkspaceDataSourceORM, ds_id)
    if ds is not None:
        defaults = await data_source_repo.default_data_source_ids(session, [ds.workspace_id])
        if defaults.get(ds.workspace_id) == ds_id:
            reads = or_(reads, and_(
                ViewORM.data_source_id.is_(None), ViewORM.workspace_id == ds.workspace_id,
            ))
    live = and_(reads, ViewORM.deleted_at.is_(None))
    # Snapshot the affected views BEFORE the bulk update, for their activity rows.
    affected = (await session.execute(select(ViewORM.id, ViewORM.workspace_id).where(live))).all()
    if not affected:
        return 0
    await session.execute(
        update(ViewORM).where(live)
        .values(data_updated_at=datetime.now(timezone.utc).isoformat(), data_updated_by=actor,
                updated_at=ViewORM.updated_at)
        .execution_options(synchronize_session=False)
    )
    for view_id, workspace_id in affected:
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=workspace_id,
            action="data_changed", actor=actor, summary=summary, changes=changes,
        )
    return len(affected)


async def last_built_from(session: AsyncSession, user_id: str, template_ids: Sequence[str]) -> Dict[str, str]:
    """When ``user_id`` last made a live view from each of ``template_ids`` —
    "recently used", as far as anyone can tell: views are what templates are
    used for."""
    if not template_ids:
        return {}
    rows = await session.execute(
        select(ViewORM.context_model_id, func.max(ViewORM.created_at)).where(
            ViewORM.created_by == user_id,
            ViewORM.context_model_id.in_(list(template_ids)),
            view_is_live(),
        ).group_by(ViewORM.context_model_id)
    )
    return {tid: at for tid, at in rows.all()}


async def template_owners_behind(session: AsyncSession, template_id: str, version: int) -> set:
    """Who made a live view from ``template_id`` that matches a version older
    than ``version`` — the people a new version is news to."""
    rows = await session.execute(
        select(ViewORM.created_by).distinct().where(
            ViewORM.context_model_id == template_id,
            ViewORM.context_model_version < version,
            ViewORM.created_by.isnot(None),
            view_is_live(),
        )
    )
    return {owner for (owner,) in rows.all()}

async def list_popular_views(
    session: AsyncSession,
    *,
    limit: int = 20,
    user_id: Optional[str] = None,
    readable=None,
) -> List[ViewResponse]:
    """List the most-favourited views visible to the caller.

    ``readable`` (from ``view_access.readable_views_clause``) is the
    caller's actual read reach and should always be supplied by the
    endpoint; the legacy predicate below survives only for the
    ``RBAC_ENFORCE_VIEWS`` kill-switch path. The legacy predicate leaked
    workspace-tier views across workspaces — it had no workspace
    scoping at all.

    Zero-favourite views are excluded so Trending reflects actual
    popularity rather than padding with unloved views.
    """
    fav_count_sq = (
        select(
            ViewFavouriteORM.view_id,
            func.count().label("fav_count"),
        )
        .group_by(ViewFavouriteORM.view_id)
        .subquery()
    )

    if readable is not None:
        visibility_predicate = readable
    else:
        # Legacy (kill-switch) predicate: everyone sees non-private
        # views; private views only surface to their creator.
        visibility_predicate = ViewORM.visibility.in_(("enterprise", "workspace"))
        if user_id:
            visibility_predicate = or_(
                visibility_predicate,
                ViewORM.created_by == user_id,
            )

    query = (
        select(ViewORM, fav_count_sq.c.fav_count)
        .join(fav_count_sq, ViewORM.id == fav_count_sq.c.view_id)
        .where(view_is_live())
        .where(fav_count_sq.c.fav_count > 0)
        .where(visibility_predicate)
        .order_by(
            fav_count_sq.c.fav_count.desc(),
            ViewORM.updated_at.desc(),
        )
        .limit(limit)
    )

    result = await session.execute(query)
    tuples = result.all()
    rows = [t[0] for t in tuples]
    # Favourite counts are already produced by the JOIN'd subquery; reuse
    # them so the batched enricher can skip its own GROUP BY.
    fav_count_overrides = {t[0].id: int(t[1] or 0) for t in tuples}

    if _batch_enrich_enabled():
        return await _batch_enrich_rows(
            session, rows, user_id,
            fav_count_overrides=fav_count_overrides,
        )

    # Legacy fallback (kill-switch path)
    responses = []
    followed = await followed_configs(session, rows)
    for row_tuple in tuples:
        row = row_tuple[0]
        fav_count = row_tuple[1] or 0
        ws_name = await _get_workspace_name(session, row.workspace_id)
        ds_name, ds_class, ds_trust = await _get_data_source_facts(session, row.data_source_id)
        cm_name = await _get_context_model_name(session, row.context_model_id, user_id)
        # The data publisher too, in the same lookup: without it this path showed
        # every trail without its last publisher, unlike the batched one.
        publisher_id = getattr(row, 'data_updated_by', None)
        user_map = await _resolve_user_identities(
            session, {row.created_by, row.updated_by, publisher_id},
        )
        creator_name, creator_email, creator_avatar = user_map.get(
            row.created_by or "", (None, None, None))
        modifier_name, modifier_email, modifier_avatar = user_map.get(
            row.updated_by or "", (None, None, None))
        publisher_name, publisher_email, publisher_avatar = user_map.get(
            publisher_id or "", (None, None, None))
        is_fav = await _is_favourited(session, row.id, user_id)
        responses.append(_to_response(
            row,
            config_override=followed.get(row.id),
            workspace_name=ws_name,
            data_source_name=ds_name,
            data_source_classification=ds_class,
            data_source_trust_status=ds_trust,
            context_model_name=cm_name,
            created_by_name=creator_name,
            created_by_email=creator_email,
            updated_by_name=modifier_name,
            updated_by_email=modifier_email,
            data_updated_by_name=publisher_name,
            data_updated_by_email=publisher_email,
            created_by_avatar_id=creator_avatar,
            updated_by_avatar_id=modifier_avatar,
            data_updated_by_avatar_id=publisher_avatar,
            favourite_count=fav_count,
            is_favourited=is_fav,
        ))
    return responses


async def list_views_for_context_model(
    session: AsyncSession,
    context_model_id: str,
    user_id: Optional[str] = None,
) -> List[ViewResponse]:
    """Find all views referencing a given context model."""
    query = (
        select(ViewORM)
        .where(ViewORM.context_model_id == context_model_id)
        .where(view_is_live())
        .order_by(ViewORM.updated_at.desc())
    )
    result = await session.execute(query)
    rows = result.scalars().all()
    if _batch_enrich_enabled():
        return await _batch_enrich_rows(session, rows, user_id)
    return [await _to_enriched_response(session, row, user_id) for row in rows]


async def update_visibility(
    session: AsyncSession, view_id: str, visibility: str,
    user_id: Optional[str] = None,
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    row.visibility = visibility
    if user_id is not None:
        row.updated_by = user_id
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return await _to_enriched_response(session, row, user_id)


# ------------------------------------------------------------------ #
# Favourites                                                           #
# ------------------------------------------------------------------ #

async def favourite_view(
    session: AsyncSession, view_id: str, user_id: str
) -> bool:
    existing = await session.execute(
        select(ViewFavouriteORM.id).where(
            ViewFavouriteORM.view_id == view_id,
            ViewFavouriteORM.user_id == user_id,
        )
    )
    if existing.scalar_one_or_none():
        return False
    fav = ViewFavouriteORM(view_id=view_id, user_id=user_id)
    session.add(fav)
    await session.flush()
    return True


async def unfavourite_view(
    session: AsyncSession, view_id: str, user_id: str
) -> bool:
    result = await session.execute(
        select(ViewFavouriteORM).where(
            ViewFavouriteORM.view_id == view_id,
            ViewFavouriteORM.user_id == user_id,
        )
    )
    row = result.scalar_one_or_none()
    if row:
        await session.delete(row)
        return True
    return False
