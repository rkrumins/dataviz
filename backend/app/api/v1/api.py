from fastapi import APIRouter
from .endpoints import graph, assignments

api_router = APIRouter()
api_router.include_router(graph.router, tags=["graph"])
api_router.include_router(assignments.router, prefix="/assignments", tags=["assignments"])
