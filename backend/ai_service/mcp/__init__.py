"""The Model Context Protocol, the parts this service needs (tools).

``protocol`` is a server: JSON-RPC 2.0 over stateless streamable HTTP,
answering ``initialize``, ``ping``, ``tools/list`` and ``tools/call`` with
JSON responses. ``client`` calls a tool on another team's MCP server.
``knowledge_server`` is the product's knowledge, and ``data_server`` the
assistant's data tools (find, describe, search, trace, impact), served over it.

Why not the SDK: the server side needs four methods and no sessions, and the
SDK's current major version is a moving target; a small, tested,
spec-following implementation is cheaper to own and audit.
"""
