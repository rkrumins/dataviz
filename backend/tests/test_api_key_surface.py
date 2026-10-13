"""The API key surface, held against the routes the app actually mounts.

``api_key_surface.SURFACE`` names handlers; these tests walk the live route
graph and check what that resolves to: every entry is a real route, every
route a key can reach is fenced the way its level says, nothing on it needs
an administrative permission — and the whole surface matches a checked-in
snapshot, so opening a route to keys is a diff a reviewer sees.

To accept a deliberate change to the surface, regenerate the snapshot:

    UPDATE_API_KEY_SURFACE=1 pytest backend/tests/test_api_key_surface.py
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import UniqueConstraint

from backend.app.auth import api_key_surface
from backend.app.auth.api_key_surface import (
    DATA_SOURCE,
    FILTERED,
    LEVELS,
    RESOURCE,
    SURFACE,
    WORKSPACE,
)
from backend.app.main import app
from backend.app.services.permission_service import KEY_GRANTABLE_PERMISSIONS

_SNAPSHOT = Path(__file__).parent / "fixtures" / "api_key_surface.txt"

#: Path parameters the request boundary holds to the key's selection.
_FENCED_PATH_PARAMS = {"view_id", "ds_id", "data_source_id"}
#: Dependencies that hold what a route names only indirectly.
_FENCING_DEPENDENCIES = {"graph_in_workspace", "pr_in_workspace", "view_in_workspace"}
#: Workspace-wide routes that name their workspace in the body, and check it
#: against the key in the handler (``authorize_view_create``).
_WORKSPACE_CHECKED_IN_HANDLER = {
    ("backend.app.api.v1.endpoints.views", "create_view"),
}


def _routes():
    return api_key_surface.routes(app)


def _key(route: APIRoute) -> tuple[str, str]:
    return route.endpoint.__module__, route.endpoint.__name__


def _eligible():
    for method, path, route, dependant in _routes():
        rule = SURFACE.get(_key(route))
        if rule is not None:
            yield method, path, route, dependant, rule


def _calls(dependant):
    stack = [dependant]
    while stack:
        dep = stack.pop()
        if getattr(dep, "call", None) is not None:
            yield dep.call
        stack.extend(dep.dependencies)


def _query_names(dependant) -> set[str]:
    names = set()
    stack = [dependant]
    while stack:
        dep = stack.pop()
        names |= {p.alias or p.name for p in dep.query_params}
        stack.extend(dep.dependencies)
    return names


def _path_names(dependant) -> set[str]:
    names = set()
    stack = [dependant]
    while stack:
        dep = stack.pop()
        names |= {p.name for p in dep.path_params}
        stack.extend(dep.dependencies)
    return names


def _snapshot_lines() -> list[str]:
    return sorted({
        f"{method} {path} {rule.level}{' reads-only' if rule.reads_only else ''}"
        for method, path, _route, _dep, rule in _eligible()
    })


# ── The registry and the app agree ──────────────────────────────────


def test_the_walk_sees_the_surface():
    assert len(list(_eligible())) > 100


def test_every_entry_is_a_routed_handler():
    routed = {_key(route) for _m, _p, route, _d in _routes()}
    missing = sorted(set(SURFACE) - routed)
    assert not missing, (
        f"named on the API key surface but not routed: {missing} — renamed or "
        f"removed handlers must leave the surface with them"
    )


def test_every_entry_has_a_level():
    assert {rule.level for rule in SURFACE.values()} <= set(LEVELS)


def test_only_posts_are_marked_as_changing_nothing():
    wrong = sorted(
        f"{method} {path}" for method, path, _r, _d, rule in _eligible()
        if rule.reads_only and method != "POST"
    )
    assert not wrong, f"reads_only is for POSTs that read; these are not POSTs: {wrong}"


def test_nothing_on_the_surface_needs_more_than_a_key_can_hold():
    """A route gated on a permission no key can carry (administration) has no
    business on the surface: a key would only ever be refused there."""
    too_much = sorted(
        f"{method} {path} needs {perm}"
        for method, path, _r, dependant, _rule in _eligible()
        for call in _calls(dependant)
        for perm in [getattr(call, "required_permission", None)]
        if perm and perm not in KEY_GRANTABLE_PERMISSIONS
    )
    assert not too_much, too_much


# ── Every level is fenced the way it says ───────────────────────────


@pytest.mark.parametrize("level", [RESOURCE])
def test_every_resource_route_is_fenced(level):
    unfenced = []
    for method, path, route, dependant, rule in _eligible():
        if rule.level != level:
            continue
        names = {getattr(call, "__name__", "") for call in _calls(dependant)}
        gated = any(getattr(c, "accepts_view_capability", False) for c in _calls(dependant))
        if (_path_names(dependant) & _FENCED_PATH_PARAMS) or gated or (
            names & _FENCING_DEPENDENCIES
        ):
            continue
        unfenced.append(f"{method} {path}")
    assert not unfenced, (
        f"RESOURCE routes nothing holds to the key's selection: {unfenced}. Name the "
        f"resource in the path, put the route behind the capability gate or a resolver "
        f"that holds it (graph_in_workspace, …), or give it another level."
    )


def test_a_resource_route_taking_a_data_source_pins_it_to_the_view():
    """The boundary lets a covered ``viewId`` vouch for its own data source on a
    read. That is the capability gate's contract only where the gate pins the
    source — or where nothing reads the source at all: the gate's workspace-
    metadata variant takes ``dataSourceId`` for its own tenant check, and the
    handlers behind it never look at one."""
    loose = []
    for method, path, route, dependant, rule in _eligible():
        if rule.level != RESOURCE or "dataSourceId" not in _query_names(dependant):
            continue
        gates = [c for c in _calls(dependant) if getattr(c, "accepts_view_capability", False)]
        pinned = any(getattr(g, "pins_data_source", False) for g in gates)
        handler_reads_it = "dataSourceId" in {
            p.alias or p.name for p in route.dependant.query_params
        }
        if not gates or (handler_reads_it and not pinned):
            loose.append(f"{method} {path}")
    assert not loose, sorted(loose)


def test_every_data_source_route_names_its_workspace_and_source():
    wrong = sorted(
        f"{method} {path}"
        for method, path, _r, dependant, rule in _eligible()
        if rule.level == DATA_SOURCE and not (
            "ws_id" in _path_names(dependant) and "dataSourceId" in _query_names(dependant)
        )
    )
    assert not wrong, wrong


def test_every_workspace_route_names_its_workspace_or_checks_it_in_the_handler():
    wrong = sorted(
        f"{method} {path}"
        for method, path, route, dependant, rule in _eligible()
        if rule.level == WORKSPACE
        and not (_path_names(dependant) & {"ws_id", "workspace_id"})
        and _key(route) not in _WORKSPACE_CHECKED_IN_HANDLER
    )
    assert not wrong, wrong


def test_a_filtered_route_names_no_single_resource_in_its_path():
    """A filtered route narrows its own results; one that names a view or data
    source in its path acts on that resource and belongs at RESOURCE."""
    wrong = sorted(
        f"{method} {path}"
        for method, path, _r, dependant, rule in _eligible()
        if rule.level == FILTERED and _path_names(dependant) & _FENCED_PATH_PARAMS
    )
    assert not wrong, wrong


async def test_a_view_never_opens_a_route_naming_its_data_source_in_the_path(monkeypatch):
    """A covered view vouches for its own data source only as the
    ``dataSourceId`` the capability gate pins to it. A data source named in
    the path is a route about that source itself — its jobs, readiness, pull
    requests — and every one of them refuses a key holding only a view of it,
    however the request also names the pair."""
    import dataclasses

    from fastapi import HTTPException

    from backend.app.auth import api_key_auth
    from backend.app.services.permission_service import key_scope_from_profile

    places = {
        ("view", "v_1"): api_key_auth._Place("ws_1", "ds_1"),
        ("data_source", "ds_1"): api_key_auth._Place("ws_1"),
    }

    async def _locate(kind, ids):
        return {i: places.get((kind, i), api_key_auth._NOWHERE) for i in ids}

    monkeypatch.setattr(api_key_auth, "_locate", _locate)
    scope = dataclasses.replace(
        key_scope_from_profile(
            "apk_surface", kind="personal", permissions={"views": "read", "data": "read"},
            resources={"views": ["v_1"]},
        ),
        view_workspaces={"v_1": "ws_1"},
    )
    checked = []
    for method, path, _route, dependant, rule in _eligible():
        names = _path_names(dependant)
        if not names & {"ds_id", "data_source_id"}:
            continue
        values = {name: "ds_1" if name in ("ds_id", "data_source_id")
                  else "ws_1" if name in ("ws_id", "workspace_id") else "x"
                  for name in names}
        request = type("Request", (), {
            "path_params": values,
            "query_params": {"viewId": "v_1", "dataSourceId": "ds_1"},
        })()
        with pytest.raises(HTTPException) as refused:
            await api_key_auth._fence(request, rule, scope, reads=method == "GET")
        assert refused.value.status_code == 403, f"{method} {path}"
        assert refused.value.detail["error"] == "api_key_out_of_scope", f"{method} {path}"
        checked.append(f"{method} {path}")
    assert len(checked) >= 10, checked


# ── The reviewed snapshot ───────────────────────────────────────────


def test_the_surface_is_the_reviewed_one():
    current = _snapshot_lines()
    if os.getenv("UPDATE_API_KEY_SURFACE"):
        _SNAPSHOT.write_text("\n".join(current) + "\n", encoding="utf-8")
    reviewed = _SNAPSHOT.read_text(encoding="utf-8").splitlines()
    opened = sorted(set(current) - set(reviewed))
    closed = sorted(set(reviewed) - set(current))
    assert not opened and not closed, (
        "The routes an API key can call changed.\n"
        + "".join(f"  + {line}\n" for line in opened)
        + "".join(f"  - {line}\n" for line in closed)
        + "If that is intended, regenerate the snapshot (see this file's docstring) "
          "and let the diff be reviewed."
    )


# ── What the API documents ──────────────────────────────────────────


def test_the_openapi_schema_marks_exactly_the_key_routes():
    app.openapi_schema = None
    schema = app.openapi()
    assert schema["components"]["securitySchemes"]["apiKey"]["scheme"] == "bearer"
    marked = {
        f"{method.upper()} {path}"
        for path, operations in schema["paths"].items()
        for method, operation in operations.items()
        if isinstance(operation, dict) and operation.get("security") == [{"apiKey": []}]
    }
    expected = {f"{method} {path}" for method, path, _rule in api_key_surface.eligible(app)}
    assert marked == expected
    assert "GET /api/v1/users/me" not in marked


# ── The schema the lookup relies on ─────────────────────────────────


def test_a_token_hash_belongs_to_one_key():
    from backend.app.db.models import ApiKeyORM

    assert any(
        isinstance(c, UniqueConstraint) and c.name == "uq_api_keys_token_hash"
        for c in ApiKeyORM.__table__.constraints
    )
