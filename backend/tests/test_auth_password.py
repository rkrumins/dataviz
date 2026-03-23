"""
Tests for backend.app.auth.password — hash_password / verify_password.
"""
from backend.app.auth.password import hash_password, verify_password


class TestHashPassword:
    def test_returns_non_empty_string(self):
        h = hash_password("my_secret_123")
        assert isinstance(h, str)
        assert len(h) > 0

    def test_hash_differs_from_input(self):
        plain = "password"
        h = hash_password(plain)
        assert h != plain


class TestVerifyPassword:
    def test_correct_password_returns_true(self):
        plain = "correct-horse-battery-staple"
        h = hash_password(plain)
        assert verify_password(plain, h) is True

    def test_wrong_password_returns_false(self):
        h = hash_password("right_password")
        assert verify_password("wrong_password", h) is False

    def test_garbage_hash_returns_false(self):
        assert verify_password("anything", "not-a-valid-hash") is False
