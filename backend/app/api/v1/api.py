from fastapi import APIRouter
from .endpoints import graph

api_router = APIRouter()
api_router.include_router(graph.router, tags=["graph"])
