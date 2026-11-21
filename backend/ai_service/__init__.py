"""The AI service: the assistant, natural-language querying and the knowledge MCP.

A separate process (``python -m backend.ai_service``) behind the web tier,
which authenticates every request and hands this service a read-only
delegation to act as the person asking (``backend/app/auth/delegation.py``).
Every read of the platform's data goes back through the platform's own API;
this package holds no graph or view access of its own. See
``docs/services/AI.md`` and ADR-031.
"""
