"""
Synodic Graph Service — port 8001.

Stateless companion service for provider connectivity testing and graph
discovery.  Does NOT access the management DB; takes connection params
in request bodies instead.  Intended for pre-registration UX flows:

  "Test this FalkorDB host before I register it as a connection."
  "Show me which Neo4j databases are available."
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from backend.graph.api.v1.endpoints.providers import router as providers_router

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Synodic Graph Service",
    description=(
        "Stateless provider discovery and connectivity-test API. "
        "Accepts connection parameters in request bodies — no management DB access."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(GZipMiddleware, minimum_size=1024)

app.include_router(providers_router, prefix="/graph/v1/providers", tags=["providers"])


@app.get("/health", tags=["health"])
async def health():
    return {"status": "healthy", "service": "graph", "version": "0.1.0"}
