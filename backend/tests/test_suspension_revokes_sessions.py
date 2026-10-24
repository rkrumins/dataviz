"""Suspending a user must also end their live sessions.

Suspension is enforced on the read side today: ``validate_session``
(``auth_service/service.py:222``) loads the user on every authenticated
request and refuses anything whose status is not ``active``. So these
tests are not guarding a live hole — they are guarding the invariant
that lets that per-request read be removed.

That read is the single largest per-request tax in the application: a
pool checkout and two SELECTs to answer "who is this", on every
authenticated request. The plan is to serve identity from the Redis
entry the request already fetches. The moment that lands, a status
column nobody reads stops enforcing anything, and the session tombstone
becomes the enforcement.

``suspend_user`` ends sessions through ``revoke_every_session_for_user``.
Reject needs nothing of the kind: a pending account cannot sign in (every
sign-in path requires ``active``), so it holds no sessions to end.

Scope: **status** paths only. The role paths are covered by
``test_rbac_phase7.py:151``, group bindings and workspace membership by
``test_rbac_revocation_chain.py``.
"""
from __future__ import annotations

import json

from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import OutboxEventORM, UserORM
from backend.app.services.revocation_service import get_revocation_service


async def _seed_user(db_session, email: str):
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email=email,
        password_hash="hash123",
        first_name="Sub",
        last_name="Ject",
    )
    await user_repo.update_user_status(db_session, user.id, "active")
    return user


async def test_suspend_revokes_the_users_live_sessions(
    test_client: AsyncClient, db_session,
):
    svc = get_revocation_service()
    user = await _seed_user(db_session, "suspend_revokes@example.com")
    await db_session.commit()
    await svc.record_session(user.id, "sess_suspend_1")
    await svc.record_session(user.id, "sess_suspend_2")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/suspend")

    assert resp.status_code == 200
    assert await svc.is_revoked("sess_suspend_1")
    assert await svc.is_revoked("sess_suspend_2")


async def test_revocation_is_scoped_to_the_suspended_user(
    test_client: AsyncClient, db_session,
):
    """A revocation that over-reaches signs out bystanders, and would
    pass every assertion above."""
    svc = get_revocation_service()
    target = await _seed_user(db_session, "scoped_target@example.com")
    bystander = await _seed_user(db_session, "scoped_bystander@example.com")
    await db_session.commit()
    await svc.record_session(target.id, "sess_target")
    await svc.record_session(bystander.id, "sess_bystander")

    resp = await test_client.post(f"/api/v1/admin/users/{target.id}/suspend")

    assert resp.status_code == 200
    assert await svc.is_revoked("sess_target")
    assert not await svc.is_revoked("sess_bystander")


async def test_a_suspension_stops_a_refresh_minting_a_new_session(
    test_client: AsyncClient, db_session,
):
    """Tombstoning the live ``sid``s is only half of ending a session:
    the tombstones expire with the access token, and the next refresh
    mints a fresh, untombstoned one. ``sessions_valid_from`` is the half
    that stops the refresh — what ``revoke_every_session_for_user``
    exists to keep paired with the other."""
    user = await _seed_user(db_session, "suspend_cutoff@example.com")
    await db_session.commit()

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/suspend")
    assert resp.status_code == 200

    cutoff = (await db_session.execute(
        select(UserORM.sessions_valid_from).where(UserORM.id == user.id)
    )).scalar_one()
    assert cutoff is not None, "the suspension left the user's refresh tokens valid"


async def test_a_suspension_is_audited_as_one_revocation(
    test_client: AsyncClient, db_session,
):
    """Revoke once. Two calls that each revoke look harmless — revocation
    is idempotent — but each one writes a ``user.session_revoked`` event,
    so the audit log reports two revocations for one suspension."""
    user = await _seed_user(db_session, "audited_once@example.com")
    await db_session.commit()
    await get_revocation_service().record_session(user.id, "sess_audited")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/suspend")
    assert resp.status_code == 200

    rows = (await db_session.execute(
        select(OutboxEventORM)
        .where(OutboxEventORM.event_type == "user.session_revoked")
    )).scalars().all()
    # ``payload`` is a Text column holding JSON.
    mine = [r for r in rows if json.loads(r.payload or "{}").get("user_id") == user.id]
    assert len(mine) == 1, f"{len(mine)} revocation events for one suspension"
