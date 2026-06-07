"""Phase 0 — JWT signing secret must be explicit and strong.

There is no ephemeral fallback: an unset or too-weak ``JWT_SECRET_KEY``
fails fast at import (``_resolve_secret``) so the process never starts
in an insecure state.

The follow-up ``.env`` auto-load (Phase-0.1) only fires in
non-production environments when a ``.env*`` file is present in CWD —
both gates have to pass; either fails closed -> the file is ignored
and the fail-fast still bites.
"""
from __future__ import annotations

import importlib
import sys

import pytest

from backend.auth_service.core import config


def test_missing_secret_raises(monkeypatch):
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    with pytest.raises(config.MissingSigningSecret):
        config._resolve_secret()


def test_weak_secret_raises(monkeypatch):
    monkeypatch.setenv("JWT_SECRET_KEY", "short")
    with pytest.raises(config.MissingSigningSecret):
        config._resolve_secret()


def test_strong_secret_accepted(monkeypatch):
    strong = "x" * config._MIN_SECRET_LENGTH
    monkeypatch.setenv("JWT_SECRET_KEY", strong)
    assert config._resolve_secret() == strong


def test_no_ephemeral_fallback_symbol():
    # The old random-key fallback imported ``secrets``; assert it's gone
    # so a future edit can't silently reintroduce an ephemeral key.
    assert not hasattr(config, "secrets")


# ── Gated ``.env`` auto-load ─────────────────────────────────────────


def _reimport_config():
    """Drop the cached module and re-import so the top-of-module
    ``.env`` auto-load runs against the current CWD + ENV state."""
    sys.modules.pop("backend.auth_service.core.config", None)
    return importlib.import_module("backend.auth_service.core.config")


def test_dotenv_loads_when_dev_and_file_present(monkeypatch, tmp_path):
    """Happy path: ENV=dev + .env file in CWD -> JWT_SECRET_KEY is
    picked up from the file. The module reimport exercises the gated
    load_dotenv block at the top of config.py."""
    pytest.importorskip("dotenv")
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.chdir(tmp_path)
    strong = "z" * 48
    (tmp_path / ".env").write_text(f"JWT_SECRET_KEY={strong}\n")
    cfg = _reimport_config()
    assert cfg.JWT_SECRET_KEY == strong


def test_dotenv_skipped_in_prod_even_if_file_present(monkeypatch, tmp_path):
    """Prod gate denies the load. The stray .env is ignored and the
    fail-fast still bites when no env var is set."""
    pytest.importorskip("dotenv")
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    monkeypatch.setenv("ENV", "production")
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("JWT_SECRET_KEY=" + ("z" * 48) + "\n")
    # ``_reimport_config()`` rebinds ``MissingSigningSecret`` to a
    # fresh class object, so we match on the base ``RuntimeError`` +
    # the message to make the assertion class-identity agnostic.
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        _reimport_config()


def test_explicit_env_wins_over_dotenv_file(monkeypatch, tmp_path):
    """``override=False`` is honoured: an already-exported
    JWT_SECRET_KEY beats the file's value."""
    pytest.importorskip("dotenv")
    shell_value = "shell" + ("X" * 43)
    file_value = "file" + ("Y" * 44)
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("JWT_SECRET_KEY", shell_value)
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text(f"JWT_SECRET_KEY={file_value}\n")
    cfg = _reimport_config()
    assert cfg.JWT_SECRET_KEY == shell_value


def test_no_dotenv_file_keeps_failfast_behaviour(monkeypatch, tmp_path):
    """No .env in CWD, no shell value -> fail-fast unchanged."""
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.chdir(tmp_path)  # empty dir
    # ``_reimport_config()`` rebinds ``MissingSigningSecret`` to a
    # fresh class object, so we match on the base ``RuntimeError`` +
    # the message to make the assertion class-identity agnostic.
    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        _reimport_config()


def test_dotenv_prefers_env_dev_over_env(monkeypatch, tmp_path):
    """When both files exist, ``.env.dev`` wins (more specific)."""
    pytest.importorskip("dotenv")
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("JWT_SECRET_KEY=" + ("a" * 48) + "\n")
    (tmp_path / ".env.dev").write_text("JWT_SECRET_KEY=" + ("d" * 48) + "\n")
    cfg = _reimport_config()
    assert cfg.JWT_SECRET_KEY == "d" * 48
