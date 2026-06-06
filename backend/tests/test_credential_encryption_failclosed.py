"""H3: credential stores must fail closed in production.

When ``CREDENTIAL_ENCRYPTION_KEY`` is unset, the connection and IdP
provider repos fall back to plaintext JSON. That is acceptable for
dev/test but MUST raise in a production environment rather than silently
writing secrets in the clear.
"""
import importlib

import pytest

from backend.app.db.repositories import connection_repo, idp_provider_repo
from backend.app.db.repositories.connection_repo import CredentialEncryptionError


@pytest.fixture()
def no_key(monkeypatch):
    monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)


def test_connection_encrypt_raises_in_prod_without_key(monkeypatch, no_key):
    monkeypatch.setenv("ENV", "production")
    with pytest.raises(CredentialEncryptionError):
        connection_repo._encrypt({"password": "s3cret"})


def test_idp_encrypt_raises_in_prod_without_key(monkeypatch, no_key):
    monkeypatch.setenv("ENV", "prod")
    with pytest.raises(CredentialEncryptionError):
        idp_provider_repo.encrypt_settings({"client_secret": "s3cret"})


def test_connection_encrypt_allows_plaintext_in_dev(monkeypatch, no_key):
    monkeypatch.setenv("ENV", "dev")
    blob = connection_repo._encrypt({"password": "s3cret"})
    # plaintext JSON round-trips (no Fernet wrapping in dev)
    assert "s3cret" in blob


def test_idp_encrypt_allows_plaintext_in_dev(monkeypatch, no_key):
    monkeypatch.setenv("ENV", "dev")
    blob = idp_provider_repo.encrypt_settings({"client_secret": "s3cret"})
    assert "s3cret" in blob
