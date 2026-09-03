"""Editing a live Access-mapping rule in place.

The tab could create and delete rules; changing one meant deleting and
retyping it. ``PUT /admin/idp-group-mappings/{id}`` replaces the whole
rule — a rule is one sentence, so the whole sentence is validated,
exactly as on create — while the row keeps its id and provenance.

The sharp edge these tests exist for: the reconciler's revocation is
deliberately scoped to targets some mapping still reaches, so when an
edit (or a delete) removes the LAST route to a target, the grants
already made under it would fall outside every future reconcile and
linger forever. The endpoints sweep exactly those orphans — and only
those: a target another rule still reaches is left alone.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db import models as m
from backend.app.db.repositories import (
    group_repo,
    idp_group_mapping_repo,
    idp_provider_repo,
    user_repo,
)
from backend.app.services.permission_service import reconcile_sso_targets
from backend.auth_service.core.password import disabled_password_hash

BASE = "/api/v1/admin/idp-group-mappings"


async def _seed(db_session):
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-ad", display_name="Corp AD",
        kind="oidc", settings={},
    )
    group_a = await group_repo.create_group(
        db_session, name="Use Case A", description="",
    )
    group_b = await group_repo.create_group(
        db_session, name="Use Case B", description="",
    )
    user = await user_repo.create_sso_user(
        db_session, email="member@corp.example", first_name="Mem",
        last_name="Ber", password_hash=disabled_password_hash(),
    )
    return provider, group_a, group_b, user


async def _membership_rows(db_session, user_id: str) -> set[str]:
    rows = (await db_session.execute(
        select(m.GroupMemberORM.group_id).where(
            m.GroupMemberORM.user_id == user_id,
        )
    )).scalars().all()
    return set(rows)


@pytest.mark.asyncio
async def test_edit_retargets_the_rule_and_keeps_its_identity(
    test_client: AsyncClient, db_session,
):
    provider, group_a, group_b, _ = await _seed(db_session)
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="group1",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    await db_session.commit()

    resp = await test_client.put(f"{BASE}/{row.id}", json={
        "idpGroup": "group2",
        "targetType": "group_membership",
        "targetGroupId": group_b.id,
        "providerId": provider.id,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == row.id
    assert body["idpGroup"] == "group2"
    assert body["targetGroupId"] == group_b.id

    events = (await db_session.execute(
        select(m.OutboxEventORM).where(
            m.OutboxEventORM.event_type == "rbac.sso_mapping.updated",
        )
    )).scalars().all()
    assert len(events) == 1


@pytest.mark.asyncio
async def test_edit_can_switch_the_target_type(
    test_client: AsyncClient, db_session,
):
    provider, group_a, _, _ = await _seed(db_session)
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="group1",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    await db_session.commit()

    resp = await test_client.put(f"{BASE}/{row.id}", json={
        "idpGroup": "group1",
        "targetType": "role_binding",
        "roleName": "org_admin",
        "scopeType": "global",
        "providerId": provider.id,
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["targetType"] == "role_binding"
    assert body["roleName"] == "org_admin"
    assert body["targetGroupId"] is None


@pytest.mark.asyncio
async def test_edit_holds_the_create_guards(
    test_client: AsyncClient, db_session,
):
    provider, group_a, _, _ = await _seed(db_session)
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="group1",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    await db_session.commit()

    # The privileged-role floor holds on edit exactly as on create.
    refused = await test_client.put(f"{BASE}/{row.id}", json={
        "idpGroup": "group1",
        "targetType": "role_binding",
        "roleName": "super_admin",
        "scopeType": "global",
        "providerId": provider.id,
    })
    assert refused.status_code == 400, refused.text

    unknown = await test_client.put(f"{BASE}/map_nonexistent", json={
        "idpGroup": "group1",
        "targetType": "group_membership",
        "targetGroupId": group_a.id,
    })
    assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_edit_sweeps_grants_the_old_target_orphaned(
    test_client: AsyncClient, db_session,
):
    """Retargeting the last rule that reached "Use Case A" clears the
    memberships it minted — otherwise they would outlive every future
    reconcile — and the next sign-in grants the new target."""
    provider, group_a, group_b, user = await _seed(db_session)
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="group1",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["group1"],
        provider_id=provider.id,
    )
    assert out["memberships_added"] == 1
    await db_session.commit()
    assert await _membership_rows(db_session, user.id) == {group_a.id}

    resp = await test_client.put(f"{BASE}/{row.id}", json={
        "idpGroup": "group1",
        "targetType": "group_membership",
        "targetGroupId": group_b.id,
        "providerId": provider.id,
    })
    assert resp.status_code == 200, resp.text

    # The old target's grant is gone at once…
    assert await _membership_rows(db_session, user.id) == set()

    # …and the person's next sign-in grants the new one.
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["group1"],
        provider_id=provider.id,
    )
    assert out["memberships_added"] == 1
    assert await _membership_rows(db_session, user.id) == {group_b.id}


@pytest.mark.asyncio
async def test_edit_spares_a_target_another_rule_still_reaches(
    test_client: AsyncClient, db_session,
):
    provider, group_a, group_b, user = await _seed(db_session)
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="group1",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="other-group",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["group1"],
        provider_id=provider.id,
    )
    await db_session.commit()

    resp = await test_client.put(f"{BASE}/{row.id}", json={
        "idpGroup": "group1",
        "targetType": "group_membership",
        "targetGroupId": group_b.id,
        "providerId": provider.id,
    })
    assert resp.status_code == 200, resp.text

    # "Use Case A" is still reachable through other-group, so nothing
    # was swept: whether THIS person keeps it is the reconciler's call
    # at their next sign-in, not the edit's.
    assert await _membership_rows(db_session, user.id) == {group_a.id}


@pytest.mark.asyncio
async def test_delete_sweeps_the_orphaned_target_too(
    test_client: AsyncClient, db_session,
):
    provider, group_a, _, user = await _seed(db_session)
    row = await idp_group_mapping_repo.create_group_membership_mapping(
        db_session, idp_group="group1",
        target_group_id=group_a.id, provider_id=provider.id,
    )
    await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["group1"],
        provider_id=provider.id,
    )
    await db_session.commit()
    assert await _membership_rows(db_session, user.id) == {group_a.id}

    resp = await test_client.delete(f"{BASE}/{row.id}")
    assert resp.status_code == 204, resp.text
    assert await _membership_rows(db_session, user.id) == set()


@pytest.mark.asyncio
async def test_edit_soft_revokes_an_orphaned_role_binding(
    test_client: AsyncClient, db_session,
):
    """The role flavour: the orphaned binding is expired rather than
    deleted, matching the reconciler's own idiom, so a future rule for
    the same target reactivates it."""
    provider, group_a, _, user = await _seed(db_session)
    row = await idp_group_mapping_repo.create_role_binding_mapping(
        db_session, idp_group="group1", role_name="org_admin",
        scope_type="global", scope_id=None, provider_id=provider.id,
    )
    out = await reconcile_sso_targets(
        db_session, user_id=user.id, idp_groups=["group1"],
        provider_id=provider.id,
    )
    assert out["created"] == 1
    await db_session.commit()

    resp = await test_client.put(f"{BASE}/{row.id}", json={
        "idpGroup": "group1",
        "targetType": "group_membership",
        "targetGroupId": group_a.id,
        "providerId": provider.id,
    })
    assert resp.status_code == 200, resp.text

    binding = (await db_session.execute(
        select(m.RoleBindingORM).where(
            m.RoleBindingORM.subject_type == "user",
            m.RoleBindingORM.subject_id == user.id,
            m.RoleBindingORM.role_name == "org_admin",
            m.RoleBindingORM.source == "sso",
        )
    )).scalar_one()
    assert binding.expires_at is not None
