"""The startup path has to be executed by something.

Nothing in this suite ran ``app/main.py``'s lifespan. ``conftest``'s
``test_client`` says so outright — "Import app lazily to avoid
triggering lifespan / real DB init at import time" — and no test uses a
lifespan manager. So every line that decides whether the process boots
at all was covered by nothing, and a ``NameError`` in it shipped:

    File "/app/backend/app/main.py", line 222, in _log_auth_fingerprint
        _auth_config.JWT_SECRET_KEY_ID,
    NameError: name '_auth_config' is not defined

Every worker crashed on startup and gunicorn looped. The suite was green.

This is the third blind spot of the same family — ``claims_resolver=None``
hid the cookie-size ceiling, ``refresh_store_factory=lambda s: None`` hid
refresh persistence — and it is the worst of the three, because it covers
the code that decides whether anything runs.

The tests here are deliberately narrow. They do not try to boot a real
application: that needs Postgres, Redis and a migration, none of which
belong in a unit run. What they do is execute the startup helpers, and
assert that startup never fails for a reason that is a *typo*. An
environment that cannot reach a database is a legitimate reason for the
lifespan to complain; a name that does not exist is not.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

_REPO_ROOT = __file__.rsplit("/backend/", 1)[0]


def test_the_auth_fingerprint_log_actually_runs():
    """The exact frame from the crash.

    It reads the key ring through the config module, which is precisely
    the reference that was missing. Calling it is the whole test — if the
    name is not bound, this raises.
    """
    from backend.app.main import _log_auth_fingerprint

    _log_auth_fingerprint()


def test_the_startup_secret_assertion_actually_runs():
    """The other new call in the lifespan.

    ``assert_signing_secret`` is what preserves "a process that signs
    tokens refuses to start without a secret" now that the key ring
    resolves lazily. It is reached through the same module reference, so
    it fails the same way if that reference is wrong.
    """
    from backend.app.main import _auth_config

    _auth_config.assert_signing_secret()


def test_the_config_coherence_check_actually_runs():
    from backend.app.main import _assert_session_config_coherent

    _assert_session_config_coherent()


@pytest.mark.parametrize(
    "name",
    [
        "_log_auth_fingerprint",
        "_assert_session_config_coherent",
        "_auth_config",
        "lifespan",
        "app",
    ],
)
def test_the_lifespan_depends_only_on_names_that_exist(name: str):
    """A module-level inventory of what the lifespan reaches for.

    Cheap, and it catches the whole class: an import edited by hand or by
    script that removes a name still in use. The crash was exactly this —
    two names were dropped from an import block and a third, never added,
    was used in their place.
    """
    import backend.app.main as main

    assert hasattr(main, name), (
        f"app.main is missing {name!r}, which the startup path references"
    )


def test_the_lifespan_never_fails_on_a_missing_name():
    """Run the real lifespan and classify how it fails.

    **In a subprocess, and that is not incidental.** Running it in-process
    against the shared ``app`` singleton sets ``app.state.degraded``
    (there is no database here), and every later test in the session then
    gets 503 "Service is starting up". The first version of this test did
    exactly that and broke 376 unrelated tests — a test that damages the
    suite it belongs to is worse than the gap it closes.

    In a unit environment startup will not complete: no Postgres, no
    Redis, and the app is designed to degrade rather than die, so it may
    also finish cleanly. Either is fine. What is not fine is ``NameError``
    or ``AttributeError`` — those mean the startup path refers to
    something that does not exist, which is not a property of the
    environment and cannot be waited out.
    """
    source = textwrap.dedent(
        """
        import asyncio, sys

        async def main():
            from backend.app.main import app, lifespan
            try:
                async with lifespan(app):
                    pass
            except (NameError, AttributeError) as exc:
                print(f'BAD_NAME:{exc}')
                return
            except Exception:
                pass
            print('OK')

        asyncio.run(main())
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", source],
        capture_output=True, text=True, timeout=300,
        env={
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": _REPO_ROOT,
            "PYTHONDONTWRITEBYTECODE": "1",
            "JWT_SECRET_KEY": "x" * 48,
        },
    )
    assert "BAD_NAME" not in result.stdout, (
        "startup referenced a name that does not exist: " + result.stdout
    )
    assert "OK" in result.stdout, (
        f"the lifespan did not run at all:\n{result.stderr[-3000:]}"
    )
