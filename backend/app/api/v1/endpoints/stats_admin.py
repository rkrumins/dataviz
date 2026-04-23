"""Admin endpoint for stats-service polling status.

Surfaces ``data_source_polling_configs`` rows joined with their data-source
labels so operators can see per-DS poll outcomes (last_polled_at,
last_status, last_error) without shelling into Postgres. This is the
feedback loop for the stats service — without it, ``last_error`` is
written but never seen.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import require_admin
from backend.app.db.engine import get_db_session
from backend.app.db.models import DataSourcePollingConfigORM, WorkspaceDataSourceORM

router = APIRouter()


class StatsPollingRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    data_source_id: str
    workspace_id: str
    label: str | None
    is_active: bool
    is_enabled: bool
    interval_seconds: int
    last_polled_at: str | None
    last_status: str | None
    last_error: str | None


@router.get("/stats-polling", response_model=list[StatsPollingRow])
async def list_stats_polling(
    session: AsyncSession = Depends(get_db_session),
    _admin=Depends(require_admin),
) -> list[StatsPollingRow]:
    """Return one row per data source with its polling config + last poll outcome."""
    stmt = (
        select(
            WorkspaceDataSourceORM.id.label("data_source_id"),
            WorkspaceDataSourceORM.workspace_id,
            WorkspaceDataSourceORM.label,
            WorkspaceDataSourceORM.is_active,
            DataSourcePollingConfigORM.is_enabled,
            DataSourcePollingConfigORM.interval_seconds,
            DataSourcePollingConfigORM.last_polled_at,
            DataSourcePollingConfigORM.last_status,
            DataSourcePollingConfigORM.last_error,
        )
        .join(
            DataSourcePollingConfigORM,
            WorkspaceDataSourceORM.id == DataSourcePollingConfigORM.data_source_id,
            isouter=True,
        )
        .order_by(WorkspaceDataSourceORM.workspace_id, WorkspaceDataSourceORM.id)
    )
    result = await session.execute(stmt)
    return [
        StatsPollingRow(
            data_source_id=row.data_source_id,
            workspace_id=row.workspace_id,
            label=row.label,
            is_active=bool(row.is_active),
            is_enabled=bool(row.is_enabled) if row.is_enabled is not None else False,
            interval_seconds=int(row.interval_seconds) if row.interval_seconds is not None else 0,
            last_polled_at=row.last_polled_at,
            last_status=row.last_status,
            last_error=row.last_error,
        )
        for row in result.all()
    ]
