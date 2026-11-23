"""People's profiles: who someone is, the workspaces they run and the data they answer
for — only what the reader can open. A service account, or an id naming nobody, has
no profile; a former member keeps one.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import DataSourceContactORM
from tests.common import discussions_world as w


@pytest.fixture
async def world(db_session):
    await w.seed(db_session)
    w.add_user(db_session, "usr_gone", deleted=True)
    db_session.add_all([
        DataSourceContactORM(data_source_id=w.DS, role="owner", subject_type="user", subject_id=w.BEN,
                             created_at=w.T0),
        DataSourceContactORM(data_source_id=w.DS, role="steward", subject_type="group", subject_id=w.G_VIEWERS,
                             created_at=w.T0),
        DataSourceContactORM(data_source_id=w.DS_OPS, role="owner", subject_type="user", subject_id=w.BEN,
                             created_at=w.T0),
    ])
    await db_session.commit()


async def _profile(client: AsyncClient, session, reader: str, uid: str):
    with w.acting(reader, await w.claims_for(session, reader)):
        return await client.get(f"/api/v1/people/{uid}")


@pytest.mark.asyncio
async def test_a_profile_shows_only_what_the_reader_can_open(world, db_session, test_client):
    r = await _profile(test_client, db_session, w.ADA, w.BEN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["person"]["displayName"] == "Ben T" and body["person"]["isServiceAccount"] is False
    assert body["isMe"] is False and body["workspacesTheyRun"] == []
    # Ben owns a source in Ops too; Ada can't open Ops, so it isn't shown.
    assert body["dataContacts"] == [{
        "dataSourceId": w.DS, "dataSourceName": "General ledger", "workspaceId": w.WS, "workspaceName": "Finance",
        "role": "owner", "via": "direct",
    }]
    assert [c["dataSourceId"] for c in (await _profile(test_client, db_session, w.SAM, w.BEN)).json()["dataContacts"]
            ] == [w.DS, w.DS_OPS]


@pytest.mark.asyncio
async def test_the_workspaces_someone_runs(world, db_session, test_client):
    body = (await _profile(test_client, db_session, w.ADA, w.WALT)).json()
    assert body["workspacesTheyRun"] == [{"id": w.WS, "name": "Finance"}]
    assert (await _profile(test_client, db_session, w.EVE, w.WALT)).json()["workspacesTheyRun"] == []
    # An Org Admin runs everything, but no workspace in particular.
    assert (await _profile(test_client, db_session, w.SAM, w.OLGA)).json()["workspacesTheyRun"] == []


@pytest.mark.asyncio
async def test_a_group_steward_and_your_own_profile(world, db_session, test_client):
    body = (await _profile(test_client, db_session, w.GIL, w.GIL)).json()
    assert body["isMe"] is True
    assert [(c["role"], c["via"]) for c in body["dataContacts"]] == [("steward", "group")]


@pytest.mark.asyncio
async def test_no_profile_for_a_service_account_or_nobody(world, db_session, test_client):
    for uid in (w.BOT, "usr_nobody"):
        r = await _profile(test_client, db_session, w.SAM, uid)
        assert r.status_code == 404 and r.json()["detail"]["type"] == "not_found"
    gone = (await _profile(test_client, db_session, w.ADA, "usr_gone")).json()["person"]
    assert gone["deleted"] is True and gone["email"] is None and gone["displayName"] == "Gone T"
