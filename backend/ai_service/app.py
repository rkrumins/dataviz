"""The AI service's FastAPI app."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from . import connections
from .api import admin, chat, mcp
from .config import get_config
from .internal_auth import assert_auth_mode_allowed, bind_forwarded_activity, require_internal_token

logger = logging.getLogger(__name__)

_RETENTION_SWEEP_SECONDS = 3600


async def _retention_loop() -> None:
    while True:
        try:
            removed = await chat.purge_expired()
            if removed:
                logger.info("AI retention: removed %d expired conversations", removed)
        except Exception:  # noqa: BLE001
            logger.exception("AI retention sweep failed")
        await asyncio.sleep(_RETENTION_SWEEP_SECONDS)


def create_app(*, knowledge=None, start_background: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        assert_auth_mode_allowed()
        tasks = []
        service = app.state.knowledge
        if service is None:
            from .knowledge.service import KnowledgeService

            service = KnowledgeService(get_config())
            app.state.knowledge = service
        if start_background:
            await service.start()
            tasks.append(asyncio.create_task(_retention_loop(), name="ai-retention"))
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            await service.stop()
            await connections.registry.close_all()

    app = FastAPI(
        title="AI service",
        description="The assistant, natural-language querying and the knowledge MCP server.",
        version="1.0.0",
        lifespan=lifespan,
        dependencies=[Depends(require_internal_token), Depends(bind_forwarded_activity)],
    )
    app.state.knowledge = knowledge
    app.state.platform_transport = None

    @app.get("/health")
    async def health():
        service = app.state.knowledge
        return {"status": "healthy", "role": "ai",
                "knowledge": "ready" if service is not None else "starting",
                "vectorStore": getattr(getattr(service, "store", None), "kind", "none")}

    app.include_router(chat.router)
    app.include_router(admin.router)
    app.include_router(mcp.router)
    try:
        from backend.app.api.v1.endpoints import metrics as metrics_endpoint
        from backend.app.jobs import metrics_prometheus

        metrics_prometheus.install()
        app.include_router(metrics_endpoint.router)
    except Exception as exc:  # noqa: BLE001 — metrics are optional, the service is not
        logger.info("AI service metrics not mounted: %s", exc)
    return app
