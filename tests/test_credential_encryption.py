"""
Tests for credential encryption helpers in backend.app.db.repositories.connection_repo.
"""
from cryptography.fernet import Fernet

from backend.app.db.repositories.connection_repo import _encrypt, _decrypt


class TestEncryptDecryptPlaintext:
    """Without CREDENTIAL_ENCRYPTION_KEY, data is stored as plain JSON."""

    def test_round_trip_without_key(self, monkeypatch):
        monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
        data = {"host": "localhost", "port": 6379}
        blob = _encrypt(data)
        assert isinstance(blob, str)
        result = _decrypt(blob)
        assert result == data


class TestEncryptDecryptWithKey:
    """With CREDENTIAL_ENCRYPTION_KEY set, data is Fernet-encrypted."""

    def test_round_trip_with_encryption_key(self, monkeypatch):
        key = Fernet.generate_key().decode()
        monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEY", key)
        data = {"username": "admin", "password": "s3cret"}
        blob = _encrypt(data)
        # Encrypted blob should not be readable JSON
        assert "admin" not in blob
        result = _decrypt(blob)
        assert result == data


class TestDecryptEdgeCases:
    def test_none_returns_empty_dict(self, monkeypatch):
        monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
        assert _decrypt(None) == {}

    def test_empty_string_returns_empty_dict(self, monkeypatch):
        monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
        assert _decrypt("") == {}

    def test_corrupt_blob_returns_empty_dict_no_key(self, monkeypatch):
        monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY", raising=False)
        assert _decrypt("not-valid-json{{{") == {}

    def test_corrupt_blob_returns_empty_dict_with_key(self, monkeypatch):
        key = Fernet.generate_key().decode()
        monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEY", key)
        assert _decrypt("totally-not-fernet-data") == {}
