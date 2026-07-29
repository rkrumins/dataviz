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
import re
import sys
from pathlib import Path

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


def test_shipped_placeholder_is_refused_despite_clearing_the_length_floor(monkeypatch):
    """The reason this check exists at all.

    ``dev-secret-key-change-in-production`` is 34 characters, so the
    length floor passed it and a deployment that copied ``.env.example``
    forward signed production tokens with a value published in this
    repository. The length assertion below is the whole point: if it
    ever fails, the placeholder has changed and this test is no longer
    reproducing the case it was written for.
    """
    placeholder = "dev-secret-key-change-in-production"
    assert len(placeholder) >= config._MIN_SECRET_LENGTH
    monkeypatch.setenv("JWT_SECRET_KEY", placeholder)
    with pytest.raises(config.MissingSigningSecret, match=r"\.env\.example"):
        config._resolve_secret()


@pytest.mark.parametrize("placeholder", sorted(config._PLACEHOLDER_SECRETS))
def test_every_shipped_placeholder_is_refused(monkeypatch, placeholder):
    monkeypatch.setenv("JWT_SECRET_KEY", placeholder)
    with pytest.raises(config.MissingSigningSecret, match="placeholder"):
        config._resolve_secret()


def test_placeholder_refused_as_a_retired_key(monkeypatch):
    """Retired keys still verify live tokens, so they carry the same bar."""
    monkeypatch.setenv("JWT_SECRET_KEY", "x" * 48)
    monkeypatch.setenv(
        "JWT_SECRET_KEY_PREVIOUS", "dev-secret-key-change-in-production"
    )
    with pytest.raises(config.MissingSigningSecret, match="placeholder"):
        config._resolve_retired_secrets()


def test_no_example_file_ships_a_secret_that_would_boot():
    """Guards the one way a literal denylist silently stops working.

    The denylist cannot cover a placeholder nobody has added to it, so
    the durable invariant is the other direction: no example file may
    assign ``JWT_SECRET_KEY`` a concrete value that a running process
    would accept. Empty, a shell/Helm interpolation, or a denylisted
    literal are the only allowed forms.

    Without this, someone adds ``docker-compose.demo.yml`` with a fresh
    32-character default and it boots clean everywhere.
    """
    repo = Path(__file__).resolve().parents[2]
    # Templates and deployment manifests only.
    #
    # ``.env.dev`` is tracked and ships the key empty, but ``dev.sh``
    # writes a real per-machine secret into it on first run — so scanning
    # it would fail on every developer's checkout the moment they started
    # the stack. The placeholder it used to carry is caught by the
    # denylist at runtime, which is the control that matters; this test
    # is the net for a NEW template arriving with a fresh weak default.
    patterns = (
        ".env.example",
        ".env*.example",
        "docker-compose*.yml",
        "deploy/k8s/**/*.yaml",
        "deploy/helm/**/*.yaml",
    )
    assignment = re.compile(r"^\s*JWT_SECRET_KEY\s*[:=]\s*(.*)$")

    offenders: list[str] = []
    for pattern in patterns:
        for path in sorted(repo.glob(pattern)):
            for lineno, line in enumerate(
                path.read_text().splitlines(), start=1
            ):
                if line.lstrip().startswith("#"):
                    continue
                match = assignment.match(line)
                if match is None:
                    continue
                value = match.group(1).strip().strip('"').strip("'")
                if not value or "${" in value or "{{" in value:
                    continue
                if value in config._PLACEHOLDER_SECRETS:
                    continue
                offenders.append(
                    f"{path.relative_to(repo)}:{lineno} assigns {value!r}"
                )

    assert not offenders, (
        "example files ship a JWT_SECRET_KEY a process would accept:\n  "
        + "\n  ".join(offenders)
        + "\nLeave it empty, interpolate it, or add the literal to "
        "_PLACEHOLDER_SECRETS."
    )


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
