"""The admin schema status endpoint: ``GET /api/v1/admin/system/schema``.

Super-admins only (the system router's ``system:admin`` gate); the status itself is
``services/system_status/schema.schema_status`` (its database cases are in
``test_upgrade_extras.py``), here replaced so the route is tested on its own.
"""
from __future__ import annotations

from sqlalchemy.exc import OperationalError

from backend.app.api.v1.endpoints import system_status
from backend.app.auth.dependencies import get_permission_claims
from backend.app.main import app
from backend.app.services.permission_service import PermissionClaims

URL = "/api/v1/admin/system/schema"


def _status():
    return {"applied": ["b"], "expected": ["b"], "atHead": True, "build": {"from": "main at abc", "onMain": True},
            "plan": {"verdict": "up_to_date"}, "history": [], "lastSeeded": None, "generatedAt": "now"}


async def test_super_admins_read_the_schema_status_with_this_servers_version(test_client, monkeypatch):
    monkeypatch.setattr(system_status, "schema_status", _status)
    res = await test_client.get(URL)
    assert res.status_code == 200
    body = res.json()
    assert body["atHead"] is True and body["plan"]["verdict"] == "up_to_date"
    assert body["build"] == {"from": "main at abc", "onMain": True, "version": app.version}


async def test_nobody_else_does(test_client, monkeypatch):
    monkeypatch.setattr(system_status, "schema_status", _status)
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", global_perms=("system:audit:read",), ws_perms={})
    try:
        assert (await test_client.get(URL)).status_code == 403
    finally:
        app.dependency_overrides.pop(get_permission_claims, None)


async def test_an_unreadable_database_is_a_503_not_a_500(test_client, monkeypatch):
    def down():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    monkeypatch.setattr(system_status, "schema_status", down)
    res = await test_client.get(URL)
    assert res.status_code == 503 and "couldn't be read" in res.json()["detail"]
