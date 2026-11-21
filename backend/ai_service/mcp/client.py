"""Calling one tool on another team's MCP server (streamable HTTP).

``initialize`` → ``notifications/initialized`` → ``tools/call``, with the
session id the server issues (if any) on the calls after the first, and the
``MCP-Protocol-Version`` it agreed. A server may answer each POST with JSON
or with a short event stream; both are read. Every request goes through the
guarded client (``llm.egress``) and the connection's own sign-in
(``llm.auth``), and the whole exchange is bounded by the caller's timeout.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from ..llm.types import LlmError
from .protocol import LATEST

_ACCEPT = "application/json, text/event-stream"


def _read(response) -> Optional[dict]:
    kind = response.headers.get("content-type", "")
    if "text/event-stream" in kind:
        found = None
        for line in response.text.splitlines():
            if line.startswith("data:"):
                try:
                    data = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if isinstance(data, dict) and ("result" in data or "error" in data):
                    found = data
        return found
    if not response.content:
        return None
    try:
        data = response.json()
    except ValueError as exc:
        raise LlmError("protocol", "The MCP server did not answer with JSON.") from exc
    return data if isinstance(data, dict) else None


class McpClient:
    def __init__(self, url: str, *, http, auth) -> None:
        self._url = url
        self._http = http
        self._auth = auth

    async def _post(self, payload: dict, session: Optional[str], version: Optional[str]):
        headers = {"Content-Type": "application/json", "Accept": _ACCEPT}
        params: dict[str, str] = {}
        await self._auth.apply(headers, params)
        if session:
            headers["Mcp-Session-Id"] = session
        if version:
            headers["MCP-Protocol-Version"] = version
        response = await self._http.request("POST", self._url, json=payload, headers=headers,
                                            params=params)
        if response.status_code in (401, 403):
            await self._auth.invalidate()
            raise LlmError("auth", "The MCP server refused the credentials.", status=response.status_code)
        if response.status_code >= 400:
            raise LlmError("unavailable", f"The MCP server answered HTTP {response.status_code}.",
                           status=response.status_code)
        return response

    async def call_tool(self, name: str, arguments: dict) -> Any:
        init = await self._post({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": LATEST, "capabilities": {},
                       "clientInfo": {"name": "ai-service", "version": "1"}},
        }, None, None)
        reply = _read(init) or {}
        if "error" in reply:
            raise LlmError("protocol", f"The MCP server refused to initialise: {reply['error'].get('message')}")
        session = init.headers.get("mcp-session-id")
        version = (reply.get("result") or {}).get("protocolVersion") or LATEST
        await self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session, version)
        response = await self._post({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }, session, version)
        reply = _read(response) or {}
        if "error" in reply:
            raise LlmError("protocol", f"The MCP tool failed: {reply['error'].get('message')}")
        result = reply.get("result") or {}
        if result.get("isError"):
            text = "".join(c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict))
            raise LlmError("protocol", f"The MCP tool reported an error: {text[:200]}")
        if result.get("structuredContent") is not None:
            return result["structuredContent"]
        texts = [c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict)
                 and c.get("type") == "text"]
        joined = "\n".join(texts)
        try:
            return json.loads(joined)
        except ValueError:
            return {"text": joined}
