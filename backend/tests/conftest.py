"""
Test configuration: add the backend root to sys.path so that
'backend' is importable without a pyproject.toml install.
"""
import sys
import os

# Add the workspace root (parent of 'backend') to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# Cookie config is read at module-import time. Tests run over plain HTTP
# (the ASGI transport has no TLS), so disable the Secure flag here before
# anything in backend.auth_service is loaded — otherwise httpx would
# refuse to send the cookies back on subsequent requests.
os.environ.setdefault("AUTH_COOKIE_SECURE", "false")

# JWT_SECRET_KEY is mandatory (>= 32 chars) and has no ephemeral
# fallback — backend.auth_service.core.config raises at import if it is
# unset. Set a deterministic test secret before any auth module loads.
os.environ.setdefault(
    "JWT_SECRET_KEY", "test-only-jwt-secret-key-not-for-production-use"
)

# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import pytest
from fastapi import HTTPException, status
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.app.db.engine import (
    Base,
    get_db_session,
    get_provider_probe_db_session,
    get_readonly_db_session,
)
from backend.app.db import models as _models  # noqa: F401 — register ORM models
from backend.app.db.repositories import user_repo as _user_repo
from backend.app.db.repositories.refresh_token_repo import make_refresh_store
from backend.app.db.seed_feature_registry import SEED_FLAGS_CONFIG
from backend.app.services.feature_flags import feature_flags
from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
    require_admin,
)
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import (
    InMemoryBackend,
    RevocationService,
    configure_revocation_service,
    get_revocation_service,
)


# RBAC Phase 2: install the in-memory revocation backend for the whole
# test session so ``requires(...)`` doesn't hit the fail-closed Redis
# path (which would 503 every test that touches a fail-closed
# permission like ``workspace:admin``).
configure_revocation_service(RevocationService(InMemoryBackend()))
from backend.auth_service.csrf import CSRF_HEADER_NAME
from backend.auth_service.cookies import CSRF_COOKIE_NAME
from backend.auth_service.interface import User
from backend.auth_service.providers import LocalIdentityProvider, register_provider
from backend.auth_service.service import LocalIdentityService
from backend.auth_service.providers import PROVIDER_BUILDERS
from backend.auth_service.providers.registry import (
    ProviderConfigSnapshot,
    ProviderRegistry,
    configure_registry,
)
from backend.app.db.repositories import idp_provider_repo as _idp_provider_repo
from backend.app.db.repositories import user_identity_repo as _user_identity_repo


# Process-wide provider registry: register the local provider once for
# any test that hits /auth/login (or other identity-service code paths).
register_provider("local", LocalIdentityProvider())


# ---------------------------------------------------------------------------
# Fake user returned by auth overrides
#
# Endpoints now receive a ``User`` DTO from ``get_current_user`` (the
# cross-service identity contract — no more SQLAlchemy ORM leaking into
# handlers). A separate ``UserORM`` row is still inserted in the test DB
# so endpoints that resolve creator/author metadata can look the user up.
# ---------------------------------------------------------------------------
_FAKE_USER = User(
    id="usr_test000000",
    email="test@example.com",
    first_name="Test",
    last_name="User",
    # Phase 5 rename: ``admin`` -> ``super_admin``. The legacy User.role
    # field is still consulted by require_admin's legacy path; setting
    # ``super_admin`` here keeps that allow-path live for tests that
    # don't set custom permission claims.
    role="super_admin",
    status="active",
    auth_provider="local",
    created_at="2024-01-01T00:00:00Z",
    updated_at="2024-01-01T00:00:00Z",
)

# Fixed CSRF token used for every request the test client makes. Real
# clients mint this server-side on /login; here we pre-set it on both
# sides of the double-submit so handlers that POST/PUT/DELETE pass the
# CSRF middleware without each test having to log in first.
_TEST_CSRF_TOKEN = "test-csrf-token"


# ---------------------------------------------------------------------------
# Database fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def db_engine() -> AsyncEngine:
    """Create an in-memory SQLite async engine shared across all tests."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        echo=False,
        # SQLite requires this for async usage with multiple statements
        connect_args={"check_same_thread": False},
    )

    # Production models in backend/app/services/aggregation/models.py and
    # backend/app/jobs/models.py declare ``__table_args__ = ({"schema":
    # "aggregation"},)`` for Postgres. SQLite has no schemas but does
    # support attached databases addressed with the same ``db.table``
    # syntax — attach an in-memory db aliased as ``aggregation`` on every
    # new connection so ``Base.metadata.create_all`` and downstream
    # queries against ``aggregation.<table>`` resolve.
    @event.listens_for(engine.sync_engine, "connect")
    def _attach_aggregation_schema(dbapi_conn, _connection_record):
        dbapi_conn.execute("ATTACH DATABASE ':memory:' AS aggregation")

    return engine


@pytest.fixture(autouse=True)
def _feature_flags_at_their_defaults():
    """Every test starts with every flag at its shipped default, resolved from memory.

    Two problems, one fixture.

    LEAKAGE. The flag cache is a process-wide singleton with a 30-second TTL, and it does not
    know that each test gets a brand-new database. A suite that reads or PATCHes a flag leaves
    its values resident, so the NEXT test — whose `feature_flags` table is empty — gets answered
    from the previous suite's memory. Harmless while nothing on a request path read a flag; the
    moment views and semantic layers started honouring the admin's toggles, `test_api_views`
    began failing with a 403 from a flag no test in it had ever set, and passing in isolation.

    THE REAL ENGINE. Gates resolve flags through `is_enabled_self_session`, which by design opens
    its OWN session when the cache is cold — it exists for call sites with no request session. It
    therefore ignores the session this fixture set injects and connects to the REAL engine, which
    in the container is Postgres. A cold-cache gate check opens a live asyncpg connection on the
    current event loop; pytest-asyncio gives the next test a different loop; the connection
    outlives its loop and the next test dies in teardown with a 500 that has nothing to do with
    what it was testing.

    Priming the cache fixes both: the flags are the seeded defaults, they are the same for every
    test, and no gate ever reaches for a database. A test that wants a different value sets it in
    the cache (see `test_feature_gates.py::_prime`), which is also how a gate would see it in
    production — via the cache, not via a row.
    """
    feature_flags._cache = dict(SEED_FLAGS_CONFIG)
    feature_flags._cache_ts = time.monotonic()
    yield
    feature_flags.invalidate()


@pytest.fixture(autouse=True)
def _reset_revocation_backend():
    """Clear the process-global in-memory revocation set between tests.

    The revocation backend is a single session-wide singleton (installed
    above). Without a reset, a test that revokes a sid — notably the fake
    ``sess_test`` that ``test_client`` now honours — would leave every later
    test's requests 401ing. Clearing before and after keeps tests isolated."""
    backend = getattr(get_revocation_service(), "_backend", None)
    if isinstance(backend, InMemoryBackend):
        backend._set.clear()
        backend._sets.clear()
    yield
    if isinstance(backend, InMemoryBackend):
        backend._set.clear()
        backend._sets.clear()


@pytest.fixture()
def signup_enabled():
    """Turn self-registration ON for a test.

    Signup is gated behind the ``signupEnabled`` flag, a security control that
    fails CLOSED (default False, see ``auth.py``). It isn't in the seeded
    defaults, so the endpoint returns 403 unless a test opts in. Prime the flag
    in the cache — the same path a gate reads in production (see
    ``_feature_flags_at_their_defaults`` above and ``test_feature_gates._prime``)."""
    feature_flags._cache = {**(feature_flags._cache or {}), "signupEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    yield


@pytest.fixture()
async def db_session(db_engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """
    Per-test async session.

    Creates all tables before each test and rolls back after, so every test
    starts with a clean database. Repo-level tests use this fixture
    directly and so do not see any "authenticated user" — that's only
    seeded by ``test_client`` below, since it simulates a real HTTP
    request where the user exists.
    """
    async with db_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        bind=db_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    # RBAC Phase 5: seed the canonical ``roles`` / ``permissions`` /
    # ``role_permissions`` tables with the post-uplift catalogue so
    # the resolver (which queries permission_repo.get_permission_categories
    # to apply its category × scope filter) and binding endpoints have
    # something to validate against. Production seeds via the migration
    # chain; tests use create_all so we mirror the final shape here.
    async with session_factory() as _seed_session:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        # Roles — five-tier taxonomy. All system roles are stored at
        # scope_type='global' (the CHECK constraint requires
        # workspace-scoped roles to carry a concrete scope_id, which
        # template roles like workspace_admin do not have). The
        # resolver's category × scope filter ensures binding a global
        # role at workspace scope still only emits workspace:* perms.
        for name, desc in (
            ("super_admin",
             "Platform owner. Carries system:admin; implies every permission."),
            ("org_admin",
             "Cross-workspace operator — manage every workspace + create new ones."),
            ("workspace_admin",
             "Workspace administrator. Auto-implies every workspace:* permission."),
            ("workspace_member",
             "Standard workspace member — manage views and data sources."),
            ("workspace_viewer",
             "Read-only access to the bound workspace's views + data sources."),
        ):
            _seed_session.add(_models.RoleORM(
                name=name, description=desc,
                scope_type="global", scope_id=None,
                is_system=True,
                created_at=now, updated_at=now, created_by=None,
            ))
        # Permissions — catalogue with category column populated.
        for pid, pdesc, pcat in (
            ("system:admin", "Platform owner short-circuit.", "system"),
            ("system:org-admin",
             "Cross-workspace operator; implies every workspace permission.",
             "system"),
            ("system:users:manage", "Manage user accounts.", "system"),
            ("system:groups:manage", "Manage groups and memberships.", "system"),
            ("system:workspaces:create", "Create new workspaces.", "system"),
            ("workspace:admin", "Workspace administrator.", "workspace"),
            ("workspace:datasource:manage", "Manage data sources.", "workspace"),
            ("workspace:datasource:read", "Read data sources.", "workspace"),
            ("workspace:view:create", "Create views.", "workspace"),
            ("workspace:view:edit", "Edit views.", "workspace"),
            ("workspace:view:delete", "Delete views.", "workspace"),
            ("workspace:view:read", "Read views.", "workspace"),
        ):
            _seed_session.add(_models.PermissionORM(
                id=pid, description=pdesc, category=pcat,
            ))
        await _seed_session.flush()
        # Role → permission bundles.
        _role_perms = (
            [("super_admin", p) for p in (
                "system:admin", "system:org-admin",
                "system:users:manage", "system:groups:manage",
                "system:workspaces:create", "workspace:admin",
                "workspace:datasource:manage", "workspace:datasource:read",
                "workspace:view:create", "workspace:view:edit",
                "workspace:view:delete", "workspace:view:read",
            )]
            + [("org_admin", p) for p in (
                "system:org-admin", "system:groups:manage",
                "system:workspaces:create", "workspace:admin",
                "workspace:datasource:manage", "workspace:datasource:read",
                "workspace:view:create", "workspace:view:edit",
                "workspace:view:delete", "workspace:view:read",
            )]
            + [("workspace_admin", "workspace:admin")]
            + [("workspace_member", p) for p in (
                "workspace:datasource:manage", "workspace:datasource:read",
                "workspace:view:create", "workspace:view:edit",
                "workspace:view:delete", "workspace:view:read",
            )]
            + [("workspace_viewer", p) for p in (
                "workspace:datasource:read", "workspace:view:read",
            )]
        )
        for role_name, perm_id in _role_perms:
            _seed_session.add(_models.RolePermissionORM(
                role_name=role_name, permission_id=perm_id,
            ))
        await _seed_session.commit()

    async with session_factory() as session:
        yield session
        await session.rollback()

    # Drop all tables so the next test gets a truly clean slate
    async with db_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


# ---------------------------------------------------------------------------
# Auth override fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_user() -> User:
    """The stub user object injected by auth overrides."""
    return _FAKE_USER


# ---------------------------------------------------------------------------
# FastAPI test client
# ---------------------------------------------------------------------------

@pytest.fixture()
async def test_client(
    db_session: AsyncSession,
) -> AsyncGenerator[AsyncClient, None]:
    """
    httpx.AsyncClient wired to the FastAPI app with dependency overrides so
    that tests hit an in-memory SQLite DB and skip real authentication.
    """
    # Import app lazily to avoid triggering lifespan / real DB init at
    # import time.
    from backend.app.main import app

    # --- dependency overrides ---

    # Persist the fake user row so endpoints that resolve creator /
    # author metadata (e.g. GET /views/facets) can look them up,
    # mirroring production where the authenticated user has a matching
    # row in the ``users`` table. Kept out of the ``db_session`` fixture
    # so raw-DB tests aren't polluted with an extra user they didn't
    # create.
    db_session.add(_models.UserORM(
        id=_FAKE_USER.id,
        email=_FAKE_USER.email,
        password_hash="not-a-real-hash",
        first_name=_FAKE_USER.first_name,
        last_name=_FAKE_USER.last_name,
        status=_FAKE_USER.status,
        # Phase 3: auth_provider lives on user_identities now. The fake
        # user is local-only so no identity row is needed.
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    ))
    db_session.add(_models.UserRoleORM(
        user_id=_FAKE_USER.id,
        role_name=_FAKE_USER.role,
    ))
    await db_session.commit()

    async def _override_get_db_session():
        yield db_session

    async def _override_get_current_user():
        # Mirror the real dependency's revocation check (see
        # ``get_current_user`` in auth/dependencies.py) for the fake session
        # sid, so the dynamic-permission revocation chain is exercisable
        # through the test client. Normal tests never revoke ``sess_test``,
        # so this is a no-op for them; the ``_reset_revocation_backend``
        # autouse fixture keeps a revoking test from leaking into the next.
        if await get_revocation_service().is_revoked("sess_test"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session revoked",
            )
        return _FAKE_USER

    async def _override_get_optional_user():
        # Tests always "have" an authenticated user, so get_optional_user
        # returns the same stub as get_current_user. Without this override,
        # endpoints that use get_optional_user (e.g. create_view) would see
        # a None token and fall back to the anonymous sentinel, breaking
        # created_by attribution in test assertions.
        return _FAKE_USER

    async def _override_require_admin():
        return _FAKE_USER

    # RBAC Phase 2: ``requires(...)`` reads permission claims from the
    # JWT cookie. The test client doesn't carry a JWT, so we synthesize
    # claims for the fake admin here. ``system:admin`` in the global
    # permission set triggers the implicit-allow shortcut in
    # ``has_permission``, so every ``requires(...)`` dependency passes
    # for the fake user without each test having to thread a real JWT
    # through. Tests that need to verify 403 behaviour for non-admins
    # can override this fixture per-test.
    def _override_get_permission_claims():
        return PermissionClaims(
            sid="sess_test",
            global_perms=("system:admin",),
            ws_perms={},
        )

    app.dependency_overrides[get_db_session] = _override_get_db_session
    app.dependency_overrides[get_readonly_db_session] = _override_get_db_session
    # PROVIDER_PROBE-pool endpoints (/admin/providers/status, /{id}/test)
    # use their own session dependency — without this override they hit
    # the real (uninitialized) engine and 503 in every test.
    app.dependency_overrides[get_provider_probe_db_session] = _override_get_db_session
    app.dependency_overrides[get_current_user] = _override_get_current_user
    app.dependency_overrides[get_optional_user] = _override_get_optional_user
    app.dependency_overrides[require_admin] = _override_require_admin
    app.dependency_overrides[get_permission_claims] = _override_get_permission_claims

    # Wire a real IdentityService against the per-test session so
    # /api/v1/auth/* endpoints can be exercised end-to-end.
    #
    # NOTE: this factory does NOT model production transaction
    # semantics, and it cannot. Production passes ``get_async_session``,
    # which commits on success and rolls back on exception; this yields
    # one shared session that does neither. It cannot be fixed in place
    # either: ``db_engine`` is in-memory SQLite, which SQLAlchemy backs
    # with a StaticPool, so every session here checks out the SAME
    # connection and there is only ever one transaction to speak of.
    #
    # Consequence: any bug about work being rolled back — or about
    # writes that must survive their caller's rollback — is INVISIBLE to
    # tests built on this fixture. That is how the refresh-family
    # revocations came to be silently discarded in production while
    # ``test_auth_cookie_flow.py`` reported them working. Tests that
    # depend on real transaction boundaries need their own file-backed
    # engine; see ``test_auth_revocation_durability.py`` for the setup,
    # including the pysqlite savepoint workaround it needs.
    @asynccontextmanager
    async def _test_session_factory():
        yield db_session

    previous_identity_service = getattr(app.state, "identity_service", None)
    app.state.identity_service = LocalIdentityService(
        session_factory=_test_session_factory,
        user_repo=_user_repo,
        refresh_store_factory=make_refresh_store,
    )

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
        # Pre-load the CSRF double-submit so non-GET requests pass the
        # middleware without each test having to walk through /login.
        cookies={CSRF_COOKIE_NAME: _TEST_CSRF_TOKEN},
        headers={CSRF_HEADER_NAME: _TEST_CSRF_TOKEN},
    ) as client:
        yield client

    # Clean up overrides so they don't leak between test modules
    app.dependency_overrides.clear()
    app.state.identity_service = previous_identity_service


@pytest.fixture()
async def csrf_client(
    test_client: AsyncClient,
) -> AsyncGenerator[AsyncClient, None]:
    """A client that carries NO CSRF cookie or header, so ``CSRFMiddleware``
    actually runs.

    ``test_client`` pre-seeds both halves of the double-submit (see above),
    which is the right default — hundreds of tests would otherwise have to
    walk through /login first. The cost is that the middleware is a no-op for
    the entire suite, and a route wrongly left un-exempt looks fine in tests
    while 403ing in production. That is exactly how the SAML ACS endpoint —
    an IdP-originated cross-site form POST that cannot carry a header — stayed
    broken.

    Depends on ``test_client`` so the app overrides and IdentityService wiring
    are already installed; this only swaps the transport for one without the
    tokens.
    """
    from backend.app.main import app

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(
        transport=transport, base_url="http://testserver",
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# SSO fixtures
#
# Shared rather than per-module: any test that drives a slug-routed
# ``/auth/{slug}/...`` endpoint needs the provider registry wired to the
# per-test session, and any test that asserts on SSO auditing needs an
# IdentityService with the SSO repos attached. The conftest default
# ``test_client`` service is local-password only, so ``complete_sso_login``
# would bail with ``identity_repo_unavailable``.
# ---------------------------------------------------------------------------

@pytest.fixture()
async def registry(db_session):
    """Wire the process registry to the per-test session so the
    slug-routed endpoints resolve real ``idp_providers`` rows."""
    class _Loader:
        @staticmethod
        def _snap(row):
            return ProviderConfigSnapshot(
                id=row.id, slug=row.slug, display_name=row.display_name,
                kind=row.kind, enabled=bool(row.enabled),
                priority=int(row.priority or 100),
                settings=_idp_provider_repo.decrypt_settings(row.settings),
                claim_mapping=_idp_provider_repo.parse_claim_mapping(row),
                linking_policy=row.linking_policy,
                button_label=row.button_label, button_icon=row.button_icon,
            )

        async def get_by_id(self, provider_id):
            row = await _idp_provider_repo.get_provider(db_session, provider_id)
            return self._snap(row) if row is not None else None

        async def get_by_slug(self, slug):
            row = await _idp_provider_repo.get_provider_by_slug(db_session, slug)
            return self._snap(row) if row is not None else None

        async def list_enabled(self):
            # Must mirror the real loader in ``main.py``, which asks for
            # PUBLIC providers (enabled AND published). Calling
            # ``list_providers(only_enabled=True)`` here instead would make
            # this double disagree with production about what the world can
            # see — the one thing a stand-in for a visibility boundary must
            # never do.
            rows = await _idp_provider_repo.list_public_providers(db_session)
            return [self._snap(r) for r in rows]

    reg = ProviderRegistry(loader=_Loader(), builders=PROVIDER_BUILDERS,
                           ttl_seconds=0)
    configure_registry(reg)
    yield reg
    await reg.invalidate()


@pytest.fixture()
def sso_events(db_session):
    """Install an ``IdentityService`` on the app that has the SSO repos
    wired (the conftest default is local-password only, so
    ``complete_sso_login`` would bail with ``identity_repo_unavailable``).
    Yields the captured outbox events."""
    from backend.app.main import app

    events: list[tuple[str, dict]] = []

    @asynccontextmanager
    async def _factory():
        yield db_session

    async def _outbox(session, event_type, payload):
        events.append((event_type, payload))

    previous = getattr(app.state, "identity_service", None)
    app.state.identity_service = LocalIdentityService(
        session_factory=_factory,
        user_repo=_user_repo,
        user_identity_repo=_user_identity_repo,
        refresh_store_factory=lambda s: None,
        outbox_emit=_outbox,
        claims_resolver=None,
    )
    yield events
    app.state.identity_service = previous


