"""``POST /mcp/knowledge`` and ``POST /mcp/data`` — the MCP servers, over stateless HTTP."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from ..internal_auth import Caller, caller
from ..knowledge.service import KnowledgeCaller
from ..mcp import data_server

router = APIRouter()


@router.post("/mcp/knowledge")
async def mcp_knowledge(request: Request, who: Caller = Depends(caller)):
    knowledge = getattr(request.app.state, "knowledge", None)
    if knowledge is None:
        return JSONResponse(status_code=503, content={
            "jsonrpc": "2.0", "id": None,
            "error": {"code": -32603, "message": "Knowledge is not available."}})
    status, body = await knowledge.mcp.handle_http(
        await request.body(), KnowledgeCaller(user_id=who.user_id, delegation=who.delegation),
    )
    if body is None:
        return Response(status_code=status)
    return JSONResponse(status_code=status, content=body)


@router.post("/mcp/data")
async def mcp_data(request: Request, who: Caller = Depends(caller)):
    status, body = await data_server.SERVER.handle_http(await request.body(), data_server.DataCaller(
        user_id=who.user_id, delegation=who.delegation, view_only=who.view_only,
        knowledge=getattr(request.app.state, "knowledge", None),
        transport=getattr(request.app.state, "platform_transport", None),
    ))
    if body is None:
        return Response(status_code=status)
    return JSONResponse(status_code=status, content=body)


@router.api_route("/mcp/knowledge", methods=["GET", "DELETE"])
@router.api_route("/mcp/data", methods=["GET", "DELETE"])
async def mcp_other(_: Request):
    # Stateless: no event stream to open, no session to end (the protocol allows 405).
    return Response(status_code=405, headers={"Allow": "POST"})
