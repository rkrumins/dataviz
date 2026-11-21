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
        self.counts = {"tag:pii": 312, "property:personal_data": 290}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        assert request.headers.get("authorization", "").startswith("Bearer nxdlg_") or path in (
            "/api/v1/features/values", "/api/v1/branding",
        )
        if path == f"/api/v1/views/{VIEW}":
            return httpx.Response(200, json={"id": VIEW, "name": "Customer lineage", "workspaceId": WS,
                                             "dataSourceId": DS, "dataSourceName": "CRM lake",
                                             "workspaceName": "Data", "description": "CRM to BI"})
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
                "relationshipTypes": [{"id": "CONTAINS", "name": "Contains", "isContainment": True},
                                      {"id": "TRANSFORMS", "name": "Transforms", "isLineage": True}],
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


async def chat(app, body: dict) -> list[tuple[str, Any]]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai") as client:
        response = await client.post("/chat/stream", json=body, headers=HEADERS, timeout=30)
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
