"""The frontend's CSP_CONNECT_SRC hook widens connect-src, or refuses to start.

The SPA document's Content-Security-Policy (frontend/nginx.conf) allows
``connect-src 'self'`` and nothing else, which blocks an Enterprise
Gateway's browser half — the sign-in trigger and the browser-side translate
call are fetches from the page to the corporate SSO host. A second CSP header
at the ingress cannot relax that (policies intersect), so the image takes the
extra origins from CSP_CONNECT_SRC: ``frontend/nginx/40-csp-connect-src.sh``
runs from the official nginx entrypoint and rewrites the map that defines
``$csp_connect_extra``.

The value lands inside a security policy, so the script is strict: bare
https/wss origins only. Anything else — a keyword, a scheme, a path, a
``;`` that would start a new directive — must stop the container rather than
serve a policy nobody wrote. These tests hold it to that, and to leaving the
shipped default alone when nothing is configured.

Pure subprocess, no app imports: runs under ``--noconftest``.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO / "frontend" / "nginx" / "40-csp-connect-src.sh"
_DEFAULT = _REPO / "frontend" / "nginx" / "00-csp-connect.conf"

# The dev container mounts backend/ only; a CI checkout has both trees.
pytestmark = pytest.mark.skipif(
    not _SCRIPT.exists() or shutil.which("sh") is None,
    reason="needs frontend/ checked out and a POSIX sh",
)


@pytest.fixture
def conf(tmp_path: Path) -> Path:
    out = tmp_path / "00-csp-connect.conf"
    shutil.copyfile(_DEFAULT, out)
    return out


def _run(conf: Path, value: str | None) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "CSP_CONNECT_CONF": str(conf),
    }
    if value is not None:
        env["CSP_CONNECT_SRC"] = value
    return subprocess.run(
        ["sh", str(_SCRIPT)], env=env, capture_output=True,
        encoding="utf-8", errors="replace", timeout=30,
    )


def _map_line(conf: Path) -> str:
    lines = [
        ln for ln in conf.read_text().splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    ]
    assert len(lines) == 1, lines
    return lines[0]


@pytest.mark.parametrize("value", [None, "", "   "])
def test_unset_or_empty_leaves_the_shipped_default(conf: Path, value):
    result = _run(conf, value)
    assert result.returncode == 0, result.stderr
    assert conf.read_bytes() == _DEFAULT.read_bytes()


def test_one_origin_is_appended_after_a_space(conf: Path):
    result = _run(conf, "https://sso.corp.example")
    assert result.returncode == 0, result.stderr
    # The leading space is what makes the policy read
    # ``connect-src 'self' https://…`` rather than ``'self'https://…``.
    assert _map_line(conf) == (
        'map $host $csp_connect_extra { default " https://sso.corp.example"; }'
    )


def test_several_origins_are_joined_by_single_spaces(conf: Path):
    result = _run(
        conf, "  https://sso.corp.example   wss://push.corp.example:8443\n",
    )
    assert result.returncode == 0, result.stderr
    assert _map_line(conf) == (
        "map $host $csp_connect_extra "
        '{ default " https://sso.corp.example wss://push.corp.example:8443"; }'
    )


@pytest.mark.parametrize("value", [
    "http://x",
    "https://x;",
    "'unsafe-inline'",
    "https://x/path",
    "data:",
    "https://a b;c",
    # Exact origins only — no wildcards, not even a leading subdomain one.
    "https://*.corp.example",
    "*",
    'https://x"',
    "https://sso.corp.example http://x",
])
def test_anything_but_bare_https_or_wss_origins_is_refused(conf: Path, value):
    result = _run(conf, value)
    assert result.returncode != 0
    assert "CSP_CONNECT_SRC" in result.stderr
    # Refused as a whole: nothing written, not even the valid entries.
    assert conf.read_bytes() == _DEFAULT.read_bytes()
