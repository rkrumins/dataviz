import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse

from .api.v1.api import api_router
from .db.engine import init_db, close_db, get_async_session, get_jobs_session, BootstrapError
from .db.seed_templates import seed_templates
from .db.repositories import user_repo
from .db.repositories.refresh_token_repo import make_refresh_store
from .middleware.request_id import RequestIdMiddleware
from .middleware.logging import StructuredLoggingMiddleware, configure_json_logging
from .middleware.security_headers import SecurityHeadersMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from .providers.manager import provider_manager
from backend.auth_service.csrf import CSRFMiddleware
from backend.auth_service.providers import LocalIdentityProvider, register_provider
from backend.auth_service.service import LocalIdentityService

logger = logging.getLogger(__name__)

try:
    from redis.exceptions import ConnectionError as _RedisConnectionError
    from redis.exceptions import TimeoutError as _RedisTimeoutError
except Exception:  # pragma: no cover - redis is part of runtime deps
    _RedisConnectionError = ConnectionError
    _RedisTimeoutError = TimeoutError


# ------------------------------------------------------------------ #
# Lifespan                                                             #
# ------------------------------------------------------------------ #

async def _degraded_recovery_loop(_app: FastAPI, interval: float = 15.0) -> None:
    """Background task: probe the management DB every `interval` seconds.
    On first successful probe, clear the degraded flag. We do NOT re-run
    seeds / auth / aggregation init — the operator should restart the
    service for full functionality. The flag clears so that DB-backed
    endpoints stop 503-ing and the health endpoint reports healthy.
    """
    from .db.engine import get_engine
    from sqlalchemy import text as _sa_text

    logger.info(
        "Degraded-mode recovery loop started (interval=%.0fs, reason=%s)",
        interval, getattr(_app.state, "degraded_reason", "unknown"),
    )
    while True:
        try:
            await asyncio.sleep(interval)
            engine = get_engine()
            async with engine.connect() as conn:
                await conn.execute(_sa_text("SELECT 1"))
            _app.state.degraded = False
            prev_reason = getattr(_app.state, "degraded_reason", None)
            _app.state.degraded_reason = None
            logger.info(
                "Recovery complete — transitioned from degraded to healthy "
                "(was: %s). Restart the service to rerun bootstrap (seeds, "
                "admin, aggregation) for full functionality.",
                prev_reason,
            )
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("Degraded recovery probe failed: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup / shutdown lifecycle.

    If bootstrap (DB migration, seeds, auth init) fails, the app starts in
    degraded mode: `app.state.degraded = True` and a background task
    probes the DB periodically. DB-backed endpoints will surface 503s via
    the existing OperationalError handler; the health endpoint reports
    degraded explicitly. The operator can fix the DB (e.g. `./dev.sh
    repair`) and either restart or wait for the recovery loop to clear
    the flag.
    """
    configure_json_logging()

    _app.state.degraded = False
    _app.state.degraded_reason = None
    _app.state._recovery_task = None

    # 1. Initialise management DB tables (idempotent — safe to run every restart)
    try:
        await init_db()
    except BootstrapError as exc:
        _app.state.degraded = True
        _app.state.degraded_reason = exc.reason
        logger.error(
            "Bootstrap failed — starting in degraded mode (reason=%s):\n%s",
            exc.reason, exc,
        )
        _app.state._recovery_task = asyncio.create_task(
            _degraded_recovery_loop(_app)
        )
        yield
        # Shutdown path for degraded start
        if _app.state._recovery_task and not _app.state._recovery_task.done():
            _app.state._recovery_task.cancel()
            try:
                await _app.state._recovery_task
            except asyncio.CancelledError:
                pass
        await close_db()
        logger.info("Synodic Visualization Service stopped (was degraded)")
        return
    except Exception as exc:
        _app.state.degraded = True
        _app.state.degraded_reason = "database_unavailable"
        logger.error(
            "Bootstrap failed with unexpected error — starting in degraded mode: %s",
            exc,
        )
        _app.state._recovery_task = asyncio.create_task(
            _degraded_recovery_loop(_app)
        )
        yield
        if _app.state._recovery_task and not _app.state._recovery_task.done():
            _app.state._recovery_task.cancel()
            try:
                await _app.state._recovery_task
            except asyncio.CancelledError:
                pass
        await close_db()
        logger.info("Synodic Visualization Service stopped (was degraded)")
        return

    # 2. Seed Quick Start Templates (idempotent — skips if already present)
    async with get_async_session() as session:
        await seed_templates(session)

    # 2a. Seed feature system — each seed gets its own session so a failure
    #      in one (e.g. multi-worker IntegrityError) doesn't roll back the others.
    from .db.seed_feature_registry import seed_feature_registry, seed_feature_flags, seed_feature_registry_meta  # noqa: E402
    try:
        async with get_async_session() as session:
            await seed_feature_registry(session)
    except Exception as exc:
        logger.warning("Feature registry seed warning: %s", exc)
    try:
        async with get_async_session() as session:
            await seed_feature_flags(session)
    except Exception as exc:
        logger.warning("Feature flags seed warning: %s", exc)
    try:
        async with get_async_session() as session:
            await seed_feature_registry_meta(session)
    except Exception as exc:
        logger.warning("Feature registry meta seed warning: %s", exc)

    # 2b. Seed system default ontology (idempotent — merge-not-overwrite strategy)
    try:
        from .ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from .ontology.service import LocalOntologyService
        async with get_async_session() as session:
            repo = SQLAlchemyOntologyRepository(session)
            svc = LocalOntologyService(repo)
            await svc.seed_system_defaults()
            await session.commit()
    except Exception as exc:
        logger.warning("System default ontology seed warning: %s", exc)

    # 2c. Bootstrap system admin (idempotent — skips if any user exists)
    # Always ensures at least one admin account is present.
    # Customizable via ADMIN_EMAIL / ADMIN_PASSWORD env vars; defaults provided.
    try:
        import os
        from .db.repositories import user_repo
        from .auth.password import hash_password
        admin_email = os.getenv("ADMIN_EMAIL", "admin@nexuslineage.local")
        admin_password = os.getenv("ADMIN_PASSWORD", "changeme")
        async with get_async_session() as session:
            user_count = await user_repo.count_users(session)
            if user_count == 0:
                user = await user_repo.create_user(
                    session,
                    email=admin_email,
                    password_hash=hash_password(admin_password),
                    first_name="System",
                    last_name="Admin",
                    status="active",
                )
                await user_repo.assign_role(session, user.id, "admin")
                await user_repo.create_approval(
                    session, user.id, status="approved", approved_by="system",
                )
                logger.info(
                    "System admin created: %s (change password after first login!)",
                    admin_email,
                )
    except Exception as exc:
        logger.warning("Admin bootstrap warning: %s", exc)

    # 3. Environment bootstrap is no longer auto-invoked on startup.
    #    Fresh installs go through the admin wizard; Docker quickstart /
    #    CI fixtures invoke `python -m backend.scripts.seed_default_environment`
    #    explicitly. Startup must never mutate user data.
    logger.info(
        "Startup is side-effect-free. Run "
        "`python -m backend.scripts.seed_default_environment` for dev seed; "
        "admin wizard handles production onboarding."
    )

    # 4. Wire up the auth service. The IdentityService is the single
    #    boundary every consumer crosses; today it's an in-process
    #    LocalIdentityService, tomorrow (post-extraction) a remote HTTP
    #    client implementing the same protocol.
    register_provider("local", LocalIdentityProvider())

    async def _emit_user_event(session, event_type: str, payload: dict) -> None:
        await user_repo.create_outbox_event(session, event_type=event_type, payload=payload)

    _app.state.identity_service = LocalIdentityService(
        session_factory=get_async_session,
        user_repo=user_repo,
        refresh_store_factory=make_refresh_store,
        outbox_emit=_emit_user_event,
    )
    logger.info("Auth service initialised (provider=local)")

    # 5. Wire up the aggregation service (role-gated)
    from .runtime.role import current_role, runs_scheduler, runs_recovery
    role = current_role()

    # Proxy mode: when AGGREGATION_PROXY_ENABLED=true, the viz-service
    # does NOT instantiate any aggregation objects locally. All 13
    # aggregation endpoints are proxied to the Control Plane (port 8091).
    # No dispatcher, no worker, no scheduler, no recovery.
    aggregation_proxy_enabled = os.getenv(
        "AGGREGATION_PROXY_ENABLED", "false"
    ).lower() == "true"

    if aggregation_proxy_enabled:
        logger.info(
            "Aggregation: proxy mode enabled — all endpoints forwarded to %s",
            os.getenv("AGGREGATION_SERVICE_URL", "http://localhost:8091"),
        )
        # Start event listener to sync aggregation status from Control Plane
        # into local workspace_data_sources table.
        _agg_event_listener = None
        redis_url = os.getenv("REDIS_URL")
        if redis_url:
            try:
                from .services.aggregation.redis_client import get_redis
                from .services.aggregation.event_listener import AggregationEventListener
                _agg_event_listener = AggregationEventListener(
                    redis_client=get_redis(),
                    session_factory=get_jobs_session,
                )
                _app.state._agg_event_listener = _agg_event_listener
                _app.state._agg_event_listener_task = asyncio.create_task(
                    _agg_event_listener.start()
                )
                logger.info("Aggregation event listener started (syncs status from Control Plane)")
            except Exception as exc:
                logger.warning("Aggregation event listener startup failed: %s", exc)
    else:
        try:
            from .services.aggregation import (
                AggregationService, AggregationWorker,
                InProcessDispatcher, AggregationScheduler,
            )
            from .services.aggregation.dispatcher import PostgresDispatcher
            from .runtime.role import runs_worker

            # Choose dispatcher based on role + dispatch mode.
            # - redis:     RedisStreamDispatcher  (production — workers consume via XREADGROUP)
            # - postgres:  PostgresDispatcher     (legacy — workers consume via LISTEN/NOTIFY)
            # - dual:      DualDispatcher         (migration — writes to both Redis + Postgres)
            # - inprocess: InProcessDispatcher    (dev — all-in-one single process)
            # - auto:      auto-detect from SYNODIC_ROLE + REDIS_URL presence
            dispatch_mode = os.getenv("AGGREGATION_DISPATCH_MODE", "auto")

            if dispatch_mode == "redis":
                from .services.aggregation.redis_client import get_redis
                from .services.aggregation.dispatcher import RedisStreamDispatcher
                agg_dispatcher = RedisStreamDispatcher(get_redis())
                logger.info("Aggregation dispatch: RedisStreamDispatcher (workers consume via Redis Streams)")
            elif dispatch_mode == "dual":
                from .services.aggregation.redis_client import get_redis
                from .services.aggregation.dispatcher import RedisStreamDispatcher, DualDispatcher
                agg_dispatcher = DualDispatcher(
                    postgres_dispatcher=PostgresDispatcher(get_jobs_session),
                    redis_dispatcher=RedisStreamDispatcher(get_redis()),
                )
                logger.info("Aggregation dispatch: DualDispatcher (Redis + Postgres for zero-downtime migration)")
            elif dispatch_mode == "postgres":
                agg_dispatcher = PostgresDispatcher(get_jobs_session)
                logger.info("Aggregation dispatch: PostgresDispatcher (legacy standalone worker)")
            elif dispatch_mode == "auto":
                # Auto-detect: if REDIS_URL is set and role is not worker, use Redis
                if os.getenv("REDIS_URL") and not runs_worker():
                    from .services.aggregation.redis_client import get_redis
                    from .services.aggregation.dispatcher import RedisStreamDispatcher
                    agg_dispatcher = RedisStreamDispatcher(get_redis())
                    logger.info("Aggregation dispatch: RedisStreamDispatcher (auto-detected from REDIS_URL)")
                elif not runs_worker():
                    agg_dispatcher = PostgresDispatcher(get_jobs_session)
                    logger.info("Aggregation dispatch: PostgresDispatcher (auto — no REDIS_URL)")
                else:
                    agg_worker = AggregationWorker(get_jobs_session, provider_manager)
                    agg_dispatcher = InProcessDispatcher(agg_worker)
                    logger.info("Aggregation dispatch: InProcessDispatcher (auto — worker role)")
            else:
                # inprocess or unknown — dev/single-process mode
                agg_worker = AggregationWorker(get_jobs_session, provider_manager)
                agg_dispatcher = InProcessDispatcher(agg_worker)
                logger.info("Aggregation dispatch: InProcessDispatcher (all-in-one dev mode)")

            # Get ontology service reference for monolith-mode resolution
            ontology_svc = None
            try:
                from .ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
                from .ontology.service import LocalOntologyService
                ontology_svc = LocalOntologyService(
                    SQLAlchemyOntologyRepository(None)  # session injected per-call
                )
            except Exception:
                logger.warning("Ontology service not available for aggregation — will use DB fallback")

            agg_service = AggregationService(
                dispatcher=agg_dispatcher,
                registry=provider_manager,
                session_factory=get_jobs_session,
                ontology_service=ontology_svc,
            )

            # Register as app state for endpoint access
            _app.state.aggregation_service = agg_service

            # Recovery and scheduler only run on control-plane / dev roles.
            # Web tier never starts background tasks — it is fully stateless.
            if runs_recovery():
                recovered = await agg_service.recover_interrupted_jobs()
                if recovered:
                    logger.info("Recovered %d interrupted aggregation jobs", recovered)

            if runs_scheduler():
                agg_scheduler = AggregationScheduler(get_jobs_session, provider_manager)
                asyncio.create_task(agg_scheduler.start())
                logger.info("Aggregation scheduler started")

            # Stuck-job reconciler — runs wherever the aggregation worker
            # lives. Detects rows whose worker died without writing a
            # terminal status (deploy mid-job, OOM, segfault) and marks
            # them ``failed`` with a clear reason so operators get a
            # working Resume button instead of a perpetual "running"
            # state. Sweep-only; auto-redispatch is Phase 2 work when
            # the dispatch substrate is XAUTOCLAIM-safe.
            from .services.aggregation.reconciler import run_reconciler
            _app.state._reconciler_shutdown = asyncio.Event()
            _app.state._reconciler_task = asyncio.create_task(
                run_reconciler(get_jobs_session, _app.state._reconciler_shutdown),
                name="aggregation-stuck-job-reconciler",
            )
            logger.info("Stuck-job reconciler started")

            # Cross-process cancel bridge. The web tier subscribes so
            # InProcessDispatcher-hosted jobs get cancelled instantly;
            # cancel broadcasts to OTHER processes (insights workers,
            # standalone aggregation workers) reach those processes via
            # their own CancelListeners.
            from .services.aggregation.cancel import CancelListener
            from .services.aggregation.redis_client import get_redis as _get_redis_for_cancel
            try:
                _app.state._cancel_listener = CancelListener(_get_redis_for_cancel())
                await _app.state._cancel_listener.start()
            except Exception as exc:
                logger.warning(
                    "Cancel listener failed to start (cancels will fall back "
                    "to local + direct DB write only): %s", exc,
                )
                _app.state._cancel_listener = None

            logger.info("Aggregation service started (role=%s)", role.value)
        except Exception as exc:
            logger.warning("Aggregation service startup warning: %s", exc)

    # Background provider warmup loop — the single source of provider
    # health observability. The loop probes each registered provider via
    # preflight() in round-robin and updates ``app.state.provider_warmup_cache``
    # so that EVERY status / health endpoint can read state from memory
    # instead of triggering live outbound work on the request path. With
    # this loop in place, hosting 1 or 100 providers — any number of
    # them unreachable — never affects the request path.
    _app.state._warmup_shutdown = asyncio.Event()
    try:
        from .providers.warmup import run_provider_warmup_loop
        from .db.engine import get_provider_probe_session
        from .db.repositories import provider_repo as _provider_repo

        async def _list_providers_for_warmup():
            async with get_provider_probe_session() as session:
                rows = await _provider_repo.list_providers(session)
                out = []
                for row in rows:
                    creds = await _provider_repo.get_credentials(session, row.id)
                    out.append({
                        "id": row.id,
                        "provider_type": (
                            row.provider_type.value
                            if hasattr(row.provider_type, "value")
                            else str(row.provider_type)
                        ),
                        "host": row.host,
                        "port": row.port,
                        "tls": row.tls_enabled,
                        "creds": creds,
                    })
                return out

        def _build_provider_for_warmup(cfg):
            return provider_manager._create_provider_instance(
                cfg["provider_type"],
                cfg.get("host"),
                cfg.get("port"),
                None,
                cfg.get("tls", False),
                cfg.get("creds") or {},
            )

        _app.state._warmup_task = asyncio.create_task(
            run_provider_warmup_loop(
                cache=provider_manager.warmup_cache,
                shutdown_event=_app.state._warmup_shutdown,
                list_providers=_list_providers_for_warmup,
                build_instance=_build_provider_for_warmup,
            ),
            name="provider-warmup-loop",
        )
        logger.info("Provider warmup loop scheduled")
    except Exception as exc:
        logger.warning(
            "Provider warmup loop failed to start: %s — status endpoints "
            "will fall back to in-memory breaker state only", exc,
        )
        _app.state._warmup_task = None

    logger.info("Synodic Visualization Service started (role=%s)", role.value)
    yield

    # Shutdown — stop event listener, release providers, close connections.

    # Stop the background warmup loop FIRST so it doesn't try to probe
    # providers during DB / pool teardown.
    _warmup_shutdown = getattr(_app.state, "_warmup_shutdown", None)
    _warmup_task = getattr(_app.state, "_warmup_task", None)
    if _warmup_shutdown is not None:
        _warmup_shutdown.set()
    if _warmup_task is not None and not _warmup_task.done():
        try:
            await asyncio.wait_for(_warmup_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            _warmup_task.cancel()
            try:
                await _warmup_task
            except (asyncio.CancelledError, Exception):
                pass

    # Stop the stuck-job reconciler so it doesn't try to commit during
    # DB pool teardown. Setting the shutdown event lets it exit at the
    # next sleep boundary; the cancel + await is the belt-and-braces
    # path for the case where it's mid-sweep.
    _reconciler_shutdown = getattr(_app.state, "_reconciler_shutdown", None)
    _reconciler_task = getattr(_app.state, "_reconciler_task", None)
    if _reconciler_shutdown is not None:
        _reconciler_shutdown.set()
    if _reconciler_task is not None and not _reconciler_task.done():
        try:
            await asyncio.wait_for(_reconciler_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            _reconciler_task.cancel()
            try:
                await _reconciler_task
            except (asyncio.CancelledError, Exception):
                pass

    # Stop the cross-process cancel listener.
    _cancel_listener = getattr(_app.state, "_cancel_listener", None)
    if _cancel_listener is not None:
        try:
            await _cancel_listener.stop()
        except Exception:
            pass

    # Stop aggregation event listener (if running in proxy mode)
    _agg_listener = getattr(_app.state, "_agg_event_listener", None)
    if _agg_listener is not None:
        await _agg_listener.stop()
        _agg_task = getattr(_app.state, "_agg_event_listener_task", None)
        if _agg_task and not _agg_task.done():
            _agg_task.cancel()
            try:
                await _agg_task
            except asyncio.CancelledError:
                pass
        # Close the Redis client used by the event listener
        try:
            from .services.aggregation.redis_client import close_redis
            await close_redis()
        except Exception:
            pass
        logger.info("Aggregation event listener stopped")

    # Release all provider connection pools (with timeout so a hung
    # provider doesn't block graceful shutdown indefinitely).
    try:
        await asyncio.wait_for(provider_manager.evict_all(), timeout=5)
    except asyncio.TimeoutError:
        logger.warning("Provider shutdown timed out after 5s — forcing exit")
    await close_db()
    logger.info("Synodic Visualization Service stopped")


# ------------------------------------------------------------------ #
# App                                                                  #
# ------------------------------------------------------------------ #

app = FastAPI(
    title="Synodic Visualization Service",
    description=(
        "Graph metadata, lineage, ontology, and reference model API. "
        "Supports multiple graph database connections via ProviderRegistry."
    ),
    version="0.2.0",
    lifespan=lifespan,
)

# Rate-limit 429 handler
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Global handler for management DB failures — returns structured 503 instead of
# raw 500 with stack trace, so the frontend can show a meaningful message.
from sqlalchemy.exc import OperationalError as _SAOperationalError

@app.exception_handler(_SAOperationalError)
async def _db_operational_error_handler(_request, exc):
    logger.error("Management DB unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Management database is temporarily unavailable. Please try again."},
    )

def _provider_unavailable_payload(request, exc) -> dict:
    provider_id = request.query_params.get("connectionId")
    return {
        "detail": {
            "code": "PROVIDER_UNAVAILABLE",
            "providerId": provider_id,
            "reason": str(exc),
        }
    }


async def _provider_error_handler(request, exc):
    """Fallback handler for raw connectivity errors that bypass the circuit
    breaker (e.g. during provider instantiation). Always returns structured
    503 regardless of URL path — provider errors are provider errors."""
    logger.warning("Provider connectivity error on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content=_provider_unavailable_payload(request, exc),
    )


# Primary handler for provider failures: raised by the CircuitBreakerProxy
# around every graph-provider instance. Carries a retry-after hint and a
# sanitized reason (no redis.exceptions details leak to the client). When
# the breaker is open, this handler fires in <1ms with no network I/O.
from backend.common.adapters import ProviderUnavailable as _ProviderUnavailable


@app.exception_handler(_ProviderUnavailable)
async def _provider_unavailable_handler(request, exc: _ProviderUnavailable):
    logger.warning(
        "Provider unavailable on %s: provider=%s reason=%s retry_after=%ds",
        request.url.path, exc.provider_name, exc.reason, exc.retry_after_seconds,
    )
    return JSONResponse(
        status_code=503,
        headers={"Retry-After": str(exc.retry_after_seconds)},
        content={
            "detail": {
                "code": "PROVIDER_UNAVAILABLE",
                "providerName": exc.provider_name,
                "reason": exc.reason,
                "retryAfterSeconds": exc.retry_after_seconds,
            }
        },
    )


# Fallback handlers for raw connectivity errors that bypass the breaker
# (e.g. errors raised during provider instantiation, before the proxy is in
# place). In steady state these should be rare because every cached provider
# is breaker-wrapped.
app.add_exception_handler(ConnectionError, _provider_error_handler)
app.add_exception_handler(OSError, _provider_error_handler)
app.add_exception_handler(asyncio.TimeoutError, _provider_error_handler)
app.add_exception_handler(_RedisConnectionError, _provider_error_handler)
app.add_exception_handler(_RedisTimeoutError, _provider_error_handler)

# ------------------------------------------------------------------ #
# Timeout middleware (raw ASGI — avoids BaseHTTPMiddleware streaming   #
# issues). Wraps every HTTP request in asyncio.wait_for so a hung     #
# provider can never block a request indefinitely.                     #
# ------------------------------------------------------------------ #

class _TimeoutMiddleware:
    """ASGI middleware: tiered per-path timeout for HTTP requests.

    Tiers (first substring match wins):
        /events                       exempt entirely (SSE — long-lived by design)
        /health*                  ->  5s  (probes must be fast)
        /graph/                   -> 15s  (read queries, bounded by per-query timeouts)
        /aggregation/             -> 45s  (write-heavy operations)
        everything else           -> 30s  (default — halved from the old flat 60s)

    Response-stream invariants (P0.1, fixes the "never recovers" freeze):

        T-1  Exactly one terminal ``http.response.body`` (more_body=False) is
             sent per request, regardless of inner-app behaviour.
        T-2  If the inner app started a response and the deadline fires, we
             emit a final empty body chunk to close the stream cleanly. We
             never re-issue ``http.response.start``, never raise.
        T-3  If the inner app finished a response and the deadline fires
             *afterwards* (race), we emit nothing further.
        T-4  ``send`` is never called after a terminal body chunk has been
             sent — ``tracked_send`` short-circuits in that state.
        T-5  We use ``asyncio.timeout()`` (Python 3.11+, lexically scoped,
             integrates cleanly with cancellation) — NOT ``asyncio.wait_for``,
             which wrapped the wrong shape and orphaned the response stream.
        T-6  First state transition wins; subsequent transitions are no-ops.

    Without these invariants, a single timeout-after-response-started leaves
    the ASGI stream half-open, ``BaseHTTPMiddleware`` raises ``RuntimeError:
    No response returned`` cascading through every middleware layer, and
    uvicorn raises ``Response content shorter than Content-Length`` — which
    poisons the keepalive connection and ratchets the backend toward an
    unrecoverable state.
    """

    # Suffix-match: SSE endpoints are routed under ``.../events``.
    # Suffix not substring so we don't accidentally exempt e.g.
    # ``/api/v1/admin/events-foo`` should one ever exist.
    _SSE_PATH_SUFFIX = "/events"

    def __init__(self, app):
        self.app = app
        # Read once at startup — see backend/app/config/resilience.py for reference.
        self._tiers: list[tuple[str, float]] = [
            ("/health",        float(os.getenv("HTTP_TIMEOUT_HEALTH_SECS", "5"))),
            ("/graph/",        float(os.getenv("HTTP_TIMEOUT_GRAPH_SECS", "15"))),
            ("/aggregation/",  float(os.getenv("HTTP_TIMEOUT_AGGREGATION_SECS", "45"))),
        ]
        self._default_timeout: float = float(os.getenv("HTTP_TIMEOUT_DEFAULT_SECS", "30"))

    def _resolve_timeout(self, path: str) -> float:
        for pattern, timeout in self._tiers:
            if pattern in path:
                return timeout
        return self._default_timeout

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # SSE bypass — let the stream run until the client disconnects
        # or the worker emits a terminal event and the handler closes
        # the response. No timeout, no cancellation, no spurious
        # "Request timed out after response started" log noise.
        if path.endswith(self._SSE_PATH_SUFFIX):
            await self.app(scope, receive, send)
            return

        timeout = self._resolve_timeout(path)
        original_send = send

        # ASGI guarantees sends within a single request are sequential within
        # the inner task — no concurrent ``tracked_send`` invocations. The
        # timeout handler below runs ONLY after the inner task is cancelled,
        # so there is no shared-state race; flat dict suffices.
        state = {"started": False, "terminal": False}

        async def tracked_send(message):
            # T-4: refuse any send after the response is terminal. Protects
            # the wire if the inner task somehow keeps emitting after we've
            # closed the stream from the timeout handler.
            if state["terminal"]:
                return
            msg_type = message["type"]
            if msg_type == "http.response.start":
                state["started"] = True
            elif msg_type == "http.response.body" and not message.get("more_body", False):
                # Terminal body chunk — happy path.
                state["terminal"] = True
            await original_send(message)

        try:
            async with asyncio.timeout(timeout):
                await self.app(scope, receive, tracked_send)
        except TimeoutError:
            # ``asyncio.timeout()`` converts the inner CancelledError to a
            # TimeoutError. The inner task is already torn down — no more
            # ``tracked_send`` calls will arrive.
            if state["terminal"]:
                # T-3: race — inner finished cleanly just before the deadline.
                return
            if not state["started"]:
                # T-2 (clean case): we own the wire. Send a fresh 504.
                response = JSONResponse(
                    {"detail": f"Request timed out after {timeout:.0f}s — the graph provider may be unreachable."},
                    status_code=504,
                )
                await response(scope, receive, original_send)
                state["terminal"] = True
                return
            # T-2 (stream-corruption case): the inner app already sent
            # ``http.response.start`` (and possibly partial body) before the
            # deadline fired. Emit a terminal empty body chunk to satisfy the
            # ASGI/HTTP protocol so uvicorn does not raise
            # "Response content shorter than Content-Length" and Starlette
            # does not raise "No response returned" upstream.
            try:
                await original_send({
                    "type": "http.response.body",
                    "body": b"",
                    "more_body": False,
                })
            except Exception:
                # Client connection already torn down — nothing further to do.
                pass
            state["terminal"] = True
            logger.warning(
                "Request timed out after response started: %s (timeout=%.0fs)",
                path, timeout,
            )

# Must be added FIRST so it wraps all other middleware.
app.add_middleware(_TimeoutMiddleware)

# ------------------------------------------------------------------ #
# Middleware (outermost → innermost order)                             #
# ------------------------------------------------------------------ #

_cors_origins_env = os.getenv("CORS_ALLOWED_ORIGINS", "")
_cors_origins = (
    [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
    if _cors_origins_env
    else ["http://localhost:3000", "http://localhost:5173"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-CSRF-Token"],
)

# GZip compression for responses > 1 KB
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Structured JSON access log + X-Process-Time header
app.add_middleware(StructuredLoggingMiddleware)

# X-Request-ID generation / propagation
app.add_middleware(RequestIdMiddleware)

# Security headers (X-Content-Type-Options, X-Frame-Options, CSP, HSTS, etc.)
app.add_middleware(SecurityHeadersMiddleware)

# CSRF double-submit. Innermost so it runs closest to the route — the
# preceding middleware (CORS, security headers) must complete first so
# that browser preflight checks succeed before we enforce the CSRF rule.
app.add_middleware(CSRFMiddleware)

# ------------------------------------------------------------------ #
# Routers                                                              #
# ------------------------------------------------------------------ #

app.include_router(api_router, prefix="/api/v1")

# Internal pool-pressure metrics (Phase 2.5 §2.5.3) — opt-in via
# INTERNAL_METRICS_ENABLED=true. Restrict at ingress in production.
from .middleware.db_metrics import router as db_metrics_router  # noqa: E402
app.include_router(db_metrics_router)


# ------------------------------------------------------------------ #
# Health endpoint                                                       #
# ------------------------------------------------------------------ #

# ────────────────────────────────────────────────────────────────────
# Three-tier health endpoints (P0.3).
#
#   /health/live   — process liveness. NO I/O, NO DB, NO providers.
#                    Constant-time. Used by k8s livenessProbe and the
#                    frontend's banner — must NEVER fail unless the
#                    event loop is dead.
#   /health/ready  — readiness. Single 1s-budgeted DB ping (READONLY
#                    pool). Provider state does NOT affect readiness.
#                    Used by k8s readinessProbe.
#   /health/deps   — deep dependency report. DB ping + in-memory
#                    breaker state. For dashboards / on-call only.
#                    NEVER on a probe hot path.
#
#   /health        — back-compat alias for /health/live (one-release
#                    deprecation; CHANGELOG documents migration).
# ────────────────────────────────────────────────────────────────────


@app.get("/health/live", tags=["health"])
@app.get("/api/v1/health/live", tags=["health"], include_in_schema=False)
async def liveness_check():
    """Process liveness — constant-time, zero I/O. Always 200.

    A failure of /health/live means the event loop is wedged or the
    process is shutting down. By construction it can never be a 5xx
    because we don't await anything; uvicorn returning 5xx implies
    the process itself is unable to schedule a coroutine.
    """
    return {"status": "live", "version": "0.2.0"}


@app.get("/health", tags=["health"])
@app.get("/api/v1/health", tags=["health"], include_in_schema=False)
async def health_alias():
    """Back-compat alias for /health/live.

    Existing infrastructure (k8s manifests, load-balancer probes, the
    frontend banner) historically polled /health expecting a status
    field. Returning the same lightweight shape preserves that contract
    while migrating new deployments to the explicit /health/live path.
    """
    return {"status": "live", "version": "0.2.0"}


@app.get("/health/deps", tags=["health"])
@app.get("/api/v1/health/deps", tags=["health"], include_in_schema=False)
async def dependency_health():
    """Deep dependency report — for dashboards and on-call.

    Includes:
      - Management DB ping (1s budget; READONLY pool)
      - Provider breaker states (in-memory, no I/O)
      - Degraded-mode flag + reason

    NEVER call this from a hot probe path. K8s probes use /health/live
    and /health/ready; this endpoint is for humans investigating an
    incident.
    """
    from .db.engine import get_engine
    from sqlalchemy import text

    degraded = getattr(app.state, "degraded", False)
    degraded_reason = getattr(app.state, "degraded_reason", None)

    result: dict = {
        "status": "healthy",
        "version": "0.2.0",
        "dependencies": {},
        "providers": {},
    }

    # Management DB ping (bounded; never blocks the response indefinitely).
    try:
        engine = get_engine()
        async with asyncio.timeout(1.0):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        result["dependencies"]["management_db"] = "healthy"
    except Exception as exc:
        result["dependencies"]["management_db"] = f"unhealthy: {exc}"
        result["status"] = "unhealthy"

    # Provider breaker state (O(1), in-memory only — no provider I/O).
    try:
        result["providers"] = provider_manager.report_provider_states()
    except Exception as exc:
        result["providers"] = {"_error": str(exc)[:200]}

    if degraded:
        result["status"] = "degraded"
        result["reason"] = degraded_reason or "database_unavailable"

    return result


@app.get("/health/ready", tags=["health"])
@app.get("/api/v1/health/ready", tags=["health"], include_in_schema=False)
async def readiness_check():
    """
    Readiness probe — Postgres must be reachable. Provider health is
    reported informally but does NOT affect the readiness verdict, so
    non-graph endpoints remain available during provider outages.

    K8s: use this for readinessProbe; use /health for livenessProbe.
    """
    from .db.engine import get_engine
    from sqlalchemy import text

    result: dict = {
        "status": "ready",
        "version": "0.2.0",
        "postgres": "healthy",
        "providers": {},
    }

    # Postgres check (required for readiness)
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={
                "status": "not_ready",
                "postgres": f"unhealthy: {exc}",
                "providers": {},
            },
        )

    # Provider health from ProviderManager — no new connections, just
    # reads in-memory breaker state for cached/attempted providers.
    result["providers"] = provider_manager.report_provider_states()

    return result


@app.get("/api/v1/health/providers", tags=["health"])
async def provider_health_check():
    """
    Per-workspace provider health — STRICT structural decoupling from
    provider state.

    This endpoint is polled continuously by the frontend's status banner
    and admin pages. It MUST NOT do any outbound work — every prior
    iteration that did (live ``get_stats``, then live ``preflight``)
    became a chokepoint that froze the whole app under hostile-host
    conditions.

    The contract now:

      - Read the data-source list from the PROVIDER_PROBE pool (1s
        deadline; cached on a tiny TTL so a poll storm dedupes).
      - Read in-memory breaker / cached-status state from
        ``provider_manager.report_provider_states()`` and the background
        warmup cache (``_provider_status_cache``). NO outbound work, NO
        provider construction, NO sockets opened.
      - Return immediately with the best-known status per data source.
        Never times out, never 504s, never affects the event loop.

    A background warmup loop (started in lifespan) periodically probes
    each registered provider via ``preflight()`` and updates the cache,
    so even un-visited providers carry a status. Provider unreachability
    is observable, but it is OBSERVED OFFLINE — never on a request path.
    """
    from .db.repositories.workspace_repo import list_workspaces
    from .db.repositories.data_source_repo import list_data_sources
    from .db.engine import get_provider_probe_session

    READ_DEADLINE = 1.0  # seconds — DB read budget; never extends past this

    try:
        # 1. Enumerate data sources from the PROVIDER_PROBE pool.
        ds_meta: list[tuple[str, str, str]] = []
        async with asyncio.timeout(READ_DEADLINE):
            async with get_provider_probe_session() as session:
                workspaces = await list_workspaces(session)
                for ws in workspaces:
                    sources = await list_data_sources(session, ws.id)
                    for ds in sources:
                        ds_meta.append((ws.id, ds.id, ds.provider_id))
    except (asyncio.TimeoutError, TimeoutError):
        # DB slow — return "configured: false" so the FE doesn't blank
        # the UI. Better to show stale than to 504.
        return {
            "providers": {},
            "dataSourceCount": 0,
            "configured": False,
            "error": "DB read deadline exceeded",
        }
    except Exception as exc:
        return {"providers": {}, "error": str(exc)[:200]}

    if not ds_meta:
        return {
            "providers": {},
            "dataSourceCount": 0,
            "configured": False,
        }

    # 2. Read in-memory breaker state — O(1), no I/O.
    try:
        breaker_states = provider_manager.report_provider_states()
    except Exception:
        breaker_states = {}

    # 3. Read background-warmup cache — O(1), no I/O.
    warmup_cache = getattr(provider_manager, "warmup_cache", {}) or {}

    # 4. Map each (ws_id, ds_id, prov_id) to its best-known status.
    providers: dict = {}
    for ws_id, ds_id, prov_id in ds_meta:
        ds_key = f"{ws_id}:{ds_id}"
        # Prefer breaker state when present (means the provider has been
        # actually exercised and we know its current truth).
        breaker_key = f"{prov_id}:"           # graph_name="" for default
        breaker_key_alt = next(
            (k for k in breaker_states if k.startswith(f"{prov_id}:")),
            None,
        )
        breaker = breaker_states.get(breaker_key) or (
            breaker_states.get(breaker_key_alt) if breaker_key_alt else None
        )

        warmup = warmup_cache.get(prov_id)

        # Resolution order: breaker (live truth from real traffic) →
        # warmup (background probe) → unknown (never observed).
        if breaker == "healthy":
            providers[ds_key] = {"status": "healthy", "providerId": prov_id}
        elif breaker in ("unavailable", "instantiation_failed"):
            providers[ds_key] = {
                "status": "unhealthy",
                "providerId": prov_id,
                "error": f"Provider circuit: {breaker}",
            }
        elif breaker == "degraded":
            providers[ds_key] = {
                "status": "unhealthy",
                "providerId": prov_id,
                "error": "Provider in degraded state (half-open)",
            }
        elif warmup is not None:
            providers[ds_key] = {
                "status": "healthy" if warmup.get("ok") else "unhealthy",
                "providerId": prov_id,
                "error": warmup.get("reason"),
                "checkedAt": warmup.get("checked_at"),
            }
        else:
            providers[ds_key] = {"status": "unknown", "providerId": prov_id}

    return {
        "providers": providers,
        "dataSourceCount": len(ds_meta),
        "configured": True,
    }

    return {
        "providers": providers,
        "dataSourceCount": len(ds_meta),
        "configured": True,
    }
