"""Regression test for the aggregation permission dependency.

The dep read ``ds.workspaceId`` while DataSourceResponse exposes
``workspace_id`` (camelCase is only a serialization alias), AttributeError-ing
and 500-ing EVERY aggregation route (it guards both read + manage) before the
handler ran — "cannot submit any aggregation job".
"""
import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import aggregation
from backend.common.models.management import DataSourceResponse


def _ds(ws="ws1"):
    # model_construct bypasses validation — we only need .workspace_id.
    return DataSourceResponse.model_construct(workspace_id=ws)


@pytest.mark.asyncio
async def test_dep_allows_when_permitted(monkeypatch):
    dep = aggregation._require_ds_perm("workspace:datasource:manage")

    async def fake_get(session, ds_id):
        return _ds("ws1")

    monkeypatch.setattr(aggregation.data_source_repo, "get_data_source", fake_get)
    captured = {}

    def fake_perm(claims, permission, workspace_id=None):
        captured["workspace_id"] = workspace_id
        return True

    monkeypatch.setattr(aggregation, "has_permission", fake_perm)

    user = object()
    result = await dep(ds_id="ds1", user=user, claims=object(), session=object())
    assert result is user
    # The dep must read the snake_case attribute, not the alias.
    assert captured["workspace_id"] == "ws1"


@pytest.mark.asyncio
async def test_dep_denies_with_403_envelope(monkeypatch):
    dep = aggregation._require_ds_perm("workspace:datasource:read")

    async def fake_get(session, ds_id):
        return _ds("ws9")

    monkeypatch.setattr(aggregation.data_source_repo, "get_data_source", fake_get)
    monkeypatch.setattr(aggregation, "has_permission", lambda *a, **k: False)

    with pytest.raises(HTTPException) as ei:
        await dep(ds_id="ds1", user=object(), claims=object(), session=object())
    assert ei.value.status_code == 403
    # The 403 envelope also reads ds.workspace_id — would AttributeError on
    # the bug rather than reaching this assertion.
    assert ei.value.detail["scope"]["id"] == "ws9"


@pytest.mark.asyncio
async def test_dep_404_when_missing(monkeypatch):
    dep = aggregation._require_ds_perm("workspace:datasource:read")

    async def fake_get(session, ds_id):
        return None

    monkeypatch.setattr(aggregation.data_source_repo, "get_data_source", fake_get)
    with pytest.raises(HTTPException) as ei:
        await dep(ds_id="missing", user=object(), claims=object(), session=object())
    assert ei.value.status_code == 404
