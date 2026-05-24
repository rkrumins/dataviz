"""
Repository for context_models table.
Context models define how to organize graph nodes into logical business flows.
Templates (is_template=True) are reusable starting points; instances are workspace-scoped.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Literal, Optional

from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ContextModelORM
from backend.common.models.management import (
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    ContextModelResponse,
    TemplateUsageStats,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_tags(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
        return value if isinstance(value, list) else []
    except (ValueError, TypeError):
        return []


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: ContextModelORM) -> ContextModelResponse:
    return ContextModelResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        workspaceId=row.workspace_id,
        dataSourceId=row.data_source_id,
        isTemplate=bool(row.is_template),
        category=row.category,
        layersConfig=json.loads(row.layers_config or "[]"),
        scopeFilter=json.loads(row.scope_filter) if row.scope_filter else None,
        instanceAssignments=json.loads(row.instance_assignments or "{}"),
        scopeEdgeConfig=json.loads(row.scope_edge_config) if row.scope_edge_config else None,
        isActive=bool(row.is_active),
        icon=row.icon,
        accentColor=row.accent_color,
        maintainer=row.maintainer,
        aboutMarkdown=row.about_markdown,
        tags=_parse_tags(row.tags),
        visibility=row.visibility or "private",
        isPinned=bool(row.is_pinned),
        instantiationCount=int(row.instantiation_count or 0),
        lastUsedAt=row.last_used_at,
        instantiatedFromId=row.instantiated_from_id,
        createdBy=row.created_by,
        deletedAt=row.deleted_at,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# Internal column writers                                             #
# ------------------------------------------------------------------ #

def _apply_template_metadata(
    row: ContextModelORM,
    req: ContextModelCreateRequest | ContextModelUpdateRequest,
) -> None:
    """Copy the template-metadata fields from a request onto an ORM row.

    Used by both create and update paths to avoid drift between them.
    Only writes the field when the request explicitly sets it (so partial
    PATCH-style updates don't clobber unrelated columns).
    """
    if req.icon is not None:
        row.icon = req.icon
    if req.accent_color is not None:
        row.accent_color = req.accent_color
    if req.maintainer is not None:
        row.maintainer = req.maintainer
    if req.about_markdown is not None:
        row.about_markdown = req.about_markdown
    if req.tags is not None:
        row.tags = json.dumps(req.tags)
    if req.visibility is not None:
        row.visibility = req.visibility
    if req.is_pinned is not None:
        row.is_pinned = bool(req.is_pinned)
    if getattr(req, "category", None) is not None:
        row.category = req.category


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_context_models(
    session: AsyncSession,
    workspace_id: Optional[str] = None,
    templates_only: bool = False,
) -> List[ContextModelResponse]:
    """List context models, optionally filtered by workspace or templates.

    Soft-deleted rows (deleted_at IS NOT NULL) are excluded.
    """
    stmt = select(ContextModelORM).where(ContextModelORM.deleted_at.is_(None))

    if templates_only:
        stmt = stmt.where(ContextModelORM.is_template == True)  # noqa: E712
    elif workspace_id:
        stmt = stmt.where(ContextModelORM.workspace_id == workspace_id)

    stmt = stmt.order_by(ContextModelORM.updated_at.desc())
    result = await session.execute(stmt)
    return [_to_response(r) for r in result.scalars().all()]


async def list_templates(
    session: AsyncSession,
    *,
    scope: Literal["all", "global", "workspace"] = "all",
    workspace_id: Optional[str] = None,
    category: Optional[str] = None,
    tag: Optional[str] = None,
    search: Optional[str] = None,
    sort: Literal["popular", "recent", "name"] = "recent",
    include_deleted: bool = False,
) -> List[ContextModelResponse]:
    """List Quick Start Templates with rich filtering.

    Scope semantics:
      * ``"all"`` (default): global templates + templates for ``workspace_id`` (if provided).
      * ``"global"``: only ``workspace_id IS NULL``.
      * ``"workspace"``: only templates matching ``workspace_id`` (must be provided).
    """
    stmt = select(ContextModelORM).where(ContextModelORM.is_template == True)  # noqa: E712

    if not include_deleted:
        stmt = stmt.where(ContextModelORM.deleted_at.is_(None))

    if scope == "global":
        stmt = stmt.where(ContextModelORM.workspace_id.is_(None))
    elif scope == "workspace":
        if not workspace_id:
            return []
        stmt = stmt.where(ContextModelORM.workspace_id == workspace_id)
    else:  # "all"
        if workspace_id:
            stmt = stmt.where(
                (ContextModelORM.workspace_id.is_(None))
                | (ContextModelORM.workspace_id == workspace_id)
            )

    if category:
        stmt = stmt.where(ContextModelORM.category == category)

    if search:
        like = f"%{search.lower()}%"
        stmt = stmt.where(
            func.lower(ContextModelORM.name).like(like)
            | func.lower(func.coalesce(ContextModelORM.description, "")).like(like)
        )

    if sort == "popular":
        stmt = stmt.order_by(
            ContextModelORM.instantiation_count.desc(),
            ContextModelORM.updated_at.desc(),
        )
    elif sort == "name":
        stmt = stmt.order_by(func.lower(ContextModelORM.name).asc())
    else:  # "recent"
        stmt = stmt.order_by(ContextModelORM.updated_at.desc())

    result = await session.execute(stmt)
    rows = result.scalars().all()

    # Tag filtering happens in Python — tags live in a JSON column so we
    # can't push it into the WHERE without dialect-specific JSON ops.
    if tag:
        rows = [r for r in rows if tag in _parse_tags(r.tags)]

    return [_to_response(r) for r in rows]


async def get_context_model(
    session: AsyncSession, context_model_id: str
) -> Optional[ContextModelResponse]:
    """Fetch a single context model by id, including soft-deleted rows."""
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def create_context_model(
    session: AsyncSession,
    req: ContextModelCreateRequest,
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> ContextModelResponse:
    row = ContextModelORM(
        name=req.name,
        description=req.description,
        workspace_id=workspace_id,
        data_source_id=data_source_id,
        is_template=req.is_template,
        category=req.category,
        layers_config=json.dumps(req.layers_config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
        instance_assignments=json.dumps(req.instance_assignments),
        scope_edge_config=json.dumps(req.scope_edge_config) if req.scope_edge_config else None,
        created_by=created_by,
    )
    _apply_template_metadata(row, req)
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_context_model(
    session: AsyncSession,
    context_model_id: str,
    req: ContextModelUpdateRequest,
) -> Optional[ContextModelResponse]:
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.layers_config is not None:
        row.layers_config = json.dumps(req.layers_config)
    if req.scope_filter is not None:
        row.scope_filter = json.dumps(req.scope_filter)
    if req.instance_assignments is not None:
        row.instance_assignments = json.dumps(req.instance_assignments)
    if req.scope_edge_config is not None:
        row.scope_edge_config = json.dumps(req.scope_edge_config)

    _apply_template_metadata(row, req)

    row.updated_at = _now()
    await session.flush()
    return _to_response(row)


async def soft_delete_context_model(
    session: AsyncSession,
    context_model_id: str,
    deleted_by: Optional[str] = None,
) -> bool:
    """Mark a context model deleted (deleted_at set) without removing the row."""
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return False
    if row.deleted_at is not None:
        return True  # idempotent: already deleted
    row.deleted_at = _now()
    row.updated_at = _now()
    await session.flush()
    return True


async def delete_context_model(
    session: AsyncSession, context_model_id: str
) -> bool:
    """Hard-delete a context model. Prefer soft_delete_context_model for templates."""
    result = await session.execute(
        delete(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    return result.rowcount > 0


async def duplicate_template(
    session: AsyncSession,
    source_id: str,
    new_name: str,
    workspace_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> Optional[ContextModelResponse]:
    """Deep-copy a template's config into a new template row.

    Resets usage counters and unpins the duplicate so it doesn't inherit
    "promoted" status from the source.
    """
    result = await session.execute(
        select(ContextModelORM).where(
            ContextModelORM.id == source_id,
            ContextModelORM.is_template == True,  # noqa: E712
        )
    )
    source = result.scalar_one_or_none()
    if not source:
        return None

    row = ContextModelORM(
        name=new_name,
        description=source.description,
        workspace_id=workspace_id,
        is_template=True,
        category=source.category,
        layers_config=source.layers_config,
        scope_filter=source.scope_filter,
        instance_assignments="{}",
        scope_edge_config=source.scope_edge_config,
        icon=source.icon,
        accent_color=source.accent_color,
        maintainer=source.maintainer,
        about_markdown=source.about_markdown,
        tags=source.tags,
        visibility=source.visibility or "private",
        is_pinned=False,
        instantiation_count=0,
        last_used_at=None,
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def get_usage_stats(
    session: AsyncSession, template_id: str
) -> Optional[TemplateUsageStats]:
    """Aggregate usage stats for a template across its workspace instances."""
    template_row = await session.execute(
        select(ContextModelORM).where(
            ContextModelORM.id == template_id,
            ContextModelORM.is_template == True,  # noqa: E712
        )
    )
    template = template_row.scalar_one_or_none()
    if not template:
        return None

    instances_q = await session.execute(
        select(
            ContextModelORM.workspace_id,
            func.count(ContextModelORM.id),
        )
        .where(
            ContextModelORM.instantiated_from_id == template_id,
            ContextModelORM.is_template == False,  # noqa: E712
            ContextModelORM.deleted_at.is_(None),
        )
        .group_by(ContextModelORM.workspace_id)
    )

    instances_by_workspace = {
        (ws_id or "_unscoped"): int(count) for ws_id, count in instances_q.all()
    }

    return TemplateUsageStats(
        templateId=template_id,
        instantiationCount=int(template.instantiation_count or 0),
        lastUsedAt=template.last_used_at,
        instancesByWorkspace=instances_by_workspace,
    )


async def instantiate_template(
    session: AsyncSession,
    template_id: str,
    workspace_id: str,
    name: str,
    data_source_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> Optional[ContextModelResponse]:
    """Create a workspace-scoped context model from a template.

    Side effects on the source template row:
      * instantiation_count += 1
      * last_used_at = now()

    The new instance keeps an ``instantiated_from_id`` pointer so
    ``get_usage_stats`` can aggregate live instances per workspace.
    """
    result = await session.execute(
        select(ContextModelORM).where(
            ContextModelORM.id == template_id,
            ContextModelORM.is_template == True,  # noqa: E712
        )
    )
    template = result.scalar_one_or_none()
    if not template:
        return None

    row = ContextModelORM(
        name=name,
        description=f"Created from template: {template.name}",
        workspace_id=workspace_id,
        data_source_id=data_source_id,
        is_template=False,
        category=template.category,
        layers_config=template.layers_config,
        scope_filter=template.scope_filter,
        instance_assignments="{}",  # Fresh — no entity assignments from template
        scope_edge_config=template.scope_edge_config,
        instantiated_from_id=template.id,
        created_by=created_by,
    )
    session.add(row)

    template.instantiation_count = int(template.instantiation_count or 0) + 1
    template.last_used_at = _now()

    await session.flush()
    return _to_response(row)
