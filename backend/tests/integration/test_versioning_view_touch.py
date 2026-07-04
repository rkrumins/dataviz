"""Publish/merge stamps view DATA freshness, non-fatally (needs Postgres).

The versioning endpoints fan out to every view of a data source after a main-advancing
write via ``_touch_views_data_updated``. This proves:
- it stamps ``data_updated_at``/``data_updated_by`` on ALL live views of the data source,
  leaving the settings-edit fields (``updated_at``/``updated_by``) untouched;
- a soft-deleted view is skipped;
- it is best-effort: a management-DB failure (the two DBs may be separate, no 2PC) is
  swallowed so it can never fail the user's already-committed publish.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db as gvdb, models as gvmodels
from backend.app.services.versioning.service import GraphVersioningService


async def _seed_management(ds_id: str) -> tuple:
    """Create a workspace + provider + data source + two views (one soft-deleted) in the
    management DB. Returns (view_live_id, view_other_id, view_deleted_id)."""
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import (
        ProviderORM, ViewORM, WorkspaceORM, WorkspaceDataSourceORM, _now,
    )
    sfx = os.urandom(3).hex()
    async with get_async_session() as s:
        s.add(WorkspaceORM(id=f"ws_{sfx}", name="Touch WS"))
        s.add(ProviderORM(id=f"prov_{sfx}", name="Touch Prov", provider_type="falkordb"))
        await s.flush()
        s.add(WorkspaceDataSourceORM(id=ds_id, workspace_id=f"ws_{sfx}",
                                     provider_id=f"prov_{sfx}", label="Touch DS"))
        await s.flush()
        vlive = ViewORM(id=f"view_{sfx}a", name="Live", workspace_id=f"ws_{sfx}",
                        data_source_id=ds_id, updated_by="editor", updated_at="2020-01-01T00:00:00+00:00")
        vother = ViewORM(id=f"view_{sfx}b", name="Other", workspace_id=f"ws_{sfx}",
                         data_source_id=ds_id, updated_by="editor", updated_at="2020-01-01T00:00:00+00:00")
        vdel = ViewORM(id=f"view_{sfx}c", name="Deleted", workspace_id=f"ws_{sfx}",
                       data_source_id=ds_id, deleted_at=_now())
        s.add_all([vlive, vother, vdel])
        await s.commit()
    return vlive.id, vother.id, vdel.id


async def _view_row(view_id: str):
    from backend.app.db.engine import get_async_session
    from backend.app.db.models import ViewORM
    async with get_async_session() as s:
        return await s.get(ViewORM, view_id)


async def _run() -> None:
    await gvmodels.create_schema_and_partitions()
    from backend.app.api.v1.endpoints import versioning as vapi

    ds_id = "ds_" + os.urandom(4).hex()
    v_live, v_other, v_del = await _seed_management(ds_id)

    svc = GraphVersioningService()
    await svc.create_graph(data_source_id=ds_id, workspace_id="ws1", actor="creator")
    gid = (await svc.get_graph_by_data_source(ds_id))["graph_id"]

    # ── Stamp: both live views get data_updated_*, settings fields untouched ──
    await vapi._touch_views_data_updated(gid, "publisher")
    for vid in (v_live, v_other):
        row = await _view_row(vid)
        assert row.data_updated_by == "publisher", vid
        assert row.data_updated_at is not None
        assert row.updated_by == "editor", "settings-edit attribution must survive a publish"
        assert row.updated_at == "2020-01-01T00:00:00+00:00", "updated_at must NOT be bumped"

    # soft-deleted view is never stamped
    assert (await _view_row(v_del)).data_updated_by is None

    # ── A second publish by another actor advances the data-freshness stamp ──
    first_at = (await _view_row(v_live)).data_updated_at
    await vapi._touch_views_data_updated(gid, "publisher2")
    row = await _view_row(v_live)
    assert row.data_updated_by == "publisher2"
    assert row.data_updated_at >= first_at

    # ── Non-fatal: a management-DB failure is swallowed (never fails the write) ──
    import backend.app.db.engine as engine_mod
    orig = engine_mod.get_async_session

    def _boom():
        raise RuntimeError("management DB unreachable")

    engine_mod.get_async_session = _boom
    try:
        await vapi._touch_views_data_updated(gid, "publisher3")   # must NOT raise
    finally:
        engine_mod.get_async_session = orig
    # the stamp from the failed run did not land, but nothing crashed
    assert (await _view_row(v_live)).data_updated_by == "publisher2"

    # ── Unknown graph (no data source resolved) is a clean no-op ──
    await vapi._touch_views_data_updated("graph_does_not_exist", "publisher4")

    await gvdb.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_view_touch_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning view data-freshness touch e2e: OK")
