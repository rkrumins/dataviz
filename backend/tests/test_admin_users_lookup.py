"""Regression tests for ``/api/v1/admin/users/search`` (Phase 8).

Two production bugs the user surfaced from the SSO admin page:

1. ``GET /admin/users/search?q=`` returned 422 because the ``q``
   query parameter had ``min_length=1``. The FE hits this endpoint
   on page load before the user has typed.

2. ``GET /admin/users/search?q=admin`` returned 500 because the
   handler ran four ``session.execute(...)`` calls concurrently via
   ``asyncio.gather`` against one AsyncSession. SQLAlchemy refuses
   concurrent operations on the same session.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.repositories import user_repo


@pytest.mark.asyncio
async def test_search_users_empty_q_returns_empty_list(
    test_client: AsyncClient, db_session,
):
    """Empty / whitespace ``q`` short-circuits to ``[]`` instead of
    422 — matches the FE's "no needle yet" expectation."""
    for q in ("", "  ", "\t"):
        resp = await test_client.get(
            "/api/v1/admin/users/search",
            params={"q": q, "limit": 20},
        )
        assert resp.status_code == 200, (q, resp.text)
        assert resp.json() == [], (q, resp.json())


@pytest.mark.asyncio
async def test_search_users_real_q_no_concurrent_session_error(
    test_client: AsyncClient, db_session,
):
    """Non-empty ``q`` runs the four underlying scans sequentially
    (not via ``asyncio.gather``) so SQLAlchemy doesn't raise
    ``InvalidRequestError: concurrent operations are not permitted``.

    Seeds a single user so the fan-out has at least one row to
    return; the test asserts 200 + that the matched user appears.
    """
    user = await user_repo.create_user(
        db_session,
        email="alice_admin@example.com",
        password_hash="x",
        first_name="Alice",
        last_name="Admin",
    )
    await db_session.commit()

    resp = await test_client.get(
        "/api/v1/admin/users/search",
        params={"q": "admin", "limit": 20},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    matched_ids = {row["id"] for row in body}
    assert user.id in matched_ids
