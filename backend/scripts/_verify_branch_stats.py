"""TEMP verification: reproduce the insights collector path for the data sources that were
crashing, and confirm get_stats/get_schema_stats now succeed. Delete after running."""
import asyncio

from backend.app.db.engine import get_jobs_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine

DS_IDS = ["ds_40205b0674e0", "ds_d06a62cbd868", "ds_331b75ba32c4", "ds_bf6bc03afe4d"]


async def main():
    async with get_jobs_session() as session:
        for ds_id in DS_IDS:
            row = await session.get(WorkspaceDataSourceORM, ds_id)
            if row is None:
                print(f"{ds_id}: NOT FOUND")
                continue
            ws = row.workspace_id
            engine = await ContextEngine.for_workspace(
                workspace_id=ws, registry=provider_registry, session=session,
                data_source_id=ds_id)
            provider = engine.provider
            ptype = type(provider).__name__
            try:
                stats = await provider.get_stats(bypass_cache=True)
            except TypeError:
                stats = await provider.get_stats()
            schema = await provider.get_schema_stats()
            print(f"{ds_id}: provider={ptype} "
                  f"nodes={stats['nodeCount']} edges={stats['edgeCount']} "
                  f"entityTypes={stats['entityTypeCounts']} "
                  f"schema_totalNodes={schema.total_nodes} schema_entityStats={len(schema.entity_type_stats)}")


if __name__ == "__main__":
    asyncio.run(main())
