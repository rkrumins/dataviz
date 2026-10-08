"""The bootstrap routes answer a refused user action with a 409 the UI can act on.

What a person may do to an enablement job depends on its state: retry only a job that has
stopped, resume only what can resume (an integrity failure needs a fresh read), enable again
only once an abandoned attempt has been cleaned up. ``bootstrap_worker`` decides; the route
must carry the decision through as ``{type, message[, action]}`` — not a 500, not a bare string
the UI would have to parse.
"""
import time

import pytest
from httpx import AsyncClient

from backend.app.db import models as _models
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning import bootstrap_worker
from backend.app.services.versioning.bootstrap_worker import BootstrapConflict

WS = "ws_boot_routes"
DS = "ds_boot_routes"


@pytest.fixture(autouse=True)
def _flag_on():
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture()
async def _data_source(db_session):
    db_session.add(_models.WorkspaceDataSourceORM(
        id=DS, workspace_id=WS, label="Mine", graph_name="my_graph", provider_id="default"))
    await db_session.commit()


def _refusing(kind, **extra):
    async def refuse(**_kw):
        raise BootstrapConflict(kind, "refused", **extra)
    return refuse


@pytest.mark.parametrize("path, target, kind, extra", [
    (f"/api/v1/{WS}/graph/bootstrap?dataSourceId={DS}",
     "create_bootstrap_job", "cleanup_in_progress", {}),
    (f"/api/v1/{WS}/graph/bootstrap/retry?dataSourceId={DS}&mode=restart",
     "retry_bootstrap", "job_active", {}),
    (f"/api/v1/{WS}/graph/bootstrap/retry?dataSourceId={DS}&mode=resume",
     "retry_bootstrap", "resume_not_possible", {"action": "restart"}),
])
async def test_a_refused_action_is_a_409_the_ui_can_act_on(
    test_client: AsyncClient, _data_source, monkeypatch, path, target, kind, extra,
):
    monkeypatch.setattr(bootstrap_worker, target, _refusing(kind, **extra))
    resp = await test_client.post(path)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"type": kind, "message": "refused", **extra}


async def test_enabling_again_reports_a_failed_job_with_what_can_be_done(
    test_client: AsyncClient, _data_source, monkeypatch,
):
    failure = {"code": "integrity", "action": "restart", "phase": "validate", "reason": "x"}

    async def existing(**_kw):
        return {"graph_id": "g1", "job_id": "j1", "status": "failed", "failure": failure}
    monkeypatch.setattr(bootstrap_worker, "create_bootstrap_job", existing)
    resp = await test_client.post(f"/api/v1/{WS}/graph/bootstrap?dataSourceId={DS}")
    assert resp.json() == {"jobId": "j1", "graphId": "g1", "status": "failed",
                           "failure": failure}


async def test_abandon_reports_the_purge_it_queued(
    test_client: AsyncClient, _data_source, monkeypatch,
):
    seen = {}

    async def abandon(**kw):
        seen.update(kw)
        return {"jobId": "j1", "status": "cancelled", "purgeJobId": "p1"}
    monkeypatch.setattr(bootstrap_worker, "abandon_bootstrap", abandon)
    resp = await test_client.post(f"/api/v1/{WS}/graph/bootstrap/abandon?dataSourceId={DS}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"jobId": "j1", "status": "cancelled", "purgeJobId": "p1"}
    assert seen["actor"] != "system", "the purge records who abandoned the job"
