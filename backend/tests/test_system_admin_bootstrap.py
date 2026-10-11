"""The built-in administrator chooses its own password.

The first administrator is seeded from ``ADMIN_PASSWORD``, which somebody
other than the administrator chose and which often comes straight from
this repository's examples. It used to be held for a change only when it
matched one of three published values; an operator's own value was
accepted as is, and an existing account never got re-checked.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth import bootstrap
from backend.app.auth.password import hash_password, verify_password
from backend.app.db.models import UserORM
from backend.app.db.repositories import user_repo
from backend.auth_service.core.password import disabled_password_hash

_OPERATOR_CHOSEN = "Operator!Chosen#Passw0rd"


async def _flag(session: AsyncSession, user_id: str) -> bool:
    return (await session.execute(
        select(UserORM.must_change_password).where(UserORM.id == user_id)
    )).scalar_one()


async def _system_account(session: AsyncSession, email: str, password_hash: str) -> str:
    user = await user_repo.create_user(
        session, email=email, password_hash=password_hash,
        first_name="System", last_name="Admin", status="active",
    )
    await user_repo.set_system_account(session, user.id, True)
    return user.id


# ── Seeding ──────────────────────────────────────────────────────────

async def test_the_seeded_admin_must_replace_even_an_operator_chosen_password(
    db_session, monkeypatch,
):
    monkeypatch.setenv("ADMIN_EMAIL", "root@example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", _OPERATOR_CHOSEN)

    assert await bootstrap.seed_system_admin(db_session) == "root@example.com"

    user = await user_repo.get_user_by_email(db_session, "root@example.com")
    assert verify_password(_OPERATOR_CHOSEN, user.password_hash)
    assert await _flag(db_session, user.id) is True
    assert user.is_system_account is True


async def test_an_empty_admin_password_means_the_default_not_no_password(
    db_session, monkeypatch,
):
    """Password sign-in refuses an empty password, so an administrator
    seeded with one could never sign in at all."""
    monkeypatch.setenv("ADMIN_EMAIL", "")
    monkeypatch.setenv("ADMIN_PASSWORD", "")

    email = await bootstrap.seed_system_admin(db_session)

    assert email == bootstrap.DEFAULT_ADMIN_EMAIL
    user = await user_repo.get_user_by_email(db_session, email)
    assert verify_password(bootstrap.DEFAULT_ADMIN_PASSWORD, user.password_hash)
    assert await _flag(db_session, user.id) is True


async def test_nothing_is_seeded_once_anyone_exists(db_session, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", _OPERATOR_CHOSEN)
    await user_repo.create_user(
        db_session, email="first@example.com", password_hash=hash_password("x" * 12),
        first_name="First", last_name="User", status="active",
    )
    assert await bootstrap.seed_system_admin(db_session) is None


# ── Existing installs ────────────────────────────────────────────────

async def test_a_system_account_still_on_its_starting_password_is_held(
    db_session, monkeypatch,
):
    monkeypatch.setenv("ADMIN_PASSWORD", _OPERATOR_CHOSEN)
    uid = await _system_account(
        db_session, "admin@example.com", hash_password(_OPERATOR_CHOSEN))

    assert await bootstrap.hold_unchanged_system_accounts(db_session) == [uid]
    assert await _flag(db_session, uid) is True


async def test_a_system_account_on_a_published_password_is_held(
    db_session, monkeypatch,
):
    """Even when the deployment's own ADMIN_PASSWORD has since changed."""
    monkeypatch.setenv("ADMIN_PASSWORD", _OPERATOR_CHOSEN)
    uid = await _system_account(
        db_session, "admin@example.com", hash_password("admin123"))

    assert await bootstrap.hold_unchanged_system_accounts(db_session) == [uid]


async def test_accounts_that_chose_their_own_password_are_left_alone(
    db_session, monkeypatch,
):
    monkeypatch.setenv("ADMIN_PASSWORD", _OPERATOR_CHOSEN)
    changed = await _system_account(
        db_session, "changed@example.com", hash_password("Their#Own!Choice-42"))
    sso_only = await _system_account(
        db_session, "sso@example.com", disabled_password_hash())
    ordinary = await user_repo.create_user(
        db_session, email="person@example.com",
        password_hash=hash_password("admin123"),
        first_name="Ordinary", last_name="Person", status="active",
    )

    assert await bootstrap.hold_unchanged_system_accounts(db_session) == []
    for uid in (changed, sso_only, ordinary.id):
        assert await _flag(db_session, uid) is False


async def test_an_account_already_held_is_not_checked_again(db_session, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", _OPERATOR_CHOSEN)
    uid = await _system_account(
        db_session, "admin@example.com", hash_password(_OPERATOR_CHOSEN))
    assert await bootstrap.hold_unchanged_system_accounts(db_session) == [uid]
    assert await bootstrap.hold_unchanged_system_accounts(db_session) == []


# ── The published list keeps up with the examples ────────────────────

_REPO = Path(__file__).resolve().parents[2]
_SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__"}
_ASSIGNMENT = re.compile(
    r"""(?:ADMIN_PASSWORD|adminPassword)["']?\s*[=:]\s*["']?([^\s"'`]+)""")


def _published_values() -> dict[str, str]:
    """Every literal admin password the repository's examples assign.

    Example files only: a real ``.env`` / ``.env.dev`` holds a real
    password, which has no business in a test report.
    """
    found: dict[str, str] = {}
    for root, dirs, files in os.walk(_REPO):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for name in files:
            if not name.endswith(
                    (".example", ".md", ".yml", ".yaml", ".sh", ".txt")):
                continue
            path = Path(root) / name
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for value in _ASSIGNMENT.findall(text):
                # Templating and shell expansion are not values.
                if value.startswith(("$", "{")):
                    continue
                found.setdefault(value, str(path.relative_to(_REPO)))
    return found


def test_every_published_example_password_is_on_the_list():
    found = _published_values()
    assert "admin123" in found, "the scan found nothing; it proves nothing"
    # Where, not what: the files are enough to find the value.
    missing = sorted(where for v, where in found.items()
                     if v not in bootstrap.PUBLISHED_PASSWORDS)
    assert missing == [], (
        "An example assigns an admin password that "
        "backend/app/auth/bootstrap.py PUBLISHED_PASSWORDS doesn't list, so an "
        "install still using it would not be made to change it."
    )
