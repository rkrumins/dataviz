"""The assistant end to end: a scripted model, a fake platform, the real loop.

The model is an ``httpx.MockTransport`` that answers each completion call with
the next scripted reply (tool calls, then an answer). The platform is another
``MockTransport`` serving the handful of reads the tools make, shaped as the
real endpoints answer. Everything else is the real code: the chat route, the
SSE stream, the tools and playbooks, concept resolution, result references,
persistence in an in-memory database.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.ai_service import connections, db as ai_db, settings_store
from backend.ai_service.agent import grounding as G
from backend.ai_service.agent import loop as agent_loop
from backend.ai_service.app import create_app
from backend.ai_service.config import AiServiceConfig, set_config_for_tests
from backend.ai_service.knowledge.service import KnowledgeService
from backend.ai_service.knowledge.store import MemoryVectorStore
from backend.ai_service.models import AiConceptMappingORM, AiLlmConnectionORM, AiUsageDailyORM
from backend.ai_service import models as ai_models
from backend.app.db.engine import Base

AI_TABLES = [getattr(ai_models, name).__table__ for name in ai_models.__all__]

WS, DS, VIEW = "ws_1", "ds_1", "view_1"
TABLE = "urn:li:dataset:customers"
COL = "urn:li:schemaField:customers.first_name"
COL2 = "urn:li:schemaField:dim_customer.full_name"
DIM = "urn:li:dataset:dim_customer"
JOB = "urn:li:dataJob:dbt_dim_customer"
DASH = "urn:li:dashboard:customer_360"
SCHEMA_URN = "urn:li:container:crm"


def node(urn, name, type_, **props):
    tags = props.pop("tags", [])
    return {"urn": urn, "displayName": name, "entityType": type_, "properties": props, "tags": tags}


NODES = {
    TABLE: node(TABLE, "customers", "dataset", owner="crm-team"),
    COL: node(COL, "first_name", "schemaField", dataType="varchar", tags=["pii"]),
    DIM: node(DIM, "dim_customer", "dataset", owner="analytics-team"),
    COL2: node(COL2, "full_name", "schemaField"),
    JOB: node(JOB, "dbt_dim_customer", "dataJob", schedule_interval="0 4 * * *"),
    DASH: node(DASH, "Customer 360", "dashboard", owner="bi-team", tags=["certified"]),
    SCHEMA_URN: node(SCHEMA_URN, "crm", "container"),
}


class FakePlatform:
    """The reads the tools make, as the real endpoints answer them."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.params: list[tuple[str, dict]] = []
        self.counts = {"tag:pii": 312, "property:personal_data": 290}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        self.params.append((path, dict(request.url.params)))
        assert request.headers.get("authorization", "").startswith("Bearer nxdlg_") or path in (
            "/api/v1/features/values", "/api/v1/branding",
        )
        if path == f"/api/v1/views/{VIEW}":
            return httpx.Response(200, json={
                "id": VIEW, "name": "Customer lineage", "workspaceId": WS, "dataSourceId": DS,
                "dataSourceName": "CRM lake", "workspaceName": "Data", "description": "CRM to BI",
                "layoutType": "reference", "createdByName": "Grace", "tags": ["crm"],
                "config": {"layout": {"type": "reference", "referenceLayout": {"layers": [
                    {"id": "l2", "name": "Marts", "order": 1, "entityTypes": ["dataset"],
                     "description": "Modelled tables"},
                    {"id": "l1", "name": "Sources", "order": 0, "entityTypes": ["container"]},
                ]}}}})
        if path == "/api/v1/admin/workspaces":
            return httpx.Response(200, json=[{"id": WS, "name": "Data", "description": "Analytics",
                                              "dataSources": [{"id": DS, "label": "CRM lake",
                                                               "ontologyId": "onto_1", "catalogItemId": "cat_1"}]}])
        if path == "/api/v1/admin/ontologies/onto_1":
            return httpx.Response(200, json={"id": "onto_1", "name": "Lineage core"})
        if path == f"/api/v1/{WS}/graph/introspection":
            return httpx.Response(200, json={"data": {
                "totalNodes": 9000, "totalEdges": 20000,
                "entityTypeStats": [{"id": "schemaField", "name": "schemaField", "count": 7000,
                                     "sampleNames": ["secret_outside_the_view"]},
                                    {"id": "dataset", "name": "dataset", "count": 900},
                                    {"id": "container", "name": "container", "count": 40}],
                "edgeTypeStats": [{"id": "CONTAINS", "name": "CONTAINS", "count": 8000},
                                  {"id": "TRANSFORMS", "name": "TRANSFORMS", "count": 5000},
                                  {"id": "AGGREGATED", "name": "AGGREGATED", "count": 300}],
            }, "meta": {"status": "fresh"}})
        if path == "/api/v1/views/":
            q = request.url.params.get("search", "")
            if "supplier" in q or "supply" in q:
                return httpx.Response(200, json={"items": [{"id": "view_sc", "name": "Supplier delays",
                                                            "description": "Late shipments by supplier",
                                                            "workspaceName": "Ops", "dataSourceName": "ERP"}],
                                                 "hasMore": False})
            return httpx.Response(200, json={"items": [], "hasMore": False})
        if path == "/api/v1/views/view_sc":
            return httpx.Response(200, json={"id": "view_sc", "name": "Supplier delays"})
        if path == "/api/v1/branding":
            return httpx.Response(200, json={"appName": "Synodic", "supportEmail": "help@example.com"})
        if path == "/api/v1/features/values":
            return httpx.Response(200, json={"values": {"versioningEnabled": False}})
        if path == f"/api/v1/{WS}/graph/metadata/schema":
            return httpx.Response(200, json={"data": {
                "entityTypes": [{"id": t, "name": t.title(), "pluralName": t + "s",
                                 "hierarchy": {"level": i}} for i, t in
                                enumerate(["container", "dataset", "schemaField", "dataJob", "dashboard"])],
                "relationshipTypes": [{"id": "CONTAINS", "name": "Contains", "isContainment": True,
                                       "sourceTypes": ["container", "dataset"],
                                       "targetTypes": ["dataset", "schemaField"],
                                       "description": "Relationship type: CONTAINS"},
                                      {"id": "TRANSFORMS", "name": "Transforms", "isLineage": True,
                                       "category": "flow", "description": "One column computed from another"},
                                      {"id": "CONSUMES", "name": "Consumes", "isLineage": True,
                                       "sourceTypes": ["schemaField"], "targetTypes": ["dashboard"]}],
                "containmentEdgeTypes": ["CONTAINS"], "lineageEdgeTypes": ["TRANSFORMS", "PRODUCES"],
            }})
        if path == f"/api/v1/{WS}/graph/search/catalog":
            return httpx.Response(200, json={
                "sessionId": "c1", "status": "complete", "entities": 4000,
                "entityTypes": [{"type": "schemaField", "count": 3200}, {"type": "dataset", "count": 300}],
                "properties": [
                    {"key": "personal_data", "count": 3200, "kinds": {"Boolean": 3200},
                     "byEntityType": {"schemaField": 3200},
                     "values": [{"value": True, "kind": "Boolean", "count": 290},
                                {"value": False, "kind": "Boolean", "count": 2910}]},
                    {"key": "updated_at", "count": 300, "kinds": {"String": 300}, "byEntityType": {"dataset": 300}},
                    {"key": "owner", "count": 280, "kinds": {"String": 280},
                     "values": [{"value": "crm-team", "kind": "String", "count": 40}]},
                ],
                "tags": [{"tag": "pii", "count": 312}, {"tag": "certified", "count": 20}],
            })
        if path == f"/api/v1/{WS}/graph/search/counts":
            out = {}
            for item in body["items"]:
                text = json.dumps(item["predicate"])
                if '"pii"' in text:
                    n = self.counts["tag:pii"]
                elif "personal_data" in text:
                    n = self.counts["property:personal_data"]
                else:
                    n = 7
                out[item["id"]] = {"count": n, "status": "complete"}
            return httpx.Response(200, json={"counts": out})
        if path == f"/api/v1/{WS}/graph/search/resolve":
            results = []
            for ref in body["refs"]:
                if "**" in ref.get("path", []) and not ref.get("caseSensitive"):
                    # As the platform answers: '**' compares names exactly.
                    return httpx.Response(422, json={"detail": "a path with '**' compares names exactly"})
                names = [p for p in ref.get("path", []) if p != "**"]
                if names and names[-1] == "first_name":
                    results.append({"count": 1, "matches": [{"urn": COL, "displayName": "first_name",
                                    "entityType": "schemaField",
                                    "ancestorPath": [{"urn": TABLE, "displayName": "customers",
                                                      "entityType": "dataset"}]}]})
                else:
                    results.append({"count": 0, "matches": []})
            return httpx.Response(200, json={"results": results})
        if path == f"/api/v1/{WS}/graph/search/advanced":
            return httpx.Response(200, json={
                "totalCount": 214, "countStatus": "exact", "status": "complete",
                "hits": [{"node": NODES[COL], "ancestorPath": [{"urn": TABLE, "displayName": "customers",
                                                                "entityType": "dataset"}]}],
                "aggregates": [
                    [{"ancestorUrn": "schemaField", "ancestorDisplayName": "schemaField",
                      "ancestorEntityType": "", "ancestorDepthFromScopeRoot": 0, "matchCount": 214}],
                    [{"ancestorUrn": TABLE, "ancestorDisplayName": "customers", "ancestorEntityType": "dataset",
                      "ancestorDepthFromScopeRoot": 1, "matchCount": 31}],
                ],
                "elapsedMs": 12,
            })
        if path.startswith(f"/api/v1/{WS}/graph/nodes/") and path.endswith("/ancestors"):
            return httpx.Response(200, json=[NODES[TABLE], NODES[SCHEMA_URN]])
        if path.startswith(f"/api/v1/{WS}/graph/nodes/"):
            urn = httpx.URL(path).path.split("/nodes/", 1)[1]
            from urllib.parse import unquote
            return httpx.Response(200, json=NODES[unquote(urn)])
        if path == f"/api/v1/{WS}/graph/trace/closure":
            return httpx.Response(200, json={
                "nodes": list(NODES.values()),
                "edges": [
                    {"id": "e1", "sourceUrn": COL, "targetUrn": JOB, "edgeType": "CONSUMES"},
                    {"id": "e2", "sourceUrn": JOB, "targetUrn": COL2, "edgeType": "TRANSFORMS",
                     "properties": {"transform_expression": "concat(first_name, ' ', last_name)"}},
                    {"id": "e3", "sourceUrn": COL2, "targetUrn": DASH, "edgeType": "CONSUMES"},
                ],
                "containmentEdges": [
                    {"id": "c1", "sourceUrn": TABLE, "targetUrn": COL, "edgeType": "CONTAINS"},
                    {"id": "c2", "sourceUrn": DIM, "targetUrn": COL2, "edgeType": "CONTAINS"},
                    {"id": "c3", "sourceUrn": SCHEMA_URN, "targetUrn": TABLE, "edgeType": "CONTAINS"},
                ],
                "downstreamUrns": [JOB, COL2, DASH], "upstreamUrns": [],
                "focus": {"urn": COL}, "effectiveLevel": 0, "truncated": False,
                "frontierDown": [], "frontierUp": [],
            })
        return httpx.Response(404, json={"detail": {"error": "not_found", "message": path}})


class ScriptedModel:
    """Each completion call gets the next reply: a list of tool calls, or text."""

    def __init__(self, replies: list) -> None:
        self.replies = list(replies)
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        reply = self.replies.pop(0) if self.replies else "Done."
        if not body.get("stream"):
            content = reply if isinstance(reply, str) else json.dumps(reply)
            return httpx.Response(200, json={"model": "fake-1", "choices": [{"message": {"content": content}}],
                                             "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
        chunks = []
        if isinstance(reply, str):
            chunks.append({"choices": [{"delta": {"content": reply}}]})
        else:
            for i, (name, args) in enumerate(reply):
                chunks.append({"choices": [{"delta": {"tool_calls": [{"index": i, "id": f"call_{i}",
                               "function": {"name": name, "arguments": json.dumps(args)}}]}}]})
        chunks.append({"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20}})
        text = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, content=text.encode(), headers={"content-type": "text/event-stream"})


CORPUS = {"version": 1, "entries": [{
    "area": "guide", "slug": "managing-views", "title": "Managing & Sharing Views", "href": "/guide/managing-views",
    "sections": [{"anchor": "share-with-people", "heading": "Share with people",
                  "href": "/guide/managing-views#share-with-people",
                  "text": "To share a View with a person, open Share in the View's header and add them. "
                          "{brand} sends them a link."}],
}], "faqs": []}


@pytest_asyncio.fixture
async def world(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=AI_TABLES))
    ai_db.set_session_factory(async_sessionmaker(engine, expire_on_commit=False))
    settings_store.invalidate()
    G.clear_cache()
    agent_loop._running.clear()
    config = AiServiceConfig(platform_api_url="http://platform", turn_timeout_seconds=60)
    set_config_for_tests(config)
    platform = FakePlatform()
    platform_transport = httpx.MockTransport(platform)
    knowledge = KnowledgeService(config, store=MemoryVectorStore(), corpus=CORPUS,
                                 platform_transport=platform_transport)
    app = create_app(knowledge=knowledge, start_background=False)
    app.state.platform_transport = platform_transport
    async with ai_db.session_scope() as session:
        row = AiLlmConnectionORM(id="llm_1", name="Fake", kind="openai_compatible",
                                 base_url="https://llm.example/v1", auth_type="none",
                                 models=json.dumps({"chat": "fake-1"}), created_at="x", updated_at="x")
        session.add(row)
        await settings_store.save(session, {"chatConnectionId": "llm_1"}, user_id="admin")

    class World:
        pass

    w = World()
    w.app, w.platform, w.knowledge = app, platform, knowledge

    def script(replies):
        model = ScriptedModel(replies)
        connections.registry.transport = httpx.MockTransport(model)
        connections.registry._built.clear()
        return model

    w.script = script
    yield w
    connections.registry.transport = None
    connections.registry._built.clear()
    set_config_for_tests(None)
    ai_db.set_session_factory(None)
    settings_store.invalidate()
    await engine.dispose()


HEADERS = {"X-AI-User-Id": "user_1", "X-AI-User-Name": "Ada", "X-AI-User-Email": "ada%40example.com",
           "X-AI-Delegation": "nxdlg_test"}


async def chat(app, body: dict, headers: dict | None = None) -> list[tuple[str, Any]]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai") as client:
        response = await client.post("/chat/stream", json=body, headers={**HEADERS, **(headers or {})},
                                     timeout=30)
        assert response.status_code == 200, response.text
        events = []
        for frame in response.text.split("\n\n"):
            lines = [l for l in frame.splitlines() if l and not l.startswith(":")]
            if not lines:
                continue
            name = lines[0].split(": ", 1)[1]
            data = json.loads(lines[1].split(": ", 1)[1])
            events.append((name, data))
        return events


def of(events, name):
    return [d for n, d in events if n == name]


CONTEXT = {"workspaceId": WS, "dataSourceId": DS, "viewId": VIEW}


async def test_impact_turn_reports_who_why_and_when(world):
    model = world.script([
        [("analyze_impact", {"name": "customers/first_name", "change": "drop"})],
        "Dropping **first_name** breaks the Customer 360 dashboard.",
    ])
    events = await chat(world.app, {"message": "If first_name in customers is dropped, who is impacted?",
                                    "context": CONTEXT})
    assert events[0][0] == "meta" and events[-1] == ("done", {"status": "ok"})
    report = next(b["data"] for b in of(events, "block") if b["type"] == "impact")
    assert report["target"]["urn"] == COL and report["target"]["path"] == ["crm", "customers"]
    assert report["totals"]["entities"] == 3 and report["totals"]["exact"] is True
    assert [c["name"] for c in report["consumers"]] == ["Customer 360"]
    assert report["consumers"][0]["hops"] == 3
    assert report["severity"] == "high"
    owners = {o["owner"] for o in report["owners"]}
    assert {"bi-team", "analytics-team"} <= owners
    assert report["paths"][0]["edges"][1]["detail"] == "concat(first_name, ' ', last_name)"
    # Columns are named with their table: many columns share a name.
    assert [n["name"] for n in report["paths"][0]["nodes"]][:3] == [
        "customers.first_name", "dbt_dim_customer", "dim_customer.full_name"]
    assert report["timing"]["schedules"][0]["human"] == "daily at 04:00 UTC"
    assert report["resultRef"] == "r1"
    assert "".join(d["delta"] for d in of(events, "text")).startswith("Dropping")
    assert of(events, "followups")
    # The model saw a summary, not the graph.
    tool_message = next(m for m in model.requests[1]["messages"] if m["role"] == "tool")
    assert "Customer 360" in tool_message["content"] and len(tool_message["content"]) < 4000


async def test_pii_is_asked_about_then_remembered_and_used(world):
    world.script([[("resolve_concept", {"concept": "PII", "appliesTo": "schemaField"})]])
    events = await chat(world.app, {"message": "Which columns hold PII?", "context": CONTEXT})
    clarify = of(events, "clarify")[0]
    assert events[-1] == ("done", {"status": "clarify"})
    labels = [o["label"] for o in clarify["options"]]
    assert "Tag “pii”" in labels and "personal_data is true" in labels and "Any of these" in labels
    conversation_id = events[0][1]["conversationId"]
    tag_option = next(o for o in clarify["options"] if o["label"] == "Tag “pii”")

    world.script([
        [("search_entities", {"title": "PII columns",
                              "predicate": {"kind": "group", "op": "and", "children": [
                                  {"kind": "entityType", "op": "in", "values": ["schemaField"]},
                                  {"kind": "concept", "name": "PII"}]}})],
        "There are 214 PII columns.",
    ])
    events = await chat(world.app, {"conversationId": conversation_id, "message": "",
                                    "clarification": {"id": clarify["id"], "optionId": tag_option["id"],
                                                      "remember": True}, "context": CONTEXT})
    results = next(b["data"] for b in of(events, "block") if b["type"] == "results")
    assert results["total"] == 214 and results["byContainer"][0]["count"] == 31
    sent = next(c for c in world.platform.calls if c[1].endswith("/search/advanced"))[2]
    assert {"kind": "tag", "op": "has", "values": ["pii"]} in sent["predicate"]["children"]
    async with ai_db.session_scope() as session:
        from sqlalchemy import select
        mapping = (await session.execute(select(AiConceptMappingORM))).scalar_one()
    assert (mapping.concept, mapping.scope, mapping.user_id) == ("pii", "personal", "user_1")


async def test_follow_up_composes_with_an_earlier_result(world):
    world.script([[("search_entities", {"title": "PII columns", "predicate": {"kind": "tag", "op": "has", "values": ["pii"]}})],
                  "214 columns."])
    events = await chat(world.app, {"message": "columns tagged pii", "context": CONTEXT})
    conversation_id = events[0][1]["conversationId"]
    world.script([[("search_entities", {"title": "of those, feeding a dashboard", "predicate": {
        "kind": "group", "op": "and", "children": [
            {"kind": "resultSet", "ref": "r1"},
            {"kind": "related", "axis": "downstream", "maxHops": 3,
             "where": {"kind": "entityType", "op": "in", "values": ["dashboard"]}}]}})], "Seven of them."])
    world.platform.calls.clear()
    await chat(world.app, {"conversationId": conversation_id, "message": "do any of those feed a dashboard?",
                           "context": CONTEXT})
    sent = next(c for c in world.platform.calls if c[1].endswith("/search/advanced"))[2]
    assert sent["predicate"]["children"][0] == {"kind": "tag", "op": "has", "values": ["pii"]}
    assert sent["predicate"]["children"][1]["axis"] == "downstream"


async def test_an_invalid_predicate_is_returned_to_the_model_not_run(world):
    model = world.script([[("search_entities", {"title": "x", "predicate": {"kind": "tag", "values": ["pii"], "bogus": 1}})],
                          "Sorry."])
    world.platform.calls.clear()
    await chat(world.app, {"message": "tagged pii", "context": CONTEXT})
    assert not any(c[1].endswith("/search/advanced") for c in world.platform.calls)
    tool_message = next(m for m in model.requests[1]["messages"] if m["role"] == "tool")
    assert "bogus" in tool_message["content"]


async def test_help_answers_from_the_docs_with_citations(world):
    world.script([[("search_docs", {"query": "share a view"})], "Open **Share** [1]."])
    events = await chat(world.app, {"message": "How do I share a view?", "persona": "auto", "context": {}})
    assert events[0][1]["persona"] == "help"
    citations = next(b["data"] for b in of(events, "block") if b["type"] == "citations")
    item = citations["items"][0]
    assert item["href"] == "/guide/managing-views#share-with-people"
    assert "Synodic" in item["snippet"] and "{brand}" not in item["snippet"]


async def test_find_views_by_topic(world):
    world.script([[("find_views", {"query": "supply chain failures", "synonyms": ["supplier", "delay"]})],
                  "Yes — *Supplier delays*."])
    events = await chat(world.app, {"message": "Do we have views about supply chain failures?", "context": {}})
    views = next(b["data"] for b in of(events, "block") if b["type"] == "views")
    assert views["items"][0]["name"] == "Supplier delays"
    assert any(a["kind"] == "open_view" for batch in of(events, "actions") for a in batch)


async def test_budget_and_configuration_are_checked_first(world):
    async with ai_db.session_scope() as session:
        session.add(AiUsageDailyORM(user_id="user_1", day=agent_loop._today(), requests=1,
                                    input_tokens=500_000, output_tokens=0))
    events = await chat(world.app, {"message": "anything", "context": CONTEXT})
    assert of(events, "error")[0]["code"] == "budget_exhausted"


async def test_query_draft_validates_and_counts(world):
    world.script([{"predicate": {"kind": "group", "op": "and", "children": [
        {"kind": "entityType", "op": "in", "values": ["dataset"]},
        {"kind": "related", "axis": "descendant", "where": {"kind": "tag", "op": "has", "values": ["pii"]}}]},
        "explanation": "Tables holding a PII column.", "assumptions": []}])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=world.app), base_url="http://ai") as client:
        response = await client.post("/query/draft", headers=HEADERS, json={
            "question": "tables with pii columns", "mode": "search", "context": CONTEXT})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["predicate"]["children"][1]["axis"] == "descendant"
    assert body["count"] == 312 and body["countExact"] is True


async def test_cypher_draft_is_guarded(world):
    world.script([{"cypher": "MATCH (n:dataset) DETACH DELETE n", "explanation": "x"},
                   {"cypher": "MATCH (n:dataset) RETURN n.displayName LIMIT 50", "explanation": "Every dataset."}])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=world.app), base_url="http://ai") as client:
        response = await client.post("/query/draft", headers=HEADERS, json={
            "question": "list datasets", "mode": "cypher", "context": CONTEXT})
    body = response.json()
    assert body["guard"] == {"ok": True} and body["cypher"].endswith("LIMIT 50")


async def test_knowledge_mcp_speaks_the_protocol(world):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=world.app), base_url="http://ai") as client:
        init = await client.post("/mcp/knowledge", headers=HEADERS, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}}})
        assert init.json()["result"]["capabilities"] == {"tools": {"listChanged": False}}
        note = await client.post("/mcp/knowledge", headers=HEADERS,
                                 json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        assert note.status_code == 202
        listed = await client.post("/mcp/knowledge", headers=HEADERS,
                                   json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert {t["name"] for t in listed.json()["result"]["tools"]} == {
            "list_collections", "search_knowledge", "get_document"}
        called = await client.post("/mcp/knowledge", headers=HEADERS, json={
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "search_knowledge", "arguments": {"query": "share a view"}}})
        result = called.json()["result"]
        assert result["isError"] is False
        assert result["structuredContent"]["results"][0]["url"] == "/guide/managing-views#share-with-people"
        assert (await client.get("/mcp/knowledge", headers=HEADERS)).status_code == 405


async def test_conversations_are_the_callers_own(world):
    world.script(["Hello."])
    events = await chat(world.app, {"message": "hi", "persona": "data", "context": {}})
    conversation_id = events[0][1]["conversationId"]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=world.app), base_url="http://ai") as client:
        mine = await client.get(f"/conversations/{conversation_id}", headers=HEADERS)
        assert [m["role"] for m in mine.json()["messages"]] == ["user", "assistant"]
        other = dict(HEADERS, **{"X-AI-User-Id": "user_2"})
        assert (await client.get(f"/conversations/{conversation_id}", headers=other)).status_code == 404
        message_id = mine.json()["messages"][1]["id"]
        assert (await client.post(f"/messages/{message_id}/feedback", headers=other,
                                  json={"rating": 1})).status_code == 404
        assert (await client.post(f"/messages/{message_id}/feedback", headers=HEADERS,
                                  json={"rating": -1, "comment": "wrong"})).status_code == 204


async def test_requests_without_a_caller_are_refused(world):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=world.app), base_url="http://ai") as client:
        response = await client.post("/chat/stream", json={"message": "hi"})
    assert response.status_code == 401


# ── What the assistant knows about where the person is ──────────────────


async def context_card(app, headers: dict | None = None, **params) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai") as client:
        return await client.get("/context", params=params, headers={**HEADERS, **(headers or {})})


def model_context(model: "ScriptedModel") -> str:
    return next(m["content"] for m in model.requests[0]["messages"]
                if m["role"] == "system" and m["content"].startswith("CONTEXT"))


async def test_the_context_card_holds_layers_types_hierarchy_and_connections(world):
    response = await context_card(world.app, viewId=VIEW)
    assert response.status_code == 200, response.text
    brief = response.json()
    assert brief["kind"] == "view"
    about = brief["about"]
    assert (about["name"], about["semanticLayer"], about["owner"], about["layout"]) == (
        "Customer lineage", "Lineage core", "Grace", "reference")
    assert [layer["name"] for layer in brief["layers"]] == ["Sources", "Marts"]
    assert brief["hierarchy"]["chains"][0] == ["container", "dataset", "schemaField"]
    connections = {c["id"]: c for c in brief["connections"]}
    assert connections["CONTAINS"]["class"] == "containment" and connections["CONTAINS"]["count"] == 8000
    assert connections["CONTAINS"]["description"] is None          # the platform's placeholder is dropped
    assert connections["CONSUMES"]["to"] == ["dashboard"]
    assert "AGGREGATED" not in connections
    types = {t["id"]: t for t in brief["types"]}
    assert (types["schemaField"]["inView"], types["schemaField"]["inSource"]) == (3200, 7000)
    assert brief["contents"]["entities"] == 4000
    assert "secret_outside_the_view" not in response.text        # introspection's sample names never leave


async def test_the_model_sees_the_brief_within_its_budget(world):
    model = world.script(["Fine."])
    await chat(world.app, {"message": "What is this view about?", "context": CONTEXT})
    text = model_context(model)
    assert "Sources" in text and "container › dataset › schemaField" in text and "Lineage core" in text
    assert "(truncated)" not in text and len(text) < 16_100


async def test_describe_context_shows_the_card(world):
    world.script([[("describe_context", {})], "Here is what I know about it."])
    events = await chat(world.app, {"message": "What do you know about this view?", "context": CONTEXT})
    card = next(b["data"] for b in of(events, "block") if b["type"] == "context")
    assert card["about"]["name"] == "Customer lineage" and card["layers"]


async def test_descriptions_stay_with_the_person_when_the_policy_withholds_them(world):
    async with ai_db.session_scope() as session:
        await settings_store.save(session, {"dataPolicy": {"sendDescriptions": False}}, user_id="admin")
    model = world.script(["Fine."])
    await chat(world.app, {"message": "What is this?", "context": CONTEXT})
    text = model_context(model)
    assert "CRM to BI" not in text and "One column computed" not in text
    assert "CRM to BI" in (await context_card(world.app, viewId=VIEW)).text


async def test_graph_reads_name_the_view(world):
    world.script(["Fine."])
    await chat(world.app, {"message": "What is this?", "context": {**CONTEXT, "workspaceId": "ws_elsewhere"}})
    graph_reads = [(path, params) for path, params in world.platform.params if "/graph/" in path]
    assert graph_reads and all(params.get("viewId") == VIEW for _, params in graph_reads)
    assert all(path.startswith(f"/api/v1/{WS}/") for path, _ in graph_reads)   # the view's workspace wins


async def test_a_shared_view_keeps_searches_inside_it(world):
    world.script([[("search_entities", {"title": "All", "scope": "data_source",
                                        "predicate": {"kind": "tag", "op": "has", "values": ["pii"]}})],
                  "Done."])
    await chat(world.app, {"message": "everything tagged pii", "context": CONTEXT}, headers={"X-AI-Reach": "view"})
    sent = next(c for c in world.platform.calls if c[1].endswith("/search/advanced"))[2]
    assert sent["scope"]["scopeMode"] == "view"
    brief = (await context_card(world.app, headers={"X-AI-Reach": "view"}, viewId=VIEW)).json()
    assert "view_only" in {c["code"] for c in brief["caveats"]}


async def test_help_on_a_docs_page_knows_the_page(world):
    model = world.script(["It explains sharing [1]."])
    await chat(world.app, {"message": "Summarise this page", "persona": "help", "context": {
        "page": {"kind": "doc", "id": "/guide/managing-views", "title": "Managing & Sharing Views"}}})
    assert "Share with people" in model_context(model)
    brief = (await context_card(world.app, pageKind="doc", pageId="/guide/managing-views")).json()
    assert brief["kind"] == "doc" and brief["headings"] == ["Share with people"]


# ── A data source with a generic schema ─────────────────────────────────

G_TABLE, G_COL, G_JOB, G_DASH = "urn:g:orders", "urn:g:orders.total", "urn:g:load_orders", "urn:g:revenue"
G_NODES = {
    G_TABLE: node(G_TABLE, "orders", "Node", kind="table", owner_team="sales-eng"),
    G_COL: node(G_COL, "total", "Node", kind="column"),
    G_JOB: node(G_JOB, "load_orders", "Node", kind="job", cron="0 4 * * *"),
    G_DASH: node(G_DASH, "Revenue board", "Node", kind="dashboard", owner_team="bi"),
}


class GenericPlatform(FakePlatform):
    """Everything is a ``Node``; its ``kind`` says what it is; one edge type;
    no semantic layer, so no hierarchy."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        if path == f"/api/v1/views/{VIEW}":
            self.calls.append((request.method, path, body))
            return httpx.Response(200, json={"id": VIEW, "name": "Everything", "workspaceId": WS,
                                             "dataSourceId": DS, "dataSourceName": "Graph"})
        if path == "/api/v1/admin/workspaces":
            return httpx.Response(200, json=[{"id": WS, "name": "Data", "dataSources": [
                {"id": DS, "label": "Graph", "ontologyId": None}]}])
        if path == f"/api/v1/{WS}/graph/metadata/schema":
            return httpx.Response(200, json={"data": {
                "entityTypes": [{"id": "Node", "name": "Node", "description": "Entity type: Node"}],
                "relationshipTypes": [{"id": "RELATED", "name": "RELATED", "isLineage": True,
                                       "sourceTypes": ["Node"], "targetTypes": ["Node"]}],
                "containmentEdgeTypes": [], "lineageEdgeTypes": ["RELATED"],
            }, "meta": {"status": "fresh"}})
        if path == f"/api/v1/{WS}/graph/introspection":
            return httpx.Response(200, json={"data": {
                "totalNodes": 500, "totalEdges": 900,
                "entityTypeStats": [{"id": "Node", "name": "Node", "count": 500}],
                "edgeTypeStats": [{"id": "RELATED", "name": "RELATED", "count": 900}]}})
        if path == f"/api/v1/{WS}/graph/search/catalog":
            return httpx.Response(200, json={
                "sessionId": "g1", "status": "complete", "entities": 500,
                "entityTypes": [{"type": "Node", "count": 500}],
                "properties": [
                    {"key": "kind", "count": 500, "kinds": {"String": 500}, "byEntityType": {"Node": 500},
                     "distinct": 4, "distinctExact": True,
                     "values": [{"value": v, "kind": "String", "count": n}
                                for v, n in (("table", 300), ("column", 150), ("dashboard", 30), ("job", 20))]},
                    {"key": "name", "count": 500, "kinds": {"String": 500}, "byEntityType": {"Node": 500},
                     "distinct": 480, "distinctExact": True, "values": []},
                    {"key": "owner_team", "count": 400, "kinds": {"String": 400}, "byEntityType": {"Node": 400},
                     "distinct": 3, "distinctExact": True,
                     "values": [{"value": "sales-eng", "kind": "String", "count": 300}]},
                    {"key": "cron", "count": 20, "kinds": {"String": 20}, "byEntityType": {"Node": 20},
                     "distinct": 2, "distinctExact": True, "values": []},
                ],
                "tags": [],
            })
        if path.startswith(f"/api/v1/{WS}/graph/nodes/") and path.endswith("/ancestors"):
            self.calls.append((request.method, path, body))
            return httpx.Response(200, json=[])
        if path.startswith(f"/api/v1/{WS}/graph/nodes/"):
            from urllib.parse import unquote
            return httpx.Response(200, json=G_NODES[unquote(path.split("/nodes/", 1)[1])])
        if path == f"/api/v1/{WS}/graph/trace/closure":
            return httpx.Response(200, json={
                "nodes": list(G_NODES.values()),
                "edges": [{"id": "e1", "sourceUrn": G_COL, "targetUrn": G_JOB, "edgeType": "RELATED"},
                          {"id": "e2", "sourceUrn": G_JOB, "targetUrn": G_DASH, "edgeType": "RELATED"}],
                "containmentEdges": [], "downstreamUrns": [G_JOB, G_DASH], "upstreamUrns": [],
                "focus": {"urn": G_COL}, "truncated": False, "frontierDown": [], "frontierUp": [],
            })
        return super().__call__(request)


def use_generic(world) -> GenericPlatform:
    platform = GenericPlatform()
    world.app.state.platform_transport = httpx.MockTransport(platform)
    world.platform = platform
    return platform


async def test_a_generic_schema_is_diagnosed(world):
    use_generic(world)
    brief = (await context_card(world.app, viewId=VIEW)).json()
    assert (brief["typeProperty"]["status"], brief["typeProperty"]["key"], brief["typeProperty"]["on"]) == (
        "suggested", "kind", "Node")
    assert [v["value"] for v in brief["typeProperty"]["values"]] == ["table", "column", "dashboard", "job"]
    codes = {c["code"] for c in brief["caveats"]}
    assert {"few_types", "no_semantic_layer"} <= codes
    assert "no_lineage" not in codes          # said once, by the semantic layer's absence
    assert next(c for c in brief["caveats"] if c["code"] == "few_types")["action"] == "confirm_type"


TABLES = {"kind": "entityType", "op": "in", "values": ["tables"]}


def reads_through_kind(predicate: dict) -> bool:
    """``Node`` whose ``kind`` is ``table`` — the validated rule may add defaults."""
    on, prop = predicate["children"]
    return (predicate["op"] == "and" and on == {"kind": "entityType", "op": "in", "values": ["Node"]}
            and {k: prop[k] for k in ("kind", "key", "op", "value")} ==
            {"kind": "property", "key": "kind", "op": "in", "value": ["table"]})


async def test_the_type_property_is_asked_once_then_used(world):
    use_generic(world)
    world.script([[("search_entities", {"title": "Tables", "predicate": TABLES})]])
    events = await chat(world.app, {"message": "How many tables are there?", "context": CONTEXT})
    clarify = of(events, "clarify")[0]
    assert events[-1] == ("done", {"status": "clarify"})
    assert "Which property says what kind of thing" in clarify["question"]
    option = clarify["options"][0]
    assert option["label"] == "The property “kind”" and "table 300" in option["description"]
    assert not any(o["id"] == "opt_any" for o in clarify["options"])
    assert not any(c[1].endswith("/search/advanced") for c in world.platform.calls)

    world.script([[("search_entities", {"title": "Tables", "predicate": TABLES})], "There are 300 tables."])
    await chat(world.app, {"conversationId": events[0][1]["conversationId"], "message": "",
                           "clarification": {"id": clarify["id"], "optionId": option["id"], "remember": True},
                           "context": CONTEXT})
    sent = next(c for c in world.platform.calls if c[1].endswith("/search/advanced"))[2]
    assert reads_through_kind(sent["predicate"])
    assert sent["options"]["aggregations"][0] == {"by": "property", "propertyKey": "kind", "maxBuckets": 12,
                                                  "sampleHitsPerBucket": 0}
    async with ai_db.session_scope() as session:
        from sqlalchemy import select
        mapping = (await session.execute(select(AiConceptMappingORM))).scalar_one()
    assert (mapping.concept, mapping.scope) == ("entitytype", "personal")

    world.platform.calls.clear()
    world.script([[("search_entities", {"title": "Tables", "predicate": TABLES})], "300."])
    events = await chat(world.app, {"message": "And tables again?", "context": CONTEXT})
    assert not of(events, "clarify")
    sent = next(c for c in world.platform.calls if c[1].endswith("/search/advanced"))[2]
    assert reads_through_kind(sent["predicate"])
    brief = (await context_card(world.app, viewId=VIEW)).json()
    assert brief["typeProperty"]["status"] == "confirmed"
    assert "few_types" not in {c["code"] for c in brief["caveats"]}


async def test_an_unknown_type_goes_back_to_the_model(world):
    model = world.script([[("search_entities", {"title": "x", "predicate": {
        "kind": "entityType", "op": "in", "values": ["spaceship"]}})], "Sorry."])
    await chat(world.app, {"message": "spaceships?", "context": CONTEXT})
    tool_message = next(m for m in model.requests[1]["messages"] if m["role"] == "tool")
    assert "Unknown entity type(s): spaceship" in tool_message["content"] and "schemaField" in tool_message["content"]


async def test_impact_on_a_generic_schema_finds_sinks_owners_and_schedules(world):
    use_generic(world)
    async with ai_db.session_scope() as session:
        session.add(AiConceptMappingORM(
            workspace_id=WS, data_source_id=DS, scope="workspace", concept="entitytype",
            label="The property “kind” on Node", created_at="x", updated_at="x",
            predicate=json.dumps({"kind": "group", "op": "and", "children": [
                {"kind": "entityType", "op": "in", "values": ["Node"]}, {"kind": "hasProperty", "key": "kind"}]})))
    world.script([[("analyze_impact", {"urn": G_COL, "change": "drop"})], "It breaks the Revenue board."])
    events = await chat(world.app, {"message": "What breaks if total is dropped?", "context": CONTEXT})
    report = next(b["data"] for b in of(events, "block") if b["type"] == "impact")
    assert [(c["name"], c["type"]) for c in report["consumers"]] == [("Revenue board", "dashboard")]
    assert report["target"]["type"] == "column"
    assert "bi" in {o["owner"] for o in report["owners"]}
    assert report["timing"]["schedules"][0]["job"]["name"] == "load_orders"
    assert report["timing"]["schedules"][0]["human"] == "daily at 04:00 UTC"
    assert "Show only the dashboards" in of(events, "followups")[0]

