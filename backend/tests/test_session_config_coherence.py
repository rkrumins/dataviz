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

The same drift then recurred one level up, in the TTL itself: 5 in code,
15 in every ``.env`` and the configmap, 60 in both compose files — which
this module did not read. Since that one number decides when a page hits
the refresh path, every "it only breaks when the token expires" report
behaved differently per environment and reproduced nowhere. The compose
files are in ``_CONFIG_FILES`` now, and the code default is asserted
against them, so a fifth number cannot appear quietly.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

# Every place an operator can set the access TTL. Compose included: it is
# what ``./dev.sh up`` and ``./deploy.sh up`` actually run, so leaving it
# out made this suite green while the running system disagreed.
_CONFIG_FILES = [
    REPO / ".env.example",
    REPO / ".env.dev",
    REPO / ".env.prod.example",
    REPO / "deploy/k8s/base/configmaps/common-config.yaml",
    REPO / "docker-compose.yml",
    REPO / "docker-compose.quickstart.yml",
]

# Above this, a revoked session keeps working for an uncomfortably long
# time and the tombstone has to be held in Redis for the whole window.
_MAX_REASONABLE_ACCESS_MINUTES = 15

# ``KEY=15``, ``KEY: "15"``, or compose's ``KEY: "${KEY:-15}"`` — the
# interpolation default is the effective value when the env var is unset,
# which is the case for every operator who has not overridden it.
_ACCESS_TTL_PATTERNS = (
    r'^\s*JWT_EXPIRY_MINUTES:?\s*=?\s*"?\$\{JWT_EXPIRY_MINUTES:-(\d+)\}"?\s*$',
    r'^\s*JWT_EXPIRY_MINUTES:?\s*=?\s*"?(\d+)"?\s*$',
)


def _access_minutes(path: Path) -> int | None:
    if not path.exists():
        return None
    text = path.read_text()
    for pattern in _ACCESS_TTL_PATTERNS:
        match = re.search(pattern, text, re.MULTILINE)
        if match:
            return int(match.group(1))
    return None


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


def test_the_code_default_matches_the_shipped_configs():
    """The fourth number nobody was comparing.

    An operator who sets nothing gets the code default; one who copies
    ``.env.example`` gets that. When they differ, the same build behaves
    two ways and only one of them is the one anybody tested.
    """
    from backend.auth_service.core.config import _DEFAULT_ACCESS_EXPIRY_MINUTES

    shipped = {
        path.name: _access_minutes(path)
        for path in _CONFIG_FILES
        if _access_minutes(path) is not None
    }
    assert shipped, "no shipped config declares JWT_EXPIRY_MINUTES"
    assert set(shipped.values()) == {_DEFAULT_ACCESS_EXPIRY_MINUTES}, (
        f"code default is {_DEFAULT_ACCESS_EXPIRY_MINUTES} but shipped "
        f"configs say {shipped}"
    )


def test_revocation_ttl_outlives_the_access_token():
    """The derived default must satisfy the invariant on its own."""
    from backend.app.services.revocation_service import REVOCATION_TTL_SECONDS
    from backend.auth_service.core.config import JWT_EXPIRY_MINUTES

    assert REVOCATION_TTL_SECONDS >= JWT_EXPIRY_MINUTES * 60, (
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
    with pytest.raises(RuntimeError, match="shorter than the access-token"):
        main_module._assert_session_config_coherent()


def test_startup_accepts_a_coherent_config():
    from backend.app import main as main_module

    main_module._assert_session_config_coherent()


# ── The revocation store has to be shared ────────────────────────────


def test_startup_refuses_a_per_process_revocation_store_in_prod(monkeypatch):
    """Two workers with two revocation stores is worse than it sounds.

    The in-memory fallback is right where it lives — on the per-request
    path, raising would turn a config typo into a total auth outage. But
    the app runs two gunicorn workers, so a revocation recorded in one is
    invisible to the other: a suspended user's requests alternate between
    refused and served depending on who answers. Boot is the moment to be
    strict; nothing is being served and someone is watching.
    """
    from backend.app import main as main_module

    monkeypatch.setattr("backend.auth_service.core.config.ENV", "production")
    with pytest.raises(RuntimeError, match="in-process backend"):
        main_module._assert_revocation_is_shared()


def test_startup_only_warns_about_it_outside_prod(caplog):
    """Dev and test must keep working without a Redis.

    That is the whole reason the fallback exists; a check that broke it
    would just get reverted.
    """
    from backend.app import main as main_module

    with caplog.at_level("WARNING"):
        main_module._assert_revocation_is_shared()
    assert any("in-process backend" in r.message for r in caplog.records)
