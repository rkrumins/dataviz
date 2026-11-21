"""The product's knowledge, over MCP — for the Help persona and other teams' agents.

Tools (all read-only):

``list_collections``
    What can be searched: ``docs`` (the documentation and user guide) and
    ``views`` (the curated views the caller can open).
``search_knowledge``
    Ranked passages for a question, each with a title, the section's link and
    its text. ``views`` results are checked as the caller before they are
    returned: a view they cannot open never appears.
``get_document``
    The full text of one passage's section, by the id a search returned.

The docs are the product's public documentation; views are only ever what the
caller's own access allows.
"""
from __future__ import annotations

import asyncio
from typing import Any

from ..platform_client import PlatformClient, PlatformError
from .protocol import McpServer, McpTool, ToolError

INSTRUCTIONS = (
    "Search the product's documentation and user guide, and the curated views you can open. "
    "Cite each passage by its url. The docs describe how the product works; views are "
    "canvases people built about a subject."
)


def build_server(knowledge) -> McpServer:
    async def list_collections(arguments: dict, caller: Any) -> dict:
        return {"collections": [
            {"name": "docs", "description": "The product documentation and user guide",
             "documents": len({c.source_id for c in knowledge.docs})},
            {"name": "views", "description": "Curated views about a subject, that you can open"},
        ]}

    async def search_knowledge(arguments: dict, caller: Any) -> dict:
        query = str(arguments.get("query") or "").strip()
        if not query:
            raise ToolError("Give a query.")
        collection = str(arguments.get("collection") or "docs")
        limit = max(1, min(20, int(arguments.get("limit") or 6)))
        results: list[dict] = []
        if collection in ("docs", "all"):
            for hit in await knowledge.search_docs_local(query, limit):
                results.append({"id": hit.id, "sourceId": hit.source_id, "collection": "docs",
                                "title": hit.title, "heading": hit.heading, "url": hit.url,
                                "text": hit.text[:1500], "score": round(hit.score, 5),
                                "metadata": hit.metadata})
        if collection in ("views", "all"):
            results.extend(await _views(knowledge, query, limit, caller))
        if collection not in ("docs", "views", "all"):
            raise ToolError("collection is docs, views or all.")
        return {"results": results}

    async def get_document(arguments: dict, caller: Any) -> dict:
        found = knowledge.document(str(arguments.get("id") or ""))
        if found is None:
            raise ToolError("No document with that id.")
        return found

    return McpServer(
        name="knowledge", version="1", instructions=INSTRUCTIONS,
        tools=[
            McpTool("list_collections", "What can be searched.", {"type": "object", "properties": {}},
                    list_collections, title="List collections"),
            McpTool("search_knowledge",
                    "Ranked passages from the documentation (collection docs) or the views you can "
                    "open (collection views) for a question.",
                    {"type": "object", "properties": {
                        "query": {"type": "string", "description": "The question or topic"},
                        "collection": {"type": "string", "enum": ["docs", "views", "all"]},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 20}},
                     "required": ["query"]},
                    search_knowledge, title="Search knowledge"),
            McpTool("get_document", "The full section a search result came from.",
                    {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
                    get_document, title="Get a document"),
        ],
    )


async def _views(knowledge, query: str, limit: int, caller: Any) -> list[dict]:
    if caller is None or not getattr(caller, "delegation", None):
        return []
    hits = await knowledge.search_collection("views", query, limit)
    if not hits:
        return []
    client = PlatformClient(knowledge.config.platform_api_url, caller.delegation,
                            timeout=knowledge.config.platform_timeout_seconds,
                            transport=knowledge.platform_transport)

    async def verify(hit: dict):
        view_id = (hit.get("metadata") or {}).get("viewId")
        if not view_id:
            return None
        try:
            view = await client.get_view(view_id)
        except PlatformError:
            return None  # not theirs to see
        return {"id": f"view/{view_id}", "sourceId": f"view/{view_id}", "collection": "views",
                "title": view.get("name"), "heading": view.get("dataSourceName") or "",
                "url": f"/views/{view_id}", "text": (view.get("description") or "")[:800],
                "score": round(float(hit.get("score") or 0), 5),
                "metadata": {"viewId": view_id, "workspace": view.get("workspaceName")}}

    try:
        found = await asyncio.gather(*(verify(h) for h in hits))
    finally:
        await client.aclose()
    return [f for f in found if f]
