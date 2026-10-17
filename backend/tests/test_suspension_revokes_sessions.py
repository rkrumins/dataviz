"""Deactivating a user must also end their live sessions.

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

Which makes the ordering the whole point. Cache first and suspension
silently degrades to "takes effect within a TTL", with no test failing
and no error logged to say so. Revoke first and the cache is safe by
the same argument that already protects role changes.

Scope: **status** paths only. The role paths were never missing this —
``PUT /admin/users/{id}/role`` is covered by
``test_rbac_phase7.py:151``, group bindings and workspace membership by
``test_rbac_revocation_chain.py``. Status was the gap, because status
was the one whose enforcement lived somewhere else.
"""
from __future__ import annotations

import inspect
import re

import pytest
from httpx import AsyncClient

from backend.app.services.revocation_service import get_revocation_service


async def _seed_user(db_session, email: str, status: str = "active"):
    from backend.app.db.repositories import user_repo

    user = await user_repo.create_user(
        db_session,
        email=email,
        password_hash="hash123",
        first_name="Sub",
        last_name="Ject",
    )
    await user_repo.update_user_status(db_session, user.id, status)
    return user


# ── The two paths that were missing it ────────────────────────────────


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


async def test_reject_revokes_the_users_live_sessions(
    test_client: AsyncClient, db_session,
):
    """Reject is the one that looks like it could not matter.

    A pending user cannot authenticate, so "reject kills sessions" reads
    like a no-op — until you notice that approve and reject are separate
    endpoints against the same row, so a user approved at 10:00 and
    rejected at 10:01 spends that minute holding real sessions.
    """
    svc = get_revocation_service()
    user = await _seed_user(db_session, "reject_revokes@example.com", status="pending")
    await db_session.commit()
    await svc.record_session(user.id, "sess_reject_1")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/reject")

    assert resp.status_code == 200
    assert await svc.is_revoked("sess_reject_1")


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


async def test_the_outbox_records_how_many_sessions_died(
    test_client: AsyncClient, db_session,
):
    """``change_role`` already reports this and the audit trail is the
    only place an operator can see that a suspension actually reached
    the sessions — revocation is best-effort and returns 0 rather than
    raising, so a silent 0 is the failure mode worth being able to see.
    """
    import json

    from sqlalchemy import select

    from backend.app.db import models as _models

    user = await _seed_user(db_session, "outbox_counts@example.com")
    await db_session.commit()
    await get_revocation_service().record_session(user.id, "sess_outbox")

    resp = await test_client.post(f"/api/v1/admin/users/{user.id}/suspend")
    assert resp.status_code == 200

    rows = (await db_session.execute(
        select(_models.OutboxEventORM)
        .where(_models.OutboxEventORM.event_type == "user.suspended")
    )).scalars().all()
    # ``payload`` is a Text column holding JSON (``models.py:2458``).
    decoded = [json.loads(r.payload or "{}") for r in rows]
    payloads = [p for p in decoded if p.get("user_id") == user.id]
    assert payloads, "no user.suspended outbox event was written"
    assert payloads[-1].get("sessions_revoked") == 1


# ── The invariant, structurally ───────────────────────────────────────


def test_no_deactivation_path_can_skip_revocation():
    """The behavioural tests above cover the two paths that exist today.

    This one covers the path somebody adds next year. Both call sites
    were written by someone who had no reason to think about session
    revocation — the bug was not a mistake in the code, it was the
    absence of anything connecting the two ideas. A third endpoint that
    suspends a user would be written the same way and would be just as
    correct-looking.

    So the rule is expressed where it can be enforced rather than
    documented: setting a user's status to ``suspended`` happens inside
    ``_suspend_and_revoke`` or it does not happen. Asserting on source
    is unusual, but the alternative is a comment, and a comment does not
    fail.

    This checks only *where* the status is set. That the helper then
    actually revokes is covered behaviourally above — deliberately, and
    not by reading its source: an earlier version of this file asserted
    ``"revoke_subject_sessions" in helper_source`` and passed happily
    against a helper whose body had been replaced with ``return 0``,
    because the import line inside the function satisfied the substring.
    """
    from backend.app.api.v1.endpoints import users as users_module

    source = inspect.getsource(users_module)
    helper = inspect.getsource(users_module._suspend_and_revoke)

    outside = source.replace(helper, "")
    offenders = re.findall(
        r"update_user_status\([^)]*?[\"']suspended[\"']", outside, re.S,
    )

    assert not offenders, (
        "A user is being suspended outside _suspend_and_revoke, so their "
        "live sessions survive the suspension: "
        f"{offenders}. Route it through the helper."
    )


@pytest.mark.parametrize("endpoint", ["suspend", "reject"])
def test_both_endpoints_route_through_the_helper(endpoint: str):
    """Named explicitly, so deleting a call rather than editing it is
    also caught — the lint above only sees what is still there."""
    from backend.app.api.v1.endpoints import users as users_module

    func = getattr(users_module, f"{endpoint}_user")
    assert "_suspend_and_revoke" in inspect.getsource(func)
