"""Model connections: a provider-neutral port, adapters, and how to sign in.

``types`` is the vocabulary the agent speaks (messages, tools, stream events);
``provider`` the port every adapter implements and the factory that builds one
from a stored connection; ``openai_compatible`` the first adapter (OpenAI,
Azure OpenAI, vLLM, Ollama, LiteLLM and most enterprise gateways speak it);
``auth`` the ways an enterprise endpoint wants to be signed in to; ``egress``
the one HTTP client every outbound call goes through, held to the network
guard.
"""
