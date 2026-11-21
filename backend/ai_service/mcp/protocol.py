"""An MCP server for tools: JSON-RPC 2.0, stateless streamable HTTP, JSON answers.

Follows the Model Context Protocol's basic and tools specifications
(2025-06-18, and the earlier 2025-03-26 and 2024-11-05 versions a client may
ask for):

* ``initialize`` → the negotiated protocol version, ``capabilities.tools``,
  ``serverInfo`` and ``instructions``;
* ``notifications/initialized`` and every other notification → accepted, no
  answer (HTTP 202);
* ``ping`` → ``{}``;
* ``tools/list`` → every tool with its ``inputSchema``;
* ``tools/call`` → ``{"content": [{"type": "text", "text": …}],
  "structuredContent": …, "isError": bool}``; a tool's own failure is
  ``isError: true``, a protocol fault a JSON-RPC error.

Stateless: no ``Mcp-Session-Id`` is issued, every request stands alone, so any
replica can answer any call and there is nothing to expire.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

SUPPORTED_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
LATEST = SUPPORTED_VERSIONS[0]

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL = (
    -32700, -32600, -32601, -32602, -32603,
)


@dataclass(frozen=True)
class McpTool:
    name: str
    description: str
    input_schema: dict
    run: Callable[[dict, Any], Awaitable[Any]]
    title: Optional[str] = None
    read_only: bool = True


class ToolError(Exception):
    """A tool could not answer; reported to the caller as ``isError``."""


class McpServer:
    def __init__(self, *, name: str, version: str, instructions: str, tools: list[McpTool]) -> None:
        self.name, self.version, self.instructions = name, version, instructions
        self.tools = {t.name: t for t in tools}

    @staticmethod
    def _error(id_: Any, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}

    async def handle(self, message: Any, caller: Any) -> Optional[dict]:
        """One JSON-RPC message in; its response out (None for a notification)."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self._error(None, INVALID_REQUEST, "Not a JSON-RPC 2.0 message.")
        method = message.get("method")
        id_ = message.get("id")
        if "id" not in message:
            return None  # a notification
        params = message.get("params") or {}
        if not isinstance(params, dict):
            return self._error(id_, INVALID_PARAMS, "params must be an object.")
        if method == "initialize":
            asked = params.get("protocolVersion")
            version = asked if asked in SUPPORTED_VERSIONS else LATEST
            return {"jsonrpc": "2.0", "id": id_, "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": self.name, "version": self.version},
                "instructions": self.instructions,
            }}
        if method == "ping":
            return {"jsonrpc": "2.0", "id": id_, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": id_, "result": {"tools": [
                {"name": t.name, "title": t.title or t.name, "description": t.description,
                 "inputSchema": t.input_schema,
                 "annotations": {"readOnlyHint": t.read_only, "openWorldHint": False}}
                for t in self.tools.values()
            ]}}
        if method == "tools/call":
            tool = self.tools.get(str(params.get("name") or ""))
            if tool is None:
                return self._error(id_, INVALID_PARAMS, f"Unknown tool {params.get('name')!r}.")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                return self._error(id_, INVALID_PARAMS, "arguments must be an object.")
            try:
                result = await tool.run(arguments, caller)
            except ToolError as exc:
                return {"jsonrpc": "2.0", "id": id_, "result": {
                    "content": [{"type": "text", "text": str(exc)}], "isError": True}}
            except Exception:  # noqa: BLE001
                logger.exception("MCP tool %s failed", tool.name)
                return {"jsonrpc": "2.0", "id": id_, "result": {
                    "content": [{"type": "text", "text": "The tool failed."}], "isError": True}}
            return {"jsonrpc": "2.0", "id": id_, "result": {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "structuredContent": result if isinstance(result, dict) else {"result": result},
                "isError": False,
            }}
        return self._error(id_, METHOD_NOT_FOUND, f"Unknown method {method!r}.")

    async def handle_http(self, body: bytes, caller: Any) -> tuple[int, Optional[dict]]:
        """A POST body in; (status, JSON body or None) out."""
        try:
            message = json.loads(body or b"")
        except ValueError:
            return 400, self._error(None, PARSE_ERROR, "The body is not JSON.")
        if isinstance(message, list):
            return 400, self._error(None, INVALID_REQUEST, "Batches are not supported.")
        response = await self.handle(message, caller)
        return (202, None) if response is None else (200, response)

    async def call_local(self, name: str, arguments: dict, caller: Any) -> Any:
        """A tool call through the protocol, in memory — what an MCP client of
        this server would get, without the network."""
        response = await self.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": name, "arguments": arguments}}, caller,
        )
        result = (response or {}).get("result") or {}
        if "error" in (response or {}) or result.get("isError"):
            text = (result.get("content") or [{}])[0].get("text") or (response or {}).get("error", {}).get("message")
            raise ToolError(str(text))
        return result.get("structuredContent")
