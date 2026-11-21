"""``python -m backend.ai_service`` — run the AI service.

Listens on ``AI_SERVICE_PORT`` (8093). Behind the web tier, which is its only
caller in a deployment: set ``AI_INTERNAL_TOKEN`` on both (required with
``ENV=production``).
"""
from __future__ import annotations

import logging
import os

import uvicorn

from .app import create_app
from .config import get_config


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    os.environ.setdefault("SYNODIC_ROLE", "ai")
    config = get_config()
    uvicorn.run(create_app(), host=os.getenv("AI_SERVICE_HOST", "0.0.0.0"), port=config.port,
                proxy_headers=False, log_level=os.getenv("LOG_LEVEL", "info").lower(),
                timeout_keep_alive=75)


if __name__ == "__main__":
    main()
