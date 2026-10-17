"""The world the API key tests run in, and a client that sees it as a script would.

Shared by ``test_api_key_auth`` (the request path) and ``test_api_keys_api``
(managing keys). The client runs the real auth dependencies over the test
database; the graph and versioning backends are stubbed where a request would
otherwise need them, answering 418 "reached the handler" — the success signal
for a request that got past every gate.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from backend.app.auth import api_key_auth
from backend.app.db import engine as db_engine
from backend.app.db.engine import (
    get_db_session,
    get_graph_read_db_session,
    get_provider_probe_db_session,
    get_readonly_db_session,
)
from backend.app.db.models import (
    IdpProviderReachabilityORM,
    ProviderORM,
    RoleBindingORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import (
    api_key_repo,
    app_auth_config_repo,
    grant_repo,
    user_identity_repo,
    user_repo,
)
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.app.services import api_key_service, api_key_usage, idp_reachability
from backend.app.services.feature_flags import feature_flags
from backend.auth_service.app_auth_config import AuthConfigSnapshot, CachedAuthConfigProvider
from backend.auth_service.core import api_keys
from backend.auth_service.ratelimit import reset_account_limiter_for_tests
from backend.auth_service.service import LocalIdentityService

OWNER = "usr_keyowner"
OTHER = "usr_keyother"


# ── The world ───────────────────────────────────────────────────────


def user_row(user_id: str, *, password: bool = True, status: str = "active") -> UserORM:
    return UserORM(
        id=user_id, email=f"{user_id}@example.com",
        password_hash="not-a-real-hash" if password else "x-disabled-password-x",
        first_name="Key", last_name="Owner", status=status,
    )


async def world(session) -> None:
    """The owner is a member of ws_a, only a viewer in ws_b, and holds an
    editor grant on one private view there. ws_a has two data sources."""
    session.add(user_row(OWNER))
    session.add(user_row(OTHER))
    for ws in ("ws_a", "ws_b"):
        session.add(WorkspaceORM(id=ws, name=ws))
    session.add(ProviderORM(id="prov", name="prov", provider_type="mock", permitted_workspaces="[]"))
    for ds, ws in (("ds_a", "ws_a"), ("ds_a2", "ws_a"), ("ds_b", "ws_b")):
        session.add(WorkspaceDataSourceORM(id=ds, workspace_id=ws, provider_id="prov"))
    await session.flush()  # the views below name these data sources
    for vid, ws, visibility, creator, ds in (
        ("v_a_ws", "ws_a", "workspace", OTHER, "ds_a"),
        ("v_a_mine", "ws_a", "private", OWNER, None),
        ("v_a_theirs", "ws_a", "private", OTHER, None),
        ("v_b_granted", "ws_b", "private", OTHER, None),
        ("v_b_other", "ws_b", "workspace", OTHER, None),
    ):
        session.add(ViewORM(
            id=vid, name=vid, workspace_id=ws, visibility=visibility,
            created_by=creator, data_source_id=ds,
        ))
    session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="workspace_member",
        scope_type="workspace", scope_id="ws_a",
    ))
    session.add(RoleBindingORM(
        subject_type="user", subject_id=OWNER, role_name="workspace_viewer",
        scope_type="workspace", scope_id="ws_b",
    ))
    await session.flush()
    await grant_repo.create_grant(
        session, resource_type="view", resource_id="v_b_granted",
        subject_type="user", subject_id=OWNER, role_name="editor",
    )
    await session.commit()


@dataclass(frozen=True)
class Key:
    id: str
    token: str

    @property
    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}


async def mint(
    session, user_id: str = OWNER, *, views: str = "none", data: str = "none",
    publish: bool = False, resources="all", **overrides,
) -> Key:
    generated = api_keys.generate()
    fields = dict(
        user_id=user_id, kind="personal", created_by=user_id, name="ci key",
        description=None, token_prefix=generated.display_prefix,
        token_hash=generated.token_hash,
        permissions={"views": views, "data": data, "publish": publish},
        resources=resources, allowed_cidrs=None, expires_at=None,
        created_ip=None, created_user_agent=None,
    )
    fields.update(overrides)
    row = await api_key_repo.create(session, **fields)
    await session.commit()
    return Key(id=row.id, token=generated.token)


def days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


async def confirmed_down(session, provider_id: str) -> IdpProviderReachabilityORM:
    """The reachability prober's record of a connection confirmed down: seen
    working, unreachable for longer than it takes to confirm, checked just
    now. Delete it, and the connection is back."""
    now = datetime.now(timezone.utc)
    row = IdpProviderReachabilityORM(
        provider_id=provider_id,
        last_ok_at=(now - timedelta(minutes=10)).isoformat(),
        unreachable_since=(now - timedelta(minutes=5)).isoformat(),
        checked_at=now.isoformat(),
    )
    session.add(row)
    await session.commit()
    return row


def prime(**flags) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), **flags}


def error(response) -> str:
    return response.json()["detail"]["error"]


# ── The client ──────────────────────────────────────────────────────


def reached_the_handler():
    raise HTTPException(status_code=418, detail="reached the handler")


_GRAPHS = {
    gid: {
        "graph_id": gid, "workspace_id": ws, "tenant_id": None, "data_source_id": ds,
        "kind": "source", "base_ontology_id": None, "fork_parent_graph_id": parent,
        "fork_base_commit_seq": None, "main_head_commit_seq": 1,
        "created_by": OTHER, "created_at": "2026-01-01T00:00:00+00:00",
    }
    for gid, ws, ds, parent in (
        ("g_a", "ws_a", "ds_a", None), ("g_a2", "ws_a", "ds_a2", None),
        # A fork of g_a2 whose own data source is ds_a.
        ("g_fork", "ws_a", "ds_a", "g_a2"),
    )
}
#: Each draft, and the graph it belongs to.
_BRANCHES = {"br_a": "g_a", "br_a2": "g_a2"}


class _FakeVersioning:
    async def get_graph(self, graph_id):
        return _GRAPHS.get(graph_id)

    async def get_graph_by_data_source(self, _data_source_id):
        reached_the_handler()

    async def assert_branch_readable(self, *, graph_id, branch_id, viewer):
        if _BRANCHES.get(branch_id) != graph_id:
            raise ValueError("unknown graph/branch")

    async def preview_merge(self, **_kwargs):
        reached_the_handler()

    async def open_pr(self, **_kwargs):
        reached_the_handler()


class _FakeImports:
    async def create_import_job(self, **_kwargs):
        reached_the_handler()


@asynccontextmanager
async def api_key_app(db_session, monkeypatch):
    """The app over the test database with the real auth dependencies, the
    world seeded, and no CSRF cookie: a script's view of the API. Wrap it in
    a fixture where it is used."""
    from backend.app.api.v1.endpoints import graph as graph_endpoints
    from backend.app.api.v1.endpoints import versioning as versioning_endpoints
    from backend.app.main import app

    async def _session_dependency():
        yield db_session

    @asynccontextmanager
    async def _sessions():
        yield db_session

    for dependency in (
        get_db_session, get_readonly_db_session, get_graph_read_db_session,
        get_provider_probe_db_session,
    ):
        app.dependency_overrides[dependency] = _session_dependency
    app.dependency_overrides[graph_endpoints.get_context_engine] = reached_the_handler
    app.dependency_overrides[versioning_endpoints.get_versioning_service] = _FakeVersioning
    app.dependency_overrides[versioning_endpoints.get_import_export_service] = _FakeImports
    # The resource fence looks resources up in a session of its own.
    monkeypatch.setattr(db_engine, "get_async_session", _sessions)

    async def _posture() -> AuthConfigSnapshot:
        # As ``main._load_auth_config``: the stored switches and the
        # prober's confirmed outages — read on every call, so a test sets
        # them the way an administrator or the prober does.
        snap = await app_auth_config_repo.get_snapshot(db_session)
        slugs, since = await idp_reachability.read_confirmed_outage(_sessions)
        return AuthConfigSnapshot(
            sso_enabled=snap.sso_enabled,
            allow_local_login=snap.allow_local_login,
            allow_jit_provisioning=snap.allow_jit_provisioning,
            email_first_login=snap.email_first_login,
            password_fallback_until=snap.password_fallback_until,
            sso_outage_slugs=slugs,
            sso_outage_since=since,
            version=snap.version,
            updated_at=snap.updated_at,
        )

    previous = getattr(app.state, "identity_service", None)
    app.state.identity_service = LocalIdentityService(
        session_factory=_sessions,
        user_repo=user_repo,
        user_identity_repo=user_identity_repo,
        refresh_store_factory=make_refresh_store,
        api_key_repo=api_key_repo,
        api_key_claims_resolver=api_key_service.claims_for_key,
        api_key_rejection_hook=api_key_service.record_rejection,
        auth_config_provider=CachedAuthConfigProvider(_posture, ttl_seconds=0),
    )
    api_key_service.reset_for_tests()
    api_key_auth.reset_for_tests()
    api_key_usage.recorder.reset()
    reset_account_limiter_for_tests()
    try:
        await world(db_session)
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield http
    finally:
        app.dependency_overrides.clear()
        app.state.identity_service = previous
        api_key_service.reset_for_tests()
        api_key_auth.reset_for_tests()
        api_key_usage.recorder.reset()
        reset_account_limiter_for_tests()
