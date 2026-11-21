"""Product knowledge and semantic matching (ADR-033).

* ``corpus`` — the docs and user guide, as sections with the in-app reader's
  anchors (built from ``docs/`` by ``frontend/scripts/gen-ai-docs-corpus.mjs``).
* ``lexical`` — an in-memory BM25 index: always available, and the fallback
  when the vector store or the embedding model is not.
* ``store`` — the ``VectorStore`` port and its pgvector adapter: versioned
  collections, so a new embedding model is built beside the old one and
  switched to at once (blue/green).
* ``embedder`` — batching, retries and a circuit breaker around the
  connection that embeds.
* ``indexer`` — keeps the ``docs`` and ``views`` collections in step with
  their sources, re-embedding only what changed (content hashes).
* ``retrieval`` — hybrid ranking: dense and lexical, fused by reciprocal rank.
* ``sources`` — the ``KnowledgeSource`` port: the product's own knowledge,
  read through its MCP server, and MCP servers other teams host.
* ``service`` — the facade the agent, the MCP server and the admin routes use.
"""
