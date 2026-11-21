"""Where the Help persona's knowledge comes from: the ``KnowledgeSource`` port.

* :class:`ProductKnowledge` — the product's own docs and guide, read through
  this service's knowledge **MCP server**, in memory (the same protocol path an
  external agent takes, without the network).
* :class:`ExternalMcpSource` — an MCP server another team hosts (a wiki, a
  runbook store), registered under Administration → AI → Knowledge: its URL,
  its sign-in (the same methods as model connections), which tool to call,
  how to map our arguments to its and its results to ours.

Sources are asked in parallel, each with its own deadline; a slow or failing
one is left out of the answer, never waited on. What an external source
returns is labelled with its name and trust label everywhere it is shown,
and is treated as untrusted data in the prompt.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional, Protocol

from ..llm.auth import build_auth, json_path
from ..llm.egress import GuardedClient
from ..llm.types import LlmError
from ..mcp.client import McpClient
from .retrieval import Hit

logger = logging.getLogger(__name__)


class KnowledgeSource(Protocol):
    name: str
    trust: str

    async def search(self, query: str, limit: int, caller: Any) -> list[Hit]: ...


class ProductKnowledge:
    name = "product"
    trust = "product"

    def __init__(self, server) -> None:
        self._server = server

    async def search(self, query: str, limit: int, caller: Any) -> list[Hit]:
        result = await self._server.call_local(
            "search_knowledge", {"query": query, "collection": "docs", "limit": limit}, caller,
        )
        out = []
        for item in (result or {}).get("results") or []:
            out.append(Hit(
                id=str(item.get("id")), source_id=str(item.get("sourceId") or item.get("id")),
                title=str(item.get("title") or ""), heading=str(item.get("heading") or ""),
                url=str(item.get("url") or ""), text=str(item.get("text") or ""),
                score=float(item.get("score") or 0), source="product", trust="product",
                metadata=item.get("metadata") or {},
            ))
        return out


def _loads(raw: Optional[str], default):
    try:
        value = json.loads(raw) if raw else default
    except (TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


class ExternalMcpSource:
    def __init__(self, row, *, allow_hosts: frozenset[str], transport=None) -> None:
        from backend.common import credential_crypto

        self.id = row.id
        self.name = row.name
        self.trust = row.trust_label or "external"
        self.tool = row.tool_name
        self.timeout = max(0.5, (row.timeout_ms or 4000) / 1000.0)
        self.argument_map = _loads(row.argument_map, {}) or {"query": "query"}
        self.result_map = _loads(row.result_map, {})
        http = GuardedClient(allow_hosts=allow_hosts, timeout=self.timeout, transport=transport)
        auth = build_auth(row.auth_type, _loads(row.auth_config, {}),
                          credential_crypto.decrypt(row.secrets_encrypted), http)
        self._http = http
        self._client = McpClient(row.url, http=http, auth=auth)

    def _arguments(self, query: str, limit: int) -> dict:
        values = {"query": query, "limit": limit}
        out = {}
        for ours, theirs in self.argument_map.items():
            if ours in values and theirs:
                out[str(theirs)] = values[ours]
        return out or {"query": query}

    def _hits(self, result: Any, limit: int) -> list[Hit]:
        items_path = self.result_map.get("items")
        items = json_path(result, items_path) if items_path else result
        if isinstance(items, dict):
            items = items.get("results") or items.get("items") or [items]
        if not isinstance(items, list):
            items = [{"text": str(result)}]
        out = []
        for i, item in enumerate(items[:limit]):
            if not isinstance(item, dict):
                item = {"text": str(item)}
            text = json_path(item, self.result_map.get("text") or "text") or item.get("content") or ""
            title = json_path(item, self.result_map.get("title") or "title") or self.name
            url = json_path(item, self.result_map.get("url") or "url") or ""
            out.append(Hit(
                id=f"{self.id}:{i}", source_id=f"{self.id}:{url or i}", title=str(title)[:200],
                heading="", url=str(url)[:500], text=str(text)[:2000], source=self.name,
                trust=self.trust,
            ))
        return out

    async def search(self, query: str, limit: int, caller: Any) -> list[Hit]:
        result = await self._client.call_tool(self.tool, self._arguments(query, limit))
        return self._hits(result, limit)

    async def test(self) -> dict:
        try:
            hits = await asyncio.wait_for(self.search("getting started", 3, None), self.timeout)
        except asyncio.TimeoutError:
            return {"ok": False, "detail": f"No answer within {self.timeout:.1f}s."}
        except LlmError as exc:
            return {"ok": False, "code": exc.code, "detail": str(exc)}
        return {"ok": True, "detail": f"Answered with {len(hits)} result(s).",
                "sample": [{"title": h.title, "url": h.url} for h in hits[:3]]}

    async def aclose(self) -> None:
        await self._http.aclose()


async def ask_all(sources: list, query: str, limit: int, caller: Any) -> list[list[Hit]]:
    """Every source's results, each within its own deadline; failures dropped."""

    async def one(source):
        try:
            return await asyncio.wait_for(source.search(query, limit, caller),
                                          getattr(source, "timeout", 6.0))
        except Exception as exc:  # noqa: BLE001
            logger.info("knowledge source %s left out: %s", getattr(source, "name", "?"), exc)
            return []

    return list(await asyncio.gather(*(one(s) for s in sources)))
