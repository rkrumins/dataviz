"""
Tests for the auth-service token helpers — create_access_token /
decode_token round-trip.

Imports go through ``backend.app.auth.jwt`` (the compatibility shim) so
the tests double as a regression check that the shim still re-exports
the right symbols. The expiry monkeypatch targets the canonical module
where the constant actually lives.
"""
import jwt as pyjwt

from backend.app.auth.jwt import create_access_token, decode_token
from backend.auth_service.core import tokens as tokens_mod


class TestCreateAndDecodeToken:
    def test_round_trip_basic_claims(self):
        token = create_access_token("usr_abc123", "alice@example.com", "admin")
        payload = decode_token(token)
        assert payload["sub"] == "usr_abc123"
        assert payload["email"] == "alice@example.com"
        assert payload["role"] == "admin"

    def test_extra_claims_included(self):
        token = create_access_token(
            "usr_x", "x@x.com", "viewer", extra={"workspace_id": "ws_42", "custom": True}
        )
        payload = decode_token(token)
        assert payload["workspace_id"] == "ws_42"
        assert payload["custom"] is True

    def test_issuer_and_audience_present(self):
        token = create_access_token("usr_1", "a@b.com", "editor")
        payload = decode_token(token)
        assert payload["iss"] == "nexus-lineage"
        assert payload["aud"] == "nexus-lineage"

    def test_expired_token_raises(self, monkeypatch):
        # Force expiry to be in the past by setting a negative-equivalent expiry
        monkeypatch.setattr(tokens_mod, "JWT_EXPIRY_MINUTES", -1)
        token = create_access_token("usr_exp", "exp@test.com", "viewer")
        try:
            decode_token(token)
            assert False, "Expected ExpiredSignatureError"
        except pyjwt.ExpiredSignatureError:
            pass

    def test_tampered_token_raises(self):
        token = create_access_token("usr_tam", "tam@test.com", "viewer")
        # Flip a character in the middle of the token
        chars = list(token)
        mid = len(chars) // 2
        chars[mid] = "A" if chars[mid] != "A" else "B"
        tampered = "".join(chars)
        try:
            decode_token(tampered)
            assert False, "Expected InvalidTokenError"
        except pyjwt.InvalidTokenError:
            pass
