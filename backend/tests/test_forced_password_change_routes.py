"""A pending password change holds on every route, whichever way it signs in.

``get_current_user`` enforced the hold, but a route can also authenticate
through ``get_optional_user`` and ``get_permission_claims`` without ever
calling it — and thirty-odd view routes did, so the hold never reached
them.

This signs in for real, as an account that must change its password, and
calls every route that authenticates without ``get_current_user``. The
list is read from the live route table, so a route added that way later is
covered without anyone remembering to add it here.
"""
from __future__ import annotations

import re
import time

import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.auth.password import hash_password
from backend.app.db.repositories import user_repo
from backend.app.services.feature_flags import feature_flags
from backend.auth_service.cookies import CSRF_COOKIE_NAME
from backend.auth_service.csrf import CSRF_HEADER_NAME

_EMAIL = "starting-password@example.com"
_PASSWORD = "C0mpl3x!Passw0rd#"


def _dependency_calls(dependant) -> set:
    """Every callable in a route's dependency tree."""
    calls, stack = set(), [dependant]
    while stack:
        node = stack.pop()
        for sub in node.dependencies:
            if sub.call is not None:
                calls.add(sub.call)
            stack.append(sub)
    return calls


def _api_routes():
    """Yield ``(path, methods, dependant)`` for every mounted APIRoute.

    Same traversal as ``test_nav_catalogue._iter_route_gates``: some FastAPI
    versions keep included routers behind ``_IncludedRouter`` wrappers
    instead of flattening them into ``app.routes``.
    """
    import fastapi.routing as _fr
    from backend.app.main import app

    included = getattr(_fr, "_IncludedRouter", None)

    def _emit(ctx):
        original = getattr(ctx, "original_route", None)
        if isinstance(original, APIRoute):
            yield (getattr(ctx, "path", "") or "", original.methods,
                   getattr(ctx, "dependant", None) or original.dependant)

    def _walk(routes):
        for route in routes:
            if included is not None and isinstance(route, included):
                for cand in route.effective_candidates():
                    if isinstance(cand, included):
                        yield from _walk([cand])
                    else:
                        yield from _emit(cand)
                for cand in route.effective_low_priority_routes():
                    yield from _emit(cand)
            elif isinstance(route, APIRoute):
                yield route.path, route.methods, route.dependant

    yield from _walk(app.routes)


def _routes_that_skip_get_current_user() -> list[tuple[str, str]]:
    found = []
    for path, methods, dependant in _api_routes():
        calls = _dependency_calls(dependant)
        if get_current_user in calls:
            continue
        if get_optional_user in calls or get_permission_claims in calls:
            concrete = re.sub(r"\{[^}]+\}", "x", path)
            for method in sorted(methods - {"HEAD"}):
                found.append((method, concrete))
    return found


@pytest.fixture()
async def held_client(test_client: AsyncClient, db_session: AsyncSession):
    """Signed in, for real, as an account that must change its password."""
    from backend.app.main import app

    user = await user_repo.create_user(
        db_session, email=_EMAIL, password_hash=hash_password(_PASSWORD),
        first_name="Starting", last_name="Password", status="active",
    )
    await user_repo.assign_role(db_session, user.id, "super_admin")
    user.must_change_password = True
    await db_session.commit()

    # The real resolvers, not the fixture's stand-ins: they are what is
    # under test.
    for dep in (get_current_user, get_optional_user, get_permission_claims):
        app.dependency_overrides.pop(dep, None)
    # The view transfer and version routes answer to these before anything
    # else; switched on so the request reaches the sign-in check.
    feature_flags._cache = {
        **(feature_flags._cache or {}),
        "viewPortabilityEnabled": True,
        "viewExportEnabled": True,
        "viewImportEnabled": True,
    }
    feature_flags._cache_ts = time.monotonic()

    resp = await test_client.post(
        "/api/v1/auth/login", json={"email": _EMAIL, "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["user"]["mustChangePassword"] is True
    # Carry the session's own CSRF token rather than the fixture's.
    token = resp.cookies[CSRF_COOKIE_NAME]
    test_client.cookies.delete(CSRF_COOKIE_NAME)
    test_client.cookies.set(CSRF_COOKIE_NAME, token)
    test_client.headers[CSRF_HEADER_NAME] = token
    return test_client


def test_the_walk_finds_the_routes_it_is_about():
    """If the route table stops yielding these, the walk below proves
    nothing — fail loudly rather than pass on an empty list."""
    routes = _routes_that_skip_get_current_user()
    assert len(routes) >= 30
    assert ("POST", "/api/v1/views/") in routes or ("POST", "/api/v1/views") in routes


async def test_every_route_holds_until_the_password_is_changed(held_client):
    leaks = []
    for method, path in _routes_that_skip_get_current_user():
        resp = await held_client.request(method, path, json={})
        body = resp.json() if resp.headers.get("content-type", "").startswith(
            "application/json") else {}
        detail = body.get("detail") if isinstance(body, dict) else None
        if not (resp.status_code == 403 and isinstance(detail, dict)
                and detail.get("error") == "password_change_required"):
            leaks.append(f"{method} {path} -> {resp.status_code}")
    assert leaks == []


async def test_the_change_itself_stays_reachable(held_client):
    me = await held_client.get("/api/v1/users/me")
    assert me.status_code == 200, me.text

    changed = await held_client.post("/api/v1/users/me/password", json={
        "currentPassword": _PASSWORD, "newPassword": "An0ther!Lengthy#Phrase",
    })
    assert changed.status_code == 200, changed.text


async def test_editing_the_profile_waits_for_the_change(held_client):
    """``/users/me`` is open so the change screen can read who you are —
    not so the account can be edited before the password is."""
    resp = await held_client.patch("/api/v1/users/me", json={"firstName": "Renamed"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "password_change_required"
