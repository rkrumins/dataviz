"""
Graph Service provider discovery and connectivity-test endpoints.

This service is **stateless** — it accepts connection params in the request
body rather than reading from the management DB.  Intended for pre-registration
testing (e.g. "does this FalkorDB host exist?") and capability discovery.
"""
import asyncio
import time
from typing import List, Optional
from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

router = APIRouter()


# ------------------------------------------------------------------ #
# Provider capability model                                            #
# ------------------------------------------------------------------ #

class ProviderCapabilities(BaseModel):
    name: str
    displayName: str
    supportsMultiGraph: bool
    supportsLineage: bool
    supportsContainment: bool
    supportsWriteBack: bool
    defaultPort: Optional[int] = None


# ------------------------------------------------------------------ #
# Provider catalogue                                                   #
# ------------------------------------------------------------------ #

_PROVIDERS: List[ProviderCapabilities] = [
    ProviderCapabilities(
        name="falkordb",
        displayName="FalkorDB",
        supportsMultiGraph=True,
        supportsLineage=True,
        supportsContainment=True,
        supportsWriteBack=True,
        defaultPort=6379,
    ),
    ProviderCapabilities(
        name="neo4j",
        displayName="Neo4j",
        supportsMultiGraph=True,
        supportsLineage=True,
        supportsContainment=True,
        supportsWriteBack=False,  # read-only in Phase 4
        defaultPort=7687,
    ),
    ProviderCapabilities(
        name="datahub",
        displayName="DataHub",
        supportsMultiGraph=False,
        supportsLineage=True,
        supportsContainment=False,
        supportsWriteBack=False,
        defaultPort=None,
    ),
    ProviderCapabilities(
        name="mock",
        displayName="Mock (testing)",
        supportsMultiGraph=False,
        supportsLineage=True,
        supportsContainment=True,
        supportsWriteBack=True,
        defaultPort=None,
    ),
]


@router.get("", response_model=List[ProviderCapabilities])
async def list_providers():
    """Return the list of supported provider types and their capabilities."""
    return _PROVIDERS


# ------------------------------------------------------------------ #
# FalkorDB                                                            #
# ------------------------------------------------------------------ #

class FalkorDBPingRequest(BaseModel):
    host: str
    port: int = 6379
    graph_name: str = "nexus_lineage"


@router.post("/falkordb/ping")
async def ping_falkordb(req: FalkorDBPingRequest = Body(...)):
    """
    Test connectivity to a FalkorDB instance without registering a connection.
    Returns latency and graph count on success.
    """
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    provider = FalkorDBProvider(host=req.host, port=req.port, graph_name=req.graph_name)
    try:
        t0 = time.perf_counter()
        await asyncio.wait_for(provider.get_stats(), timeout=10)
        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {"status": "healthy", "latencyMs": latency_ms}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="FalkorDB ping timed out")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"FalkorDB ping failed: {exc}")


@router.post("/falkordb/graphs")
async def list_falkordb_graphs(req: FalkorDBPingRequest = Body(...)):
    """
    List named graph keys on a FalkorDB instance without registering a connection.
    Uses GRAPH.LIST internally.
    """
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    provider = FalkorDBProvider(host=req.host, port=req.port, graph_name=req.graph_name)
    try:
        graphs = await asyncio.wait_for(provider.list_graphs(), timeout=10)
        return {"graphs": graphs}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="FalkorDB timed out while listing graphs")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to list FalkorDB graphs: {exc}")


# ------------------------------------------------------------------ #
# Neo4j                                                               #
# ------------------------------------------------------------------ #

class Neo4jPingRequest(BaseModel):
    host: str
    port: int = 7687
    username: str = "neo4j"
    password: str = ""
    database: str = "neo4j"
    tls_enabled: bool = False


@router.post("/neo4j/ping")
async def ping_neo4j(req: Neo4jPingRequest = Body(...)):
    """
    Test connectivity to a Neo4j instance without registering a connection.
    Runs ``RETURN 1`` via Bolt.
    """
    from backend.graph.adapters.neo4j_provider import Neo4jProvider
    scheme = "bolt+s" if req.tls_enabled else "bolt"
    provider = Neo4jProvider(
        uri=f"{scheme}://{req.host}:{req.port}",
        username=req.username,
        password=req.password,
        database=req.database,
    )
    try:
        t0 = time.perf_counter()
        await asyncio.wait_for(provider.get_stats(), timeout=10)
        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {"status": "healthy", "latencyMs": latency_ms}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Neo4j ping timed out")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Neo4j ping failed: {exc}")
    finally:
        await provider.close()


@router.post("/neo4j/databases")
async def list_neo4j_databases(req: Neo4jPingRequest = Body(...)):
    """
    List available Neo4j databases on an instance without registering a connection.
    Uses ``SHOW DATABASES`` on the system DB.
    """
    from backend.graph.adapters.neo4j_provider import Neo4jProvider
    scheme = "bolt+s" if req.tls_enabled else "bolt"
    provider = Neo4jProvider(
        uri=f"{scheme}://{req.host}:{req.port}",
        username=req.username,
        password=req.password,
        database=req.database,
    )
    try:
        databases = await asyncio.wait_for(provider.list_graphs(), timeout=10)
        return {"databases": databases}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Neo4j timed out while listing databases")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to list Neo4j databases: {exc}")
    finally:
        await provider.close()


# ------------------------------------------------------------------ #
# DataHub                                                             #
# ------------------------------------------------------------------ #

class DataHubPingRequest(BaseModel):
    base_url: str
    token: Optional[str] = None


@router.post("/datahub/ping")
async def ping_datahub(req: DataHubPingRequest = Body(...)):
    """
    Test connectivity to a DataHub instance without registering a connection.
    Calls the ``{ health { status } }`` GraphQL query.
    """
    from backend.graph.adapters.datahub_provider import DataHubGraphQLProvider
    provider = DataHubGraphQLProvider(base_url=req.base_url, token=req.token)
    try:
        t0 = time.perf_counter()
        result = await asyncio.wait_for(provider.get_stats(), timeout=10)
        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {"status": result.get("status", "UNKNOWN"), "latencyMs": latency_ms}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="DataHub ping timed out")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"DataHub ping failed: {exc}")
    finally:
        await provider.close()
