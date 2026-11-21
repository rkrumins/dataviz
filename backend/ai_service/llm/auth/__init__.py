"""How a connection signs in to its endpoint.

Enterprises sign in to their completion gateways in many ways, so the method
is data, not code: an ``auth_type`` plus a non-secret ``auth_config`` and the
secrets (stored encrypted, never returned). Every strategy applies itself to a
request and can be told the endpoint refused it (``invalidate``), after which
the adapter retries once with fresh credentials.

=========================  ==================================================
``none``                   Nothing — an endpoint inside a trusted network.
``api_key``                A key in a header (``Authorization: Bearer <key>``
                           by default; ``api-key: <key>`` for Azure) or a
                           query parameter.
``bearer``                 A static token in ``Authorization: Bearer``.
``basic``                  A username and password, HTTP Basic.
``oauth2_client_credentials``  A client id and secret exchanged at a token
                           URL for a short-lived bearer token (RFC 6749 §4.4).
``token_mint``             Any request to a token URL — a username and
                           password, a client secret, a custom body — whose
                           answer holds a token, found by a JSON path, used in
                           a header of your choosing. For gateways that mint
                           their own tokens.
=========================  ==================================================

Minted tokens are cached per connection, refreshed at 80% of their life by
one caller at a time, and dropped when the endpoint answers 401.
"""
from __future__ import annotations

from .strategies import (
    AUTH_TYPES,
    SECRET_FIELDS,
    AuthStrategy,
    build_auth,
    describe_auth_fields,
    json_path,
    render_template,
)

__all__ = [
    "AUTH_TYPES", "SECRET_FIELDS", "AuthStrategy", "build_auth",
    "describe_auth_fields", "json_path", "render_template",
]
