"""Group membership changed by IdP sync is recorded like a manual change.

A person added to or removed from a group by hand writes
``rbac.group.member_added`` / ``member_removed``; the same change made by the
IdP group sync on sign-in wrote nothing, so the activity ledger could not say
how someone came to be in a group. Now it writes the same event types, marked
``via: "sso"`` and with no actor — no person did it — and only when a
membership actually changes: a sign-in that asserts what is already true
records nothing.
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories import (
    group_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
    user_repo,
)
from backend.app.services.activity import catalogue
from backend.app.services.permission_service import reconcile_sso_targets
from backend.auth_service.core.password import disabled_password_hash


async def _membership_events(db_session) -> list[tuple[str, dict]]:
    await db_session.flush()
    rows = (await db_session.execute(
        select(OutboxEventORM)
        .where(OutboxEventORM.event_type.like("rbac.group.member_%"))
        .order_by(OutboxEventORM.created_at)
    )).scalars().all()
    return [(r.event_type, json.loads(r.payload)) for r in rows]


@pytest.mark.asyncio
async def test_sso_sync_records_each_membership_it_changes_and_nothing_else(db_session):
    idp = await idp_provider_repo.create_provider(
        db_session, slug="corp", display_name="Corp", kind="oidc", settings={},
    )
    analysts = await group_repo.create_group(db_session, name="Analysts", description="")
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="corp-analysts", target_group_id=analysts.id,
        provider_id=idp.id,
    )
    user = await user_repo.create_sso_user(
        db_session, email="ana@corp.example", first_name="Ana", last_name="Lyst",
        password_hash=disabled_password_hash(),
    )

    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["corp-analysts"], provider_id=idp.id,
    )
    # Asserting what is already true changes nothing, and records nothing.
    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["corp-analysts"], provider_id=idp.id,
    )
    # The directory takes the group away.
    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=[], provider_id=idp.id,
    )

    events = await _membership_events(db_session)
    assert [t for t, _ in events] == ["rbac.group.member_added", "rbac.group.member_removed"]
    for _, payload in events:
        assert payload["group_id"] == analysts.id
        assert payload["user_id"] == user.id
        assert payload["via"] == "sso"
        assert payload["provider_id"] == idp.id
        assert "actor_id" not in payload   # no person did it

    # The ledger files it as access, about that person, done by no one.
    event_type, payload = events[0]
    projected = catalogue.project(event_type=event_type, payload=payload)
    assert projected["category"] == "access"
    assert (projected["subject_id"], projected["actor_id"]) == (user.id, None)
    assert projected["actor_kind"] == "system"
    severity, summary = catalogue.summarize(event_type, payload)
    assert "IdP group sync" in summary
