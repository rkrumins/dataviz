"""The access TTL and its revocation tombstone must not drift apart.

Forced revocation works by tombstoning a session's ``sid`` in Redis
until the access token carrying it expires. If the tombstone expires
first, revoking access silently stops taking effect for the tail of
every token: the account reads as revoked in the admin UI and keeps
working in the browser.

That is what shipped. ``RBAC_REVOCATION_TTL_SECONDS`` defaulted to 360s
— sized for the 5-minute access TTL in code — while every ``.env`` set
60 minutes and the k8s configmap set 15. Nothing compared the two, so
nothing noticed.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

# Every place an operator can set the access TTL.
_CONFIG_FILES = [
    REPO / ".env.example",
    REPO / ".env.dev",
    REPO / ".env.prod.example",
    REPO / "deploy/k8s/base/configmaps/common-config.yaml",
]

# Above this, a revoked session keeps working for an uncomfortably long
# time and the tombstone has to be held in Redis for the whole window.
_MAX_REASONABLE_ACCESS_MINUTES = 15


def _access_minutes(path: Path) -> int | None:
    if not path.exists():
        return None
    match = re.search(
        r'^\s*JWT_EXPIRY_MINUTES:?\s*=?\s*"?(\d+)"?\s*$',
        path.read_text(),
        re.MULTILINE,
    )
    return int(match.group(1)) if match else None


@pytest.mark.parametrize("path", _CONFIG_FILES, ids=lambda p: p.name)
def test_shipped_configs_agree_on_the_access_ttl(path: Path):
    """One number, or the next person changes three files and misses one."""
    minutes = _access_minutes(path)
    if minutes is None:
        pytest.skip(f"{path.name} does not set JWT_EXPIRY_MINUTES")
    assert minutes <= _MAX_REASONABLE_ACCESS_MINUTES, (
        f"{path.name} sets JWT_EXPIRY_MINUTES={minutes}. Claims ride in the "
        "access token, so that is how long a revoked session keeps working."
    )


def test_every_shipped_config_uses_the_same_value():
    values = {
        path.name: _access_minutes(path)
        for path in _CONFIG_FILES
        if _access_minutes(path) is not None
    }
    assert len(set(values.values())) == 1, (
        f"JWT_EXPIRY_MINUTES disagrees across shipped configs: {values}"
    )


def test_revocation_ttl_outlives_the_access_token():
    """The derived default must satisfy the invariant on its own.

    Against ``exp + leeway``, not ``exp``: a token is honoured for the
    leeway past its own expiry, so a tombstone sized to the raw TTL dies
    while the token it exists to kill is still being accepted.
    """
    from backend.app.services.revocation_service import REVOCATION_TTL_SECONDS
    from backend.auth_service.core.config import (
        CLOCK_SKEW_LEEWAY_SECONDS,
        JWT_EXPIRY_MINUTES,
    )

    acceptance_window = JWT_EXPIRY_MINUTES * 60 + CLOCK_SKEW_LEEWAY_SECONDS
    assert REVOCATION_TTL_SECONDS >= acceptance_window, (
        "a revoked session would keep working after its tombstone expired"
    )


def test_startup_refuses_an_incoherent_override(monkeypatch):
    """An explicit too-short override must stop the boot, not warn.

    The failure is otherwise invisible: revocation appears to work in
    the admin UI and does nothing in the browser.
    """
    from backend.app import main as main_module

    monkeypatch.setattr(
        "backend.app.services.revocation_service.REVOCATION_TTL_SECONDS", 60,
    )
    monkeypatch.setattr(
        "backend.auth_service.core.config.JWT_EXPIRY_MINUTES", 15,
    )
    with pytest.raises(RuntimeError, match="shorter than the window"):
        main_module._assert_session_config_coherent()


def test_startup_refuses_a_tombstone_that_covers_exp_but_not_the_leeway(
    monkeypatch,
):
    """The boundary the leeway moved.

    900s access TTL with a 900s tombstone reads as coherent — the
    tombstone covers the token's stated lifetime exactly. It is not:
    the token is still accepted for ``leeway`` seconds after that, and
    for those seconds a revoked session works again. This is the case
    that silently passed before the leeway was part of the derivation.
    """
    from backend.app import main as main_module
    from backend.auth_service.core.config import (
        CLOCK_SKEW_LEEWAY_SECONDS,
        JWT_EXPIRY_MINUTES,
    )

    assert CLOCK_SKEW_LEEWAY_SECONDS > 0, "nothing to test with no leeway"
    # Sized off the live access TTL rather than monkeypatching it. The
    # key-ring tests reload the config module, which leaves monkeypatch's
    # attribute-walk resolving a different module object than the one
    # ``main`` imports — so a patched JWT_EXPIRY_MINUTES silently does
    # nothing when this file runs after that one.
    monkeypatch.setattr(
        "backend.app.services.revocation_service.REVOCATION_TTL_SECONDS",
        JWT_EXPIRY_MINUTES * 60,
    )
    with pytest.raises(RuntimeError, match="clock-skew leeway"):
        main_module._assert_session_config_coherent()


def test_startup_accepts_a_coherent_config():
    from backend.app import main as main_module

    main_module._assert_session_config_coherent()
