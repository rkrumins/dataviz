"""The bootstrap routes must not act across tenants.

`require_ws_manage` proves the caller may manage the workspace in the URL — it says
NOTHING about the `dataSourceId` in the query string. Without a check that the data
source belongs to that workspace, a manager of workspace A could pass workspace B's
data source id and enable, restart, or (worst) ABANDON — i.e. DELETE — B's versioned
graph. These routes live on the graph router, so they can't lean on the versioning
router's `graph_in_workspace` dependency; they do it themselves.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.db import models as _models
from backend.app.services.feature_flags import feature_flags

WS_MINE = "ws_tenant_a"
WS_THEIRS = "ws_tenant_b"
DS_THEIRS = "ds_belongs_to_b"


@pytest.fixture(autouse=True)
def _flag_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture()
async def _their_data_source(db_session):
    """A data source that lives in the OTHER workspace."""
    db_session.add(_models.WorkspaceDataSourceORM(
        id=DS_THEIRS, workspace_id=WS_THEIRS, label="Theirs",
        graph_name="their_graph", provider_id="prov_x",
    ))
    await db_session.commit()


@pytest.mark.parametrize("method,path", [
    ("POST", f"/api/v1/{WS_MINE}/graph/bootstrap?dataSourceId={DS_THEIRS}"),
    ("POST", f"/api/v1/{WS_MINE}/graph/bootstrap/retry?dataSourceId={DS_THEIRS}"),
    ("POST", f"/api/v1/{WS_MINE}/graph/bootstrap/abandon?dataSourceId={DS_THEIRS}"),
])
async def test_cannot_act_on_another_workspaces_data_source(
    test_client: AsyncClient, _their_data_source, method, path,
):
    resp = await test_client.request(method, path)
    # 404, not 403: existence isn't leaked across tenants either.
    assert resp.status_code == 404, (
        f"{method} {path} reached another tenant's data source (got {resp.status_code})"
    )


async def test_status_does_not_leak_another_workspaces_job(
    test_client: AsyncClient, _their_data_source,
):
    resp = await test_client.get(
        f"/api/v1/{WS_MINE}/graph/bootstrap/status?dataSourceId={DS_THEIRS}")
    assert resp.status_code == 404
