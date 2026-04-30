"""Audit / debug endpoint for the role-binding table (RBAC Phase 2).

Mounted at ``/api/v1/admin/role-bindings``. Answers the operational
question "why does Alice see Workspace-X?" without forcing the
operator to write SQL.

  GET /admin/role-bindings?subject_id=usr_alice
  GET /admin/role-bindings?scope_type=workspace&scope_id=ws_finance

Either or both filters may be omitted (returns the full table —
limited for safety). Result rows are RoleBindingAuditRow DTOs; no
display-name expansion to keep the endpoint cheap on big deployments.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import RoleBindingORM
from backend.auth_service.interface import User
from backend.common.models.rbac import RoleBindingAuditRow


router = APIRouter()


@router.get(
    "",
    response_model=list[RoleBindingAuditRow],
    response_model_by_alias=True,
)
async def list_bindings(
    subject_id: Optional[str] = Query(default=None, alias="subjectId"),
    scope_type: Optional[str] = Query(default=None, alias="scopeType"),
    scope_id: Optional[str] = Query(default=None, alias="scopeId"),
    role_name: Optional[str] = Query(default=None, alias="role"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    if scope_type is not None and scope_type not in ("global", "workspace"):
        raise HTTPException(
            status_code=400,
            detail="scopeType must be 'global' or 'workspace'",
        )

    stmt = select(RoleBindingORM)
    if subject_id is not None:
        stmt = stmt.where(RoleBindingORM.subject_id == subject_id)
    if scope_type is not None:
        stmt = stmt.where(RoleBindingORM.scope_type == scope_type)
    if scope_id is not None:
        stmt = stmt.where(RoleBindingORM.scope_id == scope_id)
    if role_name is not None:
        stmt = stmt.where(RoleBindingORM.role_name == role_name)

    stmt = (
        stmt.order_by(RoleBindingORM.granted_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await session.execute(stmt)).scalars().all()

    return [
        RoleBindingAuditRow(
            id=b.id,
            subject_type=b.subject_type,
            subject_id=b.subject_id,
            role=b.role_name,
            scope_type=b.scope_type,
            scope_id=b.scope_id,
            granted_at=b.granted_at,
            granted_by=b.granted_by,
            expires_at=b.expires_at,
        )
        for b in rows
    ]
