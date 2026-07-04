"""TEMP: force a stats poll for the previously-crashing data sources so the live worker
processes them end-to-end. Delete after running."""
import asyncio

from backend.app.db.engine import get_jobs_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.insights_service.enqueue import enqueue_stats_job_force

DS_IDS = ["ds_40205b0674e0", "ds_d06a62cbd868", "ds_331b75ba32c4", "ds_bf6bc03afe4d"]


async def main():
    async with get_jobs_session() as session:
        for ds_id in DS_IDS:
            row = await session.get(WorkspaceDataSourceORM, ds_id)
            if row is None:
                print(f"{ds_id}: NOT FOUND")
                continue
            msg = await enqueue_stats_job_force(ds_id, row.workspace_id)
            print(f"{ds_id}: enqueued msg_id={msg}")


if __name__ == "__main__":
    asyncio.run(main())
