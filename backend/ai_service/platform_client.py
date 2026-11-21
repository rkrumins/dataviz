"""The platform's own API, called as the person the assistant answers.

Every read the assistant makes goes through here, carrying the person's
read-only delegation (``Authorization: Bearer nxdlg_…``). The platform then
does what it does for any request: the endpoint surface, the resource fence,
the view scope, RBAC, admission control, caches and circuit breakers. This
client adds none of its own — it is a typed, bounded HTTP client and nothing
more, so what the assistant can see and what the person can see cannot drift.

Errors come back as :class:`PlatformError` with the platform's own status and
message, so a tool can tell the model "the view does not cover that" rather
than "something failed".
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Mapping, Optional
from urllib.parse import quote

import httpx


class PlatformError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def for_model(self) -> str:
        """The refusal, worded for the model to act on."""
        if self.status == 501:
            return ("This data source's graph store does not support that read "
                    f"(the platform answered 501: {self.message}).")
        if self.status in (401, 403):
            return f"Not allowed for this person: {self.message}"
        if self.status == 404:
            return f"Not found: {self.message}"
        if self.status == 429:
            return "The platform is busy; try a narrower question."
        return f"The platform could not answer ({self.status}): {self.message}"


def _message(response: httpx.Response) -> tuple[str, str]:
    try:
        body = response.json()
    except ValueError:
        return "error", f"HTTP {response.status_code}"
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, dict):
        code = str(detail.get("error") or detail.get("code") or detail.get("type") or "error")
        message = str(detail.get("message") or detail.get("detail") or code)
        return code, message[:400]
    if isinstance(detail, list):  # pydantic validation errors
        first = detail[0] if detail else {}
        loc = ".".join(str(p) for p in first.get("loc", [])[1:]) if isinstance(first, dict) else ""
        msg = first.get("msg", "invalid") if isinstance(first, dict) else str(first)
        return "invalid_request", f"{loc}: {msg}"[:400]
    return "error", str(detail)[:400]


def _with_meta(body: Any) -> dict:
    if not isinstance(body, dict):
        return {}
    if "data" not in body and "meta" not in body:
        return body
    data = body.get("data")
    out = dict(data) if isinstance(data, dict) else {}
    if isinstance(body.get("meta"), dict):
        out["_meta"] = body["meta"]
    return out


class PlatformClient:
    """One person's view of the platform, for one turn."""

    def __init__(
        self, base_url: str, delegation: str, *, timeout: float = 60.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        self.delegation = delegation
        headers = {"Authorization": f"Bearer {delegation}", "Accept": "application/json"}
        if correlation_id:
            headers["X-Request-ID"] = correlation_id
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=headers,
            timeout=httpx.Timeout(timeout, connect=5.0), transport=transport,
        )
        self._anonymous = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), timeout=httpx.Timeout(10.0, connect=5.0),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._anonymous.aclose()

    async def _call(self, method: str, path: str, *, params=None, json=None,
                    anonymous: bool = False) -> Any:
        client = self._anonymous if anonymous else self._client
        clean = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        try:
            response = await client.request(method, path, params=clean, json=json)
        except httpx.TimeoutException as exc:
            raise PlatformError(504, "timeout", "The platform took too long to answer.") from exc
        except httpx.HTTPError as exc:
            raise PlatformError(503, "unreachable", "The platform could not be reached.") from exc
        if response.status_code >= 400:
            code, message = _message(response)
            raise PlatformError(response.status_code, code, message)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise PlatformError(502, "protocol", "The platform answered with something other than JSON.") from exc

    # ── Catalogue: views, workspaces, data sources ──────────────────

    async def list_views(self, *, search: Optional[str] = None, workspace_id: Optional[str] = None,
                         data_source_id: Optional[str] = None, limit: int = 20, offset: int = 0,
                         updated_after: Optional[str] = None, sort: Optional[str] = None) -> dict:
        return await self._call("GET", "/api/v1/views/", params={
            "search": search, "workspaceId": workspace_id, "dataSourceId": data_source_id,
            "limit": max(1, min(200, limit)), "offset": offset, "updatedAfter": updated_after,
            "sort": sort,
        })

    async def get_view(self, view_id: str) -> dict:
        return await self._call("GET", f"/api/v1/views/{quote(view_id, safe='')}")

    async def list_workspaces(self) -> Any:
        return await self._call("GET", "/api/v1/admin/workspaces")

    async def list_data_sources(self, workspace_id: str) -> Any:
        return await self._call("GET", f"/api/v1/admin/workspaces/{quote(workspace_id, safe='')}/data-sources")

    async def feature_values(self) -> dict:
        return await self._call("GET", "/api/v1/features/values", anonymous=True)

    async def branding(self) -> dict:
        return await self._call("GET", "/api/v1/branding", anonymous=True)

    # ── One data source's graph ─────────────────────────────────────

    @staticmethod
    def _graph(ws: str, rest: str) -> str:
        return f"/api/v1/{quote(ws, safe='')}/graph{rest}"

    async def schema(self, ws: str, ds: Optional[str], *, view_id: Optional[str] = None) -> dict:
        """The data source's resolved schema, with the cache's ``meta`` kept
        as ``_meta`` — ``status`` says when it is still being computed or
        stands in from the ontology alone."""
        body = await self._call("GET", self._graph(ws, "/metadata/schema"),
                                params={"dataSourceId": ds, "viewId": view_id})
        return _with_meta(body)

    async def introspection(self, ws: str, ds: Optional[str], *, view_id: Optional[str] = None) -> dict:
        """How many entities and edges of each type the whole data source holds."""
        body = await self._call("GET", self._graph(ws, "/introspection"),
                                params={"dataSourceId": ds, "viewId": view_id})
        return _with_meta(body)

    async def get_ontology(self, ontology_id: str) -> dict:
        return await self._call("GET", f"/api/v1/admin/ontologies/{quote(ontology_id, safe='')}")

    async def get_catalog_item(self, item_id: str) -> dict:
        return await self._call("GET", f"/api/v1/admin/catalog/{quote(item_id, safe='')}")

    async def get_node(self, ws: str, ds: Optional[str], urn: str, *, view_id: Optional[str] = None) -> dict:
        return await self._call("GET", self._graph(ws, f"/nodes/{quote(urn, safe='')}"),
                                params={"dataSourceId": ds, "viewId": view_id})

    async def ancestors(self, ws: str, ds: Optional[str], urn: str, *,
                        view_id: Optional[str] = None, limit: int = 12) -> list[dict]:
        """The containers *urn* sits in, parent first."""
        body = await self._call("GET", self._graph(ws, f"/nodes/{quote(urn, safe='')}/ancestors"),
                                params={"dataSourceId": ds, "viewId": view_id, "limit": limit})
        if isinstance(body, dict):
            body = body.get("items") or body.get("nodes") or body.get("ancestors") or []
        return [n for n in body or [] if isinstance(n, dict)]

    async def ancestor_chains(self, ws: str, ds: Optional[str], urns: list[str], *,
                              view_id: Optional[str] = None) -> dict:
        return await self._call("POST", self._graph(ws, "/nodes/ancestor-chains"),
                                params={"dataSourceId": ds, "viewId": view_id},
                                json={"urns": urns[:500]})

    async def search(self, ws: str, ds: Optional[str], query: Mapping[str, Any]) -> dict:
        view_id = (query.get("scope") or {}).get("viewId")
        return await self._call("POST", self._graph(ws, "/search/advanced"),
                                params={"dataSourceId": ds, "viewId": view_id}, json=dict(query))

    async def explain(self, ws: str, ds: Optional[str], query: Mapping[str, Any]) -> dict:
        view_id = (query.get("scope") or {}).get("viewId")
        return await self._call("POST", self._graph(ws, "/search/explain"),
                                params={"dataSourceId": ds, "viewId": view_id}, json=dict(query))

    async def resolve(self, ws: str, ds: Optional[str], scope: Mapping[str, Any],
                      refs: list[Mapping[str, Any]]) -> dict:
        return await self._call("POST", self._graph(ws, "/search/resolve"),
                                params={"dataSourceId": ds, "viewId": scope.get("viewId")},
                                json={"scope": dict(scope), "refs": refs[:32]})

    async def values(self, ws: str, ds: Optional[str], view_id: str, key: str, *,
                     q: Optional[str] = None, limit: int = 20) -> dict:
        return await self._call("GET", self._graph(ws, "/search/values"), params={
            "dataSourceId": ds, "viewId": view_id, "key": key, "q": q,
            "limit": max(1, min(50, limit)),
        })

    async def counts(self, ws: str, ds: Optional[str], scope: Mapping[str, Any],
                     items: list[Mapping[str, Any]], *, budget_seconds: float = 20.0) -> dict:
        """Exact counts per rule, continuing sessions until complete or out of time."""
        deadline = time.monotonic() + budget_seconds
        sessions: dict[str, str] = {}
        latest: dict[str, Any] = {}
        while True:
            body = await self._call(
                "POST", self._graph(ws, "/search/counts"),
                params={"dataSourceId": ds, "viewId": scope.get("viewId")},
                json={"scope": dict(scope), "items": items[:32], "waitMs": 4000,
                      "sessions": sessions, "purpose": "search"},
            )
            latest = body.get("counts", {}) if isinstance(body, dict) else {}
            running = {k: v for k, v in latest.items() if v.get("status") == "running"}
            if not running or time.monotonic() >= deadline:
                return {"counts": latest, "complete": not running}
            sessions = {k: v["sessionId"] for k, v in running.items() if v.get("sessionId")}
            if not sessions:
                return {"counts": latest, "complete": False}

    async def catalog(self, ws: str, ds: Optional[str], scope: Mapping[str, Any], *,
                      budget_seconds: float = 15.0) -> dict:
        deadline = time.monotonic() + budget_seconds
        session_id = None
        while True:
            body = await self._call(
                "POST", self._graph(ws, "/search/catalog"),
                params={"dataSourceId": ds, "viewId": scope.get("viewId")},
                json={"scope": dict(scope), "waitMs": 4000, "sessionId": session_id},
            )
            if body.get("status") == "complete" or time.monotonic() >= deadline:
                return body
            session_id = body.get("sessionId")
            if not session_id:
                return body
            await asyncio.sleep(0)

    async def trace_closure(self, ws: str, ds: Optional[str], body: Mapping[str, Any], *,
                            view_id: Optional[str] = None) -> dict:
        return await self._call("POST", self._graph(ws, "/trace/closure"),
                                params={"dataSourceId": ds, "viewId": view_id}, json=dict(body))

    async def trace_expand(self, ws: str, ds: Optional[str], body: Mapping[str, Any], *,
                           view_id: Optional[str] = None) -> dict:
        return await self._call("POST", self._graph(ws, "/trace/expand"),
                                params={"dataSourceId": ds, "viewId": view_id}, json=dict(body))

    async def edges_beneath(self, ws: str, ds: Optional[str], source_urn: str, target_urn: str, *,
                            view_id: Optional[str] = None) -> dict:
        return await self._call("POST", self._graph(ws, "/edges/beneath"),
                                params={"dataSourceId": ds, "viewId": view_id},
                                json={"sourceUrn": source_urn, "targetUrn": target_urn})
