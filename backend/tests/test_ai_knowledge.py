"""The knowledge layer: chunks, lexical ranking, embedding sync and MCP sources.

The sync is held to its promises: unchanged text is never re-embedded, a new
model builds beside the old and switches at once, a failed build leaves the
active version serving, and removed documents leave the index.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from backend.ai_service.config import AiServiceConfig
from backend.ai_service.knowledge import corpus as corpus_mod
from backend.ai_service.knowledge.embedder import Embedder
from backend.ai_service.knowledge.indexer import sync_chunks, view_chunk
from backend.ai_service.knowledge.lexical import Bm25Index, tokenize
from backend.ai_service.knowledge.retrieval import Hit, fuse
from backend.ai_service.knowledge.service import KnowledgeService
from backend.ai_service.knowledge.sources import ExternalMcpSource, ask_all
from backend.ai_service.knowledge.store import MemoryVectorStore
from backend.ai_service.llm.types import Capabilities, LlmError
from backend.ai_service.mcp.protocol import McpServer, McpTool

CORPUS = {"version": 1, "entries": [
    {"area": "guide", "slug": "managing-views", "title": "Managing & Sharing Views",
     "href": "/guide/managing-views", "sections": [
         {"anchor": "share-with-people", "heading": "Share with people",
          "href": "/guide/managing-views#share-with-people",
          "text": "Open Share in the View's header and add a person or a group."},
         {"anchor": "publish", "heading": "Publish a View to everyone",
          "href": "/guide/managing-views#publish", "text": "Publishing makes a View readable by everyone."},
     ]},
    {"area": "docs", "slug": "rbac", "title": "RBAC", "href": "/docs/rbac", "sections": [
        {"anchor": "", "heading": "RBAC", "href": "/docs/rbac",
         "text": ("Permissions are granted by roles. " * 80) + "\n\n" + ("Workspaces scope roles. " * 80)},
    ]},
], "faqs": [{"area": "guide", "question": "What is {brand}?", "answer": "{brand} maps data lineage.",
             "href": "/guide#faq-what-is-brand"}]}


class FakeProvider:
    def __init__(self, dims=4, fail=False):
        self.calls = 0
        self.dims = dims
        self.fail = fail
        self.capabilities = Capabilities(embeddings=True, embedding_dimensions=dims)

    async def embed(self, texts, dimensions=None):
        self.calls += 1
        if self.fail:
            raise LlmError("unavailable", "down")
        return [[float(len(t) % 7), 1.0, float(t.count("a")), 0.5][: self.dims] for t in texts]


def test_chunks_carry_reader_anchors_and_split_long_sections():
    chunks = corpus_mod.chunks(CORPUS)
    share = next(c for c in chunks if c.heading == "Share with people")
    assert share.url == "/guide/managing-views#share-with-people"
    rbac = [c for c in chunks if c.source_id == "docs/rbac#"]
    assert len(rbac) >= 2 and len({c.id for c in rbac}) == len(rbac)
    faq = next(c for c in chunks if c.metadata.get("kind") == "faq")
    assert corpus_mod.fill_brand(faq.text, "Synodic") == "Synodic maps data lineage."


def test_bm25_ranks_the_section_that_answers():
    chunks = corpus_mod.chunks(CORPUS)
    index = Bm25Index().build(chunks, text_of=lambda c: f"{c.title} {c.heading} {c.text}")
    best = index.search("how do I share a view with someone", limit=1)[0][0]
    assert best.heading == "Share with people"
    assert tokenize("Sharing views") == ["shar", "view"]


def test_fusion_rewards_agreement():
    a = [Hit("1", "s1", "", "", "", ""), Hit("2", "s2", "", "", "", "")]
    b = [Hit("2", "s2", "", "", "", ""), Hit("3", "s3", "", "", "", "")]
    assert [h.id for h in fuse(a, b, limit=3)][0] == "2"


async def test_sync_embeds_only_what_changed_and_deletes_what_left():
    store = MemoryVectorStore()
    provider = FakeProvider()
    embedder = Embedder(provider, model="emb-1", dimensions=None)
    chunks = corpus_mod.chunks(CORPUS)
    first = await sync_chunks(store, embedder, "docs", chunks, chunker="sections-v1")
    sources = len({c.source_id for c in chunks})
    assert first.embedded == sources and first.status == "ok"
    second = await sync_chunks(store, embedder, "docs", chunks, chunker="sections-v1")
    assert (second.embedded, second.unchanged, second.version) == (0, sources, first.version)
    changed = [*chunks[1:], corpus_mod.Chunk(**{**chunks[0].__dict__, "text": "Edited text."})]
    third = await sync_chunks(store, embedder, "docs", changed[:-2] + changed[-1:], chunker="sections-v1")
    assert third.embedded == 1 and third.deleted >= 1
    active = await store.active("docs")
    assert active.version == first.version and active.dimensions == 4


async def test_a_new_model_builds_beside_the_old_and_switches_at_once():
    store = MemoryVectorStore()
    chunks = corpus_mod.chunks(CORPUS)
    old = await sync_chunks(store, Embedder(FakeProvider(), model="emb-1", dimensions=4), "docs",
                            chunks, chunker="sections-v1")
    new = await sync_chunks(store, Embedder(FakeProvider(dims=3), model="emb-2", dimensions=3), "docs",
                            chunks, chunker="sections-v1")
    versions = {v.version: v.status for v in await store.versions("docs")}
    assert new.version == old.version + 1
    assert versions == {old.version: "retired", new.version: "active"}
    assert (await store.active("docs")).model == "emb-2"


async def test_a_failed_build_leaves_the_active_version_serving():
    store = MemoryVectorStore()
    chunks = corpus_mod.chunks(CORPUS)
    await sync_chunks(store, Embedder(FakeProvider(), model="emb-1", dimensions=4), "docs", chunks,
                      chunker="sections-v1")
    failing = Embedder(FakeProvider(dims=3, fail=True), model="emb-2", dimensions=3,
                       sleep=lambda _: asyncio.sleep(0))
    report = await sync_chunks(store, failing, "docs", chunks, chunker="sections-v1")
    assert report.status == "failed"
    assert (await store.active("docs")).model == "emb-1"


async def test_the_embedder_breaker_opens_after_repeated_failures():
    clock = [0.0]
    embedder = Embedder(FakeProvider(fail=True), model="m", dimensions=4,
                        sleep=lambda _: asyncio.sleep(0), clock=lambda: clock[0])
    for _ in range(3):
        with pytest.raises(Exception):
            await embedder.embed_query("x")
    assert not embedder.available
    clock[0] = 61
    assert embedder.available


def test_view_cards_carry_what_matters_and_where_to_open():
    chunk = view_chunk({"id": "v1", "name": "Supplier delays", "description": "Late shipments",
                        "tags": ["ops"], "workspaceName": "Ops", "dataSourceName": "ERP",
                        "visibility": "workspace"})
    assert chunk.url == "/views/v1" and "Late shipments" in chunk.text and "Tags: ops" in chunk.text
    assert chunk.metadata["viewId"] == "v1"


async def test_docs_search_is_lexical_without_an_embedder(monkeypatch):
    service = KnowledgeService(AiServiceConfig(), store=MemoryVectorStore(), corpus=CORPUS)

    async def none():
        return None

    monkeypatch.setattr(service, "embedder", none)
    hits = await service.search_docs_local("publish a view to everyone", limit=2)
    assert hits[0].url == "/guide/managing-views#publish"


async def test_docs_search_fuses_dense_hits_when_there_is_an_index(monkeypatch):
    store = MemoryVectorStore()
    service = KnowledgeService(AiServiceConfig(), store=store, corpus=CORPUS)
    embedder = Embedder(FakeProvider(), model="emb-1", dimensions=4)

    async def factory():
        return embedder

    monkeypatch.setattr(service, "embedder", factory)
    await sync_chunks(store, embedder, "docs", service.docs, chunker="sections-v1")
    hits = await service.search_docs_local("share with people", limit=3)
    assert any(h.heading == "Share with people" for h in hits)


def _mcp_transport(server: McpServer):
    async def handler(request: httpx.Request) -> httpx.Response:
        status, body = await server.handle_http(request.content, None)
        if body is None:
            return httpx.Response(status)
        return httpx.Response(status, json=body, headers={"mcp-session-id": "s1"})

    return httpx.MockTransport(handler)


async def test_an_external_mcp_source_is_called_mapped_and_labelled():
    seen = {}

    async def search(arguments, caller):
        seen.update(arguments)
        return {"hits": [{"name": "Runbook: supplier outage", "body": "Call the vendor.",
                          "link": "https://wiki.example/runbook"}]}

    server = McpServer(name="wiki", version="1", instructions="", tools=[
        McpTool("search_wiki", "", {"type": "object"}, search)])
    row = SimpleNamespace(
        id="ks_1", name="Ops wiki", trust_label="internal wiki", tool_name="search_wiki",
        timeout_ms=3000, argument_map=json.dumps({"query": "q", "limit": "max"}),
        result_map=json.dumps({"items": "hits", "title": "name", "text": "body", "url": "link"}),
        url="https://wiki.example/mcp", auth_type="none", auth_config="{}", secrets_encrypted=None,
    )
    source = ExternalMcpSource(row, allow_hosts=frozenset(), transport=_mcp_transport(server))
    hits = await source.search("supplier outage", 3, None)
    assert seen == {"q": "supplier outage", "max": 3}
    assert (hits[0].title, hits[0].url, hits[0].source, hits[0].trust) == (
        "Runbook: supplier outage", "https://wiki.example/runbook", "Ops wiki", "internal wiki")
    report = await source.test()
    assert report["ok"] is True


async def test_a_slow_source_is_left_out_not_waited_on():
    class Slow:
        name, trust, timeout = "slow", "external", 0.05

        async def search(self, query, limit, caller):
            await asyncio.sleep(5)

    class Quick:
        name, trust, timeout = "quick", "product", 1

        async def search(self, query, limit, caller):
            return [Hit("1", "s", "t", "", "", "x")]

    rankings = await ask_all([Slow(), Quick()], "q", 3, None)
    assert rankings[0] == [] and rankings[1][0].id == "1"


async def test_mcp_server_refuses_what_is_not_the_protocol():
    server = McpServer(name="k", version="1", instructions="", tools=[])
    assert (await server.handle_http(b"not json", None))[0] == 400
    assert (await server.handle_http(b"[]", None))[0] == 400
    status, body = await server.handle_http(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "nope"}).encode(), None)
    assert status == 200 and body["error"]["code"] == -32601
    status, body = await server.handle_http(json.dumps({
        "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}}).encode(), None)
    assert body["result"]["protocolVersion"] == "2025-06-18"
